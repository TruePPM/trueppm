"""_WorkingDayCounter must reproduce _working_days_between exactly (ADR-0142, #822).

The counter is the O(log n) hot-path replacement for the scalar O(span) loop in
CPM float computation. These tests pin them to byte-identical counts across
weekends, calendar exceptions, empty/degenerate spans, and the out-of-range
fallback — the property the schedule() conformance contract relies on.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler.engine import _working_days_between, _WorkingDayCounter
from trueppm_scheduler.models import Calendar, DateRange


def _check(cal: Calendar, lo: date, hi: date) -> None:
    counter = _WorkingDayCounter.build(lo, hi, cal)
    d = lo - timedelta(days=2)
    while d <= hi + timedelta(days=2):
        e = d
        while e <= hi + timedelta(days=2):
            # Spans fully inside [lo, hi] use the index; anything spilling out
            # falls back to the scalar — both must equal the reference.
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


def test_out_of_range_falls_back_to_scalar() -> None:
    cal = Calendar()
    # Build a narrow index, then query a span beyond it on both ends.
    counter = _WorkingDayCounter.build(date(2026, 1, 10), date(2026, 1, 15), cal)
    lo, hi = date(2026, 1, 1), date(2026, 1, 31)
    assert counter.between(lo, hi) == _working_days_between(lo, hi, cal)
