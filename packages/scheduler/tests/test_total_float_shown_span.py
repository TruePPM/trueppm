"""``total_float`` is the working-day span from the shown early to the shown late start (#4528).

The scheduler conventions page states it for every task: "``total_float`` is the
working-day span from the early start to the late start". A start-of-day
milestone whose late instant was a non-working midnight (Saturday 00:00, reached
through a calendar-day lag, a data date or a weekend ``actual_start``) broke it:
its float ran to the midnight itself, but its late start was shown on the Friday
before, so ``total_float`` read one working day more than ``LS - ES``. The 2026-11-15
audit measured it in 411 of 23,040 full-matrix runs.

The Rust engine mirrors the fix, so the conformance snapshots only prove the two
agree. The independent oracle here is twofold: the identity itself, asserted over
the full link matrix and the plausible-project fuzz generator, and a slip test on
the reported shape (pin the milestone to its shown late start and the finish must
not move; one working day later and it must). A third test pins the disclosed
limit: when the *predecessor* puts the milestone on that late start, the finish
still moves.

The matrix, known-answer, slip and predecessor tests fail against the pre-fix
engine. The two Hypothesis properties did not under the derandomized CI profile (the
plausible generator rarely builds a calendar-day lag onto a weekend midnight), so
they widen coverage under ``scheduler:fuzz-deep`` but are not the regression
witness.
"""

from __future__ import annotations

import itertools
from datetime import date, timedelta

import pytest
from hypothesis import example, given

from tests.test_contract_fuzz import _plausible_projects
from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    SchedulerError,
    ScheduleResult,
    Task,
    schedule,
)
from trueppm_scheduler.derive import derive_value
from trueppm_scheduler.engine.calendar_math import _next_working_day, _working_days_between

MON = date(2027, 3, 1)
SAT = date(2027, 3, 6)
NEXT_MON = date(2027, 3, 8)
FRI = date(2027, 3, 5)

_CALENDARS = {
    "mon-fri": Calendar(),
    "mon-thu": Calendar(working_days=0b0001111),
    "seven": Calendar(working_days=0b1111111),
}


def _own_calendar(project: Project, task: Task) -> Calendar:
    if task.calendar_id and project.calendars and task.calendar_id in project.calendars:
        return project.calendars[task.calendar_id]
    return project.calendar


def _assert_float_is_shown_span(project: Project, result: ScheduleResult) -> None:
    by_id = {t.id: t for t in project.tasks}
    for out in result.tasks:
        src = by_id.get(out.id)
        if src is None:  # summaries expanded away
            continue
        assert out.early_start is not None and out.late_start is not None
        span = _working_days_between(out.early_start, out.late_start, _own_calendar(project, src))
        assert out.total_float == timedelta(days=span), (
            f"{out.id}: total_float {out.total_float.days} != LS-ES {span} "
            f"(ES {out.early_start}, LS {out.late_start}, "
            f"at_day_end={out.milestone_at_day_end})"
        )


def _matrix_project(
    link_in: DependencyType,
    lag_in: int,
    link_out: DependencyType,
    lag_out: int,
    state: str,
    calendar: str,
    milestone_calendar: str | None,
    status_date: date | None,
) -> Project:
    m = Task("M", "M", timedelta(0))
    if state == "started-sat":
        m.actual_start = SAT
    elif state == "started-mon":
        m.actual_start = NEXT_MON
    elif state == "closed":
        m.actual_start = m.actual_finish = FRI
        m.percent_complete = 100.0
    calendars = None
    if milestone_calendar is not None:
        m.calendar_id = "mc"
        calendars = {"mc": _CALENDARS[milestone_calendar]}
    return Project(
        "p",
        "p",
        MON,
        [
            Task("P", "P", timedelta(days=3)),
            m,
            Task("S", "S", timedelta(days=1)),
            # Parallel work that ends later, so M carries float.
            Task("L", "L", timedelta(days=12)),
        ],
        [
            Dependency("P", "M", link_in, timedelta(days=lag_in)),
            Dependency("M", "S", link_out, timedelta(days=lag_out)),
        ],
        _CALENDARS[calendar],
        status_date=status_date,
        calendars=calendars,
    )


def test_total_float_is_shown_span_over_the_full_link_matrix() -> None:
    """Link in x link out x lag x milestone state x calendar, as the audit swept.

    Before the fix this matrix had 1,000+ start-of-day milestones whose float ran
    one working day past their shown late start.
    """
    for combo in itertools.product(
        DependencyType,
        (-1, 0, 2),
        DependencyType,
        (-1, 0, 3),
        ("open", "started-sat", "started-mon", "closed"),
        ("mon-fri", "mon-thu"),
        (None, "seven"),
        (None, date(2027, 3, 10)),
    ):
        project = _matrix_project(*combo)
        try:
            result = schedule(project)
        except SchedulerError:
            continue
        _assert_float_is_shown_span(project, result)


@pytest.mark.fuzz
@given(project=_plausible_projects())
def test_total_float_is_shown_span_on_plausible_projects(project: Project) -> None:
    try:
        result = schedule(project)
    except SchedulerError:
        return
    _assert_float_is_shown_span(project, result)


_JOIN_CALENDARS = {
    "fourday": Calendar(working_days=0b0001111),
    "mondays": Calendar(working_days=0b0000001),
    "seven": Calendar(working_days=0b1111111),
}


def _inherited_join(
    t0_link: DependencyType = DependencyType.SS,
    t1_link: DependencyType = DependencyType.FS,
    join_calendar: str | None = "fourday",
    t0_complete: bool = True,
    t1_pin: date | None = None,
) -> Project:
    """The 2026-11-21 ``scheduler:fuzz-deep`` counterexample (#5092), parametrized.

    ``t1`` is a start-of-day milestone (held by the project start) whose zero-lag
    link gives ``join`` its reading, so ``join`` inherits it (#4526). ``t0`` sets
    the finish, Friday 2026-04-17. ``join`` works a narrower week: at the start of
    Friday it is shown Monday and moves the finish, so ``t1``'s float stops at the
    start of Thursday. The engine measured the float there but showed the late
    start on Friday, from the uncapped instant.
    """
    t0 = Task("t0", "t", timedelta(days=35))
    if t0_complete:
        t0.percent_complete = 100.0
    join = Task("join", "t", timedelta(0), calendar_id=join_calendar)
    return Project(
        "p",
        "p",
        date(2026, 3, 2),
        [
            t0,
            Task("t1", "t", timedelta(0), planned_start=t1_pin),
            Task("t2", "t", timedelta(0)),
            join,
        ],
        [Dependency("t0", "join", t0_link), Dependency("t1", "join", t1_link)],
        Calendar(),
        calendars=dict(_JOIN_CALENDARS),
    )


def test_inherited_cap_late_start_is_where_the_float_stops() -> None:
    """Known answer and slip oracle for the reported shape (#5092)."""
    project = _inherited_join()
    result = schedule(project)
    t1 = _task(result, "t1")
    assert result.project_finish == date(2026, 4, 17)
    assert t1.early_start == date(2026, 3, 2)
    assert t1.late_start == t1.late_finish == date(2026, 4, 16)
    assert t1.total_float == timedelta(days=33)
    _assert_float_is_shown_span(project, result)
    # Held on its shown late start, t1 moves nothing; held one working day later,
    # join (Monday-to-Thursday) is shown Monday and the finish moves.
    assert schedule(_inherited_join(t1_pin=date(2026, 4, 16))).project_finish == date(2026, 4, 17)
    assert schedule(_inherited_join(t1_pin=date(2026, 4, 17))).project_finish == date(2026, 4, 20)
    # The derivation cites the bound the engine shows, not the uncapped Friday.
    derivation = derive_value(project, "t1", "late_start", result)
    assert derivation.value == "2026-04-16"
    binding = next(c for c in derivation.contributions if c.is_binding)
    assert binding.imposed_date == date(2026, 4, 16)


@pytest.mark.parametrize("join_calendar", [None, *_JOIN_CALENDARS])
@pytest.mark.parametrize("t1_link", list(DependencyType))
@pytest.mark.parametrize("t0_link", list(DependencyType))
@pytest.mark.parametrize("t0_complete", [True, False])
def test_total_float_is_shown_span_through_an_inherited_join(
    t0_link: DependencyType,
    t1_link: DependencyType,
    join_calendar: str | None,
    t0_complete: bool,
) -> None:
    """The #5092 class: every link type on both sides, the join on each calendar.

    Before the fix, 24 of these 128 cases failed: ``t0`` into the join by SS or SF
    (so the join stays early and ``t1``'s float is bounded by the finish seed),
    ``t1`` by FS, SS or FF (every zero-lag link that hands the join ``t1``'s
    reading, FF into a milestone being FS), and the join on the narrower
    ``fourday`` or ``mondays`` week. ``t1``'s late start was shown a working day
    or more past its float, and holding it there moved the finish. The ``seven``
    join's last working day is the finish itself, so it never binds. A late start
    that can be held without moving the finish is asserted alongside the identity.
    """
    project = _inherited_join(t0_link, t1_link, join_calendar, t0_complete)
    try:
        result = schedule(project)
    except SchedulerError:
        return
    _assert_float_is_shown_span(project, result)
    t1 = _task(result, "t1")
    held = _inherited_join(t0_link, t1_link, join_calendar, t0_complete, t1_pin=t1.late_start)
    assert schedule(held).project_finish == result.project_finish


@pytest.mark.fuzz
@given(project=_plausible_projects(per_task_calendars=True))
@example(project=_inherited_join())
def test_total_float_is_shown_span_with_per_task_calendars(project: Project) -> None:
    try:
        result = schedule(project)
    except SchedulerError:
        return
    _assert_float_is_shown_span(project, result)


def _lagged_out(pin: date | None = None, pred_pin: date | None = None) -> Project:
    """``P -SS-> M -FS+3cd-> S`` beside 12 days of work: M's late instant is Saturday 00:00.

    ``pin`` holds M itself (``planned_start``); ``pred_pin`` holds P, so the SS
    link is what places M.
    """
    return Project(
        "p",
        "p",
        MON,
        [
            Task("P", "P", timedelta(days=3), planned_start=pred_pin),
            Task("M", "M", timedelta(0), planned_start=pin),
            Task("S", "S", timedelta(days=1)),
            Task("L", "L", timedelta(days=12)),
        ],
        [
            Dependency("P", "M", DependencyType.SS),
            Dependency("M", "S", DependencyType.FS, timedelta(days=3)),
        ],
        Calendar(),
    )


def test_start_of_day_milestone_late_start_is_the_monday_its_float_runs_to() -> None:
    result = schedule(_lagged_out())
    m = next(t for t in result.tasks if t.id == "M")
    assert result.project_finish == date(2027, 3, 16)
    assert not m.milestone_at_day_end
    assert m.early_start == MON
    # S's late start is Tue 03-16, so M may link from as late as Saturday 03-13
    # 00:00; shown at the start of a day, that is Monday 03-15, not Friday 03-12.
    assert m.late_start == m.late_finish == date(2027, 3, 15)
    assert m.total_float == timedelta(days=10)


def _task(result: ScheduleResult, task_id: str) -> Task:
    return next(t for t in result.tasks if t.id == task_id)


@pytest.mark.parametrize(("working_days_past", "finish_moves"), [(0, False), (1, True)])
def test_pinning_the_milestone_at_its_late_start_does_not_move_the_finish(
    working_days_past: int, finish_moves: bool
) -> None:
    """Slip oracle: the shown late start is the last day the milestone can be held on.

    The pin is derived from the *reported* late start, not hard-coded, so this
    fails if the late start is shown on a day short of the real one: on the pre-fix
    engine (late start Friday 03-12) holding M on the next working day, Monday
    03-15, leaves the finish where it was, and the ``(1, True)`` case fails.
    """
    base = schedule(_lagged_out())
    shown_late = _task(base, "M").late_start
    assert shown_late is not None
    pin = shown_late
    for _ in range(working_days_past):
        pin = _next_working_day(pin + timedelta(days=1), Calendar())
    pinned = schedule(_lagged_out(pin))
    assert _task(pinned, "M").early_start == pin
    assert (pinned.project_finish != base.project_finish) is finish_moves


def test_predecessor_placing_the_milestone_on_its_late_start_moves_the_finish() -> None:
    """Pins the disclosed limit of the shown late start (#4528); see the conventions page.

    M's late start (Monday 03-15) is the latest M can start in working time *when M
    itself is held there*: a milestone pinned to Monday links from Saturday 00:00,
    the same working-time point. When its predecessor is what puts it on that
    Monday, the SS link places M at Monday 00:00, and the calendar-day lag to S then
    runs from Monday rather than Saturday, so S lands on Thursday 03-18 and the
    finish moves two working days. (P itself is past its own late start, Friday
    03-12, by then.) Whether lag should count working or calendar days is #2535 and
    is not decided here.

    If either half changes, an engine or doc decision changed: a late start shown
    on Friday again fails the ``m_late`` lines, and a predecessor-driven Monday
    that stops moving the finish fails the ``project_finish`` lines. Update the
    conventions page and changelog with it rather than this test alone.
    """
    base = schedule(_lagged_out())
    m_late = _task(base, "M").late_start
    assert m_late == date(2027, 3, 15)
    assert _task(base, "P").late_start == date(2027, 3, 12)
    assert base.project_finish == date(2027, 3, 16)

    held_itself = schedule(_lagged_out(pin=m_late))
    assert _task(held_itself, "M").early_start == m_late
    assert held_itself.project_finish == base.project_finish

    held_by_pred = schedule(_lagged_out(pred_pin=m_late))
    m = _task(held_by_pred, "M")
    assert m.early_start == m_late
    assert not m.milestone_at_day_end
    assert _task(held_by_pred, "S").early_start == date(2027, 3, 18)
    assert held_by_pred.project_finish == date(2027, 3, 18)
    assert _working_days_between(base.project_finish, held_by_pred.project_finish, Calendar()) == 2
