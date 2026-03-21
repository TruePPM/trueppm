"""API tests for the projects app CRUD endpoints."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="testuser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    """Grant the test user Owner access to the test project.

    Required for endpoints protected by ProjectScopedViewSet — without a
    ProjectMembership row the queryset is filtered to empty and the test user
    receives 404 on project-scoped resources.
    """
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Design", duration=5)


@pytest.mark.django_db
class TestCalendarAPI:
    def test_list(self, client: APIClient, calendar: Calendar) -> None:
        r = client.get("/api/v1/calendars/")
        assert r.status_code == 200
        assert len(r.data["results"]) >= 1

    def test_create(self, client: APIClient) -> None:
        r = client.post("/api/v1/calendars/", {"name": "Custom", "working_days": 31})
        assert r.status_code == 201
        assert r.data["name"] == "Custom"

    def test_retrieve(self, client: APIClient, calendar: Calendar) -> None:
        r = client.get(f"/api/v1/calendars/{calendar.pk}/")
        assert r.status_code == 200
        assert r.data["name"] == "Standard"

    def test_update(self, client: APIClient, calendar: Calendar) -> None:
        r = client.patch(f"/api/v1/calendars/{calendar.pk}/", {"hours_per_day": 9.0})
        assert r.status_code == 200
        assert r.data["hours_per_day"] == 9.0

    def test_delete(self, client: APIClient, project: Project, calendar: Calendar) -> None:
        # Remove the project referencing the calendar first to satisfy PROTECT.
        project.delete()
        r = client.delete(f"/api/v1/calendars/{calendar.pk}/")
        assert r.status_code == 204


@pytest.mark.django_db
class TestProjectAPI:
    def test_list(self, client: APIClient, project: Project, membership: ProjectMembership) -> None:
        r = client.get("/api/v1/projects/")
        assert r.status_code == 200
        assert any(p["name"] == "Alpha" for p in r.data["results"])

    def test_create(self, client: APIClient, calendar: Calendar) -> None:
        r = client.post(
            "/api/v1/projects/",
            {"name": "Beta", "start_date": "2026-04-01", "calendar": str(calendar.pk)},
        )
        assert r.status_code == 201
        assert r.data["name"] == "Beta"

    def test_retrieve(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.pk}/")
        assert r.status_code == 200
        assert r.data["name"] == "Alpha"

    def test_search(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.get("/api/v1/projects/?search=Alpha")
        assert r.status_code == 200
        assert len(r.data["results"]) >= 1

    def test_server_version_read_only(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.patch(f"/api/v1/projects/{project.pk}/", {"server_version": 999})
        assert r.status_code == 200
        # server_version must not be overwritten by the client
        assert r.data["server_version"] != 999


@pytest.mark.django_db
class TestTaskAPI:
    def test_list_by_project(
        self,
        client: APIClient,
        task: Task,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200
        assert any(t["name"] == "Design" for t in r.data["results"])

    def test_create(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        r = client.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 3},
        )
        assert r.status_code == 201
        assert r.data["duration"] == 3

    def test_cpm_fields_read_only(
        self, client: APIClient, task: Task, membership: ProjectMembership
    ) -> None:
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"early_start": "2026-01-01"})
        assert r.status_code == 200
        # CPM fields are read-only; early_start should stay None
        assert r.data["early_start"] is None

    def test_filter_is_critical(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        Task.objects.create(project=project, name="Critical T", duration=1, is_critical=True)
        r = client.get(f"/api/v1/tasks/?project={project.pk}&is_critical=true")
        assert r.status_code == 200
        assert all(t["is_critical"] is True for t in r.data["results"])


@pytest.mark.django_db
class TestDependencyAPI:
    def test_create_fs(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        t2 = Task.objects.create(project=project, name="Build", duration=3)
        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )
        assert r.status_code == 201
        assert r.data["dep_type"] == "FS"

    def test_filter_by_project(
        self,
        client: APIClient,
        project: Project,
        task: Task,
        membership: ProjectMembership,
    ) -> None:
        t2 = Task.objects.create(project=project, name="B", duration=2)
        Dependency.objects.create(predecessor=task, successor=t2)
        r = client.get(f"/api/v1/dependencies/?project={project.pk}")
        assert r.status_code == 200
        assert len(r.data["results"]) >= 1

    def test_cross_project_dependency_rejected(
        self, client: APIClient, calendar: Calendar, task: Task
    ) -> None:
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 4, 1), calendar=calendar
        )
        other_task = Task.objects.create(project=other_project, name="X", duration=1)
        r = client.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(other_task.pk), "dep_type": "FS"},
        )
        assert r.status_code == 400
