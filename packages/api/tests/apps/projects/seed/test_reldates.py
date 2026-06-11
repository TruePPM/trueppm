"""Unit tests for the seed v2 relative-date resolver (ADR-0114).

Pure functions — no database. Covers anchor resolution, offset arithmetic,
weekend-snapping via the calendar bitmask, the ``!`` snap opt-out, ISO
pass-through (v1 compatibility), and timestamp resolution.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

from trueppm_api.apps.projects.seed.reldates import (
    WorkingCalendar,
    resolve_anchor,
    resolve_date,
    resolve_timestamp,
)

# A Wednesday, so weekend math is easy to reason about.
ANCHOR = date(2026, 6, 10)
MON_FRI = WorkingCalendar(working_days=31)


def test_anchor_explicit_overrides_today() -> None:
    assert resolve_anchor({"anchor": "2026-01-05"}, date(2030, 1, 1)) == date(2026, 1, 5)


def test_anchor_defaults_to_today() -> None:
    today = date(2026, 6, 10)
    assert resolve_anchor({}, today) == today


def test_relative_offset_back_and_forward() -> None:
    # 2026-02-10 is a Tuesday — a working day, no snap.
    assert resolve_date("A-120", anchor=ANCHOR, calendar=MON_FRI) == date(2026, 2, 10)


def test_relative_offset_snaps_weekend_forward() -> None:
    # Wed 6/10 + 4 = Sun 6/14 -> snaps forward to Mon 6/15.
    assert resolve_date("A+4", anchor=ANCHOR, calendar=MON_FRI) == date(2026, 6, 15)


def test_bang_suffix_opts_out_of_snap() -> None:
    # Same Sunday, but "!" lands it exactly.
    assert resolve_date("A+4!", anchor=ANCHOR, calendar=MON_FRI) == date(2026, 6, 14)


def test_snap_off_argument() -> None:
    assert resolve_date("A+4", anchor=ANCHOR, calendar=MON_FRI, snap=False) == date(2026, 6, 14)


def test_iso_literal_passes_through() -> None:
    assert resolve_date("2026-01-05", anchor=ANCHOR, calendar=MON_FRI) == date(2026, 1, 5)


def test_exception_date_is_non_working() -> None:
    cal = WorkingCalendar(working_days=31, exception_dates=frozenset({date(2026, 6, 11)}))
    # Wed 6/10 + 1 = Thu 6/11 is an exception -> snaps to Fri 6/12.
    assert resolve_date("A+1", anchor=ANCHOR, calendar=cal) == date(2026, 6, 12)


def test_timestamp_with_time() -> None:
    dt = resolve_timestamp("A-87T14:10", anchor=ANCHOR)
    assert dt == datetime(2026, 3, 15, 14, 10, tzinfo=ZoneInfo("UTC"))


def test_timestamp_without_time_is_midnight() -> None:
    dt = resolve_timestamp("A-87", anchor=ANCHOR)
    assert dt == datetime(2026, 3, 15, 0, 0, tzinfo=ZoneInfo("UTC"))


def test_timestamp_is_never_snapped() -> None:
    # A+4 = Sunday; timestamps are not weekend-snapped.
    dt = resolve_timestamp("A+4T09:00", anchor=ANCHOR)
    assert dt.date() == date(2026, 6, 14)
