"""Task agent-task fields — executor_kind / agent_state / refusal reason / on_behalf_of.

ADR-1485 child 14 (extends ADR-0112). The load-bearing cases are the write rules: a
Member must not be able to forge ``on_behalf_of`` onto another person or promote a task
to an agent task, and a refusal reason is valid only while ``agent_state`` is refused.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _member(project: Project, name: str, role: int) -> Any:
    user = User.objects.create_user(username=name, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def admin(project: Project) -> Any:
    return _member(project, "admin", Role.ADMIN)


@pytest.fixture
def member(project: Project) -> Any:
    return _member(project, "member", Role.MEMBER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


def _patch(user: Any, task: Task, body: dict[str, Any]) -> Any:
    return _client(user).patch(f"/api/v1/tasks/{task.pk}/", body, format="json")


@pytest.mark.django_db
def test_defaults_leave_existing_rows_human_and_valid(task: Task) -> None:
    task.refresh_from_db()
    assert task.executor_kind == "human"
    assert task.agent_state == ""
    assert task.agent_refusal_reason == ""
    assert task.on_behalf_of is None


@pytest.mark.django_db
def test_db_constraints_reject_incoherent_rows(task: Task) -> None:
    with pytest.raises(IntegrityError), transaction.atomic():
        Task.objects.filter(pk=task.pk).update(agent_state="queued")  # human + state
    with pytest.raises(IntegrityError), transaction.atomic():
        Task.objects.filter(pk=task.pk).update(
            executor_kind="agent", agent_state="running", agent_refusal_reason="no"
        )


@pytest.mark.django_db
def test_serializer_exposes_fields(admin: Any, task: Task) -> None:
    data = _client(admin).get(f"/api/v1/tasks/{task.pk}/").json()
    assert data["executor_kind"] == "human"
    assert data["agent_state"] == ""
    assert data["agent_refusal_reason"] == ""
    assert data["on_behalf_of"] is None


@pytest.mark.django_db
def test_admin_makes_agent_task_with_refusal(admin: Any, member: Any, task: Task) -> None:
    resp = _patch(admin, task, {"executor_kind": "agent", "on_behalf_of": member.pk})
    assert resp.status_code == 200, resp.content
    resp = _patch(admin, task, {"agent_state": "refused", "agent_refusal_reason": "out of scope"})
    assert resp.status_code == 200, resp.content
    task.refresh_from_db()
    assert (task.agent_state, task.agent_refusal_reason) == ("refused", "out of scope")
    assert task.on_behalf_of_id == member.pk
    # Leaving "refused" without naming the reason clears it rather than leaving it stale.
    assert _patch(admin, task, {"agent_state": "queued"}).status_code == 200
    task.refresh_from_db()
    assert task.agent_refusal_reason == ""


@pytest.mark.django_db
def test_refusal_reason_rejected_unless_refused(admin: Any, task: Task) -> None:
    _patch(admin, task, {"executor_kind": "agent"})
    resp = _patch(admin, task, {"agent_state": "running", "agent_refusal_reason": "x"})
    assert resp.status_code == 400
    assert "agent_refusal_reason" in resp.json()


@pytest.mark.django_db
def test_agent_fields_require_agent_kind(admin: Any, task: Task) -> None:
    assert _patch(admin, task, {"agent_state": "queued"}).status_code == 400


@pytest.mark.django_db
def test_switching_to_human_clears_agent_fields(admin: Any, task: Task) -> None:
    _patch(admin, task, {"executor_kind": "agent", "agent_state": "queued"})
    assert _patch(admin, task, {"executor_kind": "human"}).status_code == 200
    task.refresh_from_db()
    assert (task.executor_kind, task.agent_state, task.on_behalf_of_id) == ("human", "", None)


@pytest.mark.django_db
def test_member_cannot_change_executor_kind(member: Any, project: Project) -> None:
    t = Task.objects.create(project=project, name="Mine", duration=1, assignee=member)
    resp = _patch(member, t, {"executor_kind": "agent"})
    assert resp.status_code == 403
    t.refresh_from_db()
    assert t.executor_kind == "human"


@pytest.mark.django_db
def test_member_cannot_forge_on_behalf_of(admin: Any, member: Any, project: Project) -> None:
    t = Task.objects.create(
        project=project, name="Agent", duration=1, assignee=member, executor_kind="agent"
    )
    resp = _patch(member, t, {"on_behalf_of": admin.pk})
    assert resp.status_code == 403
    assert _patch(member, t, {"on_behalf_of": member.pk}).status_code == 200


@pytest.mark.django_db
def test_on_behalf_of_must_be_project_member(admin: Any, task: Task) -> None:
    outsider = User.objects.create_user(username="out", password="pw")
    _patch(admin, task, {"executor_kind": "agent"})
    resp = _patch(admin, task, {"on_behalf_of": outsider.pk})
    assert resp.status_code == 400
    assert "on_behalf_of" in resp.json()


@pytest.mark.django_db
def test_sync_serializer_carries_agent_fields(project: Project, member: Any) -> None:
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    t = Task.objects.create(
        project=project,
        name="A",
        duration=1,
        executor_kind="agent",
        agent_state="refused",
        agent_refusal_reason="no",
        on_behalf_of=member,
    )
    data = SyncTaskSerializer(t).data
    assert data["executor_kind"] == "agent"
    assert data["agent_state"] == "refused"
    assert data["agent_refusal_reason"] == "no"
    assert data["on_behalf_of"] == member.pk
