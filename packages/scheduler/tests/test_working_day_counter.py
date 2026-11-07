"""_WorkingDayCounter must reproduce _working_days_between exactly (ADR-0142, #822, #4713).

The counter is a thin wrapper: ``build`` is O(1) and ``between`` delegates to the
arithmetic ``_working_days_between``. These tests pin them to identical counts
across weekends, calendar exceptions, empty/degenerate spans, and spans outside
the (now ignored) ``lo``/``hi`` passed to ``build`` — the property the schedule()
conformance contract relies on.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

from trueppm_scheduler.engine import (
    _count_working_days,
    _working_days_between,
    _WorkingDayCounter,
)
from trueppm_scheduler.models import Calendar, DateRange


def _check(cal: Calendar, lo: date, hi: date) -> None:
    counter = _WorkingDayCounter.build(lo, hi, cal)
    d = lo - timedelta(days=2)
    while d <= hi + timedelta(days=2):
        e = d
        while e <= hi + timedelta(days=2):
            # Spans inside and spilling out of [lo, hi] must both match.
            assert counter.between(d, e) == _working_days_between(d, e, cal), (d, e)
            e += timedelta(days=1)
        d += timedelta(days=1)


def test_matches_scalar_default_weekends() -> None:
    _check(Calendar(), date(2026, 1, 1), date(2026, 1, 31))


def test_matches_scalar_with_exceptions() -> None:
    cal = Calendar(
        exceptions=[
            DateRange(date(2026, 1, 5), date(2026, 1, 6)),
            DateRange(date(2026, 1, 19), date(2026, 1, 19)),
        ]
    )
    _check(cal, date(2026, 1, 1), date(2026, 1, 31))


def test_matches_scalar_seven_day_week() -> None:
    _check(Calendar(working_days=0b1111111), date(2026, 2, 1), date(2026, 2, 20))


def test_empty_and_reversed_spans_are_zero() -> None:
    cal = Calendar()
    counter = _WorkingDayCounter.build(date(2026, 1, 1), date(2026, 1, 31), cal)
    same = date(2026, 1, 10)
    assert counter.between(same, same) == 0
    assert counter.between(date(2026, 1, 20), date(2026, 1, 10)) == 0


def test_spans_outside_build_range_are_still_exact() -> None:
    cal = Calendar()
    # Build over a narrow range, then query a span beyond it on both ends.
    counter = _WorkingDayCounter.build(date(2026, 1, 10), date(2026, 1, 15), cal)
    lo, hi = date(2026, 1, 1), date(2026, 1, 31)
    assert counter.between(lo, hi) == _working_days_between(lo, hi, cal)


def _random_calendar(rng: random.Random) -> Calendar:
    base = date(2026, 1, 1)
    exceptions = []
    for _ in range(rng.randint(0, 8)):
        start = base + timedelta(days=rng.randint(0, 120))
        exceptions.append(DateRange(start, start + timedelta(days=rng.randint(0, 6))))
    return Calendar(working_days=rng.randint(1, 0b1111111), exceptions=exceptions)


def test_between_equals_working_days_between_over_random_calendars() -> None:
    """``between`` is a pure delegate, regardless of the (ignored) build range (#4713)."""
    rng = random.Random(4713)
    for _ in range(40):
        cal = _random_calendar(rng)
        lo = date(2026, 1, 1) + timedelta(days=rng.randint(0, 30))
        counter = _WorkingDayCounter.build(lo, lo + timedelta(days=rng.randint(0, 90)), cal)
        for _ in range(60):
            s = date(2025, 12, 1) + timedelta(days=rng.randint(0, 200))
            e = s + timedelta(days=rng.randint(-5, 90))
            assert counter.between(s, e) == _working_days_between(s, e, cal), (s, e)


def _old_walk_count(start: date, end: date, cal: Calendar) -> int:
    """The pre-#4692 day walk: working days in the closed range [start, end]."""
    n = 0
    d = start
    while d <= end:
        n += cal.is_working_day(d)
        d += timedelta(days=1)
    return n


def test_count_working_days_matches_old_walk_semantics() -> None:
    """Inclusive end, 0 when start > end, same-day = 1 iff working (#4713)."""
    rng = random.Random(4713)
    for _ in range(40):
        cal = _random_calendar(rng)
        for _ in range(40):
            s = date(2025, 12, 15) + timedelta(days=rng.randint(0, 150))
            e = s + timedelta(days=rng.randint(-4, 60))
            assert _count_working_days(s, e, cal) == _old_walk_count(s, e, cal), (s, e)
        d = date(2026, 2, 3)
        assert _count_working_days(d, d, cal) == int(cal.is_working_day(d))
