"""Reason-privacy gate + structured-blocker surfaces (ADR-0124, #1135/#1134).

The organizing principle under test: ``blocker_type`` / age / actor /
``blocking_task`` are team-shareable; ``blocked_reason`` (free text) is readable
ONLY by the task's assignee or a user @-mentioned on it. These tests prove a
non-assignee / non-mentioned project member has NO readable path to the reason —
not via the task serializer, and not via either roll-up endpoint.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Mention
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, Task, TaskComment

User = get_user_model()

REASON = "SECRET: vendor escalation, blocked on legal sign-off"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def assignee(db: object) -> Any:
    return User.objects.create_user(username="assignee", password="pw", email="a@x.io")


@pytest.fixture
def mentioned(db: object) -> Any:
    return User.objects.create_user(username="mentioned", password="pw", email="m@x.io")


@pytest.fixture
def pm(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw", email="pm@x.io")


@pytest.fixture
def bystander(db: object) -> Any:
    """A plain project member who is neither assignee nor @-mentioned."""
    return User.objects.create_user(username="bystander", password="pw", email="b@x.io")


@pytest.fixture
def memberships(project: Project, assignee: Any, mentioned: Any, pm: Any, bystander: Any) -> None:
    ProjectMembership.objects.create(project=project, user=assignee, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=mentioned, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=bystander, role=Role.MEMBER)


@pytest.fixture
def blocked_task(project: Project, assignee: Any) -> Task:
    return Task.objects.create(
        project=project,
        name="Foundation pour",
        duration=1,
        assignee=assignee,
        blocked_reason=REASON,
        blocker_type="vendor",
    )


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Serializer reason-gate (#1135)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_assignee_sees_reason(blocked_task: Task, assignee: Any, memberships: None) -> None:
    resp = _client(assignee).get(f"/api/v1/tasks/{blocked_task.pk}/")
    assert resp.status_code == 200
    assert resp.data["blocked_reason"] == REASON
    # Structured signal also present.
    assert resp.data["blocker_type"] == "vendor"
    assert resp.data["is_impediment"] is True


@pytest.mark.django_db
def test_mentioned_user_sees_reason(
    blocked_task: Task, mentioned: Any, assignee: Any, project: Project, memberships: None
) -> None:
    comment = TaskComment.objects.create(task=blocked_task, author=assignee, body="ping")
    Mention.objects.create(
        mentioner=assignee,
        mentioned_user=mentioned,
        task_comment=comment,
        project=project,
    )
    resp = _client(mentioned).get(f"/api/v1/tasks/{blocked_task.pk}/")
    assert resp.status_code == 200
    assert resp.data["blocked_reason"] == REASON


@pytest.mark.django_db
def test_bystander_member_cannot_read_reason_via_serializer(
    blocked_task: Task, bystander: Any, memberships: None
) -> None:
    """A plain member who is neither assignee nor @-mentioned: reason key is ABSENT."""
    resp = _client(bystander).get(f"/api/v1/tasks/{blocked_task.pk}/")
    assert resp.status_code == 200
    # The reason is dropped from the payload entirely — not merely emptied.
    assert "blocked_reason" not in resp.data
    # But the structured triage signal is fully visible to the team.
    assert resp.data["blocker_type"] == "vendor"
    assert resp.data["blocked_since"] is not None
    assert resp.data["blocked_age_seconds"] is not None


@pytest.mark.django_db
def test_pm_cannot_read_reason_via_serializer(
    blocked_task: Task, pm: Any, memberships: None
) -> None:
    """Even a PM (Role.ADMIN) gets type/age but never the private reason."""
    resp = _client(pm).get(f"/api/v1/tasks/{blocked_task.pk}/")
    assert resp.status_code == 200
    assert "blocked_reason" not in resp.data
    assert resp.data["blocker_type"] == "vendor"


@pytest.mark.django_db
def test_list_response_gates_reason_per_row(
    blocked_task: Task, bystander: Any, memberships: None, project: Project
) -> None:
    """The gate applies on the list path too (to_representation runs per row)."""
    resp = _client(bystander).get(f"/api/v1/tasks/?project={project.pk}")
    assert resp.status_code == 200
    rows = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    row = next(r for r in rows if r["id"] == str(blocked_task.pk))
    assert "blocked_reason" not in row
    assert row["blocker_type"] == "vendor"


# ---------------------------------------------------------------------------
# Roll-up endpoints (#1134) — reason omitted for EVERYONE
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_blocked_rollup_omits_reason_for_everyone(
    blocked_task: Task, assignee: Any, pm: Any, bystander: Any, memberships: None, project: Project
) -> None:
    for user in (assignee, pm, bystander):
        resp = _client(user).get(f"/api/v1/projects/{project.pk}/blocked/")
        assert resp.status_code == 200, (user.username, resp.data)
        assert resp.data["count"] == 1
        row = resp.data["blocked"][0]
        # The reason is never a key on a roll-up row — not even for the assignee.
        assert "blocked_reason" not in row
        assert REASON not in str(resp.data)
        # Structured triage signal IS present.
        assert row["blocker_type"] == "vendor"
        assert row["assignee"]["username"] == "assignee"
        assert row["blocked_age_seconds"] is not None


@pytest.mark.django_db
def test_sprint_blocked_rollup_omits_reason(
    project: Project, assignee: Any, pm: Any, memberships: None
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
    )
    task = Task.objects.create(
        project=project,
        name="Inspection",
        duration=1,
        assignee=assignee,
        sprint=sprint,
        blocked_reason=REASON,
        blocker_type="decision",
    )
    resp = _client(pm).get(f"/api/v1/sprints/{sprint.pk}/blocked/")
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 1
    assert REASON not in str(resp.data)
    row = resp.data["blocked"][0]
    assert row["task_id"] == str(task.pk)
    assert row["blocker_type"] == "decision"
    assert "blocked_reason" not in row


@pytest.mark.django_db
def test_blocked_rollup_denies_non_member(
    blocked_task: Task, project: Project, memberships: None
) -> None:
    stranger = User.objects.create_user(username="stranger", password="pw")
    resp = _client(stranger).get(f"/api/v1/projects/{project.pk}/blocked/")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Structured-field write + blocked_by stamping (#1135)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_flagging_stamps_blocked_by_and_since(
    project: Project, assignee: Any, pm: Any, memberships: None
) -> None:
    task = Task.objects.create(project=project, name="Wiring", duration=1, assignee=assignee)
    resp = _client(pm).patch(
        f"/api/v1/tasks/{task.pk}/",
        {"blocked_reason": "waiting", "blocker_type": "resource"},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    task.refresh_from_db()
    assert task.blocked_by_id == pm.pk  # actor stamped by the serializer
    assert task.blocked_since is not None
    assert task.blocker_type == "resource"


@pytest.mark.django_db
def test_unflagging_clears_structured_fields(
    blocked_task: Task, assignee: Any, memberships: None
) -> None:
    resp = _client(assignee).patch(
        f"/api/v1/tasks/{blocked_task.pk}/",
        {"blocked_reason": ""},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    blocked_task.refresh_from_db()
    # Model.save() clears the structured fields on unflag.
    assert blocked_task.blocked_since is None
    assert blocked_task.blocker_type == ""
    assert blocked_task.blocked_by_id is None


@pytest.mark.django_db
def test_blocking_task_must_be_same_project(
    project: Project, calendar: Calendar, assignee: Any, pm: Any, memberships: None
) -> None:
    other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
    other_task = Task.objects.create(project=other, name="Foreign", duration=1)
    task = Task.objects.create(project=project, name="Local", duration=1, assignee=assignee)
    resp = _client(pm).patch(
        f"/api/v1/tasks/{task.pk}/",
        {"blocked_reason": "waiting", "blocking_task": str(other_task.pk)},
        format="json",
    )
    assert resp.status_code == 400
    assert "blocking_task" in resp.data
