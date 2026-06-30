"""Per-subscription outgoing webhook sequence numbers (#664).

Adds a monotonic ``delivery_sequence`` counter to ``Webhook`` and a
``sequence_number`` to each ``WebhookDelivery``, then backfills existing rows so
the counter is contiguous and continues correctly for new deliveries.
"""

from django.db import migrations, models

from trueppm_api.apps.webhooks.backfill import backfill_sequence_numbers, reverse_backfill


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
        migrations.RunPython(backfill_sequence_numbers, reverse_backfill, elidable=True),
    ]
