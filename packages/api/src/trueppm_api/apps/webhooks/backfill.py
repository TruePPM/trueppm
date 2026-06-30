"""Data-backfill helpers for the webhooks app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).
"""

from __future__ import annotations

from typing import Any


def backfill_sequence_numbers(apps: Any, schema_editor: Any) -> None:
    """Assign monotonic per-subscription sequence numbers to existing deliveries (#664).

    Orders deliveries by created_at (then id as a stable tie-break) so the
    historical sequence reflects the order deliveries were actually created.
    Persists the counter on the Webhook so new deliveries continue the sequence
    rather than restarting from 1.
    """
    Webhook = apps.get_model("webhooks", "Webhook")
    WebhookDelivery = apps.get_model("webhooks", "WebhookDelivery")

    for webhook in Webhook.objects.all():
        seq = 0
        # Order by created_at (then id as a stable tie-break) so the historical
        # sequence reflects the order deliveries were actually created.
        deliveries = WebhookDelivery.objects.filter(webhook=webhook).order_by("created_at", "id")
        for delivery in deliveries:
            seq += 1
            WebhookDelivery.objects.filter(pk=delivery.pk).update(sequence_number=seq)
        # Persist the counter so deliveries created after the migration continue
        # the same sequence rather than restarting from 1.
        if seq > 0:
            Webhook.objects.filter(pk=webhook.pk).update(delivery_sequence=seq)


def reverse_backfill(apps: Any, schema_editor: Any) -> None:
    """Reset all sequence counters back to zero (migration reverse operation)."""
    Webhook = apps.get_model("webhooks", "Webhook")
    WebhookDelivery = apps.get_model("webhooks", "WebhookDelivery")
    WebhookDelivery.objects.all().update(sequence_number=0)
    Webhook.objects.all().update(delivery_sequence=0)
