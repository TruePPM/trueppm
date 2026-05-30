"""Serializers for webhook management API."""

from __future__ import annotations

import secrets
from typing import Any

from rest_framework import serializers

from trueppm_api.apps.webhooks.models import (
    Webhook,
    WebhookDelivery,
    WebhookEventType,
)

# Minimum signing-secret length (#893). The secret is the only thing standing
# between a forged request and an accepted webhook delivery (HMAC over the
# payload), so a short or low-entropy secret is brute-forceable offline. 32
# chars is the floor; auto-generated secrets use token_urlsafe(32) (~43 chars,
# 256 bits of entropy).
MIN_WEBHOOK_SECRET_LENGTH = 32


class WebhookSerializer(serializers.ModelSerializer[Webhook]):
    """Serializer for Webhook CRUD.

    The ``secret`` field is write-only — it is never returned in GET/list
    responses. It is echoed back exactly once, in the create response, so the
    caller can record it; subsequent reads never expose it (#893). When omitted
    on create, a cryptographically-strong secret is auto-generated. When
    supplied it must be at least :data:`MIN_WEBHOOK_SECRET_LENGTH` non-whitespace
    characters.

    The ``events`` field is validated against the known event type choices.
    """

    events = serializers.ListField(
        child=serializers.ChoiceField(choices=WebhookEventType.choices),
        allow_empty=False,
    )
    # required=False so the secret may be omitted and auto-generated. Still
    # write_only (Meta.extra_kwargs) so it never appears in normal reads; the
    # one-time create echo is handled explicitly in to_representation.
    secret = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=255,
        write_only=True,
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

    def validate_secret(self, value: str) -> str:
        """Enforce a minimum length / reject whitespace-only secrets (#893).

        Auto-generate-on-blank applies to CREATE only. On CREATE a blank value is
        allowed through and auto-generated in ``create``. On UPDATE
        (``self.instance is not None``) a blank/whitespace secret is rejected: an
        empty string would otherwise be written to an existing webhook and
        silently disable HMAC verification (#893). To rotate the secret the
        operator must supply a real ≥32-char value; omitting the field entirely
        leaves the existing secret unchanged (handled by partial update, since the
        field is then absent from ``validated_data``).
        """
        is_update = self.instance is not None
        # Blank → auto-generate later on create. Distinguish blank from
        # whitespace-only: a whitespace-only string is a likely mistake, not an
        # opt-in to a generated secret, so reject it explicitly even on create.
        if value == "":
            if is_update:
                raise serializers.ValidationError(
                    "Secret cannot be blanked on an existing webhook. Provide a new "
                    "secret of at least "
                    f"{MIN_WEBHOOK_SECRET_LENGTH} characters to rotate it, or omit "
                    "the field to keep the current one."
                )
            return value
        if value.strip() == "":
            raise serializers.ValidationError("Secret cannot be only whitespace.")
        if len(value) < MIN_WEBHOOK_SECRET_LENGTH:
            raise serializers.ValidationError(
                f"Secret must be at least {MIN_WEBHOOK_SECRET_LENGTH} characters."
            )
        return value

    def create(self, validated_data: dict[str, Any]) -> Webhook:
        """Auto-generate a strong secret when none was supplied (#893).

        ``token_urlsafe(32)`` yields ~43 URL-safe characters carrying 256 bits
        of entropy, comfortably above the minimum-length floor.
        """
        if not validated_data.get("secret"):
            validated_data["secret"] = secrets.token_urlsafe(32)
        instance = super().create(validated_data)
        # Flag this instance so to_representation echoes the secret exactly once,
        # in the create response only. Reads of a refetched instance never see it.
        self._created_secret = instance.secret
        return instance

    def to_representation(self, instance: Webhook) -> dict[str, Any]:
        """Echo the secret once on create; never on any other read (#893)."""
        data = super().to_representation(instance)
        created_secret = getattr(self, "_created_secret", None)
        if created_secret is not None:
            data["secret"] = created_secret
        return data

    def validate_url(self, value: str) -> str:
        """Reject webhook URLs that resolve to a private / loopback / link-local host.

        Webhook delivery is server-side egress to an admin-supplied URL, so it
        is an SSRF vector (cloud metadata, cluster-internal services). We reject
        obviously unsafe targets at registration for fast feedback; the
        ``deliver_webhook`` task re-checks at delivery time as the authoritative
        guard (closing the DNS-rebinding window). A host that cannot be resolved
        *now* is allowed through — it may resolve later and delivery re-validates.
        Shares the integrations egress chokepoint (ADR-0049 §3).
        """
        from trueppm_api.apps.integrations.http import (
            EgressBlocked,
            EgressError,
            assert_url_allowed,
        )

        try:
            assert_url_allowed(value)
        except EgressBlocked as exc:
            raise serializers.ValidationError(str(exc)) from exc
        except EgressError:
            # DNS resolution failed at registration; allow save — delivery re-checks.
            pass
        return value

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
