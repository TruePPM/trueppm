"""Per-subscription outgoing webhook sequence numbers (#664).

Adds a monotonic ``delivery_sequence`` counter to ``Webhook`` and a
``sequence_number`` to each ``WebhookDelivery``, then backfills existing rows so
the counter is contiguous and continues correctly for new deliveries.
"""

from typing import Any

from django.db import migrations, models


def backfill_sequence_numbers(apps: Any, schema_editor: Any) -> None:
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
    Webhook = apps.get_model("webhooks", "Webhook")
    WebhookDelivery = apps.get_model("webhooks", "WebhookDelivery")
    WebhookDelivery.objects.all().update(sequence_number=0)
    Webhook.objects.all().update(delivery_sequence=0)


class Migration(migrations.Migration):
    dependencies = [
        ("webhooks", "0004_webhook_program_alter_webhook_project_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="webhook",
            name="delivery_sequence",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        migrations.AddField(
            model_name="webhookdelivery",
            name="sequence_number",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        migrations.RunPython(backfill_sequence_numbers, reverse_backfill),
    ]
