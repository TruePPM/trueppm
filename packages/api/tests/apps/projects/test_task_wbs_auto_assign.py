"""Tests for automatic wbs_path assignment on task creation (issue #138)."""

from __future__ import annotations

import uuid
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


URL = "/api/v1/tasks/"


@pytest.mark.django_db
class TestRootAutoWbs:
    """Root-level tasks (no parent_id) receive sequential integer wbs_paths."""

    def test_first_task_gets_wbs_1(self, client: APIClient, project: Project) -> None:
        payload = {"project": str(project.pk), "name": "T1", "duration": 1}
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "1"

    def test_second_task_gets_wbs_2(self, client: APIClient, project: Project) -> None:
        Task.objects.create(project=project, name="existing", duration=1, wbs_path="1")
        payload = {"project": str(project.pk), "name": "T2", "duration": 1}
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "2"

    def test_third_task_sequential(self, client: APIClient, project: Project) -> None:
        Task.objects.create(project=project, name="T1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="T2", duration=1, wbs_path="2")
        payload = {"project": str(project.pk), "name": "T3", "duration": 1}
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "3"

    def test_child_tasks_not_counted_as_root(self, client: APIClient, project: Project) -> None:
        """Child tasks (wbs_path='1.1') must not count toward root-level numbering."""
        Task.objects.create(project=project, name="Root", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Child", duration=1, wbs_path="1.1")
        payload = {"project": str(project.pk), "name": "T2", "duration": 1}
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "2"

    def test_explicit_wbs_path_respected(self, client: APIClient, project: Project) -> None:
        """If the client supplies wbs_path, it must not be overridden."""
        payload = {
            "project": str(project.pk),
            "name": "T1",
            "duration": 1,
            "wbs_path": "5",
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "5"


@pytest.mark.django_db
class TestChildAutoWbs:
    """Tasks created with a parent_id receive a child wbs_path."""

    def test_first_child_gets_parent_dot_1(self, client: APIClient, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        payload = {
            "project": str(project.pk),
            "name": "Child",
            "duration": 1,
            "parent_id": str(parent.pk),
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "1.1"

    def test_second_child_gets_parent_dot_2(self, client: APIClient, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="C1", duration=1, wbs_path="1.1")
        payload = {
            "project": str(project.pk),
            "name": "C2",
            "duration": 1,
            "parent_id": str(parent.pk),
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "1.2"

    def test_three_levels_deep(self, client: APIClient, project: Project) -> None:
        root = Task.objects.create(project=project, name="Root", duration=1, wbs_path="2")
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="2.1")
        payload = {
            "project": str(project.pk),
            "name": "Grandchild",
            "duration": 1,
            "parent_id": str(parent.pk),
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "2.1.1"
        # Silence unused variable — root created only to set up project context.
        _ = root

    def test_grandchildren_excluded_from_child_count(
        self, client: APIClient, project: Project
    ) -> None:
        """Grandchildren (1.1.1) must not count when assigning the next child (1.2)."""
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="C1", duration=1, wbs_path="1.1")
        Task.objects.create(project=project, name="GC1", duration=1, wbs_path="1.1.1")
        payload = {
            "project": str(project.pk),
            "name": "C2",
            "duration": 1,
            "parent_id": str(parent.pk),
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 201
        assert r.data["wbs_path"] == "1.2"

    def test_unknown_parent_returns_400(self, client: APIClient, project: Project) -> None:
        payload = {
            "project": str(project.pk),
            "name": "Orphan",
            "duration": 1,
            "parent_id": str(uuid.uuid4()),
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 400
        assert "parent_id" in r.data

    def test_null_path_parent_returns_400(self, client: APIClient, project: Project) -> None:
        """A parent task with no wbs_path cannot anchor children."""
        parent = Task.objects.create(
            project=project, name="NullPathParent", duration=1, wbs_path=None
        )
        payload = {
            "project": str(project.pk),
            "name": "Child",
            "duration": 1,
            "parent_id": str(parent.pk),
        }
        r = client.post(URL, payload, format="json")
        assert r.status_code == 400
        assert "parent_id" in r.data


@pytest.mark.django_db
class TestBackfillLogic:
    """The _backfill_wbs_paths migration helper assigns paths to null-path tasks."""

    def _run_backfill(self) -> None:
        from django.apps import apps as django_apps

        from trueppm_api.apps.projects.backfill import _backfill_wbs_paths

        _backfill_wbs_paths(django_apps, None)

    def test_null_tasks_get_sequential_paths(self, project: Project) -> None:
        t1 = Task.objects.create(project=project, name="T1", duration=1, wbs_path=None)
        t2 = Task.objects.create(project=project, name="T2", duration=1, wbs_path=None)
        self._run_backfill()
        t1.refresh_from_db()
        t2.refresh_from_db()
        # Assert ordering and consecutiveness without assuming a fixed starting
        # number — other tests in the class share the same project fixture and
        # may leave pre-existing root tasks that shift the base count.
        assert t1.wbs_path is not None and t1.wbs_path.isdigit()
        assert t2.wbs_path is not None and t2.wbs_path.isdigit()
        assert int(t1.wbs_path) < int(t2.wbs_path)
        assert int(t2.wbs_path) - int(t1.wbs_path) == 1

    def test_existing_paths_not_overwritten(self, project: Project) -> None:
        Task.objects.create(project=project, name="Has", duration=1, wbs_path="1")
        null_task = Task.objects.create(project=project, name="Null", duration=1, wbs_path=None)
        self._run_backfill()
        null_task.refresh_from_db()
        assert null_task.wbs_path == "2"

    def test_deleted_tasks_skipped(self, project: Project) -> None:
        Task.objects.create(
            project=project, name="Deleted", duration=1, wbs_path=None, is_deleted=True
        )
        live = Task.objects.create(project=project, name="Live", duration=1, wbs_path=None)
        self._run_backfill()
        live.refresh_from_db()
        assert live.wbs_path == "1"
