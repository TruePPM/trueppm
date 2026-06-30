"""Property-based contract fuzzing of the public API (#1456).

The published exception contract is: every public entry point either **returns**
or raises a :class:`SchedulerError` subclass (``InvalidScheduleInput`` /
``CyclicDependencyError`` / ``SimulationCapExceeded``). Anything else escaping —
a bare ``ValueError``/``TypeError``, an ``OverflowError``, a numpy error, a
``RecursionError``, or a hang — is a contract violation.

``test_redteam_hardening.py`` and ``test_robustness.py`` pin the *known* findings
as deterministic regressions. This module is the *continuous* net: it generates a
broad space of structurally-valid-but-degenerate and adversarial inputs and
asserts the contract holds for each public callable. It makes the one-off
2026-06-30 red-team sweep a permanent, growing gate (see conftest.py for the
``gate`` vs ``deep`` profiles).

The two findings this gate was built to catch — #1452 (``percent_complete``
unvalidated) and #1453 (``monte_carlo`` seed unvalidated) — are now fixed, so their
adversarial vectors are folded directly into the broad strategies below:
``percent_complete`` draws non-finite floats and ``monte_carlo`` draws bad seeds,
both of which must now yield a clean ``InvalidScheduleInput``.
"""

from __future__ import annotations

import json
import signal
from collections.abc import Callable
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from trueppm_scheduler import (
    Calendar,
    DateRange,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    SchedulerError,
    Task,
    expand_summary_dependencies,
    find_cycle,
    monte_carlo,
    schedule,
)

pytestmark = pytest.mark.fuzz

# Hard ceiling for any single public call. The engine's MAX_* caps bound real
# work well under this; the watchdog exists so a *regression* into an unbounded
# spin surfaces as a contract violation ("never hangs") rather than a CI timeout.
HANG_SECONDS = 10.0


class _Timeout(Exception):
    """A public call exceeded HANG_SECONDS — treated as a contract violation."""


@contextmanager
def _time_limit(seconds: float):
    """Raise :class:`_Timeout` if the body runs longer than ``seconds``.

    SIGALRM-based, so it interrupts a pure-Python spin (the failure mode we guard)
    rather than only catching it at a yield point. No-ops where SIGALRM is absent
    (e.g. non-Unix); CI and dev are both Unix, where the guard is live.
    """
    if not hasattr(signal, "SIGALRM"):
        yield
        return

    def _handler(_signum: int, _frame: Any) -> None:
        raise _Timeout(f"exceeded {seconds}s")

    old = signal.signal(signal.SIGALRM, _handler)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def _assert_conforms(label: str, call: Callable[[], object]) -> None:
    """Assert ``call()`` either returns or raises only a documented SchedulerError.

    ``SchedulerError`` subclasses ``ValueError``, so it is caught first; any *other*
    escaping exception (including a bare ``ValueError`` that is not a SchedulerError,
    ``TypeError``, ``OverflowError``, numpy errors, ``RecursionError``) or a hang is
    a contract violation.
    """
    try:
        with _time_limit(HANG_SECONDS):
            call()
    except SchedulerError:
        return
    except _Timeout as exc:
        raise AssertionError(f"{label}: HANG — {exc}") from exc
    except Exception as exc:
        # Classifying *any* non-SchedulerError escape is the whole point.
        raise AssertionError(f"{label}: non-conforming escape {type(exc).__name__}: {exc}") from exc


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Bounded so the *generator* never overflows when constructing timedeltas/dates
# (timedelta tops out near 1e9 days). The engine's MAX_DURATION_DAYS / MAX_LAG_DAYS
# (~36_525) sit well inside this, so values routinely straddle the caps — the
# point is to prove the cap raises InvalidScheduleInput rather than OverflowError.
_day_ints = st.integers(min_value=-100_000_000, max_value=100_000_000)
_ids = st.text(alphabet=st.characters(min_codepoint=33, max_codepoint=122), min_size=1, max_size=8)
# Non-finite included on purpose: these fields are either guarded (story_points,
# velocity_samples, percent_complete — #1209/#1452) or inert (hours_per_day), so
# nan/inf must still yield a clean return or InvalidScheduleInput, never an
# arithmetic escape.
_weird_floats = st.floats()
# monte_carlo seed: None or any int (negative → must raise InvalidScheduleInput,
# #1453), plus floats/bools that are likewise non-conforming and must be rejected.
_seeds = st.none() | st.integers(min_value=-(10**6), max_value=10**6) | st.floats() | st.booleans()
_opt_date = st.none() | st.dates()
_opt_td = st.none() | _day_ints.map(lambda d: timedelta(days=d))


@st.composite
def _tasks(draw: st.DrawFn, ids: list[str]) -> Task:
    aset = draw(st.none() | st.dates())
    return Task(
        id=draw(st.sampled_from(ids)),
        name=draw(st.text(max_size=12)),
        duration=timedelta(days=draw(_day_ints)),
        planned_start=draw(_opt_date),
        planned_finish=draw(_opt_date),
        percent_complete=draw(_weird_floats),  # non-finite must raise InvalidScheduleInput (#1452)
        actual_start=aset,
        actual_finish=draw(st.none() | st.dates()),
        optimistic_duration=draw(_opt_td),
        most_likely_duration=draw(_opt_td),
        pessimistic_duration=draw(_opt_td),
        story_points=draw(st.none() | _weird_floats),
        delivery_mode=draw(st.none() | st.sampled_from(list(DeliveryMode))),
        calendar_id=draw(st.none() | _ids),
    )


@st.composite
def _calendars(draw: st.DrawFn) -> Calendar:
    n = draw(st.integers(min_value=0, max_value=6))
    exceptions = []
    for _ in range(n):
        # DateRange enforces end >= start at construction, so order the pair here;
        # sorting two full-range dates still spans up to millennia (probes the
        # engine's MAX_CALENDAR_SCAN_DAYS / MAX_PROJECT_SPAN_DAYS guards).
        lo, hi = sorted((draw(st.dates()), draw(st.dates())))
        exceptions.append(DateRange(lo, hi))
    return Calendar(
        working_days=draw(st.integers(min_value=-5, max_value=300)),  # valid is 0..127
        exceptions=exceptions,
        hours_per_day=draw(_weird_floats),
        timezone=draw(st.text(max_size=8)),
    )


@st.composite
def _projects(draw: st.DrawFn) -> Project:
    n = draw(st.integers(min_value=1, max_value=8))
    ids = [f"t{i}" for i in range(n)]
    tasks = [draw(_tasks(ids)) for _ in range(n)]

    deps = []
    for _ in range(draw(st.integers(min_value=0, max_value=12))):
        deps.append(
            Dependency(
                # Mix real ids with dangling refs — an unknown task id must raise
                # InvalidScheduleInput, not a bare KeyError.
                predecessor_id=draw(st.sampled_from(ids) | _ids),
                successor_id=draw(st.sampled_from(ids) | _ids),
                dep_type=draw(st.sampled_from(list(DependencyType))),
                lag=timedelta(days=draw(_day_ints)),
            )
        )

    return Project(
        id=draw(_ids),
        name=draw(st.text(max_size=12)),
        start_date=draw(st.dates()),
        tasks=tasks,
        dependencies=deps,
        calendar=draw(_calendars()),
        velocity_samples=draw(st.none() | st.lists(_weird_floats, max_size=8)),
        sprint_length_days=draw(st.none() | st.integers(min_value=-5, max_value=10_000_000)),
        status_date=draw(_opt_date),
    )


# JSON values for the untrusted-input surface. allow_nan=True so non-finite
# literals reach Project.from_json, which must reject them cleanly.
_json_scalars = (
    st.none()
    | st.booleans()
    | st.integers(min_value=-(10**12), max_value=10**12)
    | st.floats()
    | st.text(max_size=10)
)
_json_values = st.recursive(
    _json_scalars,
    lambda children: (
        st.lists(children, max_size=5) | st.dictionaries(st.text(max_size=8), children, max_size=5)
    ),
    max_leaves=30,
)


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------


@given(project=_projects(), seed=_seeds)
def test_direct_object_api_conforms(project: Project, seed: object) -> None:
    """schedule() and monte_carlo() on a fuzzed Project either return or raise a
    documented SchedulerError — never a bare ValueError/TypeError/OverflowError,
    numpy error, or hang. This is the path the TruePPM API itself drives. The
    fuzzed ``seed`` (incl. negative ints, floats, bools) exercises the #1453 guard:
    a non-conforming seed must raise InvalidScheduleInput, not a bare numpy error."""
    _assert_conforms("schedule", lambda: schedule(project))
    _assert_conforms(
        "monte_carlo",
        lambda: monte_carlo(project, runs=24, seed=seed, max_runs=None, max_tasks=None),  # type: ignore[arg-type]
    )


@given(value=_json_values)
def test_from_json_conforms(value: object) -> None:
    """Project.from_json on arbitrary JSON (including NaN/Infinity literals and
    malformed structures) raises only InvalidScheduleInput, or returns a Project
    that then schedules and simulates conformingly."""
    text = json.dumps(value, allow_nan=True)

    def _roundtrip() -> None:
        project = Project.from_json(text)
        schedule(project)
        monte_carlo(project, runs=12, seed=3, max_runs=None, max_tasks=None)

    _assert_conforms("from_json", _roundtrip)


@given(
    edges=st.lists(st.tuples(_ids, _ids), max_size=20)
    | st.lists(st.tuples(_ids, _ids, _ids), max_size=5)  # wrong arity
    | st.none(),
    children_map=st.none() | st.dictionaries(_ids, st.lists(_ids, max_size=4), max_size=6),
)
def test_find_cycle_conforms(edges: object, children_map: object) -> None:
    """find_cycle on well-formed and malformed edge/children inputs raises only
    InvalidScheduleInput or returns a CycleCheck."""
    _assert_conforms("find_cycle", lambda: find_cycle(edges, children_map))  # type: ignore[arg-type]


_children_maps = st.dictionaries(_ids, st.lists(_ids, max_size=5), max_size=6)


@given(project=_projects(), children_map=_children_maps)
def test_expand_summary_conforms(project: Project, children_map: dict[str, list[str]]) -> None:
    """expand_summary_dependencies on a fuzzed graph + children_map raises only
    InvalidScheduleInput (e.g. the cross-product cap) or returns an expansion."""
    _assert_conforms(
        "expand_summary_dependencies",
        lambda: expand_summary_dependencies(project.tasks, project.dependencies, children_map),
    )
