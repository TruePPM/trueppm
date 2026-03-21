"""Initial migration for resources app."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("projects", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Resource",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("name", models.CharField(max_length=255)),
                ("email", models.EmailField(blank=True)),
                (
                    "calendar",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="resources",
                        to="projects.calendar",
                    ),
                ),
                ("max_units", models.DecimalField(decimal_places=2, default=1.0, max_digits=4)),
            ],
            options={"db_table": "resources_resource", "ordering": ["name"]},
        ),
        migrations.CreateModel(
            name="TaskResource",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="assignments",
                        to="projects.task",
                    ),
                ),
                (
                    "resource",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="assignments",
                        to="resources.resource",
                    ),
                ),
                ("units", models.DecimalField(decimal_places=2, default=1.0, max_digits=4)),
            ],
            options={"db_table": "resources_task_resource"},
        ),
        migrations.AlterUniqueTogether(
            name="taskresource",
            unique_together={("task", "resource")},
        ),
    ]
