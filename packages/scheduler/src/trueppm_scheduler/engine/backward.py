"""CPM backward pass: late dates, total float and free float."""

from __future__ import annotations

from collections.abc import (
    Callable,
)
from datetime import (
    date,
    timedelta,
)

import networkx as nx

from trueppm_scheduler.engine.calendar_math import (
    _advance_calendar_days,
    _effective_duration_days,
    _finish_from_start,
    _is_complete,
    _next_working_day,
    _prev_working_day,
    _retreat_calendar_days,
    _safe_offset,
    _start_from_finish,
    _working_days_between,
    _WorkingDayCounter,
)
from trueppm_scheduler.engine.milestones import (
    _ONE_DAY,
    _START_ANCHORED,
    _edge_anchor,
    _finish_instant,
    _free_start_ref,
    _Instant,
    _late_display,
    _link_finish_ref,
    _link_start,
    _link_start_ref,
    _milestone_finish_bound,
    _milestone_free_instants,
    _milestone_latest,
    _milestone_link,
    _milestone_proposal,
    _milestone_refs,
    _sf_latest_start,
    _start_fixed_link,
    _window_start_bound,
)
from trueppm_scheduler.engine.results import (
    DrivingEdge,
)
from trueppm_scheduler.models import (
    Calendar,
    Dependency,
    DependencyType,
    Task,
)


def _backward_pass(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    project_finish: date,
    calendar: Calendar,
    task_calendars: dict[str, Calendar] | None = None,
    instants: dict[str, _Instant] | None = None,
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, date]:
    """Compute late_start and late_finish for every task (in-place).

    Progress-aware (ADR-0132/0136): a completed task carries zero float (late ==
    early — it is done, it has no slack), reusing the full-duration span the forward
    pass resolved, and an in-progress task's late dates span only its remaining
    duration, matching the forward pass so total/free float stay internally
    consistent.

    Per-task calendars (ADR-0120 D3): the node being computed (the *predecessor* of
    every outgoing edge here) is the one whose late_start/late_finish this call
    produces. Mirroring the forward pass — where the node being computed always
    uses its *own* calendar for its own arithmetic, because that arithmetic must
    land on a day the node itself can work — every successor-derived constraint
    here also snaps to a working day on **this task's own** calendar (``node_cal``),
    never the successor's. (The successor's calendar governs lag arithmetic and the
    free-float mirror in :func:`_compute_floats`, which simulates what the forward
    pass would impose *on the successor* — a different node, a different question.
    Using the successor's calendar here instead was issue #1490: it could snap a
    predecessor's own late date to a day before its early date.) With
    ``task_calendars=None`` every lookup resolves to ``calendar`` and the pass is
    identical to before.

    ``instants`` is the milestone map :func:`_forward_pass` returned (#4079). A
    milestone's late instant is the latest one every successor link still admits
    (:func:`_milestone_latest`), and a milestone successor offers its predecessors
    its late instant (:func:`_milestone_refs`) in place of a late start/finish it
    does not occupy. Returns each live milestone's late instant: the day it is
    shown on does not determine it (the end of Tuesday is the start of
    Wednesday). These are the *uncapped* instants predecessors read; a milestone's
    own total float is measured to :func:`_float_late_instant` of them, which the
    caller computes (#4183).

    ``link_instants`` is :func:`_forward_pass`'s link map (#4225). A milestone held
    up by the project-start floor alone is shown later than the instant its
    successors measure from, and its late instant is floored at the latter: that is
    the coordinate its predecessors invert against, so the floor at the shown
    instant would hand them a bound the direct link never imposes. Its own late
    date is still never shown before its early one.
    """
    early_instants = instants or {}
    links = link_instants or {}
    late_instants: dict[str, date] = {}
    # Every late date is seeded from the instant the project ends. Without
    # milestones that is the end of the finish day, exactly the old seed; a
    # milestone at the *start* of the finish day ends the project there, and
    # ordinary work finishing later that day would delay it (#4079).
    finish_instant = (
        _finish_instant(task_map, early_instants)
        if early_instants
        else _safe_offset(project_finish, _ONE_DAY)
    )

    def cal_for(tid: str) -> Calendar:
        return calendar if task_calendars is None else task_calendars.get(tid, calendar)

    for node_id in reversed(topo_order):
        task = task_map[node_id]
        # This node is the predecessor of its outgoing edges; its own calendar lays
        # out its duration (and floors its late finish at the project finish).
        node_cal = cal_for(node_id)

        # Completed (actual_finish set, or percent_complete >= 100): late == early,
        # so the task carries zero float and never distorts the critical path. The
        # forward pass already resolved its full-duration span (ADR-0136).
        if _is_complete(task):
            assert task.early_start is not None and task.early_finish is not None
            task.late_finish = task.early_finish
            task.late_start = task.early_start
            continue

        early = early_instants.get(node_id)
        if early is not None:
            late_instants[node_id] = _apply_milestone_late_date(
                node_id,
                task,
                (early, links.get(node_id, early)),
                g,
                task_map,
                node_cal,
                (project_finish, finish_instant),
                late_instants,
                cal_for,
            )
            continue

        lf_constraints, ls_constraints = _collect_backward_constraints(
            node_id, g, task_map, node_cal, (project_finish, finish_instant), late_instants, cal_for
        )
        _apply_late_dates(task, lf_constraints, ls_constraints, node_cal)

    return late_instants


def _late_refs(
    succ_id: str,
    succ: Task,
    late_instants: dict[str, date],
    cal_for: Callable[[str], Calendar],
    link: tuple[Dependency, bool, date],
) -> tuple[date, date]:
    """``(start_ref, finish_ref)`` a live successor's late window offers its predecessor.

    ``link`` is ``(dep, pred_is_milestone, project_finish)``: a milestone successor's
    start reference depends on how that link would show it (:func:`_link_start_ref`),
    and so does the finish reference an SF link inverts against
    (:func:`_link_finish_ref`, #4431).

    Neither cap goes below a live milestone's recorded ``actual_start``. That
    floor holds the milestone verbatim on its own day whatever reading a link
    would give it, so a proposal at or before it moves nothing. Capping past it
    (a Saturday ``actual_start``, ``X -SS+1d-> M``) understated ``X``'s float by
    a working day.
    """
    late = late_instants.get(succ_id)
    if late is not None:
        succ_cal = cal_for(succ_id)
        start_ref = _milestone_refs(late)[0]
        dep, pred_is_milestone, project_finish = link
        capped = (
            _link_start_ref(
                start_ref, dep.dep_type, dep.lag, pred_is_milestone, succ_cal, project_finish
            ),
            _link_finish_ref(late, dep.dep_type, succ_cal, project_finish),
        )
        if succ.actual_start is None:
            return capped
        held = _milestone_refs(min(succ.actual_start, late))
        return max(capped[0], held[0]), max(capped[1], held[1])
    assert succ.late_start is not None and succ.late_finish is not None
    return succ.late_start, succ.late_finish


def _apply_milestone_late_date(
    node_id: str,
    task: Task,
    early_pair: tuple[_Instant, _Instant],
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    node_cal: Calendar,
    finish: tuple[date, date],
    late_instants: dict[str, date],
    cal_for: Callable[[str], Calendar],
) -> date:
    """Set a milestone's late date (``late_start == late_finish``); return its instant.

    The latest instant every live successor link still admits, capped at the
    project's finish (:func:`_milestone_finish_bound`; ``finish`` is
    ``(project_finish, finish_instant)``) and floored at the early instant for the
    same coordinate-system reason as :func:`_apply_late_dates` (#4079).

    ``early_pair`` is ``(shown, link)`` (:func:`_place_milestone`). The returned
    instant, which predecessors read, is floored at ``link``; the shown late date
    at ``shown`` (#4225).
    """
    early, link = early_pair
    project_finish, finish_instant = finish
    bounds: list[date] = [_milestone_finish_bound(finish_instant, project_finish, node_cal)]
    for succ_id in g.successors(node_id):
        succ = task_map[succ_id]
        if _is_complete(succ):
            continue
        dep: Dependency = g[node_id][succ_id]["dep"]
        if succ_id in late_instants:
            dep = _milestone_link(dep)
        start_ref, finish_ref = _late_refs(
            succ_id, succ, late_instants, cal_for, (dep, True, project_finish)
        )
        bounds.append(_milestone_latest(dep.dep_type, dep.lag, start_ref, finish_ref, node_cal))
    late = max(min(bounds), link[0])
    task.late_start = task.late_finish = _late_display(
        max(late, early[0]), task, early, node_cal, project_finish
    )
    return late


def _collect_backward_constraints(
    node_id: str,
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    node_cal: Calendar,
    finish: tuple[date, date],
    late_instants: dict[str, date],
    cal_for: Callable[[str], Calendar],
) -> tuple[list[date], list[date]]:
    """Gather the LF and LS constraints this task's successors impose on it.

    ``finish`` is ``(project_finish, finish_instant)``; ``finish_instant`` is the
    midnight the project ends (the day after ``project_finish`` unless a
    start-of-day milestone ends it, #4079). The
    project-finish seed floors the task's late finish at the project end, but
    snapped to *this node's own* last workable day: ``project_finish`` is
    ``max(early_finish)`` across all tasks and can land on a day this node cannot
    work — a completed task's weekend ``actual_finish`` (single calendar) or a max
    EF contributed by a 7-day-calendar task (per-task calendars, ADR-0120). Seeding
    the raw value would overstate this task's float by ≥1 and propagate the error
    upstream through backward-pass edges (#1820). With one project calendar and no
    out-of-sequence weekend actuals, ``project_finish`` is itself a working day and
    this is a no-op.

    A completed successor is out of network logic (ADR-0136): the forward pass lays
    it at its actuals, possibly out of sequence, and it carries zero float, so it
    imposes no backward constraint on a still-live predecessor. Including it would
    clamp this task's late dates to the done successor's actuals — reporting
    false-zero float and polluting the critical path (#1819).

    Every bound produced here is snapped to a working day, so none of them can
    express an early window that sits on a non-working day; the coordinate-system
    mismatch that creates is resolved once, in :func:`_apply_late_dates` (#3963),
    rather than by special-casing each constraint.
    """
    project_finish, finish_instant = finish
    lf_constraints: list[date] = [
        _prev_working_day(_safe_offset(finish_instant, -_ONE_DAY), node_cal)
    ]
    ls_constraints: list[date] = []
    task = task_map[node_id]

    for succ_id in g.successors(node_id):
        succ = task_map[succ_id]
        if _is_complete(succ):
            continue
        dep: Dependency = g[node_id][succ_id]["dep"]
        if _start_fixed_link(task, dep):
            # Measured from a start that already happened (#4523): no slip of this
            # task's remaining work can move the successor through it.
            continue
        if succ_id in late_instants:
            dep = _milestone_link(dep)
        start_ref, finish_ref = _late_refs(
            succ_id, succ, late_instants, cal_for, (dep, False, project_finish)
        )
        _append_successor_constraint(
            dep, start_ref, finish_ref, node_cal, lf_constraints, ls_constraints, task
        )

    return lf_constraints, ls_constraints


def _append_successor_constraint(
    dep: Dependency,
    succ_start: date,
    succ_finish: date,
    node_cal: Calendar,
    lf_constraints: list[date],
    ls_constraints: list[date],
    task: Task | None = None,
) -> None:
    """Translate one successor edge into an LF or LS bound on the predecessor.

    An SS/SF bound is on the start the link measures from (:func:`_link_start`);
    for a predecessor whose span start is derived it is moved onto the
    remaining-work window the late dates describe (:func:`_window_start_bound`,
    #4523). ``task`` is that predecessor; ``None`` keeps the bound as is.

    Each result becomes *this* task's own late date, so it snaps to a working day on
    this task's own calendar (``node_cal``) — snapping on the successor's calendar
    instead (the #1490 bug) could push it before its own early_finish.

    ``succ_start``/``succ_finish`` are the successor's late start and late finish,
    or — for a milestone successor — the working-day positions of its late instant
    (:func:`_milestone_refs`, #4079).
    """
    lag = dep.lag

    if dep.dep_type == DependencyType.FS:
        # Predecessor must finish the day before successor's late start minus lag.
        lf_constraints.append(
            _prev_working_day(_safe_offset(succ_start, -timedelta(days=1) - lag), node_cal)
        )
    elif dep.dep_type == DependencyType.SS:
        # Predecessor must start no later than successor's late start minus lag.
        bound = _retreat_calendar_days(succ_start, lag, node_cal)
        ls_constraints.append(bound if task is None else _window_start_bound(bound, task, node_cal))
    elif dep.dep_type == DependencyType.FF:
        # Predecessor must finish no later than successor's late finish minus lag.
        lf_constraints.append(_retreat_calendar_days(succ_finish, lag, node_cal))
    elif dep.dep_type == DependencyType.SF:
        # Predecessor must start no later than the first working day after the
        # successor's late finish minus lag: its SF anchor is the working day
        # *before* its start, so it may start one working day beyond that bound
        # (#4145). A positive lag anchors on ``start - 1`` itself (#4333).
        bound = _sf_latest_start(succ_finish, lag, node_cal)
        ls_constraints.append(bound if task is None else _window_start_bound(bound, task, node_cal))


def _apply_late_dates(
    task: Task,
    lf_constraints: list[date],
    ls_constraints: list[date],
    node_cal: Calendar,
) -> None:
    """Set ``late_finish``/``late_start`` from the binding constraints, in place.

    The late window is finally floored at the task's own early window (#3963): a
    late date is never earlier than its early counterpart. That is not a tie-break
    or a tolerance — a task asked to finish before the day it can finish has an
    incoherent window that no consumer can draw, and ``late_start``/``late_finish``
    are persisted and read by the web float bar
    (``packages/web/src/hooks/useScheduleTasks.ts``), which renders the span
    backwards. ``_working_days_between`` clamps the negative span to ``0`` on the
    way into ``total_float``, so the task is additionally reported as *critical*
    and the evidence is erased.

    It is needed because the two passes work in different coordinate systems on
    exactly one class of input. An early window may sit on a **non-working day** —
    a recorded ``actual_start`` is kept verbatim (ADR-0132 §2). (A live
    zero-duration milestone no longer reaches this function: it is an instant, and
    :func:`_apply_milestone_late_date` places it — #4079. The milestone example
    below is kept because it is the history of this floor.) Every backward bound, by
    contrast, is ``_prev_working_day``-snapped (:func:`_collect_backward_constraints`,
    :func:`_append_successor_constraint`) and so *cannot* name that day: a milestone
    pinned to a Saturday whose successor starts Monday gets a late finish of Friday.
    Friday and Saturday are the same position in working-day arithmetic — the float
    is genuinely zero either way — so raising the late window to the early one picks
    the coherent representation of an already-correct answer rather than discarding
    a constraint. For every window that lies on working days the floor is a no-op.

    Stated once here rather than at each constraint site: the bounds are produced
    in four places, and a rule spread across four snaps is the shape that let the
    #3963 class survive four previous fixes (#1830, #1929, #2461, #1827).

    **It is not a purely local correction — say so rather than let it surprise.**
    This pass runs in reverse topological order and
    :func:`_append_successor_constraint` reads ``succ.late_start``, so raising one
    task's late window propagates upstream: on ``P -FS-> M(milestone, actual_start
    = Sat) -FS-> S``, ``P``'s total float goes from 1 working day to 2, and ``P``
    carries no actual and sits entirely on working days. The new number is the
    right one — ``P`` really can finish a day later and still let ``M`` begin on
    its recorded Saturday — but "representational" describes the *choice between
    two encodings of the same float*, not the blast radius, and a predecessor's
    ``late_start``, ``late_finish`` and ``total_float`` all move.
    """
    duration_days = _effective_duration_days(task)

    # LF = earliest of all LF constraints (binding constraint).
    task.late_finish = min(lf_constraints)
    task.late_start = _start_from_finish(task.late_finish, duration_days, node_cal)

    # Apply LS constraints (from SS/SF dependencies).
    if ls_constraints:
        max_ls = min(ls_constraints)
        if max_ls < task.late_start:
            task.late_start = max_ls
            # Push LF forward to match.
            fwd_finish = _finish_from_start(task.late_start, duration_days, node_cal)
            task.late_finish = min(fwd_finish, min(lf_constraints))

    assert task.early_start is not None and task.early_finish is not None
    task.late_finish = max(task.late_finish, task.early_finish)
    task.late_start = max(task.late_start, task.early_start)


def _compute_floats(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    calendar: Calendar,
    wd_counter: _WorkingDayCounter | None = None,
    task_calendars: dict[str, Calendar] | None = None,
    instants: dict[str, _Instant] | None = None,
    late_instants: dict[str, date] | None = None,
    link_instants: dict[str, _Instant] | None = None,
    free_instants_out: dict[str, date] | None = None,
) -> list[DrivingEdge]:
    """Compute total_float, free_float, and is_critical for every task (in-place).

    Returns the list of :class:`DrivingEdge` s discovered as a side output of the
    free-float slack loop — links that bind their successor or whose relationship
    free float is zero (#2095, #4704).

    ``total_float`` is the working-day span between a task's early and late start;
    a task is ``is_critical`` when it is zero.

    ``free_float`` is the number of working days a task can slip without delaying
    the early start (FS/SS links) or the early finish (FF/SF links) of *any* of
    its successors — the standard critical-path-method definition of free float,
    evaluated across **all four** dependency types. Like total float it is computed
    by **inverting** the forward constraint (the same inversion the backward pass
    applies for late dates), anchored on each successor's *early* date: for every
    link we find the latest date this task could finish/start that still leaves the
    successor's early date untouched, and take the working-day slip to it. Free
    float is the minimum of those slacks, capped at total float; a task with no
    live successor falls back to its total float. (Earlier versions inspected FS
    successors only and let SS/FF/SF tasks report ``free_float == total_float``;
    that FS-only caveat was removed in #825. Earlier still, the slack was measured
    from the *forward*-imposed date instead of the inverse constraint — a proxy
    that diverged whenever a calendar-day lag re-landed across non-working days as
    the task slipped, #1828.)

    Per-task calendars (ADR-0120 D3): every span — total-float and each free-float
    slack — is measured on the task's *own* calendar, because the slip is counted
    in that task's working days; each free-float constraint is snapped on that same
    calendar, mirroring the backward pass. With one project calendar every span
    resolves to ``calendar`` and ``wd_counter`` is used for all of them.

    A milestone's spans are measured between *instants* (#4079): its early instant
    (``instants``, from :func:`_forward_pass`) and, in ``late_instants``, the late
    instant its own float runs to — :func:`_backward_pass`'s instant already capped
    by :func:`_float_late_instant` (#4183), not the raw one. The day a milestone is
    shown on can name the end of Tuesday as "Tuesday" and the start of Wednesday as
    "Wednesday", one instant apart by zero working days, so a span between shown
    days would miscount.

    ``link_instants`` is :func:`_forward_pass`'s link map (#4225): a milestone's own
    floats run from its shown instant, its successors' free-float stretch from the
    instant they measure from.

    ``free_instants_out``, when given, receives the milestone free-float instants
    computed here, so :func:`schedule` can hand them to :mod:`derive` instead of it
    rebuilding the graph to recompute the same map (#4524).
    """
    early_instants = instants or {}
    lates = late_instants or {}
    links = link_instants or {}

    # Driving edges (#2095): links that bind the successor's early date
    # (:func:`_link_binds`, #4704) or whose per-edge free-float slack is zero.
    # Collected as a side output of the same slack loop that computes free float;
    # purely presentational.
    driving_edges: list[DrivingEdge] = []
    # Free float compares a milestone successor by its shown position, not its raw
    # instant (#4180).
    free_instants = _milestone_free_instants(
        topo_order,
        g,
        task_map,
        early_instants,
        lambda tid: calendar if task_calendars is None else task_calendars.get(tid, calendar),
        links,
    )
    if free_instants_out is not None:
        free_instants_out.update(free_instants)

    for node_id in topo_order:
        task = task_map[node_id]
        node_cal = calendar if task_calendars is None else task_calendars.get(node_id, calendar)

        # Total float: working days between early_start and late_start.
        # A task is critical when this is zero (cannot be delayed at all).
        # All passes have run by now, so these fields are always set.
        assert task.early_start is not None and task.late_start is not None
        assert task.early_finish is not None
        early = early_instants.get(node_id)
        if early is not None and node_id in lates:
            tf_days = _wd_span(
                early[0],
                lates[node_id],
                node_cal,
                wd_counter,
                calendar,
            )
        else:
            tf_days = _wd_span(task.early_start, task.late_start, node_cal, wd_counter, calendar)
        task.total_float = timedelta(days=tf_days)
        # A completed task is never on the critical path. The backward pass pins a
        # done task to late == early (ADR-0132/0136), which mechanically yields
        # zero total float — but a finished task has no remaining work and no slack
        # to manage, so it cannot drive the project finish and must not be reported
        # as critical (nor pull the completed prefix of the schedule into the
        # critical_path list). Completion overrides the zero-float rule; total_float
        # stays 0 because the task genuinely has no slack (#1863).
        task.is_critical = tf_days == 0 and not _is_complete(task)

        # Free float: the largest number of working days this task can slip before
        # it would push the early date of *any* live successor. Like total float,
        # it must **invert** the forward constraint rather than approximate it. For
        # each link we compute the latest date this task could finish (FS/FF) or
        # start (SS/SF) that still leaves the successor's early date untouched —
        # applying the *same* calendar-day retreat the backward pass uses for late
        # dates (see :func:`_backward_pass`), but anchored on the successor's
        # **early** dates (not late), which is exactly what turns the result into
        # free float rather than total float. Free float is the working-day slip
        # from this task's own early date to that latest date, minimized over all
        # successors and capped at total float; a task with no live successor falls
        # back to its total float.
        #
        # The earlier version instead measured the working-day gap between the
        # *forward*-imposed date and the successor's early date. That proxy assumes
        # one working day of slip moves the imposed date by one working day, which
        # fails whenever a calendar-day lag re-lands across non-working days as the
        # task slips: a single working day of slip can jump the imposed date by
        # several working days (or none), so the proxy both over- and under-counted
        # the true slack (#1828). Inverting the constraint — the way total float
        # already does — is exact for every dep type and lag.
        #
        # The slip is measured in *this* task's working days, and each constraint
        # is snapped on this task's own calendar (``node_cal``) — mirroring the
        # backward pass, whose retreat also lands on ``node_cal``. With one project
        # calendar every span resolves to ``calendar`` and the counter is used.
        ff_days = _free_float_days(
            node_id,
            task,
            g,
            task_map,
            node_cal,
            tf_days,
            wd_counter,
            calendar,
            driving_edges,
            (early_instants, links),
            task_calendars,
            free_instants,
        )
        task.free_float = timedelta(days=max(0, ff_days))

    return driving_edges


def _wd_span(
    start: date,
    end: date,
    cal: Calendar,
    wd_counter: _WorkingDayCounter | None,
    calendar: Calendar,
) -> int:
    """Working-day span, via the counter when it is for ``cal``'s calendar.

    The counter is built over the default project ``calendar`` (the ``schedule()``
    hot path, #822), so it is only valid for spans measured on that calendar — a
    per-task calendar uses :func:`_working_days_between` directly. Both return
    identical counts.
    """
    if wd_counter is not None and cal is calendar:
        return wd_counter.between(start, end)
    return _working_days_between(start, end, cal)


def _free_float_days(
    node_id: str,
    task: Task,
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    node_cal: Calendar,
    tf_days: int,
    wd_counter: _WorkingDayCounter | None,
    calendar: Calendar,
    driving_edges: list[DrivingEdge],
    instant_maps: tuple[dict[str, _Instant], dict[str, _Instant]],
    task_calendars: dict[str, Calendar] | None,
    free_instants: dict[str, date],
) -> int:
    """Working days this task can slip before it moves any live successor in working time.

    A successor's early start is read at the working day it sits at, so a verbatim
    non-working ``actual_start`` (a Saturday) counts as the Monday after it (#4332);
    every other early date already is a working day.

    Appends to ``driving_edges`` as a side output: a link that binds the
    successor's early position (:func:`_link_binds`, #4704) or whose relationship
    free float is zero (#2095). The forward pass guarantees ``slack >= 0``, so the
    exact zero test is deterministic across both engines.

    Mirrors the backward pass in skipping completed successors: one is out of
    network logic (ADR-0136) and cannot bound this task's slip, and including it
    would report false-zero free float on the live predecessor (#1819).

    A task with no live successor falls back to its total float.

    ``instant_maps`` is ``(instants, link_instants)``: this task's own slip runs from
    its shown instant, and a zero-lag link carries its link instant's reading into a
    milestone successor (:func:`_place_milestone`, #4225).
    """
    instants, links = instant_maps
    ff_days = tf_days
    for succ_id in g.successors(node_id):
        succ = task_map[succ_id]
        if _is_complete(succ):
            continue
        dep: Dependency = g[node_id][succ_id]["dep"]
        assert succ.early_start is not None and succ.early_finish is not None
        succ_instant = instants.get(succ_id)
        succ_free = free_instants.get(succ_id)
        # The driving edge keeps the link's own type; the arithmetic below uses the
        # type a milestone successor sees (FF is FS, #4272).
        label = dep.dep_type.value
        succ_cal = calendar if task_calendars is None else task_calendars.get(succ_id, calendar)
        # Checked on the link's own type: a milestone proposal reads FF as FS itself.
        binds = _link_binds(dep, task, succ, (links.get(node_id), succ_instant), node_cal, succ_cal)
        if succ_free is not None:
            dep = _milestone_link(dep)
        own = instants.get(node_id)
        own_instant = None if own is None else own[0]
        own_link = links.get(node_id, own)
        if succ_free is None:
            # A work successor is measured from the working day its start sits at,
            # not the raw date (#4332). The only early start that can fall on a
            # non-working day is a live task's verbatim ``actual_start`` (ADR-0132
            # §2), and a Saturday start is the same working-time position as the
            # Monday after it — total float already counts it that way, giving
            # zero working days from Saturday to Monday. Inverting from the raw
            # Saturday instead retreated an SS link to the Friday before, so a
            # predecessor whose link imposes Friday read zero slack and was
            # reported as the driver, although its slip to Monday leaves the
            # successor's working-time start and its finish where they are — the
            # actual start is what holds the task, and the predecessor kept the
            # day of total float that proved it. Every inversion in
            # :func:`_link_slack` assumes a working-day reference, as the late
            # dates the backward pass feeds the same formulas always are; the
            # snap is the identity for every other successor.
            refs = raw_refs = (_next_working_day(succ.early_start, succ_cal), succ.early_finish)
        else:
            # The free-float instant a lagged milestone successor is measured at
            # (#4180) is the baseline both the slack and the driving-edge check use.
            raw_refs = _milestone_refs(succ_free)
            # A tie that flips the milestone's reading moves it (#4183), layered on
            # top of that free instant. The two adjustments never both act on the
            # same instant: #4180 only advances one that reads as start of day, and
            # #4183's tie bound only adjusts one that reads as end of day.
            assert succ_instant is not None  # free_instants mirrors instants' domain
            start_ref = _free_start_ref(
                (succ_free, succ_instant[1]), dep.dep_type, dep.lag, own_link, succ_cal
            )
            refs = (start_ref, raw_refs[1])
        slack = _link_slack(dep, task, refs, own_instant, node_cal, wd_counter, calendar)
        if not _start_fixed_link(task, dep):
            # A link measured from a recorded start (#4523) limits nothing this
            # task's remaining work can do; it is still checked for driving below.
            ff_days = min(ff_days, max(0, slack))
        # Whether a link *drives* is read off the free instant, not #4183's further
        # tie adjustment: a link bounded only by a reading tie does not set the
        # milestone's instant, another link does, so it is not the milestone's
        # driving predecessor even at zero free float.
        if refs != raw_refs:
            slack = _link_slack(dep, task, raw_refs, own_instant, node_cal, wd_counter, calendar)
        if slack == 0 or binds:
            driving_edges.append(DrivingEdge(node_id, succ_id, label))
    return ff_days


def _link_binds(
    dep: Dependency,
    task: Task,
    succ: Task,
    instants: tuple[_Instant | None, _Instant | None],
    node_cal: Calendar,
    succ_cal: Calendar,
) -> bool:
    """Whether ``dep`` imposes exactly the successor's early position (#4704).

    The forward pass's own proposal for the link, compared with what it bounds.
    Into work, that is the bound :func:`_forward_edge_constraints` snaps on the
    successor's calendar, against the early start for FS/SS and the early finish
    for FF/SF. Into a milestone, it is the ``(instant, start_display)`` the link
    proposes (:func:`_milestone_proposal`) against the one the milestone is shown
    at, which is the latest proposal :func:`_place_milestone` received. This is
    the "binding" test :func:`trueppm_scheduler.derive.derive_value` applies.

    Zero relationship free float alone misses such a link whenever the
    predecessor's slip and the successor's position are measured in different
    working time: a seven-day predecessor finishing on a Friday into a
    Monday-to-Friday successor reads two days of slack (its Saturday and Sunday),
    and a calendar-day lag that lands on a weekend reads the days its slip stays
    inside that weekend (#4537). Either way the link alone places the successor.

    ``instants`` is ``(own_link, succ_shown)``: this task's link instant when it
    is a milestone (the one its successors measure from) and the successor's
    shown instant when it is a milestone; ``None`` for work.
    """
    assert task.early_finish is not None
    assert succ.early_start is not None and succ.early_finish is not None
    own_link, succ_shown = instants
    if succ_shown is not None:
        proposal = _milestone_proposal(
            dep.dep_type,
            dep.lag,
            _link_start(task),
            task.early_finish,
            own_link,
            node_cal,
            succ_cal,
        )
        return proposal == succ_shown
    anchor = _edge_anchor(
        dep.dep_type,
        _link_start(task),
        task.early_finish,
        None if own_link is None else own_link[0],
        node_cal,
        dep.lag,
    )
    bound = _advance_calendar_days(anchor, dep.lag, succ_cal)
    target = succ.early_start if dep.dep_type in _START_ANCHORED else succ.early_finish
    return bound == target


def _link_slack(
    dep: Dependency,
    task: Task,
    succ_refs: tuple[date, date],
    instant: date | None,
    node_cal: Calendar,
    wd_counter: _WorkingDayCounter | None,
    calendar: Calendar,
) -> int:
    """Slip this task can absorb on one link without moving the successor's early date.

    Computed by **inverting** the forward constraint — the same inversion the
    backward pass applies for late dates — but anchored on the successor's *early*
    dates, which is exactly what makes the result free float rather than total float.

    The earlier version instead measured the working-day gap between the *forward*-
    imposed date and the successor's early date. That proxy assumes one working day
    of slip moves the imposed date by one working day, which fails whenever a
    calendar-day lag re-lands across non-working days as the task slips: a single
    working day of slip can jump the imposed date by several working days (or none),
    so the proxy both over- and under-counted the true slack (#1828).

    ``succ_refs`` is a work successor's ``(early_start, early_finish)`` with the start
    snapped to the working day it sits at (#4332, see :func:`_free_float_days`), or a milestone
    successor's references at its free-float instant (:func:`_milestone_refs` of
    :func:`_milestone_free_instants`); ``instant`` is
    this task's own early instant when it is a milestone (#4079), whose slip is
    measured between instants.
    """
    assert task.early_start is not None and task.early_finish is not None
    succ_start, succ_finish = succ_refs
    lag = dep.lag

    if instant is not None:
        latest = _milestone_latest(dep.dep_type, lag, succ_start, succ_finish, node_cal)
        if latest < instant:
            return -_wd_span(latest, instant, node_cal, wd_counter, calendar)
        return _wd_span(instant, latest, node_cal, wd_counter, calendar)
    if dep.dep_type == DependencyType.FS:
        # Latest finish that leaves succ.early_start unmoved (inverse of the
        # forward FS constraint; matches the backward pass's LF retreat).
        latest = _prev_working_day(_safe_offset(succ_start, -timedelta(days=1) - lag), node_cal)
        return _wd_span(task.early_finish, latest, node_cal, wd_counter, calendar)
    if dep.dep_type == DependencyType.SS:
        # Measured from the start the link anchors on (#4523, :func:`_link_start`).
        # For a recorded start only the zero test for a driving edge reads the
        # result (:func:`_free_float_days`); for a derived start it also limits
        # free float, because that start slips with the remaining work.
        latest = _retreat_calendar_days(succ_start, lag, node_cal)
        return _wd_span(_link_start(task), latest, node_cal, wd_counter, calendar)
    if dep.dep_type == DependencyType.FF:
        latest = _retreat_calendar_days(succ_finish, lag, node_cal)
        return _wd_span(task.early_finish, latest, node_cal, wd_counter, calendar)
    # SF: the successor's finish is bounded by the working day before this task's
    # start, so the latest start is one working day past the retreated bound (#4145);
    # with a positive lag, by the day before it (#4333, :func:`_sf_latest_start`).
    latest = _sf_latest_start(succ_finish, lag, node_cal)
    return _wd_span(_link_start(task), latest, node_cal, wd_counter, calendar)
