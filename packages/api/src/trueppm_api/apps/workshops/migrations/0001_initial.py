"""Initial migration — WorkshopSession and WorkshopParticipant tables."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("projects", "0024_riskcomment"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="WorkshopSession",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("started_at", models.DateTimeField(auto_now_add=True)),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="workshop_sessions",
                        to="projects.project",
                    ),
                ),
                (
                    "started_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "workshops_session",
                "ordering": ["-started_at"],
            },
        ),
        migrations.AddConstraint(
            model_name="workshopsession",
            constraint=models.UniqueConstraint(
                condition=models.Q(ended_at__isnull=True),
                fields=["project"],
                name="unique_active_workshop_per_project",
            ),
        ),
        migrations.CreateModel(
            name="WorkshopParticipant",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("joined_at", models.DateTimeField(auto_now_add=True)),
                ("left_at", models.DateTimeField(blank=True, null=True)),
                ("color_index", models.PositiveSmallIntegerField(default=0)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="participants",
                        to="workshops.workshopsession",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "workshops_participant",
                "ordering": ["joined_at"],
            },
        ),
    ]
