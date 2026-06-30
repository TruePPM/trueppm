"""Shared fixtures for the SSO (OIDC relying-party) tests (ADR-0187, #1405).

The flow's outbound calls — discovery, token exchange, JWKS — all go through the
``apps/integrations/http`` egress chokepoint. ID-token verification fetches the
JWKS through that same chokepoint (never PyJWKClient's own socket — see
``services._signing_key_for``). None of that may touch the network in a unit
test, so the fixtures here provide:

* a real RSA keypair + an ``id_token`` factory that signs genuine RS256 JWTs, so
  the signature path is exercised for real (not stubbed);
* ``JWKS`` — the test public key in JWKS shape, served via the egress stub so
  ``validate_id_token`` resolves the real signing key and verifies the real
  signature; the SSRF check is turned into a no-op (no socket is opened);
* ``patch_jwks`` — stubs ``egress.get`` to return discovery + the test JWKS;
* ``fake_discovery`` / ``set_token_endpoint`` — monkeypatch the egress helpers so
  ``get`` / ``post_form`` return canned IdP responses.
"""

from __future__ import annotations

import json
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.contrib.auth import get_user_model
from jwt.algorithms import RSAAlgorithm
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import OIDCProvider

User = get_user_model()

ISSUER = "https://idp.example.com"
CLIENT_ID = "trueppm-web"
CLIENT_SECRET = "s3cr3t-value"
ALLOWED_DOMAIN = "example.com"

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

# The JWKS document an IdP publishes for the test public key, in the shape
# ``PyJWKSet.from_dict`` consumes. ``validate_id_token`` fetches this through the
# egress stub and verifies the real RS256 signature against it — so the JWKS
# parse + key-selection + signature path all run for real, only the socket is
# stubbed. ``make_id_token`` emits no ``kid`` header, so key selection matches the
# lone signing-use key regardless of the JWK's ``kid``.
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
    """Sign a genuine ID token (RS256 by default) with the test key.

    ``alg``/``key`` are overridable so a test can forge an ``alg=none`` or
    HS256-with-the-client-secret token to prove the alg allow-list rejects it.
    ``omit`` drops required claims to exercise the ``require`` option.
    """
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


@pytest.fixture
def patch_jwks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Serve discovery + the test JWKS through the egress stub (no network).

    ``validate_id_token`` fetches the JWKS via the SSRF-guarded ``egress.get`` and
    verifies the real RS256 signature against the test public key, so the whole
    signature path runs for real — only the socket is stubbed. The SSRF check is a
    no-op so the (test) issuer host is not subjected to the real allow-list.
    """

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
    """Stub ``egress.post_form`` so the token exchange returns a canned response."""

    def _fake_post(url: str, **kwargs: Any) -> egress.EgressResponse:
        payload: dict[str, Any] = {}
        if error is not None:
            payload["error"] = error
        if id_token is not None:
            payload["id_token"] = id_token
            payload["access_token"] = "opaque-access"
        return egress.EgressResponse(status=status, body=json.dumps(payload).encode(), headers={})

    monkeypatch.setattr(services.egress, "post_form", _fake_post)


@pytest.fixture
def provider(db: object) -> OIDCProvider:
    """An enabled, fully-configured singleton provider with a stored secret."""
    p = OIDCProvider.load()
    p.enabled = True
    p.display_name = "Example IdP"
    p.issuer_url = ISSUER
    p.client_id = CLIENT_ID
    p.set_client_secret(CLIENT_SECRET)
    p.allowed_email_domains = [ALLOWED_DOMAIN]
    p.auto_create_members = True
    p.save()
    return p


@pytest.fixture
def admin(db: object) -> Any:
    """Superuser → implicit workspace OWNER (IsWorkspaceAdmin allows writes)."""
    return User.objects.create_user(username="sso_admin", password="pw", is_superuser=True)


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="sso_member", password="pw")


def api_client(user: Any | None = None) -> APIClient:
    c = APIClient()
    if user is not None:
        c.force_authenticate(user=user)
    return c
