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
# Bare-assignee fallback tests (#3047 — read-side half of #2718/#2900)
#
# A task whose only assignment signal is Task.assignee (no TaskResource row)
# must not silently contribute zero load to _check_overallocation once the
# Resource is linked to that assignee's user account via Resource.user.
# ---------------------------------------------------------------------------


@pytest.fixture
def assignee_user(db: object) -> object:
    """A second user, distinct from the API caller, to act as Task.assignee."""
    User = get_user_model()
    return User.objects.create_user(username="carol", password="pw")


@pytest.fixture
def resource_with_user(assignee_user: object, db: object) -> Resource:
    """A 100%-capacity resource linked to assignee_user via Resource.user."""
    return Resource.objects.create(
        name="Carol", email="carol@example.com", max_units=Decimal("1.0"), user=assignee_user
    )


@pytest.mark.django_db
class TestTaskResourceBareAssigneeFallback:
    """POST /api/v1/task-resources/ — bare Task.assignee folded into the sum."""

    def test_bare_assignee_task_counts_toward_overallocation(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        assignee_user: object,
        resource_with_user: Resource,
    ) -> None:
        """A bare-assignee task (no TaskResource row) counts at full units.

        Carol already carries a full-time (1.0-unit) bare-assignee task with no
        TaskResource row. Assigning her to a second task at even 50% via a real
        TaskResource row must push the total past her 100% capacity and surface
        both the unit-tracking caveat and the overallocation warning.
        """
        Task.objects.create(project=project, name="Untracked", duration=5, assignee=assignee_user)
        new_task = Task.objects.create(project=project, name="Tracked", duration=5)

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(new_task.pk), "resource": str(resource_with_user.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        codes = {w["code"] for w in r.data["warnings"]}
        assert codes == {"assignment_not_unit_tracked", "resource_overallocated"}
        tracking_warning = next(
            w for w in r.data["warnings"] if w["code"] == "assignment_not_unit_tracked"
        )
        assert tracking_warning["resource_id"] == str(resource_with_user.pk)

    def test_bare_assignee_task_ignored_without_linked_user(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource: Resource,
        user: object,
    ) -> None:
        """A bare-assignee task cannot be correlated when Resource.user is unset.

        resource (Alice) has no linked user account, so a bare-assignee task —
        even one assigned to the API caller — must not be folded in: behavior
        is unchanged from before #3047.
        """
        Task.objects.create(project=project, name="Untracked", duration=5, assignee=user)
        new_task = Task.objects.create(project=project, name="Tracked", duration=5)

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(new_task.pk), "resource": str(resource.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert r.data["warnings"] == []

    def test_bare_assignee_task_not_double_counted_with_taskresource_row(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        assignee_user: object,
        resource_with_user: Resource,
    ) -> None:
        """A task with BOTH assignee and a TaskResource row counts once, not twice.

        Regression guard for the already-working #2718/#2900 write-side fix:
        once a task has a real TaskResource row, the bare-assignee fallback
        must not add a second, phantom allocation for the same task.
        """
        tracked_task = Task.objects.create(
            project=project, name="Both", duration=5, assignee=assignee_user
        )
        TaskResource.objects.create(
            task=tracked_task, resource=resource_with_user, units=Decimal("0.6")
        )
        new_task = Task.objects.create(project=project, name="Second", duration=5)

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(new_task.pk), "resource": str(resource_with_user.pk), "units": "0.3"},
        )
        assert r.status_code == 201
        # 0.6 (tracked) + 0.3 (new) = 0.9 <= 1.0 capacity — no warnings at all,
        # proving the already-tracked task was not also folded in via the
        # bare-assignee fallback (which would have pushed the total to 1.9).
        assert r.data["warnings"] == []

    def test_bare_assignee_complete_task_excluded(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        assignee_user: object,
        resource_with_user: Resource,
    ) -> None:
        """A COMPLETE bare-assignee task does not count toward the sum."""
        Task.objects.create(
            project=project,
            name="Done",
            duration=3,
            assignee=assignee_user,
            status="COMPLETE",
        )
        new_task = Task.objects.create(project=project, name="Active", duration=5)

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(new_task.pk), "resource": str(resource_with_user.pk), "units": "1.0"},
        )
        assert r.status_code == 201
        assert r.data["warnings"] == []


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


# ---------------------------------------------------------------------------
# Date-windowed overallocation (#3534)
#
# The warning used to sum TaskResource.units across every active task in the
# project with no date window at all, so three 0.8-unit tasks that never share
# a calendar day reported as 240% allocated. It now compares the PEAK units held
# on any single working day against max_units, using the same calendar
# resolution the utilization engine applies.
# ---------------------------------------------------------------------------


@pytest.fixture
def resource_80(db: object) -> Resource:
    """Resource capped at 80% capacity — Raj Mehta's seeded figure (#3534)."""
    return Resource.objects.create(name="Raj", email="raj@example.com", max_units=Decimal("0.8"))


def _dated_task(project: Project, name: str, start: date, finish: date) -> Task:
    """A committed task carrying a CPM span, the shape the engine windows on."""
    return Task.objects.create(
        project=project,
        name=name,
        duration=(finish - start).days + 1,
        early_start=start,
        early_finish=finish,
        scheduled_start=start,
    )


@pytest.mark.django_db
class TestOverallocationIsDateWindowed:
    """_check_overallocation compares a peak working-day load, not a lifetime sum."""

    def test_non_overlapping_tasks_do_not_warn(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource_80: Resource,
    ) -> None:
        """The reported defect: three 0.8-unit tasks, zero shared calendar days.

        Raj Mehta's real seeded shape — Sep 7-14, Oct 13-16, Nov 6-9 at 0.8 units
        each against an 0.8 capacity. The old lifetime sum reported 240%; the peak
        on any one working day is 0.8, exactly at capacity, so nothing warns.
        """
        first = _dated_task(project, "Sep", date(2026, 9, 7), date(2026, 9, 14))
        second = _dated_task(project, "Oct", date(2026, 10, 13), date(2026, 10, 16))
        third = _dated_task(project, "Nov", date(2026, 11, 6), date(2026, 11, 9))
        TaskResource.objects.create(task=first, resource=resource_80, units=Decimal("0.8"))
        TaskResource.objects.create(task=second, resource=resource_80, units=Decimal("0.8"))

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(third.pk), "resource": str(resource_80.pk), "units": "0.8"},
        )
        assert r.status_code == 201
        assert r.data["warnings"] == []

    def test_overlapping_tasks_still_warn_and_name_the_day(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource_80: Resource,
    ) -> None:
        """A genuine same-day conflict still warns, and says which day."""
        existing = _dated_task(project, "A", date(2026, 9, 7), date(2026, 9, 14))
        overlapping = _dated_task(project, "B", date(2026, 9, 9), date(2026, 9, 18))
        TaskResource.objects.create(task=existing, resource=resource_80, units=Decimal("0.5"))

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(overlapping.pk), "resource": str(resource_80.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        codes = [w["code"] for w in r.data["warnings"]]
        assert codes == ["resource_overallocated"]
        # 0.5 + 0.5 = 100% on the first working day both spans cover.
        assert "100%" in r.data["warnings"][0]["detail"]
        assert "2026-09-09" in r.data["warnings"][0]["detail"]

    def test_weekend_only_touch_is_not_a_conflict(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource_80: Resource,
    ) -> None:
        """Spans that meet only on a non-working day are not an overallocation.

        The heat map refuses to color a Saturday overlap; the write-time warning
        must agree, or the two controls contradict each other on the same data.
        """
        # 2026-04-04 is a Saturday and the only day both spans cover.
        first = _dated_task(project, "Wed-Sat", date(2026, 4, 1), date(2026, 4, 4))
        second = _dated_task(project, "Sat-Fri", date(2026, 4, 4), date(2026, 4, 10))
        TaskResource.objects.create(task=first, resource=resource_80, units=Decimal("0.6"))

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(second.pk), "resource": str(resource_80.pk), "units": "0.6"},
        )
        assert r.status_code == 201
        assert r.data["warnings"] == []

    def test_undated_tasks_remain_an_every_day_baseline(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource_80: Resource,
    ) -> None:
        """A task the CPM has never dated is counted as concurrent, not dropped.

        Windowing must not become a way to hide load: an unscheduled task has no
        span that could prove it does *not* overlap, so it applies to every day.
        Assignments are routinely made before the first CPM run, which is exactly
        when dropping them would silently disarm the warning.
        """
        undated = Task.objects.create(project=project, name="Unscheduled", duration=5)
        TaskResource.objects.create(task=undated, resource=resource_80, units=Decimal("0.5"))
        dated = _dated_task(project, "Scheduled", date(2026, 9, 7), date(2026, 9, 14))

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(dated.pk), "resource": str(resource_80.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        assert [w["code"] for w in r.data["warnings"]] == ["resource_overallocated"]
        assert "2026-09-07" in r.data["warnings"][0]["detail"]

    def test_all_undated_peak_has_no_day_to_name(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        resource_80: Resource,
    ) -> None:
        """With nothing dated there is no busiest day, only a floor — say so."""
        other = Task.objects.create(project=project, name="Other", duration=5)
        TaskResource.objects.create(task=other, resource=resource_80, units=Decimal("0.5"))
        target = Task.objects.create(project=project, name="Target", duration=5)

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(target.pk), "resource": str(resource_80.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        detail = r.data["warnings"][0]["detail"]
        assert "on their busiest day" in detail
        assert "capacity: 80%" in detail


@pytest.mark.django_db
class TestBareAssigneeIsAlsoDateWindowed:
    """The #3047 bare-assignee fallback is windowed by span like any other row."""

    def test_non_overlapping_bare_assignee_caveats_without_overallocating(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        assignee_user: object,
        resource_with_user: Resource,
    ) -> None:
        """The unit-tracking caveat still fires; the false overallocation does not.

        The caveat and the overallocation warning are independent: the caller is
        told the figures include a full-time estimate even when the estimate does
        not push any single day over capacity.
        """
        bare = _dated_task(project, "Untracked", date(2026, 9, 7), date(2026, 9, 14))
        bare.assignee = assignee_user
        bare.save(update_fields=["assignee"])
        tracked = _dated_task(project, "Tracked", date(2026, 10, 13), date(2026, 10, 16))

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(tracked.pk), "resource": str(resource_with_user.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        codes = [w["code"] for w in r.data["warnings"]]
        assert codes == ["assignment_not_unit_tracked"]
        assert str(bare.pk) in r.data["warnings"][0]["task_ids"]

    def test_overlapping_bare_assignee_still_overallocates(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        assignee_user: object,
        resource_with_user: Resource,
    ) -> None:
        """When the estimate really does land on the same days, both warnings fire."""
        bare = _dated_task(project, "Untracked", date(2026, 9, 7), date(2026, 9, 14))
        bare.assignee = assignee_user
        bare.save(update_fields=["assignee"])
        tracked = _dated_task(project, "Tracked", date(2026, 9, 9), date(2026, 9, 18))

        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(tracked.pk), "resource": str(resource_with_user.pk), "units": "0.5"},
        )
        assert r.status_code == 201
        codes = {w["code"] for w in r.data["warnings"]}
        assert codes == {"assignment_not_unit_tracked", "resource_overallocated"}
        over = next(w for w in r.data["warnings"] if w["code"] == "resource_overallocated")
        assert "150%" in over["detail"]
        assert "2026-09-09" in over["detail"]
