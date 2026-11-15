"""Zero-downtime key rotation: SECRET_KEY_FALLBACKS, JWT verify-fallback, validators (#3406)."""

from __future__ import annotations

import pytest
from django.core import signing
from django.core.signing import BadSignature
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from trueppm_api.core.key_fallbacks import parse_key_list
from trueppm_api.core.security_checks import (
    validate_integration_encryption_key_fallbacks,
    validate_secret_key_fallbacks,
    validate_signing_key_fallbacks,
)

pytestmark = pytest.mark.django_db

OLD = "old-key-" + "o" * 48
NEW = "new-key-" + "n" * 48
OTHER = "other-key-" + "x" * 48


def test_parse_key_list() -> None:
    assert parse_key_list(None) == []
    assert parse_key_list("  ") == []
    assert parse_key_list("a, b") == ["a", "b"]
    assert parse_key_list("a,,b") == ["a", "", "b"]  # empties kept for the validator


def test_django_signing_honors_secret_key_fallbacks(settings) -> None:
    settings.SECRET_KEY = OLD
    settings.SECRET_KEY_FALLBACKS = []
    token = signing.dumps({"v": 1})
    settings.SECRET_KEY = NEW
    with pytest.raises(BadSignature):
        signing.loads(token)  # rotated with no fallback: old value rejected
    settings.SECRET_KEY_FALLBACKS = [OLD]
    assert signing.loads(token) == {"v": 1}
    settings.SECRET_KEY_FALLBACKS = [OTHER]
    with pytest.raises(BadSignature):
        signing.loads(token)  # key in neither slot fails


@pytest.fixture
def jwt_key(settings):
    """Rebind simplejwt's SIGNING_KEY; the fallback backend reads settings per call."""
    from rest_framework_simplejwt import state
    from rest_framework_simplejwt.settings import api_settings

    from trueppm_api.core.key_fallbacks import make_fallback_token_backend

    original_backend = state.token_backend
    original = api_settings.SIGNING_KEY

    def _set(key: str, fallbacks: list[str]) -> None:
        settings.SIMPLE_JWT = {**settings.SIMPLE_JWT, "SIGNING_KEY": key}
        settings.JWT_SIGNING_KEY_FALLBACKS = fallbacks
        # simplejwt builds its backend once; rebuild so the new primary applies.
        state.token_backend = make_fallback_token_backend(
            lambda: settings.JWT_SIGNING_KEY_FALLBACKS
        )

    yield _set
    settings.SIMPLE_JWT = {**settings.SIMPLE_JWT, "SIGNING_KEY": original}
    state.token_backend = original_backend


def _backend_for_current_key():
    from rest_framework_simplejwt import state

    return state.token_backend


def test_old_key_token_verifies_via_fallback_and_new_tokens_sign_with_primary(jwt_key) -> None:
    jwt_key(OLD, [])
    old_refresh = str(RefreshToken())
    old_access = str(AccessToken())

    jwt_key(NEW, [OLD])
    # In-flight tokens signed under the old key still verify during the overlap.
    assert AccessToken(old_access)["token_type"] == "access"
    refreshed = RefreshToken(old_refresh).access_token
    # ...but anything minted now is signed with the primary ONLY.
    minted = str(refreshed)
    jwt_key(NEW, [])
    assert AccessToken(minted)["token_type"] == "access"
    jwt_key(OLD, [])
    with pytest.raises(TokenError):
        AccessToken(minted)


def test_no_fallback_rejects_old_key_token(jwt_key) -> None:
    jwt_key(OLD, [])
    old_access = str(AccessToken())
    jwt_key(NEW, [])
    with pytest.raises(TokenError):
        AccessToken(old_access)  # the documented forced-sign-out lever still works


def test_key_in_neither_slot_and_tampered_token_rejected(jwt_key) -> None:
    jwt_key(OTHER, [])
    stranger = str(AccessToken())
    jwt_key(NEW, [OLD])
    with pytest.raises(TokenError):
        AccessToken(stranger)
    jwt_key(OLD, [])
    good = str(AccessToken())
    jwt_key(NEW, [OLD])
    header, payload, sig = good.split(".")
    with pytest.raises(TokenError):
        AccessToken(f"{header}.{payload}.{sig[:-2]}AA")


def test_expired_token_under_fallback_stays_expired(jwt_key) -> None:
    from datetime import timedelta

    jwt_key(OLD, [])
    tok = AccessToken()
    tok.set_exp(lifetime=-timedelta(minutes=5))
    expired = str(tok)
    jwt_key(NEW, [OLD])
    with pytest.raises(TokenError):
        AccessToken(expired)


def test_fallback_backend_is_installed() -> None:
    assert type(_backend_for_current_key()).__name__ == "FallbackTokenBackend"


# --- boot validators -------------------------------------------------------


def test_validators_accept_strong_entries_and_empty_list() -> None:
    from cryptography.fernet import Fernet

    assert validate_secret_key_fallbacks([], debug=False) == []
    assert validate_secret_key_fallbacks([OLD], debug=False) == []
    assert validate_signing_key_fallbacks([OLD], debug=False) == []
    key = Fernet.generate_key().decode()
    assert validate_integration_encryption_key_fallbacks([key], debug=False) == []


def test_validators_reject_weak_malformed_and_empty_entries_without_echoing_keys() -> None:
    weak = "short-secret"
    errs = validate_secret_key_fallbacks([OLD, weak], debug=False)
    assert errs and all("SECRET_KEY_FALLBACKS[1]" in str(e.msg) for e in errs)
    assert all(weak not in str(e.msg) for e in errs)

    placeholder = validate_signing_key_fallbacks(["django-insecure-" + "z" * 40], debug=False)
    assert placeholder and "JWT_SIGNING_KEY_FALLBACKS[0]" in str(placeholder[0].msg)

    bad_fernet = validate_integration_encryption_key_fallbacks(["not-a-fernet-key"], debug=False)
    assert bad_fernet and "INTEGRATION_ENCRYPTION_KEY_FALLBACKS[0]" in str(bad_fernet[0].msg)
    assert "not-a-fernet-key" not in str(bad_fernet[0].msg)

    stray = validate_secret_key_fallbacks([OLD, ""], debug=False)
    assert stray and "empty" in str(stray[0].msg)


def test_validators_skip_in_debug() -> None:
    assert validate_secret_key_fallbacks(["x"], debug=True) == []
