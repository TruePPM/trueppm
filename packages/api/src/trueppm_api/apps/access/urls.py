"""URL routing for the access app."""

from __future__ import annotations

from rest_framework.routers import DefaultRouter

from trueppm_api.apps.access.views import ProjectMembershipViewSet

router = DefaultRouter()
router.register(r"memberships", ProjectMembershipViewSet, basename="membership")

urlpatterns = router.urls
