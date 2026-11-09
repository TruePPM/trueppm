"""Monte Carlo vectorized forward pass over every run at once."""

from __future__ import annotations

import copy
from bisect import (
    bisect_left,
)
from collections.abc import (
    Mapping,
    Sequence,
)
from datetime import (
    date,
    timedelta,
)

import networkx as nx
import numpy as np

from trueppm_scheduler.engine.calendar_math import (
    _is_complete,
    _next_working_day,
    _prev_working_day,
    _safe_fromordinal,
    _safe_offset,
    _start_from_finish,
)
from trueppm_scheduler.engine.forward import (
    _floor_above_start,
    _forward_pass,
)
from trueppm_scheduler.engine.milestones import (
    _START_ANCHORED,
    _edge_anchor,
    _Instant,
    _milestone_link,
    _milestone_proposal,
    _start_fixed_link,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _MC_DAY_EPS,
    _ZERO_BASE_ROUND_AWAY,
    _finish_day_key,
    _lagged_constraint,
    _milestone_hard_floors,
    _MilestoneFloors,
    _raise_mc_index_overrun,
    _start_day_index,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _OffsetLookup,
    _WorkingDayIndex,
)
from trueppm_scheduler.models import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
)


def _completed_dates(
    project: Project,
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    task_calendars: dict[str, Calendar] | None,
) -> tuple[dict[str, tuple[date, date]], dict[str, _Instant]]:
    """The VERBATIM ``(early_start, early_finish)`` ``schedule()`` gives each completed task.

    Rather than *reproducing* ``_forward_pass``'s completed-task branches, this runs
    the deterministic forward pass itself over throwaway copies and reads the answers
    off it. That is the single source of truth both engines' completed-task handling
    reads from, so Monte Carlo cannot drift from ``schedule()`` on the arithmetic
    (#2460/#2461) — and, unlike a transcription, cannot fall behind a later change to
    the deterministic pass (#2572).

    The transcription it replaces reproduced only the actuals-anchored branches
    faithfully. For the third branch — ``percent_complete >= 100`` with no actuals at
    all — it returned the bare project-start anchor and dropped the ``planned_start``
    (SNET) floor, so a completed-by-percent task with an SNET pin simulated *earlier*
    than its deterministic position and the percentiles under-reported risk.

    Every completed task is pinned out of the network (:func:`_pinned_placement`,
    #4343), including one with no actuals, so each *date* read here is a function of
    the task's own fields and the project start alone. A closed milestone's *instant*
    is not quite: which edge of its recorded day it sits on is read off its
    *completed* predecessors' positions in this one deterministic pass (#4433,
    #4525, :func:`_live_milestone_edge`). Those are pinned too, so no sampled
    duration could move it either way; it is read once, here, and frozen. That is
    what makes the pin a true constant across runs, the property the Monte Carlo
    fast path relies on: no run can move a completed task. (Before #4343
    the no-actuals task was placed through the network in ``schedule()``, so pinning it
    at its deterministic position here froze a position that in fact depended on its
    predecessors' durations, and the percentiles under-reported risk downstream of it.)

    Scalar ``date`` space also preserves the *non-working* dates the working-day offset
    index cannot represent — a weekend ``actual_finish`` stays verbatim.

    Args:
        project: The project being simulated (supplies the start date, project
            calendar, and data date).
        task_map: Every task by id. Not mutated — the pass runs over shallow copies.
        topo_order: Any valid topological order of ``g``.
        g: The dependency graph.
        task_calendars: Per-task calendar overrides, or ``None`` for one calendar.

    Returns:
        ``({task_id: (early_start, early_finish)}, {task_id: instant})`` for the
        completed tasks only — the second map holds the completed tasks the
        deterministic pass placed as milestone instants (#4079), so their outgoing
        constraints use the same anchors. Both are empty when the project carries
        no completed task, in which case the deterministic pass is skipped entirely.
    """
    completed_ids = [tid for tid, t in task_map.items() if _is_complete(t)]
    if not completed_ids:
        return {}, {}

    # _forward_pass assigns early_start/early_finish in place and monte_carlo()'s
    # task_map holds the *caller's* Task objects, so run it over shallow copies —
    # the same isolation schedule() applies, and safe for the same reason (every
    # Task field is an immutable scalar).
    scratch = {tid: copy.copy(t) for tid, t in task_map.items()}
    # Live successors measure a completed milestone's links from its link instant
    # (#4225), which is what the constraints below are built from.
    instants: dict[str, _Instant] = {}
    _forward_pass(
        scratch,
        topo_order,
        g,
        project.start_date,
        project.calendar,
        project.status_date,
        task_calendars,
        instants,
    )

    dates: dict[str, tuple[date, date]] = {}
    for tid in completed_ids:
        t = scratch[tid]
        # The forward pass sets both on every task it visits.
        assert t.early_start is not None and t.early_finish is not None
        dates[tid] = (t.early_start, t.early_finish)
    return dates, {tid: instants[tid] for tid in completed_ids if tid in instants}


def _index_offset(d: date, offset_of: _OffsetLookup, wd_index: Sequence[date]) -> float:
    """Working-day offset of ``d``: its own cell, else the next working day's cell.

    A date before the index start clamps to 0. A date inside the index that is not
    itself a cell (a weekend or holiday) takes the offset of the next indexed day,
    matching :func:`_snapped_offset`; it never reads as the last cell (#4714).
    A date past the index end raises (#4429): clamping it to the last entry reported
    an undersized index as a plausible, silently early date.
    """
    off = offset_of.get(d)
    if off is not None:
        return float(off)
    if d > wd_index[-1]:
        _raise_mc_index_overrun()
    return 0.0 if d < wd_index[0] else float(bisect_left(wd_index, d))


def _completed_offsets(
    es_date: date,
    ef_date: date,
    calendar: Calendar,
    offset_of: _OffsetLookup,
    wd_index: Sequence[date],
) -> tuple[float, float]:
    """Constant (ES, exclusive-EF) offset pin for a completed task's own columns.

    Derived from the verbatim dates :func:`_completed_dates` resolved, so the pin can
    only ever be the offset-space *projection* of what ``schedule()`` computed —
    never independently-derived arithmetic that could disagree with it.

    A non-working verbatim date has no offset (the index holds working days only) and
    snaps to the nearest one here. That loss is deliberate and no longer observable:
    successors of a completed task read a precomputed scalar constraint rather than
    these offsets (:func:`_completed_edge_constraints`), and the terminal project
    finish is floored at the verbatim date by :func:`_offset_to_date`. So the snap
    now affects nothing a caller can see.
    """
    ef_off = _index_offset(_prev_working_day(ef_date, calendar), offset_of, wd_index) + 1.0
    es_off = min(_index_offset(_next_working_day(es_date, calendar), offset_of, wd_index), ef_off)
    return es_off, ef_off


_FixedEdge = tuple[bool, float, int, bool]
"""``(is_ef_constraint, offset, instant_ordinal, start_display)`` of a completed predecessor."""


def _completed_edge_constraints(
    g: nx.DiGraph[str],
    completed_dates: dict[str, tuple[date, date]],
    completed_instants: dict[str, _Instant],
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: Mapping[int, _OffsetLookup],
    wd_index_by_cal: Mapping[int, Sequence[date]],
    task_map: dict[str, Task] | None = None,
) -> dict[tuple[str, str], _FixedEdge]:
    """The constant bound a completed predecessor, or a recorded start, imposes, per edge.

    A completed task's dates are fixed across every run, so the constraint each of its
    outgoing links imposes is a constant — and computing it here, in scalar ``date``
    space with the *verbatim* dates, is what lets Monte Carlo agree with
    ``_forward_pass`` on a non-working actual (#2461).

    The vectorised path could not: it anchors on the predecessor's working-day offset
    and applies the lag through :func:`_build_lag_delta`, so a weekend
    ``actual_finish`` was silently read as the preceding Friday and any non-zero lag
    (or any SS/SF link, which anchors on the start) landed a working day off. The
    formulas below are ``_forward_pass``'s own (:func:`_edge_anchor`); FF/SF produce
    an *inclusive* constraint date, so ``+ 1`` converts it to the exclusive-EF
    offset space the Monte Carlo pass works in.

    Per-task calendars (#1385): the snap and the resulting offset both belong to the
    **successor**, because lag is consumed on the successor's calendar and the
    successor's column is the one this constraint is compared against. The completed
    predecessor contributes only a raw date — which is precisely why the verbatim
    dates, not its offsets, are what cross the edge. This is the scalar counterpart
    of the same rule :func:`_build_lag_delta` encodes for live predecessors.

    For a milestone successor (#4079) the same link also proposes an *instant*, the
    raw midnight :func:`_place_milestone` would compare, returned as a date ordinal
    with whether it is shown at the start of its day.

    An SS or SF link out of a *started* task (``task_map`` given) is a constant of
    the same kind (#4523): it measures from the recorded ``actual_start``
    (:func:`_link_start`), which no run's sampled duration moves, so it is resolved
    here from the verbatim date too. Reading it off the run's ES offset instead
    measured it from the data-date-floored remaining window, as ``schedule()`` did
    before #4523, and could not hold a non-working actual (#4175).
    """
    constraints: dict[tuple[str, str], _FixedEdge] = {}
    tasks = task_map or {}
    for u, v, data in g.edges(data=True):
        if v in completed_dates:
            # A completed successor is pinned and skips network logic entirely
            # (mirroring _forward_pass), so an edge into one imposes nothing.
            continue
        dep: Dependency = data["dep"]
        if u in completed_dates:
            pred_es, pred_ef = completed_dates[u]
        elif u in tasks and _start_fixed_link(tasks[u], dep):
            started = tasks[u].actual_start
            assert started is not None
            # Only the start is read by an SS/SF anchor (_edge_anchor).
            pred_es = pred_ef = started
        else:
            continue
        succ_cal = cal_of[v]
        succ_key = cal_key_of[v]
        offset_of = offset_of_by_cal[succ_key]
        wd_index = wd_index_by_cal[succ_key]
        pred_instant = completed_instants.get(u)
        anchor = _edge_anchor(
            dep.dep_type,
            pred_es,
            pred_ef,
            None if pred_instant is None else pred_instant[0],
            cal_of[u],
            dep.lag,
        )
        imposed = _next_working_day(_safe_offset(anchor, dep.lag), succ_cal)
        # What the same link proposes to a milestone successor: engine
        # _place_milestone's own rule (#4079, #4272), not re-derived here.
        proposal, start_display = _milestone_proposal(
            dep.dep_type, dep.lag, pred_es, pred_ef, pred_instant, cal_of[u], succ_cal
        )
        finish_bound = dep.dep_type not in _START_ANCHORED
        constraints[(u, v)] = (
            finish_bound,
            _index_offset(imposed, offset_of, wd_index) + (1.0 if finish_bound else 0.0),
            proposal.toordinal(),
            start_display,
        )
    return constraints


def _mc_es_floors(
    project: Project,
    task_map: dict[str, Task],
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: Mapping[int, _OffsetLookup],
    wd_index_by_cal: Mapping[int, Sequence[date]],
    sf_linked: frozenset[str] = frozenset(),
) -> dict[str, float]:
    """Merge each task's SNET pin, recorded actual start, and the data-date floor.

    The deterministic forward pass builds an in-progress task's ES from a three-way
    maximum — the data date, the ``planned_start`` (SNET) pin, and the recorded
    ``actual_start`` — before folding in network logic. This is the Monte Carlo
    counterpart, and it must apply all three or the simulation samples from a window
    CPM has already excluded.

    ``planned_start`` (SNET) floors mirror the deterministic forward pass (#1068): a
    pinned task may not start before its pin regardless of network logic. A pin at or
    before project start is the 0 floor every task already has, and the index was sized
    to cover the furthest pin, so the lookup is total. The data date floors all
    not-yet-finished work — nothing remaining can be sampled before "as of now".

    ``actual_start`` floors work already underway at where it actually began
    (ADR-0132 §2 / #2621) — actuals are truth and are never smoothed back to an
    earlier network slot. It was missing here for as long as the deterministic floor
    existed, so every percentile on an in-progress project was computed against an
    early window ``schedule()`` had already rejected and P95 could land *before* the
    plain CPM finish — a risk tool under-reporting risk (#2833). Only not-yet-complete
    tasks take it, exactly as in the deterministic pass: a complete task is pinned out
    of network logic entirely (:func:`_completed_dates`) and never reads this floor.

    **A non-working actual is snapped forward here, and the deterministic pass leaves
    it verbatim.** That is a deliberate, one-directional divergence, not an oversight.
    ``_forward_pass`` works in scalar dates and can hold a Saturday actual; this index
    holds working days only, so the date has no offset and *some* neighbour has to
    stand in for it.

    **What that divergence covers shrank with #3963 — do not read the paragraph
    below as still describing the finish.** Until then ``_finish_from_start`` began
    an in-progress task's duration walk *on* the non-working actual, so the
    deterministic pass spent one working day of the duration on a Saturday and
    finished a working day early, while this snap gave the task its full remaining
    duration. The two passes returned different finishes for a fully deterministic
    project, and **this one was right**. The divergence was therefore never
    "unavoidable index rounding" in the finish direction; it was reporting a
    defect in the other pass. That is fixed: both engines now begin the walk at the
    next working day, and for any task with remaining duration >= 1 the finish this
    index produces is exactly ``schedule()``'s.

    Two readers still see the raw date, and **neither reads this floor for it any
    more (#4175)**: a **zero-duration milestone**, whose instant *is* the actual,
    and an **SS successor**, which measures its lag from the predecessor's start.
    Both used to read the snapped day here, and the error was not bounded by one
    working day as this docstring once claimed — a calendar-day lag from Monday
    instead of Sunday re-lands across a weekend, and a chain of them carried a 2-3
    working-day gap to the finish. :func:`_mc_verbatim_actuals` now hands both the
    verbatim date, per run where it binds, the way #2461 did for completed tasks.
    (SF with no lag or a lead needs nothing: its anchor is the working day *before*
    the start, which the snap cannot move. A positive SF lag counts from
    ``start - 1`` itself, #4333, so it reads the verbatim date as SS does.)
    ``tests/test_monte_carlo_live_actual_start.py`` holds the equality over that
    space.

    All three are ES lower bounds on the same task, so they merge here and the forward
    pass reads a single number.

    The project-start floor is the fourth, and the one an ``sf_linked`` task
    (:func:`_sf_linked`, #4218) does not take. Offset 0 is the project start only while
    the index opens there; once :func:`_mc_pre_start_pad_days` opens it earlier, every
    other task carries its project-start offset explicitly, and an SF-linked task keeps
    just its actual start and SNET, read wherever they fall on the index — before the
    project start included, as ``schedule()`` reads them — and its data date only
    when it falls after the start (:func:`_floor_above_start`, #4635).
    """

    def _snap_offset(d: date, tid: str) -> float:
        """Offset of the next working day on ``tid``'s own calendar.

        Clamped to the index start below it; past its end it raises (#4429).
        """
        cal_key = cal_key_of[tid]
        snapped = _next_working_day(d, cal_of[tid])
        off = offset_of_by_cal[cal_key].get(snapped)
        if off is not None:
            return float(off)
        index = wd_index_by_cal[cal_key]
        if snapped > index[-1]:
            _raise_mc_index_overrun()
        return 0.0 if snapped < index[0] else float(len(index) - 1)

    def _above_start(d: date, tid: str) -> bool:
        cal = cal_of[tid]
        return _floor_above_start(d, cal, _next_working_day(project.start_date, cal)) is not None

    es_floor: dict[str, float] = {}
    status_date = project.status_date
    for t in task_map.values():
        if t.id in sf_linked:
            # A data date at or before the project start is no floor here, exactly
            # as in _calendar_floors; the SNET is kept verbatim (#4635).
            floor = 0.0
            if t.planned_start is not None:
                floor = _snap_offset(t.planned_start, t.id)
            if status_date is not None and not _is_complete(t) and _above_start(status_date, t.id):
                floor = max(floor, _snap_offset(status_date, t.id))
            if t.actual_start is not None and not _is_complete(t):
                floor = max(floor, _snap_offset(t.actual_start, t.id))
            if floor:
                es_floor[t.id] = floor
            continue
        # 0.0 while the index opens on the project start, i.e. unchanged.
        floor = _snap_offset(project.start_date, t.id)
        if t.planned_start is not None and t.planned_start > project.start_date:
            floor = _snap_offset(t.planned_start, t.id)
        if status_date is not None and status_date > project.start_date:
            floor = max(floor, _snap_offset(status_date, t.id))
        if (
            t.actual_start is not None
            and t.actual_start > project.start_date
            and not _is_complete(t)
        ):
            floor = max(floor, _snap_offset(t.actual_start, t.id))
        if floor:
            es_floor[t.id] = floor
    return es_floor


def _mc_milestone_floors(
    project: Project,
    task_map: dict[str, Task],
    milestone_ids: frozenset[str],
    cal_of: dict[str, Calendar],
    sf_linked: frozenset[str] = frozenset(),
) -> dict[str, _MilestoneFloors]:
    """Each live milestone's :data:`_MilestoneFloors`, as ``_forward_pass`` builds them.

    Read in date space and never through the offset index, which cannot hold a
    non-working actual (#4175) or a floor before the index opens: the hard floors
    are exactly the forward pass's (:func:`_milestone_hard_floors`): the data date
    snapped to the milestone's own working days when it falls after the project
    start, the SNET likewise (or wherever it falls, for an SF-linked milestone,
    #4635), and the actual start verbatim.
    """
    out: dict[str, _MilestoneFloors] = {}
    for tid in milestone_ids:
        cal = cal_of[tid]
        hard = _milestone_hard_floors(
            task_map[tid],
            cal,
            project.status_date,
            project.start_date,
            sf_linked=tid in sf_linked,
        )
        out[tid] = (
            max(hard).toordinal() if hard else None,
            None if tid in sf_linked else _next_working_day(project.start_date, cal).toordinal(),
        )
    return out


_InstantRuns = np.ndarray
"""The runs of a zero-base column whose draw rounds away (#4698, :func:`_mc_zero_base_column`).

Their links measure from the instant exactly as a milestone's do, and hand on no
fraction (#4697).
"""


_MilestoneReading = tuple[np.ndarray, np.ndarray, np.ndarray]
"""``(instant ordinal, start_display, deficit)`` of a milestone, per run (#4697).

The deficit is the working time the true point lies before the midnight it is
placed at (:func:`_mc_milestone_bounds`).
"""


_VerbatimActual = tuple[int, float, float]
"""``(actual_ordinal, snapped_offset, other_floor)`` of a live non-working actual start.

``snapped_offset`` is the offset :func:`_mc_es_floors` floors the task at, and
``other_floor`` the task's ES floor with the actual start left out (SNET pin and
data date only) — the two :func:`_mc_forward_pass` compares to tell, per run,
whether the verbatim actual is what binds the task's start.
"""


def _mc_verbatim_actuals(
    project: Project,
    task_map: dict[str, Task],
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: Mapping[int, _OffsetLookup],
    wd_index_by_cal: Mapping[int, Sequence[date]],
    sf_linked: frozenset[str] = frozenset(),
) -> dict[str, _VerbatimActual]:
    """The live tasks whose recorded ``actual_start`` falls on a non-working day (#4175).

    :func:`_mc_es_floors` snaps such an actual forward to a working day because the
    offset index cannot hold it, while ``schedule()`` keeps it verbatim. For a task
    with remaining work that is invisible at the finish (#3963), but a
    **zero-duration milestone** sees the raw date: its instant *is* the actual (Sunday
    00:00, not Monday), and a calendar-day lag from Sunday and from Monday can land a
    full weekend apart downstream — 2-3 working days on a fully deterministic
    project. This map lets it resolve its instant from the verbatim date instead,
    the way #2461 did for completed tasks. The other readers of the raw date, SS and
    SF successors, measure from it unconditionally since #4523 and get it as a
    constant edge (:func:`_completed_edge_constraints`).

    A working-day actual is left out: its snap is the identity and nothing diverges.
    ``other_floor`` mirrors :func:`_mc_es_floors`, project-start floor included for
    every task that is not ``sf_linked`` (#4218).
    """
    out: dict[str, _VerbatimActual] = {}
    status_date = project.status_date
    for t in task_map.values():
        actual = t.actual_start
        if actual is None or actual <= project.start_date or _is_complete(t):
            continue
        cal = cal_of[t.id]
        snapped = _next_working_day(actual, cal)
        if snapped == actual:
            continue
        cal_key = cal_key_of[t.id]
        offset_of = offset_of_by_cal[cal_key]
        last = float(len(wd_index_by_cal[cal_key]) - 1)
        if t.id in sf_linked:
            # Sub-start data date left out, as in _mc_es_floors (#4635).
            start_base = _next_working_day(project.start_date, cal)
            other = 0.0
            if t.planned_start is not None:
                other = _snapped_offset(t.planned_start, cal, offset_of, last)
            if status_date is not None and _floor_above_start(status_date, cal, start_base):
                other = max(other, _snapped_offset(status_date, cal, offset_of, last))
            out[t.id] = (actual.toordinal(), _snapped_offset(actual, cal, offset_of, last), other)
            continue
        other = _snapped_offset(project.start_date, cal, offset_of, last)
        if t.planned_start is not None and t.planned_start > project.start_date:
            other = max(other, _snapped_offset(t.planned_start, cal, offset_of, last))
        if status_date is not None and status_date > project.start_date:
            other = max(other, _snapped_offset(status_date, cal, offset_of, last))
        out[t.id] = (actual.toordinal(), _snapped_offset(actual, cal, offset_of, last), other)
    return out


def _snapped_offset(d: date, cal: Calendar, offset_of: _OffsetLookup, last: float) -> float:
    """Offset of the next working day at or after ``d``.

    Clamped to the index start below it; past the index end it raises rather than
    clamping to ``last`` (#4429). The same lookup :func:`_mc_es_floors` floors a task
    with, so the offsets :func:`_mc_verbatim_actuals` compares against are the ones the
    forward pass holds.
    """
    snapped = _next_working_day(d, cal)
    off = offset_of.get(snapped)
    if off is not None:
        return float(off)
    # Below the index only for a pre-start date on an SF-linked task (#4218), which
    # the pad was sized to hold; the index's first day is the safe side to clamp to.
    if isinstance(offset_of, _WorkingDayIndex):
        lowest, highest = offset_of[0], offset_of[-1]
    else:
        lowest, highest = min(offset_of, default=snapped), max(offset_of, default=snapped)
    if snapped > highest:
        _raise_mc_index_overrun()
    return 0.0 if snapped < lowest else last


def _mc_progress_state(
    project: Project,
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    task_calendars: dict[str, Calendar] | None,
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: Mapping[int, _OffsetLookup],
    wd_index_by_cal: Mapping[int, Sequence[date]],
    sf_linked: frozenset[str] = frozenset(),
) -> tuple[
    dict[str, float],
    dict[str, tuple[float, float]],
    dict[str, tuple[date, date]],
    dict[str, _Instant],
    dict[str, float],
]:
    """Precompute the per-run-invariant floors and progress pins (ADR-0132/0136).

    Returns ``(es_floor, completed_offsets, completed_dates, completed_instants,
    elapsed_days)``; ``completed_instants`` is :func:`_completed_dates`' milestone map.
    Completed tasks are pinned to a constant offset pair (not re-sampled) and carry
    their verbatim ``(early_start, early_finish)`` dates for the scalar
    constraint/floor paths; in-progress tasks record their fixed elapsed portion so
    only the remaining work carries uncertainty; SNET pins, recorded actual starts,
    and the data date floor every not-yet-finished task. None of these vary across
    runs, so they are computed once.

    Per-task calendars (#1385): every offset here is expressed in the *owning
    task's* working-day space, because that is the space its column of the forward
    pass lives in. ``es_floor`` therefore merges the SNET pin, the actual start,
    and the data-date floor per task rather than carrying a single project-wide
    status floor — with mixed calendars the same data date snaps to a different
    offset in each one.
    ``completed_dates`` is the exception that proves the rule: it is scalar
    ``date`` space precisely so it is calendar-neutral and can cross an edge into
    a successor on a different working week.
    """
    es_floor = _mc_es_floors(
        project, task_map, cal_of, cal_key_of, offset_of_by_cal, wd_index_by_cal, sf_linked
    )

    # The verbatim dates schedule() gives each completed task — read off an actual
    # deterministic forward pass rather than transcribed from it, so the two engines
    # cannot disagree on the completed-task arithmetic (#2460/#2461/#2572). Everything
    # downstream that must agree with schedule() — the successor constraints, the
    # terminal finish floor — is derived from THESE, in scalar date space, rather
    # than re-derived in offset space where a non-working date cannot be represented.
    completed_dates, completed_instants = _completed_dates(
        project, task_map, topo_order, g, task_calendars
    )

    completed_offsets: dict[str, tuple[float, float]] = {
        tid: _completed_offsets(
            es_date,
            ef_date,
            cal_of[tid],
            offset_of_by_cal[cal_key_of[tid]],
            wd_index_by_cal[cal_key_of[tid]],
        )
        for tid, (es_date, ef_date) in completed_dates.items()
    }

    # In-progress tasks have a fixed elapsed portion subtracted from every sampled
    # duration, so only the *remaining* work carries uncertainty (a deterministic
    # in-progress task still simulates to exactly its CPM finish). ``elapsed_days``
    # uses the same integer rule as _effective_duration_days so the engines agree.
    elapsed_days: dict[str, float] = {}
    for t in task_map.values():
        if not _is_complete(t) and t.percent_complete and t.percent_complete > 0:
            elapsed_days[t.id] = float(
                int(t.duration.days * min(t.percent_complete, 100.0) / 100.0)
            )

    return es_floor, completed_offsets, completed_dates, completed_instants, elapsed_days


class _McIndex:
    """Per-column working-day ordinals the milestone arithmetic reads (#4079)."""

    def __init__(self, wd_ord_of_col: list[np.ndarray], cal_of_col: list[Calendar]) -> None:
        self.wd_ord_of_col = wd_ord_of_col
        self.cal_of_col = cal_of_col

    def next_wd_offset(self, col: int, ordinals: np.ndarray) -> np.ndarray:
        """Offset, in ``col``'s space, of the first working day at or after each ordinal."""
        wd = self.wd_ord_of_col[col]
        off = np.searchsorted(wd, ordinals, side="left")
        # Past the index end is an undersized index, not a date: refuse it (#4429).
        if off.size and int(off.max()) > len(wd) - 1:
            _raise_mc_index_overrun()
        return off

    def prev_wd_ordinal(self, col: int, ordinals: np.ndarray) -> np.ndarray:
        """The last working day at or before each ordinal, on ``col``'s calendar.

        The index starts at the project start, but a milestone at the start of the
        project measures SF links, and FF links with no lag or a lead, from the
        working day *before* it (#4273), so a lookup
        that falls off the front is resolved against the calendar itself. An ordinal
        past the index end raises (#4429): the index cannot tell whether a working
        day lies between its last entry and the ordinal, so ``wd[-1]`` would be a guess.
        """
        wd = self.wd_ord_of_col[col]
        if ordinals.size and int(ordinals.max()) > int(wd[-1]):
            _raise_mc_index_overrun()
        raw_idx = np.searchsorted(wd, ordinals, side="right") - 1
        out = np.asarray(wd[np.clip(raw_idx, 0, len(wd) - 1)], dtype=np.int64)
        before = raw_idx < 0
        if before.any():
            cal = self.cal_of_col[col]
            for o in np.unique(ordinals[before]).tolist():
                prev = _prev_working_day(_safe_fromordinal(int(o)), cal).toordinal()
                out[before & (ordinals == o)] = prev
        return out

    def next_wd_ordinal(self, col: int, ordinals: np.ndarray) -> np.ndarray:
        """The first working day at or after each ordinal, on ``col``'s calendar.

        Like :meth:`prev_wd_ordinal`, a date before the index start — an FF/SF
        finish day measured from a project-start milestone — is resolved against
        the calendar rather than clipped to the project start.
        """
        wd = self.wd_ord_of_col[col]
        out = np.asarray(wd[self.next_wd_offset(col, ordinals)], dtype=np.int64)
        before = ordinals < wd[0]
        if before.any():
            cal = self.cal_of_col[col]
            for o in np.unique(ordinals[before]).tolist():
                nxt = _next_working_day(_safe_fromordinal(int(o)), cal).toordinal()
                out[before & (ordinals == o)] = nxt
        return out

    def ordinal_at(self, col: int, offsets: np.ndarray) -> np.ndarray:
        """The working day each start position falls in, in ``col``'s space.

        A fractional start is on the day it falls in (:func:`_start_day_index`,
        #4697), not the nearest one: 10.7 starts on day 10.
        """
        return self._ordinal_of_day(col, _start_day_index(offsets))

    def finish_ordinal(self, col: int, offsets: np.ndarray) -> np.ndarray:
        """The working day each exclusive finish position falls in (#4697).

        ``e = 10.3`` ends on day 10 and a whole ``e = 10`` on day 9
        (:func:`_finish_day_key`).
        """
        return self._ordinal_of_day(col, _finish_day_key(offsets) - 1.0)

    def _ordinal_of_day(self, col: int, days: np.ndarray) -> np.ndarray:
        wd = self.wd_ord_of_col[col]
        idx = days.astype(np.int64)
        if idx.size and int(idx.max()) > len(wd) - 1:
            _raise_mc_index_overrun()  # #4429: never clamp past the index end
        return np.asarray(wd[np.maximum(idx, 0)], dtype=np.int64)


def _mc_forward_pass(
    topo_order: list[str],
    runs: int,
    g: nx.DiGraph[str],
    task_idx: dict[str, int],
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None],
    dur_matrix: np.ndarray,
    es_floor: dict[str, float],
    completed_offsets: dict[str, tuple[float, float]],
    completed_edge: dict[tuple[str, str], _FixedEdge],
    elapsed_days: dict[str, float],
    milestone_ids: frozenset[str] = frozenset(),
    index: _McIndex | None = None,
    verbatim_actuals: dict[str, _VerbatimActual] | None = None,
    milestone_floors: dict[str, _MilestoneFloors] | None = None,
    zero_base_ids: frozenset[str] = frozenset(),
) -> tuple[np.ndarray, np.ndarray, date | None, dict[str, _InstantRuns]]:
    """Vectorised forward pass — early-start/early-finish working-day offset matrices.

    ES and EF are floating-point working-day offsets (0 = project start); EF = ES +
    duration on the open interval (exclusive end, so a 5-day task starting at offset
    0 has EF=5, and its FS successor starts at offset 5). Each column is filled in
    ``topo_order`` so every predecessor is resolved before its successors. Returns
    the ``(runs, n_tasks)`` ES and EF matrices.

    Zero-duration milestones (``milestone_ids``, #4079) are instants, and an offset
    cannot say which midnight an instant sits on — the end of Friday and a lag that
    lands on Sunday share a working-time position but are different anchors for the
    next lag. So a milestone column also carries each run's instant as a date
    ordinal and its links are resolved in date space by
    :func:`_mc_milestone_bounds`, replaying :func:`_place_milestone` exactly. Its ES
    is the instant's position; its EF holds the exclusive offset of the day it is
    shown on, which is what the project finish reads. ``milestone_floors``
    (:func:`_mc_milestone_floors`) gives each milestone's floors in date space, the
    project start apart from the rest: the column's ES/EF are the *shown* instant
    and ``instant_mat`` the *link* instant its successors measure from, which the
    project-start floor does not raise (#4225, :func:`_place_milestone`).

    Per-task calendars (#1385) are deliberately invisible here. A task's own column
    is expressed in its own calendar's working-day space, and each edge's delta
    array already carries the hop from the predecessor's space into the
    successor's (see :func:`_build_lag_delta`), so this loop needs no calendar
    argument at all — duration still adds in the successor's own space and every
    constraint arrives pre-converted. The caller reconciles the columns into one
    comparable space before taking the project maximum.

    ``verbatim_actuals`` (:func:`_mc_verbatim_actuals`, #4175) carries each live
    task's non-working ``actual_start`` so a milestone floored at it sits on that
    instant, as ``schedule()`` puts it (an SS/SF successor of started work reads the
    actual from a constant edge instead, #4523). A milestone shown on
    its non-working actual day contributes that date as the returned finish floor
    when it is shown there in *every* run — the offset index cannot hold the day,
    so its column carries the working day before it and the caller floors the
    percentiles at the date, as it does for completed work. Where only some runs
    show it there, the column keeps the next working day (later, never earlier).

    ``zero_base_ids`` (#4698) are live zero-duration tasks with a positive estimate.
    Each of their runs is one or the other, because a draw that rounds away leaves
    the task the 0-day task ``schedule()`` placed and only a larger one is work:
    see :func:`_mc_zero_base_column`. Those instant runs come back per column.

    Returns ``(es_mat, ef_mat, finish_floor, instant_runs)``.
    """
    n_tasks = len(topo_order)
    es_mat = np.zeros((runs, n_tasks), dtype=np.float64)
    ef_mat = np.zeros((runs, n_tasks), dtype=np.float64)
    # Milestone instants: date ordinal and start-of-day display, per run.
    # int32: these are date ordinals (at most ~3.7M for year 9999), far inside range, and
    # the matrix is runs x tasks, so halving it matters (#4710).
    instant_mat = np.zeros((runs, n_tasks), dtype=np.int32)
    start_display_mat = np.zeros((runs, n_tasks), dtype=bool)
    # How far each link instant's true point lies before its midnight (#4697).
    deficit_mat = np.zeros((runs, n_tasks), dtype=np.float64)
    verbatim_actuals = verbatim_actuals or {}
    milestone_floors = milestone_floors or {}
    finish_floor: date | None = None
    instant_runs: dict[str, _InstantRuns] = {}
    # Live work whose SS/SF links measure from a derived span start (#4523,
    # _mc_span_link): elapsed working days, by task. A recorded start never reaches
    # those links here — they are constants in ``completed_edge``.
    span_elapsed = {tid: int(days) for tid, days in elapsed_days.items() if days > 0}

    for col, tid in enumerate(topo_order):
        # Completed: pin both offsets to constants across every run and skip the
        # network/sampling logic entirely.
        if tid in completed_offsets:
            es_off, ef_off = completed_offsets[tid]
            es_mat[:, col] = es_off
            ef_mat[:, col] = ef_off
            continue

        if tid in milestone_ids:
            assert index is not None
            (link, link_display, link_def), (instant, start_display, shown_def) = (
                _mc_milestone_bounds(
                    tid,
                    col,
                    g,
                    task_idx,
                    (es_mat, ef_mat, instant_mat, start_display_mat, deficit_mat),
                    milestone_floors.get(tid, (None, None)),
                    completed_edge,
                    milestone_ids,
                    index,
                    runs,
                    span_elapsed,
                    instant_runs,
                )
            )
            instant_mat[:, col] = link
            start_display_mat[:, col] = link_display
            deficit_mat[:, col] = link_def
            # The instant's working-time position: its midnight's offset, less the
            # working time its true point lies before it (#4697).
            position = index.next_wd_offset(col, instant) - shown_def
            es_mat[:, col] = position
            # The day it is shown on (engine._instant_day), as an exclusive offset:
            # the first working day at or after the instant for a start-of-day
            # reading, the last one before it otherwise.
            ef_mat[:, col] = position + start_display
            actual = verbatim_actuals.get(tid)
            if actual is not None and bool(np.all(instant == actual[0]) and start_display.all()):
                # _place_milestone shows a milestone its actual-start floor holds on
                # that very (non-working) day. The column carries the working day
                # before it and the date itself floors the finish (#4175).
                ef_mat[:, col] = position
                floor_day = date.fromordinal(actual[0])
                finish_floor = floor_day if finish_floor is None else max(finish_floor, floor_day)
            continue

        actual = verbatim_actuals.get(tid)
        es_constraints, ef_constraints, has_ef_constraint = _mc_edge_constraints(
            tid,
            g,
            task_idx,
            edge_lag_delta,
            es_mat,
            ef_mat,
            es_floor if actual is None else {tid: actual[2]},
            completed_edge,
            runs,
            (milestone_ids, instant_mat, index, col, deficit_mat),
            span_elapsed,
            instant_runs,
        )
        if actual is not None:
            es_constraints = np.maximum(es_constraints, actual[1])

        eff_dur = _mc_effective_duration(
            dur_matrix[:, col], tid, elapsed_days, min_days=0.0 if tid in zero_base_ids else 1.0
        )
        es = es_constraints
        ef = es + eff_dur

        if has_ef_constraint:
            ef = np.maximum(ef, ef_constraints)
            # Where EF was pushed by FF/SF, ES moves back (but not below es_constraints).
            es = np.maximum(es_constraints, ef - eff_dur)
            ef = es + eff_dur

        if tid in zero_base_ids:
            assert index is not None
            (link, link_display, link_def), (instant, start_display, shown_def) = (
                _mc_milestone_bounds(
                    tid,
                    col,
                    g,
                    task_idx,
                    (es_mat, ef_mat, instant_mat, start_display_mat, deficit_mat),
                    milestone_floors.get(tid, (None, None)),
                    completed_edge,
                    milestone_ids,
                    index,
                    runs,
                    span_elapsed,
                    instant_runs,
                )
            )
            instant_mat[:, col] = link
            start_display_mat[:, col] = link_display
            deficit_mat[:, col] = link_def
            es, ef, instant_runs[tid], actual_day = _mc_zero_base_column(
                es,
                eff_dur,
                instant,
                start_display,
                index.next_wd_offset(col, instant).astype(np.float64) - shown_def,
                actual,
            )
            if actual_day is not None:
                finish_floor = actual_day if finish_floor is None else max(finish_floor, actual_day)

        es_mat[:, col] = es
        ef_mat[:, col] = ef

    return es_mat, ef_mat, finish_floor, instant_runs


def _mc_zero_base_column(
    es: np.ndarray,
    eff_dur: np.ndarray,
    instant: np.ndarray,
    start_display: np.ndarray,
    position: np.ndarray,
    actual: _VerbatimActual | None,
) -> tuple[np.ndarray, np.ndarray, _InstantRuns, date | None]:
    """ES/EF of a zero-duration task with a positive estimate, run by run (#4698).

    The working-day offsets cannot say which midnight a start sits on, so a zero
    draw, simulated as work, reads as work that ended the working day *before* its
    start: a lag would count from there, and a task held to a Monday would be shown
    on the Friday before. Flooring every draw at a day hid that by charging a day
    nobody estimated. So a run whose draw rounds away — under
    :data:`_ZERO_BASE_ROUND_AWAY` — is the instant
    :func:`_place_milestone` gives the deterministic pass, and links out of it
    measure from that instant (``instant_runs``), exactly as from a milestone. It
    hands on no fraction (#4697). Not the finish's: carried past the task it would
    cost every whole-day successor a day under the day-it-falls-in reading. Not the
    start an FF or SF link back-solved over the draw either: added after a link's
    lag and snap, that start pulled an SS successor back across a weekend its lag
    landed on, ahead of CPM. An instant run is placed as a milestone is, its true
    point carried as the milestone's deficit (:func:`_mc_milestone_bounds`).

    A larger draw is ordinary work. An FF or SF link back-solves its start over the
    draw, which can put a successor ahead of the instant's plan; the step at the
    threshold is that class (#4822).

    ``position`` is the instant's offset. ``actual`` is the task's non-working
    recorded start, if any: it floors the finish, as for a milestone, when every
    instant run is shown on that day (:func:`_mc_forward_pass`). The other runs are
    floored at the same recorded start, so none finishes before that date.

    Returns ``(es, ef, is_instant, actual_day)``.
    """
    ef = es + eff_dur
    # Rounds away whole (#4698, #4697): see _ZERO_BASE_ROUND_AWAY.
    is_instant = eff_dur < _ZERO_BASE_ROUND_AWAY
    instant_es = position
    instant_ef = instant_es + start_display
    actual_day: date | None = None
    if (
        actual is not None
        and is_instant.any()
        and bool(np.all(~is_instant | ((instant == actual[0]) & start_display)))
    ):
        instant_ef = instant_es
        actual_day = date.fromordinal(actual[0])
    return (
        np.where(is_instant, instant_es, es),
        np.where(is_instant, instant_ef, ef),
        is_instant,
        actual_day,
    )


def _mc_span_link(
    dep: Dependency,
    p: int,
    col: int,
    es_mat: np.ndarray,
    elapsed: int,
    index: _McIndex,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per-run bound of an SS/SF link out of live work with a *derived* span start (#4523).

    The link measures from the predecessor's span start (:func:`_link_start`),
    ``elapsed`` working days before its remaining-work window — which a run's
    sampled durations move, so unlike a recorded start it is not a constant. It is
    resolved in date space with ``schedule()``'s own helpers, once per distinct
    early start across the runs: the span start can fall before the index (a
    task whose progress reaches back past the project start), where an offset
    anchor would clamp to the first cell and land the bound late.

    Returns ``(offset, proposal, start_display, deficit)``: the constraint in column
    ``col``'s offset space (an exclusive EF offset for SF), and the instant, reading
    and deficit (:func:`_mc_milestone_bounds`) the same link proposes to a milestone
    successor (:func:`_milestone_proposal`).
    """
    pred_cal = index.cal_of_col[p]
    succ_cal = index.cal_of_col[col]
    es = es_mat[:, p]
    es_ord = index.ordinal_at(p, es)
    # The remaining window can open part-way into its day (#4697); the span start is
    # then that far into its own day, and the link carries the fraction as the
    # offset path does (_lagged_constraint).
    frac = es - _start_day_index(es)
    partial = frac > _MC_DAY_EPS
    uniq, inverse = np.unique(es_ord, return_inverse=True)
    offsets = np.empty(len(uniq), dtype=np.float64)
    proposals = np.empty(len(uniq), dtype=np.int64)
    displays = np.empty(len(uniq), dtype=bool)
    lands = np.empty(len(uniq), dtype=bool)
    span_ords = np.empty(len(uniq), dtype=np.int64)
    finish_bound = dep.dep_type not in _START_ANCHORED
    for k, o in enumerate(uniq.tolist()):
        span = _start_from_finish(date.fromordinal(int(o)), elapsed + 1, pred_cal)
        anchor = _edge_anchor(dep.dep_type, span, span, None, pred_cal, dep.lag)
        landing = _safe_offset(anchor, dep.lag)
        imposed = _next_working_day(landing, succ_cal)
        off = index.next_wd_offset(col, np.array([imposed.toordinal()], dtype=np.int64))
        offsets[k] = float(off[0]) + (1.0 if finish_bound else 0.0)
        lands[k] = finish_bound or imposed == landing
        raw, display = _milestone_proposal(
            dep.dep_type, dep.lag, span, span, None, pred_cal, succ_cal
        )
        proposals[k] = raw.toordinal()
        displays[k] = display
        span_ords[k] = span.toordinal()
    run_offsets = offsets[inverse] + np.where(partial & lands[inverse], frac, 0.0)
    # A start part-way into its day proposes the midnight closing that day, with
    # the working time it lies short of it as the deficit (#4697).
    run_proposals = np.where(partial, span_ords[inverse] + 1 + dep.lag.days, proposals[inverse])
    run_displays = np.where(partial, False, displays[inverse])
    return run_offsets, run_proposals, run_displays, np.where(partial, 1.0 - frac, 0.0)


def _mc_instant_proposal(
    dep: Dependency,
    p: int,
    instant_mat: np.ndarray,
    start_display_mat: np.ndarray,
    index: _McIndex,
    deficit_mat: np.ndarray,
) -> tuple[np.ndarray, np.ndarray | bool, np.ndarray]:
    """Per-run ``(raw midnight, start_display, deficit)`` a link out of an instant proposes.

    The predecessor's deficit (:func:`_mc_milestone_bounds`) carries over: the lag
    moves the true instant with its midnight. A run with a deficit is an end-of-day
    reading; if the lag lands it after non-working time, the reading turns to the
    start of the next day and the deficit is dropped where the winner is read.
    """
    lag = dep.lag.days
    deficit = deficit_mat[:, p]
    carried = deficit > 0.0
    if dep.dep_type in _START_ANCHORED:
        # Mirrors engine._place_milestone (#4079 fuzz regression): the
        # predecessor's own reading only carries over at zero lag, the
        # same midnight it occupies; a nonzero lag proposes a different
        # midnight and reads fresh, like an ordinary FS/SS predecessor.
        base_display = start_display_mat[:, p] if lag == 0 else dep.dep_type == DependencyType.SS
        return instant_mat[:, p] + lag, np.where(carried, False, base_display), deficit
    # A positive SF lag counts from the day the instant closes (#4333).
    anchor = instant_mat[:, p] - 1 if lag > 0 else index.prev_wd_ordinal(p, instant_mat[:, p] - 1)
    # SF proposes the raw midnight closing its anchor day, plus the lag (#4272).
    return anchor + 1 + lag, False, deficit


def _mc_work_proposal(
    dep: Dependency,
    p: int,
    col: int,
    es_mat: np.ndarray,
    ef_mat: np.ndarray,
    index: _McIndex,
    elapsed: int,
) -> tuple[np.ndarray, np.ndarray | bool, np.ndarray]:
    """Per-run ``(raw midnight, start_display, deficit)`` a link out of work proposes.

    A fractional finish or start proposes the midnight closing the day it falls in
    (#4697), plus the lag, with the working time it lies short of that midnight as
    the deficit (:func:`_mc_milestone_bounds`). A whole one has none and keeps the
    deterministic proposal.
    """
    lag = dep.lag.days
    if dep.dep_type == DependencyType.FS:
        ef = ef_mat[:, p]
        return (
            index.finish_ordinal(p, ef) + 1 + lag,
            False,
            np.maximum(_finish_day_key(ef) - ef, 0.0),
        )
    if elapsed > 0 and dep.dep_type in (DependencyType.SS, DependencyType.SF):
        # Measured from a derived span start (#4523, _mc_span_link).
        _, proposal, display, deficit = _mc_span_link(dep, p, col, es_mat, elapsed, index)
        return proposal, display, deficit
    es = es_mat[:, p]
    start_ord = index.ordinal_at(p, es)
    if dep.dep_type == DependencyType.SS:
        proposal, display = start_ord + lag, np.ones(len(es), dtype=bool)
    else:
        # SF anchors on the day the start instant closes with a positive lag (#4333),
        # else on the working day before the predecessor's start (#4145), and
        # proposes the raw midnight closing that day, plus the lag (#4272).
        anchor = start_ord - 1 if lag > 0 else index.prev_wd_ordinal(p, start_ord - 1)
        proposal, display = anchor + 1 + lag, np.zeros(len(es), dtype=bool)
    # Work that starts part-way into its day proposes the midnight closing that
    # day, plus the lag, for SS and SF alike: the first midnight at or after the
    # start instant.
    frac = es - _start_day_index(es)
    partial = frac > _MC_DAY_EPS
    deficit = np.where(partial, 1.0 - frac, 0.0)
    if partial.any():
        proposal = np.where(partial, start_ord + 1 + lag, proposal)
        display = np.where(partial, False, display)
    return proposal, display, deficit


def _mc_milestone_bounds(
    tid: str,
    col: int,
    g: nx.DiGraph[str],
    task_idx: dict[str, int],
    mats: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    floors: _MilestoneFloors,
    completed_edge: dict[tuple[str, str], _FixedEdge],
    milestone_ids: frozenset[str],
    index: _McIndex,
    runs: int,
    span_elapsed: dict[str, int] | None = None,
    instant_runs: dict[str, _InstantRuns] | None = None,
) -> tuple[_MilestoneReading, _MilestoneReading]:
    """Per-run ``(link, shown)`` of a live milestone, each ``(ordinal, start_display, deficit)``.

    The vectorised :func:`_place_milestone`: every floor and incoming link proposes
    a raw midnight and the latest wins, a start-of-day reading winning a tie. The
    ``key = 2 * ordinal + start_display`` encoding makes that one ``maximum``, and
    :func:`_start_reading` is applied to the winner.
    ``mats`` is ``(es, ef, instant, start_display, deficit)`` for the columns filled
    so far; its instant columns hold each earlier milestone's *link* instant.

    The **deficit** (#4697) is how far, in working time, the true instant lies
    before the midnight it is shown at. A milestone after work that ends 0.3 into a
    day sits at that point, but the date space holds only midnights, so it is placed
    at the one closing the day (the first at or after it) with a deficit of 0.7. Its
    position is that midnight's offset less the deficit, and links out of it measure
    from the true point (:func:`_mc_instant_edge_bound`), so a milestone on a path
    neither drops nor adds working time. Rounding it up to the midnight instead put
    each milestone on a path up to a day late, compounding along a chain. A deficit
    only exists on an end-of-day reading of a working day: a lag that lands the
    instant in non-working time leaves it at the start of the next working day,
    with none. Of proposals at one key the latest true instant, the least deficit,
    wins; a floor proposes a midnight exactly and has none.

    ``floors`` is ``(hard, start)`` (:func:`_mc_milestone_floors`), both date
    ordinals in date space. ``hard`` — data date, SNET, the VERBATIM recorded actual
    start (#4175) — binds the link instant; the project-start floor ``start`` only
    the shown one (#4225). A non-working actual therefore proposes its own midnight,
    not the snapped working day the offset floor holds: ``schedule()`` places the
    milestone on Sunday 00:00, and a calendar-day lag measured from Monday instead
    lands a weekend later. An SS or SF link from started work measures from its
    verbatim actual too, and arrives as a constant in ``completed_edge`` (#4523).
    """
    es_mat, ef_mat, instant_mat, start_display_mat, deficit_mat = mats
    hard, start = floors
    # The links alone first, from -1, below any key a proposal can produce: a floor
    # that only ties the latest of them in working time leaves the link instant
    # where they put it (engine._equivalent_link, #4690). An SF-linked milestone
    # with no hard floor always has an SF link that offers a candidate.
    pred_key = np.full(runs, -1, dtype=np.int64)
    pred_def = np.zeros(runs, dtype=np.float64)

    def offer(
        ordinals: np.ndarray, start_display: np.ndarray | bool, deficit: np.ndarray | float = 0.0
    ) -> None:
        new_key = ordinals * 2 + np.asarray(start_display, dtype=np.int64)
        new_def = np.broadcast_to(np.asarray(deficit, dtype=np.float64), (runs,))
        np.copyto(
            pred_def,
            np.where(new_key > pred_key, new_def, np.minimum(pred_def, new_def)),
            where=new_key >= pred_key,
        )
        np.maximum(pred_key, new_key, out=pred_key)

    for pred_id in g.predecessors(tid):
        # FF into a milestone is FS (engine._milestone_link, #4272).
        dep: Dependency = _milestone_link(g[pred_id][tid]["dep"])
        fixed = completed_edge.get((pred_id, tid))
        if fixed is not None:
            offer(np.full(runs, fixed[2], dtype=np.int64), fixed[3])
            continue
        p = task_idx[pred_id]
        if pred_id in milestone_ids:
            offer(*_mc_instant_proposal(dep, p, instant_mat, start_display_mat, index, deficit_mat))
            continue
        proposal, display, deficit = _mc_work_proposal(
            dep, p, col, es_mat, ef_mat, index, (span_elapsed or {}).get(pred_id, 0)
        )
        # A zero-base predecessor is an instant in some runs (#4698).
        pred_runs = (instant_runs or {}).get(pred_id)
        if pred_runs is not None:
            at_instant, at_display, at_deficit = _mc_instant_proposal(
                dep, p, instant_mat, start_display_mat, index, deficit_mat
            )
            proposal = np.where(pred_runs, at_instant, proposal)
            display = np.where(pred_runs, at_display, display)
            deficit = np.where(pred_runs, at_deficit, deficit)
        offer(proposal, display, deficit)

    def with_deficit(winner: np.ndarray) -> _MilestoneReading:
        # The winner's deficit if a link proposed it, none for a floor; a start-of-day
        # reading lies after non-working time and has none either.
        instant, start_display = read(winner)
        deficit = np.where((winner == pred_key) & ~start_display, pred_def, 0.0)
        return instant, start_display, deficit

    def read(winner: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        # _start_reading (#4173): an end-of-day reading needs a working day before
        # the instant. Applying it once to the winner equals applying it to every
        # proposal, because it only ever raises the flag of a key and never
        # reorders two keys.
        instant = winner // 2
        start_display = (winner % 2).astype(bool)
        # _start_reading short-circuits on a start-of-day reading, so only an
        # end-of-day one probes the day before; at date.min that day does not
        # exist, and a start-of-day winner there must not ask for it (#4265).
        day_before = np.where(start_display, instant, instant - 1)
        after_non_working = ~start_display & (index.next_wd_ordinal(col, day_before) != day_before)
        return instant, start_display | after_non_working

    key = pred_key if hard is None else np.maximum(pred_key, hard * 2 + 1)
    shown_key = key if start is None else np.maximum(key, start * 2 + 1)
    # Nothing but the project start proposed: the link instant is the shown one.
    link, link_display, link_def = with_deficit(np.where(key < 0, shown_key, key))
    if hard is not None:
        # engine._equivalent_link: the latest link, from an earlier midnight, is
        # shown at the start of the hard floor's own day — held below the project
        # start when that is the floor, or read as the start of the day it is
        # shown on. The floor and the link are then one working-time point.
        safe = np.where(pred_key < 0, hard * 2 + 1, pred_key)
        p_instant, p_display, p_def = with_deficit(safe)
        if start is None:
            held = np.zeros(runs, dtype=bool)
        else:
            held = (p_instant < start) | ((p_instant == start) & ~p_display)
        on_floor = np.where(
            held,
            start == hard,
            p_display & (index.next_wd_ordinal(col, p_instant) == hard),
        )
        equivalent = (pred_key >= 0) & (p_instant < hard) & on_floor
        link = np.where(equivalent, p_instant, link)
        link_display = np.where(equivalent, p_display, link_display)
        link_def = np.where(equivalent, p_def, link_def)
    return (link, link_display, link_def), with_deficit(shown_key)


def _mc_instant_edge_bound(
    dep: Dependency,
    p: int,
    col: int,
    instant_mat: np.ndarray,
    index: _McIndex,
    deficit_mat: np.ndarray,
) -> np.ndarray:
    """Per-run bound a link out of an instant puts on work: ES for FS/SS, exclusive EF else.

    The instant's deficit (:func:`_mc_milestone_bounds`, #4697) is subtracted, so
    work measures from its true point. For FS/SS only while the lagged point still
    lands in the successor's working time — the day before the bound's midnight is
    the bound's own previous working day — as for work (:func:`_lagged_constraint`);
    otherwise the successor waits for the next working day to open. An FF/SF bound
    is a finish, and the deficit only moves it within its snapped day.
    """
    deficit = deficit_mat[:, p]
    if dep.dep_type in _START_ANCHORED:
        anchor_ord = instant_mat[:, p]
    elif dep.lag > timedelta(0):
        # A positive FF or SF lag counts from the day the instant closes
        # (#4273, #4333); a lead counts back from the zero-lag anchor below.
        anchor_ord = instant_mat[:, p] - 1
    else:
        anchor_ord = index.prev_wd_ordinal(p, instant_mat[:, p] - 1)
    landing = anchor_ord + dep.lag.days
    bound = index.next_wd_offset(col, landing).astype(np.float64)
    if dep.dep_type not in _START_ANCHORED:
        finish_bound: np.ndarray = bound + 1.0 - deficit
        return finish_bound
    if not (deficit > 0.0).any():
        return bound
    wd = index.wd_ord_of_col[col]
    slot = bound.astype(np.int64) - 1
    lands = (slot >= 0) & (wd[np.clip(slot, 0, len(wd) - 1)] == landing - 1)
    return bound - np.where(lands, deficit, 0.0)


def _mc_edge_constraints(
    tid: str,
    g: nx.DiGraph[str],
    task_idx: dict[str, int],
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None],
    es_mat: np.ndarray,
    ef_mat: np.ndarray,
    es_floor: dict[str, float],
    completed_edge: dict[tuple[str, str], _FixedEdge],
    runs: int,
    milestones: tuple[frozenset[str], np.ndarray, _McIndex | None, int, np.ndarray] | None = None,
    span_elapsed: dict[str, int] | None = None,
    instant_runs: dict[str, _InstantRuns] | None = None,
) -> tuple[np.ndarray, np.ndarray, bool]:
    """Fold every predecessor edge into one task's ES/EF constraint vectors.

    A completed predecessor's constraint is a run-invariant constant already
    resolved in scalar date space from its VERBATIM dates (#2460/#2461), so it is
    taken directly: routing it through the offset anchor + lag-delta path would
    re-derive it from the working-day index, which cannot represent a non-working
    actual and lands a day off.

    A live milestone predecessor (#4079) is read from its per-run instant —
    ``milestones`` is ``(milestone_ids, instant_mat, index, this_col, deficit_mat)``: FS/SS
    measure from the instant, an FF or SF with a positive lag from the day it closes
    (#4273, #4333), and an FF or SF with no lag or a lead from the last working day
    before it (:func:`_edge_anchor`), then ``next_wd(anchor + lag)`` on this task's
    calendar.

    An SS or SF link from started work measures from the recorded ``actual_start``
    (:func:`_link_start`, #4523), a run-invariant date, so it arrives in
    ``completed_edge`` as a constant resolved in date space from the verbatim
    actual, like a completed predecessor's. Only an SS/SF link from work that has
    not started reaches the offset anchor below, where the start is a working day.

    A zero-base predecessor (#4698) is such an instant only in its ``instant_runs``,
    the runs that drew no work (#4697); its other runs are work.

    A link with a lag-delta array carries the anchor's fraction only while the
    lagged instant lands in working time (:func:`_lagged_constraint`, #4697).

    Returns ``(es_constraints, ef_constraints, has_ef_constraint)``.
    """
    es_constraints = np.full(runs, es_floor.get(tid, 0.0))
    ef_constraints = np.zeros(runs)
    has_ef_constraint = False
    milestone_ids, instant_mat, index, col, deficit_mat = milestones or (
        frozenset(),
        es_mat,
        None,
        0,
        np.zeros_like(es_mat),
    )

    for pred_id in g.predecessors(tid):
        fixed = completed_edge.get((pred_id, tid))
        if fixed is not None:
            is_ef_constraint, imposed_off = fixed[0], fixed[1]
            if is_ef_constraint:
                np.maximum(ef_constraints, imposed_off, out=ef_constraints)
                has_ef_constraint = True
            else:
                np.maximum(es_constraints, imposed_off, out=es_constraints)
            continue

        dep: Dependency = g[pred_id][tid]["dep"]
        p = task_idx[pred_id]

        if pred_id in milestone_ids:
            assert index is not None
            bound = _mc_instant_edge_bound(dep, p, col, instant_mat, index, deficit_mat)
            if dep.dep_type in _START_ANCHORED:
                np.maximum(es_constraints, bound, out=es_constraints)
            else:
                np.maximum(ef_constraints, bound, out=ef_constraints)
                has_ef_constraint = True
            continue

        elapsed = (span_elapsed or {}).get(pred_id, 0)
        if elapsed > 0 and dep.dep_type in (DependencyType.SS, DependencyType.SF):
            # Measured from a derived span start (#4523, _mc_span_link).
            assert index is not None
            bound, _, _, _ = _mc_span_link(dep, p, col, es_mat, elapsed, index)
            if dep.dep_type == DependencyType.SS:
                np.maximum(es_constraints, bound, out=es_constraints)
            else:
                np.maximum(ef_constraints, bound, out=ef_constraints)
                has_ef_constraint = True
            continue

        delta_arr = edge_lag_delta[(pred_id, tid)]

        # Anchor: predecessor finish for FS/FF, predecessor start for SS/SF.
        if dep.dep_type in (DependencyType.FS, DependencyType.FF):
            anchor = ef_mat[:, p]
        else:
            anchor = es_mat[:, p]
        # Lag-free edges (the dominant kind) use the anchor directly instead
        # of allocating a runs-sized zeros vector and adding it — adding
        # zeros is exact in float64, so results are bit-identical (#1860).
        # The in-place maximum removes the remaining temporary; it is safe
        # because es/ef_constraints are freshly allocated owned arrays per
        # task (never views aliasing the anchor's matrix) and both start
        # fully initialized (SNET/status floors and zeros respectively).
        if delta_arr is None:
            constraint = anchor
        else:
            constraint = _lagged_constraint(
                dep.dep_type,
                delta_arr,
                anchor,
                dep.lag.days,
                None if index is None else index.wd_ord_of_col[p],
                None if index is None else index.wd_ord_of_col[col],
            )
        pred_runs = (instant_runs or {}).get(pred_id)
        if pred_runs is not None:
            assert index is not None
            at_instant = _mc_instant_edge_bound(dep, p, col, instant_mat, index, deficit_mat)
            constraint = np.where(pred_runs, at_instant, constraint)
        if dep.dep_type in (DependencyType.FS, DependencyType.SS):
            np.maximum(es_constraints, constraint, out=es_constraints)
        else:  # FF / SF
            np.maximum(ef_constraints, constraint, out=ef_constraints)
            has_ef_constraint = True

    return es_constraints, ef_constraints, has_ef_constraint


def _mc_effective_duration(
    sampled: np.ndarray, tid: str, elapsed_days: dict[str, float], min_days: float = 1.0
) -> np.ndarray:
    """Sampled duration floored at ``min_days`` of work, less any elapsed portion.

    The default floor of one working day exists because ordinary work occupies at
    least its start day. It does not apply to a task whose base duration is zero:
    a live one that samples zero in every run is an instant and never reaches this
    function (#4079), and one with a positive estimate passes ``min_days=0.0``
    (#4698), since a day it was never estimated to take would be charged in every
    run. #1066 had floored milestones at a day too, to agree with the deterministic
    pass's old convention, which gave every milestone a whole working day.

    The fixed elapsed portion of an in-progress task is subtracted first so only
    its remaining work is sampled (ADR-0132); the floor then applies.
    """
    if tid in elapsed_days:
        sampled = sampled - elapsed_days[tid]
    eff_dur: np.ndarray = np.maximum(sampled, min_days)
    return eff_dur
