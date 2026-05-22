"""Symmetric encryption helper for ``IntegrationCredential.secret_ciphertext``
(ADR-0049 §3).

Fernet (AES-128-CBC + HMAC-SHA256, urlsafe-base64) is used because the
``cryptography`` library is already a transitive dependency of several
Django ecosystem packages and Fernet's authenticated-encryption guarantees
match what we need: confidentiality for PATs at rest, plus tamper detection
on the ciphertext blob.

The encryption key comes from ``settings.INTEGRATION_ENCRYPTION_KEY`` —
sourced from a Helm value in production and a deterministic test key in
dev / CI. Key rotation is an Enterprise hardening item (ADR-0049 §6); 0.2
ships with a single active key.
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


class CredentialEncryptionError(RuntimeError):
    """Raised when decrypting a stored ``secret_ciphertext`` fails.

    A common cause is a stored ciphertext whose key was rotated without the
    matching rotation migration — Enterprise-only in 0.2, but the exception
    type is defined here so OSS callers can catch it.
    """


def _load_fernet() -> Fernet:
    """Build a ``Fernet`` from ``settings.INTEGRATION_ENCRYPTION_KEY``.

    Settings is read lazily so dev / CI can set the key in a per-test
    fixture without an import-time crash. A missing / empty key raises
    ``ImproperlyConfigured`` — production deployments fail loudly rather
    than silently storing un-encrypted secrets.
    """
    key = getattr(settings, "INTEGRATION_ENCRYPTION_KEY", "") or ""
    if not key:
        raise ImproperlyConfigured(
            "INTEGRATION_ENCRYPTION_KEY is not set — refusing to encrypt credentials. "
            "Generate one with: python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'"
        )
    return Fernet(key.encode() if isinstance(key, str) else key)


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
    generates this once and stores it as a Kubernetes Secret. Rotating the
    key is an Enterprise concern — see ADR-0049 §6.
    """
    raw: bytes = Fernet.generate_key()
    return raw.decode("ascii")
