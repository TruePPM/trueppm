"""Backlog delivery forecast — velocity Monte Carlo read (#487).

``sprint_forecast`` reuses the velocity series + remaining committed backlog and
runs a velocity-bootstrap Monte Carlo for P50/P80 sprint counts + calendar dates.
The endpoint is gated like /velocity/ and /forecast/ (ADR-0104).
"""

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
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import sprint_forecast

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="SfProject", start_date=date(2026, 1, 1), calendar=cal)


@pytest.fixture
def admin(project: Project) -> Any:
    user = User.objects.create_user(username="sf_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def client(admin: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


def _closed_sprint(project: Project, name: str, completed: int) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),  # 13-day span → ~fortnight pacing
        state=SprintState.COMPLETED,
        committed_points=completed,
        completed_points=completed,
        committed_task_count=completed,
        completed_task_count=completed,
        closed_at=timezone.now(),
    )


def _backlog(project: Project, total_points: int) -> Sprint:
    sprint = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.ACTIVE,
    )
    # Split the backlog across a few not-started tasks committed to the sprint.
    per = total_points // 3
    for i in range(3):
        Task.objects.create(
            project=project,
            name=f"Backlog {i}",
            duration=1,
            sprint=sprint,
            story_points=per,
            status=TaskStatus.NOT_STARTED,
        )
    return sprint


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sprint-forecast/"


@pytest.mark.django_db
def test_warming_up_with_fewer_than_two_closed_sprints(project: Project) -> None:
    _closed_sprint(project, "S1", 20)
    _backlog(project, 60)
    result = sprint_forecast(project.pk)
    assert result["status"] == "warming_up"
    assert result["p50_sprints"] is None
    assert result["basis"] == "monte_carlo"


@pytest.mark.django_db
def test_warming_up_with_no_backlog(project: Project) -> None:
    for i in range(3):
        _closed_sprint(project, f"S{i}", 20)
    result = sprint_forecast(project.pk)
    assert result["status"] == "warming_up"
    assert result["remaining_points"] == 0


@pytest.mark.django_db
def test_ready_forecast_p80_not_sooner_than_p50(project: Project) -> None:
    for name, pts in [("S1", 18), ("S2", 20), ("S3", 22)]:
        _closed_sprint(project, name, pts)
    _backlog(project, 60)  # ~20 pts/sprint → ~3 sprints
    result = sprint_forecast(project.pk)
    assert result["status"] == "ready"
    assert result["sample_count"] == 3
    assert result["remaining_points"] == 60
    assert 2 <= result["p50_sprints"] <= 5
    assert result["p80_sprints"] >= result["p50_sprints"]
    # P80 date is never earlier than P50 date.
    assert result["p80_date"] >= result["p50_date"]
    assert result["p50_date"] > timezone.localdate().isoformat()


@pytest.mark.django_db
def test_endpoint_requires_project_membership(project: Project) -> None:
    outsider = User.objects.create_user(username="sf_outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    assert c.get(_url(project)).status_code == 403


@pytest.mark.django_db
def test_endpoint_returns_ready_forecast(client: APIClient, project: Project) -> None:
    for name, pts in [("S1", 18), ("S2", 20), ("S3", 22)]:
        _closed_sprint(project, name, pts)
    _backlog(project, 60)
    resp = client.get(_url(project))
    assert resp.status_code == 200, resp.data
    body = resp.data
    assert body["status"] == "ready"
    assert body["basis"] == "monte_carlo"
    assert body["velocity_suppressed"] is False
    assert body["p50_sprints"] is not None
    assert body["p50_date"] is not None


@pytest.mark.django_db
def test_endpoint_suppresses_for_below_velocity_audience(
    client: APIClient, project: Project
) -> None:
    for name, pts in [("S1", 18), ("S2", 20), ("S3", 22)]:
        _closed_sprint(project, name, pts)
    _backlog(project, 60)
    # A reader below the velocity audience (ADR-0104) must not get the backlog
    # horizon — it is reversible into the team's throughput.
    with patch(
        "trueppm_api.apps.projects.signal_privacy_services.can_read_signal",
        return_value=False,
    ):
        resp = client.get(_url(project))
    assert resp.status_code == 200, resp.data
    assert resp.data["velocity_suppressed"] is True
    assert resp.data["p50_sprints"] is None
    assert resp.data["p50_date"] is None
    assert resp.data["remaining_points"] is None
    # The closed-sprint count and a "ready" status are themselves team-private
    # organisational facts (ADR-0104) — withheld too.
    assert resp.data["sample_count"] is None
    assert resp.data["status"] == "warming_up"
