"""URL patterns for the workflow engine's operator read path (#2994)."""

from __future__ import annotations

from django.urls import URLPattern, URLResolver
from rest_framework.routers import DefaultRouter

from trueppm_api.apps.workflow_engine.views import WorkflowInstanceViewSet

router = DefaultRouter()
router.register(r"admin/workflows", WorkflowInstanceViewSet, basename="workflow-instance")

urlpatterns: list[URLPattern | URLResolver] = router.urls
