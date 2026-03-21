"""URL routing for the projects app."""

from __future__ import annotations

from rest_framework.routers import DefaultRouter

from trueppm_api.apps.projects.views import (
    CalendarViewSet,
    DependencyViewSet,
    ProjectViewSet,
    TaskViewSet,
)

router = DefaultRouter()
router.register(r"calendars", CalendarViewSet, basename="calendar")
router.register(r"projects", ProjectViewSet, basename="project")
router.register(r"tasks", TaskViewSet, basename="task")
router.register(r"dependencies", DependencyViewSet, basename="dependency")

urlpatterns = router.urls
