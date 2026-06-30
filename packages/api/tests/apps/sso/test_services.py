"""Unit tests for the OIDC service layer (ADR-0187 §2, #1405).

Covers the security-critical pure logic in isolation: PKCE/state single-use,
discovery validation, token exchange, ID-token signature/claim validation
(including the alg-confusion and replay defenses), and identity resolution
(durable key, verified-email gate, account-linking, auto-create, fail-closed
domain/ambiguity paths).
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any

import jwt
import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache

from trueppm_api.apps.sso import extensions, services
from trueppm_api.apps.sso.models import OIDCIdentity, OIDCProvider
from trueppm_api.apps.workspace.models import WorkspaceMembership, WorkspaceRole

from .conftest import (
    ALLOWED_DOMAIN,
    CLIENT_ID,
    CLIENT_SECRET,
    ISSUER,
    discovery_doc,
    make_id_token,
    set_token_endpoint,
)

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _reset_extension_seams() -> Any:
    """Each test starts with no enterprise provider registered (OSS defaults)."""
    extensions.register_oidc_identity_mapper(None)
    extensions.register_local_login_policy_provider(None)
    yield
    extensions.register_oidc_identity_mapper(None)
    extensions.register_local_login_policy_provider(None)


def _unsaved_provider() -> OIDCProvider:
    """A provider with the fields the token/validate paths read, not persisted."""
    p = OIDCProvider(issuer_url=ISSUER, client_id=CLIENT_ID, allowed_email_domains=[ALLOWED_DOMAIN])
    p.set_client_secret(CLIENT_SECRET)
    return p


# ---------------------------------------------------------------------------
# Provider resolution — fail closed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_enabled_provider_none_when_disabled(provider: OIDCProvider) -> None:
    provider.enabled = False
    provider.save()
    assert services.get_enabled_provider() is None


@pytest.mark.django_db
def test_get_enabled_provider_none_without_secret() -> None:
    p = OIDCProvider.load()
    p.enabled = True
    p.issuer_url = ISSUER
    p.client_id = CLIENT_ID
    p.save()  # no secret stored
    assert services.get_enabled_provider() is None


@pytest.mark.django_db
def test_get_enabled_provider_returns_complete(provider: OIDCProvider) -> None:
    assert services.get_enabled_provider() is not None


# ---------------------------------------------------------------------------
# PKCE + state
# ---------------------------------------------------------------------------


def test_pkce_pair_is_valid_s256() -> None:
    verifier, challenge = services._pkce_pair()
    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    assert challenge == expected
    assert "=" not in challenge  # base64url, no padding


@pytest.mark.django_db
def test_start_login_stores_state_and_builds_url(
    provider: OIDCProvider, fake_discovery: None
) -> None:
    redirect_uri = "https://app.example.com/api/v1/auth/oidc/callback/"
    result = services.start_login(provider, redirect_uri=redirect_uri)

    assert result.authorization_url.startswith(f"{ISSUER}/authorize?")
    assert "code_challenge_method=S256" in result.authorization_url
    assert "response_type=code" in result.authorization_url
    # The PKCE verifier and nonce are stored server-side, never in the URL.
    stored = cache.get(services._STATE_KEY_PREFIX + result.state)
    assert stored is not None
    assert stored["redirect_uri"] == redirect_uri
    assert stored["verifier"] not in result.authorization_url
    assert stored["nonce"] in result.authorization_url  # nonce is sent to the IdP


@pytest.mark.django_db
def test_consume_state_is_single_use(provider: OIDCProvider, fake_discovery: None) -> None:
    result = services.start_login(provider, redirect_uri="https://app/cb/")
    first = services.consume_state(result.state)
    assert first["nonce"]
    # Second consume of the same state fails closed (replay defense).
    with pytest.raises(services.OIDCStateError):
        services.consume_state(result.state)


def test_consume_state_missing_raises() -> None:
    with pytest.raises(services.OIDCStateError):
        services.consume_state("does-not-exist")


# ---------------------------------------------------------------------------
# Discovery validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_discovery_rejects_issuer_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from trueppm_api.apps.integrations import http as egress

    def _fake_get(url: str, **kwargs: Any) -> egress.EgressResponse:
        doc = discovery_doc()
        doc["issuer"] = "https://evil.example.com"  # lies about its identity
        return egress.EgressResponse(status=200, body=json.dumps(doc).encode(), headers={})

    monkeypatch.setattr(services.egress, "get", _fake_get)
    with pytest.raises(services.OIDCIDTokenError):
        services.get_discovery_document(ISSUER)


def test_discovery_unreachable_maps_to_provider_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from trueppm_api.apps.integrations import http as egress

    def _boom(url: str, **kwargs: Any) -> Any:
        raise egress.EgressBlocked("blocked by SSRF guard")

    monkeypatch.setattr(services.egress, "get", _boom)
    with pytest.raises(services.OIDCProviderUnreachable):
        services.get_discovery_document(ISSUER)


@pytest.mark.django_db
def test_discovery_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from trueppm_api.apps.integrations import http as egress

    calls = {"n": 0}

    def _fake_get(url: str, **kwargs: Any) -> egress.EgressResponse:
        calls["n"] += 1
        return egress.EgressResponse(
            status=200, body=json.dumps(discovery_doc()).encode(), headers={}
        )

    monkeypatch.setattr(services.egress, "get", _fake_get)
    services.get_discovery_document(ISSUER)
    services.get_discovery_document(ISSUER)
    assert calls["n"] == 1  # second call served from cache


# ---------------------------------------------------------------------------
# Token exchange
# ---------------------------------------------------------------------------


def test_exchange_code_returns_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    set_token_endpoint(monkeypatch, id_token="header.payload.sig")
    tokens = services.exchange_code(
        _unsaved_provider(), discovery_doc(), code="c", redirect_uri="https://app/cb/", verifier="v"
    )
    assert tokens["id_token"] == "header.payload.sig"


def test_exchange_code_oauth_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    set_token_endpoint(monkeypatch, status=400, error="invalid_grant")
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_code(
            _unsaved_provider(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


def test_exchange_code_missing_id_token_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    set_token_endpoint(monkeypatch, id_token=None, status=200)
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_code(
            _unsaved_provider(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


# ---------------------------------------------------------------------------
# ID-token validation
# ---------------------------------------------------------------------------


def test_validate_id_token_happy(patch_jwks: None) -> None:
    token = make_id_token(nonce="n1")
    claims = services.validate_id_token(
        _unsaved_provider(), discovery_doc(), token, expected_nonce="n1"
    )
    assert claims["sub"] == "idp-subject-1"
    assert claims["email"] == "alice@example.com"


def test_validate_id_token_nonce_mismatch(patch_jwks: None) -> None:
    token = make_id_token(nonce="n1")
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            _unsaved_provider(), discovery_doc(), token, expected_nonce="different"
        )


def test_validate_id_token_wrong_audience(patch_jwks: None) -> None:
    token = make_id_token(aud="some-other-client")
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            _unsaved_provider(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_wrong_issuer(patch_jwks: None) -> None:
    token = make_id_token(iss="https://evil.example.com")
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            _unsaved_provider(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_expired(patch_jwks: None) -> None:
    import time

    token = make_id_token(extra={"exp": int(time.time()) - 10})
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            _unsaved_provider(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_rejects_alg_none(patch_jwks: None) -> None:
    # An unsigned (alg=none) token must never be honored.
    token = jwt.encode(
        {"sub": "x", "iss": ISSUER, "aud": CLIENT_ID, "nonce": "n0nce"}, None, algorithm="none"
    )
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            _unsaved_provider(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_rejects_hs256(patch_jwks: None) -> None:
    # An HS256 token "signed" with the client secret must be rejected (the alg
    # allow-list is asymmetric-only), closing the alg-confusion class.
    token = make_id_token(alg="HS256", key=CLIENT_SECRET)
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            _unsaved_provider(), discovery_doc(), token, expected_nonce="n0nce"
        )


# ---------------------------------------------------------------------------
# Domain allow-list
# ---------------------------------------------------------------------------


def test_domain_allowed_empty_fails_closed() -> None:
    p = OIDCProvider(allowed_email_domains=[])
    assert services._domain_allowed(p, "alice@example.com") is False


def test_domain_allowed_matches_case_insensitive() -> None:
    p = OIDCProvider(allowed_email_domains=["example.com"])
    assert services._domain_allowed(p, "Alice@Example.COM") is True
    assert services._domain_allowed(p, "alice@other.com") is False


# ---------------------------------------------------------------------------
# Identity resolution
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolve_durable_identity_wins(provider: OIDCProvider) -> None:
    user = User.objects.create_user(username="existing", email="x@example.com", password="pw")
    OIDCIdentity.objects.create(user=user, issuer=ISSUER, subject="sub-1")
    # Even with no email in the claims, the durable (issuer,sub) binding resolves.
    resolved, created = services.resolve_user(provider, {"sub": "sub-1"})
    assert resolved == user
    assert created is False


@pytest.mark.django_db
def test_resolve_links_single_existing_account(provider: OIDCProvider) -> None:
    user = User.objects.create_user(username="bob", email="bob@example.com", password="pw")
    resolved, created = services.resolve_user(
        provider, {"sub": "sub-bob", "email": "bob@example.com", "email_verified": True}
    )
    assert resolved == user
    assert created is False
    # A durable binding is now recorded so later logins resolve by subject.
    assert OIDCIdentity.objects.filter(user=user, issuer=ISSUER, subject="sub-bob").exists()


@pytest.mark.django_db
def test_resolve_ambiguous_email_fails_closed(provider: OIDCProvider) -> None:
    User.objects.create_user(username="c1", email="dup@example.com", password="pw")
    User.objects.create_user(username="c2", email="dup@example.com", password="pw")
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider, {"sub": "s", "email": "dup@example.com", "email_verified": True}
        )


@pytest.mark.django_db
def test_resolve_unverified_email_fails(provider: OIDCProvider) -> None:
    with pytest.raises(services.OIDCEmailUnverified):
        services.resolve_user(
            provider, {"sub": "s", "email": "new@example.com", "email_verified": False}
        )


@pytest.mark.django_db
def test_resolve_domain_not_allowed_fails(provider: OIDCProvider) -> None:
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider, {"sub": "s", "email": "intruder@other.com", "email_verified": True}
        )


@pytest.mark.django_db
def test_resolve_auto_create(provider: OIDCProvider) -> None:
    resolved, created = services.resolve_user(
        provider,
        {
            "sub": "sub-new",
            "email": "carol@example.com",
            "email_verified": True,
            "given_name": "Carol",
        },
    )
    assert created is True
    assert resolved.email == "carol@example.com"
    # SSO-only account: no usable local password.
    assert resolved.has_usable_password() is False
    assert WorkspaceMembership.objects.filter(user=resolved, role=WorkspaceRole.MEMBER).exists()
    assert OIDCIdentity.objects.filter(user=resolved, subject="sub-new").exists()


@pytest.mark.django_db
def test_resolve_auto_create_disabled_fails(provider: OIDCProvider) -> None:
    provider.auto_create_members = False
    provider.save()
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider, {"sub": "s", "email": "nobody@example.com", "email_verified": True}
        )


# ---------------------------------------------------------------------------
# Extension seams — OSS defaults
# ---------------------------------------------------------------------------


def test_oidc_role_for_default_is_default_role() -> None:
    p = OIDCProvider(default_role=WorkspaceRole.MEMBER)
    assert extensions.oidc_role_for({"groups": ["admins"]}, p) == WorkspaceRole.MEMBER


def test_oidc_role_for_uses_registered_mapper() -> None:
    extensions.register_oidc_identity_mapper(lambda claims, cfg: WorkspaceRole.ADMIN)
    p = OIDCProvider(default_role=WorkspaceRole.MEMBER)
    assert extensions.oidc_role_for({}, p) == WorkspaceRole.ADMIN


def test_oidc_role_for_falls_back_on_raise() -> None:
    def _boom(claims: Any, cfg: Any) -> int:
        raise RuntimeError("buggy enterprise mapper")

    extensions.register_oidc_identity_mapper(_boom)
    p = OIDCProvider(default_role=WorkspaceRole.MEMBER)
    assert extensions.oidc_role_for({}, p) == WorkspaceRole.MEMBER


def test_local_login_allowed_default_true() -> None:
    assert extensions.local_login_allowed(object()) is True


def test_local_login_allowed_registered_can_block() -> None:
    extensions.register_local_login_policy_provider(lambda user: False)
    assert extensions.local_login_allowed(object()) is False


def test_local_login_allowed_fails_open_on_raise() -> None:
    def _boom(user: Any) -> bool:
        raise RuntimeError("buggy enterprise policy")

    extensions.register_local_login_policy_provider(_boom)
    # Fail OPEN — a broken enterprise policy must never lock everyone out.
    assert extensions.local_login_allowed(object()) is True
