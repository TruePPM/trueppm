"""Tests for the ProjectMembership nested CRUD API."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="admin_u", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member_u", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def owner_membership(project: Project, owner: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)


@pytest.fixture
def owner_client(owner: object, owner_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def member_membership(project: Project, member_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def member_client(member_user: object, member_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


def _url(project: Project, pk: object = None) -> str:
    base = f"/api/v1/projects/{project.pk}/members/"
    return f"{base}{pk}/" if pk else base


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_requires_membership(
    outsider: object, project: Project, owner_membership: ProjectMembership
) -> None:
    c = APIClient()
    c.force_authenticate(user=outsider)
    resp = c.get(_url(project))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_list_visible_to_viewer(project: Project, owner_membership: ProjectMembership) -> None:
    viewer = User.objects.create_user(username="viewer_u", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    resp = c.get(_url(project))
    assert resp.status_code == 200
    assert len(resp.data) == 2  # owner + viewer


@pytest.mark.django_db
def test_list_excludes_soft_deleted(
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    member_membership.soft_delete()
    c = APIClient()
    c.force_authenticate(user=owner_membership.user)
    resp = c.get(_url(project))
    assert resp.status_code == 200
    ids = [m["id"] for m in resp.data]
    assert str(member_membership.pk) not in ids


# ---------------------------------------------------------------------------
# Create (Owner only)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_member_as_owner(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    new_user = User.objects.create_user(username="new_u", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.MEMBER})
    assert resp.status_code == 201
    assert ProjectMembership.objects.filter(project=project, user=new_user).exists()


@pytest.mark.django_db
def test_create_blocked_for_member(
    member_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    new_user = User.objects.create_user(username="new_u2", password="pw")
    resp = member_client.post(_url(project), {"user": str(new_user.pk), "role": Role.VIEWER})
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_cannot_assign_owner_role(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """Owner cannot assign Owner to another user (role >= own role)."""
    new_user = User.objects.create_user(username="new_u3", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.OWNER})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_duplicate_returns_409(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.VIEWER})
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Update (Owner only, role escalation rule)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_partial_update_role_as_owner(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.SCHEDULER})
    assert resp.status_code == 200
    member_membership.refresh_from_db()
    assert member_membership.role == Role.SCHEDULER


@pytest.mark.django_db
def test_partial_update_blocked_for_member(
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = member_client.patch(_url(project, owner_membership.pk), {"role": Role.VIEWER})
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Destroy — self-removal and last-Owner guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_can_self_remove(
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = member_client.delete(_url(project, member_membership.pk))
    assert resp.status_code == 204
    member_membership.refresh_from_db()
    assert member_membership.is_deleted is True


@pytest.mark.django_db
def test_last_owner_guard_on_self_remove(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    resp = owner_client.delete(_url(project, owner_membership.pk))
    assert resp.status_code == 400


@pytest.mark.django_db
def test_owner_can_remove_lower_role(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = owner_client.delete(_url(project, member_membership.pk))
    assert resp.status_code == 204
    member_membership.refresh_from_db()
    assert member_membership.is_deleted is True


@pytest.mark.django_db
def test_member_cannot_remove_owner(
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    resp = member_client.delete(_url(project, owner_membership.pk))
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# role_label field (issue #11 label rename)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_includes_role_label(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """role_label must appear in the membership list response with the correct human label."""
    resp = owner_client.get(_url(project))
    assert resp.status_code == 200
    row = next(m for m in resp.data if m["id"] == str(owner_membership.pk))
    assert row["role_label"] == "Project Admin"


@pytest.mark.django_db
def test_retrieve_includes_role_label(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    resp = owner_client.get(_url(project, owner_membership.pk))
    assert resp.status_code == 200
    assert resp.data["role_label"] == "Project Admin"


# ---------------------------------------------------------------------------
# M4: partial_update role escalation blocked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_partial_update_cannot_assign_equal_role(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """Owner (role=4) cannot assign Owner role (>= own role) to another member."""
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.OWNER})
    assert resp.status_code == 400
