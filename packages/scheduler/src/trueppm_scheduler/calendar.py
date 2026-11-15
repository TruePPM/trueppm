"""Public working-day helpers over a :class:`~trueppm_scheduler.Calendar`.

These are the calendar walks the engine itself performs, exposed so an embedder
(the TruePPM API among them) counts and steps working days with the engine's
rule instead of re-deriving it with its own ``date + timedelta`` loop (#5009). A
hand-rolled walk drifts the moment the engine's notion of a working day changes —
holiday exceptions, layered calendars, the scan bound on a degenerate calendar —
and nothing ties the two together; calling the engine's own primitive does.

Every helper treats a day as working exactly when
:meth:`Calendar.is_working_day` says so, and every walk is bounded by
:data:`~trueppm_scheduler.MAX_CALENDAR_SCAN_DAYS`: a calendar with no working day
inside that window raises :class:`~trueppm_scheduler.InvalidScheduleInput` rather
than spinning to the ``date`` ceiling.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler.engine.calendar_math import (
    _finish_from_start,
    _next_working_day,
    _prev_working_day,
    _safe_offset,
    _working_days_in_ordinals,
)
from trueppm_scheduler.models import Calendar

__all__ = [
    "next_working_day",
    "nth_working_day",
    "previous_working_day",
    "working_day_count",
]

_ONE_DAY = timedelta(days=1)


def next_working_day(day: date, calendar: Calendar, *, inclusive: bool = False) -> date:
    """Return the first working day after ``day`` (or on it, when ``inclusive``).

    Args:
        day: The date to start from.
        calendar: The calendar that defines working time.
        inclusive: When ``True``, ``day`` itself is returned if it is a working
            day. When ``False`` (the default) the result is strictly after ``day``.

    Returns:
        The first working day at or after the starting point.

    Raises:
        InvalidScheduleInput: No working day lies within
            ``MAX_CALENDAR_SCAN_DAYS`` of the starting point, or the walk would
            leave the representable ``date`` range.
    """
    start = day if inclusive else _safe_offset(day, _ONE_DAY)
    return _next_working_day(start, calendar)


def previous_working_day(day: date, calendar: Calendar, *, inclusive: bool = False) -> date:
    """Return the last working day before ``day`` (or ``day`` itself, when ``inclusive``).

    Args:
        day: The date to start from.
        calendar: The calendar that defines working time.
        inclusive: When ``True``, ``day`` itself is returned if it is a working
            day. When ``False`` (the default) the result is strictly before ``day``.

    Returns:
        The last working day at or before the starting point.

    Raises:
        InvalidScheduleInput: No working day lies within
            ``MAX_CALENDAR_SCAN_DAYS`` of the starting point, or the walk would
            leave the representable ``date`` range.
    """
    start = day if inclusive else _safe_offset(day, -_ONE_DAY)
    return _prev_working_day(start, calendar)


def nth_working_day(start: date, n: int, calendar: Calendar) -> date:
    """Return the ``n``-th working day of a span that begins at ``start``.

    This is the "add working days" helper, and it is the engine's own rule for
    laying a working-day duration onto a calendar: day one is the first working
    day on or after ``start``, so ``n=1`` returns that day and ``n=5`` on a
    Monday-to-Friday calendar from a Monday returns the Friday. ``n <= 0`` is a
    zero-length span and returns ``start`` unchanged, as a milestone does.

    Args:
        start: The first calendar day of the span.
        n: How many working days the span holds.
        calendar: The calendar that defines working time.

    Returns:
        The date of the span's last working day.

    Raises:
        InvalidScheduleInput: A gap longer than ``MAX_CALENDAR_SCAN_DAYS`` with no
            working day interrupts the span, or the span leaves the representable
            ``date`` range.
    """
    return _finish_from_start(start, n, calendar)


def working_day_count(start: date, finish: date, calendar: Calendar) -> int:
    """Count the working days in ``[start, finish]``, both ends inclusive.

    Counted arithmetically from the weekday mask and the calendar's merged
    exception runs, so the cost does not grow with the length of the span. A
    ``finish`` before ``start`` is an empty span and counts ``0``.

    Args:
        start: First day of the span, counted if it is a working day.
        finish: Last day of the span, counted if it is a working day.
        calendar: The calendar that defines working time.

    Returns:
        The number of days in the span for which
        :meth:`Calendar.is_working_day` is ``True``.
    """
    if finish < start:
        return 0
    # Ordinals, not ``finish + 1 day``: an inclusive span ending on ``date.max``
    # must not overflow building its exclusive end.
    return _working_days_in_ordinals(start.toordinal(), finish.toordinal() + 1, calendar)
