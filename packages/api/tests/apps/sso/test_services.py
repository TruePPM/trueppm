"""Unit tests for the SSO service layer (ADR-0517 §3.2, supersedes ADR-0187 §2).

Covers the security-critical pure logic in isolation: PKCE/state single-use,
discovery validation, OIDC token exchange, ID-token signature/claim validation
(alg-confusion + replay defenses), the GitHub OAuth2 path (token exchange +
userinfo parsing + org restriction), identity resolution (durable key,
verified-email gate, account-linking, auto-create, fail-closed paths), and the two
at-rest controls: the client secret lives Fernet-encrypted on the policy side row
while ``SocialApp.secret`` stays empty (control 2), and every outbound call routes
through ``egress`` (control 1).
"""

from __future__ import annotations

import base64
import hashlib
import inspect
from typing import Any

import jwt
import pytest
from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from django.core.cache import cache

from trueppm_api.apps.sso import extensions, services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.models import WorkspaceMembership, WorkspaceRole

from .conftest import (
    CLIENT_ID,
    CLIENT_SECRET,
    ISSUER,
    discovery_doc,
    make_github_ctx,
    make_id_token,
    make_oidc_ctx,
    set_token_endpoint,
    stub_github_egress,
    unsaved_oidc_ctx,
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


# ---------------------------------------------------------------------------
# Control 1 — every outbound call is on egress (no requests/urllib in services)
# ---------------------------------------------------------------------------


def test_services_module_has_no_direct_http_client() -> None:
    """The service module must not import requests/urllib/httpx — all HTTP is egress.

    An un-stubbed or off-egress fetch is impossible because the only outbound path
    the module can reach is ``apps.integrations.http`` (which is itself the SSRF
    chokepoint). This asserts the structural invariant, not just a behavior.
    """
    source = inspect.getsource(services)
    for forbidden in ("import requests", "import httpx", "import urllib.request", "urllib.request"):
        assert forbidden not in source, f"services must not use {forbidden!r} — use egress"


# ---------------------------------------------------------------------------
# Control 2 — secret at rest: Fernet on the policy, SocialApp.secret empty
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_secret_stored_on_policy_socialapp_secret_empty(
    provider_ctx: services.ProviderContext,
) -> None:
    provider_ctx.policy.refresh_from_db()
    provider_ctx.social_app.refresh_from_db()
    # SocialApp.secret stays empty; the ciphertext lives on the policy and decrypts.
    assert provider_ctx.social_app.secret == ""
    assert provider_ctx.policy.secret_ciphertext  # non-empty ciphertext bytes
    assert provider_ctx.get_client_secret() == CLIENT_SECRET


# ---------------------------------------------------------------------------
# Provider resolution — fail closed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_provider_for_slug_none_when_disabled(provider_ctx: services.ProviderContext) -> None:
    provider_ctx.policy.enabled = False
    provider_ctx.policy.save()
    assert services.get_provider_for_slug("generic") is None


@pytest.mark.django_db
def test_get_provider_for_slug_none_without_secret() -> None:
    make_oidc_ctx(secret="")  # enabled but no stored secret → not usable
    assert services.get_provider_for_slug("generic") is None


@pytest.mark.django_db
def test_get_provider_for_slug_returns_complete(provider_ctx: services.ProviderContext) -> None:
    ctx = services.get_provider_for_slug("generic")
    assert ctx is not None
    assert ctx.slug == "generic"
    assert ctx.is_github is False


@pytest.mark.django_db
def test_get_enabled_providers_lists_all(provider_ctx: services.ProviderContext) -> None:
    make_github_ctx()
    slugs = {c.slug for c in services.get_enabled_providers()}
    assert slugs == {"generic", "github"}


@pytest.mark.django_db
def test_domain_matches_any_enabled(provider_ctx: services.ProviderContext) -> None:
    assert services.domain_matches_any_enabled("alice@example.com") is not None
    assert services.domain_matches_any_enabled("bob@other.com") is None
    assert services.domain_matches_any_enabled("noatsign") is None


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
    provider_ctx: services.ProviderContext, fake_discovery: None
) -> None:
    redirect_uri = "https://app.example.com/api/v1/auth/oidc/callback/"
    result = services.start_login(provider_ctx, redirect_uri=redirect_uri)

    assert result.authorization_url.startswith(f"{ISSUER}/authorize?")
    assert "code_challenge_method=S256" in result.authorization_url
    assert "response_type=code" in result.authorization_url
    stored = cache.get(services._STATE_KEY_PREFIX + result.state)
    assert stored is not None
    assert stored["slug"] == "generic"
    assert stored["redirect_uri"] == redirect_uri
    assert stored["verifier"] not in result.authorization_url
    assert stored["nonce"] in result.authorization_url  # nonce is sent to the IdP


@pytest.mark.django_db
def test_start_login_github_builds_authorize_url_no_discovery(
    github_ctx: services.ProviderContext,
) -> None:
    # GitHub has no OIDC discovery/PKCE/nonce; the authorize URL is a constant host.
    result = services.start_login(github_ctx, redirect_uri="https://app/cb/")
    assert result.authorization_url.startswith(services.GITHUB_AUTHORIZE_URL + "?")
    assert "code_challenge" not in result.authorization_url
    stored = cache.get(services._STATE_KEY_PREFIX + result.state)
    assert stored["slug"] == "github"
    assert "verifier" not in stored


@pytest.mark.django_db
def test_consume_state_is_single_use(
    provider_ctx: services.ProviderContext, fake_discovery: None
) -> None:
    result = services.start_login(provider_ctx, redirect_uri="https://app/cb/")
    first = services.consume_state(result.state)
    assert first["nonce"]
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
        doc["issuer"] = "https://evil.example.com"
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
    assert calls["n"] == 1


# ---------------------------------------------------------------------------
# OIDC token exchange
# ---------------------------------------------------------------------------


def test_exchange_code_returns_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    set_token_endpoint(monkeypatch, id_token="header.payload.sig")
    tokens = services.exchange_code(
        unsaved_oidc_ctx(), discovery_doc(), code="c", redirect_uri="https://app/cb/", verifier="v"
    )
    assert tokens["id_token"] == "header.payload.sig"


def test_exchange_code_oauth_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    set_token_endpoint(monkeypatch, status=400, error="invalid_grant")
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_code(
            unsaved_oidc_ctx(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


def test_exchange_code_missing_id_token_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    set_token_endpoint(monkeypatch, id_token=None, status=200)
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_code(
            unsaved_oidc_ctx(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


def test_exchange_code_uses_decrypted_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """The confidential-client secret sent to the token endpoint is the decrypted one."""
    captured: dict[str, Any] = {}

    from trueppm_api.apps.integrations import http as egress

    def _fake_post(url: str, *, data: dict[str, str], **kwargs: Any) -> egress.EgressResponse:
        captured.update(data)
        import json

        return egress.EgressResponse(
            status=200, body=json.dumps({"id_token": "a.b.c"}).encode(), headers={}
        )

    monkeypatch.setattr(services.egress, "post_form", _fake_post)
    services.exchange_code(
        unsaved_oidc_ctx(), discovery_doc(), code="c", redirect_uri="https://app/cb/", verifier="v"
    )
    assert captured["client_secret"] == CLIENT_SECRET
    assert captured["client_id"] == CLIENT_ID


# ---------------------------------------------------------------------------
# ID-token validation
# ---------------------------------------------------------------------------


def test_validate_id_token_happy(patch_jwks: None) -> None:
    token = make_id_token(nonce="n1")
    claims = services.validate_id_token(
        unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n1"
    )
    assert claims["sub"] == "idp-subject-1"
    assert claims["email"] == "alice@example.com"


def test_validate_id_token_nonce_mismatch(patch_jwks: None) -> None:
    token = make_id_token(nonce="n1")
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="different"
        )


def test_validate_id_token_wrong_audience(patch_jwks: None) -> None:
    token = make_id_token(aud="some-other-client")
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_wrong_issuer(patch_jwks: None) -> None:
    token = make_id_token(iss="https://evil.example.com")
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_expired(patch_jwks: None) -> None:
    import time

    token = make_id_token(extra={"exp": int(time.time()) - 10})
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_rejects_alg_none(patch_jwks: None) -> None:
    token = jwt.encode(
        {"sub": "x", "iss": ISSUER, "aud": CLIENT_ID, "nonce": "n0nce"}, None, algorithm="none"
    )
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
        )


def test_validate_id_token_rejects_hs256(patch_jwks: None) -> None:
    token = make_id_token(alg="HS256", key=CLIENT_SECRET)
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
        )


# ---------------------------------------------------------------------------
# GitHub OAuth2 path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_github_token_exchange_via_egress(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    from trueppm_api.apps.integrations import http as egress

    def _fake_post(url: str, *, data: dict[str, str], **kwargs: Any) -> egress.EgressResponse:
        captured["url"] = url
        captured.update(data)
        import json

        return egress.EgressResponse(
            status=200, body=json.dumps({"access_token": "gho_x"}).encode(), headers={}
        )

    monkeypatch.setattr(services.egress, "post_form", _fake_post)
    token = services.exchange_github_code(github_ctx, code="c", redirect_uri="https://app/cb/")
    assert token == "gho_x"
    assert captured["url"] == services.GITHUB_TOKEN_URL
    # The decrypted client secret is used, never a plaintext SocialApp column.
    from .conftest import GITHUB_CLIENT_SECRET

    assert captured["client_secret"] == GITHUB_CLIENT_SECRET


@pytest.mark.django_db
def test_github_identity_parses_verified_primary_email(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_github_egress(
        monkeypatch,
        user={"id": 42, "login": "octocat", "name": "Mona Cat"},
        emails=[
            {"email": "other@example.com", "primary": False, "verified": True},
            {"email": "mona@example.com", "primary": True, "verified": True},
        ],
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["sub"] == "42"  # numeric id as str — stable, never the login/email
    assert claims["email"] == "mona@example.com"
    assert claims["email_verified"] is True
    assert claims["given_name"] == "Mona"


@pytest.mark.django_db
def test_github_identity_unverified_primary_is_not_verified(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_github_egress(
        monkeypatch,
        user={"id": 7, "login": "u"},
        emails=[{"email": "u@example.com", "primary": True, "verified": False}],
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["email_verified"] is False


@pytest.mark.django_db
def test_github_org_restriction_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = make_github_ctx(org="acme")
    stub_github_egress(
        monkeypatch,
        user={"id": 9, "login": "outsider"},
        emails=[{"email": "outsider@example.com", "primary": True, "verified": True}],
        org_member=False,
    )
    with pytest.raises(services.OIDCNoMember):
        services.fetch_github_identity(ctx, "gho_x")


@pytest.mark.django_db
def test_github_org_restriction_allows_member(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = make_github_ctx(org="acme")
    stub_github_egress(
        monkeypatch,
        user={"id": 9, "login": "insider"},
        emails=[{"email": "insider@example.com", "primary": True, "verified": True}],
        org_member=True,
    )
    claims = services.fetch_github_identity(ctx, "gho_x")
    assert claims["sub"] == "9"


@pytest.mark.django_db
def test_github_uid_is_stable_numeric_id(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The login can change; the numeric id is the stable subject we bind on.
    stub_github_egress(
        monkeypatch,
        user={"id": 555, "login": "renamed-login"},
        emails=[{"email": "x@example.com", "primary": True, "verified": True}],
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["sub"] == "555"


# ---------------------------------------------------------------------------
# Domain allow-list
# ---------------------------------------------------------------------------


def test_domain_allowed_empty_fails_closed() -> None:
    p = SsoProviderPolicy(allowed_email_domains=[])
    assert services._domain_allowed(p, "alice@example.com") is False


def test_domain_allowed_matches_case_insensitive() -> None:
    p = SsoProviderPolicy(allowed_email_domains=["example.com"])
    assert services._domain_allowed(p, "Alice@Example.COM") is True
    assert services._domain_allowed(p, "alice@other.com") is False


# ---------------------------------------------------------------------------
# Identity resolution (shared by OIDC + GitHub)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolve_durable_identity_wins(provider_ctx: services.ProviderContext) -> None:
    user = User.objects.create_user(username="existing", email="x@example.com", password="pw")
    SocialAccount.objects.create(
        user=user, provider="generic", uid="sub-1", extra_data={"iss": ISSUER}
    )
    # Even with no email in the claims, the durable (issuer, sub) binding resolves.
    resolved, created = services.resolve_user(provider_ctx, {"sub": "sub-1"})
    assert resolved == user
    assert created is False


@pytest.mark.django_db
def test_resolve_cross_issuer_sub_collision_fails_closed(
    provider_ctx: services.ProviderContext,
) -> None:
    """A (slug, sub) binding under a DIFFERENT issuer must not resolve to that user.

    The provider slug's ``server_url`` (issuer) is mutable; an admin repointing it to
    a new issuer must not let a user at the new issuer whose ``sub`` collides with an
    old binding take over the old user's account — the durable key is (issuer, sub),
    enforced on resolve. Here the stored binding is under issuer-A but ``provider_ctx``
    is issuer ``ISSUER``, so resolution must fail closed, not return victim.
    """
    victim = User.objects.create_user(username="victim", email="v@example.com", password="pw")
    SocialAccount.objects.create(
        user=victim,
        provider="generic",
        uid="shared-sub",
        extra_data={"iss": "https://issuer-a.example.com"},
    )
    # A verified, in-domain login at the *current* (different) issuer with the same sub.
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider_ctx,
            {"sub": "shared-sub", "email": "attacker@example.com", "email_verified": True},
        )
    # The victim's binding is untouched and no new binding was minted for the attacker.
    assert SocialAccount.objects.get(uid="shared-sub").user == victim


@pytest.mark.django_db
def test_resolve_github_durable_binding_matches_constant_issuer(
    github_ctx: services.ProviderContext,
) -> None:
    """GitHub has no OIDC issuer; the fixed GITHUB_ISSUER is stored AND compared.

    Proves bind-time and resolve-time use the same constant, so a returning GitHub
    user resolves by their stable numeric id (never re-verifying email).
    """
    user = User.objects.create_user(username="gh", email="gh@example.com", password="pw")
    SocialAccount.objects.create(
        user=user, provider="github", uid="42", extra_data={"iss": services.GITHUB_ISSUER}
    )
    resolved, created = services.resolve_user(github_ctx, {"sub": "42"})
    assert resolved == user
    assert created is False


@pytest.mark.django_db
def test_resolve_links_single_existing_account(provider_ctx: services.ProviderContext) -> None:
    user = User.objects.create_user(username="bob", email="bob@example.com", password="pw")
    resolved, created = services.resolve_user(
        provider_ctx, {"sub": "sub-bob", "email": "bob@example.com", "email_verified": True}
    )
    assert resolved == user
    assert created is False
    assert SocialAccount.objects.filter(user=user, provider="generic", uid="sub-bob").exists()


@pytest.mark.django_db
def test_resolve_ambiguous_email_fails_closed(provider_ctx: services.ProviderContext) -> None:
    User.objects.create_user(username="c1", email="dup@example.com", password="pw")
    User.objects.create_user(username="c2", email="dup@example.com", password="pw")
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider_ctx, {"sub": "s", "email": "dup@example.com", "email_verified": True}
        )


@pytest.mark.django_db
def test_resolve_unverified_email_fails(provider_ctx: services.ProviderContext) -> None:
    with pytest.raises(services.OIDCEmailUnverified):
        services.resolve_user(
            provider_ctx, {"sub": "s", "email": "new@example.com", "email_verified": False}
        )


@pytest.mark.django_db
def test_resolve_domain_not_allowed_fails(provider_ctx: services.ProviderContext) -> None:
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider_ctx, {"sub": "s", "email": "intruder@other.com", "email_verified": True}
        )


@pytest.mark.django_db
def test_resolve_auto_create(provider_ctx: services.ProviderContext) -> None:
    resolved, created = services.resolve_user(
        provider_ctx,
        {
            "sub": "sub-new",
            "email": "carol@example.com",
            "email_verified": True,
            "given_name": "Carol",
        },
    )
    assert created is True
    assert resolved.email == "carol@example.com"
    assert resolved.has_usable_password() is False
    assert WorkspaceMembership.objects.filter(user=resolved, role=WorkspaceRole.MEMBER).exists()
    account = SocialAccount.objects.get(user=resolved, provider="generic", uid="sub-new")
    assert account.extra_data == {"iss": ISSUER}


@pytest.mark.django_db
def test_resolve_auto_create_disabled_fails(provider_ctx: services.ProviderContext) -> None:
    provider_ctx.policy.auto_create_members = False
    provider_ctx.policy.save()
    with pytest.raises(services.OIDCNoMember):
        services.resolve_user(
            provider_ctx, {"sub": "s", "email": "nobody@example.com", "email_verified": True}
        )


@pytest.mark.django_db
def test_resolve_github_binds_under_github_provider(
    github_ctx: services.ProviderContext,
) -> None:
    resolved, created = services.resolve_user(
        github_ctx,
        {"sub": "12345", "email": "gh@example.com", "email_verified": True, "given_name": "G"},
    )
    assert created is True
    account = SocialAccount.objects.get(provider="github", uid="12345")
    assert account.user == resolved
    assert account.extra_data == {"iss": services.GITHUB_ISSUER}


# ---------------------------------------------------------------------------
# Extension seams — OSS defaults
# ---------------------------------------------------------------------------


def test_oidc_role_for_default_is_default_role() -> None:
    p = SsoProviderPolicy(default_role=WorkspaceRole.MEMBER)
    assert extensions.oidc_role_for({"groups": ["admins"]}, p) == WorkspaceRole.MEMBER


def test_oidc_role_for_uses_registered_mapper() -> None:
    extensions.register_oidc_identity_mapper(lambda claims, cfg: WorkspaceRole.ADMIN)
    p = SsoProviderPolicy(default_role=WorkspaceRole.MEMBER)
    assert extensions.oidc_role_for({}, p) == WorkspaceRole.ADMIN


def test_oidc_role_for_falls_back_on_raise() -> None:
    def _boom(claims: Any, cfg: Any) -> int:
        raise RuntimeError("buggy enterprise mapper")

    extensions.register_oidc_identity_mapper(_boom)
    p = SsoProviderPolicy(default_role=WorkspaceRole.MEMBER)
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
    assert extensions.local_login_allowed(object()) is True
