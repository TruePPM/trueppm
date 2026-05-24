"""Serializers for webhook management API."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.webhooks.models import (
    Webhook,
    WebhookDelivery,
    WebhookEventType,
)


class WebhookSerializer(serializers.ModelSerializer[Webhook]):
    """Serializer for Webhook CRUD.

    The ``secret`` field is write-only — it is never returned in GET responses.
    The ``events`` field is validated against the known event type choices.
    """

    events = serializers.ListField(
        child=serializers.ChoiceField(choices=WebhookEventType.choices),
        allow_empty=False,
    )

    class Meta:
        model = Webhook
        fields = [
            "id",
            "project",
            "program",
            "url",
            "secret",
            "events",
            "format",
            "is_active",
            "created_at",
            "created_by",
        ]
        read_only_fields = ["id", "project", "program", "created_at", "created_by"]
        extra_kwargs = {
            "secret": {"write_only": True},
        }

    def validate_format(self, value: str) -> str:
        """Validate ``format`` against the registered outgoing providers.

        Validation is dynamic (not a ``TextChoices`` list) so Enterprise can
        register ``slack_app``/``teams`` against ``OUTGOING_CHANNEL_PROVIDERS``
        without an OSS migration (ADR-0049). The error lists the currently
        registered keys so the client knows what is selectable.
        """
        from trueppm_api.apps.integrations.registry import OUTGOING_CHANNEL_PROVIDERS

        if value not in OUTGOING_CHANNEL_PROVIDERS:
            valid = ", ".join(OUTGOING_CHANNEL_PROVIDERS.keys())
            raise serializers.ValidationError(
                f"Unknown format {value!r}. Registered formats: {valid}."
            )
        return value


class WebhookDeliverySerializer(serializers.ModelSerializer[WebhookDelivery]):
    """Read-only serializer for webhook delivery log entries."""

    class Meta:
        model = WebhookDelivery
        fields = [
            "id",
            "event_type",
            "sequence_number",
            "payload",
            "status",
            "response_status",
            "attempt_count",
            "created_at",
            "completed_at",
        ]
        read_only_fields = fields
