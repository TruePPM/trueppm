"""App config for observability (Beat liveness, ADR-0081)."""

from django.apps import AppConfig


class ObservabilityConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.observability"
