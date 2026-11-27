"""A soft-deleted dependency can be re-added, and revival picks one edge per key (#4901)."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Task,
    cascade_project_children_restore,
    cascade_project_children_soft_delete,
    cascade_task_children_restore,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> Any:
    return get_user_model().objects.create_user(username="deps", password="pw")


@pytest.fixture
def project(user: Any) -> Project:
    p = Project.objects.create(
        name="Edges", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="c")
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def tasks(project: Project) -> tuple[Task, Task]:
    a, b = (
        Task.objects.create(project=project, name=name, duration=1, wbs_path=path)
        for name, path in (("A", "1"), ("B", "2"))
    )
    return a, b


@pytest.fixture
def client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _post(client: APIClient, a: Task, b: Task, **extra: Any) -> Any:
    body = {"predecessor": str(a.pk), "successor": str(b.pk), "dep_type": "FS", **extra}
    return client.post("/api/v1/dependencies/", body, format="json")


def _delete(client: APIClient, dep_id: str) -> None:
    assert client.delete(f"/api/v1/dependencies/{dep_id}/").status_code == 204


def _delete_and_readd(client: APIClient, a: Task, b: Task, rounds: int) -> list[str]:
    """Return the ids of ``rounds`` tombstones of one edge key, oldest first."""
    ids = []
    for _ in range(rounds):
        resp = _post(client, a, b)
        assert resp.status_code == 201, resp.content
        ids.append(resp.json()["id"])
        _delete(client, ids[-1])
    return ids


def test_deleted_edge_can_be_readded(client: APIClient, tasks: tuple[Task, Task]) -> None:
    a, b = tasks
    first = _delete_and_readd(client, a, b, 1)[0]

    resp = _post(client, a, b)
    assert resp.status_code == 201, resp.content
    assert resp.json()["id"] != first
    assert Dependency.objects.get(pk=first).is_deleted is True


def test_live_duplicate_is_still_refused(client: APIClient, tasks: tuple[Task, Task]) -> None:
    a, b = tasks
    assert _post(client, a, b).status_code == 201

    resp = _post(client, a, b, lag=3)
    assert resp.status_code == 400, resp.content
    assert "already links these two tasks" in resp.json()["non_field_errors"][0]
    # The database still backs the rule for writers that skip the serializer.
    with pytest.raises(IntegrityError), transaction.atomic():
        Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")


def test_patch_into_a_live_twin_is_refused_but_own_edit_passes(
    client: APIClient, tasks: tuple[Task, Task]
) -> None:
    a, b = tasks
    fs = _post(client, a, b).json()["id"]
    ff = _post(client, a, b, dep_type="FF")
    assert ff.status_code == 201, ff.content

    assert client.patch(f"/api/v1/dependencies/{fs}/", {"lag": 2}, format="json").status_code == 200
    resp = client.patch(
        f"/api/v1/dependencies/{ff.json()['id']}/", {"dep_type": "FS"}, format="json"
    )
    assert resp.status_code == 400, resp.content


def _live_ids() -> list[str]:
    return [str(pk) for pk in Dependency.live.values_list("pk", flat=True)]


def test_project_restore_revives_only_the_newest_tombstone(
    client: APIClient, project: Project, tasks: tuple[Task, Task]
) -> None:
    a, b = tasks
    ids = _delete_and_readd(client, a, b, 3)

    cascade_project_children_soft_delete(project)
    cascade_project_children_restore(project)

    assert _live_ids() == [ids[-1]]


def test_task_restore_revives_only_the_newest_tombstone(
    client: APIClient, tasks: tuple[Task, Task]
) -> None:
    a, b = tasks
    ids = _delete_and_readd(client, a, b, 2)

    b.soft_delete()
    b.restore()
    cascade_task_children_restore(b)

    assert _live_ids() == [ids[-1]]


def test_restore_keeps_a_live_twin_and_leaves_the_tombstone(
    client: APIClient, project: Project, tasks: tuple[Task, Task]
) -> None:
    a, b = tasks
    old = _delete_and_readd(client, a, b, 1)[0]
    live = _post(client, a, b).json()["id"]

    cascade_project_children_restore(project)

    assert _live_ids() == [live]
    assert Dependency.objects.get(pk=old).is_deleted is True


def test_sprint_milestone_predecessors_ignore_the_tombstoned_twin(
    client: APIClient, project: Project, tasks: tuple[Task, Task]
) -> None:
    """Re-adding leaves a tombstone beside the live edge; readers must list it once."""
    from trueppm_api.apps.projects.models import Sprint

    a, b = tasks
    Task.objects.filter(pk=b.pk).update(is_milestone=True, duration=0)
    _delete_and_readd(client, a, b, 1)
    assert _post(client, a, b).status_code == 201
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        target_milestone=b,
    )

    detail = client.get(f"/api/v1/sprints/{sprint.pk}/")
    listing = client.get(f"/api/v1/projects/{project.pk}/sprints/")
    assert detail.status_code == 200, detail.content
    assert detail.json()["target_milestone_detail"]["predecessor_ids"] == [str(a.pk)]
    assert listing.status_code == 200, listing.content
    assert listing.json()["results"][0]["target_milestone_detail"]["predecessor_ids"] == [str(a.pk)]
