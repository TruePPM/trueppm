"""Tests for TaskResourceViewSet — overallocation warnings, RBAC, and broadcast events (#97)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

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
    return Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)


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
    return Resource.objects.create(
        name="Alice", email="alice@example.com", max_units=Decimal("1.0")
    )


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
        # The drawer Resources section reads resource_name from this payload —
        # without it the rows render blank (regression caught visually).
        assert r.data["resource_name"] == resource.name

    def test_list_includes_resource_name(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        """GET /task-resources/?task= must expose resource_name for drawer rendering."""
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        r = client.get(f"/api/v1/task-resources/?task={task.pk}")
        assert r.status_code == 200
        assert r.data["count"] == 1
        assert r.data["results"][0]["resource_name"] == resource.name

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


# ---------------------------------------------------------------------------
# RBAC and IDOR tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskResourceRBAC:
    """Viewer-role users may not create/update/delete assignments (role < SCHEDULER)."""

    def test_viewer_cannot_create_assignment(
        self,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        client: APIClient,
    ) -> None:
        """Viewer (role == Role.VIEWER) is blocked from creating an assignment — HTTP 403."""
        membership.role = Role.VIEWER
        membership.save()
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 403

    def test_resource_manager_can_create_assignment(
        self,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        client: APIClient,
    ) -> None:
        """Resource Manager (Role.SCHEDULER) is permitted to create an assignment — HTTP 201."""
        membership.role = Role.SCHEDULER
        membership.save()
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201


@pytest.mark.django_db
class TestTaskResourceIDOR:
    """List endpoint must not expose assignments from projects the user is not a member of."""

    def test_non_member_cannot_list_foreign_assignments(
        self,
        user: object,
        calendar: Calendar,
        resource: Resource,
    ) -> None:
        """An assignment in a project where the user has no membership is not visible."""
        User = get_user_model()
        User.objects.create_user(username="other", password="pw")
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 4, 1), calendar=calendar
        )
        other_task = Task.objects.create(project=other_project, name="T", duration=3)
        TaskResource.objects.create(task=other_task, resource=resource, units=Decimal("1.0"))

        # `user` has no membership in other_project; their client must see 0 results.
        c = APIClient()
        c.force_authenticate(user=user)
        r = c.get("/api/v1/task-resources/")
        assert r.status_code == 200
        assert r.data["count"] == 0


@pytest.mark.django_db
class TestAutoRosterOnAssignment:
    """Assigning a resource to a task auto-creates a ProjectResource row (#241)."""

    def test_creates_project_resource_on_assignment(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        project: Project,
    ) -> None:
        assert not ProjectResource.objects.filter(project=project, resource=resource).exists()
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert ProjectResource.objects.filter(project=project, resource=resource).exists()

    def test_idempotent_when_already_rostered(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        project: Project,
    ) -> None:
        ProjectResource.objects.create(project=project, resource=resource)
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert ProjectResource.objects.filter(project=project, resource=resource).count() == 1

    def test_clearing_assignment_does_not_remove_roster(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        project: Project,
    ) -> None:
        """Deleting a TaskResource leaves the resource on the project roster.

        Roster removal is an explicit PM action (via the roster UI); a single
        unassign should not silently drop the resource from Team views.
        """
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assignment_id = r.data["id"]
        del_r = client.delete(f"/api/v1/task-resources/{assignment_id}/")
        assert del_r.status_code == 204
        assert ProjectResource.objects.filter(project=project, resource=resource).exists()

    def test_repointing_assignment_rosters_new_resource(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        resource_50: Resource,
        project: Project,
    ) -> None:
        """PATCHing a TaskResource onto a different resource auto-rosters that resource (#241)."""
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assignment_id = r.data["id"]

        assert not ProjectResource.objects.filter(project=project, resource=resource_50).exists()
        patch_r = client.patch(
            f"/api/v1/task-resources/{assignment_id}/",
            {"resource": str(resource_50.pk)},
        )
        assert patch_r.status_code == 200
        assert ProjectResource.objects.filter(project=project, resource=resource_50).exists()


# ---------------------------------------------------------------------------
# TaskResource.project_id property
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_resource_project_id_property(
    task: Task,
    resource: Resource,
    project: Project,
) -> None:
    """project_id property exposes task.project_id for CanAssignResource RBAC resolution.

    TaskResource has no direct FK to Project — the permission class calls
    _get_project_id_from_obj which walks obj.project_id. This test ensures
    the property is wired correctly so the permission check never silently
    returns the wrong project or raises AttributeError.
    """
    tr = TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
    assert tr.project_id == task.project_id
    assert tr.project_id == project.pk


@pytest.mark.django_db
class TestTaskResourceActivityEvents:
    """TaskResourceViewSet writes TaskActivityEvent audit rows (ADR-0394, #1886).

    Rows are written synchronously in the request transaction (not on_commit), so they
    are asserted directly without needing transaction=True.
    """

    def _events(self, task: Task, event_type: str) -> list:
        from trueppm_api.apps.projects.models import TaskActivityEvent

        return list(TaskActivityEvent.objects.filter(task=task, event_type=event_type))

    def test_create_emits_assignee_added(
        self,
        client: APIClient,
        user: object,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        events = self._events(task, "assignee_added")
        assert len(events) == 1
        ev = events[0]
        assert ev.actor_id == user.pk  # the acting member, never null
        assert ev.detail["resource_id"] == str(resource.pk)
        assert ev.detail["resource_name"] == "Alice"
        assert ev.detail["units"] == "1.00"

    def test_units_change_emits_assignee_units_changed(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        assignment = TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        r = client.patch(f"/api/v1/task-resources/{assignment.pk}/", {"units": "0.5"})
        assert r.status_code == 200
        events = self._events(task, "assignee_units_changed")
        assert len(events) == 1
        assert events[0].detail["units"] == {"from": "1.00", "to": "0.50"}
        # A units-only change must NOT masquerade as an add or remove.
        assert not self._events(task, "assignee_removed")
        assert not self._events(task, "assignee_added")

    def test_resource_repoint_emits_removed_then_added(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
        resource_50: Resource,
    ) -> None:
        assignment = TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.5"))
        r = client.patch(
            f"/api/v1/task-resources/{assignment.pk}/",
            {"resource": str(resource_50.pk), "units": "0.5"},
        )
        assert r.status_code == 200
        removed = self._events(task, "assignee_removed")
        added = self._events(task, "assignee_added")
        assert len(removed) == 1
        assert removed[0].detail["resource_name"] == "Alice"  # the old resource
        assert len(added) == 1
        assert added[0].detail["resource_name"] == "Bob"  # the new resource
        # A re-point is not an allocation change.
        assert not self._events(task, "assignee_units_changed")

    def test_delete_emits_assignee_removed(
        self,
        client: APIClient,
        user: object,
        membership: ProjectMembership,
        task: Task,
        resource: Resource,
    ) -> None:
        assignment = TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
        r = client.delete(f"/api/v1/task-resources/{assignment.pk}/")
        assert r.status_code == 204
        events = self._events(task, "assignee_removed")
        assert len(events) == 1
        assert events[0].actor_id == user.pk
        assert events[0].detail["resource_name"] == "Alice"
        assert events[0].detail["units"] == "1.00"
