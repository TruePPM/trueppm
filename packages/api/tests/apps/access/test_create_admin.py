"""Tests for the create_admin management command."""

from __future__ import annotations

import os
import tempfile
from io import StringIO

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from unittest.mock import patch


User = get_user_model()


@pytest.mark.django_db
def test_creates_superuser_on_first_run(tmp_path: pytest.fixture) -> None:
    """Happy path: no superuser exists — creates one, writes password to file."""
    pw_file = str(tmp_path / "admin_password")

    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        pw_file,
    ):
        out = StringIO()
        call_command("create_admin", stdout=out)

    user = User.objects.get(email="admin@trueppm.dev")
    assert user.is_staff
    assert user.is_superuser
    assert user.username == "admin"

    # Password written to file, not printed to stdout.
    assert os.path.exists(pw_file)
    password = open(pw_file).read().strip()
    assert len(password) > 10
    assert password not in out.getvalue()


@pytest.mark.django_db
def test_password_file_has_restricted_permissions(tmp_path: pytest.fixture) -> None:
    """Password file must be created with 0o600 permissions atomically."""
    pw_file = str(tmp_path / "admin_password")

    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        pw_file,
    ):
        call_command("create_admin")

    assert oct(os.stat(pw_file).st_mode & 0o777) == oct(0o600)


@pytest.mark.django_db
def test_explicit_email_and_username(
    tmp_path: pytest.fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "boss@example.com")
    monkeypatch.setenv("DJANGO_SUPERUSER_USERNAME", "boss")
    pw_file = str(tmp_path / "admin_password")

    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        pw_file,
    ):
        call_command("create_admin")

    user = User.objects.get(email="boss@example.com")
    assert user.username == "boss"
    assert user.is_superuser


@pytest.mark.django_db
def test_username_defaults_to_email_local_part(
    tmp_path: pytest.fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "kelly@trueppm.dev")
    monkeypatch.delenv("DJANGO_SUPERUSER_USERNAME", raising=False)
    pw_file = str(tmp_path / "admin_password")

    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        pw_file,
    ):
        call_command("create_admin")

    assert User.objects.get(email="kelly@trueppm.dev").username == "kelly"


@pytest.mark.django_db
def test_explicit_password_is_used(
    tmp_path: pytest.fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When DJANGO_SUPERUSER_PASSWORD is set, that password is used (not auto-generated)."""
    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "explicit-password-123")
    pw_file = str(tmp_path / "admin_password")

    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        pw_file,
    ):
        call_command("create_admin")

    user = User.objects.get(email="admin@trueppm.dev")
    assert user.check_password("explicit-password-123")


@pytest.mark.django_db
def test_noop_when_superuser_already_exists(
    tmp_path: pytest.fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a superuser already exists the command exits immediately without changes."""
    User.objects.create_superuser(
        username="existing", email="existing@example.com", password="prod-password"
    )
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "existing@example.com")
    pw_file = str(tmp_path / "admin_password")

    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        pw_file,
    ):
        out = StringIO()
        call_command("create_admin", stdout=out)

    # No new users created.
    assert User.objects.count() == 1
    # Password file NOT written (no bootstrap occurred).
    assert not os.path.exists(pw_file)
    assert "already exists" in out.getvalue()


@pytest.mark.django_db
def test_password_printed_to_stdout_when_file_write_fails(
    tmp_path: pytest.fixture,
) -> None:
    """When the password file cannot be written the password appears on stdout (fallback)."""
    with patch(
        "trueppm_api.apps.access.management.commands.create_admin._PASSWORD_FILE",
        "/",  # Opening a directory for writing always raises OSError.
    ):
        out = StringIO()
        call_command("create_admin", stdout=out)

    output = out.getvalue()
    # Banner must be present so the operator notices.
    assert "TRUEPPM INITIAL ADMIN CREDENTIALS" in output
    # On failure path the password appears in stdout, NOT the REDACTED placeholder.
    assert "REDACTED" not in output
    # Admin user was still created despite the file write failure.
    assert User.objects.filter(email="admin@trueppm.dev", is_superuser=True).exists()
