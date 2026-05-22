"""Root URL configuration."""

from __future__ import annotations

from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.utils import extend_schema, inline_serializer
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView


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
    path("api/v1/edition/", edition, name="edition"),
    path("admin/", admin.site.urls),
    # OpenAPI schema and interactive docs
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path(
        "api/schema/swagger-ui/",
        SpectacularSwaggerView.as_view(url_name="schema"),
        name="swagger-ui-compat",
    ),
    # JWT auth endpoints
    path("api/v1/auth/token/", TokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/v1/auth/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    # Versioned API
    path("api/v1/", include("trueppm_api.apps.access.urls")),
    path("api/v1/", include("trueppm_api.apps.projects.urls")),
    path("api/v1/", include("trueppm_api.apps.resources.urls")),
    path("api/v1/", include("trueppm_api.apps.scheduling.urls")),
    path("api/v1/", include("trueppm_api.apps.sync.urls")),
    path("api/v1/", include("trueppm_api.apps.history.urls")),
    path("api/v1/", include("trueppm_api.apps.msproject.urls")),
    path("api/v1/", include("trueppm_api.apps.webhooks.urls")),
    path("api/v1/", include("trueppm_api.apps.taskruns.urls")),
    path("api/v1/", include("trueppm_api.apps.workshops.urls")),
    path("api/v1/", include("trueppm_api.apps.notifications.urls")),
    path("api/v1/", include("trueppm_api.apps.integrations.urls")),
]
