"""URL patterns for the scheduling app."""

from __future__ import annotations

from django.urls import URLPattern, path

from trueppm_api.apps.scheduling.views import run_monte_carlo, trigger_schedule

urlpatterns: list[URLPattern] = [
    path("projects/<str:pk>/schedule/", trigger_schedule, name="project-schedule"),
    path("projects/<str:pk>/monte-carlo/", run_monte_carlo, name="project-monte-carlo"),
]
