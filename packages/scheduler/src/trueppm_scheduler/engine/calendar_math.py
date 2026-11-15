"""Calendar-aware date arithmetic: working-day snapping, counting and offsets."""

from __future__ import annotations

import bisect
from datetime import (
    date,
    timedelta,
)
from fractions import Fraction

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

    The layout is computed arithmetically (:func:`_lay_out_working_days`, #1531)
    rather than stepped one working day at a time; :func:`_finish_from_start_walk`
    is the reference walk it must equal and the fallback for the inputs where the
    walk raises.
    """
    if duration_days <= 0:
        return start
    first = _next_working_day(start, calendar)
    if duration_days == 1:
        return first
    landed = _lay_out_working_days(first, duration_days, calendar, forward=True)
    if landed is None:
        return _walk_working_days(first, duration_days, calendar, forward=True)
    return landed


def _walk_working_days(
    first: date, duration_days: int, calendar: Calendar, *, forward: bool
) -> date:
    """Step ``duration_days - 1`` working days off the working day ``first``, one at a time."""
    remaining = duration_days - 1
    current = first
    while remaining > 0:
        current = _scan_for_working_day(current, calendar, forward=forward)
        remaining -= 1
    return current


def _finish_from_start_walk(start: date, duration_days: int, calendar: Calendar) -> date:
    """Reference day-walk for :func:`_finish_from_start` (the pre-#1531 algorithm).

    Kept as the oracle the differential test compares the arithmetic against.
    """
    if duration_days <= 0:
        return start
    return _walk_working_days(
        _next_working_day(start, calendar), duration_days, calendar, forward=True
    )


def _start_from_finish_walk(finish: date, duration_days: int, calendar: Calendar) -> date:
    """Reference day-walk for :func:`_start_from_finish` (the pre-#1531 algorithm)."""
    if duration_days <= 0:
        return finish
    return _walk_working_days(
        _prev_working_day(finish, calendar), duration_days, calendar, forward=False
    )


# Per weekday mask (0..127): ``(k, offs, before)`` where ``k`` is the number of mask
# days per week, ``offs[j]`` the Monday-based weekday of the ``j``-th one, and
# ``before[w]`` how many mask days precede weekday ``w`` within its week. Filled
# lazily; a dict write of an immutable value is safe to race under the GIL.
_MASK_TABLES: dict[int, tuple[int, tuple[int, ...], tuple[int, ...]]] = {}


def _mask_table(mask: int) -> tuple[int, tuple[int, ...], tuple[int, ...]]:
    # Only bits 0-6 are weekdays (``Calendar.is_working_day`` shifts by ``weekday()``
    # and tests bit 0; a negative int reads as its two's-complement low bits, so
    # ``-1 & 0x7F`` is 127 as well). Keying on the raw int would let distinct
    # high-bit masks grow the cache without bound for one and the same table.
    mask &= 0x7F
    table = _MASK_TABLES.get(mask)
    if table is None:
        offs = tuple(w for w in range(7) if (mask >> w) & 1)
        before = tuple(sum(1 for o in offs if o < w) for w in range(7))
        table = (len(offs), offs, before)
        _MASK_TABLES[mask] = table
    return table


def _lay_out_working_days(
    first: date, duration_days: int, calendar: Calendar, *, forward: bool
) -> date | None:
    """The ``duration_days``-th working day counted from the working day ``first``.

    ``first`` counts as day 1. Equal to :func:`_walk_working_days` on every input
    where it returns a date, in O(log E) per exception run crossed instead of one
    calendar step per working day (#1531): the CPM passes lay every task's duration
    out through here, and the day walk made them O(tasks x mean duration).

    How: number the weekday-mask days by rank (``rank(o)`` = mask days in
    ``[1, o)``; ordinal 1 is a Monday, so the rank is closed-form from the week
    number and a per-mask table). The ``n``-th mask day from ``first`` is a rank
    offset of ``n - 1``. Exceptions remove mask days, so the landing is then pushed
    on by the number of exception mask days between the previous landing and the
    new one (:meth:`Calendar._exception_mask_days`), until a push crosses none. A
    landing that crossed no exception mask day is a mask day outside every
    exception, i.e. a working day, and the working days up to it number exactly
    ``n``.

    Returns ``None`` — "use the walk" — wherever the walk would not complete
    silently, so the documented errors stay the walk's own, word for word:

    - the landing falls outside the representable ``date`` range (the walk raises
      the overflow :class:`InvalidScheduleInput`);
    - a crossed exception run is long enough that the gap between two consecutive
      working days could exceed the walk's per-step budget of
      :data:`MAX_CALENDAR_SCAN_DAYS`. Exception runs are coalesced across mask-off
      gaps, so the longest non-working stretch around a run is the run plus at most
      six mask-off days on each side; runs within 13 days of the budget fall back.
    """
    mask = calendar.working_days
    k, offs, before = _mask_table(mask)
    if k == 0:
        return None
    o0 = first.toordinal()
    wk, wd = divmod(o0 - 1, 7)
    rank = wk * k + before[wd]
    step = duration_days - 1
    has_exc = bool(calendar.exceptions)
    if forward:
        rank += step
        q, j = divmod(rank, k)
        land = 1 + 7 * q + offs[j]
        if has_exc:
            lo = o0
            while True:
                if land > _MAX_ORDINAL:
                    return None
                deficit = calendar._exception_mask_days(lo, land + 1)
                if not deficit:
                    break
                lo = land + 1
                rank += deficit
                q, j = divmod(rank, k)
                land = 1 + 7 * q + offs[j]
            if not _runs_within_scan_budget(calendar, o0, land):
                return None
        if land > _MAX_ORDINAL:
            return None
    else:
        rank -= step
        q, j = divmod(rank, k)
        land = 1 + 7 * q + offs[j]
        if has_exc:
            hi = o0 + 1
            while True:
                if land < _MIN_ORDINAL:
                    return None
                deficit = calendar._exception_mask_days(land, hi)
                if not deficit:
                    break
                hi = land
                rank -= deficit
                q, j = divmod(rank, k)
                land = 1 + 7 * q + offs[j]
            if not _runs_within_scan_budget(calendar, land, o0):
                return None
        if land < _MIN_ORDINAL:
            return None
    return date.fromordinal(land)


# A coalesced exception run of this many days or more may leave a non-working gap
# (run + up to 6 mask-off days each side, + 1 to reach the next working day) wider
# than the walk's per-step budget, where the walk raises instead of landing.
_LONG_RUN_DAYS = MAX_CALENDAR_SCAN_DAYS - 13


def _runs_within_scan_budget(calendar: Calendar, lo: int, hi: int) -> bool:
    """Whether every exception run between ordinals ``lo`` and ``hi`` is short of the budget."""
    starts, ends, _ = calendar._exception_intervals()
    i = max(0, bisect.bisect_right(starts, lo) - 1)
    j = bisect.bisect_right(starts, hi)
    return all(ends[r] - starts[r] < _LONG_RUN_DAYS for r in range(i, j))


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
    last = _prev_working_day(finish, calendar)
    if duration_days == 1:
        return last
    landed = _lay_out_working_days(last, duration_days, calendar, forward=False)
    if landed is None:
        return _walk_working_days(last, duration_days, calendar, forward=False)
    return landed


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


def _elapsed_working_days(duration_days: int, pct: float) -> int:
    """Working days of ``duration_days`` already done at ``pct`` percent (ADR-0132).

    The rule is the *exact* ``floor(duration_days * P / 100)``, where ``P`` is the
    decimal number ``pct`` prints as: its shortest round-trip representation
    (``repr``), the digits a user typed or the API serialized. ``pct`` is clamped to
    ``[0, 100]`` first.

    Why the decimal and not the double: ``18.4`` is stored as
    ``18.39999999999999857...``, so both float math (``int(375 * 18.4 / 100.0)``) and
    an exact floor of the stored double give 68 elapsed days on a 375-day task where
    the percentage the user entered means 69 (#5034). Why exact and not a fixed
    precision: rounding ``pct`` to N places can round a value below 100 up to 100,
    which would leave an in-progress task with no remaining work; the exact decimal
    keeps the invariant that any ``pct < 100`` leaves at least one remaining day on a
    task with a positive duration. The Rust engine reproduces the rule bit for bit
    (``elapsed_days`` in ``models.rs``) from Rust's shortest float formatting, which
    yields the same digits as ``repr``.

    Integer percents take a pure-integer fast path; the result is identical to the
    general branch and to the previous float expression for every integer percent.
    """
    if pct <= 0 or duration_days <= 0:
        return 0
    # ``float()``: an ``int`` percent has no ``is_integer`` before Python 3.12.
    pct = min(float(pct), 100.0)
    if pct.is_integer():
        return duration_days * int(pct) // 100
    exact = Fraction(repr(pct))
    return (duration_days * exact.numerator) // (100 * exact.denominator)


def _effective_duration_days(task: Task) -> int:
    """Working-day duration of the *remaining* work on a task (ADR-0132).

    A task that has not started (``percent_complete == 0``) contributes its full
    estimate. An in-progress task contributes only the portion not yet done:
    ``duration - elapsed``, clamped to ``[0, duration]``, where ``elapsed`` is the
    exact decimal floor of :func:`_elapsed_working_days`. That rule is unambiguous
    and reproducible across the Python and Rust engines (the conformance contract).
    A completed task (see :func:`_is_complete`) is laid out at its full duration by
    the caller and never routed through this function.
    """
    duration_days = task.duration.days
    pct = task.percent_complete
    if not pct or pct <= 0:
        return duration_days
    return max(0, duration_days - _elapsed_working_days(duration_days, pct))


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


class WorkingDayCounter:
    """Count working days in a half-open span for one calendar.

    A thin wrapper over the engine's own working-day arithmetic (mask days minus
    an O(log E) exception prefix sum), so a ``between`` call here returns exactly
    the span length ``schedule()`` uses. Build one per calendar and reuse it for
    many queries; constructing it is O(1).

    Public API since 0.5 (#4158). ``_WorkingDayCounter`` remains as an alias for
    one release.

    Example:
        >>> from datetime import date
        >>> from trueppm_scheduler import Calendar, WorkingDayCounter
        >>> counter = WorkingDayCounter.build(date(2026, 1, 1), date(2026, 12, 31), Calendar())
        >>> counter.between(date(2026, 1, 5), date(2026, 1, 12))
        5
    """

    __slots__ = ("_calendar",)

    def __init__(self, calendar: Calendar) -> None:
        """Bind the counter to ``calendar``.

        Args:
            calendar: The calendar whose working days are counted.
        """
        self._calendar = calendar

    @classmethod
    def build(cls, lo: date, hi: date, calendar: Calendar) -> WorkingDayCounter:
        """Return a counter for ``calendar``.

        Args:
            lo: Start of the span the caller expects to query. Accepted for
                signature compatibility; not used.
            hi: End of the span the caller expects to query. Accepted for
                signature compatibility; not used.
            calendar: The calendar whose working days are counted.

        Returns:
            A counter bound to ``calendar``.
        """
        return cls(calendar)

    def between(self, start: date, end: date) -> int:
        """Return the working days in ``[start, end)``.

        Args:
            start: First day of the span (inclusive).
            end: Day the span stops at (exclusive).

        Returns:
            The number of working days, or 0 when ``end <= start``.
        """
        return _working_days_between(start, end, self._calendar)


# Deprecated alias, kept for one release (#4158): trueppm-api <= 0.4 imports it.
_WorkingDayCounter = WorkingDayCounter


def _advance_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Advance d by lag calendar days and snap to the next working day."""
    return _next_working_day(_safe_offset(d, lag), calendar)


def _retreat_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Retreat d by lag calendar days and snap to the previous working day."""
    return _prev_working_day(_safe_offset(d, -lag), calendar)
