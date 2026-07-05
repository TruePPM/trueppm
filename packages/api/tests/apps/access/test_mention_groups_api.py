"""Tests for user-defined @mention group CRUD, RBAC, and resolution (ADR-0212, #515)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.groups import resolve_user_defined_group_members
from trueppm_api.apps.access.models import ProjectMembership, Role, UserDefinedMentionGroup
from trueppm_api.apps.projects.models import Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def other_project(db: object) -> Project:
    return Project.objects.create(name="Other", start_date=date(2026, 1, 1))


def _member(project: Project, username: str, role: int) -> object:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def admin_user(project: Project) -> object:
    return _member(project, "admin_u", Role.ADMIN)


@pytest.fixture
def scheduler_user(project: Project) -> object:
    return _member(project, "sched_u", Role.SCHEDULER)


@pytest.fixture
def member_user(project: Project) -> object:
    return _member(project, "member_u", Role.MEMBER)


@pytest.fixture
def viewer_user(project: Project) -> object:
    return _member(project, "viewer_u", Role.VIEWER)


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.id}/mention-groups/"


# ---------------------------------------------------------------------------
# Create — RBAC + validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_can_create_group(project: Project, admin_user: object) -> None:
    resp = _client(admin_user).post(
        _url(project), {"name": "subcontractors", "description": "site subs"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["name"] == "subcontractors"
    assert resp.data["email_default_on"] is False
    assert resp.data["member_count"] == 0
    assert UserDefinedMentionGroup.objects.filter(project=project, name="subcontractors").exists()


@pytest.mark.django_db
@pytest.mark.parametrize("role_fixture", ["scheduler_user", "member_user", "viewer_user"])
def test_below_admin_cannot_create_group(
    project: Project, request: pytest.FixtureRequest, role_fixture: str
) -> None:
    user = request.getfixturevalue(role_fixture)
    resp = _client(user).post(_url(project), {"name": "subs"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_outsider_cannot_create_group(project: Project, outsider: object) -> None:
    resp = _client(outsider).post(_url(project), {"name": "subs"}, format="json")
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_name_uniqueness_case_insensitive(project: Project, admin_user: object) -> None:
    _client(admin_user).post(_url(project), {"name": "Subs"}, format="json")
    resp = _client(admin_user).post(_url(project), {"name": "subs"}, format="json")
    assert resp.status_code == 400
    assert "already exists" in str(resp.data).lower()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "reserved", ["admins", "owners", "schedulers", "members", "viewers", "all", "scrum-team"]
)
def test_reserved_auto_group_names_rejected(
    project: Project, admin_user: object, reserved: str
) -> None:
    resp = _client(admin_user).post(_url(project), {"name": reserved}, format="json")
    assert resp.status_code == 400
    assert "reserved" in str(resp.data).lower()


@pytest.mark.django_db
def test_leading_at_and_bad_chars_handled(project: Project, admin_user: object) -> None:
    # Leading @ is stripped and stored without it.
    ok = _client(admin_user).post(_url(project), {"name": "@inspectors"}, format="json")
    assert ok.status_code == 201
    assert ok.data["name"] == "inspectors"
    # A space is not a valid mention token.
    bad = _client(admin_user).post(_url(project), {"name": "bad name"}, format="json")
    assert bad.status_code == 400


@pytest.mark.django_db
def test_same_name_allowed_in_different_projects(
    project: Project, other_project: Project, admin_user: object
) -> None:
    # admin_user is admin on `project` only; make them admin on other_project too.
    ProjectMembership.objects.create(project=other_project, user=admin_user, role=Role.ADMIN)
    a = _client(admin_user).post(_url(project), {"name": "subs"}, format="json")
    b = _client(admin_user).post(_url(other_project), {"name": "subs"}, format="json")
    assert a.status_code == 201
    assert b.status_code == 201


# ---------------------------------------------------------------------------
# Rename / delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_can_rename_and_delete(project: Project, admin_user: object) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    detail = f"{_url(project)}{group.id}/"
    r = _client(admin_user).patch(detail, {"name": "trades"}, format="json")
    assert r.status_code == 200
    assert r.data["name"] == "trades"
    d = _client(admin_user).delete(detail)
    assert d.status_code == 204
    group.refresh_from_db()
    assert group.is_deleted is True


@pytest.mark.django_db
def test_name_reusable_after_soft_delete(project: Project, admin_user: object) -> None:
    # The unique constraint is partial (is_deleted=False), so a deleted group's
    # name is free to reuse — must NOT raise a 500 IntegrityError.
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    _client(admin_user).delete(f"{_url(project)}{group.id}/")
    resp = _client(admin_user).post(_url(project), {"name": "subs"}, format="json")
    assert resp.status_code == 201, resp.content


@pytest.mark.django_db
def test_cannot_delete_group_on_archived_project(project: Project, admin_user: object) -> None:
    # Archived projects are hard read-only; the shared IsProjectNotArchived bypass
    # for "destroy" is re-asserted explicitly in the viewset (RBAC finding).
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    project.is_archived = True
    project.save()
    resp = _client(admin_user).delete(f"{_url(project)}{group.id}/")
    assert resp.status_code == 403
    group.refresh_from_db()
    assert group.is_deleted is False


@pytest.mark.django_db
def test_scheduler_cannot_rename(project: Project, scheduler_user: object) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    r = _client(scheduler_user).patch(
        f"{_url(project)}{group.id}/", {"name": "trades"}, format="json"
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Membership — Scheduler+ manages, cross-project isolation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_scheduler_can_add_and_remove_member(
    project: Project, scheduler_user: object, member_user: object
) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    add = _client(scheduler_user).post(
        f"{_url(project)}{group.id}/add-member/", {"user": str(member_user.pk)}, format="json"
    )
    assert add.status_code == 200, add.content
    assert add.data["member_count"] == 1
    remove = _client(scheduler_user).post(
        f"{_url(project)}{group.id}/remove-member/", {"user": str(member_user.pk)}, format="json"
    )
    assert remove.status_code == 200
    assert remove.data["member_count"] == 0


@pytest.mark.django_db
def test_member_cannot_add_member(
    project: Project, member_user: object, viewer_user: object
) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    r = _client(member_user).post(
        f"{_url(project)}{group.id}/add-member/", {"user": str(viewer_user.pk)}, format="json"
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_cannot_add_non_project_member(
    project: Project, scheduler_user: object, outsider: object
) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    r = _client(scheduler_user).post(
        f"{_url(project)}{group.id}/add-member/", {"user": str(outsider.pk)}, format="json"
    )
    assert r.status_code == 400
    assert "not a member" in str(r.data).lower()


@pytest.mark.django_db
def test_membership_add_bumps_server_version(
    project: Project, scheduler_user: object, member_user: object
) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    before = group.server_version
    _client(scheduler_user).post(
        f"{_url(project)}{group.id}/add-member/", {"user": str(member_user.pk)}, format="json"
    )
    group.refresh_from_db()
    assert group.server_version > before


@pytest.mark.django_db
def test_group_not_visible_from_other_project(
    project: Project, other_project: Project, admin_user: object
) -> None:
    ProjectMembership.objects.create(project=other_project, user=admin_user, role=Role.ADMIN)
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    # The group's detail is 404 under the WRONG project's URL scope.
    r = _client(admin_user).get(f"{_url(other_project)}{group.id}/")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Mute — any member, self only
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_can_mute_and_unmute(project: Project, viewer_user: object) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    detail = f"{_url(project)}{group.id}/"
    m = _client(viewer_user).post(f"{detail}mute/", {}, format="json")
    assert m.status_code == 200
    assert m.data["muted_by_me"] is True
    assert group.muted_by.filter(pk=viewer_user.pk).exists()
    u = _client(viewer_user).post(f"{detail}unmute/", {}, format="json")
    assert u.status_code == 200
    assert u.data["muted_by_me"] is False


# ---------------------------------------------------------------------------
# Resolver — snapshot-at-write + active-member filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_returns_current_members(
    project: Project, member_user: object, scheduler_user: object
) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    group.members.add(member_user, scheduler_user)
    resolved = resolve_user_defined_group_members(project.id, "subs")
    assert resolved is not None
    assert set(resolved) == {member_user.pk, scheduler_user.pk}


@pytest.mark.django_db
def test_resolver_case_insensitive_and_unknown(project: Project, member_user: object) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="Subs")
    group.members.add(member_user)
    assert resolve_user_defined_group_members(project.id, "subs") == [member_user.pk]
    # A name with no live group resolves to None (caller treats as unknown user).
    assert resolve_user_defined_group_members(project.id, "nope") is None


@pytest.mark.django_db
def test_resolver_excludes_departed_members(project: Project, member_user: object) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    group.members.add(member_user)
    # Member leaves the project (soft-deleted membership) — the lingering M2M row
    # must NOT resolve to a notification target.
    ProjectMembership.objects.filter(project=project, user=member_user).update(is_deleted=True)
    assert resolve_user_defined_group_members(project.id, "subs") == []


@pytest.mark.django_db
def test_deleted_group_does_not_resolve(project: Project, member_user: object) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="subs")
    group.members.add(member_user)
    group.is_deleted = True
    group.save()
    assert resolve_user_defined_group_members(project.id, "subs") is None
