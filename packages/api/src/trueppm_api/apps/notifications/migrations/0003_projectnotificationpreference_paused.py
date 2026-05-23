"""Add the per-user-per-project kill-switch `paused` flag (#589)."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0002_project_notification_preference"),
    ]

    operations = [
        migrations.AddField(
            model_name="projectnotificationpreference",
            name="paused",
            field=models.BooleanField(default=False),
        ),
    ]
