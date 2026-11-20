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
    # Replace the FIRST signature character: it carries six full bits, so any
    # different character changes the decoded bytes. Overwriting the tail with a
    # fixed "AA" was a no-op whenever the signature already ended that way, and the
    # last character's low bits are padding a lenient decoder ignores.
    tampered = ("B" if sig[0] == "A" else "A") + sig[1:]
    with pytest.raises(TokenError):
        AccessToken(f"{header}.{payload}.{tampered}")


def test_expired_token_under_fallback_stays_expired(jwt_key) -> None:
    from datetime import timedelta

    jwt_key(OLD, [])
    tok = AccessToken()
    tok.set_exp(lifetime=-timedelta(minutes=5))
    expired = str(tok)
    jwt_key(NEW, [OLD])
    from rest_framework_simplejwt.exceptions import ExpiredTokenError

    with pytest.raises(ExpiredTokenError, match="expired"):
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


# --- two-phase rollout: the overlap order the runbook prescribes -------------
# Phase 1 puts the NEW key in the fallbacks while OLD stays primary, so pods that
# have not restarted yet (primary OLD, fallbacks [NEW]) can verify anything a
# restarted pod (primary NEW, fallbacks [OLD]) signs. Phase 2 swaps them.


def test_jwt_phase1_pod_verifies_token_minted_by_phase2_pod(jwt_key) -> None:
    jwt_key(NEW, [OLD])  # a pod already on phase 2 signs under NEW
    minted = str(AccessToken())
    jwt_key(OLD, [NEW])  # a pod still on phase 1 (OLD primary, NEW fallback)
    assert AccessToken(minted)["token_type"] == "access"


def test_multifernet_phase1_pod_decrypts_value_written_by_phase2_pod(settings) -> None:
    from cryptography.fernet import Fernet

    from trueppm_api.apps.integrations.encryption import decrypt_secret, encrypt_secret

    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    settings.INTEGRATION_ENCRYPTION_KEY = new
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = [old]
    ciphertext = encrypt_secret("s3cret")
    settings.INTEGRATION_ENCRYPTION_KEY = old
    settings.INTEGRATION_ENCRYPTION_KEY_FALLBACKS = [new]
    assert decrypt_secret(ciphertext) == "s3cret"


def test_django_signing_phase1_pod_verifies_value_signed_by_phase2_pod(settings) -> None:
    settings.SECRET_KEY = NEW
    settings.SECRET_KEY_FALLBACKS = [OLD]
    value = signing.dumps({"v": 2})
    settings.SECRET_KEY = OLD
    settings.SECRET_KEY_FALLBACKS = [NEW]
    assert signing.loads(value) == {"v": 2}


# --- empty fallback entries must reject, not 500 -----------------------------


def test_empty_fallback_entry_rejects_stranger_token_without_invalid_key_error(jwt_key) -> None:
    jwt_key(OTHER, [])
    stranger = str(AccessToken())
    jwt_key(NEW, [""])
    with pytest.raises(TokenError):
        AccessToken(stranger)


# --- refresh endpoint under rotation -----------------------------------------


def test_refresh_endpoint_accepts_cookie_signed_under_old_key(jwt_key, django_user_model) -> None:
    from django.conf import settings as dj_settings
    from django.core.cache import cache
    from rest_framework.test import APIClient

    cache.clear()
    user = django_user_model.objects.create_user(username="rot-refresh", password=None)
    jwt_key(OLD, [])
    old_refresh = str(RefreshToken.for_user(user))
    jwt_key(NEW, [OLD])
    client = APIClient()
    client.cookies[dj_settings.AUTH_REFRESH_COOKIE_NAME] = old_refresh
    resp = client.post("/api/v1/auth/token/refresh/")
    assert resp.status_code == 200
    new_cookie = resp.cookies[dj_settings.AUTH_REFRESH_COOKIE_NAME].value
    assert new_cookie != old_refresh
    jwt_key(NEW, [])  # primary alone: everything minted now is under NEW
    assert AccessToken(resp.data["access"])["token_type"] == "access"
    assert RefreshToken(new_cookie)["token_type"] == "refresh"
    cache.clear()


# --- settings wiring ----------------------------------------------------------


def _fallbacks_in_subprocess(env_extra: dict[str, str]) -> list[list[str]]:
    import json
    import os
    import subprocess
    import sys

    code = (
        "import json;from trueppm_api.settings import base;"
        "print(json.dumps([base.SECRET_KEY_FALLBACKS, base.JWT_SIGNING_KEY_FALLBACKS]))"
    )
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"JWT_SIGNING_KEY", "JWT_SIGNING_KEY_FALLBACKS", "SECRET_KEY_FALLBACKS"}
    }
    env.update(env_extra)
    out = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_jwt_fallbacks_inherit_secret_key_fallbacks_only_when_jwt_key_unset() -> None:
    inherited = _fallbacks_in_subprocess({"SECRET_KEY_FALLBACKS": "old1,old2"})
    assert inherited == [["old1", "old2"], ["old1", "old2"]]
    explicit = _fallbacks_in_subprocess(
        {"SECRET_KEY_FALLBACKS": "old1,old2", "JWT_SIGNING_KEY": "j" * 50}
    )
    assert explicit == [["old1", "old2"], []]
    own = _fallbacks_in_subprocess(
        {"JWT_SIGNING_KEY": "j" * 50, "JWT_SIGNING_KEY_FALLBACKS": "jold"}
    )
    assert own[1] == ["jold"]


def test_check_key_fallbacks_is_registered_as_a_deploy_check() -> None:
    from django.core.checks.registry import registry

    from trueppm_api.core.security_checks import check_key_fallbacks

    assert check_key_fallbacks in registry.get_checks(include_deployment_checks=True)
