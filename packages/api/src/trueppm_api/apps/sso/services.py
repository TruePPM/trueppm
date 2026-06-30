"""OIDC relying-party service layer (ADR-0187 §2, Durable Execution §3).

Pure functions for the Authorization Code + PKCE flow, kept out of the views so
the security-critical logic (state/PKCE/nonce, token exchange, ID-token
validation, identity resolution, membership creation) is testable in isolation.

The flow is synchronous request/response — no Celery, no outbox (ADR-0187 §Durable
Execution). The only ephemeral state (``state`` → PKCE verifier + nonce + the
exact redirect_uri) lives in the Django cache (Valkey in prod) with a short TTL
and is **single-use** (deleted on read), so a replayed callback fails closed.

Every outbound fetch (discovery, token endpoint, JWKS) goes through the shared
SSRF egress chokepoint (``apps/integrations/http``) — the issuer URL is
operator-supplied and must not be allowed to reach loopback / RFC1918 / cloud
metadata even though only an admin can configure it (defense in depth).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import transaction
from jwt import PyJWK, PyJWKSet
from jwt.exceptions import PyJWKError, PyJWKSetError

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.sso.extensions import oidc_role_for
from trueppm_api.apps.sso.models import OIDCIdentity, OIDCProvider
from trueppm_api.apps.workspace.models import MemberStatus, WorkspaceMembership

logger = logging.getLogger("trueppm.sso")

User = get_user_model()

# ID-token signature algorithms we accept. Asymmetric only — a symmetric ``HS*``
# token would be "verified" with the client secret, and ``none`` must never be
# honored. PyJWT rejects any ``alg`` not in this allow-list (and ``none`` outright
# when a key is supplied), closing the alg-confusion class.
_ALLOWED_ID_TOKEN_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]

# Short, single-use login state. 5 minutes is ample for an interactive IdP
# round-trip (consent screen included) and bounds how long a leaked ``state`` URL
# parameter is replayable (it's also deleted on first read).
_STATE_TTL_SECONDS = getattr(settings, "OIDC_STATE_TTL_SECONDS", 300)

# Discovery documents are stable; caching avoids re-fetching the well-known doc
# on every login (perf) without holding it so long that an issuer reconfiguration
# is invisible for hours.
_DISCOVERY_TTL_SECONDS = getattr(settings, "OIDC_DISCOVERY_TTL_SECONDS", 3600)

_STATE_KEY_PREFIX = "oidc:state:"
_DISCOVERY_KEY_PREFIX = "oidc:discovery:"


class OIDCError(Exception):
    """Base error for the OIDC flow, carrying a stable machine code + HTTP status.

    ``code`` is the non-sensitive identifier surfaced to the SPA (in a redirect
    query param) or returned in a JSON body. It never carries PII or token
    material.
    """

    code = "oidc_error"
    http_status = 400

    def __init__(
        self, message: str = "", *, code: str | None = None, http_status: int | None = None
    ) -> None:
        super().__init__(message or (code or self.code))
        if code is not None:
            self.code = code
        if http_status is not None:
            self.http_status = http_status


class OIDCNotConfigured(OIDCError):
    code = "sso_not_configured"
    http_status = 400


class OIDCStateError(OIDCError):
    code = "invalid_state"
    http_status = 400


class OIDCTokenExchangeError(OIDCError):
    code = "token_exchange_failed"
    http_status = 400


class OIDCIDTokenError(OIDCError):
    code = "invalid_id_token"
    http_status = 400


class OIDCEmailUnverified(OIDCError):
    code = "email_unverified"
    http_status = 403


class OIDCNoMember(OIDCError):
    code = "sso_no_member"
    http_status = 403


class OIDCProviderUnreachable(OIDCError):
    code = "provider_unreachable"
    http_status = 502


@dataclass(frozen=True)
class LoginRedirect:
    """The result of starting a login: where to send the browser, and the state key."""

    authorization_url: str
    state: str


# ---------------------------------------------------------------------------
# Provider resolution
# ---------------------------------------------------------------------------


def get_enabled_provider() -> OIDCProvider | None:
    """Return the enabled, fully-configured provider, or ``None`` if SSO is off.

    A provider that exists but is disabled, or is missing an issuer / client id /
    secret, is treated as "no SSO" — the flow fails closed rather than attempting
    a half-configured handshake.
    """
    provider = OIDCProvider.objects.filter(enabled=True).first()
    if provider is None:
        return None
    if not (provider.issuer_url and provider.client_id and provider.secret_set):
        return None
    return provider


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _discovery_url(issuer_url: str) -> str:
    return f"{issuer_url.rstrip('/')}/.well-known/openid-configuration"


def get_discovery_document(issuer_url: str) -> dict[str, Any]:
    """Fetch and validate the OIDC discovery document for ``issuer_url``.

    SSRF-guarded; cached for a short TTL. Validates that the document's ``issuer``
    claim is identical to the configured issuer (OIDC Discovery §4.3 — a mismatch
    is a misconfigured or hostile IdP) and that the endpoints the flow needs are
    present.

    Raises:
        OIDCProviderUnreachable: discovery could not be fetched.
        OIDCIDTokenError: the document is malformed or the issuer does not match.
    """
    cache_key = _DISCOVERY_KEY_PREFIX + issuer_url
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return cached

    url = _discovery_url(issuer_url)
    try:
        resp = egress.get(url, headers={"Accept": "application/json"})
    except egress.EgressBlocked as exc:
        raise OIDCProviderUnreachable(f"issuer URL blocked by SSRF guard: {exc}") from exc
    except (egress.EgressTimeout, egress.EgressError) as exc:
        raise OIDCProviderUnreachable(f"could not reach issuer discovery: {exc}") from exc

    if resp.status != 200:
        raise OIDCProviderUnreachable(f"discovery returned HTTP {resp.status}")

    doc = resp.json()
    if not isinstance(doc, dict):
        raise OIDCIDTokenError("discovery document is not valid JSON")

    # The issuer in the document MUST match the configured issuer exactly.
    if doc.get("issuer") != issuer_url:
        raise OIDCIDTokenError("discovery issuer does not match configured issuer")

    for required in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not doc.get(required):
            raise OIDCIDTokenError(f"discovery document missing {required}")

    cache.set(cache_key, doc, _DISCOVERY_TTL_SECONDS)
    return doc


# ---------------------------------------------------------------------------
# PKCE + state
# ---------------------------------------------------------------------------


def _pkce_pair() -> tuple[str, str]:
    """Return ``(code_verifier, code_challenge)`` for PKCE method S256 (RFC 7636)."""
    verifier = secrets.token_urlsafe(64)  # 43–128 chars after urlsafe encoding
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def start_login(provider: OIDCProvider, *, redirect_uri: str) -> LoginRedirect:
    """Mint a single-use ``state`` + PKCE verifier + nonce and build the IdP URL.

    The verifier, nonce, and the **exact** redirect_uri are stored server-side
    under the state key (never sent to the browser) so the callback can replay an
    identical redirect_uri to the token endpoint and bind the nonce. The browser
    only ever sees the opaque ``state`` and the ``code_challenge``.
    """
    doc = get_discovery_document(provider.issuer_url)

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(24)
    verifier, challenge = _pkce_pair()

    cache.set(
        _STATE_KEY_PREFIX + state,
        {"verifier": verifier, "nonce": nonce, "redirect_uri": redirect_uri},
        _STATE_TTL_SECONDS,
    )

    params = {
        "response_type": "code",
        "client_id": provider.client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(provider.scopes or ["openid", "email", "profile"]),
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    authorization_url = f"{doc['authorization_endpoint']}?{urlencode(params)}"
    return LoginRedirect(authorization_url=authorization_url, state=state)


def consume_state(state: str) -> dict[str, Any]:
    """Pop the stored login state (single-use; deleted on read).

    Returns the stored ``{verifier, nonce, redirect_uri}``. A missing / expired /
    already-consumed state raises :class:`OIDCStateError` — the callback fails
    closed, which is the CSRF / replay mitigation.
    """
    if not state:
        raise OIDCStateError("missing state")
    key = _STATE_KEY_PREFIX + state
    data = cache.get(key)
    # Delete before doing anything else, so even concurrent callbacks race to a
    # single winner (the small get/delete TOCTOU window is acceptable — the token
    # endpoint also rejects a re-used authorization code).
    cache.delete(key)
    if not isinstance(data, dict):
        raise OIDCStateError("unknown or expired state")
    return data


# ---------------------------------------------------------------------------
# Token exchange + ID-token validation
# ---------------------------------------------------------------------------


def exchange_code(
    provider: OIDCProvider, doc: dict[str, Any], *, code: str, redirect_uri: str, verifier: str
) -> dict[str, Any]:
    """Exchange the authorization ``code`` + PKCE ``verifier`` for tokens.

    Uses ``client_secret_post`` (confidential client) against the discovered
    ``token_endpoint``, SSRF-guarded. The decrypted client secret is sent only to
    the IdP and never returned to a client or logged.

    Raises:
        OIDCProviderUnreachable: the token endpoint could not be reached.
        OIDCTokenExchangeError: the IdP returned an OAuth error or no id_token.
    """
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": provider.client_id,
        "client_secret": provider.get_client_secret(),
        "code_verifier": verifier,
    }
    try:
        resp = egress.post_form(doc["token_endpoint"], data=data)
    except egress.EgressBlocked as exc:
        raise OIDCProviderUnreachable(f"token endpoint blocked by SSRF guard: {exc}") from exc
    except (egress.EgressTimeout, egress.EgressError) as exc:
        raise OIDCProviderUnreachable(f"could not reach token endpoint: {exc}") from exc

    payload = resp.json()
    if not isinstance(payload, dict):
        raise OIDCTokenExchangeError("token endpoint returned a non-JSON body")
    if resp.status != 200 or "error" in payload:
        # Do not echo the IdP's error_description verbatim to the user; log it,
        # surface a stable code.
        logger.warning(
            "oidc token exchange failed: status=%s error=%s",
            resp.status,
            payload.get("error"),
        )
        raise OIDCTokenExchangeError("token exchange failed")
    if not payload.get("id_token"):
        raise OIDCTokenExchangeError("token response did not include an id_token")
    return payload


def _signing_key_for(jwks_uri: str, id_token: str) -> PyJWK:
    """Fetch the JWKS through the SSRF-guarded egress and return the signing key.

    PyJWT's ``PyJWKClient`` is deliberately **not** used: it fetches the JWKS with
    urllib's default opener, which follows redirects and re-resolves DNS *after*
    any point-in-time host check — a TOCTOU/redirect SSRF bypass of the egress
    chokepoint. Fetching the JWKS ourselves via ``egress.get`` keeps every
    outbound call on the redirect-disabled, allow-listed path (ADR-0187 Boundary 6
    / SSRF), then we select the key locally by the token's ``kid``.
    """
    try:
        egress.assert_url_allowed(jwks_uri)
        resp = egress.get(jwks_uri, headers={"Accept": "application/json"})
    except egress.EgressBlocked as exc:
        raise OIDCProviderUnreachable(f"jwks URL blocked by SSRF guard: {exc}") from exc
    except (egress.EgressTimeout, egress.EgressError) as exc:
        raise OIDCProviderUnreachable(f"could not reach jwks: {exc}") from exc
    if resp.status != 200:
        raise OIDCProviderUnreachable(f"jwks endpoint returned HTTP {resp.status}")

    data = resp.json()
    if not isinstance(data, dict) or not data.get("keys"):
        raise OIDCIDTokenError("jwks document is empty or malformed")
    try:
        jwk_set = PyJWKSet.from_dict(data)
        header = jwt.get_unverified_header(id_token)
    except (PyJWKError, PyJWKSetError, jwt.InvalidTokenError, ValueError) as exc:
        raise OIDCIDTokenError(f"could not parse jwks or token header: {exc}") from exc

    # Match PyJWKClient's selection: the token's ``kid`` (when present) against a
    # signing-use key. ``public_key_use`` is "sig" or absent for signing keys.
    kid = header.get("kid")
    candidates = [
        key
        for key in jwk_set.keys
        if getattr(key, "public_key_use", None) in ("sig", None)
        and (kid is None or key.key_id == kid)
    ]
    if not candidates:
        raise OIDCIDTokenError("no matching signing key in jwks")
    return candidates[0]


def validate_id_token(
    provider: OIDCProvider, doc: dict[str, Any], id_token: str, *, expected_nonce: str
) -> dict[str, Any]:
    """Verify the ID token's signature and claims, returning the claim set.

    Verifies the RS256/ES256 signature against the discovered JWKS (fetched
    through the SSRF-guarded egress, never PyJWKClient's own socket), and enforces
    ``iss == issuer``, ``aud == client_id``, ``exp``/``iat`` presence, and
    ``nonce`` equality with the value bound at login. Any failure raises
    :class:`OIDCIDTokenError`.
    """
    signing_key = _signing_key_for(doc["jwks_uri"], id_token)

    try:
        claims: dict[str, Any] = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=_ALLOWED_ID_TOKEN_ALGS,
            audience=provider.client_id,
            issuer=provider.issuer_url,
            options={"require": ["exp", "iat", "aud", "iss"]},
        )
    except jwt.InvalidTokenError as exc:
        raise OIDCIDTokenError(f"id token validation failed: {exc}") from exc

    # ``nonce`` binds this ID token to *our* login request (replay defense). PyJWT
    # does not check it, so we enforce equality with the value stored under state.
    if not expected_nonce or claims.get("nonce") != expected_nonce:
        raise OIDCIDTokenError("id token nonce mismatch")

    return claims


# ---------------------------------------------------------------------------
# Identity resolution + account rules
# ---------------------------------------------------------------------------


def _domain_allowed(provider: OIDCProvider, email: str) -> bool:
    """Whether ``email``'s domain is in the allow-list.

    Empty allow-list = fail closed (no domain permitted). This forces an admin to
    name the domains that may sign in / be created before any account is linked,
    and is the takeover gate alongside ``email_verified``.
    """
    domains = [d.lower() for d in (provider.allowed_email_domains or [])]
    if not domains:
        return False
    domain = email.rsplit("@", 1)[-1].lower()
    return domain in domains


def _unique_username(email: str) -> str:
    """Derive a unique username for a newly auto-created SSO user.

    The local part of the email is the human-friendly base; a short random suffix
    is appended on collision so two ``alice@`` from different domains (or a
    pre-existing username) never clash.
    """
    base = (email.split("@", 1)[0] or "user")[:140]
    candidate = base
    while User.objects.filter(username=candidate).exists():
        candidate = f"{base}-{secrets.token_hex(3)}"
    return candidate


@transaction.atomic
def resolve_user(provider: OIDCProvider, claims: dict[str, Any]) -> tuple[Any, bool]:
    """Resolve (and possibly create/link) the local user for a validated ID token.

    Resolution order (ADR-0187 §2):

    1. **Durable key** — an existing ``OIDCIdentity`` on ``(issuer, sub)`` wins
       outright. Later logins always route here, never by email.
    2. **Verified email** — require ``email`` present and ``email_verified is
       True`` and the domain in the allow-list; otherwise fail closed.
    3. **Link** — exactly one existing local user with that email → bind a new
       ``OIDCIdentity`` and sign in. (Ambiguous: 0 or >1 → not a link.)
    4. **Auto-create** — no existing user, ``auto_create_members`` on → create the
       user + one ``WorkspaceMembership`` at the resolved role, bind the identity.
    5. Otherwise → :class:`OIDCNoMember`.

    Returns ``(user, created)``. Wrapped in a transaction so a half-created
    user/membership/identity never persists.
    """
    issuer = provider.issuer_url
    subject = str(claims.get("sub") or "")
    if not subject:
        raise OIDCIDTokenError("id token has no subject")

    # 1. Durable identity.
    identity = (
        OIDCIdentity.objects.select_related("user").filter(issuer=issuer, subject=subject).first()
    )
    if identity is not None:
        return identity.user, False

    # 2. Verified-email gate.
    email = (claims.get("email") or "").strip()
    if not email or claims.get("email_verified") is not True:
        raise OIDCEmailUnverified("IdP did not assert a verified email")
    if not _domain_allowed(provider, email):
        raise OIDCNoMember("email domain is not permitted")

    # 3. Link to an existing local account (only when unambiguous).
    existing = list(User.objects.filter(email__iexact=email)[:2])
    if len(existing) == 1:
        OIDCIdentity.objects.create(user=existing[0], issuer=issuer, subject=subject)
        return existing[0], False
    if len(existing) > 1:
        # Email is not unique in Django's auth model; an ambiguous match must not
        # silently pick one account (takeover risk). Fail closed.
        raise OIDCNoMember("ambiguous account for email")

    # 4. Auto-create.
    if not provider.auto_create_members:
        raise OIDCNoMember("no account and auto-create disabled")

    user = User.objects.create(
        username=_unique_username(email),
        email=email,
        first_name=(claims.get("given_name") or "")[:150],
        last_name=(claims.get("family_name") or "")[:150],
    )
    # SSO-only account — no usable local password. Account-linking (branch 3)
    # preserves an existing user's password; freshly created users have none.
    user.set_unusable_password()
    user.save(update_fields=["password"])

    role = oidc_role_for(claims, provider)
    WorkspaceMembership.objects.create(
        workspace=provider.workspace,
        user=user,
        role=role,
        status=MemberStatus.ACTIVE,
    )
    OIDCIdentity.objects.create(user=user, issuer=issuer, subject=subject)

    # Audit the join. Imported lazily to avoid a workspace→sso import cycle at
    # module load; the helper writes the row inside this transaction (rolls back
    # with us) and fans out the signal on commit.
    from trueppm_api.apps.workspace.models import AuditEventType
    from trueppm_api.apps.workspace.services import record_audit_event

    record_audit_event(
        event_type=AuditEventType.MEMBER_ADDED,
        actor=user,
        target_type="user",
        target_id=user.pk,
        target_label=email,
        metadata={"via": "sso", "issuer": issuer},
    )
    return user, True


# ---------------------------------------------------------------------------
# Test connection (admin)
# ---------------------------------------------------------------------------


def check_provider_reachability(issuer_url: str) -> dict[str, Any]:
    """Fetch discovery + confirm JWKS reachability for the admin "Test connection".

    Never raises — returns a structured ``{ok, issuer, endpoints, error}`` result
    so the admin page can render a clear pass/fail. (Bypasses the discovery cache
    so the button always reflects current reality.)
    """
    cache.delete(_DISCOVERY_KEY_PREFIX + issuer_url)
    try:
        doc = get_discovery_document(issuer_url)
    except OIDCError as exc:
        return {"ok": False, "issuer": issuer_url, "error": exc.code, "detail": str(exc)}

    jwks_uri = doc.get("jwks_uri", "")
    try:
        egress.assert_url_allowed(jwks_uri)
        jwks_resp = egress.get(jwks_uri, headers={"Accept": "application/json"})
    except (egress.EgressBlocked, egress.EgressTimeout, egress.EgressError) as exc:
        return {"ok": False, "issuer": issuer_url, "error": "jwks_unreachable", "detail": str(exc)}

    keys = jwks_resp.json() if jwks_resp.status == 200 else None
    if not isinstance(keys, dict) or not keys.get("keys"):
        return {"ok": False, "issuer": issuer_url, "error": "jwks_empty"}

    return {
        "ok": True,
        "issuer": issuer_url,
        "endpoints": {
            "authorization_endpoint": doc.get("authorization_endpoint", ""),
            "token_endpoint": doc.get("token_endpoint", ""),
            "jwks_uri": jwks_uri,
        },
    }
