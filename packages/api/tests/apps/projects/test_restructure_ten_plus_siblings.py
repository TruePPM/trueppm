"""Indent, outdent and reparent with 10+ siblings (#4845).

``wbs_path`` is an ltree and compares labels as text, so ``"10"`` sorts before
``"2"``. ``_get_siblings`` once relied on that ordering, and every restructure that
derived a position from the list index renumbered the wrong tasks. Each test asserts
the *full* outline. ``transaction=True`` because the (project, wbs_path) exclusion
constraint is DEFERRED and a collision only surfaces at COMMIT.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def project() -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Wide", start_date=date(2026, 1, 5), calendar=cal)


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


def _post(
    client: APIClient, project: Project, suffix: str, body: dict[str, Any] | None = None
) -> Any:
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
    ):
        return client.post(
            f"/api/v1/projects/{project.pk}/tasks/{suffix}", body or {}, format="json"
        )


def _level(project: Project, prefix: str, count: int) -> list[Task]:
    """``count`` siblings named ``T1..Tn`` under ``prefix`` ('' for root)."""
    dot = f"{prefix}." if prefix else ""
    return [_t(project, f"T{i}", f"{dot}{i}") for i in range(1, count + 1)]


def test_outdent_at_root_with_eleven_siblings(project: Project, client: APIClient) -> None:
    _level(project, "", 11)
    x = _t(project, "X", "2.1")

    response = _post(client, project, f"{x.pk}/outdent/")

    assert response.status_code == 200, response.data
    expected = {f"T{i}": str(i if i <= 2 else i + 1) for i in range(1, 12)}
    expected["X"] = "3"
    assert _outline(project) == expected


def test_indent_at_root_with_eleven_siblings(project: Project, client: APIClient) -> None:
    roots = _level(project, "", 11)
    _t(project, "T1c", "1.1")
    _t(project, "T10c", "10.1")
    _t(project, "T11c", "11.1")

    response = _post(client, project, f"{roots[1].pk}/indent/")

    assert response.status_code == 200, response.data
    expected = {"T1": "1", "T2": "1.2", "T1c": "1.1", "T10c": "9.1", "T11c": "10.1"}
    expected.update({f"T{i}": str(i - 1) for i in range(3, 12)})
    assert _outline(project) == expected


def test_reparent_at_root_with_twelve_siblings(project: Project, client: APIClient) -> None:
    roots = _level(project, "", 12)
    _t(project, "T1c", "1.1")
    _t(project, "T10c", "10.1")

    response = _post(
        client, project, f"{roots[1].pk}/reparent/", {"new_parent_id": str(roots[0].pk)}
    )

    assert response.status_code == 200, response.data
    expected = {"T1": "1", "T2": "1.2", "T1c": "1.1", "T10c": "9.1"}
    expected.update({f"T{i}": str(i - 1) for i in range(3, 13)})
    assert _outline(project) == expected


def test_guard_reparent_into_parent_with_ten_children_appends_last(
    project: Project, client: APIClient
) -> None:
    """Guard, not a regression test for #4845.

    The new child's slot comes from ``len(children) + 1``, so this passes on the old
    text ordering too. It pins that the existing ten children are left untouched.
    """
    _t(project, "P", "1")
    for i in range(1, 11):
        _t(project, f"C{i}", f"1.{i}")
    mover = _t(project, "M", "2")

    response = _post(
        client,
        project,
        f"{mover.pk}/reparent/",
        {"new_parent_id": str(Task.objects.get(name="P").pk)},
    )

    assert response.status_code == 200, response.data
    expected = {"P": "1", "M": "1.11"}
    expected.update({f"C{i}": f"1.{i}" for i in range(1, 11)})
    assert _outline(project) == expected


def test_outdent_nested_with_eleven_siblings(project: Project, client: APIClient) -> None:
    _t(project, "P", "1")
    _t(project, "Q", "2")
    kids = _level(project, "1", 11)
    _t(project, "T10a", "1.10.1")

    response = _post(client, project, f"{kids[1].pk}/outdent/")

    assert response.status_code == 200, response.data
    expected = {"P": "1", "Q": "3", "T1": "1.1", "T2": "2", "T10a": "2.8.1"}
    expected.update({f"T{i}": f"2.{i - 2}" for i in range(3, 12)})
    assert _outline(project) == expected


def test_indent_nested_with_eleven_siblings(project: Project, client: APIClient) -> None:
    _t(project, "P", "1")
    kids = _level(project, "1", 11)
    _t(project, "T10a", "1.10.1")

    response = _post(client, project, f"{kids[1].pk}/indent/")

    assert response.status_code == 200, response.data
    expected = {"P": "1", "T1": "1.1", "T2": "1.1.1", "T10a": "1.9.1"}
    expected.update({f"T{i}": f"1.{i - 1}" for i in range(3, 12)})
    assert _outline(project) == expected


def test_reparent_nested_with_eleven_siblings(project: Project, client: APIClient) -> None:
    _t(project, "P", "1")
    r = _t(project, "R", "2")
    kids = _level(project, "1", 11)
    _t(project, "T10a", "1.10.1")

    response = _post(client, project, f"{kids[1].pk}/reparent/", {"new_parent_id": str(r.pk)})

    assert response.status_code == 200, response.data
    expected = {"P": "1", "R": "2", "T1": "1.1", "T2": "2.1", "T10a": "1.9.1"}
    expected.update({f"T{i}": f"1.{i - 1}" for i in range(3, 12)})
    assert _outline(project) == expected


def test_group_with_eleven_siblings(project: Project, client: APIClient) -> None:
    _level(project, "", 11)
    t2 = Task.objects.get(name="T2")

    response = client.post(
        f"/api/v1/projects/{project.pk}/tasks/group/", {"task_ids": [str(t2.pk)]}, format="json"
    )

    assert response.status_code == 200, response.data
    container = Task.objects.get(pk=response.data["container"]["id"])
    expected = {"T1": "1", "T2": "2.1", container.name: "2"}
    expected.update({f"T{i}": str(i) for i in range(3, 12)})
    assert _outline(project) == expected


def test_ungroup_with_eleven_siblings(project: Project, client: APIClient) -> None:
    _t(project, "T1", "1")
    phase = _t(project, "Phase", "2")
    _t(project, "C1", "2.1")
    _t(project, "C2", "2.2")
    for i in range(3, 11):
        _t(project, f"T{i}", str(i))

    response = client.post(
        f"/api/v1/projects/{project.pk}/tasks/ungroup/", {"task_id": str(phase.pk)}, format="json"
    )

    assert response.status_code == 200, response.data
    expected = {"T1": "1", "C1": "2", "C2": "3"}
    expected.update({f"T{i}": str(i + 1) for i in range(3, 11)})
    assert _outline(project) == expected
