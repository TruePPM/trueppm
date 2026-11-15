"""Public working-day helpers in ``trueppm_scheduler.calendar`` (#5009).

The oracle for every helper is a plain day-by-day walk over
:meth:`Calendar.is_working_day` — the predicate the engine rests on, and the
exact loop the TruePPM API used to hand-roll. The helpers count and step
arithmetically or by jumping exception runs, so each test pins them to that walk
over randomized masks and exception sets rather than to a few hand-picked dates.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

import trueppm_scheduler
from trueppm_scheduler import (
    MAX_CALENDAR_SCAN_DAYS,
    Calendar,
    DateRange,
    InvalidScheduleInput,
    next_working_day,
    nth_working_day,
    previous_working_day,
    working_day_count,
)
from trueppm_scheduler import calendar as calendar_module

_ONE = timedelta(days=1)
_BASE = date(2026, 1, 1)


def _loop_count(cal: Calendar, start: date, finish: date) -> int:
    total = 0
    cur = start
    while cur <= finish:
        total += cal.is_working_day(cur)
        cur += _ONE
    return total


def _loop_next(cal: Calendar, d: date) -> date:
    while not cal.is_working_day(d):
        d += _ONE
    return d


def _loop_prev(cal: Calendar, d: date) -> date:
    while not cal.is_working_day(d):
        d -= _ONE
    return d


def _loop_nth(cal: Calendar, start: date, n: int) -> date:
    if n <= 0:
        return start
    cur = _loop_next(cal, start)
    counted = 1
    while counted < n:
        cur += _ONE
        counted += cal.is_working_day(cur)
    return cur


def _random_calendar(rng: random.Random) -> Calendar:
    mask = rng.randint(1, 127)
    exceptions = []
    for _ in range(rng.randint(0, 6)):
        lo = _BASE + timedelta(days=rng.randint(0, 120))
        exceptions.append(DateRange(lo, lo + timedelta(days=rng.randint(0, 20))))
    return Calendar(working_days=mask, exceptions=exceptions)


@pytest.mark.parametrize("seed", range(200))
def test_helpers_match_the_day_by_day_walk(seed: int) -> None:
    rng = random.Random(seed)
    cal = _random_calendar(rng)
    start = _BASE + timedelta(days=rng.randint(-10, 130))
    finish = start + timedelta(days=rng.randint(-3, 90))
    n = rng.randint(-1, 40)

    assert working_day_count(start, finish, cal) == _loop_count(cal, start, finish)
    assert next_working_day(start, cal, inclusive=True) == _loop_next(cal, start)
    assert next_working_day(start, cal) == _loop_next(cal, start + _ONE)
    assert previous_working_day(start, cal, inclusive=True) == _loop_prev(cal, start)
    assert previous_working_day(start, cal) == _loop_prev(cal, start - _ONE)
    assert nth_working_day(start, n, cal) == _loop_nth(cal, start, n)


def test_count_is_inclusive_on_both_ends() -> None:
    cal = Calendar()  # Mon-Fri
    monday, friday = date(2026, 11, 16), date(2026, 11, 20)
    assert working_day_count(monday, friday, cal) == 5
    assert working_day_count(monday, monday, cal) == 1
    assert working_day_count(friday, monday, cal) == 0


def test_count_reaches_date_max_without_overflow() -> None:
    cal = Calendar(working_days=0b1111111)
    assert working_day_count(date.max - timedelta(days=2), date.max, cal) == 3


def test_count_reaches_date_max_with_exceptions() -> None:
    # date.max is a Friday: Mon-Fri of its week minus a Wednesday holiday is 4.
    friday = date.max
    cal = Calendar(exceptions=[DateRange(friday - timedelta(days=2), friday - timedelta(days=2))])
    start = friday - timedelta(days=4)
    assert start.weekday() == 0 and friday.weekday() == 4  # hand count: 5 weekdays - 1 holiday
    assert working_day_count(start, friday, cal) == 4


def test_next_and_previous_skip_a_holiday_and_weekend() -> None:
    friday = date(2026, 11, 20)
    monday = date(2026, 11, 23)
    cal = Calendar(exceptions=[DateRange(monday, monday)])
    assert next_working_day(friday, cal) == date(2026, 11, 24)
    assert previous_working_day(date(2026, 11, 24), cal) == friday
    assert next_working_day(friday, cal, inclusive=True) == friday


def test_nth_working_day_counts_from_the_first_working_day() -> None:
    cal = Calendar()
    saturday = date(2026, 11, 21)
    assert nth_working_day(saturday, 1, cal) == date(2026, 11, 23)
    assert nth_working_day(date(2026, 11, 16), 5, cal) == date(2026, 11, 20)
    assert nth_working_day(saturday, 0, cal) == saturday


def test_degenerate_calendar_raises_the_documented_error() -> None:
    blanket = DateRange(_BASE, _BASE + timedelta(days=MAX_CALENDAR_SCAN_DAYS + 10))
    cal = Calendar(exceptions=[blanket])
    with pytest.raises(InvalidScheduleInput):
        next_working_day(_BASE, cal, inclusive=True)
    with pytest.raises(InvalidScheduleInput):
        previous_working_day(blanket.end, cal, inclusive=True)
    with pytest.raises(InvalidScheduleInput):
        nth_working_day(_BASE, 2, cal)


def test_helpers_are_public_from_the_root_and_the_module() -> None:
    for name in calendar_module.__all__:
        assert name in trueppm_scheduler.__all__
        assert getattr(trueppm_scheduler, name) is getattr(calendar_module, name)
