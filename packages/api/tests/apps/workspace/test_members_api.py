"""Tests for the Workspace members API (#518, ADR-0087)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.workspace.models import (
    MemberStatus,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)

User = get_user_model()

LIST_URL = "/api/v1/workspace/members/"


def _detail(user: object) -> str:
    return f"/api/v1/workspace/members/{user.pk}/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def superadmin(db: object) -> object:
    return User.objects.create_user(username="super", password="pw", is_superuser=True)


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(
        username="mem", password="pw", first_name="Mary", last_name="Member", email="m@x.io"
    )


@pytest.mark.django_db
def test_admin_lists_all_members(superadmin: object, member: object) -> None:
    resp = _client(superadmin).get(LIST_URL)
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.data}
    assert str(member.pk) in ids and str(superadmin.pk) in ids
    row = next(r for r in resp.data if r["id"] == str(member.pk))
    assert row["role"] == "Member"  # implicit default for a non-superuser
    assert row["initials"] == "MM"
    assert row["sso"] is False and row["two_fa"] is False


@pytest.mark.django_db
def test_non_admin_sees_only_self(member: object) -> None:
    other = User.objects.create_user(username="other", password="pw")
    resp = _client(member).get(LIST_URL)
    assert resp.status_code == 200
    assert [r["id"] for r in resp.data] == [str(member.pk)]
    assert str(other.pk) not in {r["id"] for r in resp.data}


@pytest.mark.django_db
def test_project_count_annotation(superadmin: object, member: object) -> None:
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    resp = _client(superadmin).get(LIST_URL)
    row = next(r for r in resp.data if r["id"] == str(member.pk))
    assert row["project_count"] == 1


@pytest.mark.django_db
def test_admin_updates_role(superadmin: object, member: object) -> None:
    resp = _client(superadmin).patch(_detail(member), {"role": WorkspaceRole.ADMIN}, format="json")
    assert resp.status_code == 200
    m = WorkspaceMembership.objects.get(user=member)
    assert m.role == WorkspaceRole.ADMIN
    assert m.role_changed_at is not None


@pytest.mark.django_db
def test_actor_cannot_assign_role_above_own(member: object) -> None:
    # An explicit ADMIN actor (not a superuser) cannot grant OWNER.
    ws = Workspace.load()
    WorkspaceMembership.objects.create(workspace=ws, user=member, role=WorkspaceRole.ADMIN)
    target = User.objects.create_user(username="t", password="pw")
    resp = _client(member).patch(_detail(target), {"role": WorkspaceRole.OWNER}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_last_owner_cannot_be_demoted(member: object) -> None:
    ws = Workspace.load()
    # member is an explicit ADMIN actor; sole_owner is the only owner; no superusers.
    WorkspaceMembership.objects.create(workspace=ws, user=member, role=WorkspaceRole.ADMIN)
    sole_owner = User.objects.create_user(username="owner", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=sole_owner, role=WorkspaceRole.OWNER)
    resp = _client(member).patch(_detail(sole_owner), {"role": WorkspaceRole.MEMBER}, format="json")
    assert resp.status_code == 400
    assert WorkspaceMembership.objects.get(user=sole_owner).role == WorkspaceRole.OWNER


@pytest.mark.django_db
def test_delete_deactivates_member(superadmin: object, member: object) -> None:
    resp = _client(superadmin).delete(_detail(member))
    assert resp.status_code == 204
    member.refresh_from_db()
    assert member.is_active is False
    assert WorkspaceMembership.objects.get(user=member).status == MemberStatus.DEACTIVATED


@pytest.mark.django_db
def test_deactivate_revokes_workspace_access(superadmin: object, member: object) -> None:
    ws = Workspace.load()
    WorkspaceMembership.objects.create(
        workspace=ws, user=member, role=WorkspaceRole.MEMBER, status=MemberStatus.DEACTIVATED
    )
    # A deactivated member resolves to no role → cannot even read.
    resp = _client(member).get(LIST_URL)
    assert resp.status_code == 403
