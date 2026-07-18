"""Tests for the faithful task-restore endpoint (#2078, ADR-0494).

Covers POST /tasks/:id/restore/ — the real inverse of the task delete cascade:
- un-tombstones the task, its is_subtask subtree, and its dependency edges;
- assignments ride along (never tombstoned);
- server_version bump for sync re-materialization (ADR-0202);
- double-submit fails closed (404); delete-parity RBAC (IsProjectMemberWriteOrOwn);
- IDOR: a foreign-project task 404s; task_restored broadcast on commit.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Task,
    TaskType,
)
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def stranger(db: object) -> Any:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(owner: Any, member: Any, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Apollo", code="APL", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=p, user=member, role=Role.MEMBER)
    return p


@pytest.fixture
def task_tree(project: Project) -> dict[str, Task]:
    """A parent with a drawer-subtask child, plus a sibling and a dependency edge.

    parent (wbs 1)  ──FS──▶  other (wbs 2)
      └─ sub (wbs 1.1, is_subtask=True)
    """
    parent = Task.objects.create(project=project, name="Parent", duration=2, wbs_path="1")
    sub = Task.objects.create(
        project=project, name="Sub", duration=1, wbs_path="1.1", is_subtask=True
    )
    other = Task.objects.create(project=project, name="Other", duration=1, wbs_path="2")
    edge = Dependency.objects.create(predecessor=parent, successor=other, dep_type="FS")
    return {"parent": parent, "sub": sub, "other": other, "edge": edge}


def _delete_task(client: APIClient, task: Task) -> None:
    """Soft-delete via the endpoint — cascades subtree + edges synchronously."""
    resp = client.delete(f"/api/v1/tasks/{task.pk}/")
    assert resp.status_code == 204, resp.content


# ---------------------------------------------------------------------------
# Happy path — subtree + edge restore
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_restore_untombstones_task_subtree_and_edges(
    owner: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    client = _client(owner)
    parent, sub, edge = task_tree["parent"], task_tree["sub"], task_tree["edge"]

    _delete_task(client, parent)

    # The delete cascaded: parent + is_subtask child + the edge are all tombstoned.
    parent.refresh_from_db()
    sub.refresh_from_db()
    edge.refresh_from_db()
    assert parent.is_deleted is True
    assert sub.is_deleted is True
    assert edge.is_deleted is True

    resp = client.post(f"/api/v1/tasks/{parent.pk}/restore/")
    assert resp.status_code == 200, resp.content
    assert resp.data["id"] == str(parent.pk)

    parent.refresh_from_db()
    sub.refresh_from_db()
    edge.refresh_from_db()
    # The whole graph is live again — parent, its subtree, and the dependency edge.
    assert parent.is_deleted is False
    assert parent.deleted_at is None
    assert parent.deleted_version is None
    assert sub.is_deleted is False
    assert edge.is_deleted is False
    # The task is reachable through the normal (is_deleted=False) surface again.
    assert client.get(f"/api/v1/tasks/{parent.pk}/").status_code == 200


@pytest.mark.django_db
def test_restore_only_touches_is_subtask_descendants(owner: Any, project: Project) -> None:
    """A WBS-structure child (is_subtask=False) is not auto-deleted, so restore of the
    parent must not resurrect a WBS child that was independently deleted."""
    client = _client(owner)
    parent = Task.objects.create(project=project, name="Parent", duration=2, wbs_path="1")
    wbs_child = Task.objects.create(
        project=project, name="WbsChild", duration=1, wbs_path="1.1", is_subtask=False
    )
    # Independently delete the WBS child first, then the parent.
    _delete_task(client, wbs_child)
    _delete_task(client, parent)

    client.post(f"/api/v1/tasks/{parent.pk}/restore/")

    parent.refresh_from_db()
    wbs_child.refresh_from_db()
    assert parent.is_deleted is False
    # The WBS child was NOT an is_subtask cascade target, so it stays tombstoned —
    # restore mirrors the delete's is_subtask scope exactly.
    assert wbs_child.is_deleted is True


@pytest.mark.django_db
def test_restore_keeps_resource_assignments(
    owner: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    """Assignments are never tombstoned, so they return with the restored row."""
    client = _client(owner)
    parent = task_tree["parent"]
    resource = Resource.objects.create(name="Dana")
    TaskResource.objects.create(task=parent, resource=resource, units=1)

    _delete_task(client, parent)
    resp = client.post(f"/api/v1/tasks/{parent.pk}/restore/")
    assert resp.status_code == 200

    assert TaskResource.objects.filter(task=parent, resource=resource).exists()


@pytest.mark.django_db
def test_restore_bumps_server_version(
    owner: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    client = _client(owner)
    parent, sub = task_tree["parent"], task_tree["sub"]
    _delete_task(client, parent)

    parent_v = Task.objects.values_list("server_version", flat=True).get(pk=parent.pk)
    sub_v = Task.objects.values_list("server_version", flat=True).get(pk=sub.pk)

    resp = client.post(f"/api/v1/tasks/{parent.pk}/restore/")
    assert resp.status_code == 200

    assert Task.objects.values_list("server_version", flat=True).get(pk=parent.pk) > parent_v
    assert Task.objects.values_list("server_version", flat=True).get(pk=sub.pk) > sub_v


# ---------------------------------------------------------------------------
# Idempotency / fail-closed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_double_restore_is_404(owner: Any, project: Project, task_tree: dict[str, Task]) -> None:
    """A second restore of an already-live task 404s — the trashed lookup no longer
    resolves it, so it fails closed rather than re-applying."""
    client = _client(owner)
    parent = task_tree["parent"]
    _delete_task(client, parent)

    assert client.post(f"/api/v1/tasks/{parent.pk}/restore/").status_code == 200
    assert client.post(f"/api/v1/tasks/{parent.pk}/restore/").status_code == 404


# ---------------------------------------------------------------------------
# RBAC — delete parity (IsProjectMemberWriteOrOwn)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_restore_forbidden_for_non_assignee_member(
    owner: Any, member: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    """A plain Member who is not the task's assignee cannot restore — mirrors the
    delete gate exactly (Admin+ or assignee)."""
    parent = task_tree["parent"]
    _delete_task(_client(owner), parent)

    resp = _client(member).post(f"/api/v1/tasks/{parent.pk}/restore/")
    assert resp.status_code == 403
    parent.refresh_from_db()
    assert parent.is_deleted is True


@pytest.mark.django_db
def test_restore_allowed_for_assignee_member(
    owner: Any, member: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    """The task's assignee (below Admin) may restore it — restore mirrors the delete
    gate, which grants the Task.assignee (ADR-0133 can_user_edit_task)."""
    parent = task_tree["parent"]
    parent.assignee = member
    parent.save()
    _delete_task(_client(owner), parent)

    resp = _client(member).post(f"/api/v1/tasks/{parent.pk}/restore/")
    assert resp.status_code == 200
    parent.refresh_from_db()
    assert parent.is_deleted is False


@pytest.mark.django_db
def test_restore_forbidden_for_product_owner_of_a_story(
    owner: Any, member: Any, project: Project
) -> None:
    """The PO grooming facet may edit an EPIC/STORY but not DELETE it — restore is a
    delete-class act, so a PO who can't delete a story can't restore it either (#2078).
    This exercises the restore→DELETE-semantics parity fix, not just the predicate."""
    story = Task.objects.create(
        project=project, name="Story", duration=1, type=TaskType.STORY, wbs_path="1"
    )
    team = Team.objects.create(
        project=project, name="Default Team", short_id="T01", is_default=True
    )
    TeamMembership.objects.create(
        team=team, user=member, role=TeamRole.MEMBER, is_product_owner=True
    )
    _delete_task(_client(owner), story)

    resp = _client(member).post(f"/api/v1/tasks/{story.pk}/restore/")
    assert resp.status_code == 403
    story.refresh_from_db()
    assert story.is_deleted is True


@pytest.mark.django_db
def test_restore_foreign_task_is_404_not_403(
    stranger: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    """A non-member gets 404 (IDOR-safe: the trashed lookup is membership-scoped, so
    it never leaks that the task exists)."""
    parent = task_tree["parent"]
    _delete_task(_client(project.memberships.get(role=Role.OWNER).user), parent)

    resp = _client(stranger).post(f"/api/v1/tasks/{parent.pk}/restore/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_restore_broadcasts_task_restored(
    owner: Any, project: Project, task_tree: dict[str, Task]
) -> None:
    """A task_restored board event is emitted on commit (mirrors task_deleted)."""
    client = _client(owner)
    parent = task_tree["parent"]
    _delete_task(client, parent)

    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast:
        resp = client.post(f"/api/v1/tasks/{parent.pk}/restore/")
        assert resp.status_code == 200

    events = [c.args[1] for c in mock_broadcast.call_args_list]
    assert "task_restored" in events
