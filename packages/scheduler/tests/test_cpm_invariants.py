"""CPM core property invariants prescribed by test-strategy (#3667).

``.claude/skills/test-strategy/SKILL.md`` names three invariants that must hold
for any valid DAG: ``total_float >= 0``, a critical-path task has
``total_float == 0``, and project duration equals the latest ``early_finish``
on the critical path. ``test_contract_fuzz.py`` only ever asserted
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
# Invariant 3: project duration == the latest early_finish on the critical path
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


def _working_time_finish_bound(result: ScheduleResult, cal: Calendar) -> date:
    """The exclusive bound :func:`_first_working_day_in` checks a finish against.

    When every task shown on ``project_finish`` is a milestone at the start of that
    day, the project ends at the end of the working day before it, so work that
    finishes that earlier day reaches the project finish in working time.
    """
    shown = [t for t in result.tasks if t.early_finish == result.project_finish]
    if not all(t.duration == timedelta(0) and not t.milestone_at_day_end for t in shown):
        return result.project_finish
    day = result.project_finish - timedelta(days=1)
    while not cal.is_working_day(day):
        day -= timedelta(days=1)
    return day


def _assert_latest_critical_task_reaches_project_finish(project: Project) -> None:
    project = _clear_completion(project)
    try:
        result = schedule(project)
    except SchedulerError:
        return

    assert result.critical_path, "no completed task, yet critical_path is empty"
    task_map = {t.id: t for t in result.tasks}
    critical = [task_map[tid] for tid in result.critical_path]
    latest = max(critical, key=lambda t: t.early_finish or date.min)
    has_successor = {d.predecessor_id for d in project.dependencies}
    sinks = [t for t in critical if t.id not in has_successor]
    for task, role in [(latest, "latest critical"), *((t, "critical sink") for t in sinks)]:
        assert task.early_finish is not None
        cal = _task_calendar(project, task)
        gap = _first_working_day_in(task.early_finish, _working_time_finish_bound(result, cal), cal)
        assert gap is None, (
            f"{task.id}: {role} task has early_finish {task.early_finish}, "
            f"a working day ({gap}) short of project_finish {result.project_finish}"
        )


# The name still says "last" so the Hypothesis example database keeps its key.
@given(project=_plausible_projects())
def test_project_duration_equals_last_critical_task_early_finish(project: Project) -> None:
    """``project_finish`` equals the latest ``early_finish`` on the critical path,
    and every critical task with no successor finishes on it.

    A task with no successor has its ``late_finish`` anchored directly on
    ``project_finish`` by the backward pass's base case, so zero float means it
    finishes there. The global early-finish maximizer is such a task, so with
    nothing complete it is on the critical path.

    The *last entry* of ``critical_path`` is not the right task to check. The
    list is a topological order of the critical set, not a chain, and a critical
    task can have successors without having a critical one, so the last entry
    can finish early (#4281). Two documented rules produce that:

    * a milestone the project start holds only where it is *shown* (#4225): a
      lead puts its instant before the project start, it is shown on the first
      working day with zero float, and its successors measure their lags from
      the earlier instant and keep slack;
    * a calendar-day lag across non-working time: ``M -FS+2d-> N`` with ``M``
      at the end of a Friday puts ``N`` at the start of Monday. ``M`` slipping
      one working day moves ``N`` three calendar days, so ``M`` has zero float
      while ``N`` has a day of it.

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
    reasoning above) — so this is asserted rather than skipped.
    """
    _assert_latest_critical_task_reaches_project_finish(project)


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


@pytest.mark.parametrize("lead_days", [-3, -4])
def test_milestone_held_at_project_start_by_a_lead_ends_critical_path_early(
    lead_days: int,
) -> None:
    """Pinned counterexample from the deep Hypothesis profile (#4281).

    ``t0 -FS(lead)-> t1 -FS+2d-> join``: the lead puts ``t1``'s instant before the
    project start. ``t1`` is shown on the first working day with zero float, while
    ``join`` is measured from the earlier instant (#4225) and keeps a day of slack,
    so ``critical_path`` ends on ``t1`` a working day short of ``project_finish``.
    """
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="t0", name="t", duration=timedelta(days=2)),
            Task(id="t1", name="t", duration=timedelta(0)),
            Task(id="join", name="t", duration=timedelta(0)),
        ],
        dependencies=[
            Dependency("t0", "t1", DependencyType.FS, timedelta(days=lead_days)),
            Dependency("t1", "join", DependencyType.FS, timedelta(days=2)),
        ],
        calendar=Calendar(working_days=0b0011111),
    )
    result = schedule(project)
    task_map = {t.id: t for t in result.tasks}

    assert result.critical_path == ["t0", "t1"]
    assert task_map["t1"].early_finish == date(2026, 3, 2)
    assert task_map["join"].early_start == date(2026, 3, 2)
    assert task_map["join"].total_float == timedelta(days=1)
    assert result.project_finish == date(2026, 3, 3)
    _assert_latest_critical_task_reaches_project_finish(project)


def test_calendar_day_lag_across_a_weekend_ends_critical_path_early() -> None:
    """Pinned counterexample from the deep Hypothesis profile (#4281).

    ``t1`` (Mon-Wed) ``-FS+2d-> t3`` puts ``t3`` at the end of Friday, and
    ``t3 -FS+2d-> join`` puts ``join`` at the start of Monday. A one-working-day
    slip of ``t3`` would push ``join`` past the Tuesday ``project_finish`` that
    ``t2`` sets, so ``t3`` is critical while ``join`` keeps a day of float, and
    ``t3`` ends ``critical_path`` on Friday.
    """
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="t0", name="t", duration=timedelta(0)),
            Task(id="t1", name="t", duration=timedelta(days=3)),
            Task(id="t2", name="t", duration=timedelta(days=4)),
            Task(id="t3", name="t", duration=timedelta(0)),
            Task(id="join", name="t", duration=timedelta(0)),
        ],
        dependencies=[
            Dependency("t0", "t1", DependencyType.FS),
            Dependency("t0", "t2", DependencyType.FS),
            Dependency("t0", "t3", DependencyType.FS),
            Dependency("t1", "t2", DependencyType.FS),
            Dependency("t1", "t3", DependencyType.FS, timedelta(days=2)),
            Dependency("t0", "join", DependencyType.SS),
            Dependency("t3", "join", DependencyType.FS, timedelta(days=2)),
        ],
        calendar=Calendar(working_days=0b0011111),
    )
    result = schedule(project)
    task_map = {t.id: t for t in result.tasks}

    assert result.critical_path == ["t0", "t1", "t2", "t3"]
    assert task_map["t3"].early_finish == date(2026, 3, 6)
    assert task_map["join"].total_float == timedelta(days=1)
    assert result.project_finish == date(2026, 3, 10)
    _assert_latest_critical_task_reaches_project_finish(project)


def test_critical_sink_reaches_a_start_of_day_milestone_finish_in_working_time() -> None:
    """Pinned counterexample from the deep Hypothesis profile (#4281).

    ``t2`` ends on Monday and ``join`` sits at the start of Tuesday, which is the
    same point in working time, so the critical sink ``t2`` reaches
    ``project_finish`` although its date is a day earlier.
    """
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="t0", name="t", duration=timedelta(0)),
            Task(id="t1", name="t", duration=timedelta(0)),
            Task(id="t2", name="t", duration=timedelta(days=1)),
            Task(id="join", name="t", duration=timedelta(0)),
        ],
        dependencies=[
            Dependency("t0", "t1", DependencyType.FS),
            Dependency("t0", "t2", DependencyType.FS, timedelta(days=5)),
            Dependency("t0", "join", DependencyType.SS, timedelta(days=8)),
            Dependency("t1", "join", DependencyType.FS),
        ],
        calendar=Calendar(working_days=0b0011111),
    )
    result = schedule(project)
    task_map = {t.id: t for t in result.tasks}

    assert task_map["t2"].is_critical
    assert task_map["t2"].early_finish == date(2026, 3, 9)
    assert result.project_finish == date(2026, 3, 10)
    assert not task_map["join"].milestone_at_day_end
    assert _working_time_finish_bound(result, project.calendar) == date(2026, 3, 9)
    _assert_latest_critical_task_reaches_project_finish(project)


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
    counted in. ``scoped`` skips the three links where that premise is false here by
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
    * **two different calendars.** Each task's float is counted in its *own*
      working days (ADR-0120 D3). The same stretch of calendar time is 10 days of
      float on a 7-day calendar and 8 on a 5-day one, so the predecessor on the
      longer working week out-floats the successor it drives.

    ``scoped=False`` applies the textbook identity to every driving edge, which is
    what the pinned counterexamples below use to show it does not hold there.
    """
    tasks = {t.id: t for t in result.tasks}
    lags = {(d.predecessor_id, d.successor_id): d.lag for d in project.dependencies}
    found = []
    for edge in result.driving_edges:
        pred, succ = tasks[edge.predecessor_id], tasks[edge.successor_id]
        if scoped and (
            lags[(pred.id, succ.id)] != timedelta(0)
            or succ.duration == timedelta(0)
            # Compared by the calendar each task resolves to, not by
            # ``calendar_id``: two ids naming equal calendars count float in the
            # same unit, and only a real difference breaks the identity.
            or _task_calendar(project, pred) != _task_calendar(project, succ)
        ):
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
    work successors on the predecessor's calendar; each exclusion has a pinned
    counterexample below showing the engine is right and the textbook identity is
    not. ``_plausible_projects`` draws a single project calendar, so the calendar
    exclusion removes nothing here. The gate profile's 200 examples check roughly
    75-100 in-scope driving edges, depending on the derandomized seed.
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


def _two_calendar_project(
    a_cal: str = "seven", b_cal: str = "five", a_planned_start: date | None = None
) -> Project:
    """``A(1d) -FS-> B(1d)`` beside a 10-day ``L``, each on its named calendar.

    The project calendar is a 5-day week; ``A`` and ``B`` opt into ``"seven"`` (a
    7-day week) or ``"five"`` (the same 5-day week) through ``calendar_id``.
    """
    five = Calendar(working_days=0b0011111)
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),  # a Monday
        tasks=[
            Task(
                id="A",
                name="A",
                duration=timedelta(days=1),
                calendar_id=a_cal,
                planned_start=a_planned_start,
            ),
            Task(id="B", name="B", duration=timedelta(days=1), calendar_id=b_cal),
            Task(id="L", name="L", duration=timedelta(days=10)),
        ],
        dependencies=[Dependency(predecessor_id="A", successor_id="B")],
        calendar=five,
        calendars={"seven": Calendar(working_days=0b1111111), "five": five},
    )


def test_per_task_calendar_driving_edge_can_carry_more_float_upstream() -> None:
    """A zero-lag driving edge across calendars: ``A`` at 10 days of float, ``B`` at 8.

    Both are the same slack in calendar time. ``A`` (7-day week) can start as late
    as Thursday 03-12, ``B`` (5-day week) as late as Friday 03-13, and each counts
    the stretch from its early start in its own working days (ADR-0120 D3). Swap
    the calendars and the numbers swap with them, so the inversion is the unit,
    not the schedule.
    """
    project = _two_calendar_project()
    result = schedule(project)
    tasks = {t.id: t for t in result.tasks}

    assert DrivingEdge("A", "B", "FS") in result.driving_edges
    assert tasks["A"].total_float == timedelta(days=10)
    assert tasks["B"].total_float == timedelta(days=8)

    # A's ten days are real: starting it Thursday 03-12 leaves the finish alone,
    # Friday moves it.
    thursday = date(2026, 3, 12)
    assert (
        schedule(_two_calendar_project(a_planned_start=thursday)).project_finish
        == result.project_finish
    )
    assert (
        schedule(_two_calendar_project(a_planned_start=thursday + timedelta(days=1))).project_finish
        > result.project_finish
    )

    swapped = _two_calendar_project("five", "seven")
    swapped_tasks = {t.id: t for t in schedule(swapped).tasks}
    assert swapped_tasks["A"].total_float == timedelta(days=8)
    assert swapped_tasks["B"].total_float == timedelta(days=10)

    # Negative control: without the calendar skip the scoped check would flag it.
    assert _float_inversions(project, result, scoped=False) == [("A", "B")]
    assert _float_inversions(project, result) == []
    # The skip is narrow: on one shared calendar the edge stays in scope, so a
    # planted inversion there is still caught.
    same = _two_calendar_project("five", "five")
    same_result = schedule(same)
    assert DrivingEdge("A", "B", "FS") in same_result.driving_edges
    assert _float_inversions(same, same_result) == []
    planted = dataclasses.replace(
        same_result,
        tasks=[
            dataclasses.replace(t, total_float=t.total_float + timedelta(days=1))
            if t.id == "A" and t.total_float is not None
            else t
            for t in same_result.tasks
        ],
    )
    assert _float_inversions(same, planted) == [("A", "B")]


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


def _saturday_actual_start_project(actual_start: date | None = date(2027, 1, 30)) -> Project:
    """The #4332 fuzz counterexample: ``t0 -SS-> t2`` where ``t2`` started on a Saturday.

    Nightly ``scheduler:fuzz-deep`` (pipeline 2926636310) shrank to this. ``t2``'s
    recorded ``actual_start`` is the Saturday after the Friday status date, kept
    verbatim (ADR-0132 §2), so it holds ``t2``'s early start; ``t0``'s SS link only
    imposes the Friday. ``t3`` closes the network on the Monday, which leaves
    ``t0`` one working day of total float and ``t2`` none. ``actual_start=None``
    gives the same network with ``t2`` placed by its links alone.
    """

    def task(tid: str, days: int, start: date | None = None) -> Task:
        return Task(id=tid, name=tid, duration=timedelta(days=days), actual_start=start)

    def link(pred: str, succ: str, kind: DependencyType) -> Dependency:
        return Dependency(predecessor_id=pred, successor_id=succ, dep_type=kind)

    fs, ss, ff = DependencyType.FS, DependencyType.SS, DependencyType.FF
    return Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[task("t0", 1), task("t1", 0), task("t2", 1, actual_start), task("t3", 0)],
        dependencies=[
            link("t0", "t1", fs),
            link("t0", "t3", fs),
            link("t1", "t2", ff),
            link("t0", "t2", ss),
            link("t1", "t3", fs),
            link("t2", "t3", fs),
        ],
        calendar=Calendar(working_days=0b0011111),
        status_date=date(2027, 1, 29),
    )


def test_ss_link_into_a_saturday_actual_start_is_not_driving() -> None:
    """A predecessor whose link imposes the Friday does not drive a Saturday start (#4332).

    ``t2``'s Saturday start is the same working-time position as the Monday after
    it — the engine counts zero days of float between them. ``t0`` slipping from
    Friday to Monday therefore moves neither ``t2``'s working-time start nor its
    finish, and ``t0`` keeps the day of total float that says so. Before the fix
    the free-float inversion retreated from the raw Saturday to the Friday,
    read zero slack, and reported ``t0 -> t2`` as driving: the one edge where the
    property above saw a predecessor out-float the successor it drives.
    """
    project = _saturday_actual_start_project()
    result = schedule(project)
    tasks = {t.id: t for t in result.tasks}

    assert tasks["t2"].early_start == date(2027, 1, 30)  # verbatim Saturday actual
    assert tasks["t0"].total_float == timedelta(days=1)
    assert tasks["t2"].total_float == timedelta(0)
    assert DrivingEdge("t0", "t2", "SS") not in result.driving_edges
    assert result.driving_edges == [
        DrivingEdge("t0", "t1", "FS"),
        DrivingEdge("t2", "t3", "FS"),
    ]
    assert _float_inversions(project, result) == []

    # Slipping t0 its one day of float leaves t2's finish, and the project's, alone.
    slipped = dataclasses.replace(
        project,
        tasks=[
            dataclasses.replace(t, planned_start=date(2027, 2, 1)) if t.id == "t0" else t
            for t in project.tasks
        ],
    )
    slipped_tasks = {t.id: t for t in schedule(slipped).tasks}
    assert slipped_tasks["t2"].early_finish == tasks["t2"].early_finish
    assert schedule(slipped).project_finish == result.project_finish


def test_ss_link_still_drives_a_work_successor_it_places() -> None:
    """Control for the #4332 snap: without the actual, ``t0``'s SS link places ``t2``.

    The snap to the working day only changes a non-working early start; a
    successor the link actually sets keeps the link as its driver.
    """
    result = schedule(_saturday_actual_start_project(actual_start=None))
    tasks = {t.id: t for t in result.tasks}
    assert tasks["t2"].early_start == tasks["t0"].early_start
    assert DrivingEdge("t0", "t2", "SS") in result.driving_edges
