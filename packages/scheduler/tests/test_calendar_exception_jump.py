"""Calendar snaps cross an exception run in one step, not one day at a time (#4161).

A single exception range just under ``MAX_CALENDAR_SCAN_DAYS`` passed every
validator, and ``schedule()`` then re-walked it once per dependency edge — in the
forward pass, the backward pass, and the free-float slack — so a few hundred edges
cost seconds and ``MC_TASK_CAP`` edges cost minutes. The snap helpers and the
working-day span count now jump across a whole merged exception interval.

Two kinds of test here: the jump must return exactly what the day-by-day walk
returned (including where and how the scan budget and the ``date`` range give out),
and ``schedule()`` must stay flat in edge count on the blanket calendar.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    MAX_CALENDAR_SCAN_DAYS,
    Calendar,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    schedule,
)
from trueppm_scheduler.engine import (
    _next_working_day,
    _prev_working_day,
    _scan_for_working_day,
    _working_days_between,
)
from trueppm_scheduler.models import DateRange

# ---------------------------------------------------------------------------
# Day-by-day references — the pre-#4161 implementations, kept verbatim in shape
# ---------------------------------------------------------------------------


def _ref_snap(d: date, cal: Calendar, step: int, budget: int = MAX_CALENDAR_SCAN_DAYS) -> date:
    scanned = 0
    while not cal.is_working_day(d):
        if scanned >= budget:
            raise InvalidScheduleInput("scan")
        try:
            d = d + timedelta(days=step)
        except OverflowError as err:
            raise InvalidScheduleInput("overflow") from err
        scanned += 1
    return d


def _ref_scan(current: date, cal: Calendar, step: int) -> date:
    scanned = 0
    while True:
        try:
            current = current + timedelta(days=step)
        except OverflowError as err:
            raise InvalidScheduleInput("overflow") from err
        scanned += 1
        if cal.is_working_day(current):
            return current
        if scanned >= MAX_CALENDAR_SCAN_DAYS:
            raise InvalidScheduleInput("scan")


def _ref_between(start: date, end: date, cal: Calendar) -> int:
    count = 0
    current = start
    while current < end:
        count += cal.is_working_day(current)
        current += timedelta(days=1)
    return count


def _scan_forward(d: date, cal: Calendar) -> date:
    return _scan_for_working_day(d, cal, forward=True)


def _scan_backward(d: date, cal: Calendar) -> date:
    return _scan_for_working_day(d, cal, forward=False)


def _outcome(fn: Callable[..., date], *args: object) -> date | str:
    """The result, or which of the two guards fired (matched on the message)."""
    try:
        return fn(*args)
    except InvalidScheduleInput as err:
        return "overflow" if "representable" in str(err) or "overflow" in str(err) else "scan"


def _random_calendar(rng: random.Random, base: date) -> Calendar:
    ranges = []
    for _ in range(rng.randint(0, 8)):
        s = base + timedelta(days=rng.randint(-60, 60))
        ranges.append(DateRange(s, s + timedelta(days=rng.randint(0, 20))))
    return Calendar(working_days=rng.randint(1, 0b1111111), exceptions=ranges)


# ---------------------------------------------------------------------------
# Equivalence with the day-by-day walk
# ---------------------------------------------------------------------------


def test_snaps_and_span_match_the_day_walk_on_random_calendars() -> None:
    """Overlapping/adjacent ranges, sparse masks, and dates inside, before, and after
    every run — the jump and the arithmetic span must agree with the walk everywhere."""
    rng = random.Random(4161)
    base = date(2026, 3, 1)
    for _ in range(300):
        cal = _random_calendar(rng, base)
        for _ in range(20):
            d = base + timedelta(days=rng.randint(-80, 80))
            assert _next_working_day(d, cal) == _ref_snap(d, cal, 1), (cal, d)
            assert _prev_working_day(d, cal) == _ref_snap(d, cal, -1), (cal, d)
            assert _scan_for_working_day(d, cal, forward=True) == _ref_scan(d, cal, 1)
            assert _scan_for_working_day(d, cal, forward=False) == _ref_scan(d, cal, -1)
            e = d + timedelta(days=rng.randint(-5, 120))
            assert _working_days_between(d, e, cal) == _ref_between(d, e, cal), (cal, d, e)


@pytest.mark.parametrize("extra", [-1, 0, 1])
def test_scan_budget_boundary_matches_the_day_walk(extra: int) -> None:
    """A gap of exactly the budget is still crossed; one day more is rejected — at the
    same edge the day walk drew it, in both directions and for the stepping scan."""
    mask_all = 0b1111111
    start = date(2026, 1, 1)
    gap = MAX_CALENDAR_SCAN_DAYS + extra
    fwd = Calendar(
        working_days=mask_all,
        exceptions=[DateRange(start, start + timedelta(days=gap - 1))],
    )
    assert _outcome(_next_working_day, start, fwd) == _outcome(_ref_snap, start, fwd, 1)
    before = start - timedelta(days=1)
    assert _outcome(_scan_forward, before, fwd) == _outcome(_ref_scan, before, fwd, 1)

    end = start + timedelta(days=gap - 1)
    assert _outcome(_prev_working_day, end, fwd) == _outcome(_ref_snap, end, fwd, -1)
    after = end + timedelta(days=1)
    assert _outcome(_scan_backward, after, fwd) == _outcome(_ref_scan, after, fwd, -1)


def test_date_range_edges_raise_the_same_guard_as_the_day_walk() -> None:
    """An exception running into ``date.max``/``date.min`` hits the overflow guard when
    the edge is nearer than the budget, and the scan guard when it is farther."""
    near = Calendar(exceptions=[DateRange(date.max - timedelta(days=30), date.max)])
    d = date.max - timedelta(days=10)
    assert _outcome(_next_working_day, d, near) == "overflow"
    assert _outcome(_ref_snap, d, near, 1) == "overflow"

    near_min = Calendar(exceptions=[DateRange(date.min, date.min + timedelta(days=30))])
    d = date.min + timedelta(days=10)
    assert _outcome(_prev_working_day, d, near_min) == "overflow"
    assert _outcome(_ref_snap, d, near_min, -1) == "overflow"

    # The tie: the budget and the date range run out on the same day.
    for back in (MAX_CALENDAR_SCAN_DAYS - 1, MAX_CALENDAR_SCAN_DAYS, MAX_CALENDAR_SCAN_DAYS + 1):
        hi = date.max - timedelta(days=back)
        tie_hi = Calendar(exceptions=[DateRange(hi, date.max)])
        assert _outcome(_next_working_day, hi, tie_hi) == _outcome(_ref_snap, hi, tie_hi, 1)
        lo = date.min + timedelta(days=back)
        tie_lo = Calendar(exceptions=[DateRange(date.min, lo)])
        assert _outcome(_prev_working_day, lo, tie_lo) == _outcome(_ref_snap, lo, tie_lo, -1)

    far_start = date.max - timedelta(days=MAX_CALENDAR_SCAN_DAYS + 5)
    far = Calendar(exceptions=[DateRange(far_start, date.max)])
    assert _outcome(_next_working_day, far_start, far) == "scan"
    assert _outcome(_ref_snap, far_start, far, 1) == "scan"


# ---------------------------------------------------------------------------
# schedule() stays flat in edge count over a century-long exception
# ---------------------------------------------------------------------------

# One working Monday, then an exception to 2126-01-01 (a Friday follows it).
_BLANKET = Calendar(exceptions=[DateRange(date(2026, 1, 6), date(2126, 1, 1))])
_START = date(2026, 1, 5)
_EDGES = 200
# Measured before the fix: ~32 ms/edge, so 200 edges took ~6 s. After: ~12 ms total.
_BUDGET_S = 0.5


def _fan_out(dep_type: DependencyType, lag: timedelta) -> Project:
    tasks = [Task(id="r", name="r", duration=timedelta(days=1))] + [
        Task(id=f"s{i}", name=f"s{i}", duration=timedelta(days=1)) for i in range(_EDGES)
    ]
    deps = [
        Dependency(predecessor_id="r", successor_id=f"s{i}", dep_type=dep_type, lag=lag)
        for i in range(_EDGES)
    ]
    return Project(
        id="p", name="p", start_date=_START, tasks=tasks, dependencies=deps, calendar=_BLANKET
    )


@pytest.mark.parametrize(
    ("dep_type", "lag", "finish"),
    [
        # FS: the successor may start the day after r → inside the exception.
        (DependencyType.FS, timedelta(), date(2126, 1, 2)),
        # SS/FF with a 1-day lag land on Jan 6 → inside the exception.
        (DependencyType.SS, timedelta(days=1), date(2126, 1, 2)),
        (DependencyType.FF, timedelta(days=1), date(2126, 1, 2)),
        # SF: the forward bound is cheap, but the free-float slack retreats across
        # the exception and measures a span outside the counter's range per edge.
        (DependencyType.SF, timedelta(), _START),
    ],
)
def test_fan_out_over_blanket_exception_is_flat_in_edges(
    dep_type: DependencyType, lag: timedelta, finish: date
) -> None:
    project = _fan_out(dep_type, lag)
    t0 = time.perf_counter()
    result = schedule(project)
    elapsed = time.perf_counter() - t0
    assert result.project_finish == finish
    assert elapsed < _BUDGET_S, f"{dep_type.name}: {elapsed:.2f}s for {_EDGES} edges"


def test_fan_in_backward_retreat_over_blanket_exception_is_flat_in_edges() -> None:
    """Every predecessor's late finish retreats from a sink past the exception back
    across all of it — the backward pass's per-edge walk, independent of fan-out."""
    tasks = [Task(id=f"x{i}", name=f"x{i}", duration=timedelta(days=1)) for i in range(_EDGES)]
    tasks.append(Task(id="z", name="z", duration=timedelta(days=1)))
    deps = [Dependency(predecessor_id=f"x{i}", successor_id="z") for i in range(_EDGES)]
    project = Project(
        id="p", name="p", start_date=_START, tasks=tasks, dependencies=deps, calendar=_BLANKET
    )
    t0 = time.perf_counter()
    result = schedule(project)
    elapsed = time.perf_counter() - t0
    assert result.project_finish == date(2126, 1, 2)
    x0 = next(t for t in result.tasks if t.id == "x0")
    # The late finish is the working day before the sink's start — back across the
    # whole exception to the one working Monday.
    assert x0.late_finish == _START
    assert elapsed < _BUDGET_S, f"{elapsed:.2f}s for {_EDGES} edges"
