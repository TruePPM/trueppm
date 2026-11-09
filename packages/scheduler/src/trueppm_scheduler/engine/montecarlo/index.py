"""Monte Carlo working-day index sizing, lag-delta tables and offset readings."""

from __future__ import annotations

from collections.abc import (
    Callable,
    Iterable,
    Iterator,
)
from datetime import (
    date,
    timedelta,
)
from typing import (
    NoReturn,
)

import networkx as nx
import numpy as np

from trueppm_scheduler.engine.calendar_math import (
    _next_working_day,
    _nth_working_day,
    _prev_working_day,
    _safe_offset,
    _start_from_finish,
    _working_days_between,
)
from trueppm_scheduler.engine.errors import (
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.forward import (
    _floor_above_start,
    _pinned_placement,
    _sf_linked,
)
from trueppm_scheduler.engine.limits import (
    MAX_LAG_DELTA_CELLS,
)
from trueppm_scheduler.engine.milestones import (
    _FROM_PREDECESSOR_FINISH,
    _ONE_DAY,
    _START_ANCHORED,
    _elapsed_link_days,
    _start_is_recorded,
)
from trueppm_scheduler.engine.validate import (
    _velocity_worst_case_days,
)
from trueppm_scheduler.models import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
)


def _mc_horizon(
    project: Project,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    topo_order: list[str],
    cal_of: dict[str, Calendar],
) -> date:
    """A calendar DATE no task finishes after in any Monte Carlo run.

    The bound is a longest-path walk in topological order over real calendars
    (#4695). A floor date is the latest of the project start, every ``planned_start``
    pin (SNET, #1068), the data date (ADR-0132) and every recorded actual (#1821).
    Each task is then laid out on **its own** calendar from the working day after
    ``max(floor, max over predecessors of (bound(pred) + max(0, lag)))``, over its
    longest possible sampled duration (the pessimistic estimate and the velocity
    sampler's ``max_sprints`` clamp, #1067); its finish is ``bound(task)``. The
    horizon is the latest bound.

    Why it is an upper bound: by induction over the topological order ``bound(p)``
    is at or after every possible finish of ``p`` — and so after every anchor a link
    out of ``p`` can take (a start, a finish, or the day before a start, #4145). A
    task's real start is the latest of its link proposals and its floors; each
    proposal from ``p`` is at most ``bound(p) + lag`` and every floor is at most the
    floor date, so its start is at most the walk's start and, since laying out a
    fixed working-day duration is monotone in the start, its finish at most the
    walk's finish. An FF/SF successor's finish is pinned at most ``bound(p) + lag``
    too, which the walk's finish already clears.

    Why a path and not one serial cursor (#4695): the cursor version advanced past
    *every* earlier task, so it laid every task end to end. For an all-agile project
    that is every story at its velocity tail one after another — a project whose P95
    was 2028 got an index to year 3163, and Monte Carlo ran 2.2-2.4x slower. The
    induction above only ever needs a task's own predecessors to be finished. Each
    layout is arithmetic (:func:`_nth_working_day`), so the walk costs
    O((tasks + links) x log span), whatever the durations.

    Why it is a DATE and not a working-day count (#4429): a duration of D working
    days on a sparse calendar — a four-day week, Monday-only, a 16-week plant
    shutdown — spans many more than D working days of a denser calendar. The
    previous bound summed working-day durations and used that one count as the length
    of *every* calendar's index, so a successor on a denser calendar ran past its
    index end, where the lookups silently clamped to the last entry and Monte Carlo
    reported P50/P95 weeks to months before ``schedule()``. Expressed as a date, the
    bound is re-counted in each calendar's own working days by :func:`_mc_index_size`.
    """
    floor = project.start_date
    if project.status_date is not None:
        floor = max(floor, project.status_date)
    for t in task_map.values():
        for pinned in (t.planned_start, t.actual_start, t.actual_finish):
            if pinned is not None:
                floor = max(floor, pinned)
    bound: dict[str, date] = {}
    horizon = floor
    for tid in topo_order:
        t = task_map[tid]
        d_days = t.duration.days
        if t.pessimistic_duration is not None:
            d_days = max(d_days, t.pessimistic_duration.days)
        d_days = max(0, d_days, _velocity_worst_case_days(t, project))
        anchor = floor
        for pred in g.predecessors(tid):
            lag_days = max(0, g[pred][tid]["dep"].lag.days)
            anchor = max(anchor, _safe_offset(bound[pred], timedelta(days=lag_days)))
        start = _next_working_day(_safe_offset(anchor, _ONE_DAY), cal_of[tid])
        bound[tid] = _nth_working_day(start, d_days, cal_of[tid], forward=True)
        horizon = max(horizon, bound[tid])
    return horizon


def _count_working_days(start: date, end: date, calendar: Calendar) -> int:
    """Working days of ``calendar`` in the closed range ``[start, end]``.

    Counted arithmetically (:func:`_working_days_between`) rather than by a day walk,
    so sizing the index costs O(log E) per calendar, not O(span) (#4692).
    """
    if end < start:
        return 0
    return _working_days_between(start, _safe_offset(end, _ONE_DAY), calendar)


def _mc_index_size(
    horizon: date,
    index_origin: date,
    calendars: Iterable[Calendar],
    n_tasks: int,
) -> int:
    """The working-day index length that holds every offset on EVERY calendar.

    Every calendar's index is built with this one length, so it is the largest count
    of any calendar's own working days in ``[index_origin, horizon]`` — the densest
    calendar needs the most cells to span the same calendar days — plus the task
    count and a small buffer. ``horizon`` (:func:`_mc_horizon`) is a calendar date
    no run finishes after, so each index then spans at least to it in calendar days,
    whatever its working week (#4429). A working-day count summed across calendars
    cannot be that bound: D working days on a sparse calendar are far more than D
    working days of a dense one. ``index_origin`` already includes the pre-start pad
    (:func:`_mc_pre_start_pad_days`), so the pad needs no separate allowance.
    """
    widest = max(_count_working_days(index_origin, horizon, cal) for cal in calendars)
    return widest + n_tasks + 30


# Calendar days of slack added below the earliest pre-start placement the pad bound
# derives, so the working-day lookups one day either side of it stay on the index.
_MC_PRE_START_PAD_BUFFER_DAYS = 14


def _mc_pre_start_pad_days(
    project: Project,
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    cal_of: dict[str, Calendar],
) -> tuple[int, frozenset[str]]:
    """``(pad_days, sf_linked_ids)``: how far before the project start the index must reach.

    An SF-linked task (:func:`_sf_linked`) is not floored at the project start (#4218), so
    a run can place it before the working-day index's first day, where no offset
    exists. The index therefore opens ``pad_days`` calendar days early. With no
    SF-linked task the pad is 0 and every offset is exactly what it was before.

    The bound is a lower bound on every run's start, not a deterministic replay: in a
    run, a task that is not SF-linked starts no earlier than the project-start floor
    (or, when complete, at its fixed pinned start), and an SF-linked task's
    start is at least the back-solve of any single SF bound — its other links only
    raise it (#4220) — over its *longest*
    possible sampled duration, measured from that lower bound on the predecessor —
    the SF bound is monotone in the predecessor's start and the back-solve is
    monotone in both arguments. That start is the one the SF link measures from
    (:func:`_link_start`, #4523): a started task's recorded ``actual_start``, or a
    derived span start a fixed number of elapsed working days before its window,
    either of which can sit before the task's own lower bound. An SF-linked task's
    own floors (data date, SNET, a recorded actual start) only raise its true
    start, so leaving them out of *its* bound keeps that bound safe. A milestone's
    floors are different — they can lower the instant its successors measure
    from — and are handled below.

    A milestone that is not SF-linked is *shown* no earlier than the project start,
    but its successors measure from its link instant, which the project-start floor
    does not raise (#4225). Its bound is therefore the one any single proposal to
    that instant proves — the link instant is the latest proposal, so it is at least
    each of them — and an SF-linked successor of it is bounded from there. Its hard
    floors (:func:`_milestone_hard_floors`: a recorded actual start, SNET, the data
    date) are proposals too, and the earliest of them can lie before the project
    start: a live milestone carrying a pre-start ``actual_start`` has its link instant
    there, so its SF successor is placed before the project start as well. Bounding
    the milestone from its links alone left that successor below the index, where its
    finish clamped to offset 0 and Monte Carlo finished a working day after
    ``schedule()`` (#4510).

    A milestone's bound is always recorded in ``lo`` (a successor reads it, possibly
    through further milestones), but it widens the index only when the milestone has
    an SF successor of its own. Any other reader of its link instant either resolves
    it in date space or is floored at the project start, and a downstream SF-linked
    task widens the index by its own bound. Without that guard, a typo-year
    ``actual_start`` on any milestone of a project with one unrelated SF link grew
    the index by centuries of cells.
    """
    sf_linked = frozenset(tid for tid in topo_order if _sf_linked(tid, g))
    if not sf_linked:
        return 0, sf_linked
    lo: dict[str, date] = {}
    # What an SS/SF link out of each task measures from is its link start, which
    # can lie before ``lo`` (#4523, :func:`_link_start`): a recorded actual start,
    # or a derived span start that many elapsed working days earlier. Links read
    # this; a task's own placement reads ``lo``.
    link_lo: dict[str, date] = {}

    def record_link_lo(tid: str) -> None:
        task = task_map[tid]
        bound = lo[tid]
        if _start_is_recorded(task):
            assert task.actual_start is not None
            bound = min(bound, task.actual_start)
        elif _elapsed_link_days(task) > 0:
            bound = _start_from_finish(bound, _elapsed_link_days(task) + 1, cal_of[tid])
        link_lo[tid] = bound

    earliest = project.start_date
    for tid in topo_order:
        task = task_map[tid]
        cal = cal_of[tid]
        pinned = _pinned_placement(task, cal, _next_working_day(project.start_date, cal))
        if pinned is not None:
            lo[tid] = pinned[0]
            record_link_lo(tid)
            continue
        if tid not in sf_linked:
            lo[tid] = _next_working_day(project.start_date, cal)
            if task.duration.days == 0:
                proposals = [
                    *_milestone_hard_floors(task, cal, project.status_date, project.start_date),
                    *_link_lower_bound(g, tid, link_lo, cal_of),
                ]
                if proposals:
                    lo[tid] = min(lo[tid], max(proposals))
                    # Only an SF successor turns this instant into a cell anyone reads;
                    # without one, widening for it would cost index cells for nothing.
                    if any(
                        g[tid][succ]["dep"].dep_type is DependencyType.SF
                        for succ in g.successors(tid)
                    ):
                        earliest = min(earliest, lo[tid])
            record_link_lo(tid)
            continue
        bound = max(
            _next_working_day(
                _safe_offset(
                    _prev_working_day(_safe_offset(link_lo[pred], -_ONE_DAY), cal_of[pred]),
                    g[pred][tid]["dep"].lag,
                ),
                cal,
            )
            for pred in g.predecessors(tid)
            if g[pred][tid]["dep"].dep_type is DependencyType.SF
        )
        longest = max(
            task.duration.days,
            0 if task.pessimistic_duration is None else task.pessimistic_duration.days,
            _velocity_worst_case_days(task, project),
        )
        # Arithmetic, not a day walk: ``longest`` includes a velocity worst case,
        # which the span guard no longer bounds in total over parallel tasks (#4695).
        lo[tid] = _nth_working_day(bound, longest, cal, forward=False) if longest > 0 else bound
        record_link_lo(tid)
        earliest = min(earliest, lo[tid])
    return (project.start_date - earliest).days + _MC_PRE_START_PAD_BUFFER_DAYS, sf_linked


def _link_lower_bound(
    g: nx.DiGraph[str], tid: str, lo: dict[str, date], cal_of: dict[str, Calendar]
) -> Iterator[date]:
    """A lower bound on the instant each incoming link proposes to milestone ``tid``.

    From a predecessor that starts (or, as a milestone, sits) no earlier than its
    ``lo``: a start-anchored link's anchor is at least that, and a finish-anchored
    one's at least the working day before it, so the proposal is at least that
    anchor plus the lag (:func:`_edge_anchor`, :func:`_place_milestone`).
    """
    for pred in g.predecessors(tid):
        dep: Dependency = g[pred][tid]["dep"]
        anchor = (
            lo[pred]
            if dep.dep_type in _START_ANCHORED
            else _prev_working_day(_safe_offset(lo[pred], -_ONE_DAY), cal_of[pred])
        )
        yield _safe_offset(anchor, dep.lag)


def _snapped_offsets(
    wd_ord: np.ndarray, last_off: int, anchor_ords: np.ndarray, shift_days: int
) -> np.ndarray:
    """Vectorised ``_offset_after``: offsets of next_working_day(anchor + shift).

    A snap that lands past the index end (``> last_off``) comes back as NaN rather
    than clamped onto the last cell (#4429). The delta table covers every anchor
    cell, including tail cells no run can reach, so producing one is not an error;
    :func:`_build_lag_delta` stores it as :data:`_LAG_DELTA_OVERRUN`, and
    :func:`_lag_term` refuses a run that actually reads it.
    """
    off = np.searchsorted(wd_ord, anchor_ords + shift_days, side="left").astype(np.float64)
    off[off > last_off] = np.nan
    return off


# Lag-delta cell whose snapped successor offset lies past the successor's index end
# (#4429). Real cells are bounded by MAX_LAG_DAYS + MAX_CALENDAR_SCAN_DAYS (~73k), so
# the int32 minimum can never collide with one.
_LAG_DELTA_OVERRUN = int(np.iinfo(np.int32).min)


def _build_lag_delta(
    dt: DependencyType,
    lag: timedelta,
    wd_ord_pred: np.ndarray,
    wd_ord_succ: np.ndarray,
    k_arange: np.ndarray,
    index_size: int,
    last_off_succ: int,
    pred_prev_ord: int,
) -> np.ndarray:
    """Per-anchor-offset lag delta array for one ``(dep_type, lag, pred_cal, succ_cal)`` key.

    Vectorised equivalent of the former per-cell loop (#1205): for each anchor
    offset k the delta is the snapped successor offset minus the plain-add
    baseline. FS/FF anchor on the *previous* working day (wd_index[k-1]), so their
    k=0 cell stays 0 and the array is filled from index 1; SS anchors on
    wd_index[k] over the full range. This reproduces the scalar ``_offset_after``
    arithmetic exactly (asserted byte-for-byte in the tests).

    SF also anchors on wd_index[k-1] (#4145), but unlike FS/FF its k is an
    inclusive *start* offset, so k=0 is reachable: a predecessor starting on the
    index's first working day anchors on the working day before the index begins,
    which ``pred_prev_ord`` supplies as an ordinal. A positive SF lag anchors on
    the calendar day before wd_index[k] instead (#4333, :func:`_edge_anchor`).
    FS/FF cannot reach k=0 — their k is an exclusive-EF offset, which is at least
    1 for any task with duration.

    Per-task calendars (ADR-0120 D3, #1385): the anchor is read in the
    *predecessor's* working-day space (``wd_ord_pred``) and the snap lands in the
    *successor's* (``wd_ord_succ``), because lag is consumed on the successor's
    calendar — the same rule ``_forward_pass`` applies, where the node being
    computed owns the snap of every incoming constraint. The delta therefore
    carries the whole cross-calendar hop, which is what lets the vectorised
    forward pass stay calendar-agnostic: it still evaluates ``anchor +
    delta[day(anchor)]`` and lands in successor space. When both calendars are
    the same object the two arrays are identical and the arithmetic is
    byte-for-byte what it was before per-task calendars existed.
    """
    arr = np.zeros(index_size, dtype=np.float64)
    lag_days = lag.days
    if dt == DependencyType.FS:
        # k = exclusive EF offset; EF date = wd_index[k-1]; shift = 1 + lag.
        off = _snapped_offsets(wd_ord_succ, last_off_succ, wd_ord_pred[:-1], 1 + lag_days)
        arr[1:] = off - k_arange[1:]
    elif dt == DependencyType.FF:
        # Anchor k is the exclusive EF offset (inclusive last day = wd_index[k-1]);
        # the inclusive→exclusive +1 is folded into the -(k-1) baseline.
        off = _snapped_offsets(wd_ord_succ, last_off_succ, wd_ord_pred[:-1], lag_days)
        arr[1:] = off - k_arange[: index_size - 1]
    elif dt == DependencyType.SS:
        # Start-anchored ES constraint; both sides are inclusive starts.
        arr[:] = _snapped_offsets(wd_ord_succ, last_off_succ, wd_ord_pred, lag_days) - k_arange
    else:  # SF
        # Start-anchored EF constraint measured from the working day BEFORE the
        # predecessor's start (#4145 — MS Project / P6 finish the successor at the
        # start of that day). succ.EF (exclusive) must clear the snapped
        # anchor+lag day (inclusive), so +1 converts the inclusive constraint day
        # to the exclusive EF offset. FF gets this +1 for free via its exclusive-EF
        # anchor; SF does not, and dropping it finished SF successors one working
        # day early (#824).
        anchor_ords = np.empty(index_size, dtype=np.int64)
        if lag_days > 0:
            # A positive lag counts from the day the start instant closes,
            # ``start - 1`` itself, not the working day before it (#4333).
            anchor_ords[:] = wd_ord_pred - 1
        else:
            anchor_ords[0] = pred_prev_ord
            anchor_ords[1:] = wd_ord_pred[:-1]
        arr[:] = (
            _snapped_offsets(wd_ord_succ, last_off_succ, anchor_ords, lag_days) + 1.0 - k_arange
        )
    # Every cell is a whole working-day offset difference, bounded by
    # MAX_LAG_DAYS + MAX_CALENDAR_SCAN_DAYS (~73k), so int32 is exact and halves
    # the table's footprint (#4129). The float64 scratch above is one array at a
    # time; only the int32 copy is retained. A cell whose snap ran off the index is
    # NaN (:func:`_snapped_offsets`) and is stored as the overrun sentinel, in place.
    np.nan_to_num(arr, copy=False, nan=float(_LAG_DELTA_OVERRUN))
    return arr.astype(np.int32)


def _build_lag_delta_table(
    g: nx.DiGraph[str],
    wd_ord_by_cal: dict[int, np.ndarray],
    index_size: int,
    cal_key_of: dict[str, int],
    prev_ord_of: Callable[[int], int],
    milestone_ids: frozenset[str] = frozenset(),
    max_cells: int = MAX_LAG_DELTA_CELLS,
) -> dict[tuple[DependencyType, timedelta, int, int], np.ndarray | None]:
    """One shared lag-delta array per *distinct* ``(dep_type, lag, pred_cal, succ_cal)`` key.

    The array content depends ONLY on that key (#1201) — the working-day indices are
    fixed for the whole simulation — so N identical SF/lag-0 edges (or any repeated
    key) cost a single array, not N. ``None`` means "no adjustment" (a plain offset
    add) — used for lag-free FS/SS/FF **within one calendar**. SF always carries a
    delta array even at zero lag (its exclusive-EF-on-inclusive-start +1 conversion,
    issue #824).

    Per-task calendars (#1385): an edge whose endpoints resolve to *different*
    calendars can never take the ``None`` short-circuit, even at zero lag — the
    delta is what converts the predecessor's working-day offset into the
    successor's, and those spaces are not the same ruler. Keying on both calendar
    identities keeps the sharing intact within each calendar pair.

    The remaining cost — distinct keys x ``index_size`` — is capped explicitly
    because ``MAX_PROJECT_SPAN_DAYS`` bounds Σlag but not this product, and an
    SF/lag-0 edge contributes 0 to Σlag. With per-task calendars the number of
    distinct keys is multiplied by the number of calendar *pairs* actually joined
    by an edge, so the same cap now also bounds cross-calendar fan-out.

    An edge out of a live milestone (``milestone_ids``, #4079) needs no array: the
    forward pass carries each run's instant as a date and resolves those edges in
    date space (:func:`_mc_milestone_bounds`).
    """
    k_arange = np.arange(index_size, dtype=np.float64)

    delta_by_key: dict[tuple[DependencyType, timedelta, int, int], np.ndarray | None] = {}

    def ensure(dep_type: DependencyType, lag: timedelta, pred_key: int, succ_key: int) -> None:
        key = (dep_type, lag, pred_key, succ_key)
        if key in delta_by_key:
            return
        same_calendar = pred_key == succ_key
        if same_calendar and lag == timedelta(0) and dep_type != DependencyType.SF:
            delta_by_key[key] = None
            return
        wd_ord_pred = wd_ord_by_cal[pred_key]
        wd_ord_succ = wd_ord_by_cal[succ_key]
        # Reject before materialising the offending array: distinct keys x
        # index_size cells is the cost the span guard does not bound (#1201).
        non_null = sum(1 for arr in delta_by_key.values() if arr is not None) + 1
        if non_null * index_size > max_cells:
            raise InvalidScheduleInput(
                f"Monte Carlo lag-delta table would exceed {max_cells:,} "
                "cells (distinct dependency type/lag combinations x schedule span). "
                "The dependency network has too many distinct lag values for the "
                "span involved — reduce the variety of lags or split the project."
            )
        delta_by_key[key] = _build_lag_delta(
            dep_type,
            lag,
            wd_ord_pred,
            wd_ord_succ,
            k_arange,
            index_size,
            len(wd_ord_succ) - 1,
            # Only SF reads it, and resolving it walks the predecessor's calendar
            # backwards off the index — so it is asked for lazily, per calendar.
            prev_ord_of(pred_key) if dep_type == DependencyType.SF else 0,
        )

    for u, v, data in g.edges(data=True):
        d = data["dep"]
        pred_key = cal_key_of[u]
        succ_key = cal_key_of[v]
        if u not in milestone_ids:
            ensure(d.dep_type, d.lag, pred_key, succ_key)
    return delta_by_key


# A zero-base column's draw below this many days is no work at all (#4698, #4697).
# The task's base estimate is zero, so a CPM instant is what the plan says, and a
# draw that rounds to no whole day must leave it that instant: links, lags and the
# finish exactly as ``schedule()`` places them. It hands no fraction on. Ordinary
# work reads a finish by the day it falls in, so a fraction carried past a
# zero-base task would push any whole-day successor into the next working day in
# every run: a (0, 0, 1) estimate, whose Beta draws are never exactly zero, would
# cost the day #4698 removed. A draw at or above it is ordinary work, unchanged,
# so the task matches a real task of that length.
_ZERO_BASE_ROUND_AWAY = 0.5


# Float slack when reading a fractional working-day offset as a day (#4697). Sampled
# durations are continuous and are summed along each path, so an offset that is a
# whole number of days can carry a few ulps of noise; reading 10.0000000001 as "a
# tenth of a nanoday into day 10" would move a zero-variance run off its CPM date.
_MC_DAY_EPS = 1e-9


def _finish_day_key(offsets: np.ndarray) -> np.ndarray:
    """The exclusive offset of the day each finish position falls in (#4697).

    Monte Carlo offsets are continuous working-time positions: ``e = 10.3`` is work
    that ends 0.3 of the way into working day 10 (zero-based), so it finishes ON day
    10 and its exclusive key is 11. A whole ``e = 10`` ends at the close of day 9 and
    keeps key 10, which is what keeps a zero-variance run on its CPM date. This is
    the ceiling, not the nearest integer: rounding half-to-even read every fraction
    below one half as the previous day, so a run whose work spilled into day 10 was
    reported, and ranked, as finishing on day 9.
    """
    return np.ceil(np.asarray(offsets, dtype=np.float64) - _MC_DAY_EPS)


def _start_day_index(offsets: np.ndarray) -> np.ndarray:
    """The zero-based working day each start position falls in (#4697).

    The start-side twin of :func:`_finish_day_key`: ``s = 10.3`` starts 0.3 into day
    10 and ``s = 10`` at its very beginning, so both are day 10 — the floor. A start
    and a finish at the same fractional position fall in the same day; they differ
    only on a whole offset, which closes one day and opens the next.
    """
    return np.floor(np.asarray(offsets, dtype=np.float64) + _MC_DAY_EPS)


def _lag_term(delta_arr: np.ndarray, anchor: np.ndarray, *, from_finish: bool) -> np.ndarray:
    """Per-run lag delta gathered at the cell of the day each run's anchor falls in.

    ``from_finish`` says how the anchor is read (#4697): an FS/FF anchor is an
    exclusive finish, whose cell is :func:`_finish_day_key`, and an SS/SF anchor an
    inclusive start, whose cell is :func:`_start_day_index`. Both agree with the
    deterministic pass on a whole offset; on a fractional one they pick the day the
    work actually ends or starts in, which is the day the lag counts from. The
    fraction itself is carried by the caller (``anchor + delta``).

    Lag-free edges (``delta_by_key[key] is None``) never reach here: the constraint
    loop uses the anchor directly, skipping a runs-sized zeros allocation plus a
    no-op add per edge (#1860 — adding zeros is exact in float64, so results are
    unchanged).

    An anchor past the index end is refused, not clamped: clamping it to the last
    cell is how an undersized index used to masquerade as a date (#4429). So is an
    anchor whose lagged snap ran off the successor's index (a cell holding
    :data:`_LAG_DELTA_OVERRUN`).
    """
    cell = _finish_day_key(anchor) if from_finish else _start_day_index(anchor)
    idx = cell.astype(np.int64)
    if idx.size and int(idx.max()) > len(delta_arr) - 1:
        _raise_mc_index_overrun()
    picked = delta_arr[np.maximum(idx, 0)]
    if (picked == _LAG_DELTA_OVERRUN).any():
        _raise_mc_index_overrun()
    return np.asarray(picked, dtype=np.float64)


def _lagged_constraint(
    dep_type: DependencyType,
    delta_arr: np.ndarray,
    anchor: np.ndarray,
    lag_days: int,
    wd_ord_pred: np.ndarray | None,
    wd_ord_succ: np.ndarray | None,
) -> np.ndarray:
    """Per-run bound of a link with a lag-delta array, its fraction carried (#4697).

    ``anchor + delta`` keeps the anchor's fraction: work that ends 0.3 into a day,
    with a lag of a day, admits a successor 0.3 into the day after. That holds only
    while the lagged instant lands in working time. When it lands on a day the
    successor does not work, the successor waits for the next working day to open,
    and the bound is that day's start, with no fraction. Carrying the fraction there
    would be wrong in both directions: for FS it falls *before* the snapped day,
    because an exclusive finish's fraction is measured from the close of the
    previous one, so the successor would start ahead of its lag; for SS it lands a
    fraction late.

    The landing is ``anchor day + lag`` on the predecessor's ruler, and it is a
    working day of the successor iff the successor's working day just before the
    whole-day bound (FS) or at it (SS) is that very date. FF and SF bound a finish:
    the snapped day already holds the fraction (it can only move the finish within
    that day), so they keep ``anchor + delta``. Whole anchors are never touched, so
    a zero-variance run reproduces the deterministic pass exactly. Without the
    working-day arrays (a direct caller with no index) the bound is ``anchor +
    delta`` unchanged.
    """
    constraint: np.ndarray = anchor + _lag_term(
        delta_arr, anchor, from_finish=dep_type in _FROM_PREDECESSOR_FINISH
    )
    if dep_type not in _START_ANCHORED or wd_ord_pred is None or wd_ord_succ is None:
        return constraint
    if dep_type == DependencyType.FS:
        day = _finish_day_key(anchor) - 1.0
        frac = anchor - day  # (0, 1]; 1 is a whole offset
        partial = frac < 1.0 - _MC_DAY_EPS
        base = constraint + (1.0 - frac)  # the deterministic start: the snapped day
        slot = base - 1.0
    else:  # SS
        day = _start_day_index(anchor)
        frac = anchor - day  # [0, 1); 0 is a whole offset
        partial = frac > _MC_DAY_EPS
        base = constraint - frac
        slot = base
    if not partial.any():
        return constraint
    day_i = np.clip(day.astype(np.int64), 0, len(wd_ord_pred) - 1)
    slot_i = np.rint(slot).astype(np.int64)
    landing = wd_ord_pred[day_i] + lag_days
    lands = (slot_i >= 0) & (wd_ord_succ[np.clip(slot_i, 0, len(wd_ord_succ) - 1)] == landing)
    out: np.ndarray = np.where(partial & ~lands, base, constraint)
    return out


def _raise_mc_index_overrun() -> NoReturn:
    """Refuse a Monte Carlo offset past its working-day index end (#4429).

    The index is sized by :func:`_mc_index_size` to hold every offset a run can
    reach, so this is unreachable on a correct bound. It exists because the clamp it
    replaces turned an undersized index into a plausible, silently early finish date.
    It raises the documented :class:`InvalidScheduleInput` rather than a bare error so
    an embedder's exception contract still holds, and the message says it is an
    engine fault rather than a fault in the caller's input.
    """
    raise InvalidScheduleInput(
        "Internal Monte Carlo error: a simulated date ran past the working-day index "
        "built for it. This is an engine bug, not a problem with the project; please "
        "report it with the project that triggered it."
    )


_MilestoneFloors = tuple[int | None, int | None]
"""``(hard, start)`` floors of a live milestone as date ordinals (#4225).

``hard`` is the latest of its data-date, SNET and recorded-actual-start floors, and
``start`` the project-start floor (``None`` for an SF-linked milestone, #4218): the
split :func:`_place_milestone` makes between what binds its link instant and what
only bounds where it is shown.

An SF-linked milestone's shown day has no Monte Carlo-observable effect of its own:
its successors read its link instant, and a milestone shown before the project start
cannot set the finish, because the SF predecessor that places it there finishes
later (#4220).
"""


def _milestone_hard_floors(
    task: Task,
    cal: Calendar,
    status_date: date | None,
    project_start: date,
    *,
    sf_linked: bool = False,
) -> list[date]:
    """A live milestone's hard floors — the ``hard`` half of :data:`_MilestoneFloors`.

    The data date and SNET snapped to the milestone's own working days — the data
    date only when after the project-start floor, and the SNET too unless the
    milestone is ``sf_linked`` (:func:`_floor_above_start`, :func:`_early_start_floors`,
    #4635) — and the recorded actual start verbatim. One definition, because two
    readers must agree on it: :func:`_mc_milestone_floors` places the link instant from these, and
    :func:`_mc_pre_start_pad_days` bounds that instant from below with them (#4510) —
    a pad bound computed from a different set could sit above the instant it bounds.
    """
    start_base = _next_working_day(project_start, cal)
    hard: list[date] = []
    if status_date is not None and (df := _floor_above_start(status_date, cal, start_base)):
        hard.append(df)
    if task.actual_start is not None:
        hard.append(task.actual_start)
    if task.planned_start is not None:
        snet = (
            _next_working_day(task.planned_start, cal)
            if sf_linked
            else _floor_above_start(task.planned_start, cal, start_base)
        )
        if snet is not None:
            hard.append(snet)
    return hard
