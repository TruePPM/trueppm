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

        ``NOTIFICATION_CHANNELS`` is wired by #639 (``email``/``in_app``).
        ``OUTGOING_CHANNEL_PROVIDERS`` is populated here by #638 with the OSS
        ``generic`` and ``slack`` renderers.
        """
        from .notification_channels import OSS_NOTIFICATION_CHANNELS
        from .outgoing import OSS_OUTGOING_CHANNEL_PROVIDERS
        from .providers import OSS_TASK_LINK_PROVIDERS
        from .registry import (
            NOTIFICATION_CHANNELS,
            OUTGOING_CHANNEL_PROVIDERS,
            TASK_LINK_PROVIDERS,
        )

        for handler in OSS_TASK_LINK_PROVIDERS:
            # Idempotent: skip if a re-import (e.g. tests reloading the app)
            # already registered the handler. ``register()`` raises on the
            # duplicate-key path; the registry-clearing helper used by tests
            # avoids that path by re-registering deliberately.
            if TASK_LINK_PROVIDERS.get(handler.key) is None:
                TASK_LINK_PROVIDERS.register(handler.key, handler)

        for channel in OSS_OUTGOING_CHANNEL_PROVIDERS:
            if OUTGOING_CHANNEL_PROVIDERS.get(channel.key) is None:
                OUTGOING_CHANNEL_PROVIDERS.register(channel.key, channel)

        for notif_channel in OSS_NOTIFICATION_CHANNELS:
            if NOTIFICATION_CHANNELS.get(notif_channel.key) is None:
                NOTIFICATION_CHANNELS.register(notif_channel.key, notif_channel)
