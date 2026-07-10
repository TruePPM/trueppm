"""Tests for POST /api/v1/projects/{pk}/tasks/reorder/ and .../bulk/."""

from __future__ import annotations

import uuid
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="reorderuser", password="pw")


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
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Reorder Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def root_tasks(project: Project) -> list[Task]:
    """Three root-level tasks (wbs_path 1, 2, 3)."""
    t1 = Task.objects.create(project=project, name="T1", duration=1, wbs_path="1")
    t2 = Task.objects.create(project=project, name="T2", duration=1, wbs_path="2")
    t3 = Task.objects.create(project=project, name="T3", duration=1, wbs_path="3")
    return [t1, t2, t3]


@pytest.fixture
def child_tasks(project: Project, root_tasks: list[Task]) -> list[Task]:
    """Two children under task at wbs_path '1'."""
    c1 = Task.objects.create(project=project, name="C1", duration=1, wbs_path="1.1")
    c2 = Task.objects.create(project=project, name="C2", duration=1, wbs_path="1.2")
    return [c1, c2]


# ---------------------------------------------------------------------------
# TaskReorderView
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskReorderView:
    URL = "/api/v1/projects/{pk}/tasks/reorder/"

    def url(self, project: Project) -> str:
        return self.URL.format(pk=project.pk)

    def test_reorder_root_happy_path(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t1, t2, t3 = root_tasks
        # Reverse order: 3, 2, 1
        payload = {
            "parent_path": "",
            "ordered_ids": [str(t3.pk), str(t2.pk), str(t1.pk)],
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data

        updated = {item["id"]: item["wbs_path"] for item in r.data["updated"]}
        assert updated[str(t3.pk)] == "1"
        assert updated[str(t2.pk)] == "2"
        assert updated[str(t1.pk)] == "3"

        # Verify DB was actually updated.
        t1.refresh_from_db()
        assert t1.wbs_path == "3"

    def test_reorder_children_happy_path(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
        child_tasks: list[Task],
    ) -> None:
        c1, c2 = child_tasks
        payload = {
            "parent_path": "1",
            "ordered_ids": [str(c2.pk), str(c1.pk)],
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data

        updated = {item["id"]: item["wbs_path"] for item in r.data["updated"]}
        assert updated[str(c2.pk)] == "1.1"
        assert updated[str(c1.pk)] == "1.2"

    def test_missing_sibling_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t1, t2, _ = root_tasks
        # Omit t3 — should be rejected as incomplete list.
        payload = {
            "parent_path": "",
            "ordered_ids": [str(t1.pk), str(t2.pk)],
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 400

    def test_unknown_id_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t1, t2, t3 = root_tasks
        payload = {
            "parent_path": "",
            "ordered_ids": [str(t1.pk), str(t2.pk), str(t3.pk), str(uuid.uuid4())],
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 400

    def test_unauthenticated_rejected(
        self,
        anon_client: APIClient,
        project: Project,
        root_tasks: list[Task],
    ) -> None:
        t1, t2, t3 = root_tasks
        payload = {
            "parent_path": "",
            "ordered_ids": [str(t1.pk), str(t2.pk), str(t3.pk)],
        }
        r = anon_client.post(self.url(project), payload, format="json")
        assert r.status_code == 401

    def test_non_member_rejected(
        self,
        project: Project,
        root_tasks: list[Task],
    ) -> None:
        """A user with no membership cannot reorder tasks."""
        User = get_user_model()
        outsider = User.objects.create_user(username="outsider_r", password="pw")
        c = APIClient()
        c.force_authenticate(user=outsider)
        t1, t2, t3 = root_tasks
        payload = {
            "parent_path": "",
            "ordered_ids": [str(t1.pk), str(t2.pk), str(t3.pk)],
        }
        r = c.post(self.url(project), payload, format="json")
        assert r.status_code == 403

    def test_wrong_project_id_returns_404(
        self,
        client: APIClient,
        root_tasks: list[Task],
    ) -> None:
        url = self.URL.format(pk=uuid.uuid4())
        t1, t2, t3 = root_tasks
        payload = {
            "parent_path": "",
            "ordered_ids": [str(t1.pk), str(t2.pk), str(t3.pk)],
        }
        r = client.post(url, payload, format="json")
        assert r.status_code == 404

    def test_empty_ordered_ids_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        r = client.post(
            self.url(project),
            {"parent_path": "", "ordered_ids": []},
            format="json",
        )
        assert r.status_code == 400


@pytest.mark.django_db
class TestTaskReorderPermission:
    """Reorder rewrites wbs_path for every sibling, so — like indent/outdent/
    reparent (#1771) — it requires per-task edit authority on each sibling, not
    merely any-Member IsProjectMemberWrite. A Member who cannot edit a colleague's
    task must not be able to renumber it by reordering the level it lives in.
    """

    URL = "/api/v1/projects/{pk}/tasks/reorder/"

    def url(self, project: Project) -> str:
        return self.URL.format(pk=project.pk)

    @pytest.fixture
    def member(self, project: Project) -> object:
        User = get_user_model()
        u = User.objects.create_user(username="reorder_member", password="pw")
        ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
        return u

    @pytest.fixture
    def member_client(self, member: object) -> APIClient:
        c = APIClient()
        c.force_authenticate(user=member)
        return c

    def test_member_cannot_reorder_level_with_unowned_task(
        self, member_client: APIClient, project: Project, member: object
    ) -> None:
        """A level containing a colleague's task is off-limits — the complete-set
        reorder would renumber a task the Member cannot edit."""
        t1 = Task.objects.create(
            project=project, name="Mine", duration=1, wbs_path="1", assignee=member
        )
        t2 = Task.objects.create(project=project, name="Theirs", duration=1, wbs_path="2")
        r = member_client.post(
            self.url(project),
            {"parent_path": "", "ordered_ids": [str(t2.pk), str(t1.pk)]},
            format="json",
        )
        assert r.status_code == 403
        # No wbs_path was rewritten.
        t1.refresh_from_db()
        t2.refresh_from_db()
        assert (t1.wbs_path, t2.wbs_path) == ("1", "2")

    def test_member_can_reorder_own_assigned_level(
        self, member_client: APIClient, project: Project, member: object
    ) -> None:
        """Field-edit parity: a Member may reorder a level whose tasks are all
        assigned to them."""
        t1 = Task.objects.create(
            project=project, name="A", duration=1, wbs_path="1", assignee=member
        )
        t2 = Task.objects.create(
            project=project, name="B", duration=1, wbs_path="2", assignee=member
        )
        r = member_client.post(
            self.url(project),
            {"parent_path": "", "ordered_ids": [str(t2.pk), str(t1.pk)]},
            format="json",
        )
        assert r.status_code == 200, r.data
        t1.refresh_from_db()
        t2.refresh_from_db()
        assert (t2.wbs_path, t1.wbs_path) == ("1", "2")

    def test_owner_can_reorder_any_level(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        """Regression guard: the Owner/Admin path is unaffected by the tightened gate."""
        t1 = Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
        t2 = Task.objects.create(project=project, name="B", duration=1, wbs_path="2")
        r = client.post(
            self.url(project),
            {"parent_path": "", "ordered_ids": [str(t2.pk), str(t1.pk)]},
            format="json",
        )
        assert r.status_code == 200, r.data


# ---------------------------------------------------------------------------
# TaskBulkView
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskBulkView:
    URL = "/api/v1/projects/{pk}/tasks/bulk/"

    def url(self, project: Project) -> str:
        return self.URL.format(pk=project.pk)

    def test_create_happy_path(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        payload = {
            "operations": [
                {
                    "op": "create",
                    "data": {"name": "New Task", "duration": 3, "project": str(project.pk)},
                },
            ]
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data
        assert len(r.data["created"]) == 1
        assert r.data["created"][0]["name"] == "New Task"
        assert r.data["updated"] == []
        assert r.data["deleted"] == []
        assert Task.objects.filter(project=project, name="New Task", is_deleted=False).exists()

    def test_update_happy_path(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t1 = root_tasks[0]
        payload = {
            "operations": [
                {"op": "update", "id": str(t1.pk), "data": {"percent_complete": 0.5}},
            ]
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data
        assert len(r.data["updated"]) == 1
        t1.refresh_from_db()
        assert t1.percent_complete == 0.5

    def test_delete_happy_path(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t3 = root_tasks[2]
        payload = {"operations": [{"op": "delete", "id": str(t3.pk)}]}
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data
        assert str(t3.pk) in r.data["deleted"]
        t3.refresh_from_db()
        assert t3.is_deleted is True

    def test_mixed_operations(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t1, t2, _ = root_tasks
        payload = {
            "operations": [
                {
                    "op": "create",
                    "data": {"name": "Mixed New", "duration": 2, "project": str(project.pk)},
                },
                {"op": "update", "id": str(t1.pk), "data": {"duration": 10}},
                {"op": "delete", "id": str(t2.pk)},
            ]
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data
        assert len(r.data["created"]) == 1
        assert len(r.data["updated"]) == 1
        assert len(r.data["deleted"]) == 1

    def test_bulk_mutated_broadcast_carries_task_ids(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """#1009: the bulk on-commit broadcast carries the ids of the tasks it
        mutated (a non-empty ``task_ids`` list — updated and deleted here),
        matching close_sprint's ``tasks_bulk_mutated`` payload shape rather than
        the old empty ``{}``. Deferred via ``transaction.on_commit``, so the
        callbacks are captured and executed to observe the wire event.
        """
        t1, _t2, t3 = root_tasks
        payload = {
            "operations": [
                {"op": "update", "id": str(t1.pk), "data": {"duration": 5}},
                {"op": "delete", "id": str(t3.pk)},
            ]
        }
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 200, r.data

        bulk_calls = [
            c.args for c in mock_bcast.call_args_list if c.args[1] == "tasks_bulk_mutated"
        ]
        assert len(bulk_calls) == 1
        pid, _event, wire_payload = bulk_calls[0]
        assert pid == str(project.pk)
        # Non-empty ids: both the updated and the deleted task are carried.
        assert set(wire_payload["task_ids"]) == {str(t1.pk), str(t3.pk)}

    def test_duplicate_id_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        t1 = root_tasks[0]
        payload = {
            "operations": [
                {"op": "update", "id": str(t1.pk), "data": {"duration": 5}},
                {"op": "delete", "id": str(t1.pk)},
            ]
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 400

    def test_unknown_id_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        payload = {
            "operations": [{"op": "update", "id": str(uuid.uuid4()), "data": {"duration": 5}}]
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 400

    def test_missing_id_for_delete_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        payload = {"operations": [{"op": "delete"}]}
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 400

    def test_unauthenticated_rejected(
        self,
        anon_client: APIClient,
        project: Project,
    ) -> None:
        payload = {
            "operations": [
                {
                    "op": "create",
                    "data": {"name": "X", "duration": 1, "project": str(project.pk)},
                }
            ]
        }
        r = anon_client.post(self.url(project), payload, format="json")
        assert r.status_code == 401

    def test_non_member_rejected(self, project: Project) -> None:
        User = get_user_model()
        outsider = User.objects.create_user(username="outsider_b", password="pw")
        c = APIClient()
        c.force_authenticate(user=outsider)
        payload = {
            "operations": [
                {
                    "op": "create",
                    "data": {"name": "X", "duration": 1, "project": str(project.pk)},
                }
            ]
        }
        r = c.post(self.url(project), payload, format="json")
        assert r.status_code == 403

    def test_empty_operations_rejected(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
    ) -> None:
        r = client.post(self.url(project), {"operations": []}, format="json")
        assert r.status_code == 400

    def test_wrong_project_id_returns_404(self, client: APIClient) -> None:
        url = self.URL.format(pk=uuid.uuid4())
        payload = {"operations": [{"op": "create", "data": {"name": "X", "duration": 1}}]}
        r = client.post(url, payload, format="json")
        assert r.status_code == 404

    def test_atomicity_rollback_on_invalid_update(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        root_tasks: list[Task],
    ) -> None:
        """If one op is invalid, the whole transaction rolls back."""
        t1 = root_tasks[0]
        initial_duration = t1.duration
        payload = {
            "operations": [
                {"op": "update", "id": str(t1.pk), "data": {"duration": 99}},
                # Invalid: create without required 'name'
                {"op": "create", "data": {"duration": 5, "project": str(project.pk)}},
            ]
        }
        r = client.post(self.url(project), payload, format="json")
        assert r.status_code == 400
        # t1 must still have original duration — transaction rolled back.
        t1.refresh_from_db()
        assert t1.duration == initial_duration
