"""URL routing for the resources app."""

from __future__ import annotations

from rest_framework.routers import DefaultRouter

from trueppm_api.apps.resources.views import ResourceViewSet, TaskResourceViewSet

router = DefaultRouter()
router.register(r"resources", ResourceViewSet, basename="resource")
router.register(r"task-resources", TaskResourceViewSet, basename="task-resource")

urlpatterns = router.urls
