"""URL routes for observability (ADR-0081)."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.observability.views import beat_health, dead_letter_metrics

urlpatterns = [
    path("health/beat/", beat_health, name="beat-health"),
    path("health/dead-letter/", dead_letter_metrics, name="dead-letter-metrics"),
]
