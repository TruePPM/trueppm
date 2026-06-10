"""Resolve seed v2 relative dates and timestamps (ADR-0113).

A v2 seed authors dates as offsets from an ``anchor`` resolved at import day, so
a bundled demo always looks current instead of aging into a museum piece:

    "A-120"      anchor minus 120 calendar days, snapped forward to a working day
    "A+15"       anchor plus 15 days
    "A-120!"     the trailing "!" opts out of weekend-snapping (land exactly)
    "A-87T14:10" an event timestamp (never snapped — an event occurs when it occurs)

ISO literals (``"2026-01-05"``, ``"2026-01-05T14:10"``) remain valid so a v1
fixture migrated field-by-field still parses. The grammar is enforced by the v2
JSON Schema (``seedDate`` / ``seedTimestamp``); this module assumes well-formed
input and turns it into concrete ``date`` / aware ``datetime`` values.

Weekend-snapping uses the project ``Calendar`` convention directly — the
``working_days`` bitmask (Mon=1 … Sun=64) plus ``CalendarException`` non-working
ranges — rather than importing the scheduler, so the resolver stays a pure
function with no engine dependency. A snapped date advances forward to the next
working day; a milestone that must land exactly authors the ``!`` suffix.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

# Mon=0 … Sun=6 (date.weekday) → bit Mon=1 … Sun=64 (Calendar.working_days).
_DEFAULT_WORKING_DAYS = 31  # Mon-Fri
_MAX_SNAP_DAYS = 366  # guard against a calendar with no reachable working day

_REL_DATE = re.compile(r"^A(?P<sign>[+-])(?P<days>\d+)(?P<bang>!?)$")
_REL_TS = re.compile(r"^A(?P<sign>[+-])(?P<days>\d+)(?:T(?P<h>\d{2}):(?P<m>\d{2}))?$")


class WorkingCalendar:
    """The minimal calendar facts the resolver needs to snap a date forward.

    Constructed from a ``Calendar`` model (or defaulted) so the resolver never
    touches the ORM itself — the importer hands it the bitmask and the set of
    non-working dates already materialized from ``CalendarException`` ranges.
    """

    def __init__(
        self,
        working_days: int = _DEFAULT_WORKING_DAYS,
        exception_dates: frozenset[date] | None = None,
        tz: tzinfo | None = None,
    ) -> None:
        # A zero/invalid mask would make every day non-working and snapping
        # pointless; fall back to Mon-Fri (the validator already rejects 0).
        self.working_days = working_days or _DEFAULT_WORKING_DAYS
        self.exception_dates = exception_dates or frozenset()
        self.tz = tz or ZoneInfo("UTC")

    def is_working_day(self, d: date) -> bool:
        if d in self.exception_dates:
            return False
        return bool(self.working_days & (1 << d.weekday()))

    def snap_forward(self, d: date) -> date:
        """Advance ``d`` to the next working day (returns ``d`` if already one)."""
        for _ in range(_MAX_SNAP_DAYS):
            if self.is_working_day(d):
                return d
            d += timedelta(days=1)
        return d  # unreachable in practice; never loop forever


def resolve_anchor(payload: dict[str, Any], today: date) -> date:
    """Resolve the program anchor: an explicit ``anchor`` date, else import day.

    An explicit anchor pins a fixed-date demo (discouraged); the common case is
    no ``anchor`` key, which resolves to ``today`` so the demo is always current.
    """
    raw = payload.get("anchor")
    return date.fromisoformat(raw) if raw else today


def resolve_date(
    value: str,
    *,
    anchor: date,
    calendar: WorkingCalendar | None = None,
    snap: bool = True,
) -> date:
    """Resolve a ``seedDate`` (ISO literal or ``A±N[!]``) to a concrete date.

    Relative dates snap forward to the next working day unless the ``!`` suffix
    is present or ``snap=False`` (the caller already knows the field is exact).
    """
    m = _REL_DATE.match(value)
    if m is None:
        return date.fromisoformat(value)  # ISO literal
    offset = int(m["days"]) * (-1 if m["sign"] == "-" else 1)
    resolved = anchor + timedelta(days=offset)
    if m["bang"] == "!" or not snap or calendar is None:
        return resolved
    return calendar.snap_forward(resolved)


def resolve_timestamp(
    value: str,
    *,
    anchor: date,
    tz: tzinfo | None = None,
) -> datetime:
    """Resolve a ``seedTimestamp`` to an aware datetime. Never weekend-snapped.

    A relative timestamp with no ``THH:MM`` resolves to midnight. ISO literals
    are accepted for v1-compatibility. The result is made timezone-aware in
    ``tz`` (default UTC) so it is a valid ``history_date``.
    """
    tz = tz or ZoneInfo("UTC")
    m = _REL_TS.match(value)
    if m is None:
        dt = datetime.fromisoformat(value)
    else:
        offset = int(m["days"]) * (-1 if m["sign"] == "-" else 1)
        day = anchor + timedelta(days=offset)
        hour = int(m["h"]) if m["h"] is not None else 0
        minute = int(m["m"]) if m["m"] is not None else 0
        dt = datetime(day.year, day.month, day.day, hour, minute)
    return dt.replace(tzinfo=tz) if dt.tzinfo is None else dt
