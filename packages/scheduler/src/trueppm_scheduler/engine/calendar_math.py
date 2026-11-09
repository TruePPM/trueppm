"""Calendar-aware date arithmetic: working-day snapping, counting and offsets."""

from __future__ import annotations

from datetime import (
    date,
    timedelta,
)

from trueppm_scheduler.engine.errors import (
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.limits import (
    MAX_CALENDAR_SCAN_DAYS,
)
from trueppm_scheduler.models import (
    Calendar,
    Task,
    _mask_days_between,
)

# ---------------------------------------------------------------------------
# Calendar-aware date arithmetic
# ---------------------------------------------------------------------------


def _safe_offset(d: date, delta: timedelta) -> date:
    """``d + delta``, converting a ``date`` min/max OverflowError into the public type.

    The engine accumulates dates one calendar step (and one lag) at a time; near the
    representable ceiling a raw ``date + timedelta`` raises a bare ``OverflowError``
    that escapes the documented exception contract and crashes the CLI / Celery
    worker (#1207). The eager span/reach guards in :func:`_validate_project` reject
    the realistic cases up front; this is the last-line backstop so no calendar walk
    or lag add can leak an ``OverflowError``.
    """
    try:
        return d + delta
    except OverflowError as err:
        raise InvalidScheduleInput(
            "The schedule span pushed a date past the representable date range; move "
            "the project start date away from that end of the range or reduce "
            "durations/lags."
        ) from err


_MIN_ORDINAL = date.min.toordinal()


_MAX_ORDINAL = date.max.toordinal()


def _safe_fromordinal(ordinal: int) -> date:
    """``date.fromordinal`` with the :func:`_safe_offset` contract.

    Monte Carlo works in integer ordinals and steps a day off them (the day before
    a milestone, an FF/SF anchor plus lag) without going through ``date``
    arithmetic, so a project starting at ``date.min`` reaches ordinal 0 and
    ``date.fromordinal`` raises a bare ``ValueError`` where ``schedule()`` raises
    :class:`InvalidScheduleInput` for the same input (#4265).
    """
    if not _MIN_ORDINAL <= ordinal <= _MAX_ORDINAL:
        raise InvalidScheduleInput(
            "The schedule span pushed a date past the representable date range; move "
            "the project start date away from that end of the range or reduce "
            "durations/lags."
        )
    return date.fromordinal(ordinal)


def _snap_to_working_day(
    d: date, calendar: Calendar, *, forward: bool, max_scan: int = MAX_CALENDAR_SCAN_DAYS
) -> date:
    """Return ``d`` if it is a working day, else the nearest one in ``forward`` direction.

    Why it jumps instead of stepping (#4161): the CPM passes snap once per
    dependency edge, and a single long exception range (a "closed until further
    notice" entry just short of :data:`MAX_CALENDAR_SCAN_DAYS`) made each of those
    snaps a ~36k-day walk — ``schedule()`` was O(edges * range length), minutes of
    synchronous CPU for a few hundred edges. The calendar already holds its
    exceptions as merged, disjoint intervals, so a day inside one is crossed to the
    interval's far edge in a single O(log E) step; only weekday-mask gaps (at most
    six days between exception runs) are still stepped. Each iteration therefore
    leaves at least one whole non-working run behind, and the result is the same
    date the day-by-day walk returned.

    The guards are the day-by-day walk's, restated on the jump: every day skipped
    is non-working, so a landing more than ``max_scan`` days from ``d`` means the
    walk would have exhausted its budget first (:class:`InvalidScheduleInput`), and
    a landing past the representable ``date`` range raises the
    :func:`_safe_offset` overflow error — unless the budget would have run out
    before the walk reached the boundary, exactly the order the walk hit them in.
    """
    step = 1 if forward else -1
    boundary = _MAX_ORDINAL if forward else _MIN_ORDINAL
    mask = calendar.working_days
    origin = o = d.toordinal()
    while True:
        # Works on ordinals so a weekend step costs no ``date`` construction. A day
        # whose weekday is in the mask is non-working only inside an exception, so
        # the interval lookup runs only then. ``(o - 1) % 7`` is the Monday=0
        # weekday (ordinal 1 is a Monday), the numbering ``is_working_day`` reads.
        if (mask >> ((o - 1) % 7)) & 1:
            run = calendar._exception_run(o)
            if run is None:
                return d if o == origin else date.fromordinal(o)
            o = run[1] + 1 if forward else run[0] - 1
        else:
            o += step
        if (o - boundary) * step > 0 and abs(boundary - origin) < max_scan:
            _safe_offset(date.fromordinal(boundary), timedelta(days=step))
        if abs(o - origin) > max_scan:
            raise InvalidScheduleInput(
                f"Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days "
                "of the requested date; check the working_days bitmask and exceptions."
            )


def _next_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the next working day.

    Guarded against a degenerate calendar (no working day, or exceptions
    blanketing the search window): rather than spin to the ``date`` ceiling and
    raise an opaque ``OverflowError``, it bails out with an actionable
    :class:`InvalidScheduleInput` after :data:`MAX_CALENDAR_SCAN_DAYS`.
    """
    if calendar.is_working_day(d):
        return d
    return _snap_to_working_day(d, calendar, forward=True)


def _prev_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the previous working day.

    Guarded symmetrically to :func:`_next_working_day`.
    """
    if calendar.is_working_day(d):
        return d
    return _snap_to_working_day(d, calendar, forward=False)


def _scan_for_working_day(current: date, calendar: Calendar, *, forward: bool) -> date:
    """Step one day from ``current`` (forward/backward) to the next working day.

    Unlike :func:`_next_working_day` / :func:`_prev_working_day` — which return
    ``current`` itself when it is already a working day — this always *advances*
    at least one day, so it is the primitive for walking off a known working day
    to the next one (duration expansion, working-day indexing).

    Guarded with the same :data:`MAX_CALENDAR_SCAN_DAYS` bound as the snap
    helpers: a calendar whose ``exceptions`` blanket the window *after* a valid
    start day (e.g. a single working day followed by a century of holidays) would
    otherwise walk the date past its representable ceiling and raise an opaque
    ``OverflowError`` mid-pass. Bailing here keeps every calendar walk — in both
    :func:`schedule` and :func:`monte_carlo` — bounded and surfacing one
    documented :class:`InvalidScheduleInput` instead.

    The first day off ``current`` counts against the budget, so the snap from
    there gets one day less of it.
    """
    step = timedelta(days=1) if forward else timedelta(days=-1)
    current = _safe_offset(current, step)
    # Fast path: the next day is usually a working day. Duration expansion calls
    # this once per working day of every task, so skipping the snap's setup here
    # is measurable on large projects.
    if calendar.is_working_day(current):
        return current
    return _snap_to_working_day(
        current,
        calendar,
        forward=forward,
        max_scan=MAX_CALENDAR_SCAN_DAYS - 1,
    )


def _finish_from_start(start: date, duration_days: int, calendar: Calendar) -> date:
    """Return the last working day of a task given its start and working-day duration.

    A duration of 1 means the task occupies only the start day.
    A duration of 0 is treated as a milestone: returns the start day unchanged.

    Why the walk begins at ``_next_working_day(start)`` rather than at ``start``
    (#3963): ``duration`` counts **working** days, so the first day of the walk has
    to be one. ``start`` is not guaranteed to be — a recorded ``actual_start`` is
    kept verbatim as the ES floor (ADR-0132 §2 / :func:`_early_start_floors`:
    actuals are truth and are never renegotiated), and the API sets one with no
    user intent at all ("Any → IN_PROGRESS: set actual_start = today"), so a
    contributor moving a card on a Saturday arms it. Counting that Saturday as
    work-day 1 spent one working day of the duration on a day the calendar says
    nobody works: the task finished a working day early, and because the backward
    pass lays the same duration back from a working-day LF, ``late_start`` landed
    *before* ``early_start`` and the inverted span was then clamped to zero float.

    Two separate quantities were being conflated. *When work began* is the recorded
    date and is kept; *how many working days of effort it takes* is the duration
    and is now laid out on working days only. Both engines take this rule
    (``wasm-scheduler/src/calendar.rs::finish_from_start``), and it is the rule
    ``monte_carlo``'s :func:`_mc_es_floors` already applied, which is why the two
    passes disagreed on a fully deterministic project.

    A duration of 0 is not a walk: a milestone keeps its verbatim date, so a
    completed milestone stays pinned exactly where it was recorded.
    """
    if duration_days <= 0:
        return start
    remaining = duration_days - 1
    current = _next_working_day(start, calendar)
    while remaining > 0:
        current = _scan_for_working_day(current, calendar, forward=True)
        remaining -= 1
    return current


def _start_from_finish(finish: date, duration_days: int, calendar: Calendar) -> date:
    """Return the first working day of a task given its finish and working-day duration.

    Inverse of :func:`_finish_from_start`, and snapped the same way for the same
    reason (#3963): the walk begins at ``_prev_working_day(finish)`` because the
    duration it lays out counts working days only. ``finish`` can be a non-working
    day — a completed task's ``actual_finish`` is recorded verbatim (ADR-0136,
    "actuals are truth") and drives this back-off in :func:`_pinned_placement` —
    and counting it as the last work day gave the task one working day fewer than
    its duration, the mirror image of the forward defect. Keeping the two helpers
    snapped symmetrically is what makes them inverses on every input rather than
    only on working-day ones.

    A duration of 0 returns ``finish`` unchanged, for the milestone reason in
    :func:`_finish_from_start`.
    """
    if duration_days <= 0:
        return finish
    remaining = duration_days - 1
    current = _prev_working_day(finish, calendar)
    while remaining > 0:
        current = _scan_for_working_day(current, calendar, forward=False)
        remaining -= 1
    return current


def _working_days_in_ordinals(lo: int, hi: int, calendar: Calendar) -> int:
    """Working days of ``calendar`` among the ordinals ``[lo, hi)``, arithmetically."""
    count = _mask_days_between(lo, hi, calendar.working_days)
    if calendar.exceptions:
        count -= calendar._exception_mask_days(lo, hi)
    return count


def _nth_working_day(anchor: date, n: int, calendar: Calendar, *, forward: bool) -> date:
    """The ``n``-th working day counting from ``anchor`` itself, forward or backward.

    Equal to :func:`_finish_from_start` (``forward=True``) and
    :func:`_start_from_finish` (``forward=False``) on every input those walks
    complete, but O(log span x log E) instead of O(n): an exponential then binary
    search over :func:`_working_days_in_ordinals`. Only the Monte Carlo index
    *sizing* bounds use it (#4695). Once the span guard stopped summing every scrum
    story's velocity worst case, the per-task layouts those bounds perform were no
    longer bounded in total by ``MAX_PROJECT_SPAN_DAYS`` — a thousand parallel
    stories each with a long worst case would have cost a thousand long day walks.
    Unlike the walks it does not raise on a calendar gap longer than
    ``MAX_CALENDAR_SCAN_DAYS``; the working-day index build that follows walks every
    calendar over the whole horizon and still refuses one.
    """
    if n <= 0:
        return anchor
    a = anchor.toordinal()
    limit = (_MAX_ORDINAL - a) if forward else (a - _MIN_ORDINAL)

    def reach(off: int) -> int:
        if forward:
            return _working_days_in_ordinals(a, a + off + 1, calendar)
        return _working_days_in_ordinals(a - off, a + 1, calendar)

    # Invariant: reach(lo_off) < n <= reach(hi_off), with reach(-1) == 0.
    lo_off, hi_off = -1, min(n - 1, limit)
    while reach(hi_off) < n:
        if hi_off >= limit:
            _safe_offset(anchor, timedelta(days=(limit + 1) if forward else -(limit + 1)))
        lo_off, hi_off = hi_off, min(limit, 2 * hi_off + 1)
    while hi_off - lo_off > 1:
        mid = (lo_off + hi_off) // 2
        if reach(mid) >= n:
            hi_off = mid
        else:
            lo_off = mid
    return date.fromordinal(a + hi_off if forward else a - hi_off)


def _effective_duration_days(task: Task) -> int:
    """Working-day duration of the *remaining* work on a task (ADR-0132).

    A task that has not started (``percent_complete == 0``) contributes its full
    estimate. An in-progress task contributes only the portion not yet done:
    ``duration - floor(duration * pct/100)``, clamped to ``[0, duration]``. The
    elapsed portion uses integer truncation so the rule is unambiguous and
    reproducible across the Python and Rust engines (the conformance contract).
    A completed task (see :func:`_is_complete`) is laid out at its full duration by
    the caller and never routed through this function.
    """
    duration_days = task.duration.days
    pct = task.percent_complete
    if not pct or pct <= 0:
        return duration_days
    elapsed = int(duration_days * min(pct, 100.0) / 100.0)
    return max(0, duration_days - elapsed)


def _is_complete(task: Task) -> bool:
    """Whether a task counts as finished for layout purposes (ADR-0136).

    True when an ``actual_finish`` is recorded *or* ``percent_complete`` has reached
    100. The scheduler dataclass has no ``status`` field, so completion is read from
    these two facts alone (the API normally keeps them aligned — a 100% task is
    promoted to REVIEW/COMPLETE — but the engine does not rely on that). A completed
    task is laid out at its *full* duration, never through
    :func:`_effective_duration_days` — otherwise a 100% task would have zero
    remaining work and collapse to a single day (ADR-0136).
    """
    return task.actual_finish is not None or (task.percent_complete or 0) >= 100


def _working_days_between(start: date, end: date, calendar: Calendar) -> int:
    """Count working days in [start, end) — start inclusive, end exclusive.

    Used to compute total float: working_days_between(early_start, late_start).
    Returns 0 when end <= start.

    Counted arithmetically rather than day by day (#4161): mask days in the span,
    minus mask days inside each exception run that overlaps it. It backs
    :class:`_WorkingDayCounter`, and a free-float
    slack measured across a century-long exception lands outside that range once
    per edge — so a day loop here was the same O(edges * range length) cost the
    snap helpers had. The subtraction is now :meth:`Calendar._exception_mask_days`,
    which is O(log E) via a prefix sum over the calendar's mask-off-gap-coalesced
    runs (#4176) rather than O(overlapping runs) — a span crossing a "closed until
    further notice" period written as thousands of weekly ranges used to walk one
    run per week; it now walks the handful of runs that are genuinely disjoint
    once weekend-only gaps are folded in.
    """
    if end <= start:
        return 0
    lo = start.toordinal()
    hi = end.toordinal()
    mask = calendar.working_days
    count = _mask_days_between(lo, hi, mask)
    if calendar.exceptions:
        count -= calendar._exception_mask_days(lo, hi)
    return count


class _WorkingDayCounter:
    """Working-day span counts for one calendar, as a thin wrapper (#822, #4713).

    This used to precompute the sorted ordinals of every working day in
    ``[lo, hi]`` with an O(span) Python walk on every :func:`schedule` call, to buy
    a two-binary-search ``between``. :func:`_working_days_between` has since become
    arithmetic (mask days minus an O(log E) exception prefix sum, #4161/#4176) and
    is at least as fast per query, so the build walk was pure cost: 43 ms at a
    150,000-day span. The class stays only because the API imports it (``build`` and
    ``between``); ``lo``/``hi`` are accepted for that signature and no longer used.

    ``between(start, end)`` is exactly :func:`_working_days_between` — working days
    in ``[start, end)``, 0 when ``end <= start``.
    """

    def __init__(self, calendar: Calendar) -> None:
        self._calendar = calendar

    @classmethod
    def build(cls, lo: date, hi: date, calendar: Calendar) -> _WorkingDayCounter:
        """Return a counter for ``calendar``; ``lo``/``hi`` are kept for compatibility."""
        return cls(calendar)

    def between(self, start: date, end: date) -> int:
        """Working days in ``[start, end)``."""
        return _working_days_between(start, end, self._calendar)


def _advance_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Advance d by lag calendar days and snap to the next working day."""
    return _next_working_day(_safe_offset(d, lag), calendar)


def _retreat_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Retreat d by lag calendar days and snap to the previous working day."""
    return _prev_working_day(_safe_offset(d, -lag), calendar)
