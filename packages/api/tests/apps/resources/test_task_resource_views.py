"""Tests for TaskResourceViewSet — overallocation warnings and broadcast events (#97)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, call, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="resuser", password="pw")


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
    return Project.objects.create(
        name="Beta", start_date=date(2026, 4, 1), calendar=calendar
    )


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(
        project=project,
        name="Design",
        duration=5,
        early_start=date(2026, 4, 1),
        early_finish=date(2026, 4, 5),
    )


@pytest.fixture
def resource(db: object) -> Resource:
    """Resource at 100% capacity."""
    return Resource.objects.create(name="Alice", email="alice@example.com", max_units=Decimal("1.0"))


@pytest.fixture
def resource_50(db: object) -> Resource:
    """Resource capped at 50% capacity."""
    return Resource.objects.create(name="Bob", email="bob@example.com", max_units=Decimal("0.5"))


# ---------------------------------------------------------------------------
# Overallocation warning tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskResourceCreateWarnings:
    """POST /api/v1/task-resources/ — 201 with warnings array."""

    def test_no_warning_within_capacity(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        """Assigning at 100% to a resource with 100% capacity: no warning."""
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert r.data["warnings"] == []

    def test_warning_when_overallocated(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource_50: Resource,
        project: Project,
    ) -> None:
        """Assigning 100% to a 50%-capacity resource returns an overallocation warning."""
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource_50.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert len(r.data["warnings"]) == 1
        warning = r.data["warnings"][0]
        assert warning["code"] == "resource_overallocated"
        assert warning["resource_id"] == str(resource_50.pk)
        assert warning["resource_name"] == resource_50.name

    def test_complete_tasks_excluded_from_sum(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource_50: Resource,
    ) -> None:
        """COMPLETE tasks do not count toward the overallocation sum."""
        # Create a COMPLETE task and assign the resource at 100% to it.
        complete_task = Task.objects.create(
            project=project,
            name="Done",
            duration=3,
            status="COMPLETE",
        )
        TaskResource.objects.create(task=complete_task, resource=resource_50, units=Decimal("1.0"))

        # Now assign the resource to a new active task at 50% — should be within capacity.
        active_task = Task.objects.create(project=project, name="Active", duration=5)
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(active_task.pk), "resource": str(resource_50.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        assert r.data["warnings"] == []

    def test_multiple_active_tasks_trigger_warning(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource: Resource,
    ) -> None:
        """Resource assigned >100% across two active tasks triggers a warning on the second."""
        task_a = Task.objects.create(project=project, name="Task A", duration=5)
        task_b = Task.objects.create(project=project, name="Task B", duration=5)

        # First assignment at 80% — under the 100% cap, no warning.
        r1 = client.post(
            "/api/v1/task-resources/",
            {"task": str(task_a.pk), "resource": str(resource.pk), "units": "0.8"},
        )
        assert r1.status_code == 201
        assert r1.data["warnings"] == []

        # Second assignment at 50% — total 130% > 100%, triggers warning.
        r2 = client.post(
            "/api/v1/task-resources/",
            {"task": str(task_b.pk), "resource": str(resource.pk), "units": "0.5"},
        )
        assert r2.status_code == 201
        assert len(r2.data["warnings"]) == 1
        assert r2.data["warnings"][0]["code"] == "resource_overallocated"

    def test_assignment_saved_regardless_of_warning(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource_50: Resource,
    ) -> None:
        """Overallocation is a soft warning — the TaskResource row is still created."""
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource_50.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert TaskResource.objects.filter(task=task, resource=resource_50).exists()


# ---------------------------------------------------------------------------
# Broadcast event tests
# ---------------------------------------------------------------------------


BROADCAST_PATH = "trueppm_api.apps.sync.broadcast.broadcast_board_event"


@pytest.mark.django_db(transaction=True)
class TestTaskResourceBroadcast:
    """Verify assignment_created/updated/deleted events fire via broadcast_board_event."""

    def test_assignment_created_broadcast(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        with patch(BROADCAST_PATH) as mock_broadcast:
            r = client.post(
                "/api/v1/task-resources/",
                {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
            )
        assert r.status_code == 201
        mock_broadcast.assert_called_once()
        event_type = mock_broadcast.call_args[0][1]
        assert event_type == "assignment_created"
        payload = mock_broadcast.call_args[0][2]
        assert payload["task_id"] == str(task.pk)

    def test_assignment_updated_broadcast(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        assignment = TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        with patch(BROADCAST_PATH) as mock_broadcast:
            r = client.patch(
                f"/api/v1/task-resources/{assignment.pk}/",
                {"units": "0.5"},
            )
        assert r.status_code == 200
        event_types = [c[0][1] for c in mock_broadcast.call_args_list]
        assert "assignment_updated" in event_types

    def test_assignment_deleted_broadcast(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        assignment = TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        with patch(BROADCAST_PATH) as mock_broadcast:
            r = client.delete(f"/api/v1/task-resources/{assignment.pk}/")
        assert r.status_code == 204
        event_types = [c[0][1] for c in mock_broadcast.call_args_list]
        assert "assignment_deleted" in event_types
