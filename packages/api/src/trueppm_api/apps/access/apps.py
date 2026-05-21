"""App config for access (RBAC)."""

from __future__ import annotations

from django.apps import AppConfig


class AccessConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.access"

    def ready(self) -> None:
        # Import for side effect: registers the SECRET_KEY system check (#566).
        # No suitable top-level AppConfig exists for trueppm_api itself, so this
        # piggybacks on the access app which is always installed.
        from trueppm_api.core import security_checks  # noqa: F401
