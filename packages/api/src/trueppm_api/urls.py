"""Root URL configuration."""

from __future__ import annotations

from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.utils import extend_schema, inline_serializer
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerSplitView
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.observability.views import readyz
from trueppm_api.core.auth_views import (
    CookieTokenLogoutView,
    CookieTokenObtainPairView,
    CookieTokenRefreshView,
)
from trueppm_api.core.password_reset import (
    PasswordResetConfirmView,
    PasswordResetRequestView,
)


@extend_schema(
    summary="Liveness probe",
    description=(
        'Returns HTTP 200 with `{"status": "ok"}` when the API process is running. '
        "No authentication required. Use for Kubernetes liveness/readiness probes."
    ),
    responses={200: inline_serializer("HealthResponse", {"status": serializers.CharField()})},
    auth=[],
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([AllowAny])
def health(_request: Request) -> Response:
    return Response({"status": "ok"})


@extend_schema(
    summary="Running edition",
    description=(
        'Returns `{"edition": "community" | "enterprise"}` from the TRUEPPM_EDITION '
        "Django setting. No authentication required. The React shell calls this once "
        "at startup to decide the post-login redirect target (ADR-0029, ADR-0030)."
    ),
    responses={200: inline_serializer("EditionResponse", {"edition": serializers.CharField()})},
    auth=[],
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([AllowAny])
def edition(request: Request) -> Response:
    """Return the running edition — community or enterprise.

    Public endpoint (no auth required). The React shell calls this once at
    startup to decide the post-login redirect target (ADR-0029, ADR-0030).
    The value is controlled by the TRUEPPM_EDITION Django setting, which the
    enterprise Helm chart sets to "enterprise".
    """
    return Response({"edition": settings.TRUEPPM_EDITION})


urlpatterns = [
    path("api/v1/health/", health, name="health"),
    # Dependency-aware readiness probe (#1894). Unauthenticated like /health/ so
    # kubelet can call it, but returns 503 when the DB or cache is unreachable —
    # unlike /health/, which is a shallow process-liveness check.
    path("api/v1/readyz", readyz, name="readyz"),
    path("api/v1/edition/", edition, name="edition"),
    path("admin/", admin.site.urls),
    # OpenAPI schema and interactive docs. The *split* Swagger view (not the
    # default inline one) is required by our strict CSP: it delivers the UI
    # bootstrap as a separate same-origin JS request instead of an inline
    # <script>, which script-src 'self' would otherwise block (the page rendered
    # blank — #1603). Asset bundles are served from drf-spectacular-sidecar
    # ('self') via SWAGGER_UI_DIST=SIDECAR in settings.
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerSplitView.as_view(url_name="schema"), name="swagger-ui"),
    path(
        "api/schema/swagger-ui/",
        SpectacularSwaggerSplitView.as_view(url_name="schema"),
        name="swagger-ui-compat",
    ),
    # JWT auth endpoints (#897). Login returns the access token in the body and
    # sets the refresh token in an httpOnly cookie; refresh reads that cookie;
    # logout clears it (and blacklists the token if the blacklist app is present).
    path("api/v1/auth/token/", CookieTokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/v1/auth/token/refresh/", CookieTokenRefreshView.as_view(), name="token_refresh"),
    path("api/v1/auth/logout/", CookieTokenLogoutView.as_view(), name="token_logout"),
    # Self-service password reset (#765, ADR-0209). Both AllowAny + throttled with a
    # dedicated "password_reset" scope. Request always returns 200 (no user
    # enumeration); confirm validates a stateless token, sets the password, and
    # revokes all of the account's other sessions.
    path(
        "api/v1/auth/password/reset/",
        PasswordResetRequestView.as_view(),
        name="password_reset",
    ),
    path(
        "api/v1/auth/password/reset/confirm/",
        PasswordResetConfirmView.as_view(),
        name="password_reset_confirm",
    ),
    # Versioned API
    path("api/v1/", include("trueppm_api.apps.access.urls")),
    path("api/v1/", include("trueppm_api.apps.projects.urls")),
    path("api/v1/", include("trueppm_api.apps.resources.urls")),
    path("api/v1/", include("trueppm_api.apps.scheduling.urls")),
    path("api/v1/", include("trueppm_api.apps.sync.urls")),
    path("api/v1/", include("trueppm_api.apps.history.urls")),
    path("api/v1/", include("trueppm_api.apps.msproject.urls")),
    path("api/v1/", include("trueppm_api.apps.jiraimport.urls")),
    path("api/v1/", include("trueppm_api.apps.webhooks.urls")),
    path("api/v1/", include("trueppm_api.apps.taskruns.urls")),
    path("api/v1/", include("trueppm_api.apps.workshops.urls")),
    path("api/v1/", include("trueppm_api.apps.notifications.urls")),
    path("api/v1/", include("trueppm_api.apps.integrations.urls")),
    path("api/v1/", include("trueppm_api.apps.observability.urls")),
    path("api/v1/", include("trueppm_api.apps.workspace.urls")),
    path("api/v1/", include("trueppm_api.apps.teams.urls")),
    path("api/v1/", include("trueppm_api.apps.timetracking.urls")),
    # Basic SSO — OIDC relying party (ADR-0187). Flow endpoints under
    # auth/oidc/*, admin config under workspace/sso/*.
    path("api/v1/", include("trueppm_api.apps.sso.urls")),
    # Team-readable agent-action audit log (ADR-0112 RC1, #1805).
    path("api/v1/", include("trueppm_api.apps.agents.urls")),
]
