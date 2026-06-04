"""App config for the teams app (ADR-0078)."""

from __future__ import annotations

from django.apps import AppConfig


class TeamsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.teams"

    def ready(self) -> None:
        # Import for side effect: the auto-membership invariant (ADR-0078 §F).
        # A ProjectMembership write mirrors onto the project's default team so a
        # new project member never sees a second "join the team" step.
        from trueppm_api.apps.teams import signals  # noqa: F401
