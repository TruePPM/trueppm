"""URL patterns for the webhooks app."""

from __future__ import annotations

from django.urls import URLPattern, URLResolver
from rest_framework.routers import DefaultRouter

from trueppm_api.apps.webhooks.views import WebhookViewSet

router = DefaultRouter()
router.register(
    r"projects/(?P<project_pk>[^/.]+)/webhooks",
    WebhookViewSet,
    basename="project-webhooks",
)

urlpatterns: list[URLPattern | URLResolver] = router.urls
