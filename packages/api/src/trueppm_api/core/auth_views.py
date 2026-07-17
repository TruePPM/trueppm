"""Cookie-based JWT auth views (#897).

These views replace the stock simplejwt token endpoints so the *refresh* token
is delivered to the browser in an ``httpOnly`` cookie scoped to the refresh path
instead of in the JSON response body. The access token is still returned in the
JSON body and held in memory by the SPA.

Why httpOnly for the refresh token:
    A refresh token is long-lived and exchangeable for access tokens, so it is
    the high-value credential. Persisting it where JavaScript can read it
    (localStorage / a JS-visible cookie) means any XSS that runs in the SPA can
    exfiltrate it and impersonate the user past the lifetime of any single
    access token. An ``httpOnly`` cookie is unreadable from JavaScript, so an
    XSS payload can ride the current session but cannot steal the long-lived
    credential. The short-lived access token stays in memory (not localStorage)
    so it dies with the tab.

CSRF posture:
    The refresh cookie uses ``SameSite=Strict`` and is ``Path``-scoped to the
    refresh endpoint only. ``SameSite=Strict`` means the browser never attaches
    the cookie to a cross-site request, so a forged request from an attacker's
    origin cannot trigger a refresh on the victim's behalf. The refresh endpoint
    is otherwise unauthenticated-by-cookie (it reads the refresh token solely
    from this cookie), and a successful refresh only mints a new short-lived
    access token returned in the response body — which a cross-site attacker
    cannot read (CORS). There is therefore no additional CSRF token required on
    the refresh path. Login and logout are likewise safe: login carries no
    ambient credential, and logout is idempotent (clearing a cookie + best-effort
    blacklist) with no cross-site state-change value.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
from datetime import timedelta
from typing import Any, cast

from django.conf import settings
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from trueppm_api.core.throttling import LoginAccountRateThrottle

# Auth-domain logger. Failed-login attempts are emitted here as a structured
# WARNING so self-hosting operators can alarm on brute-force / credential-stuffing
# spikes (e.g. ship trueppm.auth to a SIEM and alert on a burst). Reuses the same
# named logger as the password-reset flow so all auth events land on one channel.
logger = logging.getLogger("trueppm.auth")


def _client_ip(request: Request) -> str:
    """Best-effort client IP for the audit event.

    Prefers the left-most ``X-Forwarded-For`` hop when present (deployments sit
    behind an ingress), falling back to ``REMOTE_ADDR``. This value is only used
    for an operator-facing log line, never for a security decision, so a spoofable
    header is acceptable here — the per-account throttle does the enforcement.
    """
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return str(forwarded).split(",")[0].strip()
    return str(request.META.get("REMOTE_ADDR", "unknown"))


def _emit_login_failure_event(request: Request) -> None:
    """Emit an auth-failure audit event for a rejected login (#1717).

    The attempted username is hashed (never logged in the clear) so the event is
    correlatable across attempts — an operator can see that one account is being
    hammered from many IPs — without writing raw credentials/emails into logs.
    """
    raw_username = request.data.get("username") if hasattr(request, "data") else None
    username_hash = (
        hashlib.sha256(str(raw_username).strip().lower().encode("utf-8")).hexdigest()
        if raw_username
        else "unknown"
    )
    logger.warning(
        "auth.login_failed username_hash=%s client_ip=%s",
        username_hash,
        _client_ip(request),
    )


def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    """Attach the refresh token to ``response`` as a hardened httpOnly cookie.

    Cookie attributes are driven by settings so a non-HTTPS local dev server can
    still complete the flow (``AUTH_REFRESH_COOKIE_SECURE=False``) while
    production defaults to ``Secure``. The cookie is ``Path``-scoped to the
    refresh endpoint so it is never sent on ordinary API calls — only the
    refresh request carries it.
    """
    response.set_cookie(
        key=settings.AUTH_REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=int(cast(timedelta, settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"]).total_seconds()),
        httponly=True,
        secure=settings.AUTH_REFRESH_COOKIE_SECURE,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    """Delete the refresh cookie, matching the path/samesite it was set with.

    ``delete_cookie`` must be called with the same ``path`` (and ``samesite``)
    the cookie was set with, or the browser keeps the original cookie.
    """
    response.delete_cookie(
        key=settings.AUTH_REFRESH_COOKIE_NAME,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
    )


class _LoginResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Login response shape: the access token only.

    The refresh token is intentionally absent from the body — it is delivered as
    an httpOnly cookie (#897). Declared explicitly so drf-spectacular does not
    emit simplejwt's default ``TokenObtainPair`` schema, which still claims a
    required ``refresh`` field this view never returns (#997).
    """

    access = serializers.CharField()


class CookieTokenObtainPairView(TokenObtainPairView):
    """JWT login: return the access token in the body, refresh in an httpOnly cookie.

    Throttled with the scoped ``login`` rate (#770) to bound password guessing.
    The refresh token is *removed* from the JSON response body and set as a
    hardened cookie instead, so a successful login response no longer carries the
    long-lived credential anywhere JavaScript can read it (#897).

    Two throttles are STACKED (#1717): the IP-keyed ``login`` scope bounds guesses
    per source address, and ``LoginAccountRateThrottle`` bounds guesses per
    *account* (hashed username) across all source IPs — closing the distributed
    credential-stuffing gap where a rotating IP pool gets the full per-IP allowance
    from every fresh IP. Both must pass for a request to reach authentication.
    """

    # RUF012: throttle_classes is inherited from the simplejwt base; ruff reads
    # this as a fresh mutable default it can't resolve.
    throttle_classes = [ScopedRateThrottle, LoginAccountRateThrottle]  # noqa: RUF012
    throttle_scope = "login"

    @extend_schema(
        summary="Log in and obtain a JWT access token",
        description=(
            "Returns the short-lived **access** token in the JSON body. The "
            "long-lived **refresh** token is set as an httpOnly, Secure, "
            "SameSite=Strict cookie scoped to the refresh endpoint; it is never "
            "present in the response body (#897)."
        ),
        request=TokenObtainPairSerializer,
        responses={200: _LoginResponseSerializer},
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = TokenObtainPairSerializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except TokenError as exc:
            raise InvalidToken(exc.args[0]) from exc
        except AuthenticationFailed:
            # Bad credentials (simplejwt raises AuthenticationFailed with code
            # "no_active_account"). Emit an auth-failure audit event before
            # re-raising so operators can alarm on credential-stuffing bursts, then
            # let DRF return the normal 401 unchanged (no enumeration signal).
            _emit_login_failure_event(request)
            raise

        # Password-login policy seam (ADR-0187 §4). OSS always allows password
        # login (the default returns True); trueppm-enterprise registers a policy
        # that can block local login when an admin enforces org-wide SSO. Imported
        # lazily so this auth path carries no hard dependency on the sso app at
        # module load. The check runs only after a *successful* credential
        # validation, so it never leaks whether an account exists.
        from trueppm_api.apps.sso.extensions import local_login_allowed

        if not local_login_allowed(serializer.user):
            return Response(
                {"detail": "Password sign-in is disabled for this account. Use single sign-on."},
                status=status.HTTP_403_FORBIDDEN,
            )

        data = dict(serializer.validated_data)
        refresh_token = data.pop("refresh", None)

        response = Response(data, status=status.HTTP_200_OK)
        if refresh_token:
            _set_refresh_cookie(response, str(refresh_token))
        return response


class _CookieRefreshResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Response shape for the cookie-based refresh endpoint (access token only)."""

    access = serializers.CharField()


class CookieTokenRefreshView(APIView):
    """JWT refresh that reads the refresh token from the httpOnly cookie.

    The refresh token is never accepted from the request body — it is read only
    from the cookie set at login — so the SPA does not need JavaScript access to
    it. The token is rotated (a new refresh token is minted and re-cookied) when
    ``ROTATE_REFRESH_TOKENS`` is enabled, and the previous token is blacklisted
    when the blacklist app is installed (``BLACKLIST_AFTER_ROTATION``). The new
    access token is returned in the body.
    """

    # The default permission class is IsAuthenticated, but refresh must be
    # callable by a client whose access token has already expired. Authentication
    # here is the possession of a valid refresh cookie, validated below.
    permission_classes: list[Any] = []  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "refresh"

    @extend_schema(
        request=None,
        responses={
            200: _CookieRefreshResponseSerializer,
            401: OpenApiResponse(description="Missing or invalid refresh cookie."),
        },
        summary="Refresh the access token using the httpOnly refresh cookie",
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raw_token = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        if not raw_token:
            return Response(
                {"detail": "No refresh token cookie present."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        try:
            # RefreshToken accepts an encoded token string at runtime; the stub
            # only types the Token object form.
            refresh = RefreshToken(raw_token)  # type: ignore[arg-type]
        except TokenError as exc:
            # False positive: simplejwt's TokenError carries a curated, client-safe
            # reason ("Token is invalid or expired"), never a trace/path/internal.
            return Response(
                {"detail": str(exc)},  # codeql[py/stack-trace-exposure]
                status=status.HTTP_401_UNAUTHORIZED,
            )

        access_token = str(refresh.access_token)

        rotate = settings.SIMPLE_JWT.get("ROTATE_REFRESH_TOKENS", False)
        response = Response({"access": access_token}, status=status.HTTP_200_OK)

        if rotate:
            # Blacklist the just-used refresh token before issuing a new one, so a
            # leaked token cannot be replayed once the legitimate client rotates.
            # The token_blacklist app is installed by default (#910); the
            # AttributeError suppression is belt-and-braces for a lean deploy that
            # removes it, in which case rotation degrades to TTL-only expiry.
            if settings.SIMPLE_JWT.get("BLACKLIST_AFTER_ROTATION", False):
                with contextlib.suppress(AttributeError):
                    refresh.blacklist()
            refresh.set_jti()
            refresh.set_exp()
            refresh.set_iat()
            _set_refresh_cookie(response, str(refresh))

        return response


class CookieTokenLogoutView(APIView):
    """Log out: clear the refresh cookie and best-effort blacklist the token.

    Always returns 205 (reset content) — logout is idempotent. If the
    ``token_blacklist`` app is installed, the presented refresh token is
    blacklisted so it cannot be reused after the cookie is cleared; otherwise the
    refresh token remains valid only until its (short) TTL expires.
    """

    permission_classes: list[Any] = []  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012

    @extend_schema(
        request=None,
        responses={205: OpenApiResponse(description="Logged out; refresh cookie cleared.")},
        summary="Log out — clear the refresh cookie and revoke the token",
    )
    def post(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        raw_token = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        response = Response(status=status.HTTP_205_RESET_CONTENT)

        if raw_token:
            try:
                token = RefreshToken(raw_token)  # type: ignore[arg-type]
                token.blacklist()
            except (TokenError, AttributeError):
                # TokenError: already-expired/invalid token — nothing to revoke.
                # AttributeError: token_blacklist app not installed.
                pass

        _clear_refresh_cookie(response)
        return response
