"""Serializers for webhook management API."""

from __future__ import annotations

import logging
import secrets
from typing import Any

from rest_framework import serializers

from trueppm_api.apps.webhooks.models import (
    Webhook,
    WebhookDelivery,
    WebhookEventType,
)

logger = logging.getLogger(__name__)

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

    ``secret_set`` is the read-side counterpart: a boolean saying whether a secret
    is stored. The secret itself is encrypted at rest and there is no API path that
    reads the plaintext back.

    The ``events`` field is validated against the known event type choices and is
    **required** — there is no "subscribe to everything" shorthand, so omitting it
    returns 400 rather than creating a silently empty subscription.

    ``consecutive_failures``, ``last_failure_at``, ``last_failure_reason``,
    ``disabled_at`` and ``disabled_reason`` are read-only delivery health, written
    only by the delivery task. ``disabled_at`` is set solely by the automatic
    failure guard, so a subscription an admin paused by hand is distinguishable from
    one TruePPM gave up on. PATCHing ``is_active`` back to true clears the record.
    """

    events = serializers.ListField(
        child=serializers.ChoiceField(choices=WebhookEventType.choices),
        allow_empty=False,
    )
    # Mirrors SsoProviderPolicySerializer / BoardAutomationSerializer — the
    # repo-wide shape for "a secret exists, and that is all you may know" (#2885).
    # Reads the Webhook.secret_set property, which tests the stored ciphertext.
    secret_set = serializers.BooleanField(read_only=True)
    # required=False so the secret may be omitted and auto-generated. write_only so
    # it never appears in normal reads; the one-time create echo is handled
    # explicitly in to_representation. There is no model field behind it any more —
    # it writes through the Webhook.secret property, which encrypts.
    secret = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=255,
        write_only=True,
        # CharField trims surrounding whitespace by default, which would collapse a
        # whitespace-only secret to "" and silently auto-generate one on create.
        # Keep the raw value so validate_secret can reject whitespace-only input.
        trim_whitespace=False,
    )

    class Meta:
        model = Webhook
        fields = [
            "id",
            "project",
            "program",
            "url",
            "secret",
            "secret_set",
            "events",
            "format",
            "is_active",
            "consecutive_failures",
            "last_failure_at",
            "last_failure_reason",
            "disabled_at",
            "disabled_reason",
            "created_at",
            "created_by",
        ]
        read_only_fields = [
            "id",
            "project",
            "program",
            "created_at",
            "created_by",
            # Delivery health is written only by the delivery task (#2884) — a
            # client cannot fake a healthy webhook or clear the auto-disable
            # record. Re-enabling is done by PATCHing is_active, which resets the
            # counters in update() below.
            "consecutive_failures",
            "last_failure_at",
            "last_failure_reason",
            "disabled_at",
            "disabled_reason",
        ]

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

    def update(self, instance: Webhook, validated_data: dict[str, Any]) -> Webhook:
        """Reactivating a webhook clears the automatic failure record (#2884).

        The consecutive-failure guard deactivates a subscription whose endpoint has
        been failing terminally. Re-enabling it must reset the counter in the same
        write: otherwise the very next failure lands on an already-at-threshold
        counter and the guard re-disables the webhook immediately, so an admin who
        has genuinely fixed the receiver can never get out of the disabled state.
        """
        reactivating = validated_data.get("is_active") is True and not instance.is_active
        if reactivating:
            instance.consecutive_failures = 0
            instance.last_failure_at = None
            instance.last_failure_reason = ""
            instance.disabled_at = None
            instance.disabled_reason = ""
        return super().update(instance, validated_data)

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
            # Return a curated message only. EgressBlocked can embed the
            # DNS-resolved address (e.g. "resolves to non-public address
            # 10.0.0.5"), which would turn this field into an SSRF oracle for
            # internal network topology — log it server-side, never echo it to
            # the client (CodeQL py/stack-trace-exposure). Mirrors the
            # notifications bounce-webhook fix in #2082.
            logger.info("webhook url rejected by egress guard: %s", exc)
            raise serializers.ValidationError(
                "This URL is not allowed. Use a public https:// URL that does not "
                "resolve to an internal or private address."
            ) from exc
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
