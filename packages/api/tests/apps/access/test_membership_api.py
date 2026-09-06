"""Tests for the ProjectMembership nested CRUD API."""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

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


@pytest.fixture
def non_owner_client(request: pytest.FixtureRequest, project: Project) -> APIClient:
    """A client authenticated as a member holding the parametrized non-Owner role.

    Parametrized via ``request.param`` over ADMIN/SCHEDULER/VIEWER — the roles
    adjacent to the Owner-only member-management gate. These sit *above* the
    Member-403 case already covered, so they pin that relaxing the Owner-only
    gate to Admin (a one-token change) is a privilege escalation the suite catches.
    """
    role = request.param
    user = User.objects.create_user(username=f"nonowner_{int(role)}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
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


@pytest.mark.django_db
def test_create_without_role_uses_project_default(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """Omitting role falls back to the project's default_member_role (ADR-0363)."""
    project.default_member_role = Role.SCHEDULER
    project.save(update_fields=["default_member_role"])
    new_user = User.objects.create_user(username="defaulted", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk)})  # no role
    assert resp.status_code == 201, resp.data
    assert resp.data["role"] == Role.SCHEDULER
    membership = ProjectMembership.objects.get(project=project, user=new_user)
    assert membership.role == Role.SCHEDULER


@pytest.mark.django_db
def test_create_without_role_defaults_to_member_when_unset(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """A project left at its MEMBER default seeds MEMBER for a role-less add."""
    new_user = User.objects.create_user(username="def_member", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk)})
    assert resp.status_code == 201, resp.data
    assert resp.data["role"] == Role.MEMBER


@pytest.mark.django_db
def test_create_explicit_role_overrides_project_default(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """An explicit role in the payload wins over the project default."""
    project.default_member_role = Role.VIEWER
    project.save(update_fields=["default_member_role"])
    new_user = User.objects.create_user(username="explicit", password="pw")
    resp = owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.ADMIN})
    assert resp.status_code == 201, resp.data
    assert resp.data["role"] == Role.ADMIN


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
    """Owner (role == Role.OWNER) cannot assign Owner role (>= own role) to another member."""
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.OWNER})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_update_role_last_owner_guard(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """The sole Owner cannot PATCH themselves below Owner — the last-Owner guard.

    Demoting the only Owner (here to ADMIN) would strand the project with zero
    Owners. ``partial_update`` trips ``_check_last_owner_guard`` (access/views.py)
    and returns 400 with the role unchanged. Mirrors
    ``test_program_membership_api.py::test_update_role_last_owner_guard`` — the
    program suite covered this branch; the project suite did not, so removing the
    guard's three lines would let the last Owner self-demote and ship green.
    """
    resp = owner_client.patch(_url(project, owner_membership.pk), {"role": Role.ADMIN})
    assert resp.status_code == 400
    owner_membership.refresh_from_db()
    assert owner_membership.role == Role.OWNER


# ---------------------------------------------------------------------------
# Member management is Owner-only — the roles between Member and Owner must be
# blocked too (#1508). The suite tested only Owner-allowed and Member-403, so a
# relaxation of the Owner-only gate to Admin (one token) would ship green. These
# pin ADMIN/SCHEDULER/VIEWER at 403 on every write path.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "non_owner_client", [Role.ADMIN, Role.SCHEDULER, Role.VIEWER], indirect=True
)
def test_create_member_blocked_for_non_owner(
    non_owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """Adding a member requires Owner — Admin/Scheduler/Viewer are all 403."""
    new_user = User.objects.create_user(username="added_by_non_owner", password="pw")
    resp = non_owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.VIEWER})
    assert resp.status_code == 403
    assert not ProjectMembership.objects.filter(project=project, user=new_user).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "non_owner_client", [Role.ADMIN, Role.SCHEDULER, Role.VIEWER], indirect=True
)
def test_partial_update_role_blocked_for_non_owner(
    non_owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """Changing another member's role requires Owner — non-Owners are all 403."""
    resp = non_owner_client.patch(_url(project, member_membership.pk), {"role": Role.SCHEDULER})
    assert resp.status_code == 403
    member_membership.refresh_from_db()
    assert member_membership.role == Role.MEMBER


@pytest.mark.django_db
@pytest.mark.parametrize(
    "non_owner_client", [Role.ADMIN, Role.SCHEDULER, Role.VIEWER], indirect=True
)
def test_destroy_other_member_blocked_for_non_owner(
    non_owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """Removing another member requires Owner — non-Owners are all 403 (self-removal excepted)."""
    resp = non_owner_client.delete(_url(project, member_membership.pk))
    assert resp.status_code == 403
    member_membership.refresh_from_db()
    assert member_membership.is_deleted is False


# ---------------------------------------------------------------------------
# #590: per-project access evidence (joined_at / role_changed_at)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_new_membership_backfills_joined_at_and_null_role_changed_at(
    member_membership: ProjectMembership,
) -> None:
    """A freshly created membership has joined_at set and role_changed_at NULL.

    role_changed_at NULL is the "no role change since joining" signal the read
    serializer and UI key off; the migration leaves existing rows in the same
    state (joined_at backfilled via default, role_changed_at NULL).
    """
    assert member_membership.joined_at is not None
    assert member_membership.role_changed_at is None


@pytest.mark.django_db
def test_list_includes_access_evidence_fields(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    resp = owner_client.get(_url(project))
    assert resp.status_code == 200
    row = next(m for m in resp.data if m["id"] == str(owner_membership.pk))
    assert row["joined_at"] is not None
    assert row["role_changed_at"] is None


@pytest.mark.django_db
def test_partial_update_stamps_role_changed_at(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """An actual role change stamps role_changed_at at/after the join time."""
    assert member_membership.role_changed_at is None
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.SCHEDULER})
    assert resp.status_code == 200
    assert resp.data["role_changed_at"] is not None
    member_membership.refresh_from_db()
    assert member_membership.role_changed_at is not None
    assert member_membership.role_changed_at >= member_membership.joined_at


@pytest.mark.django_db
def test_partial_update_same_role_does_not_stamp(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """A no-op PATCH that re-sends the current role must not advance role_changed_at."""
    resp = owner_client.patch(_url(project, member_membership.pk), {"role": Role.MEMBER})
    assert resp.status_code == 200
    member_membership.refresh_from_db()
    assert member_membership.role_changed_at is None


@pytest.mark.django_db
def test_transfer_project_ownership_stamps_both_rows(
    project: Project,
    owner: object,
    member_user: object,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    """The ownership-transfer service stamps role_changed_at on both affected rows.

    This is the second role-change path (alongside the PATCH endpoint); without
    stamping here the access-evidence timestamp would silently miss transfers.
    """
    from trueppm_api.apps.access.services import transfer_project_ownership

    transfer_project_ownership(project=project, new_owner=member_user, actor=owner)

    owner_membership.refresh_from_db()
    member_membership.refresh_from_db()
    assert owner_membership.role == Role.ADMIN
    assert member_membership.role == Role.OWNER
    assert owner_membership.role_changed_at is not None
    assert member_membership.role_changed_at is not None


# ---------------------------------------------------------------------------
# Other-active-projects count + visibility-gated names (#598)
# ---------------------------------------------------------------------------


def _make_project(name: str, *, archived: bool = False, deleted: bool = False) -> Project:
    p = Project.objects.create(name=name, start_date=date(2026, 1, 1))
    if archived:
        p.is_archived = True
        p.save(update_fields=["is_archived"])
    if deleted:
        p.is_deleted = True
        p.save(update_fields=["is_deleted"])
    return p


def _row_for(resp: object, user: object) -> dict[str, object]:
    return next(r for r in resp.data if str(r["user"]) == str(user.pk))  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_list_includes_other_active_project_count(
    owner_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    for name in ("Apollo", "Gemini"):
        ProjectMembership.objects.create(
            project=_make_project(name), user=member_user, role=Role.MEMBER
        )
    resp = owner_client.get(_url(project))
    assert resp.status_code == 200
    assert _row_for(resp, member_user)["other_active_project_count"] == 2


@pytest.mark.django_db
def test_count_excludes_archived_and_soft_deleted_projects(
    owner_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    ProjectMembership.objects.create(
        project=_make_project("ActiveOne"), user=member_user, role=Role.MEMBER
    )
    ProjectMembership.objects.create(
        project=_make_project("Archived", archived=True), user=member_user, role=Role.MEMBER
    )
    ProjectMembership.objects.create(
        project=_make_project("Deleted", deleted=True), user=member_user, role=Role.MEMBER
    )
    resp = owner_client.get(_url(project))
    assert _row_for(resp, member_user)["other_active_project_count"] == 1  # only ActiveOne


@pytest.mark.django_db
def test_count_excludes_the_current_project(
    owner_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    resp = owner_client.get(_url(project))
    assert _row_for(resp, member_user)["other_active_project_count"] == 0


@pytest.mark.django_db
def test_names_listed_only_for_projects_the_requester_owns(
    owner: object,
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    # member_user is on two other active projects; the requester (owner) is OWNER of
    # Apollo but only a MEMBER of Gemini — so only Apollo's name may be revealed.
    apollo = _make_project("Apollo")
    gemini = _make_project("Gemini")
    ProjectMembership.objects.create(project=apollo, user=member_user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=gemini, user=member_user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=apollo, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=gemini, user=owner, role=Role.MEMBER)

    row = _row_for(owner_client.get(_url(project)), member_user)
    assert row["other_active_project_count"] == 2  # full count is not gated
    assert row["other_active_project_names"] == ["Apollo"]  # names are gated to owned projects


@pytest.mark.django_db
def test_names_empty_when_requester_owns_no_shared_projects(
    owner: object,
    member_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
) -> None:
    # The requester (a plain MEMBER) owns no other projects, so they see counts but
    # no project names for anyone.
    ProjectMembership.objects.create(project=_make_project("Apollo"), user=owner, role=Role.MEMBER)
    row = _row_for(member_client.get(_url(project)), owner)
    assert row["other_active_project_count"] == 1
    assert row["other_active_project_names"] == []


# ---------------------------------------------------------------------------
# Re-adding a revoked member (#3410)
#
# (project, user) uniqueness is unconditional, so the row a revoked member leaves
# behind still owns the slot. The add path therefore has to revive that row; an
# INSERT hits the constraint and used to surface as a 500.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_re_add_revoked_member_revives_the_original_row(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    original_pk = member_membership.pk
    original_joined_at = member_membership.joined_at
    member_membership.soft_delete()

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert resp.status_code == 201, resp.data
    assert resp.data["id"] == str(original_pk)
    revived = ProjectMembership.objects.get(pk=original_pk)
    assert revived.is_deleted is False
    assert revived.deleted_version is None
    # Same membership resuming — the identity an offline client holds, and the
    # access-evidence "since when", both survive.
    assert revived.joined_at == original_joined_at
    assert ProjectMembership.objects.filter(project=project, user=member_user).count() == 1


@pytest.mark.django_db
def test_re_add_revoked_member_at_a_different_role_stamps_the_new_role(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    member_membership.soft_delete()

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.SCHEDULER})

    assert resp.status_code == 201, resp.data
    assert resp.data["role"] == Role.SCHEDULER
    revived = ProjectMembership.objects.get(pk=member_membership.pk)
    assert revived.role == Role.SCHEDULER
    assert revived.role_changed_at is not None


@pytest.mark.django_db
def test_re_add_revoked_member_at_the_same_role_does_not_stamp_role_changed_at(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """Same rule partial_update uses — no role change, no role-change event (#590)."""
    member_membership.soft_delete()

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert resp.status_code == 201, resp.data
    assert ProjectMembership.objects.get(pk=member_membership.pk).role_changed_at is None


@pytest.mark.django_db
def test_re_add_revoked_member_restores_api_access(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """The point of the fix: the member can reach the project again afterwards."""
    member_membership.soft_delete()
    revoked_client = APIClient()
    revoked_client.force_authenticate(user=member_user)
    assert revoked_client.get(_url(project)).status_code == 403

    owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert revoked_client.get(_url(project)).status_code == 200


@pytest.mark.django_db
def test_re_add_revoked_member_cannot_exceed_the_callers_own_role(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """Revive is not a way around the strictly-below-your-own-role guard."""
    member_membership.soft_delete()

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.OWNER})

    assert resp.status_code == 400
    assert ProjectMembership.objects.get(pk=member_membership.pk).is_deleted is True


@pytest.mark.django_db
def test_re_add_revoked_group_derived_member_becomes_a_direct_grant(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """A hand-granted membership must not stay revocable by group reconciliation.

    ``workspace.services._reconcile_pair`` only revokes rows it owns
    (``source_group IS NOT NULL``); leaving the FK set on a revived row would let a
    later reconcile take away access an Owner granted directly.
    """
    from trueppm_api.apps.workspace.models import Group, Workspace

    group = Group.objects.create(workspace=Workspace.load(), name="Propulsion")
    member_membership.source_group = group
    member_membership.save(update_fields=["source_group"])
    member_membership.soft_delete()

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert resp.status_code == 201, resp.data
    assert ProjectMembership.objects.get(pk=member_membership.pk).source_group_id is None


@pytest.mark.django_db
def test_re_add_revoked_member_broadcasts_member_added(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
    django_capture_on_commit_callbacks: Any,
) -> None:
    member_membership.soft_delete()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as spy,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert resp.status_code == 201, resp.data
    added = [call for call in spy.call_args_list if call.args[1] == "member_added"]
    assert added, spy.call_args_list
    # The payload carries the ORIGINAL row id — a client reconciling its roster
    # upserts the membership it already knows rather than appending a second one.
    assert added[0].args[2]["membership_id"] == str(member_membership.pk)
    assert added[0].args[2]["role"] == Role.MEMBER


@pytest.mark.django_db
def test_live_duplicate_409_leaves_the_existing_row_untouched(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """The 409 must stay a refusal, not a silent role change on the live row."""
    before = ProjectMembership.objects.get(pk=member_membership.pk)

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.VIEWER})

    assert resp.status_code == 409
    after = ProjectMembership.objects.get(pk=member_membership.pk)
    assert after.role == before.role
    assert after.server_version == before.server_version


@pytest.mark.django_db
def test_insert_race_answers_409_not_500(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """No row exists to lock, so two concurrent adds can both reach the INSERT.

    Simulates the real condition rather than the symptom: a live row is already
    present and the *lookup* is stubbed blind to it, so the view takes the INSERT
    branch and the database raises a genuine IntegrityError. That is what makes
    the savepoint load-bearing — the connection is really poisoned, and without it
    the 409 response could not be written and ATOMIC_REQUESTS could not commit.
    """
    racer = User.objects.create_user(username="racer", password="pw")
    ProjectMembership.objects.create(project=project, user=racer, role=Role.MEMBER)

    with patch.object(
        ProjectMembership.objects,
        "select_for_update",
        return_value=ProjectMembership.objects.none(),
    ):
        resp = owner_client.post(_url(project), {"user": str(racer.pk), "role": Role.VIEWER})

    assert resp.status_code == 409
    # The transaction survived the caught IntegrityError — a poisoned connection
    # would raise TransactionManagementError here instead.
    assert ProjectMembership.objects.filter(project=project, user=racer).count() == 1


@pytest.mark.django_db
def test_an_unexpected_integrity_error_is_not_masked_as_409(
    owner_client: APIClient, project: Project, owner_membership: ProjectMembership
) -> None:
    """Only the (project, user) uniqueness race becomes a 409.

    A blanket ``except IntegrityError`` would report an FK violation, or any
    constraint added to this table later, as "user is already a member" — a wrong
    answer to the client and a silent swallow of a future integrity control.
    """
    from django.db import IntegrityError

    new_user = User.objects.create_user(username="not_a_dup", password="pw")
    with (
        patch(
            "trueppm_api.apps.access.views.ProjectMembershipWriteSerializer.save",
            side_effect=IntegrityError("some other constraint"),
        ),
        pytest.raises(IntegrityError),
    ):
        owner_client.post(_url(project), {"user": str(new_user.pk), "role": Role.MEMBER})


@pytest.mark.django_db
def test_revived_membership_syncs_as_an_update_not_a_tombstone(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """The sync-protocol consequence, asserted end to end (ADR-0202, ADR-0686).

    A client that pulled the tombstone holds the row as deleted. The revive draws a
    fresh ``sync_seq``, and the delta splits purely on the current ``is_deleted``,
    so the next pull returns the *same id* in ``updated`` — an upsert over the
    tombstoned record, never a second row.
    """
    sync_url = f"/api/v1/projects/{project.pk}/sync/"
    member_membership.soft_delete()
    tombstone = owner_client.get(sync_url, {"since": "0"}).data
    assert str(member_membership.pk) in tombstone["changes"]["memberships"]["deleted"]
    since = tombstone["timestamp"]

    owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.SCHEDULER})

    delta = owner_client.get(sync_url, {"since": str(since)}).data["changes"]["memberships"]
    assert [row["id"] for row in delta["updated"]] == [str(member_membership.pk)]
    assert delta["deleted"] == []


@pytest.mark.django_db
def test_re_add_revoked_member_without_a_role_uses_the_project_default(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """The ADR-0363 fallback decides the revived role, not just the inserted one.

    Pinned to a default that differs from the revoked role, so the assertion fails
    if the fallback is ever wired only into the INSERT branch.
    """
    project.default_member_role = Role.SCHEDULER
    project.save(update_fields=["default_member_role"])
    member_membership.soft_delete()

    resp = owner_client.post(_url(project), {"user": str(member_user.pk)})  # no role

    assert resp.status_code == 201, resp.data
    assert resp.data["role"] == Role.SCHEDULER
    revived = ProjectMembership.objects.get(pk=member_membership.pk)
    assert revived.role == Role.SCHEDULER
    assert revived.role_changed_at is not None


@pytest.mark.django_db
def test_re_add_is_refused_on_an_archived_project(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
) -> None:
    """IsProjectNotArchived still gates the revive branch.

    The revive is exactly where a future "the row already exists, just resurrect
    it" shortcut would bypass the archive gate, so pin the refusal behaviorally
    rather than relying on the declared-permission-class sweep.
    """
    member_membership.soft_delete()
    project.is_archived = True
    project.save(update_fields=["is_archived"])

    resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert resp.status_code == 403
    assert ProjectMembership.objects.get(pk=member_membership.pk).is_deleted is True


@pytest.mark.django_db
def test_re_add_below_member_still_schedules_the_eviction(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """Documents a real quirk of the revive path rather than asserting it is absent.

    ``access.signals._evict_on_revocation`` is a pre_save receiver that compares
    the stored role against the incoming one without consulting ``is_deleted``, so
    reviving a revoked MEMBER at VIEWER trips its ``demoted_below_member`` branch
    and queues an evict during an *add*. It is harmless (a revoked user holds no
    live socket, and a Viewer cannot open one) and corrective if the revoke-time
    evict was ever lost, so it is pinned, not suppressed.
    """
    member_membership.soft_delete()
    with (
        patch("trueppm_api.apps.access.signals.evict_project_connection") as evict,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.VIEWER})

    assert resp.status_code == 201, resp.data
    assert evict.called
    assert ProjectMembership.objects.get(pk=member_membership.pk).role == Role.VIEWER


@pytest.mark.django_db
def test_re_add_restores_the_team_facets_the_revocation_floored(
    owner_client: APIClient,
    project: Project,
    owner_membership: ProjectMembership,
    member_membership: ProjectMembership,
    member_user: object,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """The reason #3410 was load-bearing rather than merely a stale-data 500.

    #3386 put a live-``ProjectMembership`` floor under ``user_facets``, so revoking
    someone drops their Scrum Master / Product Owner facet even though the mirrored
    ``TeamMembership`` row survives untouched (the ADR-0078 mirror is create-only).
    Re-adding them is therefore the *only* way to restore a floored facet — which is
    precisely what used to 500. This is the largest access-restoring side effect of
    the revive, so it is pinned rather than left implied.
    """
    from trueppm_api.apps.teams.models import TeamMembership
    from trueppm_api.apps.teams.services import ensure_team_membership, user_facets

    ensure_team_membership(project_id=project.pk, user_id=member_user.pk, project_role=Role.MEMBER)
    TeamMembership.objects.filter(
        team__project_id=project.pk, user_id=member_user.pk, is_deleted=False
    ).update(is_scrum_master=True)
    assert user_facets(member_user, project.pk)["is_scrum_master"] is True

    member_membership.soft_delete()
    # Floored by the revocation even though the team row still says True.
    assert user_facets(member_user, project.pk)["is_scrum_master"] is False
    assert (
        user_facets(member_user, project.pk, live_project_members_only=False)["is_scrum_master"]
        is True
    )

    with django_capture_on_commit_callbacks(execute=True):
        resp = owner_client.post(_url(project), {"user": str(member_user.pk), "role": Role.MEMBER})

    assert resp.status_code == 201, resp.data
    assert user_facets(member_user, project.pk)["is_scrum_master"] is True
