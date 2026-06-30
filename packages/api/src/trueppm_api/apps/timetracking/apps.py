"""App config for the time-tracking app (ADR-0185)."""

from django.apps import AppConfig


class TimetrackingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.timetracking"
    verbose_name = "Time tracking"
