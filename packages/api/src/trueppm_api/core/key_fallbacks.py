"""Parsing and verify-only JWT backend for zero-downtime key rotation (#3406).

Three secrets rotate with an overlap window: ``SECRET_KEY`` (Django's own
``SECRET_KEY_FALLBACKS``), ``JWT_SIGNING_KEY`` and ``INTEGRATION_ENCRYPTION_KEY``.
In every case the *primary* key is the only one used to sign or encrypt, and the
fallbacks are consulted for verification or decryption only. Rotating with no
fallback configured keeps its old meaning: everything signed under the old key
stops verifying (for the JWT key, that signs every user out).

This module must stay free of Django imports at module level so ``settings/base.py``
can import it.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any


def parse_key_list(raw: str | None) -> list[str]:
    """Split a comma-separated ``*_FALLBACKS`` env value into a list of keys.

    An unset or blank value yields ``[]``. Entries are stripped but an *empty*
    entry (``"a,,b"``, a trailing comma) is deliberately preserved so the boot
    validators can fail loudly on it instead of the typo being silently dropped.
    """
    if raw is None or not raw.strip():
        return []
    return [part.strip() for part in raw.split(",")]


def make_fallback_token_backend(fallbacks_getter: Callable[[], Sequence[str]]) -> Any:
    """Return a simplejwt ``TokenBackend`` that verifies against fallbacks too.

    ``encode`` is inherited and signs with the primary key only. ``decode`` tries
    the primary first; only a *signature* failure falls through to the fallbacks.
    An expired token is never retried: PyJWT checks the signature before ``exp``,
    so ``TokenBackendExpiredToken`` already proves the primary verified it.
    ``fallbacks_getter`` is read per call so a settings override takes effect.
    Fallbacks apply to the symmetric (HS*) algorithms the API signs with.
    """
    from rest_framework_simplejwt.backends import TokenBackend
    from rest_framework_simplejwt.exceptions import TokenBackendError, TokenBackendExpiredToken
    from rest_framework_simplejwt.settings import api_settings

    class FallbackTokenBackend(TokenBackend):
        def decode(self, token: Any, verify: bool = True) -> dict[str, Any]:
            try:
                return super().decode(token, verify=verify)
            except TokenBackendExpiredToken:
                raise
            except TokenBackendError as primary_error:
                if not verify:
                    raise
                for key in fallbacks_getter():
                    verifier = TokenBackend(
                        self.algorithm,
                        key,
                        "",
                        self.audience,
                        self.issuer,
                        None,
                        self.leeway,
                        self.json_encoder,
                    )
                    try:
                        return verifier.decode(token, verify=True)
                    except TokenBackendExpiredToken:
                        raise
                    except TokenBackendError:
                        continue
                raise primary_error

    return FallbackTokenBackend(
        api_settings.ALGORITHM,
        api_settings.SIGNING_KEY,
        api_settings.VERIFYING_KEY,
        api_settings.AUDIENCE,
        api_settings.ISSUER,
        api_settings.JWK_URL,
        api_settings.LEEWAY,
        api_settings.JSON_ENCODER,
    )
