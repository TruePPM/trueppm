"""A pending WorkspaceInvite is a durable bearer grant and must die with its minter (#4589).

Off-boarding, password reset and ``revoke_api_tokens`` all route through
``revoke_personal_durable_grants``; accept additionally re-checks the inviter so a
deactivation done outside the app still closes the hole.
"""

from __future__ import annotations

from io import StringIO
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core.management import call_command
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
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

User = get_user_model()

ACCEPT_URL = "/api/v1/workspace/invites/accept/"
CONFIRM_URL = "/api/v1/auth/password/reset/confirm/"
NEW_PASSWORD = "N3w-Secure-Passw0rd!"
INVALID = "This invitation link is invalid or has expired."


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    cache.clear()


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="inv_owner", password="pw", is_superuser=True)


def _admin(name: str) -> Any:
    user = User.objects.create_user(username=name, email=f"{name}@x.io", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.ADMIN
    )
    return user


def _invite(inviter: Any, email: str) -> WorkspaceInvite:
    return services.create_invite(
        workspace=Workspace.load(), email=email, role=WorkspaceRole.MEMBER, invited_by=inviter
    )


def _accept(invite: WorkspaceInvite, token: str) -> Any:
    return APIClient().post(
        ACCEPT_URL,
        {"token": token, "username": invite.email.split("@")[0], "password": "s3cretpw123"},
        format="json",
    )


def _assert_revoked_and_unacceptable(invite: WorkspaceInvite, token: str) -> None:
    invite.refresh_from_db()
    assert invite.status == InviteStatus.REVOKED
    assert invite.email_token == "" and invite.email_pending is False
    assert AuditEvent.objects.filter(
        event_type=AuditEventType.INVITE_REVOKED, target_id=invite.pk
    ).exists()
    resp = _accept(invite, token)
    assert resp.status_code == 400
    assert INVALID in str(resp.data)
    assert not User.objects.filter(email=invite.email).exists()


@pytest.mark.django_db
def test_offboarding_revokes_the_minters_pending_invites_only(owner: Any) -> None:
    contained = _admin("contained")
    other = _admin("other_admin")
    bad = _invite(contained, "evil@out.io")
    bad_token = bad.email_token
    failed = _invite(contained, "failed@out.io")
    WorkspaceInvite.objects.filter(pk=failed.pk).update(status=InviteStatus.FAILED)
    good = _invite(other, "good@out.io")

    c = APIClient()
    c.force_authenticate(user=owner)
    resp = c.patch(
        f"/api/v1/workspace/members/{contained.pk}/",
        {"status": MemberStatus.DEACTIVATED},
        format="json",
    )
    assert resp.status_code == 200

    _assert_revoked_and_unacceptable(bad, bad_token)
    failed.refresh_from_db()
    assert failed.status == InviteStatus.REVOKED
    good.refresh_from_db()
    assert good.status == InviteStatus.PENDING
    assert _accept(good, good.email_token).status_code in (200, 201)


@pytest.mark.django_db
def test_password_reset_revokes_the_users_pending_invites(owner: Any) -> None:
    contained = _admin("pw_contained")
    other = _admin("pw_other")
    bad = _invite(contained, "evil2@out.io")
    bad_token = bad.email_token
    good = _invite(other, "good2@out.io")

    resp = APIClient().post(
        CONFIRM_URL,
        {
            "uid": urlsafe_base64_encode(force_bytes(contained.pk)),
            "token": default_token_generator.make_token(contained),
            "new_password": NEW_PASSWORD,
        },
        format="json",
    )
    assert resp.status_code == 200

    _assert_revoked_and_unacceptable(bad, bad_token)
    good.refresh_from_db()
    assert good.status == InviteStatus.PENDING


def _run(*args: str) -> str:
    out = StringIO()
    call_command("revoke_api_tokens", *args, stdout=out)
    return out.getvalue()


@pytest.mark.django_db
def test_revoke_api_tokens_user_revokes_that_accounts_pending_invites(owner: Any) -> None:
    contained = _admin("cmd_contained")
    other = _admin("cmd_other")
    bad = _invite(contained, "evil3@out.io")
    bad_token = bad.email_token
    good = _invite(other, "good3@out.io")

    dry = _run("--user", "cmd_contained")
    assert "Pending workspace invites matched: 1" in dry
    bad.refresh_from_db()
    assert bad.status == InviteStatus.PENDING  # dry run touches nothing

    _run("--user", "cmd_contained", "--commit", "--yes")

    _assert_revoked_and_unacceptable(bad, bad_token)
    good.refresh_from_db()
    assert good.status == InviteStatus.PENDING


@pytest.mark.django_db
def test_revoke_api_tokens_all_revokes_every_pending_invite(owner: Any) -> None:
    a, b = _admin("all_a"), _admin("all_b")
    inv_a, inv_b = _invite(a, "a@out.io"), _invite(b, "b@out.io")

    _run("--all", "--commit", "--yes")

    inv_a.refresh_from_db()
    inv_b.refresh_from_db()
    assert inv_a.status == inv_b.status == InviteStatus.REVOKED


@pytest.mark.django_db
def test_revoked_invite_cannot_be_revived_by_resend(owner: Any) -> None:
    contained = _admin("resend_contained")
    bad = _invite(contained, "evil4@out.io")
    from trueppm_api.apps.access.services import revoke_personal_durable_grants

    revoke_personal_durable_grants(contained)

    assert services.resend_invite(bad.pk) is None
    bad.refresh_from_db()
    assert bad.status == InviteStatus.REVOKED


@pytest.mark.django_db
def test_accept_refused_when_inviter_deactivated_outside_the_app(owner: Any) -> None:
    contained = _admin("raw_deact")
    invite = _invite(contained, "evil5@out.io")
    token = invite.email_token
    User.objects.filter(pk=contained.pk).update(is_active=False)

    resp = _accept(invite, token)

    assert resp.status_code == 400
    assert INVALID in str(resp.data)
    assert not User.objects.filter(email="evil5@out.io").exists()
    invite.refresh_from_db()
    assert invite.status == InviteStatus.PENDING


@pytest.mark.django_db
def test_accept_refused_when_inviter_is_no_longer_admin(owner: Any) -> None:
    demoted = _admin("demoted")
    invite = _invite(demoted, "evil6@out.io")
    token = invite.email_token
    WorkspaceMembership.objects.filter(user=demoted).update(role=WorkspaceRole.MEMBER)

    resp = _accept(invite, token)

    assert resp.status_code == 400
    assert INVALID in str(resp.data)


@pytest.mark.django_db
def test_accept_refused_when_inviter_row_is_gone(owner: Any) -> None:
    gone = _admin("deleted_inviter")
    invite = _invite(gone, "evil7@out.io")
    token = invite.email_token
    gone.delete()

    assert _accept(invite, token).status_code == 400


@pytest.mark.django_db
def test_accept_still_works_for_an_active_admin_inviter(owner: Any) -> None:
    ok = _admin("ok_inviter")
    invite = _invite(ok, "fine@out.io")
    assert _accept(invite, invite.email_token).status_code in (200, 201)


@pytest.mark.django_db
def test_revoke_api_tokens_all_personal_revokes_owners_pending_invites(owner: Any) -> None:
    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import ApiToken

    contained, other = _admin("ap_contained"), _admin("ap_other")
    raw = TOKEN_PREFIX + "b" * 64
    ApiToken.objects.create(
        name="t",
        owner=contained,
        created_by=contained,
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
    )
    bad = _invite(contained, "evil8@out.io")
    good = _invite(other, "good8@out.io")

    out = _run("--all-personal", "--commit", "--yes")

    bad.refresh_from_db()
    good.refresh_from_db()
    assert bad.status == InviteStatus.REVOKED
    assert good.status == InviteStatus.PENDING
    assert "Revoked 1 pending workspace invite(s) sent by the targeted account(s)." in out


@pytest.mark.django_db
def test_command_output_is_truthful_when_no_invites_match(owner: Any) -> None:
    user = _admin("noinv")
    out = _run("--user", "noinv", "--commit", "--yes")
    assert "invite(s)" not in out
    assert user.is_active


@pytest.mark.django_db
def test_demoting_a_sender_below_admin_revokes_their_pending_invites(owner: Any) -> None:
    sender, other = _admin("demote_me"), _admin("keep_me")
    bad = _invite(sender, "evil9@out.io")
    good = _invite(other, "good9@out.io")

    c = APIClient()
    c.force_authenticate(user=owner)
    resp = c.patch(
        f"/api/v1/workspace/members/{sender.pk}/", {"role": WorkspaceRole.MEMBER}, format="json"
    )
    assert resp.status_code == 200

    bad.refresh_from_db()
    good.refresh_from_db()
    assert bad.status == InviteStatus.REVOKED
    assert good.status == InviteStatus.PENDING
    assert AuditEvent.objects.filter(
        event_type=AuditEventType.INVITE_REVOKED, target_id=bad.pk, actor=owner
    ).exists()


@pytest.mark.django_db
def test_resend_refused_with_409_when_sender_no_longer_admin(owner: Any) -> None:
    sender = _admin("resend_demoted")
    inv = _invite(sender, "evil10@out.io")
    WorkspaceMembership.objects.filter(user=sender).update(role=WorkspaceRole.MEMBER)
    old_hash = inv.token_hash

    c = APIClient()
    c.force_authenticate(user=owner)
    resp = c.post(f"/api/v1/workspace/invites/{inv.pk}/resend/")

    assert resp.status_code == 409
    assert "sender is no longer" in resp.data["detail"]
    inv.refresh_from_db()
    assert inv.token_hash == old_hash
    assert services.resend_all_pending(Workspace.load()) == 0


@pytest.mark.django_db
def test_drain_terminal_failure_does_not_resurrect_a_revoked_invite(owner: Any) -> None:
    from unittest.mock import patch

    from trueppm_api.apps.workspace.tasks import EMAIL_MAX_RETRIES, _do_drain_invite_emails

    sender = _admin("drain_sender")
    inv = _invite(sender, "evil11@out.io")
    WorkspaceInvite.objects.filter(pk=inv.pk).update(email_attempts=EMAIL_MAX_RETRIES - 1)

    def _revoke_then_fail(*_a: Any, **_k: Any) -> bool:
        WorkspaceInvite.objects.filter(pk=inv.pk).update(status=InviteStatus.REVOKED)
        return False

    with patch("trueppm_api.apps.workspace.tasks._send_invite_email", _revoke_then_fail):
        _do_drain_invite_emails()

    inv.refresh_from_db()
    assert inv.status == InviteStatus.REVOKED
