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
        #   - valkey_checks: registers the Valkey topology system check (#2554).
        # Verify-only JWT key rotation (#3406): swap simplejwt's module-level
        # backend for one that also tries JWT_SIGNING_KEY_FALLBACKS. Signing still
        # uses the primary key only.
        from django.conf import settings as django_settings
        from rest_framework_simplejwt import state as jwt_state

        from trueppm_api.apps.access import signals  # noqa: F401
        from trueppm_api.core import security_checks, valkey_checks  # noqa: F401
        from trueppm_api.core.key_fallbacks import make_fallback_token_backend

        jwt_state.token_backend = make_fallback_token_backend(
            lambda: getattr(django_settings, "JWT_SIGNING_KEY_FALLBACKS", [])
        )
