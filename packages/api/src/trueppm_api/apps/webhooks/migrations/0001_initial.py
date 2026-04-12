"""Create Webhook and WebhookDelivery models."""

from __future__ import annotations

import uuid

import django.contrib.postgres.fields
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("projects", "0013_task_planned_start"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Webhook",
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
                ("url", models.URLField(max_length=2048)),
                ("secret", models.CharField(max_length=255)),
                (
                    "events",
                    django.contrib.postgres.fields.ArrayField(
                        base_field=models.CharField(
                            choices=[
                                ("task.created", "Task Created"),
                                ("task.updated", "Task Updated"),
                                ("task.deleted", "Task Deleted"),
                                ("dependency.created", "Dependency Created"),
                                ("dependency.deleted", "Dependency Deleted"),
                                ("schedule.recalculated", "Schedule Recalculated"),
                                ("project.created", "Project Created"),
                            ],
                            max_length=30,
                        ),
                        size=None,
                    ),
                ),
                ("is_active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="webhooks",
                        to="projects.project",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["project", "is_active"],
                        name="webhook_project_active_idx",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="WebhookDelivery",
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
                    "event_type",
                    models.CharField(
                        choices=[
                            ("task.created", "Task Created"),
                            ("task.updated", "Task Updated"),
                            ("task.deleted", "Task Deleted"),
                            ("dependency.created", "Dependency Created"),
                            ("dependency.deleted", "Dependency Deleted"),
                            ("schedule.recalculated", "Schedule Recalculated"),
                            ("project.created", "Project Created"),
                        ],
                        max_length=30,
                    ),
                ),
                ("payload", models.JSONField()),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("success", "Success"),
                            ("failed", "Failed"),
                        ],
                        default="pending",
                        max_length=10,
                    ),
                ),
                ("response_status", models.SmallIntegerField(blank=True, null=True)),
                ("attempt_count", models.SmallIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "webhook",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="deliveries",
                        to="webhooks.webhook",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["webhook", "created_at"],
                        name="delivery_webhook_created_idx",
                    ),
                ],
            },
        ),
    ]
