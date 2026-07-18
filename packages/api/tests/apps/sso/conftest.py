"""Shared fixtures for the SSO tests (ADR-0517, supersedes ADR-0187 #1405).

The flow's outbound calls — OIDC discovery / token / JWKS, GitHub ``/user`` +
``/user/emails`` + org membership — all go through the ``apps/integrations/http``
egress chokepoint. ID-token verification fetches the JWKS through that same
chokepoint (never PyJWKClient's own socket — see ``services._signing_key_for``).
None of that may touch the network in a unit test, so the fixtures here provide:

* a real RSA keypair + an ``id_token`` factory that signs genuine RS256 JWTs;
* ``JWKS`` — the test public key in JWKS shape, served via the egress stub so
  ``validate_id_token`` resolves the real signing key and verifies the real
  signature; the SSRF check is turned into a no-op (no socket is opened);
* ``patch_jwks`` / ``fake_discovery`` / ``set_token_endpoint`` — monkeypatch the
  egress helpers so ``get`` / ``post_form`` return canned IdP responses;
* ``provider_ctx`` (openid_connect ``generic``) + ``github_ctx`` — a persisted
  ``SocialApp`` + ``SsoProviderPolicy`` wrapped in a ``ProviderContext``, replacing
  the ADR-0187 ``provider`` fixture.
"""

from __future__ import annotations

import json
from typing import Any

import jwt
import pytest
from allauth.socialaccount.models import SocialApp
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.contrib.auth import get_user_model
from jwt.algorithms import RSAAlgorithm
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.sso.services import ProviderContext
from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()

ISSUER = "https://idp.example.com"
CLIENT_ID = "trueppm-web"
CLIENT_SECRET = "s3cr3t-value"
ALLOWED_DOMAIN = "example.com"

GITHUB_CLIENT_ID = "gh-client-id"
GITHUB_CLIENT_SECRET = "gh-client-secret"

# One RSA keypair for the whole test module — 2048-bit generation is ~100ms, so
# generating it once at import keeps the suite fast. The private key signs the
# test ID tokens; the public key is what the patched JWKS client returns.
_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PRIVATE_PEM = _PRIVATE_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
_PUBLIC_KEY = _PRIVATE_KEY.public_key()

_PUBLIC_JWK: dict[str, Any] = json.loads(RSAAlgorithm.to_jwk(_PUBLIC_KEY))
_PUBLIC_JWK.update({"kid": "test-key", "use": "sig"})
JWKS: dict[str, Any] = {"keys": [_PUBLIC_JWK]}


def discovery_doc(issuer: str = ISSUER) -> dict[str, str]:
    """A minimal but valid OIDC discovery document for ``issuer``."""
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/authorize",
        "token_endpoint": f"{issuer}/token",
        "jwks_uri": f"{issuer}/jwks",
    }


def make_id_token(
    *,
    sub: str = "idp-subject-1",
    nonce: str = "n0nce",
    email: str | None = "alice@example.com",
    email_verified: bool | None = True,
    aud: str = CLIENT_ID,
    iss: str = ISSUER,
    alg: str = "RS256",
    key: Any = _PRIVATE_PEM,
    extra: dict[str, Any] | None = None,
    omit: tuple[str, ...] = (),
) -> str:
    """Sign a genuine ID token (RS256 by default) with the test key."""
    import time

    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": sub,
        "iss": iss,
        "aud": aud,
        "exp": now + 300,
        "iat": now,
        "nonce": nonce,
    }
    if email is not None:
        claims["email"] = email
    if email_verified is not None:
        claims["email_verified"] = email_verified
    if extra:
        claims.update(extra)
    for field in omit:
        claims.pop(field, None)
    return jwt.encode(claims, key, algorithm=alg)


# ---------------------------------------------------------------------------
# Provider builders
# ---------------------------------------------------------------------------


def _bind_site(app: SocialApp) -> None:
    app.sites.add(int(getattr(settings, "SITE_ID", 1)))


def make_oidc_ctx(
    *,
    enabled: bool = True,
    slug: str = "generic",
    issuer: str = ISSUER,
    client_id: str = CLIENT_ID,
    secret: str = CLIENT_SECRET,
    domains: list[str] | None = None,
    auto_create: bool = True,
    name: str = "Example IdP",
) -> ProviderContext:
    """Persist an openid_connect SocialApp + policy and return its ProviderContext."""
    app = SocialApp.objects.create(
        provider=services.ALLAUTH_OPENID_CONNECT,
        provider_id=slug,
        name=name,
        client_id=client_id,
        secret="",
        settings={"server_url": issuer},
    )
    _bind_site(app)
    policy = SsoProviderPolicy(
        social_app=app,
        workspace=Workspace.load(),
        slug=slug,
        enabled=enabled,
        allowed_email_domains=domains if domains is not None else [ALLOWED_DOMAIN],
        auto_create_members=auto_create,
    )
    if secret:
        policy.set_client_secret(secret)
    policy.save()
    return ProviderContext(social_app=app, policy=policy)


def make_github_ctx(
    *,
    enabled: bool = True,
    org: str = "",
    domains: list[str] | None = None,
    auto_create: bool = True,
    secret: str = GITHUB_CLIENT_SECRET,
) -> ProviderContext:
    """Persist a github SocialApp + policy and return its ProviderContext."""
    app = SocialApp.objects.create(
        provider=services.ALLAUTH_GITHUB,
        provider_id="github",
        name="GitHub",
        client_id=GITHUB_CLIENT_ID,
        secret="",
        settings={},
    )
    _bind_site(app)
    policy = SsoProviderPolicy(
        social_app=app,
        workspace=Workspace.load(),
        slug="github",
        enabled=enabled,
        allowed_email_domains=domains if domains is not None else [ALLOWED_DOMAIN],
        auto_create_members=auto_create,
        github_org=org,
    )
    if secret:
        policy.set_client_secret(secret)
    policy.save()
    return ProviderContext(social_app=app, policy=policy)


def unsaved_oidc_ctx() -> ProviderContext:
    """A ProviderContext whose rows are NOT persisted — for the pure token/validate paths."""
    app = SocialApp(
        provider=services.ALLAUTH_OPENID_CONNECT,
        provider_id="generic",
        name="Example IdP",
        client_id=CLIENT_ID,
        secret="",
        settings={"server_url": ISSUER},
    )
    policy = SsoProviderPolicy(slug="generic", allowed_email_domains=[ALLOWED_DOMAIN])
    policy.set_client_secret(CLIENT_SECRET)
    return ProviderContext(social_app=app, policy=policy)


@pytest.fixture
def provider_ctx(db: object) -> ProviderContext:
    """An enabled, fully-configured openid_connect (generic) provider."""
    return make_oidc_ctx()


@pytest.fixture
def github_ctx(db: object) -> ProviderContext:
    """An enabled, fully-configured GitHub OAuth2 provider."""
    return make_github_ctx()


# ---------------------------------------------------------------------------
# Egress stubs
# ---------------------------------------------------------------------------


@pytest.fixture
def patch_jwks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Serve discovery + the test JWKS through the egress stub (no network)."""

    def _fake_get(url: str, **kwargs: Any) -> egress.EgressResponse:
        if url.endswith("/.well-known/openid-configuration"):
            body = json.dumps(discovery_doc()).encode()
        elif url.endswith("/jwks"):
            body = json.dumps(JWKS).encode()
        else:  # pragma: no cover - defensive
            body = b"{}"
        return egress.EgressResponse(status=200, body=body, headers={})

    monkeypatch.setattr(services.egress, "get", _fake_get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)


@pytest.fixture
def fake_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub ``egress.get`` so discovery (and JWKS) return canned 200 responses."""

    def _fake_get(url: str, **kwargs: Any) -> egress.EgressResponse:
        if url.endswith("/.well-known/openid-configuration"):
            body = json.dumps(discovery_doc()).encode()
        elif url.endswith("/jwks"):
            body = json.dumps(JWKS).encode()
        else:  # pragma: no cover - defensive
            body = b"{}"
        return egress.EgressResponse(status=200, body=body, headers={})

    monkeypatch.setattr(services.egress, "get", _fake_get)


def set_token_endpoint(
    monkeypatch: pytest.MonkeyPatch,
    *,
    id_token: str | None = None,
    status: int = 200,
    error: str | None = None,
) -> None:
    """Stub ``egress.post_form`` so the OIDC token exchange returns a canned response."""

    def _fake_post(url: str, **kwargs: Any) -> egress.EgressResponse:
        payload: dict[str, Any] = {}
        if error is not None:
            payload["error"] = error
        if id_token is not None:
            payload["id_token"] = id_token
            payload["access_token"] = "opaque-access"
        return egress.EgressResponse(status=status, body=json.dumps(payload).encode(), headers={})

    monkeypatch.setattr(services.egress, "post_form", _fake_post)


def stub_github_egress(
    monkeypatch: pytest.MonkeyPatch,
    *,
    access_token: str | None = "gho_test_token",
    token_status: int = 200,
    token_error: str | None = None,
    user: dict[str, Any] | None = None,
    user_status: int = 200,
    emails: list[dict[str, Any]] | None = None,
    emails_status: int = 200,
    org_member: bool = True,
) -> None:
    """Stub every GitHub egress call (token POST + /user, /user/emails, org GET).

    Records nothing itself — the point is that all four calls route through
    ``egress`` so an un-stubbed one would raise. ``org_member`` controls the 204/404
    of the org-membership probe.
    """

    def _fake_post(url: str, **kwargs: Any) -> egress.EgressResponse:
        payload: dict[str, Any] = {}
        if token_error is not None:
            payload["error"] = token_error
        if access_token is not None:
            payload["access_token"] = access_token
            payload["token_type"] = "bearer"
        return egress.EgressResponse(
            status=token_status, body=json.dumps(payload).encode(), headers={}
        )

    def _fake_get(url: str, **kwargs: Any) -> egress.EgressResponse:
        if url == services.GITHUB_USER_URL:
            body = json.dumps(user if user is not None else {}).encode()
            return egress.EgressResponse(status=user_status, body=body, headers={})
        if url == services.GITHUB_EMAILS_URL:
            body = json.dumps(emails if emails is not None else []).encode()
            return egress.EgressResponse(status=emails_status, body=body, headers={})
        if "/orgs/" in url and "/members/" in url:
            return egress.EgressResponse(status=204 if org_member else 404, body=b"", headers={})
        return egress.EgressResponse(status=404, body=b"{}", headers={})  # pragma: no cover

    monkeypatch.setattr(services.egress, "post_form", _fake_post)
    monkeypatch.setattr(services.egress, "get", _fake_get)
    monkeypatch.setattr(services.egress, "assert_url_allowed", lambda url: None)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


@pytest.fixture
def admin(db: object) -> Any:
    """A real WorkspaceMembership at role ADMIN (not a superuser).

    Using an explicit ADMIN membership — rather than a superuser (implicit OWNER) —
    exercises the exact ``role == ADMIN passes`` / ``MEMBER fails`` boundary that
    ``IsWorkspaceAdminStrict`` enforces, so the RBAC tests prove the gate, not the
    superuser bypass.
    """
    from trueppm_api.apps.workspace.models import (
        MemberStatus,
        WorkspaceMembership,
        WorkspaceRole,
    )

    user = User.objects.create_user(username="sso_admin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(),
        user=user,
        role=WorkspaceRole.ADMIN,
        status=MemberStatus.ACTIVE,
    )
    return user


@pytest.fixture
def member(db: object) -> Any:
    """A real WorkspaceMembership at role MEMBER (below the ADMIN gate)."""
    from trueppm_api.apps.workspace.models import (
        MemberStatus,
        WorkspaceMembership,
        WorkspaceRole,
    )

    user = User.objects.create_user(username="sso_member", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(),
        user=user,
        role=WorkspaceRole.MEMBER,
        status=MemberStatus.ACTIVE,
    )
    return user


def api_client(user: Any | None = None) -> APIClient:
    c = APIClient()
    if user is not None:
        c.force_authenticate(user=user)
    return c
