"""Edit and delete agree on who "the assignee" is (#2747).

A task can be assigned through ``Task.assignee`` (PATCH, retro promotion, importers)
or through a ``TaskResource`` row (the board's Assignees editor). Both axes must
grant a Member the same edit and delete verdict.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def project() -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def client(member: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member)
    return c


def _bare_assignee(project: Project, member: object) -> Task:
    return Task.objects.create(project=project, name="bare", duration=1, assignee=member)


def _resource_only(project: Project, member: object) -> Task:
    t = Task.objects.create(project=project, name="res", duration=1)
    TaskResource.objects.create(task=t, resource=Resource.objects.create(name="M", user=member))
    return t


def _unassigned(project: Project, member: object) -> Task:
    return Task.objects.create(project=project, name="none", duration=1)


def _bulk(client: APIClient, project: Project, op: dict) -> object:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        return client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/", {"operations": [op]}, format="json"
        )


@pytest.mark.parametrize(
    ("factory", "allowed"),
    [(_bare_assignee, True), (_resource_only, True), (_unassigned, False)],
)
def test_edit_and_delete_verdicts_agree(
    client: APIClient, project: Project, member: object, factory: object, allowed: bool
) -> None:
    task = factory(project, member)  # type: ignore[operator]
    detail = client.get(f"/api/v1/tasks/{task.pk}/")
    assert detail.status_code == 200, detail.data
    assert detail.data["can_edit"] is allowed
    assert detail.data["can_delete"] is allowed

    upd = _bulk(client, project, {"op": "update", "id": str(task.pk), "data": {"name": "x"}})
    dele = _bulk(client, project, {"op": "delete", "id": str(task.pk)})
    assert (not upd.data["rejected"]) is allowed, upd.data
    assert (not dele.data["rejected"]) is allowed, dele.data


def test_other_users_assignment_does_not_grant(
    client: APIClient, project: Project, member: object
) -> None:
    other = User.objects.create_user(username="o", password="pw")
    t = Task.objects.create(project=project, name="t", duration=1, assignee=other)
    TaskResource.objects.create(task=t, resource=Resource.objects.create(name="O", user=other))
    detail = client.get(f"/api/v1/tasks/{t.pk}/")
    assert detail.data["can_edit"] is False
    assert detail.data["can_delete"] is False
    assert _bulk(client, project, {"op": "delete", "id": str(t.pk)}).data["rejected"]
