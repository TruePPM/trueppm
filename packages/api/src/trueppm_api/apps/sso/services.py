"""Multi-provider SSO service layer (ADR-0517 §3.2, supersedes ADR-0187 §2).

Pure functions for the Authorization Code + PKCE (OIDC) and Authorization Code
(GitHub OAuth2) flows, kept out of the views so the security-critical logic
(state/PKCE/nonce, token exchange, ID-token validation, GitHub userinfo, identity
resolution, membership creation) is testable in isolation.

ADR-0517 adopts ``allauth.socialaccount`` as the provider **registry** — the
per-provider endpoint/claim knowledge — but **not** its network layer. Every
outbound call (OIDC discovery / token / JWKS, GitHub ``/user`` + ``/user/emails``
+ org membership) still routes through the shared SSRF egress chokepoint
(``apps/integrations/http``). allauth is used only for endpoint constants and
claim shape; **it never opens a socket** (control 1). We keep our own
``validate_id_token`` (alg allow-list + nonce, JWKS via egress) rather than
delegating to allauth's verification, which would fetch JWKS off-egress and not
enforce our alg allow-list (control 4).

Config lives in allauth's ``SocialApp`` (``provider``, ``provider_id``,
``client_id``, ``settings.server_url``) + our :class:`SsoProviderPolicy` side row
(the Fernet-encrypted client secret + policy fields); per-user bindings live in
allauth's ``SocialAccount``. The only ephemeral state (``state`` → provider slug +
PKCE verifier + nonce + the exact redirect_uri) lives in the Django cache (Valkey
in prod) with a short TTL and is **single-use** (deleted on read).
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
from allauth.socialaccount.models import SocialApp
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import transaction
from jwt import PyJWK, PyJWKSet
from jwt.exceptions import PyJWKError, PyJWKSetError

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.sso.extensions import oidc_role_for
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.workspace.models import MemberStatus, WorkspaceMembership

logger = logging.getLogger("trueppm.sso")

User = get_user_model()

# The two allauth provider modules we enable (ADR-0517 §1). Every OIDC IdP maps to
# ``openid_connect``; GitHub is the one non-OIDC OAuth2 IdP.
ALLAUTH_OPENID_CONNECT = "openid_connect"
ALLAUTH_GITHUB = "github"


@dataclass(frozen=True)
class RegistryEntry:
    """A fixed, server-defined SSO provider type (ADR-0517 §2).

    ``slug`` is the admin-facing registry id **and** the openid_connect
    ``provider_id`` / SocialAccount ``provider`` key. ``allauth_provider`` selects
    the flow branch (OIDC vs GitHub OAuth2). ``kind`` is display metadata for the
    admin picker (the FE composes ``server_url`` for the ``derived`` types and the
    server re-validates it as an absolute https URL).
    """

    slug: str
    display: str
    allauth_provider: str
    kind: str  # free | fixed | derived | oauth


# The fixed provider registry (ADR-0517 §2, design handoff table). Every OIDC IdP
# uses allauth's ``openid_connect`` provider as a named app keyed by our slug; only
# GitHub uses the dedicated ``github`` OAuth2 module.
REGISTRY: dict[str, RegistryEntry] = {
    "generic": RegistryEntry("generic", "Generic OIDC", ALLAUTH_OPENID_CONNECT, "free"),
    "google": RegistryEntry("google", "Google", ALLAUTH_OPENID_CONNECT, "fixed"),
    "entra": RegistryEntry("entra", "Microsoft Entra ID", ALLAUTH_OPENID_CONNECT, "derived"),
    "gitlab": RegistryEntry("gitlab", "GitLab", ALLAUTH_OPENID_CONNECT, "derived"),
    "keycloak": RegistryEntry("keycloak", "Keycloak", ALLAUTH_OPENID_CONNECT, "derived"),
    "authentik": RegistryEntry("authentik", "Authentik", ALLAUTH_OPENID_CONNECT, "derived"),
    "zitadel": RegistryEntry("zitadel", "Zitadel", ALLAUTH_OPENID_CONNECT, "derived"),
    "okta": RegistryEntry("okta", "Okta", ALLAUTH_OPENID_CONNECT, "derived"),
    "auth0": RegistryEntry("auth0", "Auth0", ALLAUTH_OPENID_CONNECT, "derived"),
    "github": RegistryEntry("github", "GitHub", ALLAUTH_GITHUB, "oauth"),
}


def registry_entry(slug: str) -> RegistryEntry | None:
    return REGISTRY.get(slug)


# Server-fixed scopes (ADR-0517 §3.4). The admin cannot widen them; ``groups`` /
# custom claims are an enterprise widening. Mirrors SOCIALACCOUNT_PROVIDERS.
OIDC_SCOPES = ["openid", "email", "profile"]
GITHUB_SCOPES = ["read:user", "user:email"]

# GitHub OAuth2 endpoints (ADR-0517 §3.2). Kept as module constants — allauth's
# github adapter (GitHubOAuth2Adapter) is used only as a reference for these
# values and the claim shape; the network call is ours, through egress.
GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_EMAILS_URL = "https://api.github.com/user/emails"
# The synthetic "issuer" recorded in SocialAccount.extra_data for GitHub bindings
# (GitHub has no OIDC issuer). Preserves parity with the OIDC ``iss`` disambiguator.
GITHUB_ISSUER = "https://github.com"

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

# JWKS documents change only when the IdP rotates keys, so re-fetching one on
# every single login is pure added latency plus an avoidable outbound request per
# sign-in. Shorter than the discovery TTL on purpose: the kid-miss refetch in
# ``_signing_key_for`` already makes a *newly added* key visible immediately, so
# the only thing the TTL bounds is how long a *withdrawn* key stays trusted — and
# that window should be minutes, not an hour.
_JWKS_TTL_SECONDS = getattr(settings, "OIDC_JWKS_TTL_SECONDS", 600)

# Clock-skew allowance when validating an ID token's time claims. 60 seconds is
# the conventional OIDC/JWT allowance (RFC 7519 §4.1.4 explicitly provides for
# "some small leeway"; the mainstream IdP SDKs default to a minute). With the
# PyJWT default of 0 an IdP whose clock is even a second ahead of ours issues
# tokens we reject as not-yet-valid, which surfaces to the user as an
# undiagnosable login failure on a correctly configured provider. It is held to
# one minute rather than the several some libraries allow because the same
# allowance symmetrically extends how long an *expired* token stays acceptable,
# and an ID token is consumed once, immediately after issuance.
_ID_TOKEN_LEEWAY_SECONDS = 60

_STATE_KEY_PREFIX = "oidc:state:"
_DISCOVERY_KEY_PREFIX = "oidc:discovery:"
_JWKS_KEY_PREFIX = "oidc:jwks:"

# Accept header for provider metadata / JWKS / token-endpoint fetches.
_ACCEPT_JSON = "application/json"


class OIDCError(Exception):
    """Base error for the SSO flow, carrying a stable machine code + HTTP status.

    ``code`` is the non-sensitive identifier surfaced to the SPA (in a redirect
    query param) or returned in a JSON body. It never carries PII or token
    material. (The ``OIDC`` prefix is retained from ADR-0187 for continuity even
    though the hierarchy now also covers GitHub OAuth2.)
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


class OIDCAccountDisabled(OIDCError):
    """The identity resolved to a local account that has been deactivated (#2875).

    Distinct from :class:`OIDCNoMember` because the remedy is different: the user
    *is* a member, their account was switched off. Telling them to ask for an
    invite (the ``sso_no_member`` copy) would send them down a path that cannot
    resolve it.
    """

    code = "sso_account_disabled"
    http_status = 403


class OIDCProviderUnreachable(OIDCError):
    code = "provider_unreachable"
    http_status = 502


@dataclass(frozen=True)
class LoginRedirect:
    """The result of starting a login: where to send the browser, and the state key."""

    authorization_url: str
    state: str


@dataclass(frozen=True)
class ProviderContext:
    """A resolved, enabled provider: an allauth ``SocialApp`` + its policy side row.

    Wraps the two rows so the flow reads config uniformly regardless of provider
    type. ``is_github`` selects the OAuth2 (no-OIDC) branch; everything else is an
    OIDC IdP whose ``issuer`` is the ``server_url`` stored on the ``SocialApp``.
    """

    social_app: SocialApp
    policy: SsoProviderPolicy

    @property
    def slug(self) -> str:
        return self.policy.slug

    @property
    def is_github(self) -> bool:
        return bool(self.social_app.provider == ALLAUTH_GITHUB)

    @property
    def display_name(self) -> str:
        return str(self.social_app.name)

    @property
    def client_id(self) -> str:
        return str(self.social_app.client_id)

    def get_client_secret(self) -> str:
        return self.policy.get_client_secret()

    @property
    def issuer(self) -> str:
        """The OIDC issuer (``server_url``), or the synthetic GitHub issuer."""
        if self.is_github:
            return GITHUB_ISSUER
        return str(self.social_app.settings.get("server_url", ""))

    @property
    def scopes(self) -> list[str]:
        return GITHUB_SCOPES if self.is_github else OIDC_SCOPES


# ---------------------------------------------------------------------------
# Provider resolution — fail closed
# ---------------------------------------------------------------------------


def _is_configured(ctx: ProviderContext) -> bool:
    """Whether a provider is complete enough to attempt a handshake.

    A half-configured provider (missing client id / secret, or — for OIDC —
    missing issuer) is treated as "not usable" so the flow fails closed rather
    than attempting a broken handshake.
    """
    if not (ctx.client_id and ctx.policy.secret_set):
        return False
    # OIDC needs an issuer; GitHub derives its endpoints from module constants.
    return ctx.is_github or bool(ctx.issuer)


def _context_for_policy(policy: SsoProviderPolicy) -> ProviderContext:
    return ProviderContext(social_app=policy.social_app, policy=policy)


def get_provider_for_slug(slug: str) -> ProviderContext | None:
    """Return the enabled, fully-configured provider for ``slug``, or ``None``.

    Fails closed: a disabled or half-configured provider yields ``None`` so the
    login/callback flow refuses to proceed.
    """
    policy = (
        SsoProviderPolicy.objects.select_related("social_app")
        .filter(enabled=True, slug=slug)
        .first()
    )
    if policy is None:
        return None
    ctx = _context_for_policy(policy)
    return ctx if _is_configured(ctx) else None


def get_enabled_providers() -> list[ProviderContext]:
    """Return every enabled, fully-configured provider (for the login screen)."""
    contexts = [
        _context_for_policy(policy)
        for policy in SsoProviderPolicy.objects.select_related("social_app").filter(enabled=True)
    ]
    return [ctx for ctx in contexts if _is_configured(ctx)]


def domain_matches_any_enabled(email: str) -> ProviderContext | None:
    """Return the first enabled provider whose domain allow-list admits ``email``.

    Used by ``discover`` to answer "does this *domain* use SSO?" without leaking
    account existence. ``None`` when no enabled provider admits the domain.
    """
    if "@" not in email:
        return None
    for ctx in get_enabled_providers():
        if _domain_allowed(ctx.policy, email):
            return ctx
    return None


# ---------------------------------------------------------------------------
# Discovery (OIDC)
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
        resp = egress.get(url, headers={"Accept": _ACCEPT_JSON})
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


def start_login(ctx: ProviderContext, *, redirect_uri: str) -> LoginRedirect:
    """Mint single-use login state and build the provider authorization URL.

    OIDC: mints ``state`` + PKCE verifier + nonce, stores the verifier/nonce/exact
    redirect_uri server-side (never sent to the browser), and binds the nonce to
    the ID token. GitHub: mints ``state`` and stores the redirect_uri (GitHub's
    OAuth2 has no PKCE/nonce). In both cases the provider ``slug`` is stored under
    the state key so the callback knows which ``SocialApp`` is completing without a
    new callback path segment (ADR-0517 §3.5).
    """
    state = secrets.token_urlsafe(32)

    if ctx.is_github:
        cache.set(
            _STATE_KEY_PREFIX + state,
            {"slug": ctx.slug, "redirect_uri": redirect_uri},
            _STATE_TTL_SECONDS,
        )
        params = {
            "response_type": "code",
            "client_id": ctx.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(ctx.scopes),
            "state": state,
        }
        authorization_url = f"{GITHUB_AUTHORIZE_URL}?{urlencode(params)}"
        return LoginRedirect(authorization_url=authorization_url, state=state)

    doc = get_discovery_document(ctx.issuer)
    nonce = secrets.token_urlsafe(24)
    verifier, challenge = _pkce_pair()

    cache.set(
        _STATE_KEY_PREFIX + state,
        {"slug": ctx.slug, "verifier": verifier, "nonce": nonce, "redirect_uri": redirect_uri},
        _STATE_TTL_SECONDS,
    )

    params = {
        "response_type": "code",
        "client_id": ctx.client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(ctx.scopes),
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    authorization_url = f"{doc['authorization_endpoint']}?{urlencode(params)}"
    return LoginRedirect(authorization_url=authorization_url, state=state)


def consume_state(state: str) -> dict[str, Any]:
    """Pop the stored login state (single-use; deleted on read).

    Returns the stored ``{slug, redirect_uri, ...}``. A missing / expired /
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
# Token exchange + ID-token validation (OIDC)
# ---------------------------------------------------------------------------


def exchange_code(
    ctx: ProviderContext, doc: dict[str, Any], *, code: str, redirect_uri: str, verifier: str
) -> dict[str, Any]:
    """Exchange the authorization ``code`` + PKCE ``verifier`` for OIDC tokens.

    Uses ``client_secret_post`` (confidential client) against the discovered
    ``token_endpoint``, SSRF-guarded. The decrypted client secret is read from the
    policy side row at call time and sent only to the IdP — never returned to a
    client or logged.

    Raises:
        OIDCProviderUnreachable: the token endpoint could not be reached.
        OIDCTokenExchangeError: the IdP returned an OAuth error or no id_token.
    """
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": ctx.client_id,
        "client_secret": ctx.get_client_secret(),
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
        # Surface a stable code to the user; log the IdP's machine-readable error
        # for ops. The logged value is the OAuth2 ``error`` *code* (RFC 6749 §5.2:
        # invalid_grant, invalid_client, …) — a public enumerated value, not a
        # credential — and we deliberately never log ``error_description``.
        # semgrep's `python-logger-credential-disclosure` flags the `error=`
        # token as a possible secret leak; this is a reviewed false positive. The
        # bare `# nosemgrep` (vs the rule-id form) is deliberate: the fully
        # qualified rule id is 92 chars, so an id-scoped directive cannot fit the
        # 100-col limit without tripping E501/RUF100. Scope here is this one line.
        logger.warning(  # nosemgrep
            "oidc token exchange failed: status=%s error=%s",
            resp.status,
            payload.get("error"),
        )
        raise OIDCTokenExchangeError("token exchange failed")
    if not payload.get("id_token"):
        raise OIDCTokenExchangeError("token response did not include an id_token")
    return payload


def _fetch_jwks(jwks_uri: str, *, force_refresh: bool = False) -> tuple[dict[str, Any], bool]:
    """Fetch the JWKS through the SSRF-guarded egress, cached. Returns ``(doc, was_cached)``.

    PyJWT's ``PyJWKClient`` is deliberately **not** used: it fetches the JWKS with
    urllib's default opener, which follows redirects and re-resolves DNS *after*
    any point-in-time host check — a TOCTOU/redirect SSRF bypass of the egress
    chokepoint. Fetching the JWKS ourselves via ``egress.get`` keeps every
    outbound call on the redirect-disabled, allow-listed path (ADR-0187 Boundary 6
    / SSRF).

    ``was_cached`` is returned rather than kept private because it is what lets
    the caller decide whether a ``kid`` miss is worth a second request: on a cold
    cache the document in hand *is* the IdP's current one, so retrying would just
    fetch the same bytes again.
    """
    cache_key = _JWKS_KEY_PREFIX + jwks_uri
    if not force_refresh:
        cached = cache.get(cache_key)
        if isinstance(cached, dict):
            return cached, True

    try:
        egress.assert_url_allowed(jwks_uri)
        resp = egress.get(jwks_uri, headers={"Accept": _ACCEPT_JSON})
    except egress.EgressBlocked as exc:
        raise OIDCProviderUnreachable(f"jwks URL blocked by SSRF guard: {exc}") from exc
    except (egress.EgressTimeout, egress.EgressError) as exc:
        raise OIDCProviderUnreachable(f"could not reach jwks: {exc}") from exc
    if resp.status != 200:
        raise OIDCProviderUnreachable(f"jwks endpoint returned HTTP {resp.status}")

    data = resp.json()
    if not isinstance(data, dict) or not data.get("keys"):
        raise OIDCIDTokenError("jwks document is empty or malformed")
    cache.set(cache_key, data, _JWKS_TTL_SECONDS)
    return data, False


def _select_signing_key(data: dict[str, Any], id_token: str) -> PyJWK | None:
    """Pick the key from a JWKS document that signed ``id_token``, or ``None``.

    Matches PyJWKClient's selection: the token's ``kid`` (when present) against a
    signing-use key. ``public_key_use`` is "sig" or absent for signing keys.
    """
    try:
        jwk_set = PyJWKSet.from_dict(data)
        header = jwt.get_unverified_header(id_token)
    except (PyJWKError, PyJWKSetError, jwt.InvalidTokenError, ValueError) as exc:
        raise OIDCIDTokenError(f"could not parse jwks or token header: {exc}") from exc

    kid = header.get("kid")
    candidates = [
        key
        for key in jwk_set.keys
        if getattr(key, "public_key_use", None) in ("sig", None)
        and (kid is None or key.key_id == kid)
    ]
    return candidates[0] if candidates else None


def _signing_key_for(jwks_uri: str, id_token: str) -> PyJWK:
    """Return the JWKS key that signed ``id_token``, refetching on a ``kid`` miss.

    A ``kid`` the cached document does not carry is the signature of an IdP that
    rotated its signing keys after we cached — a routine operator action. Failing
    outright there would break every login until the TTL expired even though the
    correct key is one request away, so a miss forces exactly one cache-bypassing
    refetch before giving up. The retry is bounded to the cached case (see
    ``_fetch_jwks``) so an unknown ``kid`` cannot be replayed to drive two
    outbound requests per attempt.
    """
    data, was_cached = _fetch_jwks(jwks_uri)
    key = _select_signing_key(data, id_token)
    if key is None and was_cached:
        data, _ = _fetch_jwks(jwks_uri, force_refresh=True)
        key = _select_signing_key(data, id_token)
    if key is None:
        raise OIDCIDTokenError("no matching signing key in jwks")
    return key


def validate_id_token(
    ctx: ProviderContext, doc: dict[str, Any], id_token: str, *, expected_nonce: str
) -> dict[str, Any]:
    """Verify the ID token's signature and claims, returning the claim set.

    Verifies the RS256/ES256 signature against the discovered JWKS (fetched
    through the SSRF-guarded egress, never PyJWKClient's own socket), and enforces
    ``iss == issuer``, ``aud == client_id``, ``exp``/``iat`` presence, and
    ``nonce`` equality with the value bound at login. Time claims are checked with
    ``_ID_TOKEN_LEEWAY_SECONDS`` of clock-skew tolerance. We keep this rather than
    delegating to allauth's verification (control 4). Any failure raises
    :class:`OIDCIDTokenError`.
    """
    signing_key = _signing_key_for(doc["jwks_uri"], id_token)

    try:
        claims: dict[str, Any] = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=_ALLOWED_ID_TOKEN_ALGS,
            audience=ctx.client_id,
            issuer=ctx.issuer,
            leeway=_ID_TOKEN_LEEWAY_SECONDS,
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
# GitHub OAuth2 (no OIDC discovery / JWKS / id_token) — ADR-0517 §3.2
# ---------------------------------------------------------------------------


def exchange_github_code(ctx: ProviderContext, *, code: str, redirect_uri: str) -> str:
    """Exchange a GitHub authorization ``code`` for an access token (SSRF-guarded).

    GitHub's OAuth2 has no PKCE/id_token; the token endpoint returns an opaque
    ``access_token`` used to call the user API. The decrypted client secret is read
    from the policy side row at call time and sent only to GitHub.

    Raises:
        OIDCProviderUnreachable: the token endpoint could not be reached.
        OIDCTokenExchangeError: GitHub returned an OAuth error or no access_token.
    """
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": ctx.client_id,
        "client_secret": ctx.get_client_secret(),
    }
    try:
        resp = egress.post_form(GITHUB_TOKEN_URL, data=data)
    except egress.EgressBlocked as exc:
        raise OIDCProviderUnreachable(
            f"github token endpoint blocked by SSRF guard: {exc}"
        ) from exc
    except (egress.EgressTimeout, egress.EgressError) as exc:
        raise OIDCProviderUnreachable(f"could not reach github token endpoint: {exc}") from exc

    payload = resp.json()
    if not isinstance(payload, dict):
        raise OIDCTokenExchangeError("github token endpoint returned a non-JSON body")
    if resp.status != 200 or "error" in payload:
        logger.warning(  # nosemgrep
            "github token exchange failed: status=%s error=%s",
            resp.status,
            payload.get("error"),
        )
        raise OIDCTokenExchangeError("github token exchange failed")
    access_token = payload.get("access_token")
    if not access_token or not isinstance(access_token, str):
        raise OIDCTokenExchangeError("github token response did not include an access_token")
    return str(access_token)


def _github_get(url: str, access_token: str) -> egress.EgressResponse:
    headers = {
        "Authorization": f"token {access_token}",
        "Accept": "application/vnd.github+json",
    }
    try:
        return egress.get(url, headers=headers)
    except egress.EgressBlocked as exc:
        raise OIDCProviderUnreachable(f"github API blocked by SSRF guard: {exc}") from exc
    except (egress.EgressTimeout, egress.EgressError) as exc:
        raise OIDCProviderUnreachable(f"could not reach github API: {exc}") from exc


def fetch_github_identity(ctx: ProviderContext, access_token: str) -> dict[str, Any]:
    """Fetch the GitHub user identity and normalize it into OIDC-shaped claims.

    Calls ``GET /user`` (profile) and ``GET /user/emails`` (to pick the verified
    primary email — GitHub's ``email_verified`` analog is the ``verified`` flag on
    the primary entry) through egress, and — if the policy restricts an org —
    verifies membership fail-closed. Returns a claims dict mirroring the OIDC
    shape (``sub``/``email``/``email_verified``/``given_name``) so ``resolve_user``
    is provider-agnostic. ``sub`` is the GitHub numeric user id as a string
    (stable; never the mutable login/email).

    Raises:
        OIDCIDTokenError: the ``/user`` response was malformed or had no id.
        OIDCEmailUnverified: no verified primary email is available.
        OIDCNoMember: org restriction set and the user is not a member.
        OIDCProviderUnreachable: the GitHub API could not be reached.
    """
    resp = _github_get(GITHUB_USER_URL, access_token)
    if resp.status != 200:
        raise OIDCTokenExchangeError(f"github /user returned HTTP {resp.status}")
    profile = resp.json()
    if not isinstance(profile, dict) or not profile.get("id"):
        raise OIDCIDTokenError("github /user response is malformed or has no id")

    # Optional org restriction — fail closed if the user is not a member.
    org = (ctx.policy.github_org or "").strip()
    if org:
        login = str(profile.get("login") or "")
        if not login or not _github_user_in_org(access_token, org=org, username=login):
            raise OIDCNoMember("github user is not a member of the required organization")

    email, email_verified = _github_primary_email(access_token, profile)

    name = str(profile.get("name") or "")
    given_name = name.split(" ", 1)[0] if name else ""
    family_name = name.split(" ", 1)[1] if " " in name else ""

    return {
        "sub": str(profile["id"]),
        "email": email,
        "email_verified": email_verified,
        "given_name": given_name,
        "family_name": family_name,
    }


def _github_primary_email(access_token: str, profile: dict[str, Any]) -> tuple[str, bool]:
    """Return ``(email, verified)`` from the user's verified primary GitHub email.

    Prefers ``GET /user/emails`` (authoritative on primary + verified). Falls back
    to the profile's public ``email`` only when the emails endpoint is unavailable,
    in which case ``verified`` is unknown → reported ``False`` so the fail-closed
    verified-email gate rejects it.
    """
    resp = _github_get(GITHUB_EMAILS_URL, access_token)
    if resp.status == 200:
        emails = resp.json()
        if isinstance(emails, list):
            for entry in emails:
                if isinstance(entry, dict) and entry.get("primary"):
                    return str(entry.get("email") or ""), bool(entry.get("verified"))
    # Fallback: the public profile email, treated as unverified (fail closed).
    return str(profile.get("email") or ""), False


def _github_user_in_org(access_token: str, *, org: str, username: str) -> bool:
    """Whether ``username`` is a member of GitHub org ``org`` (fail closed).

    Uses ``GET /orgs/{org}/members/{username}`` — 204 = member, anything else
    (404/302/403) = not a member / not visible. Any transport error propagates as
    :class:`OIDCProviderUnreachable` from ``_github_get``, so the caller fails
    closed rather than admitting on an ambiguous result.
    """
    resp = _github_get(f"https://api.github.com/orgs/{org}/members/{username}", access_token)
    return resp.status == 204


# ---------------------------------------------------------------------------
# Identity resolution + account rules
# ---------------------------------------------------------------------------


def _domain_allowed(policy: SsoProviderPolicy, email: str) -> bool:
    """Whether ``email``'s domain is in the policy allow-list.

    Empty allow-list = fail closed (no domain permitted). This forces an admin to
    name the domains that may sign in / be created before any account is linked,
    and is the takeover gate alongside ``email_verified``.
    """
    domains = [d.lower() for d in (policy.allowed_email_domains or [])]
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


def _require_active(user: Any, ctx: ProviderContext) -> Any:
    """Refuse a resolved-but-deactivated account before a session is minted (#2875).

    ``User.is_active = False`` **is** the deactivation mechanism —
    ``workspace/views.py::_apply_member_status_change`` sets it as the thing that
    stops a member logging in — and every other credential path in the auth chain
    honors it: simplejwt rejects an inactive user, DRF's ``SessionAuthentication``
    checks the flag, and the Personal Access Token authenticator was taught to in
    #2832. The SSO callback was the one login path with no reference to it at all,
    so a revoked account ran the entire handshake and was issued a **fresh refresh
    token after the admin revoked it**.

    ``JWTAuthentication`` refuses the inactive user on every subsequent request, so
    this is defense in depth rather than privilege escalation. It still has to be
    fixed here: a login that reports success and is then 401ed on every call is
    indistinguishable from a broken install, and the refusal belongs where the
    credential is issued rather than where it is spent.

    Only the two branches that resolve a **pre-existing** user need this. The
    auto-create branch builds the user in this request, so it is active by
    construction — guarding it would be dead code.

    The refusal is **logged, not audited**. Repeated SSO attempts against a revoked
    account is exactly the signal an operator wants after an off-boarding, and
    before this fix there was nothing distinctive to record because the login simply
    succeeded. It is a log line rather than an ``AuditEvent`` row because the caller
    is unauthenticated at this point: an audit row per attempt would let anyone who
    can drive the callback write unbounded rows, the same amplification the Personal
    Access Token authenticator bounds deliberately. The record carries the user's
    primary key, never their email or any token material.
    """
    if not user.is_active:
        logger.warning(
            "sso login refused: account is deactivated (user_id=%s provider=%s issuer=%s)",
            user.pk,
            ctx.slug,
            ctx.issuer,
        )
        raise OIDCAccountDisabled("account is deactivated")
    return user


@transaction.atomic
def resolve_user(ctx: ProviderContext, claims: dict[str, Any]) -> tuple[Any, bool]:
    """Resolve (and possibly create/link) the local user for a validated identity.

    Resolution order (ADR-0517 §3.2, preserving ADR-0187 §2):

    1. **Durable key** — an existing ``SocialAccount`` on ``(provider=slug, uid=sub)``
       **whose stored issuer matches the current provider issuer** wins outright.
       Later logins always route here, never by email. The provider slug
       disambiguates distinct OIDC IdPs that share allauth's ``openid_connect``
       type; the ``(issuer, subject)`` pair is the real durable key (ADR-0187 §2 /
       ADR-0517 §3.1). Requiring the issuer match on resolve — not just storing it
       at bind time — closes a cross-issuer ``sub``-collision takeover: an admin who
       repoints a slug to a new issuer must not let a user at the new issuer whose
       ``sub`` collides with an old binding resolve to the wrong local user. On
       issuer mismatch we **fail closed** (``OIDCNoMember``) rather than fall
       through, because allauth's ``(provider, uid)`` unique key means a second
       binding for the same ``(slug, subject)`` under the new issuer cannot be
       created anyway.
    2. **Verified email** — require ``email`` present and ``email_verified is True``
       and the domain in the allow-list; otherwise fail closed.
    3. **Link** — exactly one existing local user with that email → bind a new
       ``SocialAccount`` and sign in. (Ambiguous: 0 or >1 → not a link.)
    4. **Auto-create** — no existing user, ``auto_create_members`` on → create the
       user + one ``WorkspaceMembership`` at the resolved role, bind the identity.
    5. Otherwise → :class:`OIDCNoMember`.

    Branches 1 and 3 additionally refuse a **deactivated** account with
    :class:`OIDCAccountDisabled` (see :func:`_require_active`, #2875) — the SSO
    callback was the one login path that never consulted ``is_active``.

    Returns ``(user, created)``. Wrapped in a transaction so a half-created
    user/membership/identity never persists.
    """
    from allauth.socialaccount.models import SocialAccount

    provider_key = ctx.slug
    issuer = ctx.issuer
    subject = str(claims.get("sub") or "")
    if not subject:
        raise OIDCIDTokenError("identity has no subject")

    # 1. Durable identity — resolve by the stable (issuer, subject) pair, never the
    # mutable email. The (provider=slug, uid=subject) row is only trusted when its
    # stored issuer matches the current provider issuer: a slug repointed to a new
    # issuer must not resolve a colliding ``sub`` to the old issuer's user (takeover
    # defense). On mismatch we **fail closed** below rather than falling through to
    # the verified-email path, because allauth's (provider, uid) unique key means a
    # second binding under the new issuer could not be created anyway. For GitHub
    # the issuer is the fixed GITHUB_ISSUER constant, so bindings still match.
    account = (
        SocialAccount.objects.select_related("user")
        .filter(provider=provider_key, uid=subject)
        .first()
    )
    if account is not None:
        if account.extra_data.get("iss") == issuer:
            return _require_active(account.user, ctx), False
        # (provider=slug, uid=subject) is already bound to a DIFFERENT issuer. We
        # must never resolve to the old issuer's user (cross-issuer sub-collision
        # takeover), and — because allauth's SocialAccount key is (provider, uid),
        # with the issuer disambiguator only in extra_data — we cannot create a
        # second binding for the same (slug, subject) under the new issuer either.
        # Fail closed.
        raise OIDCNoMember("subject is bound to a different issuer for this provider")

    # 2. Verified-email gate.
    email = (claims.get("email") or "").strip()
    if not email or claims.get("email_verified") is not True:
        raise OIDCEmailUnverified("IdP did not assert a verified email")
    if not _domain_allowed(ctx.policy, email):
        raise OIDCNoMember("email domain is not permitted")

    # 3. Link to an existing local account (only when unambiguous).
    existing = list(User.objects.filter(email__iexact=email)[:2])
    if len(existing) == 1:
        # Checked BEFORE the binding is written: a refused login must not leave a
        # SocialAccount row behind, or reactivating the member later would silently
        # skip the verified-email link step that created it.
        _require_active(existing[0], ctx)
        SocialAccount.objects.create(
            user=existing[0], provider=provider_key, uid=subject, extra_data={"iss": issuer}
        )
        return existing[0], False
    if len(existing) > 1:
        # Email is not unique in Django's auth model; an ambiguous match must not
        # silently pick one account (takeover risk). Fail closed.
        raise OIDCNoMember("ambiguous account for email")

    # 4. Auto-create.
    if not ctx.policy.auto_create_members:
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

    role = oidc_role_for(claims, ctx.policy)
    WorkspaceMembership.objects.create(
        workspace=ctx.policy.workspace,
        user=user,
        role=role,
        status=MemberStatus.ACTIVE,
    )
    SocialAccount.objects.create(
        user=user, provider=provider_key, uid=subject, extra_data={"iss": issuer}
    )

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
        metadata={"via": "sso", "issuer": issuer, "provider": provider_key},
    )
    return user, True


# ---------------------------------------------------------------------------
# Removal impact — what an admin is about to break (#2874)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RemovalImpact:
    """What removing one provider costs, surfaced to the admin before they confirm.

    ``locked_out_accounts`` is the number that matters: members whose **only**
    sign-in method is this provider's binding.
    """

    linked_accounts: int
    locked_out_accounts: int


def removal_impact(slugs: list[str]) -> dict[str, RemovalImpact]:
    """Per-slug removal impact for every slug in ``slugs`` (#2874).

    Why this has to exist: the DELETE path purges the provider's ``SocialAccount``
    rows, and that purge is **load-bearing** — it is exactly what lets users
    re-link by verified email when an admin follows the documented remove-and-re-add
    route to move a provider to a new issuer. Keeping the rows instead would leave
    every binding stamped with the old ``iss``, and ``resolve_user`` would fail
    them closed forever.

    The cost of that purge is a member who has no other credential.
    :func:`resolve_user` calls ``set_unusable_password()`` on every JIT-created
    user, and ``core/password_reset.py`` gates the request path on
    ``has_usable_password()`` — so an SSO-only account receives the
    anti-enumeration 200 and no email. Until the provider (or another configured
    provider that admits their email domain) is set up again they cannot sign in by
    any route, and no admin set-password endpoint exists. That is a real,
    unrecoverable-by-self-service state, so the admin has to be given the number
    before they confirm it.

    "No other sign-in method" means: no usable local password, **and** no surviving
    binding to any *other* still-configured provider. Deactivated accounts are
    excluded — they cannot sign in either way, so counting them would inflate the
    warning and train admins to ignore it.

    Costs **two queries regardless of how many providers are configured**: the
    bindings and the credential-less user set are each fetched once and paired in
    Python, rather than running a per-slug aggregate that would make the admin list
    page's query count scale with the registry.
    """
    from allauth.socialaccount.models import SocialAccount
    from django.contrib.auth.hashers import UNUSABLE_PASSWORD_PREFIX
    from django.db.models import Q

    wanted = list(slugs)
    if not wanted:
        return {}

    # Scope the bindings to *configured* providers: a leftover row for a provider
    # that no longer exists is not a sign-in method, so it must not count as the
    # "other" credential that makes a user safe to strand.
    configured = list(SsoProviderPolicy.objects.values_list("slug", flat=True))
    bindings = list(
        SocialAccount.objects.filter(provider__in=configured).values_list("user_id", "provider")
    )

    per_user: dict[Any, set[str]] = {}
    for user_id, provider in bindings:
        per_user.setdefault(user_id, set()).add(provider)

    # The DB-pushable subset of ``has_usable_password()``: the two shapes this
    # codebase actually produces — ``set_unusable_password()``'s "!"-prefixed
    # sentinel and an empty column. Django additionally treats a hash no hasher can
    # parse as unusable; such a value would be missed here, which under-counts (the
    # admin is warned about fewer members than are really stranded) rather than
    # over-counts. Accepted: no code path in this repo writes a malformed hash, and
    # pulling every bound user into Python to call ``has_usable_password()`` would
    # trade a real per-request cost for a state that cannot occur.
    credential_less = set(
        User.objects.filter(
            Q(password="") | Q(password__startswith=UNUSABLE_PASSWORD_PREFIX),
            pk__in=list(per_user),
            is_active=True,
        ).values_list("pk", flat=True)
    )

    linked = dict.fromkeys(wanted, 0)
    locked_out = dict.fromkeys(wanted, 0)
    for user_id, providers in per_user.items():
        sole_binding = len(providers) == 1
        strands = sole_binding and user_id in credential_less
        for provider in providers:
            if provider not in linked:
                continue
            linked[provider] += 1
            if strands:
                locked_out[provider] += 1

    return {
        slug: RemovalImpact(linked_accounts=linked[slug], locked_out_accounts=locked_out[slug])
        for slug in wanted
    }


# ---------------------------------------------------------------------------
# Test connection (admin)
# ---------------------------------------------------------------------------


def check_provider_reachability(ctx: ProviderContext) -> dict[str, Any]:
    """Probe a provider's reachability for the admin "Test connection" button.

    OIDC: fetch discovery (cache-bypassed) + confirm JWKS reachability. GitHub:
    confirm the token endpoint host is reachable (a HEAD-equivalent GET of the API
    root). Never raises — returns a structured ``{ok, ...}`` result so the admin
    page can render a clear pass/fail.
    """
    if ctx.is_github:
        return _check_github_reachability()
    return _check_oidc_reachability(ctx.issuer)


def _check_oidc_reachability(issuer_url: str) -> dict[str, Any]:
    cache.delete(_DISCOVERY_KEY_PREFIX + issuer_url)
    try:
        doc = get_discovery_document(issuer_url)
    except OIDCError as exc:
        return {"ok": False, "issuer": issuer_url, "error": exc.code, "detail": str(exc)}

    jwks_uri = doc.get("jwks_uri", "")
    # Deliberately its own egress call rather than ``_fetch_jwks``: "Test
    # connection" must prove the endpoint is reachable *now* (a cached hit would
    # report a healthy provider whose keys endpoint has since died), and it must
    # not populate the login path's cache from a probe. It also keeps the probe's
    # own error taxonomy, which folds a non-200 into ``jwks_empty`` — for an admin
    # "the keys are not usable" and "the keys are not there" need the same fix.
    try:
        egress.assert_url_allowed(jwks_uri)
        jwks_resp = egress.get(jwks_uri, headers={"Accept": _ACCEPT_JSON})
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


def _check_github_reachability() -> dict[str, Any]:
    try:
        egress.assert_url_allowed(GITHUB_USER_URL)
        resp = egress.get(GITHUB_USER_URL)
    except (egress.EgressBlocked, egress.EgressTimeout, egress.EgressError) as exc:
        return {
            "ok": False,
            "issuer": GITHUB_ISSUER,
            "error": "github_unreachable",
            "detail": str(exc),
        }
    # An unauthenticated GET /user returns 401 — that still proves the endpoint is
    # reachable (which is all "test connection" verifies before credentials are used).
    if resp.status in (200, 401):
        return {
            "ok": True,
            "issuer": GITHUB_ISSUER,
            "endpoints": {
                "authorization_endpoint": GITHUB_AUTHORIZE_URL,
                "token_endpoint": GITHUB_TOKEN_URL,
                "jwks_uri": "",
            },
        }
    return {"ok": False, "issuer": GITHUB_ISSUER, "error": "github_unreachable"}
