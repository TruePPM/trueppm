"""Tests for Workspace invites: CRUD, public acceptance, and the email drain (#518)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import (
    InviteStatus,
    Workspace,
    WorkspaceInvite,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.tasks import _do_drain_invite_emails, _do_purge_stale_invites

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
    assert any(r["id"] == str(invite.pk) for r in listed.data)
    resp = _client(admin).delete(f"{LIST_URL}{invite.pk}/")
    assert resp.status_code == 204
    invite.refresh_from_db()
    assert invite.status == InviteStatus.REVOKED
    assert invite.email_token == ""


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
