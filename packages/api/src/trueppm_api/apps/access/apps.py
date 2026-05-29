"""App config for access (RBAC)."""

from __future__ import annotations

from django.apps import AppConfig


class AccessConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.access"

    def ready(self) -> None:
        # Imports for side effect. The access app is always installed, so it is the
        # registration point for app-wide hooks that have no better home:
        #   - signals: ProjectMembership revocation evicts live WS sockets (#813).
        #   - security_checks: registers the SECRET_KEY system check (#566).
        from trueppm_api.apps.access import signals  # noqa: F401
        from trueppm_api.core import security_checks  # noqa: F401
