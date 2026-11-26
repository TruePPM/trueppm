"""``headline_forecast_kind`` / ``headline_forecast_reason`` (ADR-1485 D4, #5130)."""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Program,
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    Sprint,
    SprintCloseRequest,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.scheduling.headline_forecast import (
    dependency_linked_share,
    note_headline_forecast_kind,
    project_headline_forecast,
)
from trueppm_api.apps.scheduling.models import HeadlineForecastState

User = get_user_model()

DISPATCH = "trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Headline", start_date=date(2026, 1, 1), calendar=calendar)


def _velocity_history(project: Project) -> None:
    """Three closed sprints and a committed backlog: velocity-basis forecast values.

    Call after :func:`_tasks`; those tasks become the active sprint's backlog.
    """
    active = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.ACTIVE,
    )
    Task.objects.filter(project=project).update(sprint=active)
    for i, points in enumerate([18, 20, 22]):
        Sprint.objects.create(
            project=project,
            name=f"S{i}",
            start_date=date(2026, 1, 1),
            finish_date=date(2026, 1, 14),
            state=SprintState.COMPLETED,
            committed_points=points,
            completed_points=points,
            committed_task_count=points,
            completed_task_count=points,
            closed_at=timezone.now(),
        )


def _tasks(project: Project, n: int, **extra: Any) -> list[Task]:
    """``n`` scheduled leaf tasks that also form the points backlog."""
    return [
        Task.objects.create(
            project=project,
            name=f"T{i}",
            duration=1,
            story_points=13,
            status=TaskStatus.NOT_STARTED,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
            **extra,
        )
        for i in range(n)
    ]


def _link(a: Task, b: Task) -> None:
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=0)


def test_team_velocity_when_the_network_is_sparse(project: Project) -> None:
    _tasks(project, 5)
    _velocity_history(project)

    assert project_headline_forecast(project.pk) == (
        "team_velocity",
        "sparse_dependency_network",
    )


@pytest.mark.parametrize(
    ("total", "expected"),
    [
        # 2 of 4 linked is exactly half: not "fewer than half".
        (4, ("cpm_monte_carlo", "dependency_network")),
        # 2 of 5 is below it.
        (5, ("team_velocity", "sparse_dependency_network")),
    ],
)
def test_threshold_boundary(project: Project, total: int, expected: tuple[str, str]) -> None:
    tasks = _tasks(project, total)
    _velocity_history(project)
    _link(tasks[0], tasks[1])

    assert project_headline_forecast(project.pk) == expected


def test_no_sprints(project: Project) -> None:
    _tasks(project, 3)

    assert project_headline_forecast(project.pk) == ("cpm_monte_carlo", "no_sprints")


def test_no_scheduled_tasks(project: Project) -> None:
    _velocity_history(project)

    assert project_headline_forecast(project.pk) == ("cpm_monte_carlo", "no_scheduled_tasks")


def test_without_velocity_values_it_stays_on_cpm(project: Project) -> None:
    Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.ACTIVE,
    )
    _tasks(project, 3)

    assert project_headline_forecast(project.pk) == ("cpm_monte_carlo", "no_velocity_forecast")


def test_a_summary_link_counts_its_leaves_and_summaries_are_not_counted(
    project: Project,
) -> None:
    summary, first, second, other = _tasks(project, 4)
    for task, path in ((summary, "1"), (first, "1.1"), (second, "1.2"), (other, "2")):
        Task.objects.filter(pk=task.pk).update(wbs_path=path)
    _link(summary, other)

    assert dependency_linked_share(project.pk) == (3, 3)


def _client(project: Project, role: int) -> APIClient:
    user = User.objects.create_user(username=f"u-{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_endpoint_serves_the_kind_to_the_velocity_audience(project: Project) -> None:
    _tasks(project, 5)
    _velocity_history(project)

    data = _client(project, Role.MEMBER).get(f"/api/v1/projects/{project.pk}/forecast/").data

    assert data["headline_forecast_kind"] == "team_velocity"
    assert data["headline_forecast_reason"] == "sparse_dependency_network"


@pytest.mark.parametrize("with_velocity", [True, False])
def test_below_audience_always_reads_velocity_withheld(
    project: Project, with_velocity: bool
) -> None:
    """The same answer whether or not a velocity forecast exists, so nothing leaks."""
    if with_velocity:
        _tasks(project, 5)
    _velocity_history(project)

    # ADMIN is below the velocity audience by default (ADR-0104).
    data = _client(project, Role.ADMIN).get(f"/api/v1/projects/{project.pk}/forecast/").data

    assert data["headline_forecast_kind"] == "cpm_monte_carlo"
    assert data["headline_forecast_reason"] == "velocity_withheld"


def test_a_change_of_kind_emits_schedule_finish_changed_once(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    _share_velocity(project)
    tasks = _tasks(project, 5)

    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is False  # first observation
    dispatch.assert_not_called()
    assert HeadlineForecastState.objects.get(project=project).kind == "cpm_monte_carlo"

    _velocity_history(project)
    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is True
        assert note_headline_forecast_kind(project.pk) is False  # unchanged
    dispatch.assert_called_once()
    assert dispatch.call_args.args[:2] == (str(project.pk), "schedule.finish_changed")

    _link(tasks[0], tasks[1])
    _link(tasks[2], tasks[3])
    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is True
    assert HeadlineForecastState.objects.get(project=project).kind == "cpm_monte_carlo"


def _share_velocity(project: Project) -> None:
    ProjectSignalPrivacyPolicy.objects.create(
        project=project,
        signal_visibility={
            "velocity": {
                "audience": SignalAudience.PROGRAM_SHARED,
                "ceiling": SignalAudience.PROGRAM_SHARED,
            }
        },
    )


def test_no_event_is_dispatched_unless_velocity_is_shared_outward(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Webhook registrants are Admin+, below the default TEAM velocity audience.

    Even a blanked event would count the switches, so none is sent. The recorded
    kind still moves, and sharing later replays nothing.
    """
    _tasks(project, 5)
    note_headline_forecast_kind(project.pk)
    _velocity_history(project)

    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is False
    dispatch.assert_not_called()
    assert HeadlineForecastState.objects.get(project=project).kind == "team_velocity"

    _share_velocity(project)
    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is False
    dispatch.assert_not_called()


def test_the_webhook_names_the_kind_when_velocity_is_shared_outward(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    _share_velocity(project)
    _tasks(project, 5)
    note_headline_forecast_kind(project.pk)
    _velocity_history(project)

    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is True

    dispatch.assert_called_once()
    assert dispatch.call_args.args[2] == {
        "project": str(project.pk),
        # Finish shift since the previous check, in working days (ADR-1485 D6).
        "finish_delta_working_days": 0,
        "velocity_suppressed": False,
        "headline_forecast_kind": "team_velocity",
        "headline_forecast_reason": "sparse_dependency_network",
        "previous_headline_forecast_kind": "cpm_monte_carlo",
    }


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("row_exists", [True, False], ids=["row-lock", "first-insert"])
def test_the_kind_is_computed_after_the_state_row_is_locked(
    project: Project, row_exists: bool
) -> None:
    """A concurrent check records a newer kind while this one waits for the row.

    Computing before the lock would carry the older kind past the wait, write it
    back over the newer one and announce a switch that never happened.
    """
    _share_velocity(project)
    if row_exists:
        HeadlineForecastState.objects.create(project=project, kind="cpm_monte_carlo")
    truth = ["cpm_monte_carlo"]
    outcome: list[bool] = []

    def check() -> None:
        try:
            outcome.append(note_headline_forecast_kind(project.pk))
        finally:
            connection.close()

    worker = threading.Thread(target=check)
    with (
        patch(
            "trueppm_api.apps.scheduling.headline_forecast.project_headline_forecast",
            side_effect=lambda _pid: (truth[0], "reason"),
        ),
        patch(DISPATCH) as dispatch,
    ):
        with transaction.atomic():
            # The other caller: holds the row (or its uncommitted first insert).
            state, _ = HeadlineForecastState.objects.select_for_update().get_or_create(
                project=project, defaults={"kind": "cpm_monte_carlo"}
            )
            worker.start()
            _wait_for_a_blocked_backend()
            truth[0] = "team_velocity"
            state.kind = "team_velocity"
            state.save(update_fields=["kind", "updated_at"])
        worker.join(timeout=10)

    assert not worker.is_alive()
    assert outcome == [False]
    dispatch.assert_not_called()
    assert HeadlineForecastState.objects.get(project=project).kind == "team_velocity"


def _wait_for_a_blocked_backend() -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            # Activity stats are snapshotted per transaction: drop the snapshot.
            cursor.execute("SELECT pg_stat_clear_snapshot()")
            cursor.execute(
                "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() "
                "AND wait_event_type = 'Lock'"
            )
            if cursor.fetchone():
                return
        time.sleep(0.02)
    raise AssertionError("the concurrent check never blocked on the state row")


def test_a_sprint_close_checks_the_kind(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """The close adds the velocity sample that makes the project forecast by velocity."""
    from trueppm_api.apps.projects.tasks import close_sprint

    _share_velocity(project)
    _tasks(project, 5)
    # The remaining backlog is what sits in not-yet-closed sprints.
    backlog = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.filter(project=project).update(sprint=backlog)
    closing = Sprint.objects.create(
        project=project,
        name="Closing",
        start_date=date(2026, 2, 1),
        finish_date=date(2026, 2, 14),
        state=SprintState.ACTIVE,
        committed_points=20,
        committed_task_count=1,
    )
    Sprint.objects.create(
        project=project,
        name="Done",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
        committed_points=18,
        completed_points=18,
        committed_task_count=1,
        completed_task_count=1,
        closed_at=timezone.now(),
    )
    Task.objects.create(
        project=project,
        name="Delivered",
        duration=1,
        story_points=20,
        sprint=closing,
        status=TaskStatus.COMPLETE,
    )
    note_headline_forecast_kind(project.pk)
    assert HeadlineForecastState.objects.get(project=project).kind == "cpm_monte_carlo"
    request = SprintCloseRequest.objects.create(sprint=closing, carry_over_to="backlog")

    redis = MagicMock()
    redis.set.return_value = True
    with (
        patch("trueppm_api.core.idempotent.valkey") as valkey,
        patch(DISPATCH) as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        valkey.client.return_value = redis
        close_sprint.run(str(request.id))

    assert HeadlineForecastState.objects.get(project=project).kind == "team_velocity"
    assert "schedule.finish_changed" in [c.args[1] for c in dispatch.call_args_list]


def test_a_program_recalculation_checks_every_member(project: Project) -> None:
    from trueppm_api.apps.scheduling.tasks import recalculate_program_schedule

    program = Program.objects.create(name="Program")
    other = Project.objects.create(
        name="Other", start_date=date(2026, 1, 1), calendar=project.calendar, program=program
    )
    Project.objects.filter(pk=project.pk).update(program=program)
    (first,) = _tasks(project, 1)
    (second,) = _tasks(other, 1)
    Dependency.objects.create(
        predecessor=first, successor=second, dep_type="FS", lag=0, accepted_at=timezone.now()
    )

    assert recalculate_program_schedule.apply(args=[str(program.pk)]).successful()

    assert set(HeadlineForecastState.objects.values_list("project_id", flat=True)) == {
        project.pk,
        other.pk,
    }


def test_a_recalculation_checks_the_kind(project: Project) -> None:
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    _tasks(project, 2)

    recalculate_schedule.apply(args=[str(project.pk)])

    assert HeadlineForecastState.objects.get(project=project).kind == "cpm_monte_carlo"


def test_a_failing_check_never_raises(project: Project) -> None:
    with patch(
        "trueppm_api.apps.scheduling.headline_forecast.project_headline_forecast",
        side_effect=RuntimeError("boom"),
    ):
        assert note_headline_forecast_kind(project.pk) is False
