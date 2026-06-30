"""OIDC relying-party endpoints (ADR-0187 §2–3).

Two groups:

- **Unauthenticated flow** (pre-session): ``discover`` (domain probe, no
  enumeration leak), ``login`` (302 to the IdP with state/PKCE/nonce), and
  ``callback`` (validate, mint the existing cookie-JWT session, 302 to the SPA).
  These set ``permission_classes = [AllowAny]`` and ``authentication_classes =
  []`` because the caller has no session yet — authentication *is* the flow.
- **Admin config** (``IsWorkspaceAdmin``): the singleton ``/workspace/sso/``
  provider config (GET/PUT/DELETE, secret write-only) and ``test-connection``.

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
from trueppm_api.apps.sso.models import OIDCProvider
from trueppm_api.apps.sso.serializers import (
    OIDCDiscoverResponseSerializer,
    OIDCProviderReadSerializer,
    OIDCProviderWriteSerializer,
    OIDCTestConnectionRequestSerializer,
    OIDCTestConnectionResponseSerializer,
)
from trueppm_api.apps.workspace.models import Workspace
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdmin
from trueppm_api.core.auth_views import _set_refresh_cookie

# Trailing slash matches the route in ``urls.py`` so the IdP returns straight to
# the view without an APPEND_SLASH redirect hop dropping the query.
_CALLBACK_PATH = "/api/v1/auth/oidc/callback/"

# Browser-binding cookie for the OIDC ``state``. The server-side single-use state
# only proves *we* minted the value; it does not prove the *same browser* that
# began the flow is the one completing it. Without this binding, an attacker who
# completes login at their own IdP account could hand the resulting
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
    the login state and replayed at the token endpoint, so it always matches.
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
    """``GET /auth/oidc/discover?email=`` — does this *domain* use SSO?

    Domain-level only: it never touches the user table and never reveals whether
    an account exists (no enumeration leak). Always 200.
    """

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "oidc_discover"

    @extend_schema(
        summary="Discover whether an email domain uses SSO",
        parameters=[OpenApiParameter("email", str, OpenApiParameter.QUERY, required=False)],
        responses={200: OIDCDiscoverResponseSerializer},
        auth=[],
        tags=["auth"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        email = (request.query_params.get("email") or "").strip()
        provider = services.get_enabled_provider()
        present = bool(
            provider is not None and "@" in email and services._domain_allowed(provider, email)
        )
        payload: dict[str, Any] = {"provider_present": present}
        if present and provider is not None:
            payload["display_name"] = provider.display_name
            payload["issuer"] = provider.issuer_url
        return Response(OIDCDiscoverResponseSerializer(payload).data)


class OIDCLoginView(APIView):
    """``GET /auth/oidc/login`` — start the Authorization Code + PKCE flow."""

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "oidc_login"

    @extend_schema(
        summary="Begin SSO login (redirects to the IdP)",
        responses={
            302: OpenApiResponse(description="Redirect to the IdP authorization endpoint."),
        },
        auth=[],
        tags=["auth"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> HttpResponse:
        provider = services.get_enabled_provider()
        if provider is None:
            return HttpResponseRedirect(_spa_completion_url(error="sso_not_configured"))
        try:
            result = services.start_login(provider, redirect_uri=_derive_redirect_uri(request))
        except services.OIDCError as exc:
            return HttpResponseRedirect(_spa_completion_url(error=exc.code))
        # Bind the state to this browser (login-CSRF / session-fixation defense).
        response = HttpResponseRedirect(result.authorization_url)
        _set_state_cookie(response, result.state)
        return response


class OIDCCallbackView(APIView):
    """``GET /auth/oidc/callback?code=&state=`` — complete the flow, mint the session.

    On success: validate state (single-use) → exchange code → validate ID token →
    resolve/link/create the user → set the httpOnly refresh cookie → 302 to the
    SPA completion route (no token in the URL). On any failure: 302 to the SPA
    completion route with a non-sensitive ``error`` code.
    """

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "oidc_callback"

    def _redirect(self, *, error: str | None = None) -> HttpResponse:
        """Redirect to the SPA completion route, always clearing the state cookie.

        The state cookie is single-use — once a callback is processed (success or
        failure) the binding has served its purpose and must not linger.
        """
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

        provider = services.get_enabled_provider()
        if provider is None:
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
            doc = services.get_discovery_document(provider.issuer_url)
            tokens = services.exchange_code(
                provider,
                doc,
                code=code,
                redirect_uri=stored["redirect_uri"],
                verifier=stored["verifier"],
            )
            claims = services.validate_id_token(
                provider, doc, tokens["id_token"], expected_nonce=stored["nonce"]
            )
            user, _created = services.resolve_user(provider, claims)
        except services.OIDCError as exc:
            return self._redirect(error=exc.code)

        # Mint the existing cookie-JWT session — no new token surface (ADR-0187 §2).
        refresh = RefreshToken.for_user(user)
        response = self._redirect()
        _set_refresh_cookie(response, str(refresh))  # type: ignore[arg-type]
        return response


class OIDCProviderView(IdempotencyMixin, APIView):
    """Singleton SSO provider config — ``/workspace/sso/`` (GET/PUT/DELETE).

    Mirrors ``WorkspaceSettingsView``: ``IsWorkspaceAdmin``, singleton row via
    ``OIDCProvider.load()``. The client secret is write-only (providing it on PUT
    rotates it) and never returned. DELETE removes the config row entirely
    (a subsequent GET lazily re-materializes a blank, disabled provider).
    """

    permission_classes = [IsWorkspaceAdmin]
    # Exempt from the generic Idempotency-Key path (ADR-0170): this is a singleton
    # config row, so PUT (full replace) and DELETE (clear) are naturally idempotent
    # — replaying converges to the same state with no resource multiplication.
    idempotency_exempt = True

    def _read(self, provider: OIDCProvider, request: Request) -> dict[str, Any]:
        return OIDCProviderReadSerializer(
            provider, context={"redirect_uri": _derive_redirect_uri(request)}
        ).data

    @extend_schema(
        summary="Get the SSO provider configuration",
        responses={200: OIDCProviderReadSerializer},
        tags=["workspace"],
    )
    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        provider = OIDCProvider.load()
        return Response(self._read(provider, request))

    @extend_schema(
        summary="Update the SSO provider configuration (secret write-only; sending it rotates)",
        request=OIDCProviderWriteSerializer,
        responses={200: OIDCProviderReadSerializer},
        tags=["workspace"],
    )
    def put(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        provider = OIDCProvider.load()
        serializer = OIDCProviderWriteSerializer(provider, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        provider = serializer.save()
        return Response(self._read(provider, request))

    @extend_schema(
        summary="Delete the SSO provider configuration (disables SSO)",
        responses={204: OpenApiResponse(description="Config deleted; SSO disabled.")},
        tags=["workspace"],
    )
    def delete(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        # Scope to this workspace rather than ``.all()``: the model is
        # workspace-scoped (the FK is retained for enterprise multi-tenancy), so a
        # blanket delete would wipe every tenant's config from one admin's request.
        OIDCProvider.objects.filter(workspace=Workspace.load()).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class OIDCTestConnectionView(IdempotencyMixin, APIView):
    """``POST /workspace/sso/test-connection`` — probe discovery + JWKS (admin)."""

    permission_classes = [IsWorkspaceAdmin]
    # Exempt from the generic Idempotency-Key path (ADR-0170): a read-only
    # reachability probe that mutates nothing — POST is the verb only because the
    # candidate issuer is supplied in the body, not because it creates a resource.
    idempotency_exempt = True

    @extend_schema(
        summary="Test the SSO provider's discovery + JWKS reachability",
        request=OIDCTestConnectionRequestSerializer,
        responses={200: OIDCTestConnectionResponseSerializer},
        tags=["workspace"],
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        req = OIDCTestConnectionRequestSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        issuer = (req.validated_data.get("issuer_url") or "").strip()
        if not issuer:
            issuer = OIDCProvider.load().issuer_url
        if not issuer:
            return Response({"ok": False, "error": "no_issuer"})
        result = services.check_provider_reachability(issuer)
        return Response(OIDCTestConnectionResponseSerializer(result).data)
