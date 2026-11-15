"""Symmetric encryption helper for ``IntegrationCredential.secret_ciphertext``
(ADR-0049 §3).

Fernet (AES-128-CBC + HMAC-SHA256, urlsafe-base64) is used because the
``cryptography`` library is already a transitive dependency of several
Django ecosystem packages and Fernet's authenticated-encryption guarantees
match what we need: confidentiality for PATs at rest, plus tamper detection
on the ciphertext blob.

The encryption key comes from ``settings.INTEGRATION_ENCRYPTION_KEY`` —
sourced from a Helm value in production and a deterministic test key in
dev / CI. Rotation (#3406): ``settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS``
holds older keys that are tried for decryption only (``MultiFernet``); every
write encrypts under the primary. ``manage.py reencrypt_integration_secrets``
moves stored rows onto the primary so a fallback can be dropped.
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


class CredentialEncryptionError(RuntimeError):
    """Raised when decrypting a stored ``secret_ciphertext`` fails.

    A common cause is a stored ciphertext whose key was rotated without the
    matching key being kept in ``INTEGRATION_ENCRYPTION_KEY_FALLBACKS``.
    """


def _as_bytes(key: str | bytes) -> bytes:
    return key.encode() if isinstance(key, str) else key


def _primary_key() -> bytes:
    key = getattr(settings, "INTEGRATION_ENCRYPTION_KEY", "") or ""
    if not key:
        raise ImproperlyConfigured(
            "INTEGRATION_ENCRYPTION_KEY is not set — refusing to encrypt credentials. "
            "Generate one with: python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'"
        )
    return _as_bytes(key)


def _load_fernet() -> MultiFernet:
    """Build a ``MultiFernet``: primary key first, then the rotation fallbacks.

    ``MultiFernet.encrypt`` always uses the first key, so writes land under the
    primary; ``decrypt`` tries each key in order, so rows written under a key
    still listed in ``INTEGRATION_ENCRYPTION_KEY_FALLBACKS`` keep working during
    a rotation. Settings is read lazily so dev / CI can set the key in a
    per-test fixture. A missing / empty primary raises ``ImproperlyConfigured``
    — production deployments fail loudly rather than silently storing
    un-encrypted secrets. A malformed fallback raises ``ImproperlyConfigured``
    too (never skipped) and its message does not include key material.
    """
    fernets = [Fernet(_primary_key())]
    for index, fallback in enumerate(
        getattr(settings, "INTEGRATION_ENCRYPTION_KEY_FALLBACKS", None) or []
    ):
        try:
            fernets.append(Fernet(_as_bytes(fallback)))
        except (ValueError, TypeError):
            raise ImproperlyConfigured(
                f"INTEGRATION_ENCRYPTION_KEY_FALLBACKS[{index}] is not a valid Fernet key "
                "(expected 32-byte urlsafe-base64)."
            ) from None
    return MultiFernet(fernets)


def reencrypt_ciphertext(ciphertext: bytes | memoryview) -> bytes | None:
    """Return ``ciphertext`` re-encrypted under the primary key, or ``None``.

    ``None`` means the blob already decrypts under the primary key alone, so
    there is nothing to do — this is what makes the re-encrypt command
    idempotent. Raises ``CredentialEncryptionError`` when no configured key can
    decrypt it.
    """
    if isinstance(ciphertext, memoryview):
        ciphertext = bytes(ciphertext)
    try:
        Fernet(_primary_key()).decrypt(ciphertext)
    except InvalidToken:
        pass
    else:
        return None
    try:
        rotated: bytes = _load_fernet().rotate(ciphertext)
    except InvalidToken as exc:
        raise CredentialEncryptionError(
            "Ciphertext cannot be decrypted by the primary key or any configured fallback."
        ) from exc
    return rotated


def encrypt_secret(plaintext: str) -> bytes:
    """Encrypt ``plaintext`` and return the ciphertext bytes for storage.

    Empty input is rejected — an empty PAT is always a bug; refusing it here
    surfaces the bug at write time rather than at first use.
    """
    if not plaintext:
        raise ValueError("Refusing to encrypt empty secret")
    fernet = _load_fernet()
    ciphertext: bytes = fernet.encrypt(plaintext.encode("utf-8"))
    return ciphertext


def decrypt_secret(ciphertext: bytes | memoryview) -> str:
    """Decrypt a stored ciphertext blob back to its plaintext PAT.

    Raises:
        CredentialEncryptionError: If the ciphertext is corrupt, truncated,
            or was encrypted under a different key than the one currently
            configured.
    """
    if isinstance(ciphertext, memoryview):
        ciphertext = bytes(ciphertext)
    fernet = _load_fernet()
    try:
        plaintext_bytes: bytes = fernet.decrypt(ciphertext)
    except InvalidToken as exc:  # pragma: no cover — guard, not behavior
        raise CredentialEncryptionError(
            "Failed to decrypt credential — ciphertext is corrupt or the "
            "encryption key has changed since this row was written."
        ) from exc
    return plaintext_bytes.decode("utf-8")


def generate_key() -> str:
    """Return a new urlsafe-base64 Fernet key suitable for the Helm value.

    Exposed for the management command + tests; the production deploy
    generates this once and stores it as a Kubernetes Secret. To rotate it,
    see ``INTEGRATION_ENCRYPTION_KEY_FALLBACKS``.
    """
    raw: bytes = Fernet.generate_key()
    return raw.decode("ascii")
