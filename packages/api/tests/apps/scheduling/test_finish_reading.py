"""Project-finish shifts are measured in working time, not by the shown day (#4178).

A zero-duration milestone is an instant, shown at the end of its day when it
follows work and at the start of the next working day when a lag lands it just
after non-working time (#4079, #4173). The end of a Friday and the start of the
following Monday are the same point in working time, so the shown project finish
can hop a weekend while nothing moved. These tests pin that the two consumers that
report a finish shift — the end-date shift notification and the activity feed's
``recalc_finish_delta_days`` — report 0 for that hop and still report a real slip.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from trueppm_scheduler.models import Calendar as SchedCalendar
from trueppm_scheduler.models import DateRange

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification, NotificationEventType
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Task,
    TaskActivityEvent,
)
from trueppm_api.apps.scheduling.finish_reading import (
    finish_shift_days,
    latest_finish,
    task_finish_at_day_start,
    working_time_end_day,
)
from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot
from trueppm_api.apps.scheduling.services import safe_capture_forecast_snapshot
from trueppm_api.apps.scheduling.tasks import _run_schedule

User = get_user_model()

MON_FRI = SchedCalendar(working_days=31)
FRI = date(2026, 8, 7)
SAT = date(2026, 8, 8)
MON = date(2026, 8, 10)
TUE = date(2026, 8, 11)


# ---------------------------------------------------------------------------
# The display rule, as the helpers read it
# ---------------------------------------------------------------------------


def _row(**kw: Any) -> SimpleNamespace:
    base: dict[str, Any] = dict(
        is_milestone=False,
        milestone_at_day_end=False,
        actual_start=None,
        actual_finish=None,
        percent_complete=0.0,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_only_an_unpinned_start_of_day_milestone_finishes_at_its_day_start() -> None:
    assert task_finish_at_day_start(_row(is_milestone=True)) is True
    assert task_finish_at_day_start(_row(is_milestone=True, milestone_at_day_end=True)) is False
    # Work ends at the end of its finish day, whatever the flag says.
    assert task_finish_at_day_start(_row()) is False
    # A milestone pinned by recorded actuals is laid out as ordinary work: the
    # engine resets the flag to False, but it ends at the end of its day.
    assert task_finish_at_day_start(_row(is_milestone=True, actual_finish=FRI)) is False
    assert (
        task_finish_at_day_start(_row(is_milestone=True, actual_start=FRI, percent_complete=100))
        is False
    )
    # The override reads the flag a task held before a recalculation overwrote it.
    assert (
        task_finish_at_day_start(
            _row(is_milestone=True, milestone_at_day_end=True), milestone_at_day_end=False
        )
        is True
    )


def test_latest_finish_is_start_of_day_only_when_every_leaf_on_the_day_is() -> None:
    assert latest_finish([(FRI, False, "1"), (MON, True, "2")]) == (MON, True)
    # Work ending on the same day as a start-of-day milestone ends the project at
    # the end of that day.
    assert latest_finish([(MON, True, "1"), (MON, False, "2")]) == (MON, False)
    # A summary carries its child's day but not its reading, so it is ignored.
    assert latest_finish([(MON, False, "1"), (MON, True, "1.1")]) == (MON, True)
    assert latest_finish([(None, False, "1")]) is None


def test_start_of_day_is_the_end_of_the_previous_working_day() -> None:
    assert working_time_end_day((MON, True), MON_FRI) == FRI
    assert working_time_end_day((MON, False), MON_FRI) == MON
    # A holiday Friday pushes it back to Thursday.
    holiday = SchedCalendar(working_days=31, exceptions=[DateRange(start=FRI, end=FRI)])
    assert working_time_end_day((MON, True), holiday) == date(2026, 8, 6)


def test_weekend_hop_is_no_shift_but_a_real_slip_is() -> None:
    assert finish_shift_days((FRI, False), (MON, True), MON_FRI) == 0
    assert finish_shift_days((MON, True), (FRI, False), MON_FRI) == 0
    assert finish_shift_days((FRI, False), (MON, False), MON_FRI) == 3
    assert finish_shift_days((MON, True), (MON, False), MON_FRI) == 3
    # Without a calendar the shown days are diffed, as before.
    assert finish_shift_days((FRI, False), (MON, True), None) == 3


def test_sprint_boundary_slip_reads_a_milestone_finish_in_working_time() -> None:
    """A milestone at the start of the Monday after a Friday sprint end is on time."""
    from datetime import timedelta

    from trueppm_api.apps.projects.models import SprintState
    from trueppm_api.apps.projects.slip_conflict import _boundary_slip

    sprint = SimpleNamespace(state=SprintState.ACTIVE, finish_date=FRI)
    db_task = SimpleNamespace(sprint_id=1, sprint_pending=False, sprint=sprint, project_id="p")

    def sched(day_end: bool) -> SimpleNamespace:
        # An engine Task: no is_milestone, a milestone by its zero duration.
        return SimpleNamespace(
            early_finish=MON,
            duration=timedelta(0),
            milestone_at_day_end=day_end,
            actual_start=None,
            actual_finish=None,
            percent_complete=0.0,
        )

    cals = {"p": MON_FRI}
    assert _boundary_slip("t", db_task, {"t": sched(False)}, cals) is None
    assert _boundary_slip("t", db_task, {"t": sched(True)}, cals) == (sprint, MON)
    # No calendar: the shown day is compared, as before.
    assert _boundary_slip("t", db_task, {"t": sched(False)}) == (sprint, MON)


# ---------------------------------------------------------------------------
# End to end: a real CPM run, the snapshot, the notification, the activity row
# ---------------------------------------------------------------------------


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Mon-Fri")
    return Project.objects.create(
        name="WeekendHop",
        start_date=date(2026, 8, 3),  # Monday
        status_date=date(2026, 8, 3),
        calendar=cal,
        end_date_shift_threshold_days=1,
    )


@pytest.fixture
def network(project: Project) -> tuple[Task, Dependency]:
    """``A(5d, Mon..Fri) -FS-> M``: M is the project finish."""
    admin = User.objects.create_user(username="hop_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    a = Task.objects.create(project=project, name="A", duration=5)
    m = Task.objects.create(project=project, name="M", duration=0, is_milestone=True)
    dep = Dependency.objects.create(predecessor=a, successor=m, dep_type="FS")
    return m, dep


def _recompute_and_capture(project: Project, capture: Callable[..., Any]) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    with capture(execute=True):
        safe_capture_forecast_snapshot(project.pk, "recompute")


def _finish_deltas(task: Task) -> set[int | None]:
    return {
        e.detail["recalc_finish_delta_days"]
        for e in TaskActivityEvent.objects.filter(task_id=task.pk, event_type="cpm_recalculated")
    }


def _shift_notifications() -> int:
    return Notification.objects.filter(
        event_type=NotificationEventType.PROJECT_END_DATE_SHIFTED
    ).count()


@pytest.mark.django_db
def test_weekend_hop_of_the_shown_finish_emits_no_slip(
    project: Project,
    network: tuple[Task, Dependency],
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    m, dep = network
    _recompute_and_capture(project, django_capture_on_commit_callbacks)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (FRI, True)

    # A one-day lag lands M at Sunday midnight: non-working time, so it is shown
    # at the start of Monday (#4173). Same point in working time as Friday's end.
    Dependency.objects.filter(pk=dep.pk).update(lag=1)
    _recompute_and_capture(project, django_capture_on_commit_callbacks)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, False)

    snaps = list(
        ProjectForecastSnapshot.objects.filter(project=project)
        .order_by("captured_at")
        .values_list("cpm_finish", "cpm_finish_at_day_start")
    )
    assert snaps == [(FRI, False), (MON, True)]
    # The shown day moved three calendar days over a threshold of one, and
    # nothing moved in working time: no one is told the end date shifted.
    assert _shift_notifications() == 0
    # One row per recalculation: the first-ever run has no prior finish (None).
    assert _finish_deltas(m) == {None, 0}


@pytest.mark.django_db
def test_a_real_one_working_day_slip_still_notifies(
    project: Project,
    network: tuple[Task, Dependency],
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    m, dep = network
    _recompute_and_capture(project, django_capture_on_commit_callbacks)

    # Three days of lag end at Tuesday midnight, after Monday's work: shown at the
    # end of Monday, one working day later than Friday's end.
    Dependency.objects.filter(pk=dep.pk).update(lag=3)
    _recompute_and_capture(project, django_capture_on_commit_callbacks)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, True)

    assert _shift_notifications() == 1
    note = Notification.objects.get(event_type=NotificationEventType.PROJECT_END_DATE_SHIFTED)
    assert "pushed out by 3 days" in note.body
    assert _finish_deltas(m) == {None, 3}


@pytest.mark.django_db
def test_whatif_cpm_finish_delta_counts_a_move_the_shown_day_hides(
    project: Project, network: tuple[Task, Dependency]
) -> None:
    """The what-if endpoint's ``delta_vs_current.cpm_finish`` is in working time.

    With a one-day lag, M sits at the start of Monday: the end of Friday in working
    time. One more day on A ends A on Monday, and the lag now runs to Wednesday
    midnight, so M is at the end of Tuesday — two working days later. The shown day
    moved one calendar day (Mon -> Tue); in working time the finish moved from the
    end of Friday to the end of Tuesday, four calendar days.
    """
    from django.core.cache import cache
    from rest_framework.test import APIClient

    _m, dep = network
    Dependency.objects.filter(pk=dep.pk).update(lag=1)
    a = Task.objects.get(project=project, name="A")
    admin = User.objects.get(username="hop_admin")
    client = APIClient()
    client.force_authenticate(user=admin)
    cache.clear()
    res = client.get(
        f"/api/v1/projects/{project.pk}/monte-carlo/whatif/",
        {"task_id": str(a.pk), "duration_delta": "1", "n_simulations": "10"},
    )
    cache.clear()
    assert res.status_code == 200, res.data
    body = res.json()
    assert (body["current"]["cpm_finish"], body["whatif"]["cpm_finish"]) == (
        MON.isoformat(),
        TUE.isoformat(),
    )
    assert body["delta_vs_current"]["cpm_finish"] == 4


def test_fixture_dates_are_one_mon_fri_week() -> None:
    # Guards the fixture dates above: the whole file assumes this Mon-Fri week.
    assert [d.strftime("%a") for d in (FRI, SAT, MON, TUE)] == ["Fri", "Sat", "Mon", "Tue"]


# ---------------------------------------------------------------------------
# Unknown readings: rows written before the field existed (upgrade path)
# ---------------------------------------------------------------------------


def test_an_unknown_prior_reading_on_the_same_day_is_no_shift() -> None:
    # A pre-upgrade row cannot say which edge of Monday it meant; a same-day
    # comparison is no move rather than a phantom three-day pull-in.
    assert finish_shift_days((MON, None), (MON, True), MON_FRI) == 0
    assert finish_shift_days((MON, None), (MON, False), MON_FRI) == 0
    # On a different day the unknown side is read as the end of its day.
    assert finish_shift_days((FRI, None), (MON, True), MON_FRI) == 0
    assert finish_shift_days((FRI, None), (TUE, False), MON_FRI) == 4


@pytest.mark.django_db
def test_first_capture_after_upgrade_does_not_notify(
    project: Project,
    network: tuple[Task, Dependency],
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A pre-field snapshot (NULL reading) on the same shown day is not a shift."""
    from trueppm_api.apps.scheduling.services import notify_project_end_date_shift

    ProjectForecastSnapshot.objects.create(
        project=project, cpm_finish=MON, cpm_finish_at_day_start=None
    )
    new = ProjectForecastSnapshot.objects.create(
        project=project, cpm_finish=MON, cpm_finish_at_day_start=True
    )
    with django_capture_on_commit_callbacks(execute=True):
        notify_project_end_date_shift(new)
    assert _shift_notifications() == 0


# ---------------------------------------------------------------------------
# Milestone forecast digest and the sprint bridge card (/forecast/)
# ---------------------------------------------------------------------------


@pytest.fixture
def bound_sprint(project: Project, network: tuple[Task, Dependency]) -> Any:
    from trueppm_api.apps.projects.models import Sprint, SprintState

    m, _dep = network
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 8, 3),
        finish_date=date(2026, 8, 14),
        state=SprintState.ACTIVE,
        target_milestone=m,
    )


def _recompute_and_reforecast(
    project: Project, m: Task, sprint: Any, capture: Callable[..., Any]
) -> Any:
    from trueppm_api.apps.projects.services import (
        notify_milestone_forecast_shift,
        reforecast_bound_milestone,
    )

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    with capture(execute=True):
        snap = reforecast_bound_milestone(m.pk, broadcast=False)
        notify_milestone_forecast_shift(snap, sprint, actor_id=None)
    return snap


def _digests() -> int:
    return Notification.objects.filter(
        event_type=NotificationEventType.MILESTONE_FORECAST_SHIFTED
    ).count()


@pytest.mark.django_db
def test_milestone_digest_ignores_a_weekend_hop_and_the_bridge_reads_zero(
    project: Project,
    network: tuple[Task, Dependency],
    bound_sprint: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    from rest_framework.test import APIClient

    m, dep = network
    first = _recompute_and_reforecast(project, m, bound_sprint, django_capture_on_commit_callbacks)
    assert (first.cpm_finish, first.cpm_finish_at_day_start) == (FRI, False)
    baseline = _digests()  # the first forecast is itself news (#861)

    Dependency.objects.filter(pk=dep.pk).update(lag=1)
    second = _recompute_and_reforecast(project, m, bound_sprint, django_capture_on_commit_callbacks)
    assert (second.cpm_finish, second.cpm_finish_at_day_start) == (MON, True)
    assert _digests() == baseline

    # The bridge card's delta is supplied by the server, in working time.
    client = APIClient()
    client.force_authenticate(user=User.objects.get(username="hop_admin"))
    res = client.get(f"/api/v1/projects/{project.pk}/forecast/")
    assert res.status_code == 200, res.data
    row = next(r for r in res.json()["milestones"] if r["milestone_id"] == str(m.pk))
    assert row["cpm_finish"] == MON.isoformat()
    assert row["previous"]["cpm_finish"] == FRI.isoformat()
    assert row["previous"]["cpm_finish_at_day_start"] is False
    assert row["cpm_finish_at_day_start"] is True
    assert row["cpm_finish_shift_days"] == 0


@pytest.mark.django_db
def test_milestone_digest_still_reports_a_real_slip(
    project: Project,
    network: tuple[Task, Dependency],
    bound_sprint: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    from trueppm_api.apps.projects.services import project_forecast

    m, dep = network
    _recompute_and_reforecast(project, m, bound_sprint, django_capture_on_commit_callbacks)
    baseline = _digests()
    Dependency.objects.filter(pk=dep.pk).update(lag=3)  # the end of Monday
    _recompute_and_reforecast(project, m, bound_sprint, django_capture_on_commit_callbacks)
    assert _digests() > baseline
    row = next(s for s in project_forecast(project.pk)["milestones"] if s.milestone_id == m.pk)
    assert row.cpm_finish_shift_days == 3


# ---------------------------------------------------------------------------
# The program pass: activity delta and cross-project sprint-boundary conflicts
# ---------------------------------------------------------------------------


@pytest.fixture
def program_network(db: object) -> tuple[Any, Task, Dependency, Any]:
    """``A(5d) in project X -FS-> M in project Y``, M in Y's active sprint ending Friday."""
    from django.utils import timezone

    from trueppm_api.apps.projects.models import Program, Sprint, SprintState

    cal = Calendar.objects.create(name="Mon-Fri program")
    program = Program.objects.create(name="Hop program")
    kw: dict[str, Any] = dict(
        start_date=date(2026, 8, 3), status_date=date(2026, 8, 3), calendar=cal, program=program
    )
    proj_x = Project.objects.create(name="X", **kw)
    proj_y = Project.objects.create(name="Y", **kw)
    sprint = Sprint.objects.create(
        project=proj_y,
        name="Y sprint",
        start_date=date(2026, 8, 3),
        finish_date=FRI,
        state=SprintState.ACTIVE,
    )
    a = Task.objects.create(project=proj_x, name="A", duration=5)
    m = Task.objects.create(project=proj_y, name="M", duration=0, is_milestone=True, sprint=sprint)
    dep = Dependency.objects.create(
        predecessor=a, successor=m, dep_type="FS", lag=0, accepted_at=timezone.now()
    )
    return program, m, dep, sprint


def _run_program(program: Any) -> None:
    from trueppm_api.apps.scheduling.tasks import _run_program_schedule

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_program_schedule(str(program.pk))


@pytest.mark.django_db
def test_program_pass_weekend_hop_is_no_finish_delta_and_no_slip_conflict(
    program_network: tuple[Any, Task, Dependency, Any],
) -> None:
    from trueppm_api.apps.projects.models import CrossProjectSlipConflict

    program, m, dep, sprint = program_network
    _run_program(program)
    Dependency.objects.filter(pk=dep.pk).update(lag=1)
    _run_program(program)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, False)
    # graph.calendars reached the activity delta ...
    assert _finish_deltas(m) == {None, 0}
    # ... and the boundary check: Monday's start is Friday's end, inside the sprint.
    assert not CrossProjectSlipConflict.objects.filter(sprint=sprint, task=m).exists()


@pytest.mark.django_db
def test_program_pass_real_boundary_breach_still_raises_a_conflict(
    program_network: tuple[Any, Task, Dependency, Any],
) -> None:
    from trueppm_api.apps.projects.models import CrossProjectSlipConflict

    program, m, dep, sprint = program_network
    Dependency.objects.filter(pk=dep.pk).update(lag=3)  # the end of Monday
    _run_program(program)
    m.refresh_from_db()
    assert (m.early_finish, m.milestone_at_day_end) == (MON, True)
    assert CrossProjectSlipConflict.objects.filter(sprint=sprint, task=m).exists()
