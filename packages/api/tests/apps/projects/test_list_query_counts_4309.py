"""List endpoints must not pay one query per row (#4309).

Covers ``GET /structural-operations/`` (``_newest_active_id``) and
``GET /project-templates/`` (``is_superseded``). Query counts are asserted with
``django_assert_num_queries`` rather than by reading SQL.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectTemplate,
    StructuralOperation,
)

User = get_user_model()

OPS_URL = "/api/v1/structural-operations/"
TEMPLATES_URL = "/api/v1/project-templates/"


def _count_queries(client: APIClient, url: str) -> tuple[int, Any]:
    with CaptureQueriesContext(connection) as ctx:
        response = client.get(url)
    assert response.status_code == 200
    return len(ctx.captured_queries), response


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="lister", password="pw")


@pytest.fixture
def client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _op(project: Project, user: Any, **kw: Any) -> StructuralOperation:
    return StructuralOperation.objects.create(
        project=project, applied_by=user, kind="indent", undoable=True, **kw
    )


@pytest.mark.django_db
def test_structural_operation_list_query_count_is_constant(user: Any, client: APIClient) -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    _op(project, user)
    one, _ = _count_queries(client, OPS_URL)
    for _i in range(24):
        _op(project, user)
    many, response = _count_queries(client, OPS_URL)
    assert len(response.json()["results"]) == 25
    assert many == one


@pytest.mark.django_db
def test_structural_operation_list_still_marks_only_the_newest_as_undoable(
    user: Any, client: APIClient
) -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    older = _op(project, user)
    newest = _op(project, user)
    body = client.get(OPS_URL).json()
    rows = {r["id"]: r for r in body["results"]}
    assert rows[str(newest.pk)]["undo_blocked_reason"] == ""
    assert rows[str(older.pk)]["undo_blocked_reason"] == "not_top_of_stack"


@pytest.mark.django_db
def test_template_list_query_count_is_constant_and_superseded_is_correct(
    user: Any, client: APIClient
) -> None:
    def make(name: str, **kw: Any) -> ProjectTemplate:
        return ProjectTemplate.objects.create(
            name=name, owner=user, structure={"version": 1, "tasks": []}, **kw
        )

    first = make("t0")
    make("t0", version=2, supersedes=first)
    one, _ = _count_queries(client, TEMPLATES_URL)
    for i in range(1, 12):
        make(f"t{i}")
    many, response = _count_queries(client, TEMPLATES_URL)
    assert many == one
    rows = {r["id"]: r for r in response.json()["results"]}
    assert rows[str(first.pk)]["is_superseded"] is True
    assert sum(1 for r in rows.values() if r["is_superseded"]) == 1
