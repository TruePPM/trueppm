"""Tests for wave 3 schedule features: assignee_is_overallocated annotation (#210)
and promote-unscheduled-task endpoint (#213)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def resource(db: object) -> Resource:
    return Resource.objects.create(name="Jane Smith")


# ---------------------------------------------------------------------------
# #210 — assignee_is_overallocated annotation
# ---------------------------------------------------------------------------


class TestAssigneeIsOverallocated:
    def _make_task(
        self,
        project: Project,
        user: object,
        name: str = "T",
        status: str = TaskStatus.IN_PROGRESS,
    ) -> Task:
        return Task.objects.create(
            project=project, name=name, duration=5, status=status, assignee=user
        )

    def test_false_when_no_resource_assignments(
        self, client: APIClient, project: Project, user: object
    ) -> None:
        task = self._make_task(project, user)
        resp = client.get(f"/api/v1/tasks/{task.id}/")
        assert resp.status_code == 200
        assert resp.data["assignee_is_overallocated"] is False

    def test_false_when_total_units_at_or_below_1(
        self, client: APIClient, project: Project, user: object, resource: Resource
    ) -> None:
        t1 = self._make_task(project, user, "T1")
        t2 = self._make_task(project, user, "T2")
        TaskResource.objects.create(task=t1, resource=resource, units=0.5)
        TaskResource.objects.create(task=t2, resource=resource, units=0.5)
        resp = client.get(f"/api/v1/tasks/{t1.id}/")
        assert resp.status_code == 200
        assert resp.data["assignee_is_overallocated"] is False

    def test_true_when_total_units_exceed_1(
        self, client: APIClient, project: Project, user: object, resource: Resource
    ) -> None:
        t1 = self._make_task(project, user, "T1")
        t2 = self._make_task(project, user, "T2")
        TaskResource.objects.create(task=t1, resource=resource, units=0.8)
        TaskResource.objects.create(task=t2, resource=resource, units=0.5)
        resp = client.get(f"/api/v1/tasks/{t1.id}/")
        assert resp.status_code == 200
        assert resp.data["assignee_is_overallocated"] is True

    def test_false_for_complete_tasks(
        self, client: APIClient, project: Project, user: object, resource: Resource
    ) -> None:
        """COMPLETE tasks are excluded from the overalloc sum."""
        t1 = self._make_task(project, user, "T1")
        t2 = self._make_task(project, user, "T2", status=TaskStatus.COMPLETE)
        TaskResource.objects.create(task=t1, resource=resource, units=0.6)
        TaskResource.objects.create(task=t2, resource=resource, units=0.8)
        resp = client.get(f"/api/v1/tasks/{t1.id}/")
        assert resp.status_code == 200
        assert resp.data["assignee_is_overallocated"] is False

    def test_false_when_no_assignee(self, client: APIClient, project: Project) -> None:
        task = Task.objects.create(project=project, name="Unassigned", duration=3)
        resp = client.get(f"/api/v1/tasks/{task.id}/")
        assert resp.status_code == 200
        assert resp.data["assignee_is_overallocated"] is False


# ---------------------------------------------------------------------------
# #213 — PATCH planned_start promotes an unscheduled task
# ---------------------------------------------------------------------------


class TestPromoteUnscheduledTask:
    def test_patch_planned_start_and_status(self, client: APIClient, project: Project) -> None:
        task = Task.objects.create(
            project=project,
            name="Parking lot item",
            duration=5,
            status=TaskStatus.BACKLOG,
        )
        assert task.planned_start is None

        resp = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"planned_start": "2026-05-12", "status": TaskStatus.NOT_STARTED},
            format="json",
        )
        assert resp.status_code == 200
        assert resp.data["planned_start"] == "2026-05-12"
        assert resp.data["status"] == TaskStatus.NOT_STARTED

        task.refresh_from_db()
        assert task.planned_start == date(2026, 5, 12)
        assert task.status == TaskStatus.NOT_STARTED

    def test_patch_planned_start_without_status_change(
        self, client: APIClient, project: Project
    ) -> None:
        task = Task.objects.create(
            project=project,
            name="Flexible task",
            duration=3,
            status=TaskStatus.NOT_STARTED,
        )
        # Use a future planned_start: a *past* date would (correctly) trip the
        # #336 date-gated NOT_STARTED → IN_PROGRESS auto-transition, which is not
        # what this test asserts. Computed relative to today so it never rots
        # (the prior hardcoded 2026-06-01 silently became a past date).
        future_start = timezone.localdate() + timedelta(days=30)
        resp = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"planned_start": future_start.isoformat()},
            format="json",
        )
        assert resp.status_code == 200
        assert resp.data["planned_start"] == future_start.isoformat()
        assert resp.data["status"] == TaskStatus.NOT_STARTED

    def test_patch_requires_authentication(self, project: Project) -> None:
        anon = APIClient()
        task = Task.objects.create(project=project, name="T", duration=1)
        resp = anon.patch(f"/api/v1/tasks/{task.id}/", {"planned_start": "2026-05-01"})
        assert resp.status_code in (401, 403)
