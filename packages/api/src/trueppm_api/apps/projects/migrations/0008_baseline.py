"""Add Baseline and BaselineTask models for plan-vs-actual tracking (issue #9).

Baseline stores a named snapshot of the schedule; BaselineTask stores one
immutable row per task at snapshot time.  The conditional UniqueConstraint
enforces that at most one Baseline per project is active.

task_id in BaselineTask is a plain UUIDField (not FK) so that the snapshot
survives task soft-delete — a historical record should not be corrupted by
lifecycle events on the live schedule.
"""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0007_task_is_milestone"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Baseline",
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
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(default=False, db_index=True)),
                (
                    "deleted_version",
                    models.BigIntegerField(blank=True, editable=False, null=True),
                ),
                ("name", models.CharField(max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("is_active", models.BooleanField(db_index=True, default=False)),
                ("has_cpm_dates", models.BooleanField(default=False)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_baselines",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="baselines",
                        to="projects.project",
                    ),
                ),
            ],
            options={
                "db_table": "projects_baseline",
                "ordering": ["created_at"],
            },
        ),
        migrations.CreateModel(
            name="BaselineTask",
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
                ("task_id", models.UUIDField(db_index=True)),
                ("task_name", models.CharField(max_length=512)),
                ("start", models.DateField(blank=True, null=True)),
                ("finish", models.DateField(blank=True, null=True)),
                ("duration", models.IntegerField()),
                (
                    "baseline",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="tasks",
                        to="projects.baseline",
                    ),
                ),
            ],
            options={
                "db_table": "projects_baseline_task",
            },
        ),
        migrations.AddIndex(
            model_name="baselinetask",
            index=models.Index(
                fields=["baseline", "task_id"],
                name="baseline_task_lookup_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="baseline",
            constraint=models.UniqueConstraint(
                condition=models.Q(is_active=True),
                fields=["project"],
                name="unique_active_baseline_per_project",
            ),
        ),
    ]
