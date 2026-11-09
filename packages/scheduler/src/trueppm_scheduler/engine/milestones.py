"""Zero-duration milestones as instants (#4079); see the :mod:`~trueppm_scheduler.engine` notes."""

from __future__ import annotations

from collections.abc import (
    Callable,
)
from dataclasses import (
    replace,
)
from datetime import (
    date,
    timedelta,
)

import networkx as nx

from trueppm_scheduler.engine.calendar_math import (
    _effective_duration_days,
    _finish_from_start,
    _is_complete,
    _next_working_day,
    _prev_working_day,
    _safe_offset,
    _scan_for_working_day,
)
from trueppm_scheduler.models import (
    Calendar,
    Dependency,
    DependencyType,
    Task,
)

# ---------------------------------------------------------------------------
# Zero-duration milestones as instants (#4079) — see the module docstring
# ---------------------------------------------------------------------------

_ONE_DAY = timedelta(days=1)


_START_ANCHORED = (DependencyType.FS, DependencyType.SS)
"""Dependency types whose successor constraint bounds the successor's *start*."""


_FROM_PREDECESSOR_FINISH = (DependencyType.FS, DependencyType.FF)
"""Dependency types measured from the predecessor's *finish*, not its start."""


_Instant = tuple[date, bool]
"""A milestone's position: ``(instant, start_display)``.

``instant`` is the midnight the milestone sits on — the end of one day is the
start of the next — and is the only thing links measure from. ``start_display``
only chooses how it is shown: at the start of the instant's own day (a milestone
held by a floor or an SS link from work) or at the end of the previous working
day (a milestone that follows work, when that day is a working day — see
:func:`_start_reading`).
"""


def _edge_anchor(
    dep_type: DependencyType,
    start: date,
    finish: date,
    instant: date | None,
    pred_cal: Calendar,
    lag: timedelta = timedelta(0),
) -> date:
    """The raw date a predecessor's constraint on its successor is measured from.

    Every forward constraint is ``_next_working_day(anchor + lag)`` on the
    successor's calendar; only the anchor depends on the dependency type and on
    whether the predecessor is a milestone. For ordinary work (``instant`` is
    ``None``) FS measures from the day after the inclusive finish, SS from the
    start, FF from the finish, and SF from the last working day *before* the start
    (from ``start - 1`` with a positive lag, #4333). Callers pass the start an SS/SF
    link measures from (:func:`_link_start`): a started task's recorded
    ``actual_start``, never its data-date-floored remaining window (#4523).

    A milestone is one instant, so its start and its finish are the same point:
    FS and SS measure from the instant itself, SF from the last working day
    before it (from ``instant - 1`` with a positive lag). This is what lets a
    milestone sit on its driving predecessor's finish without delaying anything
    behind it.

    FF out of a milestone (#4273) is a finish link measured from the instant
    itself, the same point FS measures from. With no lag there is no date to snap,
    so the successor only has to reach the instant in working time — the last
    working day before it. A positive lag counts forward from the day the instant
    closes, ``instant - 1``, which is a non-working day when the instant opens a
    working day after a weekend, and the result snaps forward like any lagged FF
    (#2534). Anchoring a positive lag on the last working day as well (the
    pre-#4273 rule) let a weekend absorb it: ``M`` at the start of Monday
    ``-FF+2d->`` finished its successor on Monday, where the same lag from ``M``'s
    instant reaches Tuesday.

    A lead counts back from the zero-lag anchor, the last working day before the
    instant, so the successor's finish is monotone in the lag: ``M`` at the start
    of Monday ``-FF-1d->`` finishes it Thursday, a day before zero lag's Friday.
    Counting a lead from ``instant - 1`` instead put a weekend between the lead and
    the working day it should reach — ``-1d`` landed on Saturday and snapped
    forward to Monday, *later* than zero lag. Links *into* a milestone do not come
    through here (:func:`_milestone_proposal`).

    SF (#4145) is the finish-anchored rule applied to the predecessor's *start*
    instant, which is why the two branches agree: MS Project and P6 finish an SF
    successor at the start of its predecessor's start day, so its last working day
    is the day before — exactly where a zero-duration milestone standing at that
    same midnight puts it. Anchoring on the start day itself (the pre-#4145
    behavior) scheduled the successor one working day later than either.

    That makes SF the FF-out-of-a-milestone rule above, whether the predecessor is
    work or a milestone, and it takes the same positive-lag branch (#4333): a lag
    counts forward from the day the start instant closes, ``start - 1``, not from
    the last working day before it. A predecessor starting on Monday anchors on
    Sunday, so ``-SF+2d->`` finishes its successor on Tuesday, as MS Project does;
    pre-snapping to Friday (the pre-#4333 rule) put the lag on Sunday, snapped it
    forward to Monday, and let the weekend absorb it. Zero lag and leads keep the
    last working day before the start, so the finish stays monotone in the lag.
    """
    if instant is None:
        if dep_type == DependencyType.FS:
            return _safe_offset(finish, _ONE_DAY)
        if dep_type == DependencyType.FF:
            return finish
        if dep_type == DependencyType.SS:
            return start
        # SF: the predecessor's start instant is the midnight its start day opens
        # on, so fall through to the finish-anchored rule below with that instant.
        instant = start
    if dep_type in _START_ANCHORED:
        return instant
    if lag > timedelta(0):
        # FF out of a milestone, or SF from anything (#4273, #4333).
        return _safe_offset(instant, -_ONE_DAY)
    return _prev_working_day(_safe_offset(instant, -_ONE_DAY), pred_cal)


def _start_is_recorded(task: Task) -> bool:
    """Whether ``task`` is live work whose start is a recorded fact (#4523).

    True for a task with work that is not complete and carries an
    ``actual_start``. Its ``early_start`` is the start of its *remaining* work
    (ADR-0132), floored at the data date and at its other floors, so it moves with
    every status update; the start itself happened on ``actual_start`` and does
    not. A completed task is pinned at its actuals already (ADR-0136) and a
    milestone is placed as an instant, so neither needs the distinction.
    """
    return task.actual_start is not None and task.duration.days > 0 and not _is_complete(task)


def _elapsed_link_days(task: Task) -> int:
    """Working days of ``task``'s span before its remaining-work window (#4523).

    Non-zero only for live work with progress and no recorded ``actual_start``
    (:func:`_start_is_recorded` covers the recorded case): its span start
    (``scheduled_start``, ADR-0752) is the full duration backed off from
    ``early_finish``, which is exactly this many working days before
    ``early_start``. Zero for everything else, where the span start *is* the early
    start.
    """
    if task.actual_start is not None or task.duration.days <= 0 or _is_complete(task):
        return 0
    return task.duration.days - _effective_duration_days(task)


def _link_start(task: Task) -> date:
    """The start an SS or SF link out of ``task`` measures from (ADR-0132 §2a, #4523).

    When the task started, or is forecast to have started — never where its
    remaining work resumes: the recorded ``actual_start`` of a started task
    (:func:`_start_is_recorded`), at any ``percent_complete`` — at 0% its bar
    (``scheduled_start``) still starts at ``early_start``, so this is not always the
    bar start; for live work with progress but no recorded start, its derived span
    start ``scheduled_start`` (:func:`_elapsed_link_days`); otherwise
    ``early_start``. Measuring from the remaining-work window instead
    re-added the link's lag from the data date on every status update: ``A``
    started 03-02 ``-SS+10d-> B`` put ``B`` on 03-16 at a 03-04 data date and two
    days later at a 03-06 one, with nothing else changed. ``early_start`` is never
    before either start for a live task, so they agree whenever nothing but
    the start holds the task.

    ``scheduled_start`` is read off the task, so this is only called after the
    forward pass resolved it (:func:`_compute_scheduled_start`), as every caller
    does.
    """
    assert task.early_start is not None
    if _start_is_recorded(task):
        assert task.actual_start is not None
        return task.actual_start
    if _elapsed_link_days(task) > 0:
        assert task.scheduled_start is not None
        return task.scheduled_start
    return task.early_start


def _start_fixed_link(task: Task, dep: Dependency) -> bool:
    """Whether ``dep`` out of ``task`` measures from a recorded start (#4523).

    Such a link cannot be moved by ``task``'s remaining work slipping, so it
    imposes no late-date bound on ``task`` and gives it no free-float limit; it is
    still the driving edge of a successor it holds. A link measured from a
    *derived* span start (:func:`_elapsed_link_days`) is not one: that start is
    backed off from the forecast finish and slips with the remaining work, so it
    keeps its bound (:func:`_window_start_bound`).
    """
    return dep.dep_type in (DependencyType.SS, DependencyType.SF) and _start_is_recorded(task)


def _window_start_bound(span_bound: date, task: Task, cal: Calendar) -> date:
    """The latest ``early_start`` that keeps ``task``'s link start at or before ``span_bound``.

    The backward inverse of :func:`_link_start` for a derived span start (#4523):
    the span start sits :func:`_elapsed_link_days` working days before the
    remaining-work window, so a bound on the one is that many working days later
    on the other. ``span_bound`` is always a working day on ``cal`` (every backward
    bound is snapped), and on working days the two helpers are inverses. The
    identity when nothing has elapsed.
    """
    elapsed = _elapsed_link_days(task)
    if elapsed <= 0:
        return span_bound
    return _finish_from_start(span_bound, elapsed + 1, cal)


def _milestone_link(dep: Dependency) -> Dependency:
    """``dep`` as a zero-duration successor sees it: FF is FS (#4272, #4273).

    A milestone's start and finish are one instant, so a link that bounds its
    finish and one that bounds its start bound the same point. FF and FS also
    anchor on the same point of the predecessor — its finish instant, or a
    milestone predecessor's own instant (:func:`_edge_anchor`) — so into a
    milestone they are the same link, and every pass treats them as one. SF keeps
    its own anchor (the close of the working day before the predecessor's start).
    """
    if dep.dep_type == DependencyType.FF:
        return replace(dep, dep_type=DependencyType.FS)
    return dep


def _milestone_proposal(
    dep_type: DependencyType,
    lag: timedelta,
    start: date,
    finish: date,
    pred_instant: _Instant | None,
    pred_cal: Calendar,
    cal: Calendar,
) -> _Instant:
    """The ``(instant, start_display)`` one incoming link proposes to a milestone.

    The proposal is the link's anchor *instant* plus the lag, never snapped: a
    milestone occupies no working day, so there is nothing for a lag to land on
    but the instant itself (#4272). FS/SS — and FF, which into a milestone is FS
    (:func:`_milestone_link`) — propose ``anchor + lag``; SF proposes the midnight
    closing its anchor day, plus the lag. This is what makes ``A -FF+1d-> M`` and
    ``A -FS+1d-> M`` land ``M`` on the same instant. Before #4272 an FF/SF link
    proposed the end of the first working day on or after ``anchor + lag``, as if
    the milestone had a finish day to snap, so a lag across a weekend put ``M`` a
    working day after its FS equivalent and moved everything behind it.

    The reading is the FS/SS-from-work one — end of day, start of day after SS —
    except at zero lag out of a milestone, where the proposal is the very midnight
    the predecessor occupies and carries its reading over (#4079); an instant just
    after non-working time always reads as start of day (:func:`_start_reading`,
    #4173). ``cal`` is the milestone's own calendar.
    """
    if dep_type == DependencyType.FF:
        dep_type = DependencyType.FS  # one link into a milestone (_milestone_link)
    instant = None if pred_instant is None else pred_instant[0]
    anchor = _edge_anchor(dep_type, start, finish, instant, pred_cal, lag)
    if dep_type == DependencyType.SF:
        # The close of the anchor day: the working day before the start, or with a
        # positive lag the day the start instant closes, so the proposal is the
        # start instant plus the lag (#4333).
        raw = _safe_offset(_safe_offset(anchor, _ONE_DAY), lag)
        return raw, _start_reading(raw, False, cal)
    raw = _safe_offset(anchor, lag)
    if pred_instant is not None and lag == timedelta(0):
        # Same midnight as the predecessor milestone (#4079): its own reading
        # carries over verbatim.
        base_display = pred_instant[1]
    else:
        # Ordinary work, or a milestone predecessor reached through a nonzero lag:
        # a different midnight than the predecessor's own instant, so its reading
        # is computed fresh rather than inherited (#4079 fuzz regression) —
        # inheriting it would let a display quirk of the predecessor's instant
        # (the Sunday/Monday snap, #4173) leak into an instant it has nothing to
        # do with.
        base_display = dep_type == DependencyType.SS
    return raw, _start_reading(raw, base_display, cal)


def _instant_day(instant: date, start_display: bool, cal: Calendar) -> date:
    """The day an instant is shown on.

    A start-of-day reading is shown on the first working day at or after the
    instant (the start of Monday for Saturday midnight); an end-of-day reading on
    the last working day before it (the end of Friday).
    """
    if start_display:
        return _next_working_day(instant, cal)
    return _prev_working_day(_safe_offset(instant, -_ONE_DAY), cal)


def _start_reading(instant: date, start_display: bool, cal: Calendar) -> bool:
    """Whether an instant proposed by a start-anchored link reads as a day start.

    An end-of-day reading names the end of the working day before the instant,
    which only exists when that day *is* a working day. A lag that lands the
    instant just after non-working time (Sunday or Monday midnight, after a
    weekend) sits in non-working time, and it is shown the way MS Project snaps an
    elapsed lag there: at the start of the next working day (#4173).

    This is what keeps the shown day monotone in the instant. Sunday and Monday
    midnight are the same working-time position; read at the end of the previous
    working day, the later midnight was shown on Friday while the earlier one, read
    at the start of the next, was shown on Monday — so a *longer* predecessor moved
    a milestone, and with it ``project_finish``, a working day *earlier*, and
    Monte Carlo reported P50 before the deterministic finish.
    """
    return start_display or not cal.is_working_day(_safe_offset(instant, -_ONE_DAY))


def _milestone_refs(instant: date) -> tuple[date, date]:
    """``(start_ref, finish_ref)`` a milestone successor offers its predecessors.

    The backward pass and free float invert each forward constraint as
    ``anchor + lag <= ref``, against a successor's start for FS/SS links and its
    inclusive finish for SF ones (FF into a milestone is FS, :func:`_milestone_link`).
    A link into a milestone proposes the raw instant ``anchor + lag`` (FS/SS) or
    ``anchor + 1 + lag`` (SF, whose anchor is an inclusive day), so the references
    are the instant itself and the day it closes — *unsnapped*, because the
    proposal is never snapped either (#4272). Snapping the finish reference back to
    a working day inverted the pre-#4272 rule, which snapped the proposal forward.
    """
    return instant, _safe_offset(instant, -_ONE_DAY)


def _milestone_free_instants(
    topo_order: list[str],
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    instants: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, date]:
    """The latest instant each milestone may reach without moving anything (#4180).

    Free float asks how far a predecessor can slip before a successor moves, and a
    milestone's early position is its shown day plus its reading, not the raw
    instant. A start-of-day reading is shown on ``next_wd(instant)``, and every
    midnight from the instant up to that one lies in the same stretch of
    non-working time, with the same shown day and reading. So
    ``A(4d) -FS+2d-> M`` (Sunday midnight, shown Monday) lets ``A`` slip one day to
    Monday midnight without moving ``M``: one day of free float, not zero.

    An end-of-day reading stays at the raw instant: ``A -FS+1d-> M`` puts ``M`` at
    Saturday midnight shown Friday, and the next midnight is shown Monday (#4173).
    This is the free-float twin of :func:`_milestone_finish_bound`.

    The raw instant is still what the milestone's own links measure from, and a
    calendar-day lag carries it downstream (``M -FS+1d-> N`` proposes Monday
    midnight from Sunday, Tuesday midnight from Monday). So the stretch is also
    capped by every live successor link, inverted with :func:`_milestone_latest`
    against that successor's early references — its own free instant when it is
    a milestone, which is why this runs in reverse topological order. Moving the
    instant anywhere up to the result moves nothing downstream.

    A milestone held up by the project-start floor alone (#4225) is shown at the
    floor but measured from by its successors at its earlier link instant
    (``link_instants``, :func:`_place_milestone`). Its stretch runs from that link
    instant — the one a predecessor's slip moves — up to the same shown-day bound
    and successor caps, so its predecessors see the slack the direct link gives them.

    A successor that is itself a milestone is reached through the same reading-tie
    bound :func:`_free_float_days` applies to ordinary work (:func:`_free_start_ref`,
    #4183) — not just :func:`_milestone_latest` against its raw free instant
    (#4329). Without it, this bound can overstate how far *this* milestone's own
    instant may travel: pushing it up to that successor's raw free instant can flip
    the successor's reading from the end-of-day instant another, unrelated,
    predecessor already occupies to a start-of-day one at the very same raw
    instant — and a start-of-day proposal always outranks an end-of-day one at a
    tie (:func:`_place_milestone`), so the successor's *shown day* moves even
    though its raw free instant, taken alone, did not. Capping at the tie-adjusted
    reference keeps this milestone's own stretch inside the range that leaves every
    live successor's shown position — not just its raw instant — untouched.
    """
    links = link_instants or {}
    free: dict[str, date] = {}
    for node_id in reversed(topo_order):
        early = instants.get(node_id)
        if early is None:
            continue
        instant, start_display = early
        own_link = links.get(node_id, early)
        link = own_link[0]
        cal = cal_for(node_id)
        if not start_display:
            free[node_id] = instant
            continue
        bound = _next_working_day(instant, cal)
        for succ_id in g.successors(node_id):
            succ = task_map[succ_id]
            if _is_complete(succ):
                continue
            dep: Dependency = g[node_id][succ_id]["dep"]
            succ_free = free.get(succ_id)
            if succ_free is None:
                assert succ.early_start is not None and succ.early_finish is not None
                # The same working-day snap _free_float_days reads a work successor
                # at (#4332): a live task's verbatim non-working actual_start is the
                # working-time position of the next working day, so capping from the
                # raw date ends this milestone's stretch early (#4345).
                refs = (_next_working_day(succ.early_start, cal_for(succ_id)), succ.early_finish)
            else:
                dep = _milestone_link(dep)
                succ_cal = cal_for(succ_id)
                raw_refs = _milestone_refs(succ_free)
                succ_instant = instants.get(succ_id)
                assert succ_instant is not None
                start_ref = _free_start_ref(
                    (succ_free, succ_instant[1]), dep.dep_type, dep.lag, own_link, succ_cal
                )
                refs = (start_ref, raw_refs[1])
            bound = min(bound, _milestone_latest(dep.dep_type, dep.lag, *refs, cal))
        free[node_id] = max(link, bound)
    return free


def _milestone_latest(
    dep_type: DependencyType,
    lag: timedelta,
    start_ref: date,
    finish_ref: date,
    node_cal: Calendar,
) -> date:
    """Latest instant a milestone may sit on and still honor one successor link.

    The inverse of :func:`_edge_anchor` for a milestone predecessor: the largest
    instant ``X`` whose forward bound does not pass the successor's reference. A
    start-anchored link measures from ``X`` itself; a finish-anchored one from
    ``prev_wd(X - 1)``, which stays at or before ``W`` for every ``X`` up to the
    first working day after ``W``.

    An FF or SF with a positive lag measures from ``X - 1`` itself (#4273, #4333),
    so its inverse is the raw ``W + 1 - lag``; a lead measures from
    ``prev_wd(X - 1)`` like zero lag and inverts through the finish-anchored
    branch. FF reaches this only from a successor with work: into a milestone it is
    FS (:func:`_milestone_link`), and the caller converts it.
    """
    if dep_type in _START_ANCHORED:
        return _safe_offset(start_ref, -lag)
    if lag > timedelta(0):
        return _safe_offset(finish_ref, _ONE_DAY - lag)
    last = _prev_working_day(_safe_offset(finish_ref, -lag), node_cal)
    return _scan_for_working_day(last, node_cal, forward=True)


def _sf_latest_start(succ_finish: date, lag: timedelta, node_cal: Calendar) -> date:
    """Latest start day an ordinary task may take without moving an SF successor's finish.

    The inverse of :func:`_edge_anchor`'s SF anchor for ordinary work (#4145). The
    forward bound is measured from ``prev_wd(start - 1)``, so inverting
    ``next_wd(anchor + lag) <= W`` gives the largest allowed anchor
    ``A = prev_wd(W - lag)`` — and the largest *start day* whose anchor is still at
    or before ``A`` is the first working day after ``A``, since any later start day
    would drag the anchor past it.

    This is deliberately the same expression as :func:`_milestone_latest`'s
    finish-anchored branch: a start instant and a milestone instant invert
    identically, which is the consistency #4145 restored.

    A positive lag measures from ``start - 1`` itself (#4333), so the forward bound
    is ``next_wd(start - 1 + lag) <= W``, which holds exactly when
    ``start <= W + 1 - lag``; the latest start is the last working day at or
    before that — :func:`_milestone_latest`'s positive-lag branch, snapped to a day
    this task can start on.
    """
    if lag > timedelta(0):
        return _prev_working_day(_safe_offset(succ_finish, _ONE_DAY - lag), node_cal)
    last = _prev_working_day(_safe_offset(succ_finish, -lag), node_cal)
    return _scan_for_working_day(last, node_cal, forward=True)


def _milestone_finish_bound(finish_instant: date, project_finish: date, node_cal: Calendar) -> date:
    """Latest instant the project-finish seed admits for a milestone (#4174).

    When the finish instant already reads as start of day — ``project_finish`` is
    on or after it, e.g. ``A(4d) -FS+2d-> M`` placing ``M`` at Sunday midnight,
    shown Monday — every midnight up to the one that opens the next working day
    shows the same finish, so a milestone at any of them does not move it. Seeding
    at the raw instant told that milestone Monday midnight was a slip, which gave
    ``A`` zero float and put it on the critical path.

    When the instant reads as end of day instead (``project_finish`` before it —
    ``A -FS+1d-> M`` at Saturday midnight, shown Friday), the raw instant is the
    bound: under #4173's display rule Sunday midnight is shown Monday, so landing
    there *does* move the finish and the predecessor has no float to give.

    The shown day stays capped at ``project_finish`` by :func:`_late_display`.
    """
    if project_finish >= finish_instant:
        return _next_working_day(finish_instant, node_cal)
    return finish_instant


def _start_read_cap(
    instant: date, start_display: bool, cal: Calendar, project_finish: date
) -> date:
    """Latest instant up to ``instant`` that a given reading shows by ``project_finish`` (#4183).

    A milestone's late instant is the latest midnight its successors and the
    finish seed admit, but the day it is *shown* on also depends on its reading
    (:func:`_start_reading`). When the project ends at the end of a day (``W``
    finishing Friday: finish instant Saturday midnight, ``project_finish``
    Friday), a milestone at Saturday midnight read as end of day is shown Friday,
    but read as start of day it is shown Monday and moves ``project_finish``. So a
    start-of-day reading is capped at the last working day ``D`` on or before
    ``project_finish``, the latest midnight it still shows by then. With a
    start-of-day finish (``project_finish`` on or after the instant, #4174) the
    cap never binds.

    An end-of-day reading reaches the cap too, when the instant sits just after
    non-working time and so reads as a day start (:func:`_start_reading`) — e.g.
    ``project_finish`` a Sunday (a weekend ``actual_finish``) and the instant the
    Monday midnight after it. Its latest admissible instant is ``D + 1``, the
    midnight that *closes* ``D``: ``D`` is a working day, so that midnight reads as
    end of day and is shown on ``D``. Capping it at ``D`` cost every FS/SS
    predecessor, and the milestone's own float, one working day, and reported a
    task with one day of float as critical (#4344). A start-of-day reading keeps
    ``D``: at ``D + 1`` it is shown on the next working day, past the finish.
    """
    if not _start_reading(instant, start_display, cal):
        return instant
    if _next_working_day(instant, cal) <= project_finish:
        return instant
    last_day = _prev_working_day(project_finish, cal)
    if start_display:
        return last_day
    # Here ``instant > last_day + 1``: at ``last_day + 1`` the end-of-day reading
    # holds (``last_day`` works), so the first branch would have returned.
    return _safe_offset(last_day, _ONE_DAY)


def _link_start_ref(
    start_ref: date,
    dep_type: DependencyType,
    lag: timedelta,
    pred_is_milestone: bool,
    succ_cal: Calendar,
    project_finish: date,
) -> date:
    """The milestone ``start_ref`` one FS/SS link into it may use (#4183).

    The reading is the one this link would give the milestone
    (:func:`_place_milestone`): start of day after SS from work, end of day after
    FS from work. Measured against the raw late instant, ``X(2d) -SS+3-> M`` beside
    ``W(5d)`` reported two days of float when a two-day slip lands ``M`` on Saturday
    midnight, shown Monday.

    The cap is per link, not on the milestone's late instant itself: an FS
    predecessor of the same milestone really can slip it to Saturday midnight, where
    it is shown Friday, so capping the shared instant would understate its float.

    A zero-lag link from a milestone carries that milestone's reading over, and the
    backward pass computes each milestone's late instant for the end-of-day reading
    (the uncapped one). The start-of-day bound follows from it by the same cap —
    the cap is a ``min``, so it commutes with the ``min`` over successor links — and
    is applied where it is read: :func:`_float_late_instant` for the milestone's own
    float, and this function for an SS or work predecessor reaching it.
    """
    if dep_type not in _START_ANCHORED:
        return start_ref
    inherits = pred_is_milestone and lag == timedelta(0)
    base_display = dep_type == DependencyType.SS and not inherits
    return _start_read_cap(start_ref, base_display, succ_cal, project_finish)


def _link_finish_ref(
    late: date, dep_type: DependencyType, succ_cal: Calendar, project_finish: date
) -> date:
    """The milestone ``finish_ref`` one SF link into it may use (#4431).

    The SF twin of :func:`_link_start_ref`. An SF proposal into a milestone is read
    like FS from work — end of day, or start of day just after non-working time
    (:func:`_milestone_proposal`) — so the latest instant it may propose is
    :func:`_start_read_cap` of the late instant for the end-of-day reading, and the
    reference is the day *that* instant closes (:func:`_milestone_refs`). Inverting
    against the uncapped instant gave an SF predecessor one working day of float
    that, used, showed the milestone past ``project_finish``. Every other type
    inverts against the start reference, so its finish reference is left raw.
    """
    if dep_type != DependencyType.SF:
        return _milestone_refs(late)[1]
    return _milestone_refs(_start_read_cap(late, False, succ_cal, project_finish))[1]


def _float_late_instant(late: date, early: _Instant, cal: Calendar, project_finish: date) -> date:
    """The late instant a milestone's *own* total float is measured to (#4183).

    This *defines* a milestone's own total float: slipping the milestone keeps the
    reading that places it early, so its float stops where that reading would show
    it past ``project_finish`` — the same cap :func:`_link_start_ref` applies to a
    predecessor reaching it with that reading. Predecessors still read the uncapped
    instant (:func:`_late_refs`).

    Why this definition: in the tie case (a start-of-day milestone whose late
    instant is an end-of-day finish instant) it makes ``total_float`` the
    working-day span between the milestone's shown ``early_start`` and its shown
    ``late_start``, the rule the scheduler conventions page states for every task.
    :func:`_late_display` already capped the *shown* late start at
    ``project_finish``; measuring float to the raw instant reported ``M`` with
    early start 01-08, late start 01-09 and total float 2 in the #4183 repro. It is
    **not** needed for insertion invariance: ``A -FS-> M -FS-> B`` scheduling as
    ``A -FS-> B`` asserts nothing about ``M``'s own float and holds either way.

    It is a semantic choice with collateral effects beyond the reported tie: a
    lone start-of-day milestone held by a floor, or one reached by ``X -SF-> M``,
    also reports one day less float when its late instant is the end-of-day finish
    instant, and can now be ``is_critical`` / on ``critical_path`` where it was not.

    It is also **not** a general "float == shown-day span" invariant. The cap only
    reaches a late instant past the last working day of ``project_finish``, i.e.
    the window near the *finish* instant. Elsewhere a milestone can still report a
    float that differs from the span between its shown days: the remaining cases
    seen are a start-of-day milestone whose late instant is a Saturday or Sunday
    midnight before the finish, shown late on the Friday before it while its float
    runs through that Friday. A derandomized sample of 1,500 fuzzed networks during
    review found 43 such milestones left, down from 643 before this change.
    """
    return max(_start_read_cap(late, early[1], cal, project_finish), early[0])


def _free_start_ref(
    succ_early: _Instant,
    dep_type: DependencyType,
    lag: timedelta,
    own: _Instant | None,
    succ_cal: Calendar,
) -> date:
    """The start reference an FS/SS link's free float may run to in a milestone (#4183).

    The free-float face of the same midnight tie. An end-of-day milestone at
    instant ``I`` (``A -FS-> M``, shown the end of Friday for Saturday midnight)
    changes its shown day without its instant moving when a start-of-day proposal
    reaches ``I``: two proposals at one midnight resolve to the start-of-day
    reading (:func:`_place_milestone`), so ``M`` flips to the start of Monday. Its
    ``early_start`` moves, and so does the reading any zero-lag milestone after it
    inherits. Inverting such a link against ``I`` itself counted that flip as free.

    So when this link would read ``I`` as start of day, computed exactly as
    :func:`_place_milestone` reads it (SS from work, a lagged SS from a milestone,
    or a zero-lag link carrying a start-of-day predecessor milestone's reading),
    the latest proposal that leaves ``M`` alone is one day before ``I``. An FS link
    from work, or any link into a milestone already read as start of day, keeps
    ``I``: a tie there changes nothing. The slipping predecessor milestone keeps
    its early reading, as :func:`_float_late_instant` assumes for total float.
    """
    instant, start_display = succ_early
    if start_display or dep_type not in _START_ANCHORED:
        return instant
    if own is not None and lag == timedelta(0):
        base_display = own[1]
    else:
        base_display = dep_type == DependencyType.SS
    if not _start_reading(instant, base_display, succ_cal):
        return instant
    return _safe_offset(instant, -_ONE_DAY)


def _late_display(
    late_instant: date, task: Task, early: _Instant, cal: Calendar, project_finish: date
) -> date:
    """The day a milestone's late instant is shown on.

    A late instant at the same working-time position as the early one is zero
    float and is shown on the early day — this also keeps a milestone floored at a
    non-working actual (a Saturday ``actual_start``) a single point. Otherwise the
    milestone is shown the way it is shown early, except that a start-of-day
    reading is never shown past the project finish: the latest instant is often
    the end of the finish day, which is shown as that day.
    """
    assert task.early_start is not None
    if _next_working_day(late_instant, cal) == _next_working_day(early[0], cal):
        return task.early_start
    if early[1] and cal.is_working_day(late_instant) and late_instant <= project_finish:
        return late_instant
    return _prev_working_day(_safe_offset(late_instant, -_ONE_DAY), cal)


def _finish_instant(task_map: dict[str, Task], instants: dict[str, _Instant]) -> date:
    """The instant the project ends: the latest task finish, milestones as instants.

    ``project_finish`` is a *day* — the latest ``early_finish`` — and a milestone at
    the start of that day ends the project at its start, not its end. Seeding late
    dates at the end of the finish day would give the work before it a day of
    float it does not have.
    """
    latest: date | None = None
    for tid, t in task_map.items():
        assert t.early_finish is not None
        own = instants.get(tid)
        end = _safe_offset(t.early_finish, _ONE_DAY) if own is None else own[0]
        latest = end if latest is None or end > latest else latest
    assert latest is not None
    return latest


def _place_milestone(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    es_floors: list[date],
    links: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    start_floor: date | None = None,
    completed_only: bool = False,
) -> tuple[_Instant, date, _Instant]:
    """Place a zero-duration task as an instant: ``(shown, day, link)``.

    ``shown`` is ``(instant, start_display)``, the position the milestone is shown at
    on ``day``; ``link`` is the instant its own successors measure from, read off
    ``links`` for each predecessor milestone in turn.

    Each floor and each incoming link proposes an instant, and the latest wins:

    * floors (project start, data date, SNET, a recorded actual start) propose the
      start of their day, shown on that day;
    * FS/SS links propose ``anchor + lag`` (:func:`_edge_anchor`) — shown at the end
      of the previous working day after FS from work, at the start of the day after
      SS from work, and — only at zero lag, where the proposed instant is the very
      same midnight the predecessor milestone occupies — the way that predecessor is
      shown; a *lagged* link out of a milestone proposes a different midnight and
      falls back to the FS/SS-from-work rule, or the composed lag would inherit a
      display quirk (Sunday/Monday snapping, #4173) that belongs to the
      predecessor's own instant and not to this one (#4079 fuzz regression). Every
      case is subject to the same override: an instant just after non-working time
      is always shown at the start of the next working day (:func:`_start_reading`,
      #4173);
    * FF links propose exactly what FS would (:func:`_milestone_link`), and SF links
      the midnight closing their anchor day plus the lag, read like FS from work —
      raw instants, never snapped to a working day (#4272,
      :func:`_milestone_proposal`).

    Two proposals at the same midnight resolve to the start-of-day reading, so a
    milestone floored at the data date or an SNET day is never shown before it.
    Because the instant is a raw midnight and never rounded, lags compose through a
    milestone exactly as they would without it.

    The **project-start floor** (``start_floor``) only places the milestone where it
    is *shown* (#4225). ``es_floors`` holds the others — data date, SNET, a recorded
    actual start — which are facts about when the milestone can happen, so they bind
    ``link`` as well. A data date at or before the project start is not among them,
    nor is such an SNET unless the milestone is SF-linked (:func:`_floor_above_start`,
    #4635): it is the project-start floor, and binding ``link`` with it measured every
    successor's lag from before the plan opened. The project start is a display
    bound: nothing is shown before the plan opens, but every successor carries that
    same floor itself, so a milestone held at it by the floor alone has nothing to
    add downstream. Measuring
    a successor's lag from the floored instant instead made the milestone a node
    that moved its successor: with ``A`` placed before the project start (an
    SF-linked task, #4218, or a negative lag), ``A -FS(2cd)-> B`` and
    ``A -FS-> M -FS(2cd)-> B`` put ``B`` a working day apart. ``link`` is therefore
    the latest proposal *without* the project-start floor, and ``shown`` with it —
    the same raw-versus-shown split :func:`_start_reading` keeps for a display-only
    snap (#4173). When nothing but the project-start floor proposes, the two are
    the same instant.

    A floor that only ties a link in working time does not move ``link`` either
    (#4690, :func:`_equivalent_link`): when the latest floor is the very day the
    latest link proposal is shown on, at its start, ``link`` stays the proposal's
    raw midnight and only ``shown`` takes the floor. Recording or pinning the day a
    milestone is already shown on — an ``actual_start``, or a ``planned_start`` —
    is such a floor, and linking from it moved every successor with a calendar-day
    lag: ``A -FS+1d-> M`` puts ``M`` at Sunday 00:00, shown at the start of Monday,
    and a Monday floor measured ``M -FS+1d-> B`` from Monday instead, a working day
    later.

    ``completed_only`` limits the links to completed predecessors — the reading a
    closed milestone's day edge is taken from (:func:`_live_milestone_edge`, #4525),
    and the instant it links from (:func:`_closed_milestone_link`, #4690).
    """
    best: tuple[date, bool, date] | None = None
    pred_best: tuple[date, bool, date] | None = None

    def offer(candidate: tuple[date, bool, date]) -> None:
        nonlocal best
        if best is None or candidate[:2] > best[:2]:
            best = candidate

    for floor in es_floors:
        offer((floor, True, floor))

    for pred_id in g.predecessors(node_id):
        pred = task_map[pred_id]
        if completed_only and not _is_complete(pred):
            continue
        dep: Dependency = g[pred_id][node_id]["dep"]
        assert pred.early_start is not None and pred.early_finish is not None
        raw, start_display = _milestone_proposal(
            dep.dep_type,
            dep.lag,
            _link_start(pred),
            pred.early_finish,
            links.get(pred_id),
            cal_for(pred_id),
            cal,
        )
        proposal = (raw, start_display, _instant_day(raw, start_display, cal))
        offer(proposal)
        if pred_best is None or proposal[:2] > pred_best[:2]:
            pred_best = proposal

    link = best
    if pred_best is not None and _equivalent_link(
        pred_best, max(es_floors) if es_floors else None, start_floor
    ):
        link = pred_best
    if start_floor is not None:
        offer((start_floor, True, start_floor))
    # start_floor is given for every task except an SF-linked one (#4218), and that one
    # has at least one SF link, which offers a candidate.
    assert best is not None
    # `resolved` and `link` both still read as `tuple[...] | None` to SonarPython
    # here: `best` is reassigned via `nonlocal` from inside the `offer()` closure,
    # and its dataflow analysis does not carry this assert's narrowing across that
    # closure boundary — rebinding to a fresh name (`resolved`, #4259) did not clear
    # it either, since `link = best` above captured the same unnarrowed type before
    # the assert ever ran. Genuinely non-Optional below: every call path offers at
    # least one candidate (an `es_floors` entry, a predecessor edge, or
    # `start_floor`) before this line, per the docstring and the `assert` itself.
    resolved = best
    shown = (resolved[0], resolved[1])  # NOSONAR
    if link is None:
        return shown, resolved[2], shown  # NOSONAR
    return shown, resolved[2], (link[0], link[1])  # NOSONAR


def _equivalent_link(
    proposal: tuple[date, bool, date],
    floor: date | None,
    start_floor: date | None,
) -> bool:
    """Whether ``floor`` only ties the link ``proposal`` in working time (#4690).

    ``proposal`` is ``(instant, start_display, day)`` from :func:`_place_milestone`.
    True when, from an earlier midnight, the proposal is shown at the start of
    ``floor`` itself: read as the start of a day and shown on it, or held below
    the project-start floor ``start_floor`` when that is ``floor`` — the
    project-start floor only bounds where a milestone is shown (#4225), at the
    start of its day. Then the floor and the proposal are one working-time point:
    Saturday 00:00, Sunday 00:00 and the start of Monday are where a milestone
    after a weekend can sit, and they differ only in the calendar days a lag out of
    it counts from (#2534). The floor then holds nothing the link does not, so the
    link keeps the proposal's raw midnight and every successor sits where it would
    with no floor at all.

    A proposal shown at the *end* of a day at or after the project start is not
    covered: the floor moves the milestone to another day there, and the
    end-of-day edge has its own round-trip (:attr:`Task.live_day_end_on`, #4433).
    Nor is a floor on a non-working day, such as a weekend ``actual_start``: that
    is shown verbatim on its own day.
    """
    if floor is None or proposal[0] >= floor:
        return False
    if start_floor is not None and (start_floor, True) > proposal[:2]:
        return start_floor == floor
    return proposal[1] and proposal[2] == floor


def _closed_milestone_link(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    links: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    recorded: date,
    start_floor: date | None,
) -> _Instant:
    """The instant a milestone closed at the start of ``recorded`` links from (#4690).

    Closing records the *day* a milestone happened, but its live link instant is a
    raw midnight that can fall before that day's start: ``A -FS+1d-> M`` with ``A``
    finishing on Friday puts ``M`` at Sunday 00:00, shown at the start of Monday
    (#4173). Linking from the recorded Monday instead measured every calendar-day
    lag out of ``M`` from a day later, so marking ``M`` done on the day it was
    shown moved its successors, and the project finish with them.

    The instant is re-read from the facts, the same way the edge is
    (:func:`_live_milestone_edge`): the completed predecessors placed with the
    recorded day as a start-of-day floor. When one of them proposes an earlier
    midnight shown on the recorded day (:func:`_equivalent_link`), that is the
    instant the live milestone linked from, and the closed one keeps it. A
    milestone held by a floor, or with nothing before it, links from the recorded
    day, as it did live.

    Open work is not a fact (#4525): reading its forecast would let a slip of it
    move a closed milestone's successors. So while any predecessor is still open
    the milestone links from the start of its recorded day, as it did before #4690,
    and a lag out of it can count from a different midnight than it did live — the
    open residual (#4740). Linking from the close of the working day before
    instead matched the live instant on some shapes and broke more than it fixed.
    ``start_floor`` is the project-start floor, ``None`` for an SF-linked milestone
    (#4218), as :func:`_place_milestone` takes it.
    """
    if any(not _is_complete(task_map[p]) for p in g.predecessors(node_id)):
        return recorded, True
    _, _, link = _place_milestone(
        node_id, task_map, g, cal, [recorded], links, cal_for, start_floor, completed_only=True
    )
    return link if link[0] < recorded else (recorded, True)
