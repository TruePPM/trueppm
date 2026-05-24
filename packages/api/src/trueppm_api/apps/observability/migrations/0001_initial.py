"""Create BeatHeartbeat singleton model (ADR-0081)."""

from __future__ import annotations

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="BeatHeartbeat",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "singleton_key",
                    models.PositiveSmallIntegerField(default=1, editable=False, unique=True),
                ),
                ("last_heartbeat", models.DateTimeField()),
            ],
        ),
    ]
