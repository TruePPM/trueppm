"""Root URL configuration."""

from __future__ import annotations

from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

urlpatterns = [
    path("admin/", admin.site.urls),
    # OpenAPI schema and interactive docs
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
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
]
