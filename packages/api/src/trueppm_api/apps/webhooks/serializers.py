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
            "url",
            "secret",
            "events",
            "is_active",
            "created_at",
            "created_by",
        ]
        read_only_fields = ["id", "project", "created_at", "created_by"]
        extra_kwargs = {
            "secret": {"write_only": True},
        }


class WebhookDeliverySerializer(serializers.ModelSerializer[WebhookDelivery]):
    """Read-only serializer for webhook delivery log entries."""

    class Meta:
        model = WebhookDelivery
        fields = [
            "id",
            "event_type",
            "payload",
            "status",
            "response_status",
            "attempt_count",
            "created_at",
            "completed_at",
        ]
        read_only_fields = fields
