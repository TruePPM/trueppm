"""Tests for the resource assignments projection (issue #2047, ADR-0499).

Covers: the ``IsWorkspaceOperator`` gate on the GET action (the base catalog read
is open to any authenticated user, but this cross-project projection is not — see
get_permissions), cross-project scope (NOT member-scoped), soft-deleted tasks
excluded, deactivated resources still resolve, response shape, ordering, and 404.

**The gate was raised from ``IsOrgAdmin`` in #3569.** ADR-0499 reasoned that the
org-admin gate "is what makes that safe"; it did not, because that gate is
self-grantable by creating a throwaway project, so the projection — task and
project names for one person across every project in the install — was readable by
any authenticated account. ``admin_client`` is kept here deliberately as a
*refused* principal rather than deleted: it is the regression test.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

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
    # A second project the caller is NOT a member of — proves the projection is
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
    """ADMIN on one project — an org admin under ADR-0034, and no longer enough here."""
    ProjectMembership.objects.create(user=admin_user, project=project, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin_user)
    return c


@pytest.fixture
def operator_user(db: object) -> object:
    """A superuser with no WorkspaceMembership row — the implicit-OWNER bootstrap.

    #3569 gates this projection on the stored workspace ADMIN role, and
    ``workspace_role_for_user`` resolves a superuser carrying no row to implicit
    OWNER so a fresh install is administrable before any membership exists. This
    fixture pins that path; ``workspace_admin_client`` below pins the ordinary one.
    """
    return User.objects.create_superuser(username="operator_user", password="pw")


@pytest.fixture
def operator_client(operator_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=operator_user)
    return c


@pytest.fixture
def workspace_admin_client(db: object) -> APIClient:
    """An explicit, stored workspace ADMIN — the principal #3569 actually targets.

    Not a superuser and not a member of any project: this authority exists only
    because it was granted in-app, which is exactly why it cannot be reached by
    creating a throwaway project the way ``IsOrgAdmin`` could.
    """
    user = User.objects.create_user(username="ws_admin_assignments", password="pw")
    ws = Workspace.objects.first() or Workspace.objects.create()
    WorkspaceMembership.objects.create(workspace=ws, user=user, role=WorkspaceRole.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
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
    # The projection 403s even though it is a GET — it must not inherit the base
    # catalog read's open IsAuthenticated gate (IDOR guard).
    res = member_client.get(_url(str(resource.pk)))
    assert res.status_code == 403


def test_org_admin_cannot_read_assignments(admin_client: APIClient, resource: Resource) -> None:
    """#3569: ADMIN on a project is not the principal for a cross-install projection.

    Paired with ``test_operator_sees_cross_project_assignments_with_names`` and
    ``test_workspace_admin_sees_assignments`` below,
    which reaches the same URL and gets the data — so this 403 is the gate, not a
    broken route.
    """
    res = admin_client.get(_url(str(resource.pk)))
    assert res.status_code == 403


def test_anonymous_cannot_read_assignments(db: object, resource: Resource) -> None:
    res = APIClient().get(_url(str(resource.pk)))
    assert res.status_code in (401, 403)


def test_unknown_resource_returns_404(operator_client: APIClient) -> None:
    res = operator_client.get(_url("00000000-0000-0000-0000-000000000000"))
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


def test_operator_sees_cross_project_assignments_with_names(
    operator_client: APIClient,
    resource: Resource,
    project: Project,
    other_project: Project,
) -> None:
    task_a = Task.objects.create(project=project, name="Design", duration=5)
    # Assignment in a project the caller is NOT a member of — must still appear.
    task_b = Task.objects.create(
        project=other_project, name="Build", duration=5, percent_complete=40.0
    )
    TaskResource.objects.create(task=task_a, resource=resource, units=Decimal("1.0"))
    TaskResource.objects.create(task=task_b, resource=resource, units=Decimal("0.5"))

    res = operator_client.get(_url(str(resource.pk)))
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
    operator_client: APIClient, resource: Resource, project: Project
) -> None:
    live = Task.objects.create(project=project, name="Live", duration=3)
    gone = Task.objects.create(project=project, name="Gone", duration=3)
    TaskResource.objects.create(task=live, resource=resource, units=Decimal("1.0"))
    TaskResource.objects.create(task=gone, resource=resource, units=Decimal("1.0"))
    Task.objects.filter(pk=gone.pk).update(is_deleted=True)

    res = operator_client.get(_url(str(resource.pk)))
    rows = _results(res.json())
    assert [r["task_name"] for r in rows] == ["Live"]


def test_deactivated_resource_still_returns_assignments(
    operator_client: APIClient, resource: Resource, project: Project
) -> None:
    task = Task.objects.create(project=project, name="Design", duration=5)
    TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))
    resource.is_deleted = True
    resource.save(update_fields=["is_deleted"])

    res = operator_client.get(_url(str(resource.pk)))
    assert res.status_code == 200
    rows = _results(res.json())
    assert len(rows) == 1


def test_completed_tasks_are_included(
    operator_client: APIClient, resource: Resource, project: Project
) -> None:
    done = Task.objects.create(project=project, name="Done", duration=3, status="COMPLETE")
    TaskResource.objects.create(task=done, resource=resource, units=Decimal("1.0"))
    res = operator_client.get(_url(str(resource.pk)))
    rows = _results(res.json())
    assert [r["task_name"] for r in rows] == ["Done"]
    assert rows[0]["status"] == "COMPLETE"


def test_no_assignments_returns_empty(operator_client: APIClient, resource: Resource) -> None:
    res = operator_client.get(_url(str(resource.pk)))
    assert res.status_code == 200
    assert _results(res.json()) == []


def test_workspace_admin_sees_assignments(
    workspace_admin_client: APIClient, resource: Resource, project: Project
) -> None:
    """The ordinary principal — a granted workspace ADMIN, no superuser flag.

    The sibling tests above all authenticate as a superuser, which reaches this
    surface only through ``workspace_role_for_user``'s implicit-OWNER bootstrap. If
    every positive test took that path, a regression that broke the *explicit* role
    lookup would leave the whole file green.
    """
    task = Task.objects.create(project=project, name="Design", duration=5)
    TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.0"))

    res = workspace_admin_client.get(_url(str(resource.pk)))
    assert res.status_code == 200
    assert [r["task_name"] for r in _results(res.json())] == ["Design"]
