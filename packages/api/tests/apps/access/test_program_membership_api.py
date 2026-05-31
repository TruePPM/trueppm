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
