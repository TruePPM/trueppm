"""Tests for the Workspace members API (#518, ADR-0087)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import ApiToken, Project
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
    rows = resp.data["results"]  # cursor-paginated (#1317)
    ids = {row["id"] for row in rows}
    assert str(member.pk) in ids and str(superadmin.pk) in ids
    row = next(r for r in rows if r["id"] == str(member.pk))
    assert row["role"] == "Member"  # implicit default for a non-superuser
    assert row["initials"] == "MM"
    assert row["sso"] is False and row["two_fa"] is False


@pytest.mark.django_db
def test_non_admin_sees_only_self(member: object) -> None:
    other = User.objects.create_user(username="other", password="pw")
    resp = _client(member).get(LIST_URL)
    assert resp.status_code == 200
    rows = resp.data["results"]
    assert [r["id"] for r in rows] == [str(member.pk)]
    assert str(other.pk) not in {r["id"] for r in rows}


@pytest.mark.django_db
def test_project_count_annotation(superadmin: object, member: object) -> None:
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    resp = _client(superadmin).get(LIST_URL)
    row = next(r for r in resp.data["results"] if r["id"] == str(member.pk))
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
def test_actor_cannot_assign_role_equal_to_own(member: object) -> None:
    """#1728: an Admin cannot mint a peer Admin (role equal to their own).

    ``>`` previously allowed this, creating a peer that neither Admin could then
    manage (the peer-guard blocks modifying members at or above your own role).
    Aligned to ``>=`` to match the project membership gate.
    """
    ws = Workspace.load()
    WorkspaceMembership.objects.create(workspace=ws, user=member, role=WorkspaceRole.ADMIN)
    target = User.objects.create_user(username="t", password="pw")
    resp = _client(member).patch(_detail(target), {"role": WorkspaceRole.ADMIN}, format="json")
    assert resp.status_code == 403
    # The target was not granted the peer role.
    assert not WorkspaceMembership.objects.filter(user=target, role=WorkspaceRole.ADMIN).exists()


@pytest.mark.django_db
def test_owner_can_still_assign_admin(superadmin: object, member: object) -> None:
    """An Owner (strictly above Admin) may still grant Admin — the gate only
    blocks equal-or-higher, so legitimate downward grants are unaffected."""
    resp = _client(superadmin).patch(_detail(member), {"role": WorkspaceRole.ADMIN}, format="json")
    assert resp.status_code == 200
    assert WorkspaceMembership.objects.get(user=member).role == WorkspaceRole.ADMIN


@pytest.mark.django_db
def test_admin_cannot_demote_owner(member: object) -> None:
    ws = Workspace.load()
    # member is an explicit ADMIN actor; sole_owner is the only owner; no superusers.
    WorkspaceMembership.objects.create(workspace=ws, user=member, role=WorkspaceRole.ADMIN)
    sole_owner = User.objects.create_user(username="owner", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=sole_owner, role=WorkspaceRole.OWNER)
    resp = _client(member).patch(_detail(sole_owner), {"role": WorkspaceRole.MEMBER}, format="json")
    # The peer/higher-role guard (#890) blocks an Admin touching an Owner at all —
    # a 403, ahead of (and stronger than) the last-Owner stranding guard's 400.
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=sole_owner).role == WorkspaceRole.OWNER


@pytest.mark.django_db
def test_owner_cannot_demote_last_owner(db: object) -> None:
    """The last-Owner stranding guard still fires for an Owner-on-Owner demote (#890)."""
    ws = Workspace.load()
    # An explicit OWNER actor demoting the sole owner (themselves is excluded from
    # the role guard via self-edit, but here a second owner row is the target).
    owner_actor = User.objects.create_user(username="own_actor", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=owner_actor, role=WorkspaceRole.OWNER)
    # Demoting themselves would strand the workspace (no other owner). Self-edit is
    # exempt from the role guard, so the stranding guard is what must catch this.
    resp = _client(owner_actor).patch(
        _detail(owner_actor), {"role": WorkspaceRole.MEMBER}, format="json"
    )
    assert resp.status_code == 400
    assert WorkspaceMembership.objects.get(user=owner_actor).role == WorkspaceRole.OWNER


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


# --- #890: peer/higher-role guard on deactivate + role change ---------------


@pytest.mark.django_db
def test_admin_cannot_deactivate_peer_admin_via_patch(db: object) -> None:
    """An Admin must not deactivate another Admin (#890)."""
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_a", password="pw")
    peer = User.objects.create_user(username="adm_b", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=peer, role=WorkspaceRole.ADMIN)
    resp = _client(actor).patch(_detail(peer), {"status": MemberStatus.DEACTIVATED}, format="json")
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=peer).status == MemberStatus.ACTIVE


@pytest.mark.django_db
def test_admin_cannot_deactivate_peer_admin_via_delete(db: object) -> None:
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_c", password="pw")
    peer = User.objects.create_user(username="adm_d", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=peer, role=WorkspaceRole.ADMIN)
    resp = _client(actor).delete(_detail(peer))
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=peer).status == MemberStatus.ACTIVE


@pytest.mark.django_db
def test_admin_cannot_deactivate_owner(db: object) -> None:
    """An Admin must not deactivate an Owner, even when a second Owner exists (#890)."""
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_e", password="pw")
    owner_one = User.objects.create_user(username="own_1", password="pw")
    owner_two = User.objects.create_user(username="own_2", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    # Two owners so the last-owner guard would NOT block — only the role guard does.
    WorkspaceMembership.objects.create(workspace=ws, user=owner_one, role=WorkspaceRole.OWNER)
    WorkspaceMembership.objects.create(workspace=ws, user=owner_two, role=WorkspaceRole.OWNER)
    resp = _client(actor).delete(_detail(owner_one))
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=owner_one).status == MemberStatus.ACTIVE


@pytest.mark.django_db
def test_admin_cannot_change_role_of_peer_admin(db: object) -> None:
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_f", password="pw")
    peer = User.objects.create_user(username="adm_g", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=peer, role=WorkspaceRole.ADMIN)
    resp = _client(actor).patch(_detail(peer), {"role": WorkspaceRole.MEMBER}, format="json")
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=peer).role == WorkspaceRole.ADMIN


@pytest.mark.django_db
def test_admin_cannot_reactivate_deactivated_owner(db: object) -> None:
    """A non-owner Admin must not reactivate a deactivated Owner (#901).

    Reactivation (status→ACTIVE) is a privilege change just like deactivation, so
    it is gated by the same peer/higher-role guard — otherwise a lower-role Admin
    could flip a deactivated Owner back to ACTIVE and restore their login.
    """
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_react", password="pw")
    owner = User.objects.create_user(username="own_deact", password="pw", is_active=False)
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(
        workspace=ws, user=owner, role=WorkspaceRole.OWNER, status=MemberStatus.DEACTIVATED
    )
    resp = _client(actor).patch(_detail(owner), {"status": MemberStatus.ACTIVE}, format="json")
    assert resp.status_code == 403
    owner.refresh_from_db()
    assert owner.is_active is False
    assert WorkspaceMembership.objects.get(user=owner).status == MemberStatus.DEACTIVATED


@pytest.mark.django_db
def test_admin_cannot_reactivate_deactivated_peer_admin(db: object) -> None:
    """A non-owner Admin must not reactivate a deactivated peer Admin (#901)."""
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_react2", password="pw")
    peer = User.objects.create_user(username="adm_deact", password="pw", is_active=False)
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(
        workspace=ws, user=peer, role=WorkspaceRole.ADMIN, status=MemberStatus.DEACTIVATED
    )
    resp = _client(actor).patch(_detail(peer), {"status": MemberStatus.ACTIVE}, format="json")
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=peer).status == MemberStatus.DEACTIVATED


@pytest.mark.django_db
def test_admin_can_reactivate_lower_member(db: object) -> None:
    """The reactivation guard must not over-block: an Admin can reactivate a Member (#901)."""
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_react3", password="pw")
    target = User.objects.create_user(username="mem_deact", password="pw", is_active=False)
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(
        workspace=ws, user=target, role=WorkspaceRole.MEMBER, status=MemberStatus.DEACTIVATED
    )
    resp = _client(actor).patch(_detail(target), {"status": MemberStatus.ACTIVE}, format="json")
    assert resp.status_code == 200, resp.data
    target.refresh_from_db()
    assert target.is_active is True
    assert WorkspaceMembership.objects.get(user=target).status == MemberStatus.ACTIVE


@pytest.mark.django_db
def test_admin_can_still_deactivate_lower_member(db: object) -> None:
    """The guard must not over-block: an Admin can deactivate a Member (#890)."""
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_h", password="pw")
    target = User.objects.create_user(username="mem_low", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=target, role=WorkspaceRole.MEMBER)
    resp = _client(actor).delete(_detail(target))
    assert resp.status_code == 204
    assert WorkspaceMembership.objects.get(user=target).status == MemberStatus.DEACTIVATED


# --- Resource-availability baseline (#542) ------------------------------------


@pytest.mark.django_db
def test_member_row_defaults_to_full_availability(superadmin: object, member: object) -> None:
    """A member with no explicit baseline reads as 100% available, no bounds (#542)."""
    resp = _client(superadmin).get(LIST_URL)
    row = next(r for r in resp.data["results"] if r["id"] == str(member.pk))
    assert row["availability_percent"] == 100
    assert row["availability_effective_from"] is None
    assert row["availability_effective_to"] is None
    assert row["availability_notes"] == ""


@pytest.mark.django_db
def test_admin_sets_availability_baseline(superadmin: object, member: object) -> None:
    resp = _client(superadmin).patch(
        _detail(member),
        {
            "availability_percent": 80,
            "availability_effective_from": "2026-07-01",
            "availability_effective_to": "2026-09-30",
            "availability_notes": "Part-time contract this quarter",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["availability_percent"] == 80
    assert resp.data["availability_effective_from"] == "2026-07-01"
    m = WorkspaceMembership.objects.get(user=member)
    assert m.availability_percent == 80
    assert m.availability_effective_from == date(2026, 7, 1)
    assert m.availability_effective_to == date(2026, 9, 30)
    assert m.availability_notes == "Part-time contract this quarter"


@pytest.mark.django_db
def test_member_views_own_availability(member: object) -> None:
    """A non-admin sees their own baseline on the self-scoped list row (#542)."""
    ws = Workspace.load()
    WorkspaceMembership.objects.create(
        workspace=ws, user=member, role=WorkspaceRole.MEMBER, availability_percent=60
    )
    resp = _client(member).get(LIST_URL)
    rows = resp.data["results"]
    assert [r["id"] for r in rows] == [str(member.pk)]
    assert rows[0]["availability_percent"] == 60


@pytest.mark.django_db
def test_member_cannot_edit_availability(member: object) -> None:
    """Edit is Owner/Admin only — a plain member PATCHing availability is rejected (#542)."""
    target = User.objects.create_user(username="avail_t", password="pw")
    resp = _client(member).patch(_detail(target), {"availability_percent": 50}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_availability_percent_zero_is_honored(superadmin: object, member: object) -> None:
    """0% is a legitimate value — the presence check must not treat it as 'omitted' (#542)."""
    resp = _client(superadmin).patch(_detail(member), {"availability_percent": 0}, format="json")
    assert resp.status_code == 200, resp.data
    assert WorkspaceMembership.objects.get(user=member).availability_percent == 0


@pytest.mark.django_db
def test_availability_percent_above_100_rejected(superadmin: object, member: object) -> None:
    resp = _client(superadmin).patch(_detail(member), {"availability_percent": 101}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_availability_from_after_to_rejected(superadmin: object, member: object) -> None:
    resp = _client(superadmin).patch(
        _detail(member),
        {
            "availability_effective_from": "2026-09-30",
            "availability_effective_to": "2026-07-01",
        },
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_partial_bound_validated_against_stored_bound(superadmin: object, member: object) -> None:
    """A PATCH setting only `to` earlier than the stored `from` is rejected (#542)."""
    ws = Workspace.load()
    WorkspaceMembership.objects.create(
        workspace=ws,
        user=member,
        role=WorkspaceRole.MEMBER,
        availability_effective_from=date(2026, 8, 1),
    )
    resp = _client(superadmin).patch(
        _detail(member), {"availability_effective_to": "2026-07-01"}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_explicit_null_clears_stored_bound(superadmin: object, member: object) -> None:
    ws = Workspace.load()
    WorkspaceMembership.objects.create(
        workspace=ws,
        user=member,
        role=WorkspaceRole.MEMBER,
        availability_effective_from=date(2026, 8, 1),
    )
    resp = _client(superadmin).patch(
        _detail(member), {"availability_effective_from": None}, format="json"
    )
    assert resp.status_code == 200, resp.data
    assert WorkspaceMembership.objects.get(user=member).availability_effective_from is None


@pytest.mark.django_db
def test_availability_edit_not_blocked_by_peer_guard(db: object) -> None:
    """Availability is benign capacity metadata — an Admin may set a peer Admin's
    baseline even though the peer-guard blocks role/status changes on peers (#542)."""
    ws = Workspace.load()
    actor = User.objects.create_user(username="rm_admin", password="pw")
    peer = User.objects.create_user(username="peer_admin", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=peer, role=WorkspaceRole.ADMIN)
    resp = _client(actor).patch(_detail(peer), {"availability_percent": 40}, format="json")
    assert resp.status_code == 200, resp.data
    assert WorkspaceMembership.objects.get(user=peer).availability_percent == 40


@pytest.mark.django_db
def test_empty_availability_patch_rejected(superadmin: object, member: object) -> None:
    """An empty body still fails the at-least-one-field guard (#542)."""
    resp = _client(superadmin).patch(_detail(member), {}, format="json")
    assert resp.status_code == 400


# --- Pagination (#1317) -------------------------------------------------------


@pytest.mark.django_db
def test_members_list_is_cursor_paginated_and_query_bounded(
    superadmin: object, django_assert_max_num_queries: object
) -> None:
    """A 200-member workspace returns a single bounded page, and the query count
    does not scale with the org size (#1317).

    The pre-pagination view ran ``User.objects.all()`` and built a row per user;
    cursor pagination caps the page, so the row builder's batched membership /
    group lookups fan out over at most ``page_size`` users, not the whole org.
    """
    User.objects.bulk_create([User(username=f"u{i:04d}") for i in range(200)])

    # A handful of queries (role lookup + cursor page + membership/group batches)
    # regardless of the 201 total users — the unbounded build is what #1317 fixed.
    with django_assert_max_num_queries(12):
        resp = _client(superadmin).get(LIST_URL)

    assert resp.status_code == 200
    # WorkspaceMemberCursorPagination.page_size — one page, not all 201 rows.
    assert len(resp.data["results"]) == 50
    assert resp.data["next"] is not None  # more pages remain
    # Cursor pagination intentionally omits the expensive total COUNT.
    assert "count" not in resp.data


# --- #2832: off-boarding must revoke long-lived credentials ------------------


def _mint_pat(user: object, raw: str) -> ApiToken:
    """Mint an owner-scoped Personal Access Token for ``user``."""
    return ApiToken.objects.create(
        name="Personal",
        owner=user,
        token_prefix=raw[len(TOKEN_PREFIX) :][:8],
        token_hash=sha256_hex(raw),
    )


def _outstanding_refresh_token(user: object) -> object:
    from rest_framework_simplejwt.tokens import RefreshToken

    return RefreshToken.for_user(user)


def _blacklisted_count(user: object) -> int:
    from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken

    return BlacklistedToken.objects.filter(token__user=user).count()


@pytest.mark.django_db
def test_deactivate_revokes_personal_access_tokens_and_refresh_tokens(
    superadmin: object, member: object
) -> None:
    """#2832: ``is_active = False`` alone left every PAT live and unexpiring."""
    pat = _mint_pat(member, TOKEN_PREFIX + ("a" * 64))
    _outstanding_refresh_token(member)

    resp = _client(superadmin).patch(
        _detail(member), {"status": MemberStatus.DEACTIVATED}, format="json"
    )
    assert resp.status_code == 200

    pat.refresh_from_db()
    assert pat.revoked_at is not None
    assert _blacklisted_count(member) == 1


@pytest.mark.django_db
def test_delete_revokes_personal_access_tokens_and_refresh_tokens(
    superadmin: object, member: object
) -> None:
    """Removal is a deactivation here, so it must cut the same credentials (#2832)."""
    pat = _mint_pat(member, TOKEN_PREFIX + ("b" * 64))
    _outstanding_refresh_token(member)

    assert _client(superadmin).delete(_detail(member)).status_code == 204

    pat.refresh_from_db()
    assert pat.revoked_at is not None
    assert _blacklisted_count(member) == 1


@pytest.mark.django_db
def test_reactivation_does_not_restore_revoked_tokens(superadmin: object, member: object) -> None:
    """Revocation is durable and one-way — a returning member mints new tokens (#2832).

    A token that was outside the organization's control during the absence must not
    silently become valid again when the account is re-enabled.
    """
    pat = _mint_pat(member, TOKEN_PREFIX + ("c" * 64))
    admin = _client(superadmin)

    assert (
        admin.patch(
            _detail(member), {"status": MemberStatus.DEACTIVATED}, format="json"
        ).status_code
        == 200
    )
    pat.refresh_from_db()
    revoked_at = pat.revoked_at
    assert revoked_at is not None

    assert (
        admin.patch(_detail(member), {"status": MemberStatus.ACTIVE}, format="json").status_code
        == 200
    )
    member.refresh_from_db()
    assert member.is_active is True  # login is restored...
    pat.refresh_from_db()
    assert pat.revoked_at == revoked_at  # ...the token is not


@pytest.mark.django_db
def test_self_deactivation_revokes_the_actors_own_credentials(db: object) -> None:
    """Self-edits are exempt from the peer guard, so an Admin can off-board themselves.

    The revocation then destroys the credentials of the very request serving it. That is
    intended — a member stepping away should not keep a live PAT — but it is a surprising
    enough sequence to pin, so a later refactor cannot quietly exempt the actor.
    """
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_self", password="pw")
    # A second Owner-tier account so the last-Owner strand guard does not fire first.
    other = User.objects.create_user(username="own_self", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=other, role=WorkspaceRole.OWNER)
    pat = _mint_pat(actor, TOKEN_PREFIX + ("f" * 64))

    resp = _client(actor).patch(_detail(actor), {"status": MemberStatus.DEACTIVATED}, format="json")
    assert resp.status_code == 200

    pat.refresh_from_db()
    assert pat.revoked_at is not None


@pytest.mark.django_db
def test_forbidden_deactivation_does_not_revoke_tokens(db: object) -> None:
    """The peer/higher-role guard fires BEFORE the revocation, and it is atomic (#2832).

    Revocation is irreversible, so "an Admin cannot deactivate a peer Admin" has to mean
    the peer's credentials survive the attempt — not merely that the response is a 403.
    """
    ws = Workspace.load()
    actor = User.objects.create_user(username="adm_rev_a", password="pw")
    peer = User.objects.create_user(username="adm_rev_b", password="pw")
    WorkspaceMembership.objects.create(workspace=ws, user=actor, role=WorkspaceRole.ADMIN)
    WorkspaceMembership.objects.create(workspace=ws, user=peer, role=WorkspaceRole.ADMIN)
    pat = _mint_pat(peer, TOKEN_PREFIX + ("e" * 64))

    assert (
        _client(actor)
        .patch(_detail(peer), {"status": MemberStatus.DEACTIVATED}, format="json")
        .status_code
        == 403
    )
    assert _client(actor).delete(_detail(peer)).status_code == 403

    pat.refresh_from_db()
    assert pat.revoked_at is None
    peer.refresh_from_db()
    assert peer.is_active is True


@pytest.mark.django_db
def test_deactivate_leaves_project_scoped_tokens_alone(superadmin: object, member: object) -> None:
    """Scope discipline: a project token is an org asset, not the member's credential.

    Revoking it on an unrelated person's off-boarding would break the team's CI.
    """
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1))
    raw = TOKEN_PREFIX + ("d" * 64)
    org_token = ApiToken.objects.create(
        name="CI",
        project=project,
        created_by=member,
        token_prefix=raw[len(TOKEN_PREFIX) :][:8],
        token_hash=sha256_hex(raw),
    )

    assert _client(superadmin).delete(_detail(member)).status_code == 204

    org_token.refresh_from_db()
    assert org_token.revoked_at is None
