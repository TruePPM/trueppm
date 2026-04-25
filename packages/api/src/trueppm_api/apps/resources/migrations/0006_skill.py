"""Add Skill model (global org-level catalog)."""

from __future__ import annotations

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("resources", "0005_resource_job_role"),
    ]

    operations = [
        migrations.CreateModel(
            name="Skill",
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
                ("name", models.CharField(max_length=120)),
                ("normalized_name", models.CharField(max_length=120, unique=True)),
                ("category", models.CharField(blank=True, max_length=60)),
            ],
            options={"db_table": "resources_skill", "ordering": ["name"]},
        ),
    ]
