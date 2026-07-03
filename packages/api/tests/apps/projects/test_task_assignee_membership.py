"""Assignee-membership validation on the REST task-write path (#684, security).

``TaskSerializer.validate`` rejects an assignee who is not a live (non
soft-deleted) ``ProjectMembership`` member of the task's project. Without it a
writer could point a task at ANY existing user id — including one with no
membership on the project. Unassigning (assignee=null / unset) stays valid.

Covers create (``POST /api/v1/tasks/``) and update (``PATCH /api/v1/tasks/{id}/``)
plus the positive member case, the null case, and the soft-deleted-membership
exclusion. The sync-upload apply path — which reuses this serializer — is covered
in ``tests/apps/sync/test_sync_upload.py``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


@contextmanager
def _no_side_effects() -> Iterator[None]:
    """Silence the CPM recalc + board broadcast fired on a successful write."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        yield


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def pm_user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    """A live MEMBER of the project — a valid assignee."""
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def outsider_user(db: object) -> object:
    """An existing user with NO membership on the project — an invalid assignee."""
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def pm_client(project: Project, pm_user: object) -> APIClient:
    """The requester is an ADMIN member, so the write-permission gate is satisfied
    and each test isolates the assignee-membership validation itself."""
    ProjectMembership.objects.create(project=project, user=pm_user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=pm_user)
    return c


@pytest.fixture
def member_membership(project: Project, member_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def existing_task(project: Project, member_user: object) -> Task:
    """A task already assigned to a live member (created via the ORM, which is not
    gated — only the serializer write path is)."""
    return Task.objects.create(project=project, name="Existing", duration=3, assignee=member_user)


# ---------------------------------------------------------------------------
# Create path (POST /api/v1/tasks/)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_with_non_member_assignee_rejected(
    pm_client: APIClient, project: Project, outsider_user: object
) -> None:
    r = pm_client.post(
        "/api/v1/tasks/",
        {
            "name": "Ghost",
            "duration": 1,
            "project": str(project.pk),
            "assignee": outsider_user.pk,
        },
        format="json",
    )
    assert r.status_code == 400, r.data
    assert "assignee" in r.data
    assert not Task.objects.filter(name="Ghost").exists()


@pytest.mark.django_db
def test_create_with_member_assignee_succeeds(
    pm_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    with _no_side_effects():
        r = pm_client.post(
            "/api/v1/tasks/",
            {
                "name": "Owned",
                "duration": 1,
                "project": str(project.pk),
                "assignee": member_user.pk,
            },
            format="json",
        )
    assert r.status_code == 201, r.data
    assert Task.objects.get(name="Owned").assignee_id == member_user.pk


@pytest.mark.django_db
def test_create_without_assignee_succeeds(pm_client: APIClient, project: Project) -> None:
    """Unassigned is a valid state — the validator only fires when an assignee is set."""
    with _no_side_effects():
        r = pm_client.post(
            "/api/v1/tasks/",
            {"name": "Unowned", "duration": 1, "project": str(project.pk)},
            format="json",
        )
    assert r.status_code == 201, r.data
    assert Task.objects.get(name="Unowned").assignee_id is None


# ---------------------------------------------------------------------------
# Update path (PATCH /api/v1/tasks/{id}/)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_assignee_to_non_member_rejected(
    pm_client: APIClient, existing_task: Task, outsider_user: object
) -> None:
    r = pm_client.patch(
        f"/api/v1/tasks/{existing_task.pk}/",
        {"assignee": outsider_user.pk},
        format="json",
    )
    assert r.status_code == 400, r.data
    assert "assignee" in r.data
    existing_task.refresh_from_db()
    # Unchanged — the original member assignee is preserved.
    assert existing_task.assignee_id != outsider_user.pk


@pytest.mark.django_db
def test_patch_assignee_to_member_succeeds(
    pm_client: APIClient, project: Project, existing_task: Task
) -> None:
    other_member = User.objects.create_user(username="member2", password="pw")
    ProjectMembership.objects.create(project=project, user=other_member, role=Role.MEMBER)
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{existing_task.pk}/",
            {"assignee": other_member.pk},
            format="json",
        )
    assert r.status_code == 200, r.data
    existing_task.refresh_from_db()
    assert existing_task.assignee_id == other_member.pk


@pytest.mark.django_db
def test_patch_assignee_to_null_succeeds(pm_client: APIClient, existing_task: Task) -> None:
    """Unassigning an already-assigned task is always allowed."""
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{existing_task.pk}/",
            {"assignee": None},
            format="json",
        )
    assert r.status_code == 200, r.data
    existing_task.refresh_from_db()
    assert existing_task.assignee_id is None


@pytest.mark.django_db
def test_soft_deleted_membership_is_not_a_valid_assignee(
    pm_client: APIClient, project: Project, existing_task: Task
) -> None:
    """A user whose only membership is soft-deleted is treated as a non-member."""
    removed = User.objects.create_user(username="removed", password="pw")
    membership = ProjectMembership.objects.create(project=project, user=removed, role=Role.MEMBER)
    ProjectMembership.objects.filter(pk=membership.pk).update(is_deleted=True)
    r = pm_client.patch(
        f"/api/v1/tasks/{existing_task.pk}/",
        {"assignee": removed.pk},
        format="json",
    )
    assert r.status_code == 400, r.data
    assert "assignee" in r.data
