"""Per-task ownership enforcement on the bulk task-update op (#1548).

TaskBulkView's "update" branch previously applied only project-wide Member+
write, so a plain Member could bulk-edit ANY task, including tasks assigned to
other users — bypassing the per-task ownership rule the single-task
TaskViewSet.update path (IsProjectMemberWriteOrOwn -> can_user_edit_task,
ADR-0133) enforces. The fix runs the same can_user_edit_task predicate per task:
Admin+ may edit any task; a Member may edit only their own assigned task; a
non-editable task rejects the whole request with 403 (matching the sibling
"delete" branch's semantics).
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
def admin_user(db: object) -> object:
    return User.objects.create_user(username="admin", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def admin_client(project: Project, admin_user: object) -> APIClient:
    ProjectMembership.objects.create(project=project, user=admin_user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin_user)
    return c


@pytest.fixture
def member_client(project: Project, member_user: object) -> APIClient:
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def own_task(project: Project, member_user: object) -> Task:
    """Task assigned to the Member making the request (assignee FK — the
    ownership signal can_user_edit_task checks)."""
    return Task.objects.create(project=project, name="Mine", duration=3, assignee=member_user)


@pytest.fixture
def others_task(project: Project, other_user: object) -> Task:
    """Task assigned to a different user — off-limits to the Member."""
    return Task.objects.create(project=project, name="Theirs", duration=3, assignee=other_user)


def _bulk_update(client: APIClient, project: Project, task: Task, name: str) -> object:
    return client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {"operations": [{"op": "update", "id": str(task.pk), "data": {"name": name}}]},
        format="json",
    )


# ---------------------------------------------------------------------------
# Ownership enforcement
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_bulk_update_others_task_forbidden(
    member_client: APIClient, project: Project, others_task: Task
) -> None:
    """A Member bulk-updating a task assigned to someone else is rejected 403 —
    mirroring the delete branch, the whole request fails and nothing mutates."""
    with _no_side_effects():
        r = _bulk_update(member_client, project, others_task, "Hijacked")
    assert r.status_code == 403
    others_task.refresh_from_db()
    assert others_task.name == "Theirs"


@pytest.mark.django_db
def test_member_bulk_update_own_task_succeeds(
    member_client: APIClient, project: Project, own_task: Task
) -> None:
    """A Member may bulk-update a task they are assigned to."""
    with _no_side_effects():
        r = _bulk_update(member_client, project, own_task, "Renamed")
    assert r.status_code == 200
    own_task.refresh_from_db()
    assert own_task.name == "Renamed"


@pytest.mark.django_db
def test_admin_bulk_update_any_task_succeeds(
    admin_client: APIClient, project: Project, others_task: Task
) -> None:
    """Admin+ may bulk-update any task regardless of assignee."""
    with _no_side_effects():
        r = _bulk_update(admin_client, project, others_task, "AdminEdit")
    assert r.status_code == 200
    others_task.refresh_from_db()
    assert others_task.name == "AdminEdit"


@pytest.mark.django_db
def test_member_bulk_update_mixed_batch_rejects_whole_request(
    member_client: APIClient, project: Project, own_task: Task, others_task: Task
) -> None:
    """A batch containing a task the Member may not edit is rejected 403 before
    any sibling op commits — the forbidden op is placed first so the request
    short-circuits and neither task mutates."""
    with _no_side_effects():
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    {"op": "update", "id": str(others_task.pk), "data": {"name": "OtherEdit"}},
                    {"op": "update", "id": str(own_task.pk), "data": {"name": "OwnEdit"}},
                ]
            },
            format="json",
        )
    assert r.status_code == 403
    own_task.refresh_from_db()
    others_task.refresh_from_db()
    assert own_task.name == "Mine"
    assert others_task.name == "Theirs"
