"""Tests for Workspace invites: CRUD, public acceptance, and the email drain (#518).

Also covers the durability half (#2911): the admin list hard-filtered to PENDING, so
accepting or revoking an invite erased it from the only surface that showed it, and no
audit verb replaced it. ``accepted_at``/``accepted_user`` were written by the accept
path and exposed by nothing. And the ``MEMBER_ADDED`` row written on accept has the
*invitee* as its actor — the endpoint is unauthenticated — so the log could say "X
joined via invite" and never who sent it.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import (
    AuditEvent,
    AuditEventType,
    InviteStatus,
    MemberStatus,
    Workspace,
    WorkspaceInvite,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.tasks import (
    EMAIL_MAX_RETRIES,
    _do_drain_invite_emails,
    _do_purge_stale_invites,
)

User = get_user_model()

LIST_URL = "/api/v1/workspace/invites/"
ACCEPT_URL = "/api/v1/workspace/invites/accept/"


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="inv_admin", password="pw", is_superuser=True)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# --- create / list / revoke -------------------------------------------------


@pytest.mark.django_db
def test_admin_creates_invite(admin: object) -> None:
    resp = _client(admin).post(
        LIST_URL, {"email": "new@x.io", "role": WorkspaceRole.MEMBER}, format="json"
    )
    assert resp.status_code == 201
    invite = WorkspaceInvite.objects.get(email="new@x.io")
    assert invite.status == InviteStatus.PENDING
    assert invite.email_pending is True
    assert invite.token_hash and invite.email_token  # hash stored, raw queued for email


@pytest.mark.django_db
def test_non_admin_cannot_create_invite(db: object) -> None:
    member = User.objects.create_user(username="m", password="pw")
    resp = _client(member).post(LIST_URL, {"email": "x@x.io"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_duplicate_pending_invite_rejected(admin: object) -> None:
    _client(admin).post(LIST_URL, {"email": "dup@x.io"}, format="json")
    resp = _client(admin).post(LIST_URL, {"email": "dup@x.io"}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_admin_cannot_invite_above_own_role(db: object) -> None:
    # An explicit ADMIN actor cannot invite someone as OWNER (actor-ceiling).
    actor = User.objects.create_user(username="adm", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=actor, role=WorkspaceRole.ADMIN
    )
    resp = _client(actor).post(
        LIST_URL, {"email": "boss@x.io", "role": WorkspaceRole.OWNER}, format="json"
    )
    assert resp.status_code == 403
    assert not WorkspaceInvite.objects.filter(email="boss@x.io").exists()


@pytest.mark.django_db
def test_admin_cannot_invite_peer_at_equal_role(db: object) -> None:
    """#1728: an Admin cannot invite a peer Admin (equal role) either.

    The accept path grants the invite's role verbatim, so allowing an equal-role
    invite would reopen the peer-Admin hole via the invite path. The invite
    actor-ceiling uses the same ``>=`` rule as the member-role PATCH gate.
    """
    actor = User.objects.create_user(username="adm_eq", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=actor, role=WorkspaceRole.ADMIN
    )
    resp = _client(actor).post(
        LIST_URL, {"email": "peer@x.io", "role": WorkspaceRole.ADMIN}, format="json"
    )
    assert resp.status_code == 403
    assert not WorkspaceInvite.objects.filter(email="peer@x.io").exists()


@pytest.mark.django_db
def test_invite_for_existing_member_rejected(admin: object) -> None:
    User.objects.create_user(username="exists", email="here@x.io", password="pw")
    resp = _client(admin).post(LIST_URL, {"email": "here@x.io"}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_list_and_revoke(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(), email="p@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    listed = _client(admin).get(LIST_URL)
    # /workspace/invites/ now returns the page-number envelope (#1355); freeze the
    # contract shape so a regression to a bare array is caught here.
    assert set(listed.data) >= {"count", "next", "previous", "results"}
    assert any(r["id"] == str(invite.pk) for r in listed.data["results"])
    resp = _client(admin).delete(f"{LIST_URL}{invite.pk}/")
    assert resp.status_code == 204
    invite.refresh_from_db()
    assert invite.status == InviteStatus.REVOKED
    assert invite.email_token == ""


@pytest.mark.django_db
def test_non_admin_cannot_list_invites(admin: object) -> None:
    # #1724: pending invites expose PII (email / role / invited_by). A plain
    # implicit member must not read them — GET is now gated at ADMIN, not just
    # writes. The admin still sees the list (200).
    services.create_invite(
        workspace=Workspace.load(), email="secret@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    member = User.objects.create_user(username="peeker", password="pw")
    assert _client(member).get(LIST_URL).status_code == 403
    assert _client(admin).get(LIST_URL).status_code == 200


# --- #2911: the invite record is durable, and keeps its inviter ---------------


@pytest.mark.django_db
def test_creating_an_invite_records_who_offered_which_role(admin: object) -> None:
    """An invite grants a role to an address nobody has verified — record the grant."""
    resp = _client(admin).post(
        LIST_URL, {"email": "audit-sent@x.io", "role": WorkspaceRole.MEMBER}, format="json"
    )
    assert resp.status_code == 201

    event = AuditEvent.objects.get(event_type=AuditEventType.INVITE_SENT)
    assert event.actor_id == admin.pk  # type: ignore[attr-defined]
    assert event.target_label == "audit-sent@x.io"
    assert event.metadata["role"] == WorkspaceRole(WorkspaceRole.MEMBER).label


@pytest.mark.django_db
def test_accepting_an_invite_records_the_inviter(admin: object) -> None:
    """The point of the issue: "who let them in" must survive the accept.

    ``MEMBER_ADDED`` cannot answer it — its actor is the invitee, because the accept
    endpoint is unauthenticated and the invitee provisions themselves. So the inviter
    is asserted on the INVITE_ACCEPTED row, and asserted to be a *different* person
    from that row's actor, which is exactly the distinction that was missing.
    """
    invite = services.create_invite(
        workspace=Workspace.load(), email="joiner@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    resp = APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "newjoiner", "password": "s3cretpw123"},
        format="json",
    )
    assert resp.status_code == 200

    joined = User.objects.get(username="newjoiner")
    event = AuditEvent.objects.get(event_type=AuditEventType.INVITE_ACCEPTED)
    assert event.actor_id == joined.pk
    assert event.metadata["invited_by_id"] == str(admin.pk)  # type: ignore[attr-defined]
    assert event.metadata["invited_by"] == services._actor_label(admin)
    assert event.metadata["invited_at"]

    # The pre-existing MEMBER_ADDED row is the one that cannot answer it — pinned so
    # a future change cannot quietly make INVITE_ACCEPTED redundant with it.
    member_added = AuditEvent.objects.get(event_type=AuditEventType.MEMBER_ADDED)
    assert member_added.actor_id == joined.pk
    assert "invited_by" not in member_added.metadata


@pytest.mark.django_db
def test_the_inviter_is_readable_after_the_inviter_is_gone(admin: object) -> None:
    """A denormalized label, not just an id — off-boarding the inviter must not erase them.

    ``invited_by`` is ``SET_NULL`` on the invite and ``AuditEvent.actor`` is too, so an
    id alone would dangle exactly when the question ("who was provisioning accounts?")
    is most likely to be asked.
    """
    invite = services.create_invite(
        workspace=Workspace.load(), email="j2@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    label_at_invite_time = services._actor_label(admin)
    APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "j2", "password": "s3cretpw123"},
        format="json",
    )

    admin.delete()  # type: ignore[attr-defined]

    event = AuditEvent.objects.get(event_type=AuditEventType.INVITE_ACCEPTED)
    assert event.metadata["invited_by"] == label_at_invite_time


@pytest.mark.django_db
def test_revoking_an_invite_is_audited_once(admin: object) -> None:
    """A repeat DELETE is a no-op and must not claim a second revocation."""
    invite = services.create_invite(
        workspace=Workspace.load(),
        email="revoked@x.io",
        role=WorkspaceRole.MEMBER,
        invited_by=admin,
    )
    assert _client(admin).delete(f"{LIST_URL}{invite.pk}/").status_code == 204
    assert _client(admin).delete(f"{LIST_URL}{invite.pk}/").status_code == 204

    events = AuditEvent.objects.filter(event_type=AuditEventType.INVITE_REVOKED)
    assert events.count() == 1
    assert events.first().target_label == "revoked@x.io"  # type: ignore[union-attr]


@pytest.mark.django_db
def test_accepted_invite_is_still_readable_through_the_status_filter(admin: object) -> None:
    """The defect: accepting made the row vanish from the only admin surface."""
    invite = services.create_invite(
        workspace=Workspace.load(), email="gone@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "gonejoiner", "password": "s3cretpw123"},
        format="json",
    )

    # The default is unchanged — the Members page's "Pending invites" section must
    # not silently start listing terminal rows.
    default_ids = {r["id"] for r in _client(admin).get(LIST_URL).data["results"]}
    assert str(invite.pk) not in default_ids

    for query in ("?status=accepted", "?status=all"):
        rows = _client(admin).get(f"{LIST_URL}{query}").data["results"]
        row = next(r for r in rows if r["id"] == str(invite.pk))
        assert row["status"] == InviteStatus.ACCEPTED
        assert row["accepted_at"] is not None
        assert row["accepted_by"] is not None


@pytest.mark.django_db
def test_pending_row_reports_no_acceptance(admin: object) -> None:
    """Both outcome fields are null on every row that was never accepted."""
    services.create_invite(
        workspace=Workspace.load(), email="still@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    row = _client(admin).get(LIST_URL).data["results"][0]
    assert row["accepted_at"] is None
    assert row["accepted_by"] is None


@pytest.mark.django_db
def test_unknown_status_filter_is_a_400(admin: object) -> None:
    """A typo'd status must not silently fall back to "everything"."""
    resp = _client(admin).get(f"{LIST_URL}?status=acepted")
    assert resp.status_code == 400
    assert "status" in resp.data


@pytest.mark.django_db
def test_invite_history_does_not_n_plus_one_on_the_accepting_user(admin: object) -> None:
    """``accepted_by`` renders initials, which needs the user row — prefetch it.

    ``_invite_dict`` already resolved ``invited_by`` through ``select_related``; the
    outcome column added a **second** user relation, and rendering it per row without
    widening the prefetch makes an admin history page cost one extra query per
    accepted invite.

    Asserted as an absolute budget rather than by comparing two page sizes: this view
    uses stock ``PageNumberPagination``, whose ``page_size_query_param`` is ``None``,
    so ``?page_size=`` is ignored and a two-request comparison silently compares two
    identical requests and passes no matter what. Verified by removing
    ``accepted_user`` from ``select_related`` and confirming this fails.
    """
    accepted_count = 6
    for i in range(accepted_count):
        invite = services.create_invite(
            workspace=Workspace.load(),
            email=f"n{i}@x.io",
            role=WorkspaceRole.MEMBER,
            invited_by=admin,
        )
        APIClient().post(
            ACCEPT_URL,
            {"token": invite.email_token, "username": f"nuser{i}", "password": "s3cretpw123"},
            format="json",
        )

    with CaptureQueriesContext(connection) as ctx:
        resp = _client(admin).get(f"{LIST_URL}?status=accepted")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == accepted_count

    # Budget, not a golden number: permission/session/count/page queries plus the one
    # joined row fetch. Set below `accepted_count` extra so an unprefetched relation
    # cannot hide inside the headroom.
    assert len(ctx) < 10, (
        f"{len(ctx)} queries for {accepted_count} rows — a user relation is being "
        f"resolved per row: {[q['sql'][:90] for q in ctx.captured_queries]}"
    )


@pytest.mark.django_db
def test_invite_history_is_admin_only(admin: object) -> None:
    """The history is at least as sensitive as the pending list #1724 gated."""
    invite = services.create_invite(
        workspace=Workspace.load(), email="hist@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    _client(admin).delete(f"{LIST_URL}{invite.pk}/")
    member = User.objects.create_user(username="hist_peeker", password="pw")
    assert _client(member).get(f"{LIST_URL}?status=all").status_code == 403


# --- acceptance (public) ----------------------------------------------------


@pytest.mark.django_db
def test_accept_provisions_new_user(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(), email="join@x.io", role=WorkspaceRole.ADMIN, invited_by=admin
    )
    resp = APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "joiner", "password": "s3cretpw123"},
        format="json",
    )
    assert resp.status_code == 200
    user = User.objects.get(username="joiner")
    assert user.email == "join@x.io"
    m = WorkspaceMembership.objects.get(user=user)
    assert m.role == WorkspaceRole.ADMIN
    invite.refresh_from_db()
    assert invite.status == InviteStatus.ACCEPTED
    assert invite.email_token == ""  # consumed


@pytest.mark.django_db
def test_accept_links_existing_user(admin: object) -> None:
    existing = User.objects.create_user(username="already", email="known@x.io", password="pw")
    invite = services.create_invite(
        workspace=Workspace.load(), email="known@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    resp = APIClient().post(ACCEPT_URL, {"token": invite.email_token}, format="json")
    assert resp.status_code == 200
    assert WorkspaceMembership.objects.filter(user=existing).exists()


@pytest.mark.django_db
def test_accept_invalid_token_is_generic_400(db: object) -> None:
    resp = APIClient().post(ACCEPT_URL, {"token": "not-a-real-token"}, format="json")
    assert resp.status_code == 400
    # Generic message — must not reveal whether the token exists.
    assert "invalid or has expired" in str(resp.data).lower()


@pytest.mark.django_db
def test_accept_expired_token_rejected(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(), email="late@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    WorkspaceInvite.objects.filter(pk=invite.pk).update(
        expires_at=timezone.now() - timedelta(hours=1)
    )
    resp = APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "u", "password": "pw12345678"},
        format="json",
    )
    assert resp.status_code == 400
    invite.refresh_from_db()
    assert invite.status == InviteStatus.EXPIRED


@pytest.mark.django_db
def test_accept_new_user_requires_credentials(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(),
        email="nocreds@x.io",
        role=WorkspaceRole.MEMBER,
        invited_by=admin,
    )
    resp = APIClient().post(ACCEPT_URL, {"token": invite.email_token}, format="json")
    assert resp.status_code == 400


# --- email drain + purge ----------------------------------------------------


@pytest.mark.django_db
def test_drain_sends_after_orphan_window(admin: object, settings: object) -> None:
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    invite = services.create_invite(
        workspace=Workspace.load(), email="drain@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    # Inside the orphan window → not yet eligible.
    _do_drain_invite_emails()
    assert len(mail.outbox) == 0
    # Backdate past the 5-min orphan window.
    WorkspaceInvite.objects.filter(pk=invite.pk).update(
        created_at=timezone.now() - timedelta(minutes=10)
    )
    _do_drain_invite_emails()
    assert len(mail.outbox) == 1
    assert "drain@x.io" in mail.outbox[0].to
    invite.refresh_from_db()
    assert invite.email_pending is False
    assert invite.email_token == ""  # cleared after successful send


@pytest.mark.django_db
def test_invite_drain_honors_the_workspace_delivery_limits(admin: object, settings: object) -> None:
    """The invite drain used to consult neither operator control (#2887 item 3).

    It carried its own hardcoded ``EMAIL_BATCH_SIZE = 50`` on the same 30 s beat as
    the notification drain, so an operator who dialed ``throttle_per_min`` down to
    protect a rate-limited relay was still exposed to a bulk-invite burst.
    """
    from django.core.cache import cache

    from trueppm_api.apps.notifications.models import WorkspaceEmailSettings

    cache.clear()
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    limits = WorkspaceEmailSettings.load()
    limits.max_recipients = 2
    limits.save()

    for i in range(5):
        services.create_invite(
            workspace=Workspace.load(),
            email=f"burst{i}@x.io",
            role=WorkspaceRole.MEMBER,
            invited_by=admin,
        )
    WorkspaceInvite.objects.update(created_at=timezone.now() - timedelta(minutes=10))

    mail.outbox.clear()
    _do_drain_invite_emails()
    assert len(mail.outbox) == 2


@pytest.mark.django_db
def test_invite_drain_leaves_rows_pending_when_the_transport_is_unusable(
    admin: object, settings: object
) -> None:
    """A configuration fault must not mark every queued invite FAILED (#2886 item 2).

    Now that an unusable transport raises rather than silently rerouting, resolving
    it per-invite would have burned all three retries on each queued row and flipped
    them to ``FAILED`` — destroying invites for a fault an operator fix clears.
    """
    from trueppm_api.apps.notifications.models import (
        EmailTransportMode,
        WorkspaceEmailSettings,
    )

    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    broken = WorkspaceEmailSettings.load()
    broken.transport_mode = EmailTransportMode.SMTP
    broken.host = "mail.corp.test"
    broken.username = "u"
    broken.password_ciphertext = b"not-a-valid-fernet-token"
    broken.save()

    invite = services.create_invite(
        workspace=Workspace.load(), email="stuck@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    WorkspaceInvite.objects.update(created_at=timezone.now() - timedelta(minutes=10))

    mail.outbox.clear()
    for _ in range(3):
        _do_drain_invite_emails()

    invite.refresh_from_db()
    assert len(mail.outbox) == 0
    assert invite.email_pending is True
    assert invite.email_attempts == 0
    assert invite.status == InviteStatus.PENDING


@pytest.mark.django_db
def test_purge_expires_and_deletes(admin: object) -> None:
    stale = services.create_invite(
        workspace=Workspace.load(), email="stale@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    WorkspaceInvite.objects.filter(pk=stale.pk).update(
        expires_at=timezone.now() - timedelta(days=1)
    )
    _do_purge_stale_invites()
    stale.refresh_from_db()
    assert stale.status == InviteStatus.EXPIRED


# --- #889: password policy enforced on invite-accept ------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("weak", ["a", "12345678", "password"])
def test_accept_rejects_weak_password(admin: object, weak: str) -> None:
    """create_user does not run AUTH_PASSWORD_VALIDATORS — accept_invite must (#889)."""
    invite = services.create_invite(
        workspace=Workspace.load(), email="weak@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    resp = APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "weakling", "password": weak},
        format="json",
    )
    assert resp.status_code == 400
    assert not User.objects.filter(username="weakling").exists()
    invite.refresh_from_db()
    # Token still pending — a rejected accept must not consume the invite.
    assert invite.status == InviteStatus.PENDING


@pytest.mark.django_db
def test_accept_allows_strong_password(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(), email="strong@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    resp = APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "stronger", "password": "Tr0ub4dor&3xkcd"},
        format="json",
    )
    assert resp.status_code == 200
    assert User.objects.filter(username="stronger").exists()


# --- #901 FIX A: deactivated member cannot reactivate via invite ------------


@pytest.mark.django_db
def test_accept_rejects_deactivated_member(admin: object) -> None:
    """Replaying a pending invite must not undo an admin's deactivation (#901)."""
    ws = Workspace.load()
    existing = User.objects.create_user(
        username="deact", email="deact@x.io", password="pw", is_active=False
    )
    WorkspaceMembership.objects.create(
        workspace=ws,
        user=existing,
        role=WorkspaceRole.MEMBER,
        status=MemberStatus.DEACTIVATED,
    )
    invite = services.create_invite(
        workspace=ws, email="deact@x.io", role=WorkspaceRole.ADMIN, invited_by=admin
    )
    resp = APIClient().post(ACCEPT_URL, {"token": invite.email_token}, format="json")
    assert resp.status_code == 400
    assert "deactivated" in str(resp.data).lower()
    membership = WorkspaceMembership.objects.get(user=existing)
    # Neither reactivated nor role-elevated.
    assert membership.status == MemberStatus.DEACTIVATED
    assert membership.role == WorkspaceRole.MEMBER


# --- #901 FIX B: terminal email failure clears the raw token ----------------


@pytest.mark.django_db
def test_drain_terminal_failure_clears_token(admin: object, monkeypatch: object) -> None:
    """After retries are exhausted, email_token must be cleared and invite FAILED (#901)."""
    invite = services.create_invite(
        workspace=Workspace.load(), email="fail@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    # Backdate past the orphan window and pre-load attempts to the retry ceiling so
    # this drain pass is the terminal one.
    WorkspaceInvite.objects.filter(pk=invite.pk).update(
        created_at=timezone.now() - timedelta(minutes=10),
        email_attempts=EMAIL_MAX_RETRIES - 1,
    )
    # Force the SMTP send to fail.
    monkeypatch.setattr("trueppm_api.apps.workspace.tasks._send_invite_email", lambda inv: False)
    _do_drain_invite_emails()
    invite.refresh_from_db()
    assert invite.status == InviteStatus.FAILED
    assert invite.email_pending is False
    assert invite.email_token == ""  # raw token cleared even on terminal failure


# --- resend (#969, ADR-0149) ------------------------------------------------


def _sent_invite(admin: object, email: str = "resend@x.io") -> WorkspaceInvite:
    """A create-then-drained invite: PENDING, already sent, token cleared."""
    invite = services.create_invite(
        workspace=Workspace.load(), email=email, role=WorkspaceRole.MEMBER, invited_by=admin
    )
    WorkspaceInvite.objects.filter(pk=invite.pk).update(
        created_at=timezone.now() - timedelta(minutes=10)
    )
    _do_drain_invite_emails()
    invite.refresh_from_db()
    assert invite.email_sent_at is not None
    assert invite.email_token == ""
    return invite


@pytest.mark.django_db
def test_resend_reissues_token_and_requeues(admin: object) -> None:
    invite = _sent_invite(admin)
    old_hash = invite.token_hash

    resp = _client(admin).post(f"{LIST_URL}{invite.pk}/resend/")
    assert resp.status_code == 202
    assert resp.data == {"queued": True}

    invite.refresh_from_db()
    # Re-issued: fresh token (old link dies), back in the outbox, attempts reset.
    assert invite.token_hash != old_hash
    assert invite.email_token  # a fresh raw token is queued for the drain
    assert invite.email_pending is True
    assert invite.email_sent_at is None
    assert invite.email_attempts == 0
    assert invite.status == InviteStatus.PENDING


@pytest.mark.django_db
def test_resend_then_drain_sends_again(admin: object) -> None:
    invite = _sent_invite(admin)
    mail.outbox.clear()
    _client(admin).post(f"{LIST_URL}{invite.pk}/resend/")
    # created_at is unchanged (old), so the resend clears the orphan window at once.
    _do_drain_invite_emails()
    invite.refresh_from_db()
    assert invite.email_pending is False
    assert invite.email_sent_at is not None
    assert len(mail.outbox) == 1


@pytest.mark.django_db
def test_resend_in_flight_is_noop(admin: object) -> None:
    """A freshly-created (not-yet-sent) invite must not have its token re-issued."""
    invite = services.create_invite(
        workspace=Workspace.load(),
        email="inflight@x.io",
        role=WorkspaceRole.MEMBER,
        invited_by=admin,
    )
    original_token = invite.email_token

    resp = _client(admin).post(f"{LIST_URL}{invite.pk}/resend/")
    assert resp.status_code == 202
    invite.refresh_from_db()
    assert invite.email_token == original_token  # untouched — drain will send this one


@pytest.mark.django_db
def test_resend_accepted_invite_is_409(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(), email="done@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    WorkspaceInvite.objects.filter(pk=invite.pk).update(status=InviteStatus.ACCEPTED)
    resp = _client(admin).post(f"{LIST_URL}{invite.pk}/resend/")
    assert resp.status_code == 409


@pytest.mark.django_db
def test_resend_unknown_invite_is_404(admin: object) -> None:
    resp = _client(admin).post(f"{LIST_URL}00000000-0000-0000-0000-000000000000/resend/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_resend_requires_admin(db: object, admin: object) -> None:
    invite = _sent_invite(admin)
    member = User.objects.create_user(username="plain", password="pw")
    resp = _client(member).post(f"{LIST_URL}{invite.pk}/resend/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_resend_failed_invite_is_resendable(admin: object) -> None:
    invite = _sent_invite(admin, email="failed@x.io")
    WorkspaceInvite.objects.filter(pk=invite.pk).update(status=InviteStatus.FAILED)
    resp = _client(admin).post(f"{LIST_URL}{invite.pk}/resend/")
    assert resp.status_code == 202
    invite.refresh_from_db()
    assert invite.status == InviteStatus.PENDING


@pytest.mark.django_db
def test_resend_all_requeues_every_pending(admin: object) -> None:
    a = _sent_invite(admin, email="a@x.io")
    b = _sent_invite(admin, email="b@x.io")
    resp = _client(admin).post(f"{LIST_URL}resend-all/")
    assert resp.status_code == 202
    assert resp.data == {"requeued": 2}
    for inv in (a, b):
        inv.refresh_from_db()
        assert inv.email_pending is True
        assert inv.email_sent_at is None


@pytest.mark.django_db
def test_resend_all_requires_admin(db: object, admin: object) -> None:
    _sent_invite(admin)
    member = User.objects.create_user(username="plain2", password="pw")
    resp = _client(member).post(f"{LIST_URL}resend-all/")
    assert resp.status_code == 403
