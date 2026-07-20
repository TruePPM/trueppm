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

import secrets
from typing import Any

from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
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
from trueppm_api.apps.workspace.models import Workspace
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdminStrict
from trueppm_api.core.auth_views import _apply_remember, _cookie_seconds, _set_refresh_cookie

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
    token / (GitHub) fetch userinfo → resolve/link/create the user → set the
    httpOnly refresh cookie → 302 to the SPA completion route (no token in the
    URL). On any failure: 302 to the SPA completion route with a non-sensitive
    ``error`` code.
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
        # Constant-time compare avoids leaking a match via timing.
        cookie_state = request.COOKIES.get(_STATE_COOKIE_NAME) or ""
        if not cookie_state or not secrets.compare_digest(cookie_state, state):
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


class SsoProviderCollectionView(IdempotencyMixin, APIView):
    """``/workspace/sso/providers/`` — list (GET) and create (POST) providers.

    ``IsWorkspaceAdminStrict`` on every method: even a GET discloses IdP topology
    (issuers, client ids, allowed domains), so reads are ADMIN-gated exactly like
    writes.
    """

    permission_classes = [IsWorkspaceAdminStrict]
    # Exempt from the generic Idempotency-Key path (ADR-0170): create keys on the
    # unique (workspace, slug) constraint, so a replayed POST 409s naturally.
    idempotency_exempt = True

    def _read(self, policy: SsoProviderPolicy, request: Request) -> dict[str, Any]:
        return SsoProviderReadSerializer(
            policy, context={"redirect_uri": _derive_redirect_uri(request)}
        ).data

    @extend_schema(
        summary="List configured SSO providers",
        responses={200: SsoProviderReadSerializer(many=True)},
        tags=["workspace"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        policies = SsoProviderPolicy.objects.select_related("social_app").filter(
            workspace=Workspace.load()
        )
        return Response([self._read(p, request) for p in policies])

    @extend_schema(
        summary="Add an SSO provider (secret write-only; sending it stores it)",
        request=SsoProviderWriteSerializer,
        responses={201: SsoProviderReadSerializer},
        tags=["workspace"],
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = SsoProviderWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        policy = serializer.save()
        return Response(self._read(policy, request), status=status.HTTP_201_CREATED)


class SsoProviderDetailView(IdempotencyMixin, APIView):
    """``/workspace/sso/providers/{slug}/`` — get/update/delete one provider."""

    permission_classes = [IsWorkspaceAdminStrict]
    idempotency_exempt = True

    def _read(self, policy: SsoProviderPolicy, request: Request) -> dict[str, Any]:
        return SsoProviderReadSerializer(
            policy, context={"redirect_uri": _derive_redirect_uri(request)}
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
        serializer = SsoProviderWriteSerializer(policy, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        policy = serializer.save()
        return Response(self._read(policy, request))

    @extend_schema(
        summary="Delete an SSO provider configuration",
        responses={204: OpenApiResponse(description="Provider deleted.")},
        tags=["workspace"],
    )
    def delete(self, request: Request, slug: str, *args: Any, **kwargs: Any) -> Response:
        from allauth.socialaccount.models import SocialAccount

        policy = _policy_or_none(slug)
        if policy is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        # Deleting the SocialApp cascades to the policy (OneToOne, CASCADE), but
        # SocialAccount has no FK to SocialApp, so the per-user bindings would
        # survive and could silently re-activate if the slug were later reused.
        # Purge them explicitly, keyed on the provider slug.
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
