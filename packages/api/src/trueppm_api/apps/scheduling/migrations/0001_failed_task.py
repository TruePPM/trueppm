"""Create FailedTask model for dead-letter tracking."""

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="FailedTask",
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
                ("task_name", models.CharField(db_index=True, max_length=255)),
                ("task_id", models.CharField(max_length=255, unique=True)),
                ("args", models.JSONField(default=list)),
                ("kwargs", models.JSONField(default=dict)),
                ("exception_type", models.CharField(max_length=255)),
                ("exception_message", models.TextField()),
                ("traceback", models.TextField()),
                ("failure_count", models.PositiveIntegerField(default=1)),
                ("first_failed_at", models.DateTimeField(auto_now_add=True)),
                ("last_failed_at", models.DateTimeField(auto_now=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending_retry", "Pending Retry"),
                            ("dead", "Dead"),
                            ("dismissed", "Dismissed"),
                            ("retried", "Retried"),
                        ],
                        db_index=True,
                        default="dead",
                        max_length=16,
                    ),
                ),
            ],
            options={
                "ordering": ["-last_failed_at"],
            },
        ),
        migrations.AddIndex(
            model_name="failedtask",
            index=models.Index(
                fields=["status", "last_failed_at"],
                name="failed_task_status_idx",
            ),
        ),
    ]
