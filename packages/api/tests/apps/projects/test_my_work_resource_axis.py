"""Resource-axis ownership (#2750) on the My Work sibling reads.

``MeWorkView``'s list is covered in ``test_task_owners_field.py``. These pin the
other surfaces that answer "what is assigned to me": the active-sprints block of
``/me/work/``, ``/me/active-sprints/``, the project "my tasks" week view and the
retro-promoted rows. In each, a task owned ONLY through ``TaskResource`` ->
``Resource.user`` (no ``Task.assignee``) must count exactly once.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RetroActionItem,
    Sprint,
    SprintRetro,
    SprintState,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


@pytest.fixture
def world(db: object) -> dict[str, object]:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)
    user = User.objects.create_user(username="priya", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)
    # Two resources linked to the same user: a join would double-count.
    resources = [
        Resource.objects.create(
            name=f"Priya {i}", email=f"p{i}@example.com", max_units=Decimal("1.0"), user=user
        )
        for i in range(2)
    ]
    return {"project": project, "user": user, "client": client, "resources": resources}


def _own_via_resources(task: Task, resources: list[Resource]) -> None:
    for r in resources:
        TaskResource.objects.create(task=task, resource=r)


@pytest.mark.django_db
def test_me_work_active_sprints_counts_resource_owned_task_once(world: dict[str, object]) -> None:
    project, client = world["project"], world["client"]
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(project=project, name="T", duration=1, sprint=sprint)
    _own_via_resources(task, world["resources"])  # type: ignore[arg-type]
    # Both axes on a second task: still one.
    both = Task.objects.create(
        project=project, name="B", duration=1, sprint=sprint, assignee=world["user"]
    )
    _own_via_resources(both, world["resources"])  # type: ignore[arg-type]

    resp = client.get("/api/v1/me/work/")  # type: ignore[attr-defined]
    assert resp.status_code == 200, resp.data
    sprints = resp.data["active_sprints"]
    assert [s["id"] for s in sprints] == [str(sprint.pk)]
    assert sprints[0]["task_count"] == 2


@pytest.mark.django_db
def test_me_active_sprints_includes_resource_owned_task(world: dict[str, object]) -> None:
    project, client = world["project"], world["client"]
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(project=project, name="T", duration=1, sprint=sprint)
    _own_via_resources(task, world["resources"])  # type: ignore[arg-type]

    resp = client.get("/api/v1/me/active-sprints/")  # type: ignore[attr-defined]
    assert resp.status_code == 200, resp.data
    body = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    assert len(body) == 1


@pytest.mark.django_db
def test_project_my_tasks_week_includes_resource_owned_task_once(
    world: dict[str, object],
) -> None:
    project, client = world["project"], world["client"]
    task = Task.objects.create(project=project, name="T", duration=1)
    Task.objects.filter(pk=task.pk).update(early_finish=timezone.localdate())
    _own_via_resources(task, world["resources"])  # type: ignore[arg-type]

    resp = client.get(f"/api/v1/projects/{project.pk}/my-tasks/")  # type: ignore[attr-defined]
    assert resp.status_code == 200, resp.data
    assert [t["id"] for t in resp.data["tasks"]] == [str(task.pk)]


@pytest.mark.django_db
def test_retro_promoted_resource_owned_task_is_an_owned_row(world: dict[str, object]) -> None:
    project, client = world["project"], world["client"]
    sprint = Sprint.objects.create(
        project=project,
        name="S0",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14) + timedelta(days=0),
        state=SprintState.COMPLETED,
    )
    retro = SprintRetro.objects.create(sprint=sprint, notes="r")
    task = Task.objects.create(project=project, name="Follow-up", duration=1)
    item = RetroActionItem.objects.create(retro=retro, text="Do it", promoted_task_id=task.pk)
    _own_via_resources(task, world["resources"])  # type: ignore[arg-type]

    resp = client.get("/api/v1/me/work/")  # type: ignore[attr-defined]
    assert resp.status_code == 200, resp.data
    owned = [r for r in resp.data["retro_action_items"] if r["suggestion_state"] == "owned"]
    assert [r["text"] for r in owned] == [item.text]
