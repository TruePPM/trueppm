"""``headline_forecast_kind`` / ``headline_forecast_reason`` (ADR-1485 D4, #5130)."""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Sprint,
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
    tasks = _tasks(project, 5)

    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is False  # first observation
    dispatch.assert_not_called()
    assert HeadlineForecastState.objects.get(project=project).kind == "cpm_monte_carlo"

    _velocity_history(project)
    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is True
        assert note_headline_forecast_kind(project.pk) is False  # unchanged
    dispatch.assert_called_once_with(
        str(project.pk),
        "schedule.finish_changed",
        {
            "project": str(project.pk),
            "headline_forecast_kind": "team_velocity",
            "headline_forecast_reason": "sparse_dependency_network",
            "previous_headline_forecast_kind": "cpm_monte_carlo",
        },
    )

    _link(tasks[0], tasks[1])
    _link(tasks[2], tasks[3])
    with patch(DISPATCH) as dispatch, django_capture_on_commit_callbacks(execute=True):
        assert note_headline_forecast_kind(project.pk) is True
    assert dispatch.call_args.args[2]["headline_forecast_kind"] == "cpm_monte_carlo"


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
