"""Invite/export emails must never carry a relative, unclickable link (#4188).

When ``FRONTEND_BASE_URL`` is empty, ``_render_invite_email`` and
``_render_export_email`` used to build a bare relative path
(``/invite/accept?token=...``, ``/settings/workspace/danger``) — not a valid URL,
and unclickable in any mail client. Both now omit the link entirely and explain
why, matching the degrade-to-prose idiom already used by
``blocker_services.render_blocker_notification`` and
``core.password_reset._render_password_reset_email``.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings

from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import Workspace, WorkspaceRole
from trueppm_api.apps.workspace.tasks import _render_export_email, _render_invite_email

User = get_user_model()


@pytest.fixture
def inviter(db: object) -> object:
    return User.objects.create_user(
        username="inviter", password="pw", first_name="Pat", last_name="Admin"
    )


@pytest.fixture
def invite(inviter: object) -> object:
    return services.create_invite(
        workspace=Workspace.load(),
        email="new-hire@example.com",
        role=WorkspaceRole.MEMBER,
        invited_by=inviter,
    )


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="https://app.example.com")
def test_invite_email_has_absolute_link_when_configured(invite: object) -> None:
    _subject, body = _render_invite_email(invite)
    assert f"https://app.example.com/invite/accept?token={invite.email_token}" in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="")
def test_invite_email_never_emits_a_relative_link_when_unconfigured(invite: object) -> None:
    _subject, body = _render_invite_email(invite)
    for line in body.splitlines():
        assert not line.strip().startswith("/"), f"relative link leaked into invite email: {line!r}"
    assert "TRUEPPM_FRONTEND_BASE_URL" in body
    assert "resend" in body.lower()
    # The token must not leak in the clear either, now that the email carries no
    # link built from it.
    assert invite.email_token not in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="")
def test_invite_email_body_and_subject_still_render(invite: object) -> None:
    subject, body = _render_invite_email(invite)
    assert "invited" in subject.lower()
    assert f"expires on {invite.expires_at:%Y-%m-%d}" in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="https://app.example.com")
def test_export_email_has_absolute_link_when_configured(db: object) -> None:
    Workspace.load()
    _subject, body = _render_export_email(object())
    assert "https://app.example.com/settings/workspace/danger" in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="")
def test_export_email_never_emits_a_relative_link_when_unconfigured(db: object) -> None:
    Workspace.load()
    _subject, body = _render_export_email(object())
    for line in body.splitlines():
        assert not line.strip().startswith("/"), f"relative link leaked into export email: {line!r}"
    assert "Settings" in body and "Danger Zone" in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="https://app.example.com/")
def test_frontend_base_url_trailing_slash_is_stripped(invite: object) -> None:
    _subject, body = _render_invite_email(invite)
    assert "//invite" not in body


@pytest.mark.django_db
@pytest.mark.parametrize("role", list(WorkspaceRole))
def test_invite_email_role_copy_avoids_hard_coded_article(
    inviter: object, role: WorkspaceRole
) -> None:
    """The invite body must not hard-code "a" ahead of the role label (#4192).

    ``WorkspaceRole.ADMIN`` and ``WorkspaceRole.OWNER`` both start with a vowel
    sound, so a literal "as a {role_label}" reads as "as a Admin" / "as a Owner".
    Rewording to "with the <Role> role" sidesteps article selection for every
    role, present and future (enterprise roles land in the same 100-unit band
    per ADR-0072), rather than hard-coding a table of exceptions.
    """
    invite = services.create_invite(
        workspace=Workspace.load(),
        email="new-hire@example.com",
        role=role,
        invited_by=inviter,
    )
    _subject, body = _render_invite_email(invite)
    role_label = WorkspaceRole(role).label
    assert f"a {role_label}" not in body
    assert f"an {role_label}" not in body
    assert f"with the {role_label} role" in body
