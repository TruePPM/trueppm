"""Tests for ProgramMembershipViewSet (ADR-0070, #502).

Mirrors :mod:`tests/apps/access/test_membership_api` for ProjectMembership.
Covers: list (membership gate), create (Owner only, no over-assign), update
(last-Owner guard), destroy (self-remove allowed, last-Owner guard).
"""

from __future__ import annotations

import threading
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connections
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import (
    PROGRAM_ROLE_LABELS,
    ProgramMembership,
    ProjectMembership,
    Role,
)
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Methodology, Program
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="prog-owner", password="pw")


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="prog-admin", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="prog-member", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="prog-stranger", password="pw")


@pytest.fixture
def program(owner: object) -> Program:
    return create_program(
        name="Phase 2",
        description="",
        methodology=Methodology.HYBRID,
        created_by=owner,
    )


@pytest.fixture
def owner_is_workspace_admin(owner: object) -> WorkspaceMembership:
    """Promote ``owner`` to workspace ADMIN — the principal that may add any account.

    A program Owner reaches only the accounts already on a roster they belong to
    (#3641). A test whose subject is role ceilings, role_title handling or error
    mapping has to take the actor out of that variable; workspace ADMIN is the tier
    the install already hands the directory to, and it is not self-grantable.
    """
    return WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=owner, role=WorkspaceRole.ADMIN
    )


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _make_user(username: str) -> object:
    return User.objects.create_user(username=username, password="pw")


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_members_requires_program_membership(
    program: Program,
    stranger: object,
) -> None:
    resp = _client(stranger).get(f"/api/v1/programs/{program.pk}/members/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_list_members_returns_active_only(program: Program, owner: object) -> None:
    # The owner's auto-membership is the only active row.
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/members/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["role"] == Role.OWNER


@pytest.mark.django_db
def test_list_members_self_query(program: Program, owner: object) -> None:
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/members/?self=true")
    assert resp.status_code == 200
    assert len(resp.data) == 1


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_member_requires_owner(
    program: Program,
    owner: object,
    admin_user: object,
    member: object,
) -> None:
    # An ADMIN cannot create new members — only OWNER can.
    ProgramMembership.objects.create(program=program, user=admin_user, role=Role.ADMIN)
    resp = _client(admin_user).post(
        f"/api/v1/programs/{program.pk}/members/",
        {"user": str(member.pk), "role": Role.MEMBER},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_member_cannot_assign_role_at_or_above_own(
    program: Program,
    owner: object,
    member: object,
) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/members/",
        {"user": str(member.pk), "role": Role.OWNER},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_member_duplicate_returns_409(
    program: Program,
    owner: object,
    member: object,
) -> None:
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/members/",
        {"user": str(member.pk), "role": Role.ADMIN},
        format="json",
    )
    assert resp.status_code == 409


@pytest.mark.django_db
def test_create_member_succeeds_under_owner_role(
    program: Program,
    owner: object,
    member: object,
    owner_is_workspace_admin: WorkspaceMembership,
) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/members/",
        {"user": str(member.pk), "role": Role.MEMBER},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["role"] == Role.MEMBER
    assert resp.data["role_label"] == "Team Member"


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_role_last_owner_guard(program: Program, owner: object) -> None:
    owner_membership = ProgramMembership.objects.get(program=program, user=owner)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/members/{owner_membership.pk}/",
        {"role": Role.ADMIN},
        format="json",
    )
    # Cannot demote the last OWNER below OWNER — caller role check trips first
    # because new_role would equal actor_role; both guards converge on rejection.
    assert resp.status_code == 400


@pytest.mark.django_db
def test_update_role_last_owner_guard_passes_with_a_second_owner(
    program: Program, owner: object
) -> None:
    """Demoting an Owner succeeds when another Owner remains — see the project twin."""
    owner_membership = ProgramMembership.objects.get(program=program, user=owner)
    second_owner = _make_user("second-prog-owner")
    second_owner_membership = ProgramMembership.objects.create(
        program=program, user=second_owner, role=Role.OWNER
    )

    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/members/{owner_membership.pk}/",
        {"role": Role.ADMIN},
        format="json",
    )

    assert resp.status_code == 200, resp.data
    owner_membership.refresh_from_db()
    assert owner_membership.role == Role.ADMIN
    second_owner_membership.refresh_from_db()
    assert second_owner_membership.role == Role.OWNER


@pytest.mark.django_db
def test_update_role_succeeds_for_owner(
    program: Program,
    owner: object,
    member: object,
) -> None:
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/members/{m.pk}/",
        {"role": Role.ADMIN},
        format="json",
    )
    assert resp.status_code == 200
    m.refresh_from_db()
    assert m.role == Role.ADMIN


# ---------------------------------------------------------------------------
# Destroy
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_remove_other_member_requires_owner(
    program: Program,
    owner: object,
    admin_user: object,
    member: object,
) -> None:
    ProgramMembership.objects.create(program=program, user=admin_user, role=Role.ADMIN)
    member_membership = ProgramMembership.objects.create(
        program=program, user=member, role=Role.MEMBER
    )
    resp = _client(admin_user).delete(
        f"/api/v1/programs/{program.pk}/members/{member_membership.pk}/"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_owner_cannot_remove_a_peer_owner(program: Program, owner: object) -> None:
    """The peer-role guard is an authorization decision → 403, not 400 (#3365)."""
    peer = _make_user("prog-peer-owner")
    peer_membership = ProgramMembership.objects.create(program=program, user=peer, role=Role.OWNER)
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/members/{peer_membership.pk}/")
    assert resp.status_code == 403
    assert resp.json() == {"detail": "You can only remove members with a role lower than your own."}
    peer_membership.refresh_from_db()
    assert peer_membership.is_deleted is False


@pytest.mark.django_db
def test_self_remove_allowed_for_non_owner(
    program: Program,
    owner: object,
    member: object,
) -> None:
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(member).delete(f"/api/v1/programs/{program.pk}/members/{m.pk}/")
    assert resp.status_code == 204
    m.refresh_from_db()
    assert m.is_deleted is True


@pytest.mark.django_db
def test_last_owner_cannot_self_remove(program: Program, owner: object) -> None:
    m = ProgramMembership.objects.get(program=program, user=owner)
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/members/{m.pk}/")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# #878: per-program access evidence (joined_at / role_changed_at) — mirrors the
# #590 ProjectMembership coverage in test_membership_api.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_new_membership_backfills_joined_at_and_null_role_changed_at(
    program: Program, member: object
) -> None:
    """A freshly created membership has joined_at set and role_changed_at NULL."""
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    assert m.joined_at is not None
    assert m.role_changed_at is None


@pytest.mark.django_db
def test_list_includes_access_evidence_fields(program: Program, owner: object) -> None:
    owner_membership = ProgramMembership.objects.get(program=program, user=owner)
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/members/")
    assert resp.status_code == 200
    row = next(m for m in resp.data if m["id"] == str(owner_membership.pk))
    assert row["joined_at"] is not None
    assert row["role_changed_at"] is None


@pytest.mark.django_db
def test_partial_update_stamps_role_changed_at(
    program: Program, owner: object, member: object
) -> None:
    """An actual role change stamps role_changed_at at/after the join time."""
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    assert m.role_changed_at is None
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/members/{m.pk}/",
        {"role": Role.SCHEDULER},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["role_changed_at"] is not None
    m.refresh_from_db()
    assert m.role_changed_at is not None
    assert m.role_changed_at >= m.joined_at


@pytest.mark.django_db
def test_partial_update_same_role_does_not_stamp(
    program: Program, owner: object, member: object
) -> None:
    """A no-op PATCH that re-sends the current role must not advance role_changed_at."""
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/members/{m.pk}/",
        {"role": Role.MEMBER},
        format="json",
    )
    assert resp.status_code == 200
    m.refresh_from_db()
    assert m.role_changed_at is None


@pytest.mark.django_db
def test_transfer_program_sponsorship_stamps_both_rows(
    program: Program, owner: object, member: object
) -> None:
    """The sponsorship-transfer service stamps role_changed_at on both rows.

    This is the second role-change path (alongside the PATCH endpoint); without
    stamping here the access-evidence timestamp would silently miss transfers.
    """
    from trueppm_api.apps.access.services import transfer_program_sponsorship

    owner_membership = ProgramMembership.objects.get(program=program, user=owner)
    target = ProgramMembership.objects.create(program=program, user=member, role=Role.ADMIN)

    transfer_program_sponsorship(program=program, new_owner=member, actor=owner)

    owner_membership.refresh_from_db()
    target.refresh_from_db()
    assert owner_membership.role == Role.ADMIN
    assert target.role == Role.OWNER
    assert owner_membership.role_changed_at is not None
    assert target.role_changed_at is not None


# ---------------------------------------------------------------------------
# role_title — freeform functional-role label (#565)
# ---------------------------------------------------------------------------


def _members_url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/members/"


@pytest.mark.django_db
def test_role_title_defaults_to_empty(program: Program, owner: object, member: object) -> None:
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    assert m.role_title == ""
    resp = _client(owner).get(_members_url(program))
    row = next(r for r in resp.data if r["id"] == str(m.pk))
    assert row["role_title"] == ""


@pytest.mark.django_db
def test_create_member_with_role_title(
    program: Program,
    owner: object,
    member: object,
    owner_is_workspace_admin: WorkspaceMembership,
) -> None:
    resp = _client(owner).post(
        _members_url(program),
        {"user": str(member.pk), "role": Role.MEMBER, "role_title": "Product Owner"},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["role_title"] == "Product Owner"
    # role_label (access-role display name) stays distinct from the freeform title.
    assert resp.data["role_label"] == "Team Member"
    assert ProgramMembership.objects.get(pk=resp.data["id"]).role_title == "Product Owner"


@pytest.mark.django_db
def test_owner_sets_role_title(program: Program, owner: object, member: object) -> None:
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(owner).patch(
        f"{_members_url(program)}{m.pk}/", {"role_title": "Tech Lead"}, format="json"
    )
    assert resp.status_code == 200, resp.data
    m.refresh_from_db()
    assert m.role_title == "Tech Lead"


@pytest.mark.django_db
def test_admin_can_set_role_title_only(program: Program, owner: object, admin_user: object) -> None:
    """A role_title-only PATCH is benign metadata — allowed at Admin+ (#565)."""
    ProgramMembership.objects.create(program=program, user=admin_user, role=Role.ADMIN)
    target = ProgramMembership.objects.create(
        program=program, user=_make_user("po-target"), role=Role.MEMBER
    )
    resp = _client(admin_user).patch(
        f"{_members_url(program)}{target.pk}/", {"role_title": "Product Owner"}, format="json"
    )
    assert resp.status_code == 200, resp.data
    target.refresh_from_db()
    assert target.role_title == "Product Owner"


@pytest.mark.django_db
def test_admin_cannot_change_role_via_patch(
    program: Program, owner: object, admin_user: object
) -> None:
    """Relaxing role_title to Admin must NOT open access-role changes to Admin (#565)."""
    ProgramMembership.objects.create(program=program, user=admin_user, role=Role.ADMIN)
    target = ProgramMembership.objects.create(
        program=program, user=_make_user("role-target"), role=Role.MEMBER
    )
    resp = _client(admin_user).patch(
        f"{_members_url(program)}{target.pk}/", {"role": Role.ADMIN}, format="json"
    )
    assert resp.status_code == 403
    target.refresh_from_db()
    assert target.role == Role.MEMBER


@pytest.mark.django_db
def test_admin_cannot_reassign_user_via_patch(
    program: Program, owner: object, admin_user: object
) -> None:
    """Reassigning the member identity is refused at Admin — and now at every role.

    This used to assert a *role* gate: ``user`` made the payload privileged, so an
    Admin got 403 while an Owner would have succeeded. #3641 removed the capability
    instead of the caller — a PATCH carrying ``user`` is a 400 whoever sends it (see
    ``test_owner_cannot_reassign_user_via_patch``), because swapping the account
    behind a live row was the second door onto the address harvest. The refusal is
    explicit rather than a silent drop, so a 200 never means "ignored".
    """
    ProgramMembership.objects.create(program=program, user=admin_user, role=Role.ADMIN)
    original = _make_user("orig-user")
    target = ProgramMembership.objects.create(program=program, user=original, role=Role.MEMBER)
    other = _make_user("reassign-target")
    resp = _client(admin_user).patch(
        f"{_members_url(program)}{target.pk}/",
        {"user": str(other.pk), "role_title": "PO"},
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "user" in resp.data
    target.refresh_from_db()
    assert target.user_id == original.pk
    assert target.role_title == ""


@pytest.mark.django_db
def test_member_cannot_set_role_title(program: Program, member: object) -> None:
    # The member must belong to the program (else the membership gate trips first);
    # a plain Member is still below the Admin floor for a role_title edit.
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    target = ProgramMembership.objects.create(
        program=program, user=_make_user("rt-target"), role=Role.MEMBER
    )
    resp = _client(member).patch(
        f"{_members_url(program)}{target.pk}/", {"role_title": "PO"}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_role_title_blank_coerced_to_empty(program: Program, owner: object, member: object) -> None:
    m = ProgramMembership.objects.create(
        program=program, user=member, role=Role.MEMBER, role_title="Tech Lead"
    )
    resp = _client(owner).patch(
        f"{_members_url(program)}{m.pk}/", {"role_title": "   "}, format="json"
    )
    assert resp.status_code == 200, resp.data
    m.refresh_from_db()
    assert m.role_title == ""


@pytest.mark.django_db
def test_role_title_max_length_enforced(program: Program, owner: object, member: object) -> None:
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(owner).patch(
        f"{_members_url(program)}{m.pk}/", {"role_title": "x" * 51}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_role_title_only_patch_does_not_stamp_role_changed_at(
    program: Program, owner: object, member: object
) -> None:
    """A role_title-only edit is not a role change — role_changed_at stays NULL (#565)."""
    m = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    assert m.role_changed_at is None
    before = m.server_version
    resp = _client(owner).patch(
        f"{_members_url(program)}{m.pk}/", {"role_title": "Architect"}, format="json"
    )
    assert resp.status_code == 200, resp.data
    m.refresh_from_db()
    assert m.role_changed_at is None
    # The write still bumps server_version so the change rides the offline-sync
    # stream (this is the change-record mechanism for a VersionedModel).
    assert m.server_version > before


# ---------------------------------------------------------------------------
# Re-adding a revoked member (#3410)
#
# ProgramMembership carries the identical unconditional (program, user)
# constraint, so it carried the identical 500. These mirror the project-side
# tests in test_membership_api.py.
# ---------------------------------------------------------------------------


def _members_url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/members/"


@pytest.mark.django_db
def test_re_add_revoked_member_revives_the_original_row(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    original_joined_at = existing.joined_at
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert resp.data["id"] == str(existing.pk)
    revived = ProgramMembership.objects.get(pk=existing.pk)
    assert revived.is_deleted is False
    assert revived.deleted_version is None
    assert revived.joined_at == original_joined_at
    assert ProgramMembership.objects.filter(program=program, user=member).count() == 1


@pytest.mark.django_db
def test_re_add_revoked_member_at_a_different_role_stamps_the_new_role(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.SCHEDULER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert resp.data["role"] == Role.SCHEDULER
    revived = ProgramMembership.objects.get(pk=existing.pk)
    assert revived.role == Role.SCHEDULER
    assert revived.role_changed_at is not None


@pytest.mark.django_db
def test_re_add_revoked_member_at_the_same_role_does_not_stamp_role_changed_at(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert ProgramMembership.objects.get(pk=existing.pk).role_changed_at is None


@pytest.mark.django_db
def test_re_add_revoked_member_resets_role_title_when_none_is_supplied(
    program: Program, owner: object, member: object
) -> None:
    """A revive is observably a fresh add — an omitted role_title means "unset"."""
    existing = ProgramMembership.objects.create(
        program=program, user=member, role=Role.MEMBER, role_title="Tech Lead"
    )
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert ProgramMembership.objects.get(pk=existing.pk).role_title == ""


@pytest.mark.django_db
def test_re_add_revoked_member_applies_a_supplied_role_title(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(
        program=program, user=member, role=Role.MEMBER, role_title="Tech Lead"
    )
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program),
        {"user": str(member.pk), "role": Role.MEMBER, "role_title": "Product Owner"},
        format="json",
    )

    assert resp.status_code == 201, resp.data
    assert ProgramMembership.objects.get(pk=existing.pk).role_title == "Product Owner"


@pytest.mark.django_db
def test_re_add_revoked_member_restores_api_access(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()
    assert _client(member).get(_members_url(program)).status_code == 403

    _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert _client(member).get(_members_url(program)).status_code == 200


# ---------------------------------------------------------------------------
# #3436: reinstatement evidence — mirrors the project-side block exactly.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_re_add_revoked_member_stamps_reinstated_at(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    assert existing.reinstated_at is None
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert resp.data["reinstated_at"] is not None
    revived = ProgramMembership.objects.get(pk=existing.pk)
    assert revived.reinstated_at is not None
    assert revived.reinstated_at >= revived.joined_at


@pytest.mark.django_db
def test_re_add_revoked_member_stamps_reinstated_at_even_at_the_same_role(
    program: Program, owner: object, member: object
) -> None:
    """Unconditional on revive, unlike role_changed_at — see the project-side twin."""
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    revived = ProgramMembership.objects.get(pk=existing.pk)
    assert revived.role_changed_at is None
    assert revived.reinstated_at is not None


@pytest.mark.django_db
def test_second_revive_advances_reinstated_at(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()
    _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )
    first_reinstated_at = ProgramMembership.objects.get(pk=existing.pk).reinstated_at
    assert first_reinstated_at is not None

    ProgramMembership.objects.get(pk=existing.pk).soft_delete()
    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    second_reinstated_at = ProgramMembership.objects.get(pk=existing.pk).reinstated_at
    assert second_reinstated_at is not None
    assert second_reinstated_at > first_reinstated_at


@pytest.mark.django_db
def test_fresh_add_response_carries_null_reinstated_at(
    program: Program, owner: object, owner_is_workspace_admin: WorkspaceMembership
) -> None:
    """Workspace-admin fixture, not a shared roster — see the project-side twin."""
    new_user = _make_user("prog-fresh-add")

    resp = _client(owner).post(
        _members_url(program), {"user": str(new_user.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert resp.data["reinstated_at"] is None


@pytest.mark.django_db
def test_re_add_revoked_member_cannot_exceed_the_callers_own_role(
    program: Program, owner: object, member: object
) -> None:
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.OWNER}, format="json"
    )

    assert resp.status_code == 400
    assert ProgramMembership.objects.get(pk=existing.pk).is_deleted is True


@pytest.mark.django_db
def test_live_duplicate_409_leaves_the_existing_row_untouched(
    program: Program, owner: object, member: object
) -> None:
    before = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.VIEWER}, format="json"
    )

    assert resp.status_code == 409
    after = ProgramMembership.objects.get(pk=before.pk)
    assert after.role == before.role
    assert after.server_version == before.server_version


@pytest.mark.django_db
def test_insert_race_answers_409_not_500(program: Program, owner: object, member: object) -> None:
    """Two concurrent adds with no row to lock: the loser gets 409, not a 500.

    Real condition, not a stubbed exception — a live row is present and the lookup
    is blinded to it, so the INSERT raises a genuine IntegrityError and the
    savepoint is what keeps the transaction usable afterwards.

    Blinding *every* ``select_for_update()`` call (as this used to) now also
    blinds the actor-row lock `create` added for #3438, which would misread the
    owner as not a member. Excluding only ``member``'s row keeps the actor
    lookup real while still hiding the racing row from the combined lock.
    """
    from unittest.mock import patch

    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)

    with patch.object(
        ProgramMembership.objects,
        "select_for_update",
        side_effect=lambda *args, **kwargs: ProgramMembership.objects.exclude(
            user=member
        ).select_for_update(*args, **kwargs),
    ):
        resp = _client(owner).post(
            _members_url(program), {"user": str(member.pk), "role": Role.VIEWER}, format="json"
        )

    assert resp.status_code == 409
    assert ProgramMembership.objects.filter(program=program, user=member).count() == 1


@pytest.mark.django_db
def test_an_unexpected_integrity_error_is_not_masked_as_409(
    program: Program,
    owner: object,
    member: object,
    owner_is_workspace_admin: WorkspaceMembership,
) -> None:
    """Only the (program, user) uniqueness race becomes a 409."""
    from unittest.mock import patch

    from django.db import IntegrityError

    with (
        patch(
            "trueppm_api.apps.access.views.ProgramMembershipWriteSerializer.save",
            side_effect=IntegrityError("some other constraint"),
        ),
        pytest.raises(IntegrityError),
    ):
        _client(owner).post(
            _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
        )


@pytest.mark.django_db
def test_revived_membership_is_delivered_as_an_update_not_a_tombstone(
    program: Program, owner: object, member: object
) -> None:
    """The sync-protocol consequence, asserted on what the delta actually reads.

    The program delta selects ``sync_seq__gt=since`` and then splits purely on the
    current ``is_deleted`` (ADR-0747 for the installation-wide allocator, ADR-0202
    for the split). So the two facts that decide the bucket are: the revive drew a
    fresh cursor above the tombstone's, and the row is live. A client holding the
    tombstone therefore gets the same id back in ``updated`` — an upsert, never a
    second row.
    """
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()
    tombstone_seq = ProgramMembership.objects.get(pk=existing.pk).sync_seq

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.SCHEDULER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    revived = ProgramMembership.objects.get(pk=existing.pk)
    assert revived.is_deleted is False
    assert revived.sync_seq > tombstone_seq
    assert ProgramMembership.objects.filter(program=program, user=member).count() == 1


@pytest.mark.django_db
def test_re_add_is_refused_on_a_closed_program(
    program: Program, owner: object, member: object
) -> None:
    """IsProgramNotClosed still gates the revive branch (#530)."""
    existing = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    existing.soft_delete()
    program.is_closed = True
    program.save(update_fields=["is_closed"])

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 403
    assert ProgramMembership.objects.get(pk=existing.pk).is_deleted is True


# ---------------------------------------------------------------------------
# role_label vocabulary (#3503)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected_label"),
    [
        (Role.VIEWER, "Viewer"),
        (Role.MEMBER, "Team Member"),
        (Role.SCHEDULER, "Resource Manager"),
        (Role.ADMIN, "Program Manager"),
        (Role.OWNER, "Program Admin"),
    ],
)
def test_members_list_role_label_uses_program_vocabulary(
    program: Program, owner: object, member: object, role: int, expected_label: str
) -> None:
    """``GET /programs/{id}/members/`` names roles for the *program* (#3503).

    Ordinals 300 and 400 used to serialize through the project-scoped
    ``Role.label`` and read "Project Manager" / "Project Admin" on a program
    row; the lower three read the same either way and must not move.
    """
    ProgramMembership.objects.create(program=program, user=member, role=role)

    resp = _client(owner).get(_members_url(program))

    assert resp.status_code == 200, resp.data
    row = next(m for m in resp.data if str(m["user"]) == str(member.pk))
    assert row["role"] == role
    assert row["role_label"] == expected_label


@pytest.mark.django_db
def test_member_retrieve_role_label_uses_program_vocabulary(
    program: Program, owner: object, member: object
) -> None:
    """The detail route reads the same vocabulary as the list route."""
    membership = ProgramMembership.objects.create(program=program, user=member, role=Role.ADMIN)

    resp = _client(owner).get(f"{_members_url(program)}{membership.pk}/")

    assert resp.status_code == 200, resp.data
    assert resp.data["role_label"] == "Program Manager"


@pytest.mark.django_db
def test_members_role_label_agrees_with_program_card_my_role_label(
    program: Program, owner: object, member: object
) -> None:
    """One membership, one name — the defect this issue is about (#3503).

    ``GET /programs/{id}/`` answers ``my_role_label`` and
    ``GET /programs/{id}/members/`` answers ``role_label`` for the *same* row.
    Before the fix they disagreed ("Program Manager" vs "Project Manager") and
    only TruePPM's own web client knew which one to believe.
    """
    ProgramMembership.objects.create(program=program, user=member, role=Role.ADMIN)
    client = _client(member)

    card = client.get(f"/api/v1/programs/{program.pk}/")
    members = client.get(_members_url(program))

    assert card.status_code == 200, card.data
    assert members.status_code == 200, members.data
    row = next(m for m in members.data if str(m["user"]) == str(member.pk))
    assert card.data["my_role_label"] == row["role_label"] == "Program Manager"


@pytest.mark.django_db
def test_members_role_label_degrades_for_an_enterprise_band_ordinal(
    program: Program, owner: object, member: object
) -> None:
    """An ordinal outside the five OSS roles must not 500 the response.

    ADR-0072 reserves 301-399 for Enterprise custom roles and ``role`` is a
    plain ``IntegerField``, so ``Role(350)`` is reachable — and raises
    ``ValueError``, which DRF does not convert. The OSS edition has no name for
    it, so the field echoes the ordinal rather than borrowing a neighbour's
    label; the web client prefers its own vocabulary for ordinals it knows and
    falls back to this string only here.
    """
    ProgramMembership.objects.create(program=program, user=member, role=350)

    resp = _client(owner).get(_members_url(program))

    assert resp.status_code == 200, resp.data
    row = next(m for m in resp.data if str(m["user"]) == str(member.pk))
    assert row["role"] == 350
    assert row["role_label"] == "Role 350"


def test_every_role_has_a_program_label() -> None:
    """A new ``Role`` member must be named for the program too, not fall back.

    The map is exhaustive by design: without this, adding an enum value would
    silently reintroduce a project label on a program surface.
    """
    assert set(PROGRAM_ROLE_LABELS) == set(Role)


def test_program_membership_str_uses_program_vocabulary(program: Program, member: object) -> None:
    """The admin/log repr is a program surface too (#3503)."""
    membership = ProgramMembership(program=program, user=member, role=Role.OWNER)
    assert "Program Admin" in str(membership)
    assert "Project Admin" not in str(membership)


def test_no_program_permission_refusal_uses_project_vocabulary() -> None:
    """A refusal on a program surface must not name a *project* role (#3503).

    The exhaustiveness test above guards the map; this guards the **call sites**,
    which is the half that keeps recurring — #1794 fixed the program card, #3503
    the members list and three refusal messages, and each time the map was
    already right and a new surface reached past it. Every ``IsProgram*``
    permission class only ever refuses on a program, so "Project" in its
    ``message`` is a defect by construction.
    """
    from trueppm_api.apps.access import permissions as perms

    offenders = {
        name: cls.message
        for name, cls in vars(perms).items()
        if name.startswith("IsProgram")
        and isinstance(cls, type)
        and isinstance(getattr(cls, "message", None), str)
        and "Project" in cls.message
    }
    assert offenders == {}, f"program refusals naming a project role: {offenders}"


# ---------------------------------------------------------------------------
# Target reachability (#3641) — mirrors the project twin. `POST /api/v1/programs/`
# is IsAuthenticated and `create_program` auto-OWNERs the caller, so this path is
# reachable from a standing start exactly like the project one.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_refuses_an_account_the_owner_cannot_already_reach(
    program: Program, owner: object
) -> None:
    """A self-minted program Owner may not name an arbitrary account."""
    victim = User.objects.create_user(username="prog-victim", password="pw", email="pv@x.test")

    resp = _client(owner).post(
        _members_url(program), {"user": str(victim.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 400, resp.data
    assert "user" in resp.data
    assert not ProgramMembership.objects.filter(program=program, user=victim).exists()
    assert "pv@x.test" not in str(resp.data)


@pytest.mark.django_db
def test_create_refuses_a_deactivated_account(
    program: Program,
    owner: object,
    member: object,
    owner_is_workspace_admin: WorkspaceMembership,
) -> None:
    """``is_active=False`` stays out of reach even at workspace ADMIN (#1724)."""
    member.is_active = False  # type: ignore[attr-defined]
    member.save(update_fields=["is_active"])  # type: ignore[attr-defined]

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 400, resp.data
    assert "user" in resp.data


@pytest.mark.django_db
def test_create_accepts_someone_sharing_a_project_with_the_owner(
    program: Program, owner: object, member: object
) -> None:
    """The golden path without workspace ADMIN: a colleague from a shared roster."""
    from datetime import date

    from trueppm_api.apps.projects.models import Project

    shared = Project.objects.create(name="Shared", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=shared, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=shared, user=member, role=Role.MEMBER)

    resp = _client(owner).post(
        _members_url(program), {"user": str(member.pk), "role": Role.MEMBER}, format="json"
    )

    assert resp.status_code == 201, resp.data
    assert ProgramMembership.objects.filter(program=program, user=member).exists()


@pytest.mark.django_db
def test_owner_cannot_reassign_user_via_patch(
    program: Program, owner: object, member: object
) -> None:
    """The second door, at the tier that used to be allowed through it.

    ``partial_update`` treated a payload carrying ``user`` as a privileged change and
    let an Owner through. It is now refused at every role — the capability is gone,
    not merely gated (#3641).
    """
    target = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    victim = User.objects.create_user(username="prog-reassign", password="pw", email="pr@x.test")

    resp = _client(owner).patch(
        f"{_members_url(program)}{target.pk}/", {"user": str(victim.pk)}, format="json"
    )

    assert resp.status_code == 400, resp.data
    assert "user" in resp.data
    target.refresh_from_db()
    assert target.user_id == member.pk  # type: ignore[attr-defined]
    assert "pr@x.test" not in str(resp.data)


@pytest.mark.django_db
def test_patch_still_changes_a_role_and_role_title(
    program: Program, owner: object, member: object
) -> None:
    """The legitimate update paths are untouched by the ``user`` refusal."""
    target = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)

    resp = _client(owner).patch(
        f"{_members_url(program)}{target.pk}/",
        {"role": Role.SCHEDULER, "role_title": "Tech Lead"},
        format="json",
    )

    assert resp.status_code == 200, resp.data
    target.refresh_from_db()
    assert target.role == Role.SCHEDULER
    assert target.role_title == "Tech Lead"


@pytest.mark.django_db
def test_below_admin_reassignment_attempt_is_a_403_not_a_400(
    program: Program, owner: object, member: object
) -> None:
    """A below-Admin caller is refused on *authority*, before the field is examined.

    ``user`` is now refused by the serializer, which runs before the in-body role
    check — so without an Admin floor at the permission layer a plain Member would
    read "bad request" for what is a permission refusal, inverting this file's own
    convention (#3365). ``get_permissions`` states the floor the body already
    enforces, which keeps the status honest.
    """
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    target = ProgramMembership.objects.create(
        program=program, user=_make_user("floor-target"), role=Role.MEMBER
    )
    victim = User.objects.create_user(username="floor-victim", password="pw")

    resp = _client(member).patch(
        f"{_members_url(program)}{target.pk}/", {"user": str(victim.pk)}, format="json"
    )

    assert resp.status_code == 403, resp.data
    target.refresh_from_db()
    assert target.user_id != victim.pk


# ---------------------------------------------------------------------------
# #3438: create() reads the actor's role under the same lock discipline as
# partial_update, closing the TOCTOU window a concurrent demotion opened.
# See the project-side twin (test_membership_api.py) for the full rationale.
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_create_role_check_serializes_against_concurrent_actor_demotion() -> None:
    """A second, genuinely separate connection holds the actor's row locked.

    Needs ``transaction=True``: a genuinely separate connection only sees rows
    the test has actually committed.
    """
    owner = User.objects.create_user(username="prog-conc-owner", password="pw")
    program = create_program(
        name="Concurrency", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    owner_membership = ProgramMembership.objects.get(program=program, user=owner)
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=owner, role=WorkspaceRole.ADMIN
    )
    new_user = _make_user("prog-conc-new")

    table = ProgramMembership._meta.db_table
    lock_acquired = threading.Event()
    release_lock = threading.Event()

    def _hold_lock_then_demote() -> None:
        other = connections.create_connection("default")
        try:
            with other.cursor() as cursor:
                cursor.execute("BEGIN")
                cursor.execute(
                    f"SELECT id FROM {table} WHERE id = %s FOR UPDATE",
                    [str(owner_membership.pk)],
                )
                lock_acquired.set()
                release_lock.wait(timeout=5)
                cursor.execute(
                    f"UPDATE {table} SET role = %s WHERE id = %s",
                    [int(Role.ADMIN), str(owner_membership.pk)],
                )
                cursor.execute("COMMIT")
        finally:
            other.close()

    holder = threading.Thread(target=_hold_lock_then_demote)
    holder.start()
    try:
        assert lock_acquired.wait(timeout=5), "the competing connection never acquired its lock"

        result: dict[str, Any] = {}

        def _create() -> None:
            try:
                result["resp"] = _client(owner).post(
                    _members_url(program),
                    {"user": str(new_user.pk), "role": Role.ADMIN},
                    format="json",
                )
            finally:
                # This thread opened its own DB connection (Django connections are
                # thread-local); close it explicitly rather than leaving it for
                # test-database teardown to trip over.
                connections.close_all()

        creator = threading.Thread(target=_create)
        creator.start()
        try:
            creator.join(timeout=1)
            assert creator.is_alive(), "create() did not block on the actor's locked row"
        finally:
            release_lock.set()
            creator.join(timeout=5)
    finally:
        holder.join(timeout=5)

    resp = result["resp"]
    # Refused: create() re-read the actor's row after the demotion committed,
    # and ADMIN is below the OWNER floor create() re-verifies under lock.
    assert resp.status_code == 403, resp.data
    assert not ProgramMembership.objects.filter(program=program, user=new_user).exists()
    owner_membership.refresh_from_db()
    assert owner_membership.role == Role.ADMIN
