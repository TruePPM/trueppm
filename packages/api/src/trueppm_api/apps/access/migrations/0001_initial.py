"""Initial migration for the access app — creates ProjectMembership."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies: list[tuple[str, str]] = [
        ("projects", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ProjectMembership",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="memberships",
                        to="projects.project",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="memberships",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "role",
                    models.IntegerField(
                        choices=[
                            (0, "Viewer"),
                            (1, "Member"),
                            (2, "Scheduler"),
                            (3, "Admin"),
                            (4, "Owner"),
                        ]
                    ),
                ),
            ],
            options={"db_table": "access_project_membership"},
        ),
        migrations.AlterUniqueTogether(
            name="projectmembership",
            unique_together={("project", "user")},
        ),
    ]
