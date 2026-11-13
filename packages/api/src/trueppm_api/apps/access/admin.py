"""Django admin registration for ``auth.User`` with a revoking change-password form (#4840).

The stock admin "change password" form only rewrites the hash. A password reset
through the API (#4499) also signs the account out everywhere: it blacklists every
refresh token and stamps ``UserProfile.credentials_revoked_at`` so every access
token, refresh token and WebSocket ticket issued before the change is refused. An
operator who changes a password from ``/admin/`` is doing the same thing for the
same reasons — usually because the old password is lost or suspect — so leaving the
old sessions live made the admin path the weaker of the two.

The hook is the form's ``save()`` rather than Django's ``password_changed()``
validator callback on purpose: that callback also fires on every
``create_user(password=...)``, which would stamp a cutoff on every new account and
refuse tokens minted in its first seconds, and it only runs when
``AUTH_PASSWORD_VALIDATORS`` is configured.

``manage.py changepassword`` is not covered here — Django resolves a management
command from the first app that defines it, so overriding it would mean moving an
app ahead of ``django.contrib.auth`` in ``INSTALLED_APPS``. The administration docs
name ``revoke_api_tokens --user <name> --commit`` as the required follow-up for that
path instead.

This module is imported by admin autodiscovery, which runs in ``INSTALLED_APPS``
order; ``django.contrib.auth`` comes first, so its stock ``UserAdmin`` is already
registered when this replaces it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.forms import AdminPasswordChangeForm
from django.db import transaction

if TYPE_CHECKING:
    # django-stubs makes the form generic in the user model; the runtime class is not
    # subscriptable, so the parameterized base exists for the type checker only.
    _PasswordFormBase = AdminPasswordChangeForm[Any]
else:
    _PasswordFormBase = AdminPasswordChangeForm


class RevokingAdminPasswordChangeForm(_PasswordFormBase):
    """``AdminPasswordChangeForm`` that signs the account out everywhere on save.

    Covers both outcomes the stock form offers — a new password, and (Django 5.1+)
    "disable password-based authentication" — since either one is an operator
    deciding the old password must stop working.
    """

    def save(self, commit: bool = True) -> Any:
        from trueppm_api.apps.access.services import revoke_all_refresh_tokens

        if not commit:
            # Nothing is persisted yet, so there is nothing to revoke against; the
            # caller that saves the user later owns that step.
            return super().save(commit=False)
        # One transaction so the new hash and the revocation commit together: a
        # failure revoking must not leave the password changed with old sessions live.
        with transaction.atomic():
            user = super().save(commit=True)
            # Blacklists every outstanding refresh token and stamps the credential
            # cutoff (#4499) — the same "sign out every device" primitive the
            # password-reset flow uses.
            revoke_all_refresh_tokens(user)
        return user


User = get_user_model()

if admin.site.is_registered(User):
    admin.site.unregister(User)


@admin.register(User)
class TruePPMUserAdmin(UserAdmin):  # type: ignore[type-arg]
    """Stock ``UserAdmin`` whose change-password view revokes sessions (#4840)."""

    change_password_form = RevokingAdminPasswordChangeForm
