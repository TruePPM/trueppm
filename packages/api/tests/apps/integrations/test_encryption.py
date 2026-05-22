"""Tests for the integration-credential encryption helper.

The helper is small but security-critical: a bug that round-trips a stored
PAT through the model layer without encrypting it would land plaintext
PATs in PostgreSQL. These tests assert the round-trip works, that empty
plaintext is rejected, and that a missing key fails loudly rather than
silently storing plaintext.
"""

from __future__ import annotations

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings

from trueppm_api.apps.integrations.encryption import (
    CredentialEncryptionError,
    decrypt_secret,
    encrypt_secret,
    generate_key,
)


def test_encrypt_decrypt_round_trip() -> None:
    plaintext = "glpat-abc123-this-is-a-fake-token"
    ciphertext = encrypt_secret(plaintext)
    assert isinstance(ciphertext, bytes)
    assert plaintext.encode() not in ciphertext  # actually encrypted
    assert decrypt_secret(ciphertext) == plaintext


def test_encrypt_refuses_empty_plaintext() -> None:
    with pytest.raises(ValueError, match="empty secret"):
        encrypt_secret("")


def test_decrypt_handles_memoryview() -> None:
    """``models.BinaryField`` reads back as ``memoryview`` under some
    PostgreSQL driver paths — the helper accepts both bytes and memoryview
    so the model's ``decrypt`` call site doesn't have to coerce."""
    ciphertext = encrypt_secret("hello")
    assert decrypt_secret(memoryview(ciphertext)) == "hello"


def test_decrypt_corrupt_ciphertext_raises_typed_error() -> None:
    with pytest.raises(CredentialEncryptionError):
        decrypt_secret(b"this-is-not-a-valid-fernet-token")


def test_generate_key_is_fernet_compatible() -> None:
    """A freshly generated key must work for both encrypt and decrypt
    when applied to the next call. Round-trip with override_settings."""
    new_key = generate_key()
    with override_settings(INTEGRATION_ENCRYPTION_KEY=new_key):
        ciphertext = encrypt_secret("payload")
        assert decrypt_secret(ciphertext) == "payload"


@override_settings(INTEGRATION_ENCRYPTION_KEY="")
def test_missing_key_raises_improperly_configured() -> None:
    """An empty / missing key must raise ``ImproperlyConfigured`` rather
    than fall back to a hardcoded key. We never want a deploy to succeed
    with PATs stored in plaintext because the env var was forgotten."""
    with pytest.raises(ImproperlyConfigured, match="INTEGRATION_ENCRYPTION_KEY"):
        encrypt_secret("anything")
