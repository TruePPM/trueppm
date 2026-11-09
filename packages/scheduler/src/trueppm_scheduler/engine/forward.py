"""CPM forward pass: early dates, floors and pinned placements."""

from __future__ import annotations

from collections.abc import (
    Callable,
)
from datetime import (
    date,
)

import networkx as nx

from trueppm_scheduler.engine.calendar_math import (
    _advance_calendar_days,
    _effective_duration_days,
    _finish_from_start,
    _is_complete,
    _next_working_day,
    _safe_offset,
    _start_from_finish,
)
from trueppm_scheduler.engine.milestones import (
    _ONE_DAY,
    _START_ANCHORED,
    _closed_milestone_link,
    _edge_anchor,
    _Instant,
    _link_start,
    _place_milestone,
    _start_reading,
)
from trueppm_scheduler.models import (
    Calendar,
    Dependency,
    DependencyType,
    Task,
)

# ---------------------------------------------------------------------------
# CPM: forward and backward passes
# ---------------------------------------------------------------------------


def _forward_pass(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    project_start: date,
    calendar: Calendar,
    status_date: date | None = None,
    task_calendars: dict[str, Calendar] | None = None,
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, _Instant]:
    """Compute early_start and early_finish for every task (in-place).

    Progress-aware (ADR-0132): a completed task (``actual_finish`` set, or
    ``percent_complete >= 100``) is pinned by :func:`_pinned_placement` and removed
    from network logic (ADR-0136, #4343); an in-progress task
    contributes only its remaining duration; and when ``status_date`` (the data
    date) is given, remaining/not-started work is floored at it — future work is
    never scheduled in the past. An in-progress task's ``actual_start``, when
    recorded, is an additional early-start floor (ADR-0132 §2, #2621): work
    already underway stays where it actually started, even past the data date
    or a predecessor's constraint. With no actuals and no status date the
    result is byte-identical to a pure planning pass.

    Per-task calendars (ADR-0120 D3): when ``task_calendars`` is supplied, the task
    being computed (the successor of every incoming edge) uses its own calendar for
    *all* of its arithmetic — duration expansion **and** the working-day snap of
    every predecessor constraint, since lag lands on the successor's calendar and
    the successor *is* the node here. ``task_calendars=None`` (or any task absent
    from it) falls back to ``calendar``, making the single-calendar path identical.

    Zero-duration tasks scheduled through the network are placed as instants
    (#4079, see the module docstring). Returns ``{task_id: (instant,
    start_display)}`` for each of them (:data:`_Instant`), which the backward pass,
    float computation and Monte Carlo's completed-task constraints read to invert
    and extend the same rule. A completed task with work is absent: it is ordinary
    work to its successors. A completed milestone is present, with or without
    actuals: it stays an instant (:func:`_pinned_milestone_instant`, #4343), on the
    edge of its day it had live when actuals are recorded (#4433).

    ``link_instants``, when given, is filled with the instant each of those
    milestones' successors measure from (:func:`_place_milestone`'s ``link``). It
    differs from the shown instant only for a milestone held up by the project-start
    floor alone (#4225).
    """
    floors: dict[int, tuple[date, date, date | None]] = {}
    instants: dict[str, _Instant] = {}
    links: dict[str, _Instant] = {} if link_instants is None else link_instants

    def cal_for(tid: str) -> Calendar:
        return calendar if task_calendars is None else task_calendars.get(tid, calendar)

    for node_id in topo_order:
        task = task_map[node_id]
        # The node being computed is the successor of all its incoming edges, so a
        # single calendar — its own — governs both its duration and the snap of
        # every predecessor constraint (lag is consumed on the successor's
        # calendar). With no per-task calendars this is always ``calendar``.
        cal = calendar if task_calendars is None else task_calendars.get(node_id, calendar)
        start_base, start, data_floor = _calendar_floors(cal, project_start, status_date, floors)
        # Only a milestone can sit at the end of its day (#4079, #4433);
        # reset first so an input carrying a previous run's value cannot leak.
        task.milestone_at_day_end = False

        pinned = _pinned_placement(task, cal, start_base)
        if pinned is not None:
            task.early_start, task.early_finish = pinned
            if task.duration.days == 0:
                # A completed milestone stays an instant (#4343, #4433), on the
                # edge of its day it had live (#4525): read from completed
                # predecessors, except that while one is still open the edge the
                # caller's previous run recorded on the recorded day stands in for
                # the facts that work has not yet supplied.
                recorded = task.actual_finish or task.actual_start
                frozen = task.live_day_end_on == recorded and any(
                    not _is_complete(task_map[p]) for p in g.predecessors(node_id)
                )
                live_start = recorded is None or (
                    not frozen
                    and _live_milestone_edge(node_id, task_map, g, cal, links, cal_for, recorded)
                )
                instants[node_id], links[node_id] = _pinned_milestone_instant(
                    task, cal, pinned[0], live_start
                )
                if recorded is not None and live_start:
                    # The midnight it linked from live, not the recorded day's (#4690).
                    links[node_id] = _closed_milestone_link(
                        node_id,
                        task_map,
                        g,
                        cal,
                        links,
                        cal_for,
                        recorded,
                        None if _sf_linked(node_id, g) else start_base,
                    )
                task.milestone_at_day_end = not instants[node_id][1]
            task.scheduled_start = _compute_scheduled_start(task, cal)
            continue

        sf_linked = _sf_linked(node_id, g)
        duration_days, es_constraints = _early_start_floors(
            task,
            cal,
            start,
            data_floor,
            start_base=start_base,
            sf_linked=sf_linked,
            snet_verbatim=sf_linked,
        )

        if duration_days == 0:
            # Every floor but the project start's — the list an SF-linked task gets —
            # binds the instant successors measure from; the project start only
            # bounds where the milestone is shown (#4225, see _place_milestone).
            # A data date at or before the start is not in it, nor is such an SNET
            # unless the milestone is SF-linked (#4635, _early_start_floors).
            _, hard_floors = _early_start_floors(
                task,
                cal,
                start,
                data_floor,
                start_base=start_base,
                sf_linked=True,
                snet_verbatim=sf_linked,
            )
            instant, day, links[node_id] = _place_milestone(
                node_id,
                task_map,
                g,
                cal,
                hard_floors,
                links,
                cal_for,
                None if sf_linked else start_base,
            )
            task.early_start = task.early_finish = day
            instants[node_id] = instant
            # ``start_display`` False = shown at the end of ``day`` (follows work).
            task.milestone_at_day_end = not instant[1]
            task.scheduled_start = _compute_scheduled_start(task, cal)
            continue

        pred_es, ef_constraints = _forward_edge_constraints(
            node_id, task_map, g, cal, links, cal_for
        )
        es_constraints.extend(pred_es)

        if not es_constraints:
            # An SF-linked task with no FS/SS link and no data date, SNET or actual
            # start (#4218): its finish links place it, and nothing floors the start
            # they back-solve. ``_sf_linked`` guarantees ef_constraints here.
            min_ef = max(ef_constraints)
            task.early_start = _start_from_finish(min_ef, duration_days, cal)
            task.early_finish = max(
                _finish_from_start(task.early_start, duration_days, cal), min_ef
            )
            task.scheduled_start = _compute_scheduled_start(task, cal)
            continue

        # ES = latest of all ES constraints.
        task.early_start = max(es_constraints)
        task.early_finish = _finish_from_start(task.early_start, duration_days, cal)

        # Apply EF constraints (from FF/SF dependencies).
        if ef_constraints:
            min_ef = max(ef_constraints)
            if min_ef > task.early_finish:
                task.early_finish = min_ef
                # Pull ES back to match: task must start early enough to hit EF.
                back_start = _start_from_finish(task.early_finish, duration_days, cal)
                # ES cannot go below its own constraints.
                task.early_start = max(back_start, max(es_constraints))
                # Recompute EF from the (possibly adjusted) ES.
                task.early_finish = max(
                    _finish_from_start(task.early_start, duration_days, cal),
                    min_ef,
                )

        task.scheduled_start = _compute_scheduled_start(task, cal)

    return instants


def _sf_linked(node_id: str, g: nx.DiGraph[str]) -> bool:
    """Whether ``node_id`` has at least one incoming SF link (#4218, #4220).

    Such a task is not floored at the project start (see "An SF-linked task may
    start before the project start" in the module docstring): its floor is
    ``min(project start, SF placement)``, which never binds. It reads the graph the
    pass schedules — the same edge set :mod:`trueppm_scheduler.derive` explains
    from — and the Monte Carlo pass, the
    derivation and the Rust engine (``forward.rs::sf_linked``) apply the same test.
    """
    return any(g[p][node_id]["dep"].dep_type == DependencyType.SF for p in g.predecessors(node_id))


def _early_start_floors(
    task: Task,
    cal: Calendar,
    start: date,
    data_floor: date | None = None,
    *,
    start_base: date,
    sf_linked: bool = False,
    snet_verbatim: bool = False,
) -> tuple[int, list[date]]:
    """Return ``(duration_days, es_constraints)``: the duration to schedule and the ES lower bounds.

    The bounds cover the project-start / data-date floor, an in-progress task's
    ``actual_start``, and ``planned_start`` (SNET). Predecessor-driven bounds are
    added by the caller.

    An SNET at or before ``start_base`` (the project-start floor) is left out, like a
    data date there (:func:`_calendar_floors`), unless ``snet_verbatim``: raised to
    the project start it is the project-start floor, which ``start`` already carries
    and which a milestone's link instant deliberately does not take (#4225). Left in,
    it pulled that instant, and every lag measured from it, *earlier* than no SNET at
    all (#4635). ``snet_verbatim`` is the SF-linked task's case: it takes no
    project-start floor, so an SNET can only hold it later than its SF placement,
    never earlier, and the UI's "snap to project start" / "move project start" /
    "start at the earliest" commits write exactly such an SNET (the API pulls the
    project start back to it, #867). Dropping it there made each of those commits a
    no-op that ratcheted the project start earlier. ``actual_start`` is never
    dropped: a recorded fact may precede the plan.

    ``sf_linked`` (:func:`_sf_linked`) drops the project-start floor and keeps only the
    data date (``data_floor``, ``None`` when no status date is set), so the list
    may come back empty (#4218). For a task with an SF link the project-start floor
    is ``min(project start, SF placement)``, which its SF link already enforces, so
    leaving it out is that rule (#4220). Why the two floors part here: the project start
    is where the plan *nominally* opens, and an SF link is the one dependency that
    can legitimately require work before an early predecessor — MS Project moves
    such a successor ahead of the project start rather than dropping its link. The
    data date is not a planning choice: remaining work cannot be forecast into the
    past, so an SF anchor behind it means the successor is late, and it stays on
    the data date like any other unfinished work.

    Only reached for a task that is not complete: every completed task is pinned by
    :func:`_pinned_placement` before the forward pass asks for its floors (#4343).
    """
    # In-progress work contributes only what is left, laid forward from the
    # data date; not-started work uses its full estimate.
    duration_days = _effective_duration_days(task)
    es_floor = data_floor if sf_linked else start
    es_constraints: list[date] = [] if es_floor is None else [es_floor]
    if task.actual_start is not None:
        # ADR-0132 §2 / #2621: work already underway is floored at where
        # it actually started, not just at the data date or predecessor
        # constraints — actuals are truth and are never smoothed back
        # to an earlier network slot. Unsnapped, unlike planned_start:
        # a recorded actual can legitimately land on a non-working day
        # (e.g. logged over a weekend) and is not renegotiated.
        es_constraints.append(task.actual_start)

    # planned_start (SNET) is an additional ES lower-bound: the task may
    # not start before this date regardless of network logic.
    if task.planned_start is not None:
        snet = (
            _next_working_day(task.planned_start, cal)
            if snet_verbatim
            else _floor_above_start(task.planned_start, cal, start_base)
        )
        if snet is not None:
            es_constraints.append(snet)
    return duration_days, es_constraints


def _floor_above_start(floor: date, cal: Calendar, start_base: date) -> date | None:
    """``floor`` (a data date or SNET) snapped to ``cal``, or ``None`` at or before the start.

    Raised to the project-start floor ``start_base``, a bound at or before it *is* that
    floor, so it is dropped: every task that takes the project-start floor already has
    it, and the places that leave it out must not get it back through it (#4635). The
    data date is dropped for every task, an SF-linked one (#4218) included. An SNET
    is dropped for the instant a milestone's successors measure from (#4225) and a
    completed milestone's link, and kept verbatim on an SF-linked task, where it can
    only hold the task later (:func:`_early_start_floors`). Compared after snapping,
    so a status date on the weekend before a Monday start is at the start. One
    definition for both passes and the Rust engine (``forward.rs::floor_above_start``).
    """
    snapped = _next_working_day(floor, cal)
    return snapped if snapped > start_base else None


def _calendar_floors(
    cal: Calendar,
    project_start: date,
    status_date: date | None,
    cache: dict[int, tuple[date, date, date | None]],
) -> tuple[date, date, date | None]:
    """The project-start floor and the data-date floor for ``cal``, memoized (#1824).

    Both floors snap to the task's *own* calendar — a task can never begin on its own
    non-working day. With one project calendar every task resolves the same value the
    pre-ADR-0120 pass hoisted out of the loop, so the result is byte-identical.

    Memoized because both are identical for every task sharing a calendar, and
    re-snapping per task made the forward pass O(tasks · scan_depth): a valid calendar
    whose exceptions blanket a ~36k-day gap after the start (one working day just past
    it, so validation's reachability probe passes) turned even a few hundred tasks into
    a multi-second spin — every task repeating the same 36k-day walk. Keyed by object
    identity: Calendar holds a mutable exceptions list and isn't hashable, and the
    resolved objects are stable here.

    Returns ``(start_base, start, data_floor)`` — the project-start floor, that floor
    raised to the data date when one is set, and the data-date floor on its own
    (``None`` without a status date). A status date at or before project start is
    already covered by the project-start floor in ``start``, so ``data_floor`` is
    ``None`` for it too (:func:`_floor_above_start`, #4635); otherwise it is what an
    SF-linked task, which the project start does not floor, is held at (#4218), and
    what binds a milestone's link instant (#4225).
    """
    key = id(cal)
    cached = cache.get(key)
    if cached is not None:
        return cached

    start_base = _next_working_day(project_start, cal)
    start = start_base
    data_floor: date | None = None
    if status_date is not None:
        # The data date floors all not-yet-finished work: nothing remaining can be
        # scheduled before "as of now".
        data_floor = _floor_above_start(status_date, cal, start_base)
        if data_floor is not None:
            start = data_floor
    cache[key] = (start_base, start, data_floor)
    return start_base, start, data_floor


def _compute_scheduled_start(task: Task, cal: Calendar) -> date:
    """The task's span start (ADR-0752), as distinct from ``early_start``.

    ``early_start``/``early_finish`` mean the *remaining-work window* for an
    in-progress task (ADR-0132) — what the task's own remaining duration and its
    finish-side (FS/FF) links are laid from, but not the task's span, and not what
    its start-side (SS/SF) links measure from (:func:`_link_start`, ADR-0132 §2a).
    ``scheduled_start`` is the span start, per this table:

    - Not started (``percent_complete <= 0``): ``early_start`` — the windows
      coincide, nothing has been consumed yet.
    - Complete (:func:`_is_complete`): ``early_start`` — ADR-0136 already pins
      a completed task at its full duration, so the remaining window *is* the
      span.
    - In progress, ``actual_start`` recorded: ``actual_start`` — the span
      began when work actually began, however long ago that was. The span may
      then exceed ``duration`` (a task running long); that divergence is the
      whole point of the field (ADR-0752 §2).
    - In progress, no ``actual_start``: the full duration backed off from
      ``early_finish`` (which is unaffected by this — remaining work still
      ends when the task ends), calendar-aware via :func:`_start_from_finish`.

    Must be called after ``task.early_start``/``task.early_finish`` are set
    for this task (i.e. from within :func:`_forward_pass`, after the early
    window is resolved for both the pinned and network-scheduled branches).
    """
    assert task.early_start is not None and task.early_finish is not None
    if _is_complete(task):
        return task.early_start
    pct = task.percent_complete or 0.0
    if pct <= 0:
        return task.early_start
    if task.actual_start is not None:
        return task.actual_start
    full_days = task.duration.days
    return _start_from_finish(task.early_finish, full_days, cal)


def _pinned_placement(task: Task, cal: Calendar, start_base: date) -> tuple[date, date] | None:
    """Early window for a completed task, which is pinned out of network logic.

    A completed task (``actual_finish`` set, or ``percent_complete >= 100``) is laid
    out at its FULL duration so the bar keeps its shape (ADR-0136). Whatever actuals
    exist anchor the span; a missing endpoint is derived from full duration. Actuals
    are truth, so a pinned task leaves network logic entirely — it may even sit before
    a predecessor, surfacing out-of-sequence reality rather than smoothing it away.

    A completed task with **no** actuals at all is pinned too (#4343): its full
    duration is laid out from ``start_base`` — the project start snapped to the
    task's calendar, never the data date, because completed work is historical —
    raised to its ``planned_start`` (SNET) when one is set. Predecessors do not move
    it. That is the position the backward pass, free float, Monte Carlo and the
    derivation already assumed (they all treat a completed task as out of the
    network); placing it through the network here instead made the two halves of the
    engine disagree about the same task, inflating its predecessors' float and
    dropping them off the critical path.

    Returns ``None`` — "schedule this one through the network" — only when the task
    is not complete.
    """
    if not _is_complete(task):
        return None

    full_days = task.duration.days
    if task.actual_finish is not None:
        # Finish is known; start is the recorded actual, else a full duration back
        # from the finish (the actual_finish drives FS successors, the resolved
        # start drives SS/SF successors).
        start = (
            task.actual_start
            if task.actual_start is not None
            else _start_from_finish(task.actual_finish, full_days, cal)
        )
        return start, task.actual_finish
    if task.actual_start is not None:
        # Start is known (e.g. a REVIEW task: done, awaiting sign-off); lay the full
        # duration forward from it.
        return task.actual_start, _finish_from_start(task.actual_start, full_days, cal)
    # No actuals: the un-floored project start, or the SNET when it is later.
    start = start_base
    if task.planned_start is not None:
        start = max(start, _next_working_day(task.planned_start, cal))
    return start, _finish_from_start(start, full_days, cal)


def _live_milestone_edge(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    links: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    recorded: date,
) -> bool:
    """Whether a closed milestone sits at the *start* of its recorded day (#4433).

    The edge of the day a live milestone sits on is set by whatever places it: a
    floor (project start, data date, SNET) proposes the start of its day, an FS
    link from work the end of the work's finish day (:func:`_place_milestone`).
    Closing it records *when* it happened, not a different kind of instant, so it
    keeps that edge — "preserve the live edge".

    The recorded day is offered as a start-of-day floor alongside the links, which
    is what a data-date or SNET floor that placed the milestone live amounts to
    once the actuals supply the date: the end of the day wins only when an FS
    proposal from work reaches past the start of the recorded day — the work
    finished that day (or later). Asking the links alone read every milestone
    with an FS predecessor as end-of-day, so one whose work finished days before
    it was signed off, or held by a later SNET, slipped its successors a working
    day when it was closed — the #4433 bug again. With no predecessor nothing but
    a floor can place it: the start of its day.

    Only **completed** predecessors are read (#4525). A closed milestone is pinned
    out of network logic (ADR-0136), so its edge must be a function of facts
    recorded by the time it closed, not of a live predecessor's current forecast.
    Reading every predecessor let an unrelated slip of open work — a milestone
    signed off out of sequence — flip the edge and move the milestone's
    successors a working day either way: a longer predecessor could finish the
    project *earlier*, and the predecessor's float, measured by a backward pass
    that skips completed successors, ignored the coupling. Completed predecessors
    are themselves pinned, so by induction nothing live can move a closed
    milestone.

    Open work that placed the milestone live is still honored, through the one
    fact recorded about it: :attr:`Task.live_day_end_on`, the day the caller's
    previous run showed it at the end of. While any predecessor is still open
    and that names the recorded day, the forward pass keeps the end-of-day edge
    and does not call this. Otherwise — every predecessor complete, none at all,
    no value handed back, or a milestone signed off on another day — this
    reading decides, so a correction to completed work or a deleted link is
    re-read rather than frozen. Neither path reads an open task's forecast, so
    no change to open work moves a closed milestone, and one closed on its
    forecast day ahead of its work keeps its edge. Its link instant is a separate
    question (:func:`_closed_milestone_link`): closed ahead of open work, a lagged
    successor can still move (#4740).
    """
    shown, _, _ = _place_milestone(
        node_id, task_map, g, cal, [recorded], links, cal_for, completed_only=True
    )
    return shown[1]


def _pinned_milestone_instant(
    task: Task, cal: Calendar, day: date, live_start: bool = True
) -> tuple[_Instant, _Instant]:
    """``(shown, link)`` for a completed milestone pinned on ``day`` (#4343, #4433).

    Pinning takes the milestone out of the network, but not out of being a
    milestone. With no actuals it is an instant at the start of its pinned day,
    as a live milestone with no links is (#4343); the pair is what
    :func:`_place_milestone` returns with no predecessors: the SNET is a fact
    about when the milestone happens and binds ``link``; the project start only
    bounds where it is shown (#4225). ``day`` already is the later of the two
    (:func:`_pinned_placement`), and an SNET at or before the project start is no
    floor (#4635) — linking from it measured successors' lags from before the plan
    opened — so ``link`` is ``shown``.

    With actuals recorded — the API's normal path, since ``COMPLETE`` stamps
    ``actual_finish`` — the day is the recorded one (``actual_finish``, else
    ``actual_start``), shown and — at the end of the day — linked from alike; at
    the start of the day the caller replaces ``link`` with the live instant
    (:func:`_closed_milestone_link`, #4690). The edge of that day is
    the one the milestone had live (``live_start``, :func:`_live_milestone_edge`).
    A milestone that nothing precedes, or that a floor held, stays at the start of
    its day: laying it out as ordinary work, ending at the end of the day, slipped
    every FS successor a working day the moment the milestone was closed (#4433).
    One placed by work finishing that day stays at the end of it, so closing it
    then does not pull its successors into the day the work was still finishing.

    At the end of the recorded day, ``shown`` and ``link`` differ in their reading
    when that day is non-working on ``cal`` (#4641). Successors read ``link`` the
    way an FS proposal from work is read, so a weekend actual snaps forward to the
    start of the next working day (:func:`_start_reading`). ``shown`` stays at the
    end of the recorded day, because the shown day *is* the recorded day, kept
    verbatim the way completed work's weekend ``actual_finish`` is. Pairing the
    snapped start-of-day reading with the recorded day showed the milestone at the
    start of its day, a day before the instant the backward pass seeds from. That
    gave work finishing later the same day float it did not have: a 1-day task
    reported 5 days of float, and spending all 5 moved the shown finish.
    """
    recorded = task.actual_finish if task.actual_finish is not None else task.actual_start
    if recorded is not None:
        if live_start:
            actual: _Instant = (recorded, True)
            return actual, actual
        raw = _safe_offset(recorded, _ONE_DAY)
        return (raw, False), (raw, _start_reading(raw, False, cal))
    shown: _Instant = (day, True)
    return shown, shown


def _forward_edge_constraints(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    instants: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
) -> tuple[list[date], list[date]]:
    """Split a node's incoming edges into early-start and early-finish constraints.

    FS/SS bound when the successor may *start*; FF/SF bound when it may *finish*. All
    snapping uses ``cal`` — the successor's calendar — because lag is consumed on the
    successor's calendar and the successor is the node being computed. Each bound is
    ``next_wd(anchor + lag)``; :func:`_edge_anchor` supplies the anchor, which for a
    milestone predecessor is the instant its successors measure from (``instants``
    here is :func:`_forward_pass`'s link map, #4225) rather than a day it occupies
    (#4079).
    """
    es_constraints: list[date] = []
    ef_constraints: list[date] = []

    for pred_id in g.predecessors(node_id):
        pred = task_map[pred_id]
        dep: Dependency = g[pred_id][node_id]["dep"]
        # Predecessors are visited first in topological order, so these are always set.
        assert pred.early_start is not None and pred.early_finish is not None
        anchor = _edge_anchor(
            dep.dep_type,
            _link_start(pred),
            pred.early_finish,
            instants[pred_id][0] if pred_id in instants else None,
            cal_for(pred_id),
            dep.lag,
        )
        bound = _advance_calendar_days(anchor, dep.lag, cal)
        if dep.dep_type in _START_ANCHORED:
            es_constraints.append(bound)
        else:
            ef_constraints.append(bound)

    return es_constraints, ef_constraints
