"""Admin-issued set-password link for a member with no local credential (#2927).

The recovery path for an SSO-only account whose provider was removed. Every refusal
below is paired with a success elsewhere in the file, so a broken route cannot pass
the refusal tests by refusing everything.
"""

from __future__ import annotations

import re
import secrets
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL, ApiToken
from trueppm_api.apps.workspace.models import (
    AuditEvent,
    AuditEventType,
    MemberStatus,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)

User = get_user_model()

_LOCMEM = "django.core.mail.backends.locmem.EmailBackend"
_BASE = "https://ppm.example.com"
_CONFIRM_URL = "/api/v1/auth/password/reset/confirm/"
_NEW_PASSWORD = "Fresh-local-pw-42"
_LINK_RE = re.compile(r"#uid=([^&\s]+)&token=([^\s\"<]+)")

pytestmark = [
    pytest.mark.django_db,
    pytest.mark.usefixtures("_mail_settings"),
]


@pytest.fixture
def _mail_settings() -> Any:
    with override_settings(EMAIL_BACKEND=_LOCMEM, FRONTEND_BASE_URL=_BASE):
        mail.outbox.clear()
        yield


def _user(username: str, role: int | None, *, sso_only: bool = True, **kw: Any) -> Any:
    kw.setdefault("email", f"{username}@example.com")
    user = User.objects.create_user(username=username, password="pw-Local-123", **kw)
    if sso_only:
        # What sso.services.resolve_user does to every JIT-created account.
        user.set_unusable_password()
        user.save(update_fields=["password"])
    if role is not None:
        WorkspaceMembership.objects.create(workspace=Workspace.load(), user=user, role=role)
    return user


def _url(user: Any) -> str:
    return f"/api/v1/workspace/members/{user.pk}/send-set-password-link/"


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner(db: object) -> Any:
    return _user("owner", WorkspaceRole.OWNER, sso_only=False)


@pytest.fixture
def admin(db: object) -> Any:
    return _user("admin", WorkspaceRole.ADMIN, sso_only=False)


@pytest.fixture
def sso_member(db: object) -> Any:
    return _user("ssomember", WorkspaceRole.MEMBER)


# --- happy path + redemption --------------------------------------------------


def test_admin_emails_the_member_and_the_link_sets_a_password_once(
    admin: Any, sso_member: Any
) -> None:
    resp = _client(admin).post(_url(sso_member))

    assert resp.status_code == 200, resp.content
    assert resp.data == {"sent": True}
    # The administrator never sees the credential: nothing token-shaped comes back.
    assert "token" not in resp.content.decode() and "uid" not in resp.content.decode()

    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    assert message.to == [sso_member.email]
    assert admin.email not in message.to + message.cc + message.bcc
    assert "Set a password" in message.subject
    # The member is told who issued it, so an unexpected issuance can be challenged.
    assert admin.email in message.body
    match = _LINK_RE.search(message.body)
    assert match is not None and message.body.count(_BASE + "/reset-password/confirm#") == 1
    uid, token = match.groups()

    ok = APIClient().post(
        _CONFIRM_URL, {"uid": uid, "token": token, "new_password": _NEW_PASSWORD}, format="json"
    )
    assert ok.status_code == 200, ok.content
    sso_member.refresh_from_db()
    assert sso_member.check_password(_NEW_PASSWORD)

    # Single use: the token is keyed on the password hash, which just changed.
    again = APIClient().post(
        _CONFIRM_URL, {"uid": uid, "token": token, "new_password": "Another-pw-99"}, format="json"
    )
    assert again.status_code == 400
    assert again.data["code"] == "invalid_token"


def test_the_link_expires(admin: Any, sso_member: Any) -> None:
    assert _client(admin).post(_url(sso_member)).status_code == 200
    uid, token = _LINK_RE.search(mail.outbox[0].body).groups()  # type: ignore[union-attr]
    with override_settings(PASSWORD_RESET_TIMEOUT=-1):
        resp = APIClient().post(
            _CONFIRM_URL,
            {"uid": uid, "token": token, "new_password": _NEW_PASSWORD},
            format="json",
        )
    assert resp.status_code == 400
    assert resp.data["code"] == "invalid_token"
    sso_member.refresh_from_db()
    assert not sso_member.has_usable_password()


def test_an_empty_password_column_counts_as_no_local_credential(admin: Any) -> None:
    member = _user("blankpw", WorkspaceRole.MEMBER, sso_only=False)
    User.objects.filter(pk=member.pk).update(password="")
    assert _client(admin).post(_url(member)).status_code == 200
    assert mail.outbox[0].to == [member.email]


def test_owner_may_recover_an_sso_only_admin(owner: Any) -> None:
    sso_admin = _user("ssoadmin", WorkspaceRole.ADMIN)
    assert _client(owner).post(_url(sso_admin)).status_code == 200


# --- audit ---------------------------------------------------------------------


def test_issuance_is_audited(admin: Any, sso_member: Any) -> None:
    assert _client(admin).post(_url(sso_member)).status_code == 200
    event = AuditEvent.objects.get(event_type=AuditEventType.MEMBER_SET_PASSWORD_LINK_SENT)
    assert event.actor == admin
    assert event.target_type == "member"
    assert event.target_label == sso_member.email
    assert event.metadata == {"user_id": sso_member.pk, "delivered": True}


def test_failed_delivery_is_503_and_still_audited(admin: Any, sso_member: Any) -> None:
    with patch(
        "trueppm_api.core.password_reset.EmailMultiAlternatives.send",
        side_effect=OSError("smtp down"),
    ):
        resp = _client(admin).post(_url(sso_member))
    assert resp.status_code == 503
    assert resp.data["code"] == "email_delivery_failed"
    event = AuditEvent.objects.get(event_type=AuditEventType.MEMBER_SET_PASSWORD_LINK_SENT)
    assert event.metadata["delivered"] is False


# --- permission matrix -----------------------------------------------------------


def test_non_admin_member_is_refused(sso_member: Any) -> None:
    peer = _user("plainmember", WorkspaceRole.MEMBER, sso_only=False)
    resp = _client(peer).post(_url(sso_member))
    assert resp.status_code == 403
    assert mail.outbox == []
    assert not AuditEvent.objects.filter(
        event_type=AuditEventType.MEMBER_SET_PASSWORD_LINK_SENT
    ).exists()


def test_anonymous_is_refused(sso_member: Any) -> None:
    assert APIClient().post(_url(sso_member)).status_code in (401, 403)
    assert mail.outbox == []


def test_implicit_member_without_a_row_is_refused(sso_member: Any) -> None:
    """Every account is an implicit MEMBER; that must not reach an Admin-only write."""
    nobody = _user("norow", None, sso_only=False)
    assert _client(nobody).post(_url(sso_member)).status_code == 403


@pytest.mark.parametrize("target_role", [WorkspaceRole.ADMIN, WorkspaceRole.OWNER])
def test_admin_cannot_target_a_peer_or_higher_role(admin: Any, target_role: int) -> None:
    target = _user(f"high{target_role}", target_role)
    resp = _client(admin).post(_url(target))
    assert resp.status_code == 403
    assert mail.outbox == []


def test_admin_cannot_target_themselves(admin: Any) -> None:
    admin.set_unusable_password()
    admin.save(update_fields=["password"])
    assert _client(admin).post(_url(admin)).status_code == 403
    assert mail.outbox == []


@pytest.mark.parametrize("flag", ["is_staff", "is_superuser"])
def test_operator_accounts_are_refused(owner: Any, flag: str) -> None:
    target = _user(f"op_{flag}", WorkspaceRole.MEMBER, **{flag: True})
    assert _client(owner).post(_url(target)).status_code == 403
    assert mail.outbox == []


def test_api_token_is_refused_even_for_an_owner(owner: Any, sso_member: Any) -> None:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="pat",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_LEGACY_FULL],
        expires_at=timezone.now() + timedelta(days=30),
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = client.post(_url(sso_member))
    assert resp.status_code == 403
    assert "API tokens cannot manage" in str(resp.data["detail"])
    assert mail.outbox == []


# --- not-applicable targets ------------------------------------------------------


def test_member_with_a_usable_password_is_refused(admin: Any) -> None:
    has_pw = _user("haspw", WorkspaceRole.MEMBER, sso_only=False)
    resp = _client(admin).post(_url(has_pw))
    assert resp.status_code == 409
    assert resp.data["code"] == "member_has_password"
    assert mail.outbox == []


def test_deactivated_member_is_refused(admin: Any, sso_member: Any) -> None:
    WorkspaceMembership.objects.filter(user=sso_member).update(status=MemberStatus.DEACTIVATED)
    resp = _client(admin).post(_url(sso_member))
    assert resp.status_code == 409
    assert resp.data["code"] == "member_inactive"
    assert mail.outbox == []


def test_member_without_email_is_refused(admin: Any) -> None:
    target = _user("noemail", WorkspaceRole.MEMBER, email="")
    resp = _client(admin).post(_url(target))
    assert resp.status_code == 409
    assert resp.data["code"] == "member_has_no_email"


def test_refused_when_the_email_could_not_carry_a_link(admin: Any, sso_member: Any) -> None:
    with override_settings(FRONTEND_BASE_URL=""):
        resp = _client(admin).post(_url(sso_member))
    assert resp.status_code == 409
    assert resp.data["code"] == "set_password_link_unavailable"
    assert mail.outbox == []


def test_unknown_member_is_404(admin: Any) -> None:
    resp = _client(admin).post("/api/v1/workspace/members/987654321/send-set-password-link/")
    assert resp.status_code == 404


# --- throttle ----------------------------------------------------------------------


def test_eleventh_link_in_an_hour_is_429(admin: Any, sso_member: Any) -> None:
    """Driven through the client: asserting ``throttle.scope`` passes on a dead throttle."""
    client = _client(admin)
    for _ in range(10):
        assert client.post(_url(sso_member)).status_code == 200
    assert client.post(_url(sso_member)).status_code == 429
    assert len(mail.outbox) == 10
