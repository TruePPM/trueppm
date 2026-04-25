"""Add ProjectResource model (explicit project roster join)."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0018_estimation_governance"),
        ("resources", "0007_resource_skill"),
    ]

    operations = [
        migrations.CreateModel(
            name="ProjectResource",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                ("deleted_version", models.BigIntegerField(blank=True, editable=False, null=True)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="resource_pool",
                        to="projects.project",
                    ),
                ),
                (
                    "resource",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="project_memberships",
                        to="resources.resource",
                    ),
                ),
                ("role_title", models.CharField(blank=True, max_length=120)),
                (
                    "units_override",
                    models.DecimalField(blank=True, decimal_places=2, max_digits=4, null=True),
                ),
                ("notes", models.CharField(blank=True, max_length=500)),
            ],
            options={"db_table": "resources_project_resource"},
        ),
        migrations.AlterUniqueTogether(
            name="projectresource",
            unique_together={("project", "resource")},
        ),
        migrations.AddIndex(
            model_name="projectresource",
            index=models.Index(fields=["project", "is_deleted"], name="proj_res_proj_del_idx"),
        ),
    ]
