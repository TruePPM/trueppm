"""Tests for automatic wbs_path assignment on task creation (issue #138)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="wbsuser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(user: object, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="WBS Test Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.mark.django_db
class TestAutoWbsAssignment:
    URL = "/api/v1/tasks/"

    def test_first_task_gets_wbs_1(self, client: APIClient, project: Project) -> None:
        payload = {"project": str(project.pk), "name": "T1", "duration": 1}
        r = client.post(self.URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "1"

    def test_second_task_gets_wbs_2(self, client: APIClient, project: Project) -> None:
        Task.objects.create(project=project, name="existing", duration=1, wbs_path="1")
        payload = {"project": str(project.pk), "name": "T2", "duration": 1}
        r = client.post(self.URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "2"

    def test_third_task_sequential(self, client: APIClient, project: Project) -> None:
        Task.objects.create(project=project, name="T1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="T2", duration=1, wbs_path="2")
        payload = {"project": str(project.pk), "name": "T3", "duration": 1}
        r = client.post(self.URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "3"

    def test_child_tasks_not_counted_as_root(self, client: APIClient, project: Project) -> None:
        """Child tasks (wbs_path='1.1') must not count toward root-level numbering."""
        Task.objects.create(project=project, name="Root", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Child", duration=1, wbs_path="1.1")
        payload = {"project": str(project.pk), "name": "T2", "duration": 1}
        r = client.post(self.URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "2"

    def test_explicit_wbs_path_respected(self, client: APIClient, project: Project) -> None:
        """If the client supplies wbs_path, it must not be overridden."""
        r = client.post(
            self.URL,
            {"project": str(project.pk), "name": "T1", "duration": 1, "wbs_path": "5"},
            format="json",
        )
        assert r.status_code == 201
        assert r.data["wbs_path"] == "5"
