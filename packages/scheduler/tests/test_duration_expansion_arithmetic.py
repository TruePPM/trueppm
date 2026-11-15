"""The arithmetic duration layout equals the day walk it replaced (#1531).

``_finish_from_start`` / ``_start_from_finish`` used to step one working day at a
time; they now jump by rank arithmetic over the weekday mask and the calendar's
exception prefix sum. This is a pure performance change, so the oracle is the
old walk itself, kept as ``_finish_from_start_walk`` / ``_start_from_finish_walk``:

- the helper level compares the two over random masks, exception sets (including
  runs long enough to trip the walk's per-step scan budget), anchors near both
  ends of the ``date`` range, and durations — dates **and** raised errors, message
  included;
- the engine level runs ``schedule()`` twice on the same random project, once with
  the walk patched back into every module that imported the helpers, and requires
  the two results to be identical. The generator sweeps the combinations where CPM
  defects have historically hidden: FS/SS/SF/FF links with positive and negative
  lag, x actuals (start only, finish only, both, on non-working days, 100% with
  none), x calendar scope (project calendar vs per-task calendars), plus status
  dates on either side of the project start, SNETs and milestones.
"""

from __future__ import annotations

import copy
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, timedelta

import pytest
from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    Project,
    SchedulerError,
    Task,
    schedule,
)
from trueppm_scheduler.engine import calendar_math as cm
from trueppm_scheduler.engine.limits import MAX_CALENDAR_SCAN_DAYS

pytestmark = pytest.mark.fuzz

_BASE = date(2026, 1, 1)


def _outcome(fn: object, *args: object) -> tuple[str, object]:
    try:
        return "ok", fn(*args)  # type: ignore[operator]
    except SchedulerError as err:
        return type(err).__name__, str(err)


@st.composite
def _calendars(draw: st.DrawFn, base: date = _BASE, *, budget_runs: bool = True) -> Calendar:
    mask = draw(st.integers(min_value=1, max_value=127))
    exceptions = []
    for _ in range(draw(st.integers(min_value=0, max_value=12))):
        start = base + timedelta(days=draw(st.integers(min_value=-400, max_value=900)))
        lengths = [st.integers(min_value=0, max_value=20), st.integers(min_value=21, max_value=400)]
        if budget_runs:
            # Around the walk's per-step budget: where the arithmetic must hand
            # back to the walk so the same error is raised.
            lengths.append(
                st.integers(
                    min_value=MAX_CALENDAR_SCAN_DAYS - 20, max_value=MAX_CALENDAR_SCAN_DAYS + 5
                )
            )
        length = draw(st.one_of(*lengths))
        exceptions.append(DateRange(start=start, end=start + timedelta(days=length)))
    return Calendar(working_days=mask, exceptions=exceptions)


_EDGE_ANCHORS = st.sampled_from(
    [date.min, date.min + timedelta(days=3), date.max - timedelta(days=3), date.max]
)


@given(
    cal=_calendars(),
    offset=st.integers(min_value=-500, max_value=1500),
    duration=st.integers(min_value=0, max_value=600),
)
@settings(max_examples=600, deadline=None)
@example(cal=Calendar(), offset=3, duration=10)  # Sunday start, Mon-Fri
@example(cal=Calendar(working_days=0b1000000), offset=0, duration=53)
def test_arithmetic_layout_equals_the_walk(cal: Calendar, offset: int, duration: int) -> None:
    anchor = _BASE + timedelta(days=offset)
    for new, old in (
        (cm._finish_from_start, cm._finish_from_start_walk),
        (cm._start_from_finish, cm._start_from_finish_walk),
    ):
        assert _outcome(new, anchor, duration, cal) == _outcome(old, anchor, duration, cal)


@given(cal=_calendars(base=date(5000, 1, 1)), anchor=_EDGE_ANCHORS, duration=st.integers(0, 40))
@settings(max_examples=150, deadline=None)
def test_arithmetic_layout_equals_the_walk_at_the_date_range_edges(
    cal: Calendar, anchor: date, duration: int
) -> None:
    for new, old in (
        (cm._finish_from_start, cm._finish_from_start_walk),
        (cm._start_from_finish, cm._start_from_finish_walk),
    ):
        assert _outcome(new, anchor, duration, cal) == _outcome(old, anchor, duration, cal)


def test_a_run_past_the_scan_budget_raises_the_walks_error() -> None:
    """A gap longer than the walk's budget raises, not a silent far landing."""
    start = date(2026, 1, 5)
    blanket = DateRange(
        start=start + timedelta(days=1), end=start + timedelta(days=MAX_CALENDAR_SCAN_DAYS + 3)
    )
    cal = Calendar(exceptions=[blanket])
    new = _outcome(cm._finish_from_start, start, 2, cal)
    assert new == _outcome(cm._finish_from_start_walk, start, 2, cal)
    assert new[0] == "InvalidScheduleInput"


# ---------------------------------------------------------------------------
# Engine level: schedule() with the arithmetic == schedule() with the walk
# ---------------------------------------------------------------------------


@contextmanager
def _walk_patched() -> Iterator[None]:
    """Patch the day walk into every engine module that imported the helpers."""
    swaps = {
        cm._finish_from_start: cm._finish_from_start_walk,
        cm._start_from_finish: cm._start_from_finish_walk,
    }
    patched: list[tuple[object, str, object]] = []
    for name, mod in list(sys.modules.items()):
        if not name.startswith("trueppm_scheduler") or mod is None:
            continue
        for attr in ("_finish_from_start", "_start_from_finish"):
            current = getattr(mod, attr, None)
            if current in swaps:
                patched.append((mod, attr, current))
                setattr(mod, attr, swaps[current])
    assert len(patched) >= 4, "the patch reached too few modules to compare anything"
    try:
        yield
    finally:
        for mod, attr, original in patched:
            setattr(mod, attr, original)


def _snapshot(project: Project) -> tuple[str, object]:
    try:
        result = schedule(copy.deepcopy(project))
    except SchedulerError as err:
        return type(err).__name__, str(err)
    return "ok", repr(result)


_LINK_TYPES = st.sampled_from(list(DependencyType))


@st.composite
def _projects(draw: st.DrawFn) -> Project:
    start = _BASE + timedelta(days=draw(st.integers(0, 6)))
    per_task = draw(st.booleans())
    calendars = (
        {
            "a": draw(_calendars(base=start, budget_runs=False)),
            "b": draw(_calendars(base=start, budget_runs=False)),
        }
        if per_task
        else None
    )
    n = draw(st.integers(min_value=1, max_value=10))
    day = st.integers(min_value=-20, max_value=120).map(lambda d: start + timedelta(days=d))
    tasks = []
    for i in range(n):
        progress = draw(st.sampled_from(["none", "pct", "start", "finish", "both", "done"]))
        actual_start = draw(day) if progress in ("start", "both") else None
        actual_finish = draw(day) if progress in ("finish", "both") else None
        if actual_start and actual_finish and actual_finish < actual_start:
            actual_start, actual_finish = actual_finish, actual_start
        tasks.append(
            Task(
                id=f"t{i}",
                name=f"T{i}",
                duration=timedelta(days=draw(st.sampled_from([0, 0, 1, 2, 5, 13, 40]))),
                percent_complete=(
                    100.0
                    if progress == "done"
                    else float(draw(st.integers(1, 99)))
                    if progress in ("pct", "start")
                    else 0.0
                ),
                actual_start=actual_start,
                actual_finish=actual_finish,
                planned_start=draw(st.none() | day),
                live_day_end_on=actual_finish or actual_start if draw(st.booleans()) else None,
                calendar_id=draw(st.sampled_from([None, "a", "b"])) if per_task else None,
            )
        )
    deps = []
    for i in range(1, n):
        for p in draw(st.sets(st.integers(0, i - 1), max_size=2)):
            deps.append(
                Dependency(
                    predecessor_id=f"t{p}",
                    successor_id=f"t{i}",
                    dep_type=draw(_LINK_TYPES),
                    lag=timedelta(days=draw(st.integers(-5, 10))),
                )
            )
    return Project(
        id="p",
        name="p",
        start_date=start,
        tasks=tasks,
        dependencies=deps,
        # Budget-length runs are swept by the helper-level tests; here they would
        # make most projects unschedulable and starve the comparison.
        calendar=draw(_calendars(base=start, budget_runs=False)),
        status_date=draw(st.none() | day),
        calendars=calendars,
    )


@given(project=_projects())
@settings(max_examples=400, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_schedule_is_identical_with_the_walk(project: Project) -> None:
    new = _snapshot(project)
    with _walk_patched():
        old = _snapshot(project)
    assert new == old


def test_generator_reaches_the_forward_pass() -> None:
    """Guard the acceptance rate: a generator the engine mostly rejects compares nothing."""
    accepted = 0

    @given(project=_projects())
    @settings(max_examples=200, deadline=None, database=None)
    def probe(project: Project) -> None:
        nonlocal accepted
        accepted += _snapshot(project)[0] == "ok"

    probe()
    assert accepted >= 150
