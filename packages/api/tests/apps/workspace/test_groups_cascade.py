"""Tests for Workspace groups CRUD and the group→project access cascade (#519)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.workspace.models import Group, GroupMembership

User = get_user_model()

GROUPS_URL = "/api/v1/workspace/groups/"


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="grp_admin", password="pw", is_superuser=True)


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Apollo", start_date=date(2026, 1, 1))


@pytest.fixture
def teammate(db: object) -> object:
    return User.objects.create_user(username="teammate", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _membership(project: Project, user: object) -> ProjectMembership | None:
    return ProjectMembership.objects.filter(project=project, user=user, is_deleted=False).first()


def _make_group(admin: object, name: str = "Propulsion") -> str:
    resp = _client(admin).post(GROUPS_URL, {"name": name}, format="json")
    assert resp.status_code == 201
    return resp.data["id"]


# --- CRUD + permissions -----------------------------------------------------


@pytest.mark.django_db
def test_create_and_list_group(admin: object) -> None:
    gid = _make_group(admin, "Avionics")
    listed = _client(admin).get(GROUPS_URL)
    assert any(g["id"] == gid and g["name"] == "Avionics" for g in listed.data)


@pytest.mark.django_db
def test_non_admin_can_read_but_not_create(teammate: object) -> None:
    assert _client(teammate).get(GROUPS_URL).status_code == 200
    assert _client(teammate).post(GROUPS_URL, {"name": "X"}, format="json").status_code == 403


# --- cascade ----------------------------------------------------------------


@pytest.mark.django_db
def test_linking_project_grants_members(admin: object, project: Project, teammate: object) -> None:
    gid = _make_group(admin)
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    resp = _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    assert resp.status_code == 201
    pm = _membership(project, teammate)
    assert pm is not None
    assert pm.role == Role.MEMBER
    assert str(pm.source_group_id) == gid


@pytest.mark.django_db
def test_member_added_after_link_is_granted(
    admin: object, project: Project, teammate: object
) -> None:
    gid = _make_group(admin)
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    assert _membership(project, teammate) is None
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    assert _membership(project, teammate) is not None


@pytest.mark.django_db
def test_role_change_resyncs_membership(admin: object, project: Project, teammate: object) -> None:
    gid = _make_group(admin)
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    # Re-link at a higher role (update_or_create) → cascade re-syncs.
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.ADMIN},
        format="json",
    )
    assert _membership(project, teammate).role == Role.ADMIN


@pytest.mark.django_db
def test_removing_member_revokes_grant(admin: object, project: Project, teammate: object) -> None:
    gid = _make_group(admin)
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    assert _membership(project, teammate) is not None
    _client(admin).delete(f"{GROUPS_URL}{gid}/members/{teammate.pk}/")
    assert _membership(project, teammate) is None


@pytest.mark.django_db
def test_removing_project_link_revokes_grant(
    admin: object, project: Project, teammate: object
) -> None:
    gid = _make_group(admin)
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    _client(admin).delete(f"{GROUPS_URL}{gid}/projects/{project.pk}/")
    assert _membership(project, teammate) is None


@pytest.mark.django_db
def test_direct_grant_wins_over_group(admin: object, project: Project, teammate: object) -> None:
    # A direct membership (source_group is None) must never be altered or revoked
    # by group reconciliation (ADR-0087 §5).
    ProjectMembership.objects.create(project=project, user=teammate, role=Role.ADMIN)
    gid = _make_group(admin)
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    pm = _membership(project, teammate)
    assert pm.role == Role.ADMIN  # unchanged by the lower group grant
    assert pm.source_group_id is None
    # Removing from the group leaves the direct grant intact.
    _client(admin).delete(f"{GROUPS_URL}{gid}/members/{teammate.pk}/")
    pm = _membership(project, teammate)
    assert pm is not None and pm.role == Role.ADMIN


@pytest.mark.django_db
def test_group_cannot_confer_owner(admin: object, project: Project) -> None:
    gid = _make_group(admin)
    resp = _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.OWNER},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_highest_role_across_overlapping_groups(
    admin: object, project: Project, teammate: object
) -> None:
    g1 = _make_group(admin, "G1")
    g2 = _make_group(admin, "G2")
    for gid, role in ((g1, Role.MEMBER), (g2, Role.ADMIN)):
        _client(admin).post(
            f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json"
        )
        _client(admin).post(
            f"{GROUPS_URL}{gid}/projects/",
            {"project": str(project.pk), "role": role},
            format="json",
        )
    assert _membership(project, teammate).role == Role.ADMIN  # max of the two
    # Drop the ADMIN group → falls back to the MEMBER grant.
    _client(admin).delete(f"{GROUPS_URL}{g2}/members/{teammate.pk}/")
    assert _membership(project, teammate).role == Role.MEMBER


@pytest.mark.django_db
def test_deleting_group_revokes_grants(admin: object, project: Project, teammate: object) -> None:
    gid = _make_group(admin)
    _client(admin).post(f"{GROUPS_URL}{gid}/members/", {"user": str(teammate.pk)}, format="json")
    _client(admin).post(
        f"{GROUPS_URL}{gid}/projects/",
        {"project": str(project.pk), "role": Role.MEMBER},
        format="json",
    )
    _client(admin).delete(f"{GROUPS_URL}{gid}/")
    assert _membership(project, teammate) is None
    assert not Group.objects.filter(pk=gid, is_deleted=False).exists()
    assert (
        GroupMembership.objects.filter(group_id=gid, is_deleted=False).exists() is True
    )  # kept; group soft-deleted
