"""End-to-end tests for the OIDC flow endpoints (ADR-0187 §2, #1405).

Covers ``discover`` (domain-only, no account enumeration), ``login`` (302 to the
IdP with PKCE), and ``callback`` (state validation, token exchange, ID-token
validation, session minting via the existing httpOnly refresh cookie, redirect to
the SPA with no token in the URL). Also asserts the password-login policy seam:
OSS allows local login by default, and a registered blocking policy returns 403.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache

from trueppm_api.apps.sso import extensions, services
from trueppm_api.apps.sso.models import OIDCIdentity
from trueppm_api.apps.sso.views import _STATE_COOKIE_NAME

from .conftest import ISSUER, api_client, make_id_token, set_token_endpoint

User = get_user_model()

DISCOVER = "/api/v1/auth/oidc/discover/"
LOGIN = "/api/v1/auth/oidc/login/"
CALLBACK = "/api/v1/auth/oidc/callback/"
TOKEN = "/api/v1/auth/token/"


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()  # also resets ScopedRateThrottle counters between tests
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _reset_seams() -> Any:
    extensions.register_local_login_policy_provider(None)
    yield
    extensions.register_local_login_policy_provider(None)


# ---------------------------------------------------------------------------
# discover — domain-level only, no enumeration
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_discover_false_when_sso_off(db: object) -> None:
    resp = api_client().get(DISCOVER, {"email": "alice@example.com"})
    assert resp.status_code == 200
    assert resp.data["provider_present"] is False


@pytest.mark.django_db
def test_discover_true_for_allowed_domain(provider: Any) -> None:
    resp = api_client().get(DISCOVER, {"email": "alice@example.com"})
    assert resp.status_code == 200
    assert resp.data["provider_present"] is True
    assert resp.data["issuer"] == ISSUER


@pytest.mark.django_db
def test_discover_false_for_other_domain(provider: Any) -> None:
    # A domain outside the allow-list looks identical to "no SSO" — the response
    # never reveals whether the email/account exists (no enumeration leak).
    resp = api_client().get(DISCOVER, {"email": "bob@other.com"})
    assert resp.status_code == 200
    assert resp.data["provider_present"] is False
    assert not resp.data.get("issuer")


# ---------------------------------------------------------------------------
# login — 302 to the IdP
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_login_redirects_to_idp_with_pkce(provider: Any, fake_discovery: None) -> None:
    resp = api_client().get(LOGIN)
    assert resp.status_code == 302
    location = resp["Location"]
    assert location.startswith(f"{ISSUER}/authorize?")
    assert "code_challenge_method=S256" in location
    assert "response_type=code" in location
    # The state is bound to this browser via a hardened, SameSite=Lax cookie so the
    # callback can prove the same browser is completing the flow (login-CSRF).
    cookie = resp.cookies[_STATE_COOKIE_NAME]
    assert cookie.value  # the state value
    assert cookie["httponly"]
    assert cookie["samesite"] == "Lax"


@pytest.mark.django_db
def test_login_not_configured_redirects_with_error(db: object) -> None:
    resp = api_client().get(LOGIN)
    assert resp.status_code == 302
    assert "error=sso_not_configured" in resp["Location"]


# ---------------------------------------------------------------------------
# callback
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_callback_happy_path_sets_refresh_cookie(
    provider: Any, fake_discovery: None, patch_jwks: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    redirect_uri = "http://testserver/api/v1/auth/oidc/callback/"
    result = services.start_login(provider, redirect_uri=redirect_uri)
    # Peek (without consuming) the nonce bound at login so the ID token matches.
    stored = cache.get(services._STATE_KEY_PREFIX + result.state)
    id_token = make_id_token(nonce=stored["nonce"], sub="sub-flow", email="alice@example.com")
    set_token_endpoint(monkeypatch, id_token=id_token)

    # The browser carries the state cookie set at /login; the callback requires it.
    client = api_client()
    client.cookies[_STATE_COOKIE_NAME] = result.state
    resp = client.get(CALLBACK, {"code": "auth-code", "state": result.state})

    assert resp.status_code == 302
    assert "/auth/sso/complete" in resp["Location"]
    # No token is ever placed in the redirect URL — only the httpOnly cookie.
    assert "error=" not in resp["Location"]
    assert "token" not in resp["Location"]
    assert settings.AUTH_REFRESH_COOKIE_NAME in resp.cookies
    # The user was auto-created and durably bound to (issuer, sub).
    assert OIDCIdentity.objects.filter(issuer=ISSUER, subject="sub-flow").exists()


@pytest.mark.django_db
def test_callback_idp_error_redirects_access_denied(provider: Any) -> None:
    resp = api_client().get(CALLBACK, {"error": "access_denied"})
    assert resp.status_code == 302
    assert "error=access_denied" in resp["Location"]


@pytest.mark.django_db
def test_callback_missing_code_is_invalid_request(provider: Any) -> None:
    resp = api_client().get(CALLBACK, {"state": "something"})
    assert resp.status_code == 302
    assert "error=invalid_request" in resp["Location"]


@pytest.mark.django_db
def test_callback_unknown_state_fails_closed(provider: Any) -> None:
    # Cookie matches the query param (passes the browser-binding check) but the
    # state was never issued server-side → consume_state fails closed.
    client = api_client()
    client.cookies[_STATE_COOKIE_NAME] = "never-issued"
    resp = client.get(CALLBACK, {"code": "c", "state": "never-issued"})
    assert resp.status_code == 302
    assert "error=invalid_state" in resp["Location"]


@pytest.mark.django_db
def test_callback_without_matching_state_cookie_fails_closed(
    provider: Any, fake_discovery: None
) -> None:
    # A genuine, server-issued state but no matching browser cookie → reject. This
    # is the login-CSRF / session-fixation defense: an attacker who completes login
    # at their own IdP cannot replay the (state, code) callback into a victim's
    # browser, because the victim has no cookie binding that state.
    result = services.start_login(provider, redirect_uri="http://testserver" + CALLBACK)
    resp = api_client().get(CALLBACK, {"code": "auth-code", "state": result.state})
    assert resp.status_code == 302
    assert "error=invalid_state" in resp["Location"]
    # The server-side state was NOT consumed (it remains available for the real
    # browser), proving we rejected before touching it.
    assert cache.get(services._STATE_KEY_PREFIX + result.state) is not None


@pytest.mark.django_db
def test_callback_not_configured(db: object) -> None:
    resp = api_client().get(CALLBACK, {"code": "c", "state": "s"})
    assert resp.status_code == 302
    assert "error=sso_not_configured" in resp["Location"]


# ---------------------------------------------------------------------------
# Password-login policy seam (ADR-0187 §4)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_password_login_allowed_by_default(db: object) -> None:
    User.objects.create_user(username="pw_default", password="secret-pw-123")
    resp = api_client().post(
        TOKEN, {"username": "pw_default", "password": "secret-pw-123"}, format="json"
    )
    assert resp.status_code == 200
    assert "access" in resp.data


@pytest.mark.django_db
def test_password_login_blocked_by_registered_policy(db: object) -> None:
    User.objects.create_user(username="pw_blocked", password="secret-pw-123")
    # Enterprise-style enforced-SSO policy: block local login. The 403 only fires
    # AFTER successful credential validation, so it never leaks account existence.
    extensions.register_local_login_policy_provider(lambda user: False)
    resp = api_client().post(
        TOKEN, {"username": "pw_blocked", "password": "secret-pw-123"}, format="json"
    )
    assert resp.status_code == 403
