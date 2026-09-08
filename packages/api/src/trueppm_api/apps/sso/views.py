"""Multi-provider SSO endpoints (ADR-0517 §3.4–3.5, supersedes ADR-0187 §2–3).

Two groups:

- **Unauthenticated flow** (pre-session): ``discover`` (domain probe, no
  enumeration leak, now returning the *list* of enabled providers), ``login``
  (302 to the chosen IdP with state/PKCE/nonce), and ``callback`` (validate, mint
  the existing cookie-JWT session, 302 to the SPA). The callback path is
  **unchanged** for every provider — a ``slug`` stored in the login state (not a
  new URL segment) disambiguates which ``SocialApp`` is completing, so the OTel
  ``code``/``state`` redaction rule and operator IdP allow-lists keep matching
  (ADR-0517 §3.5).
- **Admin config** (``IsWorkspaceAdminStrict``): the ``/workspace/sso/providers/``
  collection (list/create), item (get/update/delete by slug), and
  ``test-connection``. Strict (ADMIN on *all* methods, reads included) because
  even a GET exposes the org's IdP topology.

The callback never puts a token in the URL: it sets the hardened httpOnly refresh
cookie via the existing ``_set_refresh_cookie`` and 302s the browser to the SPA
completion route, which then calls the existing ``/auth/token/refresh/``.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.db import IntegrityError
from django.http import HttpResponse, HttpResponseRedirect
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.permissions import SAFE_METHODS, AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.sso import services
from trueppm_api.apps.sso.models import SsoProviderPolicy
from trueppm_api.apps.sso.serializers import (
    SsoDiscoverResponseSerializer,
    SsoProviderReadSerializer,
    SsoProviderWriteSerializer,
    SsoTestConnectionResponseSerializer,
)
from trueppm_api.apps.workspace.models import AuditEventType, Workspace
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdminStrict
from trueppm_api.core.auth_views import (
    _apply_remember,
    _cookie_seconds,
    _set_refresh_cookie,
    emit_login_success,
)
from trueppm_api.core.constant_time import constant_time_equal

logger = logging.getLogger("trueppm.sso")

# Trailing slash matches the route in ``urls.py`` so the IdP returns straight to
# the view without an APPEND_SLASH redirect hop dropping the query. UNCHANGED for
# every provider (ADR-0517 §3.5) — OTel redaction + operator allow-lists depend
# on this exact path.
_CALLBACK_PATH = "/api/v1/auth/oidc/callback/"

# Browser-binding cookie for the OIDC/OAuth ``state``. The server-side single-use
# state only proves *we* minted the value; it does not prove the *same browser*
# that began the flow is the one completing it. Without this binding, an attacker
# who completes login at their own IdP account could hand the resulting
# ``?state=&code=`` callback URL to a victim and silently sign the victim into the
# attacker's account (login CSRF / session fixation). The callback therefore also
# requires the ``state`` query param to equal the value stored in this cookie.
# ``SameSite=Lax`` (not Strict) is required: the callback arrives as a top-level
# GET navigation from the IdP origin, which Strict would strip. Path-scoped to the
# OIDC routes so it is never attached to ordinary API calls.
_STATE_COOKIE_NAME = "trueppm_oidc_state"
_STATE_COOKIE_PATH = "/api/v1/auth/oidc/"


def _set_state_cookie(response: HttpResponse, state: str) -> None:
    response.set_cookie(
        key=_STATE_COOKIE_NAME,
        value=state,
        max_age=int(getattr(settings, "OIDC_STATE_TTL_SECONDS", 300)),
        httponly=True,
        secure=settings.AUTH_REFRESH_COOKIE_SECURE,
        samesite="Lax",
        path=_STATE_COOKIE_PATH,
    )


def _clear_state_cookie(response: HttpResponse) -> None:
    response.delete_cookie(key=_STATE_COOKIE_NAME, path=_STATE_COOKIE_PATH, samesite="Lax")


def _derive_redirect_uri(request: Request) -> str:
    """The redirect_uri sent to the IdP and shown read-only in the admin page.

    Prefers the explicit ``TRUEPPM_PUBLIC_API_BASE_URL`` (so the value the operator
    allow-lists is deterministic behind a proxy); falls back to the request's
    absolute URI for zero-config single-origin dev. The exact string is stored in
    the login state and replayed at the token endpoint, so it always matches. It is
    the **same path for every provider** (ADR-0517 §3.5).
    """
    base = (getattr(settings, "TRUEPPM_PUBLIC_API_BASE_URL", "") or "").rstrip("/")
    if base:
        return f"{base}{_CALLBACK_PATH}"
    return request.build_absolute_uri(_CALLBACK_PATH)


def _spa_completion_url(error: str | None = None) -> str:
    """The SPA route the callback redirects to (optionally with a non-sensitive code)."""
    base = (getattr(settings, "FRONTEND_BASE_URL", "") or "").rstrip("/")
    url = f"{base}/auth/sso/complete"
    if error:
        url = f"{url}?error={error}"
    return url


class OIDCDiscoverView(APIView):
    """``GET /auth/oidc/discover?email=`` — which enabled providers this domain uses.

    Domain-level only: it never touches the user table and never reveals whether
    an account exists (no enumeration leak). With an ``email`` it returns the
    enabled providers whose domain allow-list admits that address; without one it
    returns every enabled provider (for a login screen that renders a button per
    provider). Always 200.
    """

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "oidc_discover"

    @extend_schema(
        summary="Discover which SSO providers are available (optionally for an email domain)",
        parameters=[OpenApiParameter("email", str, OpenApiParameter.QUERY, required=False)],
        responses={200: SsoDiscoverResponseSerializer},
        auth=[],
        tags=["auth"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        email = (request.query_params.get("email") or "").strip()
        if email:
            matched = services.domain_matches_any_enabled(email)
            contexts = [matched] if matched is not None else []
        else:
            contexts = services.get_enabled_providers()
        providers = [{"slug": c.slug, "display_name": c.display_name} for c in contexts]
        payload = {"provider_present": bool(providers), "providers": providers}
        return Response(SsoDiscoverResponseSerializer(payload).data)


class OIDCLoginView(APIView):
    """``GET /auth/oidc/login?provider=<slug>`` — start the flow for one provider."""

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "oidc_login"

    @extend_schema(
        summary="Begin SSO login for a provider (redirects to the IdP)",
        parameters=[OpenApiParameter("provider", str, OpenApiParameter.QUERY, required=False)],
        responses={
            302: OpenApiResponse(description="Redirect to the IdP authorization endpoint."),
        },
        auth=[],
        tags=["auth"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> HttpResponse:
        ctx = self._resolve_provider(request)
        if ctx is None:
            return HttpResponseRedirect(_spa_completion_url(error="sso_not_configured"))
        try:
            result = services.start_login(ctx, redirect_uri=_derive_redirect_uri(request))
        except services.OIDCError as exc:
            return HttpResponseRedirect(_spa_completion_url(error=exc.code))
        # Bind the state to this browser (login-CSRF / session-fixation defense).
        response = HttpResponseRedirect(result.authorization_url)
        _set_state_cookie(response, result.state)
        return response

    def _resolve_provider(self, request: Request) -> services.ProviderContext | None:
        """Resolve the provider from ``?provider=<slug>``, or the sole enabled one.

        Explicit slug wins. With no slug, fall back to the single enabled provider
        (the common single-IdP install) — otherwise the caller must disambiguate.
        """
        slug = (request.query_params.get("provider") or "").strip()
        if slug:
            return services.get_provider_for_slug(slug)
        enabled = services.get_enabled_providers()
        return enabled[0] if len(enabled) == 1 else None


class OIDCCallbackView(APIView):
    """``GET /auth/oidc/callback?code=&state=`` — complete the flow, mint the session.

    On success: validate state (single-use, browser-bound) → resolve the provider
    from the ``slug`` stored in the state → exchange code → (OIDC) validate ID
    token / (GitHub) fetch userinfo → resolve/link/create the user → **refuse a
    deactivated account** → set the httpOnly refresh cookie → 302 to the SPA
    completion route (no token in the URL). On any failure: 302 to the SPA
    completion route with a non-sensitive ``error`` code.
    """

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "oidc_callback"

    def _redirect(self, *, error: str | None = None) -> HttpResponse:
        """Redirect to the SPA completion route, always clearing the state cookie."""
        response = HttpResponseRedirect(_spa_completion_url(error=error))
        _clear_state_cookie(response)
        return response

    @extend_schema(
        summary="SSO callback (sets the refresh cookie, redirects to the SPA)",
        parameters=[
            OpenApiParameter("code", str, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("state", str, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("error", str, OpenApiParameter.QUERY, required=False),
        ],
        responses={302: OpenApiResponse(description="Redirect to the SPA completion route.")},
        auth=[],
        tags=["auth"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> HttpResponse:
        # The IdP can redirect back with an error (e.g. user denied consent).
        idp_error = request.query_params.get("error")
        if idp_error:
            return self._redirect(error="access_denied")

        # SSO entirely off → fail closed before touching state.
        if not services.get_enabled_providers():
            return self._redirect(error="sso_not_configured")

        code = request.query_params.get("code") or ""
        state = request.query_params.get("state") or ""
        if not code or not state:
            return self._redirect(error="invalid_request")

        # Browser-binding check: the state query param must match the cookie set at
        # /login for this browser. consume_state proves we issued the state; the
        # cookie proves the same browser began the flow (login-CSRF defense).
        # Constant-time compare avoids leaking a match via timing. Both sides are
        # caller-controlled here — a query parameter and a cookie — so the compare
        # goes through core.constant_time, which compares bytes and therefore
        # cannot raise on non-ASCII the way compare_digest does on str (#2929).
        cookie_state = request.COOKIES.get(_STATE_COOKIE_NAME) or ""
        if not cookie_state or not constant_time_equal(cookie_state, state):
            return self._redirect(error="invalid_state")

        try:
            stored = services.consume_state(state)
            ctx = services.get_provider_for_slug(str(stored.get("slug") or ""))
            if ctx is None:
                return self._redirect(error="sso_not_configured")
            claims = self._complete(ctx, code=code, stored=stored)
            user, _created = services.resolve_user(ctx, claims)
        except services.OIDCError as exc:
            return self._redirect(error=exc.code)

        # Mint the existing cookie-JWT session — no new token surface (ADR-0517 §3.3).
        # SSO logins are always session-scoped (#2246): there is no "remember me"
        # checkbox in an IdP redirect, and the operator's IdP owns device trust, so
        # defaulting an unattended redirect to a 30-day persistent cookie would be the
        # wrong safe default. A session cookie (dies on browser close) + short exp.
        refresh = RefreshToken.for_user(user)
        _apply_remember(refresh, remember=False)
        response = self._redirect()
        _set_refresh_cookie(
            response,  # type: ignore[arg-type]  # HttpResponseRedirect; set_cookie is shared
            str(refresh),
            persistent_seconds=_cookie_seconds(remember=False),  # None → session cookie
        )
        # AFTER the cookie is set, not after resolve_user (#3552, ADR-1120): the session
        # is what succeeded. Emitted on ``trueppm.auth`` — not this module's
        # ``trueppm.sso`` logger — so an operator correlating "who got in" against
        # ``auth.login_failed`` reads one channel and does not have to know which door
        # the user came through. ``remember`` is always False here: an IdP redirect
        # carries no such choice, which is the same reason ``_apply_remember`` is called
        # with False above.
        emit_login_success(request, user=user, method=f"sso:{ctx.slug}", remember=False)
        return response

    def _complete(
        self, ctx: services.ProviderContext, *, code: str, stored: dict[str, Any]
    ) -> dict[str, Any]:
        """Run the provider-specific exchange and return normalized claims."""
        redirect_uri = stored["redirect_uri"]
        if ctx.is_github:
            access_token = services.exchange_github_code(ctx, code=code, redirect_uri=redirect_uri)
            return services.fetch_github_identity(ctx, access_token)
        doc = services.get_discovery_document(ctx.issuer)
        tokens = services.exchange_code(
            ctx, doc, code=code, redirect_uri=redirect_uri, verifier=stored["verifier"]
        )
        return services.validate_id_token(
            ctx, doc, tokens["id_token"], expected_nonce=stored["nonce"]
        )


# ---------------------------------------------------------------------------
# Admin config — collection under /workspace/sso/providers/ (ADR-0517 §3.4)
# ---------------------------------------------------------------------------


def _policy_or_none(slug: str) -> SsoProviderPolicy | None:
    return (
        SsoProviderPolicy.objects.select_related("social_app")
        .filter(workspace=Workspace.load(), slug=slug)
        .first()
    )


# Query flag an admin must send to remove a provider that is somebody's only way in
# (#2874). A query parameter rather than a body field because DELETE bodies are not
# reliably forwarded by proxies and are not part of this collection's request shape.
_CONFIRM_LOCKOUT_PARAM = "confirm_lockout"

# The one constraint POST is allowed to translate into a 409 (see ``post``).
_SLUG_UNIQUE_CONSTRAINT = "uniq_sso_policy_workspace_slug"


class _SsoProviderWriteThrottle(ScopedRateThrottle):
    """The ``sso_provider_write`` scope, applied to mutating methods only (#3552).

    ``ScopedRateThrottle`` normally caps every method on the view. That is wrong here:
    the collection GET backs the admin page — which the SPA re-reads on navigation and
    after each save — while it is the *writes* that need bounding, because each accepted
    write appends a row to an audit table with no OSS retention (ADR-1120). Capping reads
    at a write rate would break the page to fix the disk.
    """

    scope = "sso_provider_write"

    def allow_request(self, request: Request, view: APIView) -> bool:
        if request.method in SAFE_METHODS:
            return True
        return bool(super().allow_request(request, view))


# Provider fields whose change is recorded in an ``sso_provider_updated`` diff (#3552,
# ADR-1120). This is the **writable surface of the serializer**, minus the secret — not
# ``SsoProviderPolicy._meta.fields``: ``server_url``, ``client_id`` and ``display_name``
# live on the linked ``SocialApp``, so a model-derived list would silently exempt the
# three fields that most change who can sign in.
#
# ``client_id`` is here because it determines which OAuth client the install presents
# itself as; paired with a secret rotation it is a complete credential swap, and without
# it the log would show "a secret was rotated" and never that the client identity moved
# underneath it. It is not secret material — the read serializer already exposes it.
#
# ``allow_password_signin`` is deliberately absent: the OSS write serializer rejects the
# field outright, so in this edition it cannot change. Whoever makes it writable in
# Enterprise must add it here by hand — the test below enumerates the *serializer's*
# writable fields, and that field is already declared, so nothing will fail on its own.
_AUDITED_PROVIDER_FIELDS = (
    "allowed_email_domains",
    "auto_create_members",
    "client_id",
    "default_role",
    "display_name",
    "enabled",
    "github_org",
    "server_url",
)

# Maximum entries kept per list value in an audit diff. ``allowed_email_domains`` has no
# length cap on either the serializer or the ArrayField, and a diff stores it twice, so an
# uncapped row is arbitrarily large in a table nothing prunes.
_MAX_AUDITED_LIST = 25


def _cap(value: Any) -> Any:
    """Truncate a list value for storage in an audit diff, marking that it was cut."""
    if isinstance(value, list) and len(value) > _MAX_AUDITED_LIST:
        return {"items": value[:_MAX_AUDITED_LIST], "total": len(value), "truncated": True}
    return value


def _actor_kind(request: Request) -> str:
    """Whether this write came from an interactive session or a Personal Access Token.

    These views set ``permission_classes`` but not ``authentication_classes``, so they
    inherit ``OwnerScopedApiTokenAuthentication``: an Admin's ``legacy:full`` token
    authenticates here and passes ``IsWorkspaceAdminStrict`` (all three routes are listed
    in ``tests/apps/access/token_write_surface.txt``, and none of them writes an
    ``AgentAction`` row). Without this the audit row attributes a machine-driven
    credential-path change to the token's human owner, indistinguishable from that human
    sitting at a browser — on the one row that exists to answer *who did this*.

    ``request.auth`` holds an ``ApiToken`` for token auth and a simplejwt ``Token`` for an
    interactive session, so the isinstance check is the discriminator rather than a
    None-test.
    """
    from trueppm_api.apps.projects.models import ApiToken

    return "token" if isinstance(request.auth, ApiToken) else "session"


def _provider_snapshot(policy: SsoProviderPolicy) -> dict[str, Any]:
    """Current values of the audited fields, reading through to the linked SocialApp."""
    app = policy.social_app
    return {
        "allowed_email_domains": list(policy.allowed_email_domains),
        "auto_create_members": policy.auto_create_members,
        "client_id": app.client_id,
        "default_role": int(policy.default_role),
        "display_name": app.name,
        "enabled": policy.enabled,
        "github_org": policy.github_org,
        "server_url": str(app.settings.get("server_url", "")),
    }


def _record_provider_audit(
    request: Request,
    *,
    event_type: str,
    policy: SsoProviderPolicy,
    slug: str,
    metadata: dict[str, Any],
) -> None:
    """Write one SSO provider audit row (#3552, ADR-1120).

    Called only on paths that have already succeeded. That is the whole reason this
    feature never meets the ``set_rollback`` trap of ADR-0902: under ``ATOMIC_REQUESTS``
    DRF's exception handler rolls back for *every* ``APIException``, so a row written on a
    400/403/409 path is issued and silently discarded. Here a refusal simply writes
    nothing, which is also the correct record — nothing changed.

    ``metadata`` is enumerated by each caller; the secret never appears in it in any form,
    including a length, hash, or prefix.
    """
    # ``record_audit_event`` is imported at call time, matching ``sso/services.py`` and
    # ``projects/views.py::_record_project_audit_event``: the sso→workspace dependency is
    # one-way and stays that way at module level. (``AuditEventType`` is a plain enum on
    # ``workspace.models``, which this module already imports for ``Workspace``, so it
    # needs no deferral.)
    from trueppm_api.apps.workspace.services import record_audit_event

    record_audit_event(
        event_type=event_type,
        actor=request.user,
        target_type="sso_provider",
        target_id=policy.pk,
        target_label=slug,
        metadata={**metadata, "actor_kind": _actor_kind(request)},
    )


def _is_duplicate_slug(exc: IntegrityError) -> bool:
    """Whether ``exc`` is the ``(workspace, slug)`` unique-constraint collision.

    psycopg exposes the violated constraint's name on the wrapped driver error, so
    match on that rather than assuming every integrity failure in ``create()`` is a
    duplicate provider. The message fallback covers backends (and re-raised wrappers)
    that carry no ``diag``; PostgreSQL always names the constraint in the text.
    """
    constraint = getattr(getattr(exc.__cause__, "diag", None), "constraint_name", None)
    if constraint:
        return bool(constraint == _SLUG_UNIQUE_CONSTRAINT)
    return _SLUG_UNIQUE_CONSTRAINT in str(exc)


class SsoProviderCollectionView(IdempotencyMixin, APIView):
    """``/workspace/sso/providers/`` — list (GET) and create (POST) providers.

    ``IsWorkspaceAdminStrict`` on every method: even a GET discloses IdP topology
    (issuers, client ids, allowed domains), so reads are ADMIN-gated exactly like
    writes.
    """

    permission_classes = [IsWorkspaceAdminStrict]
    # Writes bounded at 20/min (#3552); the list GET is deliberately unthrottled by this
    # scope — see ``_SsoProviderWriteThrottle``.
    throttle_classes = [_SsoProviderWriteThrottle]
    # Exempt from the generic Idempotency-Key path (ADR-0170): create keys on the
    # unique (workspace, slug) constraint, so a replayed POST 409s. That was true of
    # the constraint but not of the response until #2875 — nothing mapped the
    # resulting IntegrityError, so it surfaced as a 500. ``post`` now translates it.
    idempotency_exempt = True

    def _read(self, policy: SsoProviderPolicy, request: Request) -> dict[str, Any]:
        return SsoProviderReadSerializer(
            policy,
            context={
                "redirect_uri": _derive_redirect_uri(request),
                "removal_impact": services.removal_impact([policy.slug]),
            },
        ).data

    @extend_schema(
        summary="List configured SSO providers",
        responses={200: SsoProviderReadSerializer(many=True)},
        tags=["workspace"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        policies = list(
            SsoProviderPolicy.objects.select_related("social_app").filter(
                workspace=Workspace.load()
            )
        )
        # One impact map for the whole collection: ``removal_impact`` is two queries
        # for any number of slugs, so building it here keeps the list endpoint flat
        # instead of paying two queries per row.
        context = {
            "redirect_uri": _derive_redirect_uri(request),
            "removal_impact": services.removal_impact([p.slug for p in policies]),
        }
        return Response([SsoProviderReadSerializer(p, context=context).data for p in policies])

    @extend_schema(
        summary="Add an SSO provider (secret write-only; sending it stores it)",
        request=SsoProviderWriteSerializer,
        responses={
            201: SsoProviderReadSerializer,
            409: OpenApiResponse(description="A provider of this type is already configured."),
        },
        tags=["workspace"],
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = SsoProviderWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            policy = serializer.save()
        except IntegrityError as exc:
            # The unique (workspace, slug) constraint is the collision key — this
            # class's own comment claimed "a replayed POST 409s naturally", but
            # nothing maps IntegrityError, so it escaped as a 500 (#2875). Caught
            # here rather than pre-checked with an ``exists()`` because the
            # constraint is the only race-free arbiter, matching the established
            # pattern at ``projects/services.py`` (#1349).
            #
            # Narrowed to that one constraint on purpose. ``create()`` also writes a
            # SocialApp and an M2M row against Site, so a bare ``except`` would
            # rebrand an unrelated fault (a stale SITE_ID's FK, a constraint added
            # later) as "already configured" — a plausible but wrong diagnosis with
            # no trace left for whoever has to debug it. Anything else is logged and
            # re-raised as the server error it is.
            if not _is_duplicate_slug(exc):
                logger.exception("sso provider create failed on an unexpected constraint")
                raise
            # ``slug`` IS the provider type, so this also reports the real
            # limitation: one provider per registry type per workspace, which means
            # two Keycloak realms cannot both be configured. Say so plainly rather
            # than emitting a bare conflict.
            return Response(
                {
                    "detail": (
                        "A provider of this type is already configured. Each provider type "
                        "can be configured once; edit the existing one instead."
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )
        # NOTE: no audit row is written on the 409 branch above, and none may ever be.
        # That branch runs with the connection in an aborted-transaction state after the
        # IntegrityError, so *any* statement issued there raises TransactionManagementError
        # and turns a correct 409 into a 500. It is also the right record: a refused create
        # changed nothing (#3552, ADR-1120).
        _record_provider_audit(
            request,
            event_type=AuditEventType.SSO_PROVIDER_CREATED,
            policy=policy,
            slug=policy.slug,
            metadata={
                "config": {k: _cap(v) for k, v in _provider_snapshot(policy).items()},
                # Whether a client secret was supplied at creation — never the value, its
                # length, or any hash of it.
                "secret_set": policy.secret_set,
            },
        )
        return Response(self._read(policy, request), status=status.HTTP_201_CREATED)


class SsoProviderDetailView(IdempotencyMixin, APIView):
    """``/workspace/sso/providers/{slug}/`` — get/update/delete one provider."""

    permission_classes = [IsWorkspaceAdminStrict]
    # PUT/DELETE bounded at 20/min (#3552); the detail GET is not — see
    # ``_SsoProviderWriteThrottle``.
    throttle_classes = [_SsoProviderWriteThrottle]
    idempotency_exempt = True

    def _read(self, policy: SsoProviderPolicy, request: Request) -> dict[str, Any]:
        return SsoProviderReadSerializer(
            policy,
            context={
                "redirect_uri": _derive_redirect_uri(request),
                "removal_impact": services.removal_impact([policy.slug]),
            },
        ).data

    @extend_schema(
        summary="Get one SSO provider configuration",
        responses={200: SsoProviderReadSerializer},
        tags=["workspace"],
    )
    def get(self, request: Request, slug: str, *args: Any, **kwargs: Any) -> Response:
        policy = _policy_or_none(slug)
        if policy is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        return Response(self._read(policy, request))

    @extend_schema(
        summary="Update an SSO provider (secret write-only; sending it rotates)",
        request=SsoProviderWriteSerializer,
        responses={200: SsoProviderReadSerializer},
        tags=["workspace"],
    )
    def put(self, request: Request, slug: str, *args: Any, **kwargs: Any) -> Response:
        policy = _policy_or_none(slug)
        if policy is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        before = _provider_snapshot(policy)
        serializer = SsoProviderWriteSerializer(policy, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        # Read the rotation flag from ``validated_data`` rather than from the raw body:
        # a blank/absent value never validates (the field is allow_blank=False), so this
        # is true exactly when a real secret was supplied. DRF's ``save()`` passes a
        # *copy* to ``update()``, so the pop inside it leaves ``validated_data`` intact —
        # but reading it before ``save()`` keeps that from being load-bearing.
        rotated = "client_secret" in serializer.validated_data
        policy = serializer.save()
        after = _provider_snapshot(policy)

        # A change row only when something actually changed. The admin form re-submits
        # every field on every save, and this table has no OSS retention, so a row per
        # form save would accumulate rows that answer no question (#3552, ADR-1120).
        changed = {
            field: {"from": _cap(before[field]), "to": _cap(after[field])}
            for field in _AUDITED_PROVIDER_FIELDS
            if before[field] != after[field]
        }
        if changed:
            _record_provider_audit(
                request,
                event_type=AuditEventType.SSO_PROVIDER_UPDATED,
                policy=policy,
                slug=slug,
                metadata={"changed": changed},
            )
        if rotated:
            # A distinct verb rather than a ``client_secret`` entry in the diff above: the
            # value can never appear, and a diff whose values must always be redacted is a
            # diff-shaped lie the next person extending the field list would have to
            # rediscover. This row says a rotation happened and nothing whatsoever about
            # what it rotated to.
            _record_provider_audit(
                request,
                event_type=AuditEventType.SSO_SECRET_ROTATED,
                policy=policy,
                slug=slug,
                metadata={},
            )
        return Response(self._read(policy, request))

    @extend_schema(
        summary="Delete an SSO provider configuration",
        parameters=[
            OpenApiParameter(
                _CONFIRM_LOCKOUT_PARAM,
                bool,
                OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Required (`true`) when removing this provider would leave one or "
                    "more members with no way to sign in. See the 409 body's "
                    "`locked_out_account_count`."
                ),
            )
        ],
        responses={
            204: OpenApiResponse(description="Provider deleted."),
            409: OpenApiResponse(
                description="Removal would lock members out; re-send with the confirm flag."
            ),
        },
        tags=["workspace"],
    )
    def delete(self, request: Request, slug: str, *args: Any, **kwargs: Any) -> Response:
        from allauth.socialaccount.models import SocialAccount

        policy = _policy_or_none(slug)
        if policy is None:
            return Response(status=status.HTTP_404_NOT_FOUND)

        # Informed-confirmation gate (#2874). Removing a provider is unrecoverable for
        # a member whose only credential is its binding: every JIT-created user has
        # ``set_unusable_password()``, and the password-reset request path gates on
        # ``has_usable_password()``, so they get the anti-enumeration 200 and no email.
        # There is no admin set-password endpoint, so nothing short of re-adding the
        # provider (or a shell) brings them back. The admin may still do it — an
        # operator has to be able to tear down an IdP — but not without being told the
        # number first, which is what the 409 carries.
        impact = services.removal_impact([slug])[slug]
        confirmed = (request.query_params.get(_CONFIRM_LOCKOUT_PARAM) or "").lower() == "true"
        if impact.locked_out_accounts and not confirmed:
            return Response(
                {
                    "code": "sso_removal_locks_out_members",
                    "detail": (
                        f"{impact.locked_out_accounts} member(s) sign in only through this "
                        "provider and have no password, so removing it leaves them unable "
                        "to sign in at all — they cannot use the password-reset flow either. "
                        "They can sign in again if you add this provider back with the same "
                        f"issuer. Re-send with ?{_CONFIRM_LOCKOUT_PARAM}=true to confirm."
                    ),
                    "linked_account_count": impact.linked_accounts,
                    "locked_out_account_count": impact.locked_out_accounts,
                },
                status=status.HTTP_409_CONFLICT,
            )

        # Deleting the SocialApp cascades to the policy (OneToOne, CASCADE), but
        # SocialAccount has no FK to SocialApp, so the per-user bindings would
        # survive and could silently re-activate if the slug were later reused.
        # Purge them explicitly, keyed on the provider slug.
        #
        # The purge is load-bearing, not merely hygiene: it is what makes the
        # documented remove-and-re-add issuer migration work. A retained binding keeps
        # its old ``extra_data["iss"]``, and ``resolve_user`` fails an issuer mismatch
        # closed, so keeping the rows would lock every user out of the *new* issuer
        # permanently instead of letting them re-link by verified email.
        # Capture the audit payload BEFORE the cascade. Deleting the SocialApp cascades
        # to the policy, and Django's collector nulls the pk on the instances it was
        # handed, so a row assembled after this point reads a half-torn-down object
        # (#3552, ADR-1120). Both impact counts are recorded: the delete destroys
        # ``linked_accounts`` federated credentials, of which the locked-out set is a
        # strict subset, and recording only the smaller number understates the blast
        # radius on the sole record of an unrecoverable action. Both stay counts —
        # naming the affected members in an audit row is a privacy call not taken here.
        _record_provider_audit(
            request,
            event_type=AuditEventType.SSO_PROVIDER_DELETED,
            policy=policy,
            slug=slug,
            metadata={
                "linked_accounts": impact.linked_accounts,
                "locked_out_accounts": impact.locked_out_accounts,
                "confirmed_lockout": confirmed,
                "config": {k: _cap(v) for k, v in _provider_snapshot(policy).items()},
            },
        )
        SocialAccount.objects.filter(provider=slug).delete()
        policy.social_app.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SsoTestConnectionView(IdempotencyMixin, APIView):
    """``POST /workspace/sso/providers/{slug}/test-connection/`` — probe reachability."""

    permission_classes = [IsWorkspaceAdminStrict]
    # Throttled: the probe triggers server-side egress (OIDC discovery + JWKS, or
    # the GitHub API), so an admin must not be able to drive unbounded outbound
    # requests. Scoped like the flow endpoints (settings ``sso_test_connection``).
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "sso_test_connection"
    # Exempt from the generic Idempotency-Key path (ADR-0170): a read-only
    # reachability probe that mutates nothing.
    idempotency_exempt = True

    @extend_schema(
        summary="Test a provider's discovery/JWKS (OIDC) or API (GitHub) reachability",
        request=None,
        responses={200: SsoTestConnectionResponseSerializer},
        tags=["workspace"],
    )
    def post(self, request: Request, slug: str, *args: Any, **kwargs: Any) -> Response:
        policy = _policy_or_none(slug)
        if policy is None:
            # Match the detail views' not-found behavior for an unknown slug.
            return Response(status=status.HTTP_404_NOT_FOUND)
        from trueppm_api.apps.sso.services import ProviderContext

        ctx = ProviderContext(social_app=policy.social_app, policy=policy)
        if not ctx.is_github and not ctx.issuer:
            return Response({"ok": False, "error": "no_issuer"})
        result = services.check_provider_reachability(ctx)
        return Response(SsoTestConnectionResponseSerializer(result).data)
