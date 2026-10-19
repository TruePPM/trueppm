"""A member of a trashed project is not a member for notification redaction (#4587).

#4577 made "a trashed project confers no role" an invariant; the inbox's
redaction gate still counted the membership, so the project's task names,
subjects, bodies, snippets and deep-link ids stayed visible to members of a
project in Trash for the whole notification retention window.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Mention, Notification
from trueppm_api.apps.notifications.serializers import NotificationSerializer
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskComment

User = get_user_model()

pytestmark = pytest.mark.django_db

LIST_URL = "/api/v1/me/notifications/"


@pytest.fixture
def setup() -> dict[str, object]:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=cal)
    task = Task.objects.create(project=project, name="Secret task", duration=1)
    author = User.objects.create_user(username="author", password="pw")
    user = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    comment = TaskComment.objects.create(task=task, author=author, body="Confidential body")
    mention = Mention.objects.create(
        mentioner=author, mentioned_user=user, task_comment=comment, project=project
    )
    notif = Notification.objects.create(
        recipient=user,
        event_type="task.assigned",
        subject='Assigned: "Secret task"',
        body='You were assigned "Secret task" on Alpha.',
        project=project,
        task=task,
        mention=mention,
    )
    return {"project": project, "task": task, "user": user, "notif": notif}


def _row(user: object) -> dict[str, object]:
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.get(LIST_URL)
    assert resp.status_code == 200
    rows = resp.data["results"]
    assert len(rows) == 1
    return dict(rows[0])


def test_live_project_member_sees_content(setup: dict[str, object]) -> None:
    row = _row(setup["user"])
    assert row["subject"] == 'Assigned: "Secret task"'
    assert row["body"]
    assert row["snippet"].startswith("Confidential")  # type: ignore[attr-defined]
    assert row["task_id"] == str(setup["task"].pk)  # type: ignore[attr-defined]
    assert row["project"] == setup["project"].pk  # type: ignore[attr-defined]


def test_trashed_project_member_gets_redacted_row(setup: dict[str, object]) -> None:
    Project.objects.filter(pk=setup["project"].pk).update(is_deleted=True)  # type: ignore[attr-defined]
    row = _row(setup["user"])
    assert row["subject"] == ""
    assert row["body"] == ""
    assert row["snippet"] == ""
    assert row["task_id"] is None
    assert row["project"] is None


def test_restoring_the_project_unredacts(setup: dict[str, object]) -> None:
    pk = setup["project"].pk  # type: ignore[attr-defined]
    Project.objects.filter(pk=pk).update(is_deleted=True)
    assert _row(setup["user"])["subject"] == ""
    Project.objects.filter(pk=pk).update(is_deleted=False)
    assert _row(setup["user"])["subject"] == 'Assigned: "Secret task"'


def test_serializer_fallback_set_floors_trashed_project(setup: dict[str, object]) -> None:
    """No view-supplied context: the serializer's own fallback must floor too."""
    from rest_framework.test import APIRequestFactory

    pk = setup["project"].pk  # type: ignore[attr-defined]
    Project.objects.filter(pk=pk).update(is_deleted=True)
    request = APIRequestFactory().get(LIST_URL)
    request.user = setup["user"]  # type: ignore[assignment]
    data = NotificationSerializer(setup["notif"], context={"request": request}).data  # type: ignore[arg-type]
    assert data["subject"] == ""
    assert data["project"] is None


def test_mention_visible_to_floors_trashed_project(setup: dict[str, object]) -> None:
    pk = setup["project"].pk  # type: ignore[attr-defined]
    assert Mention.objects.visible_to(setup["user"]).count() == 1
    Project.objects.filter(pk=pk).update(is_deleted=True)
    assert Mention.objects.visible_to(setup["user"]).count() == 0
