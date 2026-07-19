"""End-to-end tests for the SSO flow endpoints (ADR-0517 §3.3–3.5).

Covers ``discover`` (domain-only, no account enumeration, now returning the list
of enabled providers), ``login`` (302 to the chosen IdP, provider-aware), and
``callback`` (state validation, provider disambiguation via the slug stored in
state, token exchange, ID-token / GitHub-userinfo validation, session minting via
the existing httpOnly refresh cookie, redirect to the SPA with no token in the
URL). Also asserts the password-login policy seam is unchanged.
"""

from __future__ import annotations

from typing import Any

import pytest
from allauth.socialaccount.models import SocialAccount
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache

from trueppm_api.apps.sso import extensions, services
from trueppm_api.apps.sso.views import _STATE_COOKIE_NAME

from .conftest import (
    ISSUER,
    api_client,
    make_github_ctx,
    make_id_token,
    set_token_endpoint,
    stub_github_egress,
)

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
    assert resp.data["providers"] == []


@pytest.mark.django_db
def test_discover_true_for_allowed_domain(provider_ctx: Any) -> None:
    resp = api_client().get(DISCOVER, {"email": "alice@example.com"})
    assert resp.status_code == 200
    assert resp.data["provider_present"] is True
    slugs = {p["slug"] for p in resp.data["providers"]}
    assert slugs == {"generic"}


@pytest.mark.django_db
def test_discover_false_for_other_domain(provider_ctx: Any) -> None:
    # A domain outside the allow-list looks identical to "no SSO" — no enumeration.
    resp = api_client().get(DISCOVER, {"email": "bob@other.com"})
    assert resp.status_code == 200
    assert resp.data["provider_present"] is False
    assert resp.data["providers"] == []


@pytest.mark.django_db
def test_discover_lists_all_enabled_providers(provider_ctx: Any) -> None:
    make_github_ctx()
    resp = api_client().get(DISCOVER)  # no email → all enabled providers
    slugs = {p["slug"] for p in resp.data["providers"]}
    assert slugs == {"generic", "github"}


# ---------------------------------------------------------------------------
# login — 302 to the IdP
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_login_redirects_to_idp_with_pkce(provider_ctx: Any, fake_discovery: None) -> None:
    resp = api_client().get(LOGIN, {"provider": "generic"})
    assert resp.status_code == 302
    location = resp["Location"]
    assert location.startswith(f"{ISSUER}/authorize?")
    assert "code_challenge_method=S256" in location
    assert "response_type=code" in location
    cookie = resp.cookies[_STATE_COOKIE_NAME]
    assert cookie.value
    assert cookie["httponly"]
    assert cookie["samesite"] == "Lax"


@pytest.mark.django_db
def test_login_null_byte_provider_400_not_500(provider_ctx: Any) -> None:
    """A NUL byte in ``?provider`` is rejected as 400 before the ORM (#2229).

    ``x\\x00y`` reaches ``SsoProviderPolicy.objects.filter(slug=...)`` unstripped;
    PostgreSQL forbids NUL bytes in text comparisons and raises an uncaught
    ``DataError`` (500). ``RejectNullBytesMiddleware`` short-circuits it to 400.
    """
    resp = api_client().get(LOGIN, {"provider": "x\x00y"})
    assert resp.status_code == 400
    assert resp["Content-Type"].startswith("application/json")


@pytest.mark.django_db
def test_login_defaults_to_sole_enabled_provider(provider_ctx: Any, fake_discovery: None) -> None:
    # With exactly one enabled provider, ?provider is optional.
    resp = api_client().get(LOGIN)
    assert resp.status_code == 302
    assert resp["Location"].startswith(f"{ISSUER}/authorize?")


@pytest.mark.django_db
def test_login_github_provider(github_ctx: Any) -> None:
    resp = api_client().get(LOGIN, {"provider": "github"})
    assert resp.status_code == 302
    assert resp["Location"].startswith(services.GITHUB_AUTHORIZE_URL + "?")


@pytest.mark.django_db
def test_login_unknown_provider_redirects_with_error(provider_ctx: Any) -> None:
    resp = api_client().get(LOGIN, {"provider": "does-not-exist"})
    assert resp.status_code == 302
    assert "error=sso_not_configured" in resp["Location"]


@pytest.mark.django_db
def test_login_not_configured_redirects_with_error(db: object) -> None:
    resp = api_client().get(LOGIN)
    assert resp.status_code == 302
    assert "error=sso_not_configured" in resp["Location"]


# ---------------------------------------------------------------------------
# callback — OIDC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_callback_happy_path_sets_refresh_cookie(
    provider_ctx: Any, fake_discovery: None, patch_jwks: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    redirect_uri = "http://testserver/api/v1/auth/oidc/callback/"
    result = services.start_login(provider_ctx, redirect_uri=redirect_uri)
    stored = cache.get(services._STATE_KEY_PREFIX + result.state)
    id_token = make_id_token(nonce=stored["nonce"], sub="sub-flow", email="alice@example.com")
    set_token_endpoint(monkeypatch, id_token=id_token)

    client = api_client()
    client.cookies[_STATE_COOKIE_NAME] = result.state
    resp = client.get(CALLBACK, {"code": "auth-code", "state": result.state})

    assert resp.status_code == 302
    assert "/auth/sso/complete" in resp["Location"]
    assert "error=" not in resp["Location"]
    assert "token" not in resp["Location"]
    assert settings.AUTH_REFRESH_COOKIE_NAME in resp.cookies
    assert SocialAccount.objects.filter(provider="generic", uid="sub-flow").exists()


@pytest.mark.django_db
def test_callback_github_happy_path(github_ctx: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    result = services.start_login(github_ctx, redirect_uri="http://testserver" + CALLBACK)
    stub_github_egress(
        monkeypatch,
        user={"id": 314, "login": "octocat", "name": "Mona"},
        emails=[{"email": "mona@example.com", "primary": True, "verified": True}],
    )
    client = api_client()
    client.cookies[_STATE_COOKIE_NAME] = result.state
    resp = client.get(CALLBACK, {"code": "auth-code", "state": result.state})

    assert resp.status_code == 302
    assert "/auth/sso/complete" in resp["Location"]
    assert "error=" not in resp["Location"]
    assert settings.AUTH_REFRESH_COOKIE_NAME in resp.cookies
    assert SocialAccount.objects.filter(provider="github", uid="314").exists()


@pytest.mark.django_db
def test_callback_idp_error_redirects_access_denied(provider_ctx: Any) -> None:
    resp = api_client().get(CALLBACK, {"error": "access_denied"})
    assert resp.status_code == 302
    assert "error=access_denied" in resp["Location"]


@pytest.mark.django_db
def test_callback_missing_code_is_invalid_request(provider_ctx: Any) -> None:
    resp = api_client().get(CALLBACK, {"state": "something"})
    assert resp.status_code == 302
    assert "error=invalid_request" in resp["Location"]


@pytest.mark.django_db
def test_callback_unknown_state_fails_closed(provider_ctx: Any) -> None:
    client = api_client()
    client.cookies[_STATE_COOKIE_NAME] = "never-issued"
    resp = client.get(CALLBACK, {"code": "c", "state": "never-issued"})
    assert resp.status_code == 302
    assert "error=invalid_state" in resp["Location"]


@pytest.mark.django_db
def test_callback_without_matching_state_cookie_fails_closed(
    provider_ctx: Any, fake_discovery: None
) -> None:
    # A genuine, server-issued state but no matching browser cookie → reject
    # (login-CSRF / session-fixation defense). The server-side state is NOT consumed.
    result = services.start_login(provider_ctx, redirect_uri="http://testserver" + CALLBACK)
    resp = api_client().get(CALLBACK, {"code": "auth-code", "state": result.state})
    assert resp.status_code == 302
    assert "error=invalid_state" in resp["Location"]
    assert cache.get(services._STATE_KEY_PREFIX + result.state) is not None


@pytest.mark.django_db
def test_callback_not_configured(db: object) -> None:
    resp = api_client().get(CALLBACK, {"code": "c", "state": "s"})
    assert resp.status_code == 302
    assert "error=sso_not_configured" in resp["Location"]


# ---------------------------------------------------------------------------
# Password-login policy seam (unchanged)
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
    extensions.register_local_login_policy_provider(lambda user: False)
    resp = api_client().post(
        TOKEN, {"username": "pw_blocked", "password": "secret-pw-123"}, format="json"
    )
    assert resp.status_code == 403
