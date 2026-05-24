"""Initial migration for the idempotency app (ADR-0083)."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="IdempotencyKey",
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
                ("key", models.CharField(max_length=255)),
                ("method", models.CharField(max_length=8)),
                ("path", models.CharField(max_length=512)),
                ("request_hash", models.CharField(max_length=64)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("processing", "Processing"),
                            ("completed", "Completed"),
                        ],
                        default="processing",
                        max_length=10,
                    ),
                ),
                ("response_status", models.SmallIntegerField(blank=True, null=True)),
                ("response_body", models.JSONField(blank=True, null=True)),
                ("response_headers", models.JSONField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "user",
                    models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="idempotency_keys",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "indexes": [models.Index(fields=["created_at"], name="idempotency_created_idx")],
                "constraints": [
                    models.UniqueConstraint(
                        fields=["user", "key"],
                        name="idempotency_key_unique_per_user",
                    )
                ],
            },
        ),
    ]
