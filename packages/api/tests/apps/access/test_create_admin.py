"""Tests for the create_admin management command."""

from __future__ import annotations

import os
import secrets
import threading
from datetime import date
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest
from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import connection as default_connection
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.access.management.commands import create_admin as mod
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    ApiToken,
    ApiTokenAuditEntry,
    Calendar,
    Project,
    ShareLink,
)

User = get_user_model()

_CMD = "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE"


@pytest.mark.django_db
def test_creates_superuser_on_first_run(tmp_path: Path) -> None:
    """Happy path: no superuser exists — creates one, writes password to file."""
    pw_file = str(tmp_path / "admin_password")

    with patch(_CMD, pw_file):
        out = StringIO()
        call_command("create_admin", stdout=out)

    user = User.objects.get(email="admin@example.com")
    assert user.is_staff
    assert user.is_superuser
    assert user.username == "admin"

    # Password written to file, not printed to stdout.
    assert os.path.exists(pw_file)
    with open(pw_file) as fh:
        password = fh.read().strip()
    assert len(password) > 10
    assert password not in out.getvalue()


@pytest.mark.django_db
def test_password_file_has_restricted_permissions(tmp_path: Path) -> None:
    """Password file must be created with 0o600 permissions atomically."""
    pw_file = str(tmp_path / "admin_password")

    with patch(_CMD, pw_file):
        call_command("create_admin")

    assert oct(os.stat(pw_file).st_mode & 0o777) == oct(0o600)


@pytest.mark.django_db
def test_explicit_email_and_username(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "boss@example.com")
    monkeypatch.setenv("DJANGO_SUPERUSER_USERNAME", "boss")
    pw_file = str(tmp_path / "admin_password")

    with patch(_CMD, pw_file):
        call_command("create_admin")

    user = User.objects.get(email="boss@example.com")
    assert user.username == "boss"
    assert user.is_superuser


@pytest.mark.django_db
def test_username_defaults_to_email_local_part(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "kelly@trueppm.com")
    monkeypatch.delenv("DJANGO_SUPERUSER_USERNAME", raising=False)
    pw_file = str(tmp_path / "admin_password")

    with patch(_CMD, pw_file):
        call_command("create_admin")

    assert User.objects.get(email="kelly@trueppm.com").username == "kelly"


@pytest.mark.django_db
def test_explicit_password_is_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When DJANGO_SUPERUSER_PASSWORD is set, that password is used (not auto-generated)."""
    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "explicit-password-123")
    pw_file = str(tmp_path / "admin_password")

    with patch(_CMD, pw_file):
        call_command("create_admin")

    user = User.objects.get(email="admin@example.com")
    assert user.check_password("explicit-password-123")


@pytest.mark.django_db
def test_noop_when_superuser_already_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a superuser already exists the command exits immediately without changes."""
    User.objects.create_superuser(
        username="existing", email="existing@example.com", password="prod-password"
    )
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "existing@example.com")
    pw_file = str(tmp_path / "admin_password")

    with patch(_CMD, pw_file):
        out = StringIO()
        call_command("create_admin", stdout=out)

    # No new users created.
    assert User.objects.count() == 1
    # Password file NOT written (no bootstrap occurred).
    assert not os.path.exists(pw_file)
    assert "already exists" in out.getvalue()


@pytest.mark.django_db
def test_password_printed_to_stdout_when_file_write_fails(tmp_path: Path) -> None:
    """When the password file cannot be written the password appears on stdout (fallback)."""
    with patch(_CMD, "/"):  # Opening a directory for writing always raises OSError.
        out = StringIO()
        call_command("create_admin", stdout=out)

    output = out.getvalue()
    # Banner must be present so the operator notices.
    assert "TRUEPPM INITIAL ADMIN CREDENTIALS" in output
    # On failure path the password appears in stdout, NOT the REDACTED placeholder.
    assert "REDACTED" not in output
    # Admin user was still created despite the file write failure.
    assert User.objects.filter(email="admin@example.com", is_superuser=True).exists()


@pytest.mark.django_db
def test_default_email_is_a_reserved_domain(tmp_path: Path) -> None:
    """The fallback must never be a domain someone other than the operator owns (#3175).

    It was ``admin@trueppm.com`` — the vendor's domain — so every install that did not
    override it had its root account at an address its own operator could not receive
    password-reset mail at. ``example.com`` is RFC 2606 reserved and undeliverable,
    which is the point: it fails visibly rather than routing somewhere real.
    """
    with patch(_CMD, str(tmp_path / "pw")):
        call_command("create_admin")

    user = User.objects.get(is_superuser=True)
    assert user.email.endswith("@example.com")
    assert "trueppm.com" not in user.email


@pytest.mark.django_db
def test_promoting_an_existing_user_is_announced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Promotion is a privilege grant + password reset — it must not read as a create.

    Reachable whenever no superuser exists and some ordinary account already holds
    DJANGO_SUPERUSER_EMAIL and the operator opted in.
    """
    monkeypatch.setenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", "true")
    existing = User.objects.create_user(
        username="someone", email="admin@example.com", password="their-own-password"
    )

    with patch(_CMD, str(tmp_path / "pw")):
        out = StringIO()
        call_command("create_admin", stdout=out)

    existing.refresh_from_db()
    assert existing.is_superuser
    assert not existing.check_password("their-own-password")

    output = out.getvalue()
    assert "WARNING" in output
    assert "password has been RESET" in output


def _mint_pat(owner: object) -> ApiToken:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    return ApiToken.objects.create(
        name="t",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        owner=owner,
        created_by=owner,
    )


@pytest.mark.django_db
def test_promotion_revokes_existing_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pre-claimed account keeps no PAT, refresh token, or SSO link after promotion (#4586)."""
    monkeypatch.setenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", "1")
    existing = User.objects.create_user(username="someone", email="admin@example.com", password="x")
    pat = _mint_pat(existing)
    refresh = RefreshToken.for_user(existing)
    social = SocialAccount.objects.create(user=existing, provider="github", uid="123")

    with patch(_CMD, str(tmp_path / "pw")):
        call_command("create_admin", stdout=StringIO())

    pat.refresh_from_db()
    assert pat.revoked_at is not None
    assert ApiTokenAuditEntry.objects.filter(
        token=pat, detail__reason="bootstrap_promotion"
    ).exists()
    assert BlacklistedToken.objects.filter(token__jti=refresh["jti"]).exists()
    assert not SocialAccount.objects.filter(pk=social.pk).exists()


@pytest.mark.django_db
def test_promotion_refused_without_opt_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Without the opt-in the pre-claimed account is untouched and the command exits 0."""
    monkeypatch.delenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", raising=False)
    existing = User.objects.create_user(
        username="someone", email="admin@example.com", password="pw"
    )
    pat = _mint_pat(existing)
    pw_file = tmp_path / "pw"

    out, err = StringIO(), StringIO()
    with patch(_CMD, str(pw_file)):
        call_command("create_admin", stdout=out, stderr=err)

    existing.refresh_from_db()
    pat.refresh_from_db()
    assert not existing.is_superuser
    assert not existing.is_staff
    assert existing.check_password("pw")
    assert pat.revoked_at is None
    assert not pw_file.exists()
    assert "TRUEPPM_ADMIN_PROMOTE_EXISTING" in err.getvalue()
    assert not User.objects.filter(is_superuser=True).exists()


@pytest.mark.django_db
def test_duplicate_bootstrap_email_is_a_clear_error_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """auth.User.email is not unique; two holders must not raise MultipleObjectsReturned."""
    monkeypatch.setenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", "true")
    User.objects.create_user(username="a", email="admin@example.com", password="pw")
    User.objects.create_user(username="b", email="admin@example.com", password="pw")

    err = StringIO()
    with patch(_CMD, str(tmp_path / "pw")):
        call_command("create_admin", stdout=StringIO(), stderr=err)

    assert "more than one account" in err.getvalue()
    assert not User.objects.filter(is_superuser=True).exists()


@pytest.mark.django_db
def test_email_match_is_case_insensitive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An account stored as ADMIN@example.com is the existing account, not a new one."""
    monkeypatch.delenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", raising=False)
    existing = User.objects.create_user(username="someone", email="ADMIN@example.com", password="x")
    err = StringIO()
    with patch(_CMD, str(tmp_path / "pw")):
        call_command("create_admin", stdout=StringIO(), stderr=err)
    existing.refresh_from_db()
    assert not existing.is_superuser
    assert User.objects.count() == 1
    assert "TRUEPPM_ADMIN_PROMOTE_EXISTING" in err.getvalue()


@pytest.mark.django_db
def test_case_variant_duplicates_are_ambiguous(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", "true")
    User.objects.create_user(username="a", email="ADMIN@example.com", password="pw")
    User.objects.create_user(username="b", email="Admin@example.com", password="pw")
    err = StringIO()
    with patch(_CMD, str(tmp_path / "pw")):
        call_command("create_admin", stdout=StringIO(), stderr=err)
    assert "more than one account" in err.getvalue()
    assert not User.objects.filter(is_superuser=True).exists()


@pytest.mark.django_db
def test_promotion_evicts_live_sockets_and_revokes_durable_grants(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TRUEPPM_ADMIN_PROMOTE_EXISTING", "true")
    existing = User.objects.create_user(username="someone", email="admin@example.com", password="x")
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )
    link = ShareLink.objects.create(
        project=project,
        token_prefix="tok-prefix1",
        token_hash=sha256_hex("a-share-link"),
        created_by=existing,
    )
    target = "trueppm_api.apps.access.signals.evict_all_live_project_sockets"
    with patch(_CMD, str(tmp_path / "pw")), patch(target) as evict:
        call_command("create_admin", stdout=StringIO())
    evict.assert_called_once_with(existing.pk)
    link.refresh_from_db()
    assert link.revoked_at is not None


@pytest.mark.django_db
def test_username_collision_is_a_refusal_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No email match but the derived username is taken: refuse instead of IntegrityError."""
    monkeypatch.delenv("DJANGO_SUPERUSER_USERNAME", raising=False)
    User.objects.create_user(username="admin", email="other@example.com", password="pw")
    err = StringIO()
    with patch(_CMD, str(tmp_path / "pw")):
        call_command("create_admin", stdout=StringIO(), stderr=err)
    assert "already belongs to a different account" in err.getvalue()
    assert not User.objects.filter(is_superuser=True).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_bootstraps_mint_exactly_one_password(tmp_path: Path) -> None:
    """Two pods bootstrapping at once must not both mint a password (#4039).

    The first run is held inside its bootstrap transaction while the second
    starts. Without the advisory lock the second passes the "no superuser"
    check, resets the password, and the first pod's file is left wrong.
    """
    pw_file = str(tmp_path / "admin_password")
    first_inside = threading.Event()
    release_first = threading.Event()
    calls = {"n": 0}
    original = mod.Command._bootstrap

    def held_bootstrap(self: mod.Command) -> tuple[str, str, str, bool]:
        result = original(self)
        calls["n"] += 1
        if calls["n"] == 1:
            first_inside.set()
            release_first.wait(timeout=10)
        return result

    outputs: dict[str, str] = {}

    def run(name: str) -> None:
        out = StringIO()
        try:
            call_command("create_admin", stdout=out)
        finally:
            outputs[name] = out.getvalue()
            default_connection.close()

    with patch(_CMD, pw_file), patch.object(mod.Command, "_bootstrap", held_bootstrap):
        first = threading.Thread(target=run, args=("first",))
        first.start()
        assert first_inside.wait(timeout=10)
        second = threading.Thread(target=run, args=("second",))
        second.start()
        # Give the second run time to reach the check; with the lock it blocks.
        second.join(timeout=1)
        release_first.set()
        first.join(timeout=10)
        second.join(timeout=10)

    assert "Created admin" in outputs["first"]
    assert "skipping bootstrap" in outputs["second"]
    assert calls["n"] == 1
    with open(pw_file) as fh:
        password = fh.read().strip()
    assert User.objects.get(email="admin@example.com").check_password(password)
