"""MultiFernet decryption fallback and ``reencrypt_integration_secrets`` (#3406)."""

from __future__ import annotations

from io import StringIO

import pytest
from cryptography.fernet import Fernet
from django.apps import apps
from django.core.exceptions import ImproperlyConfigured
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import models

from trueppm_api.apps.integrations.encryption import (
    CredentialEncryptionError,
    decrypt_secret,
    encrypt_secret,
    reencrypt_ciphertext,
)
from trueppm_api.apps.integrations.management.commands.reencrypt_integration_secrets import (
    ENCRYPTED_FIELDS,
)
from trueppm_api.apps.integrations.models import IntegrationCredential
from trueppm_api.apps.notifications.models import WorkspaceEmailSettings

OLD_KEY = Fernet.generate_key().decode()
NEW_KEY = Fernet.generate_key().decode()


def _encrypt_under(key: str, settings, plaintext: str) -> bytes:
    settings.INTEGRATION_ENCRYPTION_KEY = key
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = []
    return encrypt_secret(plaintext)


def test_decrypt_via_fallback_and_primary_alone_after_reencrypt(settings) -> None:
    old_ct = _encrypt_under(OLD_KEY, settings, "pat-123")
    settings.INTEGRATION_ENCRYPTION_KEY = NEW_KEY
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = [OLD_KEY]
    assert decrypt_secret(old_ct) == "pat-123"
    # New writes use the primary only.
    fresh = encrypt_secret("fresh")
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = []
    assert decrypt_secret(fresh) == "fresh"
    with pytest.raises(CredentialEncryptionError):
        decrypt_secret(old_ct)


def test_reencrypt_ciphertext_none_when_already_primary(settings) -> None:
    ct = _encrypt_under(NEW_KEY, settings, "x")
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = [OLD_KEY]
    assert reencrypt_ciphertext(ct) is None


def test_malformed_fallback_fails_loudly_without_key_material(settings) -> None:
    settings.INTEGRATION_ENCRYPTION_KEY = NEW_KEY
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = ["garbage-key-value"]
    with pytest.raises(ImproperlyConfigured) as exc:
        encrypt_secret("x")
    assert "garbage-key-value" not in str(exc.value)


@pytest.mark.django_db
def test_command_rewrites_dry_run_idempotent(settings, django_user_model) -> None:
    user = django_user_model.objects.create_user(username="rot", password=None)
    cred = IntegrationCredential.objects.create(
        user=user, provider="jira", secret_ciphertext=_encrypt_under(OLD_KEY, settings, "tok")
    )
    email = WorkspaceEmailSettings.load()
    email.password_ciphertext = encrypt_secret("smtp-pw")
    email.save()

    settings.INTEGRATION_ENCRYPTION_KEY = NEW_KEY
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = [OLD_KEY]
    before = bytes(IntegrationCredential.objects.get(pk=cred.pk).secret_ciphertext)

    out = StringIO()
    call_command("reencrypt_integration_secrets", "--dry-run", stdout=out)
    assert "IntegrationCredential.secret_ciphertext: would rewrite 1" in out.getvalue()
    assert bytes(IntegrationCredential.objects.get(pk=cred.pk).secret_ciphertext) == before

    out = StringIO()
    call_command("reencrypt_integration_secrets", "--batch-size", "1", stdout=out)
    assert "IntegrationCredential.secret_ciphertext: rewrote 1" in out.getvalue()
    assert "WorkspaceEmailSettings.password_ciphertext: rewrote 1" in out.getvalue()

    # Primary alone now decrypts every row.
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = []
    row = IntegrationCredential.objects.get(pk=cred.pk)
    assert decrypt_secret(row.secret_ciphertext) == "tok"
    assert WorkspaceEmailSettings.load().get_password() == "smtp-pw"

    out = StringIO()
    call_command("reencrypt_integration_secrets", stdout=out)
    assert "rewrote 0" in out.getvalue()
    assert "rewrote 1" not in out.getvalue()


@pytest.mark.django_db
def test_command_fails_and_keeps_going_on_undecryptable_row(settings, django_user_model) -> None:
    user = django_user_model.objects.create_user(username="rot2", password=None)
    IntegrationCredential.objects.create(
        user=user, provider="jira", secret_ciphertext=_encrypt_under(OLD_KEY, settings, "tok")
    )
    settings.INTEGRATION_ENCRYPTION_KEY = NEW_KEY
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = []  # old key forgotten
    with pytest.raises(CommandError, match="could not be decrypted"):
        call_command("reencrypt_integration_secrets", stdout=StringIO())


def test_every_ciphertext_field_is_registered() -> None:
    """A new ``*_ciphertext`` column must be added to ENCRYPTED_FIELDS or it is
    stranded on a dropped key."""
    found = {
        (m._meta.app_label, m.__name__, f.name)
        for m in apps.get_models()
        for f in m._meta.get_fields()
        if isinstance(f, models.BinaryField) and f.name.endswith("_ciphertext")
    }
    assert found == set(ENCRYPTED_FIELDS)
