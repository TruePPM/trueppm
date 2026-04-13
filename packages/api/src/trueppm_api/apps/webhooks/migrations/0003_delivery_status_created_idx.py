from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("webhooks", "0002_alter_webhook_events"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="webhookdelivery",
            index=models.Index(
                fields=["status", "created_at"],
                name="delivery_status_created_idx",
            ),
        ),
    ]
