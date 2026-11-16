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
not move; one working day later and it must).

The matrix test and the known-answer test fail against the pre-fix engine. The
two Hypothesis properties did not under the derandomized CI profile (the
plausible generator rarely builds a calendar-day lag onto a weekend midnight), so
they widen coverage under ``scheduler:fuzz-deep`` but are not the regression
witness.
"""

from __future__ import annotations

import itertools
from datetime import date, timedelta

import pytest
from hypothesis import given

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
from trueppm_scheduler.engine.calendar_math import _working_days_between

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


@pytest.mark.fuzz
@given(project=_plausible_projects(per_task_calendars=True))
def test_total_float_is_shown_span_with_per_task_calendars(project: Project) -> None:
    try:
        result = schedule(project)
    except SchedulerError:
        return
    _assert_float_is_shown_span(project, result)


def _lagged_out(pin: date | None = None) -> Project:
    """``P -SS-> M -FS+3cd-> S`` beside 12 days of work: M's late instant is Saturday 00:00."""
    return Project(
        "p",
        "p",
        MON,
        [
            Task("P", "P", timedelta(days=3)),
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


@pytest.mark.parametrize(
    ("pin", "finish_moves"),
    [(date(2027, 3, 15), False), (date(2027, 3, 16), True)],
)
def test_pinning_the_milestone_at_its_late_start_does_not_move_the_finish(
    pin: date, finish_moves: bool
) -> None:
    """Slip oracle: the shown late start is a date the milestone can really be moved to."""
    base = schedule(_lagged_out()).project_finish
    pinned = schedule(_lagged_out(pin))
    m = next(t for t in pinned.tasks if t.id == "M")
    assert m.early_start == pin
    assert (pinned.project_finish != base) is finish_moves
