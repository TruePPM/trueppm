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
    # Expired by more than ``_ID_TOKEN_LEEWAY_SECONDS`` (#2875): validation now
    # allows a minute of clock skew, so a token 10 s past ``exp`` is deliberately
    # still accepted and would no longer exercise the expiry branch.
    import time

    token = make_id_token(extra={"exp": int(time.time()) - services._ID_TOKEN_LEEWAY_SECONDS - 10})
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


# ---------------------------------------------------------------------------
# Error taxonomy — OIDCError carries a stable machine code + HTTP status
# ---------------------------------------------------------------------------


def test_oidc_error_defaults_come_from_the_class() -> None:
    """A bare ``OIDCError`` reports the class-level code and status."""
    exc = services.OIDCError()
    assert exc.code == "oidc_error"
    assert exc.http_status == 400
    assert str(exc) == "oidc_error"


def test_oidc_error_overrides_code_and_status() -> None:
    """Explicit ``code`` / ``http_status`` override the class defaults per-instance."""
    exc = services.OIDCError("boom", code="custom_code", http_status=418)
    assert exc.code == "custom_code"
    assert exc.http_status == 418
    assert str(exc) == "boom"
    # The override is instance-scoped — the class default is untouched.
    assert services.OIDCError.code == "oidc_error"


def test_oidc_error_subclass_codes_are_stable() -> None:
    """The SPA-facing codes are part of the contract; pin them."""
    assert (services.OIDCNotConfigured.code, services.OIDCNotConfigured.http_status) == (
        "sso_not_configured",
        400,
    )
    assert (services.OIDCEmailUnverified.code, services.OIDCEmailUnverified.http_status) == (
        "email_unverified",
        403,
    )
    assert (services.OIDCNoMember.code, services.OIDCNoMember.http_status) == ("sso_no_member", 403)
    assert (services.OIDCAccountDisabled.code, services.OIDCAccountDisabled.http_status) == (
        "sso_account_disabled",
        403,
    )
    assert (
        services.OIDCProviderUnreachable.code,
        services.OIDCProviderUnreachable.http_status,
    ) == ("provider_unreachable", 502)


# ---------------------------------------------------------------------------
# Egress response helpers for the failure-path tests
# ---------------------------------------------------------------------------


def _egress_response(status: int = 200, *, payload: Any = None, body: bytes | None = None) -> Any:
    """Build an :class:`EgressResponse` from a JSON payload or a raw body."""
    import json

    from trueppm_api.apps.integrations import http as egress

    if body is None:
        body = json.dumps(payload if payload is not None else {}).encode()
    return egress.EgressResponse(status=status, body=body, headers={})


def _raiser(exc: Exception) -> Any:
    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise exc

    return _boom


# ---------------------------------------------------------------------------
# Discovery — every rejection path (a malformed or hostile IdP fails closed)
# ---------------------------------------------------------------------------


def test_discovery_non_200_raises_provider_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(services.egress, "get", lambda url, **kw: _egress_response(503))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.get_discovery_document(ISSUER)


def test_discovery_timeout_raises_provider_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "get", _raiser(egress.EgressTimeout("slow idp")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.get_discovery_document(ISSUER)


def test_discovery_transport_error_raises_provider_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "get", _raiser(egress.EgressError("connection reset")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.get_discovery_document(ISSUER)


def test_discovery_non_json_body_raises_id_token_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 200 carrying an HTML login page is not a discovery document."""
    monkeypatch.setattr(
        services.egress, "get", lambda url, **kw: _egress_response(200, body=b"<html>hi</html>")
    )
    with pytest.raises(services.OIDCIDTokenError):
        services.get_discovery_document(ISSUER)


@pytest.mark.parametrize("missing", ["authorization_endpoint", "token_endpoint", "jwks_uri"])
def test_discovery_missing_required_endpoint_raises(
    monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    doc = discovery_doc()
    doc.pop(missing)
    monkeypatch.setattr(services.egress, "get", lambda url, **kw: _egress_response(payload=doc))
    with pytest.raises(services.OIDCIDTokenError):
        services.get_discovery_document(ISSUER)


def test_discovery_failure_is_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """A rejected document must never poison the cache for the next attempt."""
    monkeypatch.setattr(services.egress, "get", lambda url, **kw: _egress_response(503))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.get_discovery_document(ISSUER)
    assert cache.get(services._DISCOVERY_KEY_PREFIX + ISSUER) is None


# ---------------------------------------------------------------------------
# State — the empty-state branch is distinct from "unknown state"
# ---------------------------------------------------------------------------


def test_consume_state_empty_string_raises() -> None:
    """A callback with no ``state`` at all fails closed (CSRF defense)."""
    with pytest.raises(services.OIDCStateError):
        services.consume_state("")


# ---------------------------------------------------------------------------
# OIDC token exchange — transport + malformed-body failures
# ---------------------------------------------------------------------------


def test_exchange_code_ssrf_block_raises_provider_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(
        services.egress, "post_form", _raiser(egress.EgressBlocked("private address"))
    )
    with pytest.raises(services.OIDCProviderUnreachable):
        services.exchange_code(
            unsaved_oidc_ctx(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


def test_exchange_code_timeout_raises_provider_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "post_form", _raiser(egress.EgressTimeout("timed out")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.exchange_code(
            unsaved_oidc_ctx(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


def test_exchange_code_non_json_body_raises_token_exchange_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        services.egress,
        "post_form",
        lambda url, **kw: _egress_response(200, body=b"not json at all"),
    )
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_code(
            unsaved_oidc_ctx(),
            discovery_doc(),
            code="c",
            redirect_uri="https://app/cb/",
            verifier="v",
        )


# ---------------------------------------------------------------------------
# JWKS retrieval — the key-selection path is a security boundary
# ---------------------------------------------------------------------------


def _jwks_only(monkeypatch: pytest.MonkeyPatch, response: Any) -> None:
    """Serve ``response`` for the JWKS fetch and no-op the SSRF pre-check."""
    monkeypatch.setattr(services.egress, "get", lambda url, **kw: response)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)


def test_signing_key_ssrf_block_raises_provider_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(
        services.egress, "assert_url_allowed", _raiser(egress.EgressBlocked("blocked jwks host"))
    )
    with pytest.raises(services.OIDCProviderUnreachable):
        services._signing_key_for(f"{ISSUER}/jwks", make_id_token())


def test_signing_key_timeout_raises_provider_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    monkeypatch.setattr(services.egress, "get", _raiser(egress.EgressTimeout("slow jwks")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services._signing_key_for(f"{ISSUER}/jwks", make_id_token())


def test_signing_key_non_200_raises_provider_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    _jwks_only(monkeypatch, _egress_response(500))
    with pytest.raises(services.OIDCProviderUnreachable):
        services._signing_key_for(f"{ISSUER}/jwks", make_id_token())


@pytest.mark.parametrize("document", [{}, {"keys": []}])
def test_signing_key_empty_jwks_raises_id_token_error(
    monkeypatch: pytest.MonkeyPatch, document: dict[str, Any]
) -> None:
    _jwks_only(monkeypatch, _egress_response(payload=document))
    with pytest.raises(services.OIDCIDTokenError):
        services._signing_key_for(f"{ISSUER}/jwks", make_id_token())


def test_signing_key_unusable_jwks_raises_id_token_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A JWKS whose entries cannot be parsed is an IdP/config error, not a 502."""
    _jwks_only(monkeypatch, _egress_response(payload={"keys": [{"kty": "NOPE"}]}))
    with pytest.raises(services.OIDCIDTokenError):
        services._signing_key_for(f"{ISSUER}/jwks", make_id_token())


def test_signing_key_unparseable_token_header_raises_id_token_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from .conftest import JWKS

    _jwks_only(monkeypatch, _egress_response(payload=JWKS))
    with pytest.raises(services.OIDCIDTokenError):
        services._signing_key_for(f"{ISSUER}/jwks", "this-is-not-a-jwt")


def test_signing_key_unknown_kid_raises_id_token_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A token whose ``kid`` names no key in the JWKS must not fall back to key[0]."""
    from .conftest import JWKS

    _jwks_only(monkeypatch, _egress_response(payload=JWKS))
    token = jwt.encode({"sub": "x"}, "irrelevant", algorithm="HS256", headers={"kid": "unknown"})
    with pytest.raises(services.OIDCIDTokenError):
        services._signing_key_for(f"{ISSUER}/jwks", token)


def test_validate_id_token_surfaces_jwks_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """The JWKS failure propagates out of ``validate_id_token`` unchanged."""
    _jwks_only(monkeypatch, _egress_response(payload={"keys": []}))
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), make_id_token(), expected_nonce="n0nce"
        )


def test_validate_id_token_empty_expected_nonce_fails(patch_jwks: None) -> None:
    """An absent stored nonce can never satisfy the replay check."""
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), make_id_token(nonce=""), expected_nonce=""
        )


# ---------------------------------------------------------------------------
# GitHub token exchange — transport + protocol failures
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_github_exchange_ssrf_block_raises_provider_unreachable(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "post_form", _raiser(egress.EgressBlocked("blocked")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.exchange_github_code(github_ctx, code="c", redirect_uri="https://app/cb/")


@pytest.mark.django_db
def test_github_exchange_timeout_raises_provider_unreachable(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "post_form", _raiser(egress.EgressTimeout("timed out")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.exchange_github_code(github_ctx, code="c", redirect_uri="https://app/cb/")


@pytest.mark.django_db
def test_github_exchange_non_json_body_raises(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        services.egress, "post_form", lambda url, **kw: _egress_response(200, body=b"<html>")
    )
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_github_code(github_ctx, code="c", redirect_uri="https://app/cb/")


@pytest.mark.django_db
def test_github_exchange_oauth_error_raises(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GitHub answers 200 with an ``error`` body on a bad code — still a failure."""
    monkeypatch.setattr(
        services.egress,
        "post_form",
        lambda url, **kw: _egress_response(200, payload={"error": "bad_verification_code"}),
    )
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_github_code(github_ctx, code="c", redirect_uri="https://app/cb/")


@pytest.mark.django_db
def test_github_exchange_missing_access_token_raises(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        services.egress, "post_form", lambda url, **kw: _egress_response(200, payload={"ok": True})
    )
    with pytest.raises(services.OIDCTokenExchangeError):
        services.exchange_github_code(github_ctx, code="c", redirect_uri="https://app/cb/")


# ---------------------------------------------------------------------------
# GitHub user API — transport + malformed-profile failures
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_github_identity_ssrf_block_raises_provider_unreachable(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "get", _raiser(egress.EgressBlocked("blocked")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.fetch_github_identity(github_ctx, "gho_x")


@pytest.mark.django_db
def test_github_identity_timeout_raises_provider_unreachable(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "get", _raiser(egress.EgressTimeout("timed out")))
    with pytest.raises(services.OIDCProviderUnreachable):
        services.fetch_github_identity(github_ctx, "gho_x")


@pytest.mark.django_db
def test_github_identity_user_endpoint_error_status_raises(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_github_egress(monkeypatch, user={"id": 1}, user_status=401)
    with pytest.raises(services.OIDCTokenExchangeError):
        services.fetch_github_identity(github_ctx, "gho_x")


@pytest.mark.django_db
def test_github_identity_profile_without_id_raises(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_github_egress(monkeypatch, user={"login": "no-id-here"})
    with pytest.raises(services.OIDCIDTokenError):
        services.fetch_github_identity(github_ctx, "gho_x")


@pytest.mark.django_db
def test_github_identity_falls_back_to_profile_email_unverified(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When ``/user/emails`` is unavailable the public email is reported unverified."""
    stub_github_egress(
        monkeypatch,
        user={"id": 3, "login": "u", "email": "public@example.com"},
        emails_status=404,
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["email"] == "public@example.com"
    assert claims["email_verified"] is False


@pytest.mark.django_db
def test_github_identity_no_primary_entry_falls_back(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 200 emails list with no ``primary`` entry is not an authoritative answer."""
    stub_github_egress(
        monkeypatch,
        user={"id": 4, "login": "u", "email": "public@example.com"},
        emails=[{"email": "secondary@example.com", "primary": False, "verified": True}],
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["email"] == "public@example.com"
    assert claims["email_verified"] is False


@pytest.mark.django_db
def test_github_identity_splits_full_name(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_github_egress(
        monkeypatch,
        user={"id": 5, "login": "u", "name": "Ada Byron Lovelace"},
        emails=[{"email": "ada@example.com", "primary": True, "verified": True}],
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["given_name"] == "Ada"
    assert claims["family_name"] == "Byron Lovelace"


@pytest.mark.django_db
def test_github_identity_without_name_yields_empty_name_claims(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_github_egress(
        monkeypatch,
        user={"id": 6, "login": "u"},
        emails=[{"email": "u@example.com", "primary": True, "verified": True}],
    )
    claims = services.fetch_github_identity(github_ctx, "gho_x")
    assert claims["given_name"] == ""
    assert claims["family_name"] == ""


# ---------------------------------------------------------------------------
# Identity resolution — subject gate + username collision
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolve_without_subject_raises(provider_ctx: services.ProviderContext) -> None:
    """No ``sub`` means no durable key — the flow must not fall back to email."""
    with pytest.raises(services.OIDCIDTokenError):
        services.resolve_user(provider_ctx, {"email": "alice@example.com", "email_verified": True})
    assert not SocialAccount.objects.exists()


@pytest.mark.django_db
def test_auto_create_username_collision_gets_suffix(
    provider_ctx: services.ProviderContext,
) -> None:
    """A taken local-part username never blocks (or silently reuses) an SSO join."""
    User.objects.create_user(username="carol", email="carol@other.example", password="pw")
    resolved, created = services.resolve_user(
        provider_ctx,
        {"sub": "sub-collide", "email": "carol@example.com", "email_verified": True},
    )
    assert created is True
    assert resolved.username != "carol"
    assert resolved.username.startswith("carol-")
    assert User.objects.filter(username="carol").count() == 1


# ---------------------------------------------------------------------------
# Test connection (admin "Test connection" button)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_check_reachability_oidc_ok(
    provider_ctx: services.ProviderContext, patch_jwks: None
) -> None:
    result = services.check_provider_reachability(provider_ctx)
    assert result["ok"] is True
    assert result["issuer"] == ISSUER
    assert result["endpoints"]["token_endpoint"] == f"{ISSUER}/token"
    assert result["endpoints"]["jwks_uri"] == f"{ISSUER}/jwks"


@pytest.mark.django_db
def test_check_reachability_oidc_discovery_failure_reports_code(
    provider_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A discovery failure never raises — it becomes a structured ``ok: False``."""
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(services.egress, "get", _raiser(egress.EgressBlocked("private host")))
    result = services.check_provider_reachability(provider_ctx)
    assert result["ok"] is False
    assert result["error"] == services.OIDCProviderUnreachable.code
    assert result["detail"]


@pytest.mark.django_db
def test_check_reachability_oidc_jwks_unreachable(
    provider_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    from trueppm_api.apps.integrations import http as egress

    def _get(url: str, **kwargs: Any) -> Any:
        if url.endswith("/.well-known/openid-configuration"):
            return _egress_response(payload=json.loads(json.dumps(discovery_doc())))
        raise egress.EgressTimeout("jwks timed out")

    monkeypatch.setattr(services.egress, "get", _get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    result = services.check_provider_reachability(provider_ctx)
    assert result["ok"] is False
    assert result["error"] == "jwks_unreachable"


@pytest.mark.django_db
def test_check_reachability_oidc_jwks_empty(
    provider_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _get(url: str, **kwargs: Any) -> Any:
        if url.endswith("/.well-known/openid-configuration"):
            return _egress_response(payload=discovery_doc())
        return _egress_response(payload={"keys": []})

    monkeypatch.setattr(services.egress, "get", _get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    result = services.check_provider_reachability(provider_ctx)
    assert result["ok"] is False
    assert result["error"] == "jwks_empty"


@pytest.mark.django_db
def test_check_reachability_oidc_jwks_non_200_is_empty(
    provider_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-200 JWKS is indistinguishable from an empty one for the probe."""

    def _get(url: str, **kwargs: Any) -> Any:
        if url.endswith("/.well-known/openid-configuration"):
            return _egress_response(payload=discovery_doc())
        return _egress_response(500)

    monkeypatch.setattr(services.egress, "get", _get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    result = services.check_provider_reachability(provider_ctx)
    assert result["ok"] is False
    assert result["error"] == "jwks_empty"


@pytest.mark.django_db
def test_check_reachability_oidc_bypasses_the_discovery_cache(
    provider_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ "Test connection" must re-fetch, or an admin's fix looks like it did nothing."""
    cache.set(services._DISCOVERY_KEY_PREFIX + ISSUER, {"issuer": "stale"}, 300)
    calls = {"n": 0}

    def _get(url: str, **kwargs: Any) -> Any:
        calls["n"] += 1
        if url.endswith("/.well-known/openid-configuration"):
            return _egress_response(payload=discovery_doc())
        from .conftest import JWKS

        return _egress_response(payload=JWKS)

    monkeypatch.setattr(services.egress, "get", _get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    result = services.check_provider_reachability(provider_ctx)
    assert result["ok"] is True
    assert calls["n"] == 2  # discovery re-fetched despite the pre-seeded cache, then jwks


@pytest.mark.django_db
@pytest.mark.parametrize("status", [200, 401])
def test_check_reachability_github_ok(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    """An unauthenticated 401 still proves the GitHub API host is reachable."""
    monkeypatch.setattr(services.egress, "get", lambda url, **kw: _egress_response(status))
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    result = services.check_provider_reachability(github_ctx)
    assert result["ok"] is True
    assert result["issuer"] == services.GITHUB_ISSUER
    assert result["endpoints"]["token_endpoint"] == services.GITHUB_TOKEN_URL
    assert result["endpoints"]["jwks_uri"] == ""


@pytest.mark.django_db
def test_check_reachability_github_unexpected_status_is_failure(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(services.egress, "get", lambda url, **kw: _egress_response(503))
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    result = services.check_provider_reachability(github_ctx)
    assert result["ok"] is False
    assert result["error"] == "github_unreachable"
    assert "detail" not in result


@pytest.mark.django_db
def test_check_reachability_github_blocked_reports_detail(
    github_ctx: services.ProviderContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.integrations import http as egress

    monkeypatch.setattr(
        services.egress, "assert_url_allowed", _raiser(egress.EgressBlocked("blocked host"))
    )
    result = services.check_provider_reachability(github_ctx)
    assert result["ok"] is False
    assert result["error"] == "github_unreachable"
    assert "blocked host" in result["detail"]


# ---------------------------------------------------------------------------
# JWKS caching + kid-miss refetch (#2875 item 3)
# ---------------------------------------------------------------------------


def _counting_jwks(monkeypatch: pytest.MonkeyPatch, documents: list[Any]) -> list[str]:
    """Serve ``documents`` in order for successive JWKS fetches; return a call log.

    The last document is repeated once exhausted, so a test can assert "no further
    request happened" by checking the log length rather than by exhausting a stub.
    """
    calls: list[str] = []

    def _get(url: str, **kwargs: Any) -> Any:
        calls.append(url)
        index = min(len(calls) - 1, len(documents) - 1)
        return _egress_response(payload=documents[index])

    monkeypatch.setattr(services.egress, "get", _get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)
    return calls


def test_jwks_is_cached_across_logins(monkeypatch: pytest.MonkeyPatch) -> None:
    """One outbound JWKS fetch, not one per sign-in (#2875)."""
    from .conftest import JWKS

    calls = _counting_jwks(monkeypatch, [JWKS])
    token = make_id_token()
    for _ in range(3):
        services._signing_key_for(f"{ISSUER}/jwks", token)
    assert len(calls) == 1


def test_jwks_refetched_once_when_the_cached_document_lacks_the_kid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rotated ``kid`` must trigger a refetch, not fail until the TTL expires."""
    from .conftest import JWKS

    stale = {"keys": [{**JWKS["keys"][0], "kid": "old-key"}]}
    calls = _counting_jwks(monkeypatch, [stale, JWKS])
    # The token must name a ``kid`` or the selector matches any signing key and the
    # rotation is invisible. Only the unverified header is read here, so an HS256
    # envelope is enough (same technique as the unknown-kid test above).
    rotated = jwt.encode({"sub": "x"}, "irrelevant", algorithm="HS256", headers={"kid": "test-key"})
    pre_rotation = jwt.encode(
        {"sub": "x"}, "irrelevant", algorithm="HS256", headers={"kid": "old-key"}
    )

    # Warm the cache with the pre-rotation document (one fetch, no retry: cold).
    assert services._signing_key_for(f"{ISSUER}/jwks", pre_rotation).key_id == "old-key"
    assert len(calls) == 1

    # Now the IdP has rotated. The cached document misses, so exactly one refetch.
    key = services._signing_key_for(f"{ISSUER}/jwks", rotated)
    assert key.key_id == "test-key"
    assert len(calls) == 2


def test_jwks_kid_miss_on_a_cold_cache_does_not_double_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The document just fetched IS current — retrying would re-request the same bytes.

    This also bounds the outbound cost of replaying an unknown ``kid``: one request,
    not two, per attempt on a cold cache.
    """
    from .conftest import JWKS

    calls = _counting_jwks(monkeypatch, [JWKS])
    token = jwt.encode({"sub": "x"}, "irrelevant", algorithm="HS256", headers={"kid": "nope"})
    with pytest.raises(services.OIDCIDTokenError):
        services._signing_key_for(f"{ISSUER}/jwks", token)
    assert len(calls) == 1


def test_jwks_cache_is_keyed_per_uri(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two providers must not share one cached key set."""
    from .conftest import JWKS

    calls = _counting_jwks(monkeypatch, [JWKS])
    token = make_id_token()
    services._signing_key_for(f"{ISSUER}/jwks", token)
    services._signing_key_for("https://other.example.com/jwks", token)
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# Clock-skew leeway (#2875 item 4)
# ---------------------------------------------------------------------------


def test_validate_id_token_tolerates_an_idp_clock_slightly_ahead(patch_jwks: None) -> None:
    """``iat``/``nbf`` in the near future is clock skew, not an attack (#2875).

    With PyJWT's default ``leeway=0`` this raised ImmatureSignatureError and the user
    saw an undiagnosable failure against a correctly configured IdP.
    """
    import time

    now = int(time.time())
    token = make_id_token(extra={"iat": now + 20, "nbf": now + 20, "exp": now + 300})
    claims = services.validate_id_token(
        unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
    )
    assert claims["sub"] == "idp-subject-1"


def test_validate_id_token_still_rejects_a_clock_beyond_the_leeway(patch_jwks: None) -> None:
    import time

    now = int(time.time())
    skew = services._ID_TOKEN_LEEWAY_SECONDS + 30
    token = make_id_token(extra={"iat": now + skew, "nbf": now + skew, "exp": now + 300 + skew})
    with pytest.raises(services.OIDCIDTokenError):
        services.validate_id_token(
            unsaved_oidc_ctx(), discovery_doc(), token, expected_nonce="n0nce"
        )


# ---------------------------------------------------------------------------
# is_active on the SSO path (#2875 item 1)
# ---------------------------------------------------------------------------


def _sso_only_user(*, email: str = "alice@example.com", active: bool = True) -> Any:
    user = User.objects.create(username=email.split("@")[0], email=email, is_active=active)
    user.set_unusable_password()
    user.save(update_fields=["password"])
    return user


@pytest.mark.django_db
def test_resolve_user_refuses_a_deactivated_durable_binding() -> None:
    """The SSO callback was the only login path that never consulted ``is_active``."""
    ctx = make_oidc_ctx()
    user = _sso_only_user(active=False)
    SocialAccount.objects.create(
        user=user, provider="generic", uid="sub-1", extra_data={"iss": ISSUER}
    )
    with pytest.raises(services.OIDCAccountDisabled):
        services.resolve_user(ctx, {"sub": "sub-1", "email": user.email, "email_verified": True})


@pytest.mark.django_db
def test_resolve_user_refuses_a_deactivated_account_on_the_email_link_path() -> None:
    """Branch 3 (link by verified email) must refuse too — and write no binding."""
    ctx = make_oidc_ctx()
    user = _sso_only_user(active=False)
    with pytest.raises(services.OIDCAccountDisabled):
        services.resolve_user(ctx, {"sub": "sub-new", "email": user.email, "email_verified": True})
    assert not SocialAccount.objects.filter(uid="sub-new").exists()


@pytest.mark.django_db
def test_resolve_user_admits_a_reactivated_account() -> None:
    """The refusal tracks the flag, so reactivation restores SSO login with no extra step."""
    ctx = make_oidc_ctx()
    user = _sso_only_user(active=False)
    SocialAccount.objects.create(
        user=user, provider="generic", uid="sub-1", extra_data={"iss": ISSUER}
    )
    user.is_active = True
    user.save(update_fields=["is_active"])
    resolved, created = services.resolve_user(
        ctx, {"sub": "sub-1", "email": user.email, "email_verified": True}
    )
    assert resolved.pk == user.pk
    assert created is False


def test_account_disabled_code_is_distinct_from_no_member() -> None:
    """The two need different remedies, so they must not collapse into one code.

    Reusing ``sso_no_member`` would tell a deactivated member to ask for an invite
    they already have. (The exact spelling is pinned in the contract test above.)
    """
    assert services.OIDCAccountDisabled.code != services.OIDCNoMember.code
    assert issubclass(services.OIDCAccountDisabled, services.OIDCError)


# ---------------------------------------------------------------------------
# Removal impact (#2874 B)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_removal_impact_counts_only_credential_less_sole_bindings() -> None:
    make_oidc_ctx()
    jit = _sso_only_user(email="jit@example.com")
    SocialAccount.objects.create(user=jit, provider="generic", uid="a", extra_data={"iss": ISSUER})
    with_password = User.objects.create_user(
        username="pw", email="pw@example.com", password="long-enough-9"
    )
    SocialAccount.objects.create(
        user=with_password, provider="generic", uid="b", extra_data={"iss": ISSUER}
    )

    impact = services.removal_impact(["generic"])["generic"]
    assert impact.linked_accounts == 2
    assert impact.locked_out_accounts == 1


@pytest.mark.django_db
def test_removal_impact_spares_a_user_bound_to_a_second_configured_provider() -> None:
    """A surviving binding to another configured provider IS another way in."""
    make_oidc_ctx()
    make_github_ctx()
    jit = _sso_only_user(email="jit@example.com")
    SocialAccount.objects.create(user=jit, provider="generic", uid="a", extra_data={"iss": ISSUER})
    SocialAccount.objects.create(
        user=jit, provider="github", uid="7", extra_data={"iss": services.GITHUB_ISSUER}
    )

    impact = services.removal_impact(["generic", "github"])
    assert impact["generic"].locked_out_accounts == 0
    assert impact["github"].locked_out_accounts == 0


@pytest.mark.django_db
def test_removal_impact_ignores_bindings_of_unconfigured_providers() -> None:
    """A leftover row for a provider that no longer exists is not a sign-in method."""
    make_oidc_ctx()
    jit = _sso_only_user(email="jit@example.com")
    SocialAccount.objects.create(user=jit, provider="generic", uid="a", extra_data={"iss": ISSUER})
    SocialAccount.objects.create(
        user=jit, provider="okta", uid="b", extra_data={"iss": "https://gone.example.com"}
    )
    assert services.removal_impact(["generic"])["generic"].locked_out_accounts == 1


@pytest.mark.django_db
def test_removal_impact_is_two_queries_for_any_number_of_providers(
    django_assert_num_queries: Any,
) -> None:
    """The admin list page must not scale its query count with the registry."""
    make_oidc_ctx()
    make_github_ctx()
    with django_assert_num_queries(2):
        services.removal_impact(["generic", "github"])


@pytest.mark.django_db
def test_removal_impact_of_no_slugs_queries_nothing(django_assert_num_queries: Any) -> None:
    with django_assert_num_queries(0):
        assert services.removal_impact([]) == {}
