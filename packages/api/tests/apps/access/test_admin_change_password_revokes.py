"""The Django admin's change-password form signs the account out everywhere (#4840).

Before #4840 the stock ``AdminPasswordChangeForm`` only rewrote the hash, while the
API password-reset flow (#4499) also blacklisted every refresh token and stamped
``UserProfile.credentials_revoked_at``. These tests drive the real admin view, so a
regression in the ``UserAdmin`` registration (``apps/access/admin.py``) is caught as
well as one in the form.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.test import Client
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.access.admin import RevokingAdminPasswordChangeForm, TruePPMUserAdmin
from trueppm_api.core.auth_views import _record_outstanding
from trueppm_api.core.credential_cutoff import credentials_revoked_at

User = get_user_model()

_NEW_PASSWORD = "N3w-Secure-Passw0rd!"


@pytest.fixture
def operator(db: object) -> Any:
    return User.objects.create_superuser(
        username="ops_admin", email="ops@example.com", password="ops-password-1"
    )


@pytest.fixture
def target(db: object) -> Any:
    return User.objects.create_user(
        username="pw_target", email="target@example.com", password="old-password-1"
    )


def test_user_admin_uses_the_revoking_form() -> None:
    model_admin = admin.site._registry[User]
    assert isinstance(model_admin, TruePPMUserAdmin)
    assert model_admin.change_password_form is RevokingAdminPasswordChangeForm


@pytest.mark.django_db
def test_admin_password_change_blacklists_refresh_tokens_and_stamps_cutoff(
    operator: Any, target: Any
) -> None:
    refresh = RefreshToken.for_user(target)
    _record_outstanding(refresh)
    assert credentials_revoked_at(target) is None

    client = Client()
    client.force_login(operator)
    resp = client.post(
        f"/admin/auth/user/{target.pk}/password/",
        {"password1": _NEW_PASSWORD, "password2": _NEW_PASSWORD},
    )
    assert resp.status_code == 302, resp.content

    target.refresh_from_db()
    assert target.check_password(_NEW_PASSWORD)
    assert credentials_revoked_at(target) is not None
    assert BlacklistedToken.objects.filter(token__jti=refresh["jti"]).exists()


@pytest.mark.django_db
def test_an_invalid_admin_password_change_revokes_nothing(operator: Any, target: Any) -> None:
    """Negative control: a form that fails validation must not sign the user out."""
    refresh = RefreshToken.for_user(target)
    _record_outstanding(refresh)

    client = Client()
    client.force_login(operator)
    resp = client.post(
        f"/admin/auth/user/{target.pk}/password/",
        {"password1": _NEW_PASSWORD, "password2": "does-not-match"},
    )
    assert resp.status_code == 200  # the form re-renders with its error

    target.refresh_from_db()
    assert target.check_password("old-password-1")
    assert credentials_revoked_at(target) is None
    assert not BlacklistedToken.objects.filter(token__jti=refresh["jti"]).exists()


@pytest.mark.django_db
def test_form_save_without_commit_does_not_revoke(target: Any) -> None:
    form = RevokingAdminPasswordChangeForm(
        target, {"password1": _NEW_PASSWORD, "password2": _NEW_PASSWORD}
    )
    assert form.is_valid(), form.errors
    form.save(commit=False)
    assert credentials_revoked_at(target) is None
