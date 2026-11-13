"""PhaseReorderSerializer error shape (#264) and comment-parent oracle (#4010)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.views import PhaseReorderSerializer

User = get_user_model()


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _reorder(client: APIClient, project: Project, body: object) -> object:
    return client.patch(f"/api/v1/projects/{project.pk}/phases/reorder/", body, format="json")


@pytest.mark.django_db
def test_reorder_happy_path(client: APIClient, project: Project) -> None:
    a = Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
    b = Task.objects.create(project=project, name="B", duration=1, wbs_path="2")
    resp = _reorder(
        client,
        project,
        {
            "phases": [
                {"id": str(b.pk), "server_version": b.server_version},
                {"id": str(a.pk), "server_version": a.server_version},
            ]
        },
    )
    assert resp.status_code == status.HTTP_200_OK
    a.refresh_from_db()
    b.refresh_from_db()
    assert b.priority_rank < a.priority_rank


@pytest.mark.django_db
def test_reorder_duplicate_ids_rejected(client: APIClient, project: Project) -> None:
    a = Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
    entry = {"id": str(a.pk), "server_version": a.server_version}
    resp = _reorder(client, project, {"phases": [entry, entry]})
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert "Duplicate phase IDs" in str(resp.data["phases"])


@pytest.mark.django_db
@pytest.mark.parametrize(
    "body",
    [
        {"phases": []},
        {},
        {"phases": "x"},
        {"phases": [{"id": "not-a-uuid", "server_version": 1}]},
        {"phases": [{"id": "11111111-1111-1111-1111-111111111111"}]},
        ["a"],
    ],
)
def test_reorder_malformed_body_is_field_keyed_400(
    client: APIClient, project: Project, body: object
) -> None:
    resp = _reorder(client, project, body)
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    # Field-keyed (or non_field_errors for a non-object body), never a flat detail.
    assert "detail" not in resp.json()
    assert "phases" in resp.json() or "non_field_errors" in resp.json()


@pytest.mark.django_db
def test_reorder_unknown_id_still_400(client: APIClient, project: Project) -> None:
    resp = _reorder(
        client,
        project,
        {"phases": [{"id": "11111111-1111-1111-1111-111111111111", "server_version": 1}]},
    )
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert "Unknown or non-root" in str(resp.data["phases"])


def test_serializer_validates_without_a_request() -> None:
    ser = PhaseReorderSerializer(data={"phases": [{"id": "x", "server_version": 1}]})
    assert not ser.is_valid()
    assert "phases" in ser.errors


@pytest.mark.django_db
def test_comment_parent_on_other_task_matches_not_found(
    client: APIClient, project: Project
) -> None:
    t1 = Task.objects.create(project=project, name="T1", duration=1)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    base1 = f"/api/v1/projects/{project.pk}/tasks/{t1.pk}/comments/"
    base2 = f"/api/v1/projects/{project.pk}/tasks/{t2.pk}/comments/"
    parent = client.post(base1, {"body": "root"}, format="json")
    assert parent.status_code == status.HTTP_201_CREATED, parent.data
    pid = parent.data["id"]

    cross = client.post(base2, {"body": "reply", "parent": pid}, format="json")
    missing = client.post(
        base2, {"body": "reply", "parent": "22222222-2222-2222-2222-222222222222"}, format="json"
    )
    # A REPLY on another task must not leak via comment_reply_depth either.
    reply = client.post(base1, {"body": "r", "parent": pid}, format="json")
    assert reply.status_code == status.HTTP_201_CREATED, reply.data
    cross_reply = client.post(base2, {"body": "x", "parent": reply.data["id"]}, format="json")
    assert cross_reply.status_code == status.HTTP_400_BAD_REQUEST
    assert cross_reply.data["parent"][0].code == "does_not_exist"
    assert str(cross_reply.data["parent"][0]).replace(reply.data["id"], "X") == str(
        missing.data["parent"][0]
    ).replace("22222222-2222-2222-2222-222222222222", "X")
    # Same-task reply-to-reply still gets the depth error.
    same = client.post(base1, {"body": "x", "parent": reply.data["id"]}, format="json")
    assert same.data["parent"][0].code == "comment_reply_depth"

    assert cross.status_code == missing.status_code == status.HTTP_400_BAD_REQUEST
    # Identical apart from the echoed pk: the response must not distinguish
    # "exists on another task" from "does not exist".
    assert cross.data["parent"][0].code == missing.data["parent"][0].code == "does_not_exist"
    assert str(cross.data["parent"][0]).replace(pid, "X") == str(missing.data["parent"][0]).replace(
        "22222222-2222-2222-2222-222222222222", "X"
    )
