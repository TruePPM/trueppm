"""Tests for ProgramMembershipViewSet (ADR-0070, #502).

Mirrors :mod:`tests/apps/access/test_membership_api` for ProjectMembership.
Covers: list (membership gate), create (Owner only, no over-assign), update
(last-Owner guard), destroy (self-remove allowed, last-Owner guard).
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Methodology, Program

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
def test_create_member_with_role_title(program: Program, owner: object, member: object) -> None:
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
    """The other privileged branch: reassigning the member identity stays Owner-only.

    A payload carrying ``user`` is privileged even alongside a benign role_title, so
    an Admin is rejected — guards the ``new_user`` arm of ``privileged_change`` (#565).
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
    assert resp.status_code == 403
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
