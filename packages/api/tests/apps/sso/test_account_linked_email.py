"""Account-linked notification email tests (#3554, resolve_user branch 3).

Before this, branch 3 of ``resolve_user`` bound a first-time SSO identity to any
existing local user matched by verified email — OWNER included — with nothing
telling the account owner it happened. The owner's decision on #3554 is "notify,
don't block" (Option 1): email the local account, naming the provider, whenever
this branch runs. Three properties matter more than the happy path:

* **every role gets the email** — the notice is not scoped to a workspace role,
  since the risk (a silent credential added to an account) is identical for
  OWNER, ADMIN, and MEMBER;
* **only the link event sends mail** — a second login by the same ``(issuer,
  subject)`` resolves through branch 1 and must not re-notify on every sign-in;
* **a mail failure never breaks the login** — ``resolve_user`` must still return
  the linked user even when the transport is unusable or ``send()`` raises,
  matching the best-effort posture of ``send_password_reset_email``.

``transaction.on_commit`` only fires when the enclosing transaction actually
commits, and pytest-django's default per-test transaction never does — hence
``django_db(transaction=True)`` throughout. ``admin``/``member``/``owner`` are
the real-workspace-role fixtures from ``conftest.py`` (auto-available to every
test module in this package; no import needed).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import override_settings

from trueppm_api.apps.sso import services

User = get_user_model()

_LOCMEM = "django.core.mail.backends.locmem.EmailBackend"
_EMAIL_BACKEND_MODULE = "trueppm_api.apps.notifications.email_backend"


@pytest.fixture(autouse=True)
def _clear_outbox() -> Any:
    mail.outbox.clear()
    yield
    mail.outbox.clear()


@override_settings(EMAIL_BACKEND=_LOCMEM)
@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("account_fixture", ["owner", "admin", "member"])
def test_link_notifies_the_local_account_at_every_role(
    account_fixture: str, provider_ctx: services.ProviderContext, request: Any
) -> None:
    """OWNER, ADMIN, and MEMBER local accounts all receive the link notice."""
    user = request.getfixturevalue(account_fixture)
    user.email = f"{account_fixture}@example.com"
    user.save(update_fields=["email"])

    resolved, created = services.resolve_user(
        provider_ctx,
        {"sub": f"sub-{account_fixture}", "email": user.email, "email_verified": True},
    )

    assert resolved == user
    assert created is False
    assert len(mail.outbox) == 1
    msg = mail.outbox[0]
    assert msg.to == [user.email]
    assert "sign-in method" in msg.subject
    assert provider_ctx.display_name in msg.body
    assert "administrator" in msg.body


@override_settings(EMAIL_BACKEND=_LOCMEM)
@pytest.mark.django_db(transaction=True)
def test_repeat_login_does_not_resend(provider_ctx: services.ProviderContext) -> None:
    """Branch 1's durable ``(issuer, subject)`` key must short-circuit before any mail."""
    local_user = User.objects.create_user(
        username="erin_notify", email="erin-notify@example.com", password="pw"
    )
    claims = {"sub": "sub-erin-notify", "email": local_user.email, "email_verified": True}

    services.resolve_user(provider_ctx, claims)
    assert len(mail.outbox) == 1

    mail.outbox.clear()
    resolved_again, created_again = services.resolve_user(provider_ctx, claims)

    assert resolved_again == local_user
    assert created_again is False
    assert mail.outbox == []


@pytest.mark.django_db(transaction=True)
def test_mail_transport_unusable_does_not_break_the_link(
    provider_ctx: services.ProviderContext,
) -> None:
    """An unresolvable connection is logged and swallowed — the SSO callback must not 500.

    Patches the connection resolver where it is *defined*
    (``notifications.email_backend``), not on ``services``, because
    ``_send_sso_account_linked_email`` imports it lazily inside the function body — the
    same lazy-import idiom ``core.password_reset`` uses, so the patch target has to be
    the source module.
    """
    from allauth.socialaccount.models import SocialAccount

    local_user = User.objects.create_user(
        username="frank_notify", email="frank-notify@example.com", password="pw"
    )

    with patch(f"{_EMAIL_BACKEND_MODULE}.resolve_email_connection") as mock_connection:
        mock_connection.side_effect = RuntimeError("smtp transport unusable")
        resolved, created = services.resolve_user(
            provider_ctx,
            {"sub": "sub-frank-notify", "email": local_user.email, "email_verified": True},
        )

    assert resolved == local_user
    assert created is False
    # The bind itself must still have happened even though the notice could not be sent.
    assert SocialAccount.objects.filter(user=local_user, provider="generic").exists()


@override_settings(EMAIL_BACKEND=_LOCMEM)
@pytest.mark.django_db(transaction=True)
def test_mail_send_exception_does_not_break_the_link(
    provider_ctx: services.ProviderContext,
) -> None:
    """A raised exception from ``EmailMultiAlternatives.send`` must also be swallowed."""
    local_user = User.objects.create_user(
        username="grace_notify", email="grace-notify@example.com", password="pw"
    )

    with patch(
        "trueppm_api.apps.sso.services.EmailMultiAlternatives.send",
        side_effect=OSError("connection refused"),
    ):
        resolved, created = services.resolve_user(
            provider_ctx,
            {"sub": "sub-grace-notify", "email": local_user.email, "email_verified": True},
        )

    assert resolved == local_user
    assert created is False
