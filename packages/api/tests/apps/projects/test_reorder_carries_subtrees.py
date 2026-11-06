"""Reorder carries each sibling's whole subtree (#4842).

``Task.wbs_path`` is the only record of parenthood, so rewriting just the listed
siblings' paths left their descendants behind under whichever task now held the
old path. ``transaction=True`` because the (project, wbs_path) exclusion
constraint is DEFERRED: a collision only surfaces at COMMIT.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task

User = get_user_model()
URL = "/api/v1/projects/{pk}/tasks/reorder/"

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def project() -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Reorder", start_date=date(2026, 1, 5), calendar=cal)


@pytest.fixture
def client(project: Project) -> APIClient:
    user = User.objects.create_user(username="owner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _t(project: Project, name: str, path: str) -> Task:
    return Task.objects.create(project=project, name=name, duration=2, wbs_path=path)


def _outline(project: Project) -> dict[str, str]:
    return {
        n: str(p)
        for n, p in Task.objects.filter(project=project, is_deleted=False).values_list(
            "name", "wbs_path"
        )
    }


def _reorder(client: APIClient, project: Project, parent_path: str, ids: list[Task]) -> Any:
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
    ):
        response = client.post(
            URL.format(pk=project.pk),
            {"parent_path": parent_path, "ordered_ids": [str(t.pk) for t in ids]},
            format="json",
        )
    response.broadcast = broadcast
    return response


def test_root_reorder_moves_children_with_their_parent(project: Project, client: APIClient) -> None:
    a = _t(project, "A", "1")
    _t(project, "A1", "1.1")
    a11 = _t(project, "A11", "1.1.1")
    b = _t(project, "B", "2")
    c = _t(project, "C", "3")
    dep = Dependency.objects.create(predecessor=b, successor=c, dep_type="SS")

    response = _reorder(client, project, "", [b, a, c])

    assert response.status_code == 200, response.data
    assert _outline(project) == {"B": "1", "A": "2", "A1": "2.1", "A11": "2.1.1", "C": "3"}
    updated = {u["id"]: u["wbs_path"] for u in response.json()["updated"]}
    assert updated[str(a11.pk)] == "2.1.1"
    assert set(Dependency.objects.values_list("pk", flat=True)) == {dep.pk}


def test_swapping_two_summaries_keeps_each_subtree_intact(
    project: Project, client: APIClient
) -> None:
    a = _t(project, "A", "1")
    _t(project, "A1", "1.1")
    b = _t(project, "B", "2")
    _t(project, "B1", "2.1")
    _t(project, "B2", "2.2")

    response = _reorder(client, project, "", [b, a])

    assert response.status_code == 200, response.data
    assert _outline(project) == {"B": "1", "B1": "1.1", "B2": "1.2", "A": "2", "A1": "2.1"}


def test_nested_reorder_carries_subtrees_and_leaves_other_branches_alone(
    project: Project, client: APIClient
) -> None:
    _t(project, "P", "1")
    x = _t(project, "X", "1.1")
    _t(project, "X1", "1.1.1")
    y = _t(project, "Y", "1.2")
    _t(project, "Q", "2")
    _t(project, "Q1", "2.1")

    response = _reorder(client, project, "1", [y, x])

    assert response.status_code == 200, response.data
    assert _outline(project) == {
        "P": "1",
        "Y": "1.1",
        "X": "1.2",
        "X1": "1.2.1",
        "Q": "2",
        "Q1": "2.1",
    }


def test_ten_does_not_swallow_one_s_subtree(project: Project, client: APIClient) -> None:
    """Prefix matching must be label-aware: "1" must not capture "10.x"."""
    ids = [_t(project, f"T{i}", str(i)) for i in range(1, 11)]
    _t(project, "T1c", "1.1")
    _t(project, "T10c", "10.1")

    response = _reorder(client, project, "", list(reversed(ids)))

    assert response.status_code == 200, response.data
    out = _outline(project)
    assert out["T1"] == "10" and out["T1c"] == "10.1"
    assert out["T10"] == "1" and out["T10c"] == "1.1"


def test_moved_descendants_bump_server_version_and_broadcast_once(
    project: Project, client: APIClient
) -> None:
    a = _t(project, "A", "1")
    a1 = _t(project, "A1", "1.1")
    b = _t(project, "B", "2")
    before = Task.objects.get(pk=a1.pk).server_version

    response = _reorder(client, project, "", [b, a])

    assert response.status_code == 200, response.data
    assert Task.objects.get(pk=a1.pk).server_version > before
    response.broadcast.assert_called_once_with(str(project.pk), "tasks_reordered", {})


def test_unchanged_order_touches_nothing(project: Project, client: APIClient) -> None:
    a = _t(project, "A", "1")
    a1 = _t(project, "A1", "1.1")
    b = _t(project, "B", "2")
    before = Task.objects.get(pk=a1.pk).server_version

    response = _reorder(client, project, "", [a, b])

    assert response.status_code == 200, response.data
    assert Task.objects.get(pk=a1.pk).server_version == before
    assert _outline(project) == {"A": "1", "A1": "1.1", "B": "2"}
