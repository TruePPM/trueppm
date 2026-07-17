"""Tests for the resource assignments projection (issue #2047, ADR-0499).

Covers: IsOrgAdmin gate on the GET action (the base catalog read is open to any
authenticated user, but this cross-project projection is not — see get_permissions),
cross-project scope (NOT member-scoped), soft-deleted tasks excluded, deactivated
resources still resolve, response shape, ordering, and 404.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


def _url(resource_id: str) -> str:
    return f"/api/v1/resources/{resource_id}/assignments/"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", hours_per_day=8.0)


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date="2025-01-01", calendar=calendar)


@pytest.fixture
def other_project(calendar: Calendar) -> Project:
    # A second project the admin is NOT a member of — proves the projection is
    # cross-project, not scoped to the caller's memberships.
    return Project.objects.create(name="Bravo", start_date="2025-01-01", calendar=calendar)


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="pm_user", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member_user", password="pw")


@pytest.fixture
def admin_client(admin_user: object, project: Project) -> APIClient:
    # ADMIN on ONE project makes the user an org admin (ADR-0034 / IsOrgAdmin).
    ProjectMembership.objects.create(user=admin_user, project=project, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin_user)
    return c


@pytest.fixture
def member_client(member_user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(user=member_user, project=project, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def resource(db: object) -> Resource:
    return Resource.objects.create(name="Dana", email="dana@example.com", max_units=1.0)


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


def test_member_cannot_read_assignments(member_client: APIClient, resource: Resource) -> None:
    # Below org-admin the projection 403s even though it is a GET — it must not
    # inherit the base catalog read's open IsAuthenticated gate (IDOR guard).
    res = member_client.get(_url(str(resource.pk)))
    assert res.status_code == 403


def test_anonymous_cannot_read_assignments(db: object, resource: Resource) -> None:
    res = APIClient().get(_url(str(resource.pk)))
    assert res.status_code in (401, 403)


def test_unknown_resource_returns_404(admin_client: APIClient) -> None:
    res = admin_client.get(_url("00000000-0000-0000-0000-000000000000"))
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Projection behavior
# ---------------------------------------------------------------------------


def _results(payload: object) -> list[dict]:
    # DRF pagination wraps the list in {results: [...]} — unwrap either shape.
    if isinstance(payload, dict) and "results" in payload:
        return payload["results"]
    assert isinstance(payload, list)
    return payload


def test_admin_sees_cross_project_assignments_with_names(
    admin_client: APIClient,
    resource: Resource,
    project: Project,
    other_project: Project,
) -> None:
    task_a = Task.objects.create(project=project, name="Design", duration=5)
    # Assignment in a project the admin is NOT a member of — must still appear.
    task_b = Task.objects.create(
        project=other_project, name="Build", duration=5, percent_complete=40.0
    )
    TaskResource.objects.create(task=task_a, resource=resource, units=Decimal("1.0"))
    TaskResource.objects.create(task=task_b, resource=resource, units=Decimal("0.5"))

    res = admin_client.get(_url(str(resource.pk)))
    assert res.status_code == 200
    rows = _results(res.json())
    assert len(rows) == 2

    # Ordered by project name then task name: Alpha/Design before Bravo/Build.
    assert [r["project_name"] for r in rows] == ["Alpha", "Bravo"]
    build = next(r for r in rows if r["task_name"] == "Build")
    assert build["project_name"] == "Bravo"
    assert build["project"] == str(other_project.pk)
    assert build["task"] == str(task_b.pk)
    assert build["status"]  # e.g. "NOT_STARTED"
    assert build["percent_complete"] == 40.0
    assert build["units"] == "0.50"


def test_soft_deleted_tasks_are_excluded(
    admin_client: APIClient, resource: Resource, project: Project
) -> None:
    live = Task.objects.create(project=project, name="Live", duration=3)
    gone = Task.objects.create(project=project, name="Gone", duration=3)
    TaskResource.objects.create(task=live, resource=resource, units=Decimal("1.0"))
    TaskResource.objects.create(task=gone, resource=resource, units=Decimal("1.0"))
    Task.objects.filter(pk=gone.pk).update(is_deleted=True)

    res = admin_client.get(_url(str(resource.pk)))
    rows = _results(res.json())
    assert [r["task_name"] for r in rows] == ["Live"]


def test_deactivated_resource_still_returns_assignments(
    admin_client: APIClient, resource: Resource, project: Project
) -> None:
    task = Task.objects.create(project=project, name="Design", duration=5)
    TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
    resource.is_deleted = True
    resource.save(update_fields=["is_deleted"])

    res = admin_client.get(_url(str(resource.pk)))
    assert res.status_code == 200
    rows = _results(res.json())
    assert len(rows) == 1


def test_completed_tasks_are_included(
    admin_client: APIClient, resource: Resource, project: Project
) -> None:
    done = Task.objects.create(project=project, name="Done", duration=3, status="COMPLETE")
    TaskResource.objects.create(task=done, resource=resource, units=Decimal("1.0"))
    res = admin_client.get(_url(str(resource.pk)))
    rows = _results(res.json())
    assert [r["task_name"] for r in rows] == ["Done"]
    assert rows[0]["status"] == "COMPLETE"


def test_no_assignments_returns_empty(admin_client: APIClient, resource: Resource) -> None:
    res = admin_client.get(_url(str(resource.pk)))
    assert res.status_code == 200
    assert _results(res.json()) == []
