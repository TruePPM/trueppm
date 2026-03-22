"""URL patterns for the scheduling app."""

from __future__ import annotations

from django.urls import URLPattern, path

from trueppm_api.apps.scheduling.views import trigger_schedule

urlpatterns: list[URLPattern] = [
    path("projects/<str:pk>/schedule/", trigger_schedule, name="project-schedule"),
]
