"""URL routes for observability (ADR-0081, ADR-0090)."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.observability.views import (
    beat_health,
    dead_letter_metrics,
    retention_impact,
    retention_runs,
    retention_settings,
    system_health,
)

urlpatterns = [
    path("health/beat/", beat_health, name="beat-health"),
    path("health/dead-letter/", dead_letter_metrics, name="dead-letter-metrics"),
    path("health/system/", system_health, name="system-health"),
    path("health/retention/", retention_settings, name="retention-settings"),
    path("health/retention/impact/", retention_impact, name="retention-impact"),
    path("health/retention/runs/", retention_runs, name="retention-runs"),
]
