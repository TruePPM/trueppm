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

One property here is not about exceptions at all:
:func:`test_monte_carlo_never_precedes_cpm` binds ``monte_carlo()``'s output to
``schedule()``'s. Nothing asserted any relationship between the two passes, which
is how #2833 — a Monte Carlo floor the deterministic pass had and the simulation
did not — survived ~99% line coverage. It runs against its own
:func:`_plausible_projects` strategy rather than the adversarial one, because an
input the engine *rejects* proves nothing about the two passes agreeing.

A generated space is only a net for what it actually generates, and this one was
not: #3765 was the same invariant failing through ``Task.duration``, and
:func:`_plausible_tasks` drew no three-point estimate, so every example took the
deterministic path where the two passes agree by construction. The property could
not fail at any budget for the class it was written to guard. The triple is now
drawn — bracketing the duration and, deliberately, sitting below it.
"""

from __future__ import annotations

import json
import signal
from collections.abc import Callable
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Any

import pytest
from hypothesis import example, given
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


def _assert_conforms(
    label: str,
    call: Callable[[], object],
    on_return: Callable[[object], None] | None = None,
) -> None:
    """Assert ``call()`` either returns or raises only a documented SchedulerError.

    ``SchedulerError`` subclasses ``ValueError``, so it is caught first; any *other*
    escaping exception (including a bare ``ValueError`` that is not a SchedulerError,
    ``TypeError``, ``OverflowError``, numpy errors, ``RecursionError``) or a hang is
    a contract violation.

    When ``call()`` returns cleanly and ``on_return`` is given, it is invoked with
    the result to assert output invariants — so a clean return is no longer treated
    as unconditional success (#1511).
    """
    try:
        with _time_limit(HANG_SECONDS):
            result = call()
    except SchedulerError:
        return
    except _Timeout as exc:
        raise AssertionError(f"{label}: HANG — {exc}") from exc
    except Exception as exc:
        # Classifying *any* non-SchedulerError escape is the whole point.
        raise AssertionError(f"{label}: non-conforming escape {type(exc).__name__}: {exc}") from exc
    if on_return is not None:
        on_return(result)


def _assert_schedule_invariants(project: Project, result: object) -> None:
    """Basic CPM output invariants that must hold for any clean ``schedule`` return.

    A clean return means the project passed validation (duplicate ids, for one, are
    rejected — see the engine's uniqueness guard), so the task set is preserved and
    every task carries a coherent early window. Asserting these turns "returned
    without raising" from a vacuous pass into a real correctness check (#1511).
    """
    tasks = list(result.tasks)  # type: ignore[attr-defined]
    assert len(tasks) == len(project.tasks), "schedule must neither drop nor invent tasks"
    for t in tasks:
        if t.early_start is not None and t.early_finish is not None:
            assert t.early_start <= t.early_finish, f"{t.id}: early_start after early_finish"
        if t.free_float is not None and t.total_float is not None:
            assert t.free_float <= t.total_float, f"{t.id}: free_float exceeds total_float"


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
    _assert_conforms(
        "schedule",
        lambda: schedule(project),
        on_return=lambda r: _assert_schedule_invariants(project, r),
    )
    _assert_conforms(
        "monte_carlo",
        lambda: monte_carlo(project, runs=24, seed=seed, max_runs=None, max_tasks=None),  # type: ignore[arg-type]
    )


_PLAUSIBLE_ANCHOR = date(2026, 3, 2)  # Monday
# Dates within a working year either side of the anchor: far enough to straddle
# the data date, the SNET pin, and every actual, but nowhere near the engine's
# span caps — an input rejected by validation proves nothing about the two passes
# agreeing, and the adversarial ``_projects()`` space is rejected almost always.
_plausible_date = st.dates(min_value=date(2025, 9, 1), max_value=date(2027, 3, 1))
_opt_plausible_date = st.none() | _plausible_date


@st.composite
def _plausible_tasks(draw: st.DrawFn, tid: str) -> Task:
    """A task in the value ranges a real project uses, with real duration uncertainty.

    Every field that feeds an ES floor is drawn (``planned_start``,
    ``actual_start``, ``actual_finish``, ``percent_complete``).

    **The three-point estimate is drawn too, and that is load-bearing (#3765).** It
    used to be deliberately left unset "so the simulation has nothing to vary" —
    which meant every example took the deterministic sampling path where
    ``monte_carlo()`` equals ``schedule()`` *by construction*, so
    :func:`test_monte_carlo_never_precedes_cpm` could not fail at any Hypothesis
    budget. It was written to stop #2833 recurring and was structurally blind to
    #3765, the next instance of the same invariant. A detector that cannot fail is
    not a detector, so the triple is now drawn in three shapes:

    * absent (the original deterministic path, still the most common real project);
    * **bracketing** the drawn duration (``optimistic <= duration <= pessimistic``);
    * **not bracketing** it — the whole triple sitting below the duration, which is
      the #3765 defect exactly, and the state the MS Project importer, the estimates
      drawer and the velocity-suggestion accept can each write on their own.

    The triple is always internally ordered (``o <= m <= p``): an unordered one is
    *rejected* by ``_validate_task_durations``, and a rejected input never produces
    the pair of results this property compares.

    The actuals are drawn as a coherent pair (finish at or after start, and only
    ever alongside one) because ``schedule()`` rejects the incoherent combinations
    outright, and a rejected input tells this invariant nothing.
    """
    actual_start = draw(_opt_plausible_date)
    actual_finish = None
    if actual_start is not None:
        actual_finish = draw(
            st.none() | st.dates(min_value=actual_start, max_value=date(2027, 6, 1))
        )
    duration_days = draw(st.integers(min_value=0, max_value=40))
    shape = draw(st.sampled_from(["none", "brackets", "below"]))
    triple: dict[str, timedelta] = {}
    if shape == "brackets":
        opt = draw(st.integers(min_value=0, max_value=duration_days))
        pess = draw(st.integers(min_value=duration_days, max_value=40))
        ml = draw(st.integers(min_value=opt, max_value=pess))
        triple = {
            "optimistic_duration": timedelta(days=opt),
            "most_likely_duration": timedelta(days=ml),
            "pessimistic_duration": timedelta(days=pess),
        }
    elif shape == "below":
        # The whole triple under the duration. Degenerate when duration is 0 (the
        # only triple at or below it is all-zero), which is fine — that example
        # simply lands back on "equal to the duration".
        pess = draw(st.integers(min_value=0, max_value=max(duration_days, 0)))
        opt = draw(st.integers(min_value=0, max_value=pess))
        ml = draw(st.integers(min_value=opt, max_value=pess))
        triple = {
            "optimistic_duration": timedelta(days=opt),
            "most_likely_duration": timedelta(days=ml),
            "pessimistic_duration": timedelta(days=pess),
        }
    return Task(
        id=tid,
        name="t",
        duration=timedelta(days=duration_days),
        planned_start=draw(_opt_plausible_date),
        # 100.0 included so the complete-by-percent branch is covered too.
        percent_complete=draw(st.floats(min_value=0.0, max_value=100.0)),
        actual_start=actual_start,
        actual_finish=actual_finish,
        **triple,  # type: ignore[arg-type]
    )


@st.composite
def _plausible_projects(draw: st.DrawFn) -> Project:
    """A schedulable project: real-world value ranges, with duration uncertainty.

    The adversarial ``_projects()`` strategy exists to prove the *exception*
    contract, and it earns that by generating inputs the engine rejects — which
    makes it nearly useless for an *output* invariant, since a rejected input
    never produces a pair of results to compare (a first cut of this strategy
    reused its duplicate-id and self-edge draws and put only ~8% of examples
    through the forward pass, so the property passed on an engine that was
    provably broken). This one trades that breadth for inputs that reach the
    forward pass, while keeping every field that can floor an early start in play.
    """
    n = draw(st.integers(min_value=1, max_value=6))
    ids = [f"t{i}" for i in range(n)]
    tasks = [draw(_plausible_tasks(tid)) for tid in ids]

    # Only forward edges (i < j) and at most one per ordered pair: cycles and
    # duplicate dependencies are both rejected by validation, and neither is what
    # this property is probing.
    pairs = [(ids[i], ids[j]) for i in range(n) for j in range(i + 1, n)]
    chosen = draw(st.lists(st.sampled_from(pairs), max_size=6, unique=True)) if pairs else []
    deps = [
        Dependency(
            predecessor_id=u,
            successor_id=v,
            dep_type=draw(st.sampled_from(list(DependencyType))),
            lag=timedelta(days=draw(st.integers(min_value=-5, max_value=15))),
        )
        for u, v in chosen
    ]

    return Project(
        id="p",
        name="p",
        start_date=_PLAUSIBLE_ANCHOR,
        tasks=tasks,
        dependencies=deps,
        # A five-day week plus a handful of holidays: enough calendar texture for a
        # non-working actual (the case the offset index cannot represent directly).
        calendar=Calendar(
            working_days=0b0011111,
            exceptions=[
                DateRange(d, d) for d in draw(st.lists(_plausible_date, max_size=4, unique=True))
            ],
        ),
        status_date=draw(_opt_plausible_date),
    )


@given(project=_plausible_projects())
def test_monte_carlo_never_precedes_cpm(project: Project) -> None:
    """``monte_carlo()`` must never forecast a finish EARLIER than ``schedule()``.

    Nothing in this suite asserted any relationship between the two passes, which
    is the structural reason #2833 survived ~99% line coverage: ``monte_carlo()``
    never received the ``actual_start`` early-start floor ``schedule()`` has
    applied since #2621, so it sampled from a window CPM had already rejected and
    P95 could land *before* the deterministic finish. A risk tool that
    under-reports risk fails silently and plausibly, so the binding is asserted
    here as a property rather than only at the one instance that was found.

    The second instance was #3765, and it is why ``_plausible_tasks`` now draws a
    three-point estimate. With the estimates unset every example took the
    deterministic sampling path, where the two passes agree by construction — so
    this property was structurally incapable of failing, at any budget, for the
    entire class it was written to guard. ``monte_carlo()`` sampled from the triple
    and ignored ``Task.duration`` outright, so a triple sitting below the planned
    duration forecast a finish the deterministic pass had already ruled infeasible.

    P50 is the tightest leg of the assertion (P80 and P95 are >= it by
    construction), and the direction is one-way: a *later* percentile is the risk
    premium the deterministic pass cannot express and is entirely legitimate.

    Both calls must reach the same verdict on validity — if one raises a
    documented ``SchedulerError`` the input never had a comparable pair, and there
    is nothing to bind.

    **Why the finish-level leg is scoped to FS/SS networks.** CPM is not monotone in
    duration once an FF or SF edge is present: those pin a task's *finish*, so its
    start is placed back from there, and a LONGER task therefore starts EARLIER —
    which an SS successor keyed on that start inherits. ``schedule()`` shows this on
    its own, with no simulation involved: on the five-task network found while fixing
    #3765, raising every duration to its pessimistic value moves the deterministic
    finish from 2026-07-09 *back* to 2026-06-05. So on such a network the CPM finish
    is not a lower bound on the finishes reachable from larger durations, and no
    duration-level floor can make it one — ``monte_carlo()`` is reproducing
    ``schedule()`` faithfully there rather than diverging from it. Asserting the
    binding anyway would red the suite on correct output. The edges stay in the
    generator (they exercise the ``has_ef_constraint`` branch that #2833's ES floors
    run through, and the percentile-ordering leg below is asserted for every
    example); only the finish-level comparison is held back. Tracked separately in
    #3806 — whether the FF convention itself should place the start forward instead
    is a semantics question for both engines, not a bugfix.
    """
    try:
        with _time_limit(HANG_SECONDS):
            cpm = schedule(project)
            mc = monte_carlo(project, runs=16, seed=11, max_runs=None, max_tasks=None)
    except SchedulerError:
        return
    except _Timeout as exc:  # pragma: no cover - guarded by the conformance tests
        raise AssertionError(f"monte_carlo/schedule pair: HANG — {exc}") from exc

    monotone = all(
        d.dep_type not in (DependencyType.FF, DependencyType.SF) for d in project.dependencies
    )
    if monotone:
        assert mc.p50 >= cpm.project_finish, (
            f"monte_carlo P50 {mc.p50} precedes the deterministic CPM finish "
            f"{cpm.project_finish} — the simulation sampled a window schedule() rejected"
        )
    assert mc.p50 <= mc.p80 <= mc.p95, "percentiles must be monotonically non-decreasing"


#: Two shapes that must be tried on every run, not left to the search (#3963).
#:
#: The default ``gate`` profile is 200 derandomized examples, and that budget
#: reliably finds the *duration-walk* half of #3963 but **not** the
#: *late-window-floor* half — the floor's trigger needs a task whose early window
#: sits on a non-working day AND a successor tight enough to pull the backward
#: bound below it, which the generator produces rarely enough to miss at 200. A
#: property that only fails under ``fuzz-deep`` is not a gate on the blocking
#: pipeline, so the two triggers are pinned as examples and the search is left to
#: find the rest.
_FLOOR_TRIGGERS = [
    # A milestone pinned to a Saturday actual: it lays out no working days for
    # the duration walk to snap, so its early_finish IS the Saturday, while the
    # successor's backward bound resolves to the Friday.
    Project(
        id="p",
        name="p",
        start_date=_PLAUSIBLE_ANCHOR,
        tasks=[
            Task(
                id="t0",
                name="t",
                duration=timedelta(days=0),
                actual_start=date(2026, 3, 7),  # Saturday
            ),
            Task(id="t1", name="t", duration=timedelta(days=0)),
        ],
        dependencies=[Dependency(predecessor_id="t0", successor_id="t1")],
        calendar=Calendar(working_days=0b0011111),
    ),
    # The LS-pullback shape: an SF edge retreats the late start below the early
    # start, and the re-expanded late finish lands below a WORKING-day early
    # finish. Both legs floor, and the finish leg floors onto a working day —
    # the case a calendar-based discriminator cannot see (see
    # ``test_derive.TestLateWindowFloorDerivation``).
    Project(
        id="p",
        name="p",
        start_date=date(2027, 2, 1),
        tasks=[
            Task(
                id="t0",
                name="t",
                duration=timedelta(days=5),
                percent_complete=37.0,
                actual_start=date(2027, 2, 28),  # Sunday
            ),
            Task(id="t1", name="t", duration=timedelta(days=11), percent_complete=58.0),
        ],
        dependencies=[
            Dependency(
                predecessor_id="t0",
                successor_id="t1",
                dep_type=DependencyType.SF,
                lag=timedelta(days=5),
            )
        ],
        calendar=Calendar(working_days=0b0011111),
    ),
]


@example(project=_FLOOR_TRIGGERS[0])
@example(project=_FLOOR_TRIGGERS[1])
@given(project=_plausible_projects())
def test_late_window_never_precedes_early_window(project: Project) -> None:
    """Every task ``schedule()`` returns has ``late_start >= early_start`` and
    ``late_finish >= early_finish``.

    This is the float definition itself: total float is the working days between
    the early and late start, and a late date before its early counterpart is not
    "negative float" but an incoherent window — the task is asked to start after
    it has to start and before it is allowed to. No consumer can draw it. The web
    reads ``late_start``/``late_finish`` off the persisted CPM output
    (``useScheduleTasks.ts``), so a float bar spanning ES→LS renders backwards,
    and ``_working_days_between`` clamps the negative span to ``0`` on the way out
    — which reports the task as **critical** and erases the evidence that anything
    was wrong.

    **Why this is a property and not three regression cases (#2861).** The class is
    "a working-day duration walk that does not begin on a working day", and it has
    now been entered from four separate readers (#1830, #1929, #2461, #1827) — each
    of which fixed *its* reader and left the walk alone, because nothing in the
    suite asserted an invariant that spanned them. #3963 was found by an invariant
    fuzzer, not by any of those fixes: 143 of 3,000 generated projects produced
    ``late_start < early_start`` and every one traced to an ``actual_start`` on a
    non-working day, which ``_early_start_floors`` keeps verbatim by design
    (ADR-0132 §2) and ``_finish_from_start`` then counted as work-day 1.

    The generator is ``_plausible_projects``, which already draws exactly the input
    that breaks it: a Mon-Fri calendar with holiday exceptions, and
    ``actual_start``/``actual_finish``/``planned_start``/``status_date`` drawn over
    a working year, so non-working actuals arrive on their own rather than needing
    a special case. That is load-bearing and is why this property lives here rather
    than in its own module with a bespoke strategy — a detector built around the
    one shape that was found would be blind to the fifth instance in the same way
    its predecessors were.

    Scoped to tasks whose four dates are all set, which after a clean return is all
    of them; the guard is there so a future engine that legitimately leaves a
    window unresolved fails on the new behavior rather than on a ``None``
    comparison. An input the engine *rejects* is not a counterexample — it never
    produced a window to check.

    **What the search finds and what is pinned.** At the ``gate`` profile's 200
    derandomized examples this fails on a pre-#3963 engine through the duration
    walk, so the main defect is guarded on the blocking pipeline. The
    late-window-floor half needs a rarer shape and was not reached at that budget
    — see ``_FLOOR_TRIGGERS`` above, which pins both triggers as explicit examples
    rather than leaving a second half of the fix guarded only by the scheduled
    ``fuzz-deep`` job.
    """
    try:
        with _time_limit(HANG_SECONDS):
            result = schedule(project)
    except SchedulerError:
        return
    except _Timeout as exc:  # pragma: no cover - guarded by the conformance tests
        raise AssertionError(f"schedule: HANG — {exc}") from exc

    for t in result.tasks:
        if t.early_start is None or t.late_start is None:
            continue
        assert t.late_start >= t.early_start, (
            f"{t.id}: late_start {t.late_start} precedes early_start {t.early_start} — "
            f"the late window is inverted (actual_start={t.actual_start}, "
            f"actual_finish={t.actual_finish}, duration={t.duration})"
        )
        if t.early_finish is None or t.late_finish is None:
            continue
        assert t.late_finish >= t.early_finish, (
            f"{t.id}: late_finish {t.late_finish} precedes early_finish "
            f"{t.early_finish} (actual_start={t.actual_start}, "
            f"actual_finish={t.actual_finish}, duration={t.duration})"
        )


@given(project=_plausible_projects())
def test_duration_walk_spends_only_working_days(project: Project) -> None:
    """A task's early window spans exactly its scheduled working-day duration.

    The companion to the ordering property above, asserting the *cause* rather
    than the symptom: ``duration`` counts working days, so the working days in
    ``[early_start, early_finish]`` must equal the duration the pass laid out — the
    full estimate for a not-started or completed task, the remaining portion for an
    in-progress one (ADR-0132 §3). Before #3963 a non-working ``actual_start`` was
    counted as work-day 1, so the window held one working day *fewer* than the
    duration and the task finished a working day early — a defect the ordering
    property only catches when it happens to invert the late window, and which
    propagates to ``ProjectForecastSnapshot`` (append-only) whether it does or not.

    Only network-scheduled tasks are checked. A task pinned by a recorded
    ``actual_finish`` (:func:`_pinned_placement`) deliberately spans whatever its
    actuals say — possibly out of sequence, possibly longer or shorter than its
    estimate — because actuals are truth (ADR-0136), so its window is not a
    statement about duration at all. An ``early_finish`` pushed out by an FF/SF
    constraint is likewise longer than the duration by design.
    """
    try:
        with _time_limit(HANG_SECONDS):
            result = schedule(project)
    except SchedulerError:
        return
    except _Timeout as exc:  # pragma: no cover - guarded by the conformance tests
        raise AssertionError(f"schedule: HANG — {exc}") from exc

    has_finish_constraint = {
        d.successor_id
        for d in project.dependencies
        if d.dep_type in (DependencyType.FF, DependencyType.SF)
    }
    cal = project.calendar
    for t in result.tasks:
        if t.early_start is None or t.early_finish is None:
            continue
        if t.actual_finish is not None or t.id in has_finish_constraint:
            continue
        duration_days = t.duration.days
        pct = t.percent_complete or 0.0
        if 0 < pct < 100:
            duration_days -= int(duration_days * min(pct, 100.0) / 100.0)
        if duration_days <= 0:
            # A milestone (or fully-burned remaining work) is a single pinned day.
            assert t.early_start == t.early_finish, f"{t.id}: zero-duration span is not a point"
            continue
        worked = sum(
            1
            for n in range((t.early_finish - t.early_start).days + 1)
            if cal.is_working_day(t.early_start + timedelta(days=n))
        )
        assert worked == duration_days, (
            f"{t.id}: early window {t.early_start}..{t.early_finish} holds {worked} "
            f"working days but the pass laid out {duration_days} "
            f"(actual_start={t.actual_start}, percent_complete={t.percent_complete})"
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
