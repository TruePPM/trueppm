"""Add ResourceSkill model (skill tags on a resource with proficiency)."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("resources", "0006_skill"),
    ]

    operations = [
        migrations.CreateModel(
            name="ResourceSkill",
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
                    "resource",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="skills",
                        to="resources.resource",
                    ),
                ),
                (
                    "skill",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="resources",
                        to="resources.skill",
                    ),
                ),
                (
                    "proficiency",
                    models.IntegerField(
                        choices=[(1, "Beginner"), (2, "Intermediate"), (3, "Expert")],
                        default=2,
                    ),
                ),
            ],
            options={"db_table": "resources_resource_skill"},
        ),
        migrations.AlterUniqueTogether(
            name="resourceskill",
            unique_together={("resource", "skill")},
        ),
        migrations.AddIndex(
            model_name="resourceskill",
            index=models.Index(fields=["skill", "proficiency"], name="res_skill_prof_idx"),
        ),
    ]
