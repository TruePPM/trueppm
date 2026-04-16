"""Tests for the create_admin management command."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError


User = get_user_model()


@pytest.mark.django_db
def test_create_admin_creates_superuser(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "s3cr3t!")

    call_command("create_admin")

    user = User.objects.get(email="admin@example.com")
    assert user.is_staff
    assert user.is_superuser
    assert user.check_password("s3cr3t!")
    # Username defaults to local part of email.
    assert user.username == "admin"


@pytest.mark.django_db
def test_create_admin_explicit_username(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "s3cr3t!")
    monkeypatch.setenv("DJANGO_SUPERUSER_USERNAME", "superadmin")

    call_command("create_admin")

    user = User.objects.get(email="admin@example.com")
    assert user.username == "superadmin"


@pytest.mark.django_db
def test_create_admin_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Running the command twice updates rather than duplicating the user."""
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "first-password")

    call_command("create_admin")

    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "second-password")
    call_command("create_admin")

    assert User.objects.filter(email="admin@example.com").count() == 1
    user = User.objects.get(email="admin@example.com")
    assert user.check_password("second-password")


@pytest.mark.django_db
def test_create_admin_missing_email_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DJANGO_SUPERUSER_EMAIL", raising=False)
    monkeypatch.setenv("DJANGO_SUPERUSER_PASSWORD", "s3cr3t!")

    with pytest.raises(CommandError, match="DJANGO_SUPERUSER_EMAIL"):
        call_command("create_admin")


@pytest.mark.django_db
def test_create_admin_missing_password_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
    monkeypatch.delenv("DJANGO_SUPERUSER_PASSWORD", raising=False)

    with pytest.raises(CommandError, match="DJANGO_SUPERUSER_PASSWORD"):
        call_command("create_admin")
