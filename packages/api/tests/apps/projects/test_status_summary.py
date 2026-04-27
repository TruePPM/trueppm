"""Tests for GET /api/v1/projects/<pk>/status-summary/ (issue #205)."""

from __future__ import annotations

import datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(user: object, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Test Project",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def tasks(project: Project) -> list[Task]:
    today = datetime.date(2026, 4, 27)
    return [
        Task.objects.create(
            project=project,
            name="Critical A",
            wbs_path="1",
            duration=5,
            is_critical=True,
            total_float=0,
            status=TaskStatus.IN_PROGRESS,
            early_start=today - datetime.timedelta(days=3),
            early_finish=today + datetime.timedelta(days=2),
        ),
        Task.objects.create(
            project=project,
            name="At Risk B",
            wbs_path="2",
            duration=5,
            is_critical=False,
            total_float=3,
            status=TaskStatus.IN_PROGRESS,
            early_start=today,
            early_finish=today + datetime.timedelta(days=5),
        ),
        Task.objects.create(
            project=project,
            name="Safe C",
            wbs_path="3",
            duration=10,
            is_critical=False,
            total_float=20,
            status=TaskStatus.NOT_STARTED,
            early_start=today + datetime.timedelta(days=5),
            early_finish=today + datetime.timedelta(days=15),
        ),
        Task.objects.create(
            project=project,
            name="Done D",
            wbs_path="4",
            duration=3,
            is_critical=True,
            total_float=0,
            status=TaskStatus.COMPLETE,
        ),
    ]


class TestStatusSummary:
    def test_returns_correct_counts(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_count"] == 4
        # critical_count excludes the COMPLETE task
        assert data["critical_count"] == 1
        # at_risk_count: total_float <= 5 and not COMPLETE (A + B)
        assert data["at_risk_count"] == 2

    def test_at_risk_tasks_list(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        assert resp.status_code == 200
        wbs_list = [t["wbs"] for t in resp.json()["at_risk_tasks"]]
        assert "1" in wbs_list
        assert "2" in wbs_list
        assert "3" not in wbs_list

    def test_critical_tasks_list(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        data = resp.json()
        wbs_list = [t["wbs"] for t in data["critical_tasks"]]
        # Only the non-COMPLETE critical task
        assert "1" in wbs_list
        assert "4" not in wbs_list

    def test_p80_is_null_until_mc_store(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.json()["monte_carlo_p80"] is None

    def test_timestamps_are_null(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        # Task model uses server_version, not auto_now timestamps; the response
        # surfaces null for both fields. The redesigned StatusBar (#201) does
        # not display them.
        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")
        data = resp.json()
        assert data["last_saved"] is None
        assert data["recalculated_at"] is None

    def test_requires_authentication(self, anon_client: APIClient, project: Project) -> None:
        resp = anon_client.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (401, 403)

    def test_non_member_forbidden(self, other_user: object, project: Project) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (403, 404)
