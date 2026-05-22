"""App config for ``apps/integrations`` (ADR-0049)."""

from __future__ import annotations

from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.integrations"
    verbose_name = "Integrations"

    def ready(self) -> None:
        """Register OSS provider classes against the three ADR-0049 registries.

        Enterprise's ``AppConfig.ready()`` registers richer providers
        against the same registries at the same hook — no OSS code changes
        required when Enterprise lights up Jira / ServiceNow / Slack App.

        ``OUTGOING_CHANNEL_PROVIDERS`` and ``NOTIFICATION_CHANNELS`` are
        intentionally not populated in 0.2 — #638 and #639 wire their OSS
        providers ``slack``/``generic`` and ``email``/``in_app`` against
        them. The registries exist so those follow-ups don't need to
        re-architect.
        """
        from .providers import OSS_TASK_LINK_PROVIDERS
        from .registry import TASK_LINK_PROVIDERS

        for handler in OSS_TASK_LINK_PROVIDERS:
            # Idempotent: skip if a re-import (e.g. tests reloading the app)
            # already registered the handler. ``register()`` raises on the
            # duplicate-key path; the registry-clearing helper used by tests
            # avoids that path by re-registering deliberately.
            if TASK_LINK_PROVIDERS.get(handler.key) is None:
                TASK_LINK_PROVIDERS.register(handler.key, handler)
