"""URL patterns for the scheduling app."""

from __future__ import annotations

from django.urls import URLPattern, URLResolver, include, path
from rest_framework.routers import DefaultRouter

from trueppm_api.apps.scheduling.views import (
    FailedTaskViewSet,
    MonteCarloLatestView,
    VelocitySuggestionViewSet,
    run_monte_carlo,
    trigger_schedule,
)

router = DefaultRouter()
router.register(r"admin/failed-tasks", FailedTaskViewSet, basename="failed-task")
router.register(
    r"velocity-suggestions",
    VelocitySuggestionViewSet,
    basename="velocity-suggestion",
)

urlpatterns: list[URLPattern | URLResolver] = [
    path("projects/<str:pk>/schedule/", trigger_schedule, name="project-schedule"),
    path("projects/<str:pk>/monte-carlo/", run_monte_carlo, name="project-monte-carlo"),
    path(
        "projects/<str:pk>/monte-carlo/latest/",
        MonteCarloLatestView.as_view(),
        name="project-monte-carlo-latest",
    ),
    path("", include(router.urls)),
]
