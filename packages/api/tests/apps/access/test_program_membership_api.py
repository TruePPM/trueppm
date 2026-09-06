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
    """
    from unittest.mock import patch

    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)

    with patch.object(
        ProgramMembership.objects,
        "select_for_update",
        return_value=ProgramMembership.objects.none(),
    ):
        resp = _client(owner).post(
            _members_url(program), {"user": str(member.pk), "role": Role.VIEWER}, format="json"
        )

    assert resp.status_code == 409
    assert ProgramMembership.objects.filter(program=program, user=member).count() == 1


@pytest.mark.django_db
def test_an_unexpected_integrity_error_is_not_masked_as_409(
    program: Program, owner: object, member: object
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
