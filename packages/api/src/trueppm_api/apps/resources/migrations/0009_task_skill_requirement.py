"""Add TaskSkillRequirement model (skill requirements on tasks)."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0018_estimation_governance"),
        ("resources", "0008_project_resource"),
    ]

    operations = [
        migrations.CreateModel(
            name="TaskSkillRequirement",
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
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="skill_requirements",
                        to="projects.task",
                    ),
                ),
                (
                    "skill",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="task_requirements",
                        to="resources.skill",
                    ),
                ),
                (
                    "min_proficiency",
                    models.IntegerField(
                        choices=[(1, "Beginner"), (2, "Intermediate"), (3, "Expert")],
                        default=1,
                    ),
                ),
            ],
            options={"db_table": "resources_task_skill_requirement"},
        ),
        migrations.AlterUniqueTogether(
            name="taskskillrequirement",
            unique_together={("task", "skill")},
        ),
    ]
