"""CPM core property invariants prescribed by test-strategy (#3667).

``.claude/skills/test-strategy/SKILL.md`` names three invariants that must hold
for any valid DAG: ``total_float >= 0``, a critical-path task has
``total_float == 0``, and project duration equals the ``early_finish`` of the
last task on the critical path. ``test_contract_fuzz.py`` only ever asserted
``free_float <= total_float`` and ``early_start <= early_finish`` — this module
is the dedicated home for the three invariants above, plus one more that falls
out of the engine's own ``driving_edges`` output.

All four properties reuse ``_plausible_projects``/``_PLAUSIBLE_ANCHOR`` from
``test_contract_fuzz.py`` (imported, not copied) rather than the adversarial
``_projects()`` strategy: an input the engine rejects never produces a
``ScheduleResult`` to check, so only the "reaches the forward pass" generator
is useful here. Where an invariant needs a narrower space than
``_plausible_projects`` provides, the narrowing is defined locally and its
reason is documented on the property that uses it.
"""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta

import pytest
from hypothesis import given

from tests.test_contract_fuzz import _plausible_projects
from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    DrivingEdge,
    Project,
    SchedulerError,
    ScheduleResult,
    Task,
    schedule,
)

pytestmark = pytest.mark.fuzz


# ---------------------------------------------------------------------------
# Invariant 1 & 2: is_critical <=> total_float == 0, and total_float never negative
# ---------------------------------------------------------------------------


@given(project=_plausible_projects())
def test_critical_path_tasks_have_zero_total_float(project: Project) -> None:
    """Every task id in ``result.critical_path`` has ``total_float == 0`` and
    ``is_critical`` set — and the reverse: every ``is_critical`` task appears in
    ``critical_path`` exactly once.

    ``is_critical`` is defined in the engine as ``tf_days == 0 and not
    _is_complete(task)`` (``engine._compute_floats``), and ``critical_path`` is
    built by filtering a topological order down to tasks where ``is_critical``
    is true (``engine.schedule``). Both facts are true **by construction** at
    the single call site that sets them — what this property actually guards
    is that the two independently-maintained representations (a per-task flag
    read by the web float bar, and a list read by the Gantt's critical-path
    overlay) never drift apart, e.g. a future change to one filter condition
    without the other, or a ``critical_path`` built from a stale ``is_critical``
    snapshot. No restriction on the generator is needed: the equivalence holds
    for a completed task too (it is simply excluded from both sides).
    """
    try:
        result = schedule(project)
    except SchedulerError:
        return

    task_map = {t.id: t for t in result.tasks}
    critical_ids = set(result.critical_path)
    flagged_ids = {t.id for t in result.tasks if t.is_critical}

    assert critical_ids == flagged_ids, (
        f"critical_path {sorted(critical_ids)} disagrees with is_critical-flagged "
        f"tasks {sorted(flagged_ids)}"
    )
    assert len(result.critical_path) == len(critical_ids), (
        "critical_path contains a duplicate task id"
    )
    for tid in result.critical_path:
        task = task_map[tid]
        assert task.total_float == timedelta(0), (
            f"{tid}: on critical_path but total_float is {task.total_float}, not zero"
        )
        assert task.is_critical, f"{tid}: on critical_path but is_critical is False"


@given(project=_plausible_projects())
def test_no_negative_total_float(project: Project) -> None:
    """No task in a clean ``schedule()`` return ever has ``total_float < 0``.

    This engine has no hard finish-no-later-than ("deadline") constraint that
    is actually consumed by the CPM pass — ``Task.planned_finish`` round-trips
    but is explicitly documented as reserved-but-inert
    (``models.Task.planned_finish``), so there is no input shape in this
    engine's model that legitimately produces negative float the way an
    external deadline would in a general CPM tool. The invariant is also
    enforced structurally, not just arithmetically: ``_apply_late_dates``
    floors every task's late window at its own early window (``late_finish =
    max(late_finish, early_finish)`` — #3963), and ``_wd_span`` /
    ``_working_days_between`` clamp a negative span to ``0`` on the way into
    ``total_float`` as a second, independent floor. So this property should
    hold for literally any accepted (acyclic, non-degenerate) project — no
    narrowing of ``_plausible_projects`` is applied. A failure here means one
    of those two floors regressed.
    """
    try:
        result = schedule(project)
    except SchedulerError:
        return

    for task in result.tasks:
        assert task.total_float >= timedelta(0), (
            f"{task.id}: total_float {task.total_float} is negative"
        )


# ---------------------------------------------------------------------------
# Invariant 3: project duration == early_finish of the last critical-path task
# ---------------------------------------------------------------------------


def _clear_completion(project: Project) -> Project:
    """Strip every actuals-driven completion signal from ``project``'s tasks.

    ``engine._is_complete`` is ``actual_finish is not None or percent_complete
    >= 100``, and a completed task is force-excluded from ``is_critical`` (and
    therefore ``critical_path``) even when its own ``total_float`` is zero
    (``_compute_floats``: "Completion overrides the zero-float rule" — #1863).
    That override can decouple ``critical_path``'s last entry from the task
    that actually carries ``project_finish``: if the unique task whose
    ``early_finish`` equals ``project_finish`` is complete, it is dropped from
    ``critical_path`` while an upstream, not-yet-complete predecessor (one
    working day short of ``project_finish``) stays critical and ends the list
    instead. That is a real, legitimate scheduling state — not a bug — so
    rather than weakening the invariant this property narrows its input to
    projects with no completed task, where the decoupling cannot arise, and
    says so here instead of silently filtering it out.
    """
    tasks = [
        dataclasses.replace(t, actual_finish=None, percent_complete=min(t.percent_complete, 99.0))
        for t in project.tasks
    ]
    return dataclasses.replace(project, tasks=tasks)


def _task_calendar(project: Project, task: Task) -> Calendar:
    """The calendar the engine schedules ``task`` on: its ``calendar_id`` entry in
    ``project.calendars`` when one resolves, else the project calendar."""
    if task.calendar_id is not None and project.calendars:
        return project.calendars.get(task.calendar_id, project.calendar)
    return project.calendar


def _first_working_day_in(start: date, end: date, cal: Calendar) -> date | None:
    """First working day in ``[start, end)``, or ``None`` if there is none.

    Walks day by day rather than reusing ``engine._working_days_between``, so the
    property does not check the engine against its own span arithmetic. It stops
    at the first working day, so a passing case costs only the non-working run.
    """
    d = start
    while d < end:
        if cal.is_working_day(d):
            return d
        d += timedelta(days=1)
    return None


@given(project=_plausible_projects())
def test_project_duration_equals_last_critical_task_early_finish(project: Project) -> None:
    """``project_finish`` equals the ``early_finish`` of the last task on
    ``critical_path``.

    ``critical_path`` is documented as topologically ordered
    (``ScheduleResult.critical_path``), so its last element has no critical
    successor. A critical task with at least one successor always has at
    least one *critical* successor too — its own zero float is inherited from
    the single tightest downstream path, and that path's next hop cannot
    itself carry slack without contradicting the zero float upstream of it.
    So the last entry is a true sink (no successors at all), and a sink's
    ``late_finish`` is anchored directly on ``project_finish`` by the backward
    pass's base case — critical (``late_finish == early_finish``) therefore
    forces ``early_finish == project_finish`` for that task.

    "Equals" is in working time, not calendar date. ``actual_start`` is a
    recorded fact the engine does not snap, so a milestone can sit on a
    non-working day — a Saturday milestone is the same working-time instant as
    a Monday-start one, carries zero float against a Monday ``project_finish``
    (``total_float`` counts working days in ``[early_start, late_start)``), and
    is legitimately critical while its date is two days short (#4280). So the
    assertion is that no working day on the task's own calendar lies between
    its ``early_finish`` and ``project_finish``: a critical sink that finishes
    one or more working days early still fails.

    Narrowed to projects with no completed task via :func:`_clear_completion`
    — see its docstring for why a completed task can legitimately break this
    without the engine being wrong.

    If ``critical_path`` is ever empty for a non-degenerate, non-completed
    project, that is itself worth knowing about (it should not happen per the
    reasoning above: the global early-finish maximizer, which always exists
    for at least one task, is always a zero-float sink when nothing is
    complete) — so this is asserted rather than skipped.
    """
    # TODO(#4281): a milestone clamped to project start by a negative-lag FS can
    # still end critical_path a working day short — open engine question.
    project = _clear_completion(project)
    try:
        result = schedule(project)
    except SchedulerError:
        return

    assert result.critical_path, "no completed task, yet critical_path is empty"
    task_map = {t.id: t for t in result.tasks}
    last = task_map[result.critical_path[-1]]
    assert last.early_finish is not None
    gap = _first_working_day_in(
        last.early_finish, result.project_finish, _task_calendar(project, last)
    )
    assert gap is None, (
        f"{last.id}: last critical_path entry has early_finish {last.early_finish}, "
        f"a working day ({gap}) short of project_finish {result.project_finish}"
    )


def test_milestone_pinned_to_non_working_day_ends_critical_path_in_working_time() -> None:
    """Pinned counterexample from the nightly deep fuzz run (#4280).

    A Saturday ``actual_start`` milestone and a 17-day task finishing Monday
    are both critical sinks; the milestone ends ``critical_path`` with an
    ``early_finish`` two calendar days — but zero working days — before
    ``project_finish``.
    """
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="t0", name="t", duration=timedelta(days=17), actual_start=date(2027, 1, 1)),
            Task(id="t1", name="t", duration=timedelta(0), actual_start=date(2027, 1, 23)),
        ],
        dependencies=[],
        calendar=Calendar(working_days=0b0011111),
    )
    result = schedule(project)
    task_map = {t.id: t for t in result.tasks}
    last = task_map[result.critical_path[-1]]

    assert result.critical_path == ["t0", "t1"]
    assert last.early_finish == date(2027, 1, 23)
    assert result.project_finish == date(2027, 1, 25)
    assert _first_working_day_in(last.early_finish, result.project_finish, project.calendar) is None
    # The helper still catches a real gap: Friday is a working day short of Monday.
    assert _first_working_day_in(
        date(2027, 1, 22), result.project_finish, project.calendar
    ) == date(2027, 1, 22)


# ---------------------------------------------------------------------------
# Invariant 4: a driving edge never carries more float upstream than downstream
# ---------------------------------------------------------------------------


def _zero_lags(project: Project) -> Project:
    """``project`` with every dependency's lag set to zero.

    The narrowing :func:`test_driving_edge_never_gains_float_upstream` needs: a
    calendar-day lag is not a fixed working-time offset, so a driving edge with lag
    can legitimately carry more float upstream than downstream (see
    :func:`test_calendar_day_lag_driving_edge_can_carry_more_float_upstream`).
    Zeroing the lags, rather than skipping lagged edges, keeps every drawn link in
    scope; skipping them leaves the property about one zero-lag link in 21.
    """
    deps = [dataclasses.replace(d, lag=timedelta(0)) for d in project.dependencies]
    return dataclasses.replace(project, dependencies=deps)


def _float_inversions(
    project: Project, result: ScheduleResult, *, scoped: bool = True
) -> list[tuple[str, str]]:
    """Driving edges whose predecessor has more total float than its successor.

    In textbook CPM a zero-slack link gives ``total_float(pred) <=
    total_float(succ)``: the backward pass bounds the predecessor's late date by
    the successor's, shifted by a link offset that is constant in the unit float is
    counted in. ``scoped`` skips the two links where that premise is false here by
    design, not by defect (#4269):

    * **a non-zero lag.** Lag is calendar days, then snapped; float is working days.
      The same calendar-day lag spans more working days from a Monday than from
      the weekend the predecessor's late date can sit on, so the predecessor can
      out-float the successor by the working days the lag stops covering.
    * **a zero-duration successor.** A milestone's own float is measured to its
      late instant capped by ``engine._float_late_instant`` (#4183), keeping the
      reading that places it early, while its predecessors read the uncapped
      instant. The milestone can report a day less float than the predecessor
      that drives it.

    ``scoped=False`` applies the textbook identity to every driving edge, which is
    what the pinned counterexamples below use to show it does not hold there.
    """
    tasks = {t.id: t for t in result.tasks}
    lags = {(d.predecessor_id, d.successor_id): d.lag for d in project.dependencies}
    found = []
    for edge in result.driving_edges:
        pred, succ = tasks[edge.predecessor_id], tasks[edge.successor_id]
        if scoped and (lags[(pred.id, succ.id)] != timedelta(0) or succ.duration == timedelta(0)):
            continue
        assert pred.total_float is not None and succ.total_float is not None
        if pred.total_float > succ.total_float:
            found.append((pred.id, succ.id))
    return found


@given(project=_plausible_projects())
def test_driving_edge_never_gains_float_upstream(project: Project) -> None:
    """A driving edge into a work task never has more float on its predecessor.

    ``driving_edges`` come from a forward-anchored inversion (each link's free
    float, ``engine._free_float_days``) and ``total_float`` from the backward
    pass, so nothing in the engine makes them agree by construction — this is the
    property that ties the two together. A zero-slack link with a zero lag is a
    fixed working-time offset, so slipping the predecessor past its successor's
    float would slip the successor past its own, and its own late date bounds the
    predecessor's.

    Narrowed by :func:`_zero_lags` and scoped by :func:`_float_inversions` to
    work successors; each exclusion has a pinned counterexample below showing the
    engine is right and the textbook identity is not. With the gate profile's 200
    examples about a hundred in-scope driving edges are checked.
    """
    project = _zero_lags(project)
    try:
        result = schedule(project)
    except SchedulerError:
        return

    assert _float_inversions(project, result) == []


def _join_repro(*, include_long_task: bool = True, push_t1_days: int = 0) -> Project:
    """The #4269 repro: ``t0 -SS-> join`` and ``t1 -FS+2d-> join``, all milestones.

    ``t2`` (6 days) sets ``project_finish`` and gives the join float; without it
    every task is critical and there is nothing to compare. ``push_t1_days`` puts a
    work predecessor of that many days in front of ``t1``, landing it at the end of
    a later working day.
    """
    tasks = [
        Task(id="t0", name="t", duration=timedelta(0)),
        Task(id="t1", name="t", duration=timedelta(0)),
        Task(id="join", name="t", duration=timedelta(0)),
    ]
    deps = [
        Dependency(predecessor_id="t0", successor_id="join", dep_type=DependencyType.SS),
        Dependency(
            predecessor_id="t1",
            successor_id="join",
            dep_type=DependencyType.FS,
            lag=timedelta(days=2),
        ),
    ]
    if include_long_task:
        tasks.append(Task(id="t2", name="t", duration=timedelta(days=6)))
    if push_t1_days:
        tasks.append(Task(id="w", name="w", duration=timedelta(days=push_t1_days)))
        deps.append(Dependency(predecessor_id="w", successor_id="t1"))
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),  # a Monday
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=0b0011111),
    )


def test_calendar_day_lag_driving_edge_can_carry_more_float_upstream() -> None:
    """The #4269 repro: a driving edge with ``t1`` at 5 days of float, ``join`` at 4.

    Both numbers are right. ``t1`` (start of Monday 03-02) reaches ``join`` at the
    end of Tuesday through two calendar days of lag, which cover two working days.
    ``join`` can slip 4 working days, to the end of Monday 03-09. ``t1`` can slip 5,
    to the end of Friday 03-06: from there the same two calendar days are the
    weekend and land on the start of Monday, before ``join``'s late instant. The
    lag shrank from two working days to zero as ``t1`` slipped, so ``t1`` gained
    the difference. It is the lag, not the milestones: the same link between work
    tasks does the same (the property's :func:`_zero_lags` narrowing exists for it).
    """
    result = schedule(_join_repro())
    tasks = {t.id: t for t in result.tasks}

    assert DrivingEdge("t1", "join", "FS") in result.driving_edges
    assert result.project_finish == date(2026, 3, 9)
    assert tasks["t1"].total_float == timedelta(days=5)
    assert tasks["join"].total_float == timedelta(days=4)

    # t1's fifth day of float is real: a 5-day predecessor holds it to the end of
    # Friday and the finish does not move; a sixth day does move it.
    assert schedule(_join_repro(push_t1_days=5)).project_finish == date(2026, 3, 9)
    assert schedule(_join_repro(push_t1_days=6)).project_finish > date(2026, 3, 9)

    # Without t2 there is no float to compare: both are critical.
    lone = {t.id: t for t in schedule(_join_repro(include_long_task=False)).tasks}
    assert lone["t1"].total_float == lone["join"].total_float == timedelta(0)

    # The unscoped identity flags this edge; the scoped property skips it.
    assert _float_inversions(_join_repro(), result, scoped=False) == [("t1", "join")]
    assert _float_inversions(_join_repro(), result) == []


def _capped_milestone_project(a_planned_start: date | None = None) -> Project:
    """``A(1d) -FS-> M`` and ``B(1d) -SS+1d-> M`` beside a 5-day ``L``.

    Both links reach ``M`` at Tuesday midnight. A tie at one midnight resolves to
    the start-of-day reading, so ``M`` is a start-of-day milestone on Tuesday and
    ``engine._float_late_instant`` caps its own float.
    """
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),  # a Monday
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=1), planned_start=a_planned_start),
            Task(id="B", name="B", duration=timedelta(days=1)),
            Task(id="M", name="M", duration=timedelta(0)),
            Task(id="L", name="L", duration=timedelta(days=5)),
        ],
        dependencies=[
            Dependency(predecessor_id="A", successor_id="M"),
            Dependency(
                predecessor_id="B",
                successor_id="M",
                dep_type=DependencyType.SS,
                lag=timedelta(days=1),
            ),
        ],
        calendar=Calendar(working_days=0b0011111),
    )


def test_milestone_float_cap_driving_edge_can_carry_more_float_upstream() -> None:
    """A zero-lag driving edge into a milestone: ``A`` at 4 days of float, ``M`` at 3.

    ``A`` can slip to Friday and still finish by the end of the project's last day,
    so its 4 days are real. ``M``'s own float keeps the start-of-day reading that
    places it early (#4183): 4 days of slip would put it at the start of Saturday,
    shown on Monday past ``project_finish``, so it stops at 3. ``A`` reads ``M``'s
    uncapped late instant, as ``engine._float_late_instant`` documents. The cap is
    the whole difference: measured to the uncapped instant ``M`` would report 4.
    """
    project = _capped_milestone_project()
    result = schedule(project)
    tasks = {t.id: t for t in result.tasks}

    assert DrivingEdge("A", "M", "FS") in result.driving_edges
    assert not tasks["M"].milestone_at_day_end
    assert tasks["A"].total_float == timedelta(days=4)
    assert tasks["M"].total_float == timedelta(days=3)

    # A's fourth day is real: starting it on Friday leaves the finish alone.
    friday = date(2026, 3, 6)
    assert schedule(_capped_milestone_project(friday)).project_finish == result.project_finish
    assert schedule(_capped_milestone_project(friday + timedelta(days=1))).project_finish > (
        result.project_finish
    )

    assert _float_inversions(project, result, scoped=False) == [("A", "M")]
    assert _float_inversions(project, result) == []


def test_float_inversion_check_flags_a_zero_lag_work_successor() -> None:
    """Negative control: the scoping does not hide an inversion it should catch.

    A zero-lag link between two work tasks is exactly what the property checks; a
    result whose predecessor reports a day more float than its successor must be
    flagged, or the property would pass on an engine that produced one.
    """
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=2)),
            Task(id="B", name="B", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency(predecessor_id="A", successor_id="B")],
        calendar=Calendar(working_days=0b0011111),
    )
    result = schedule(project)
    assert DrivingEdge("A", "B", "FS") in result.driving_edges
    assert _float_inversions(project, result) == []

    broken = dataclasses.replace(
        result,
        tasks=[
            dataclasses.replace(t, total_float=timedelta(days=1)) if t.id == "A" else t
            for t in result.tasks
        ],
    )
    assert _float_inversions(project, broken) == [("A", "B")]
