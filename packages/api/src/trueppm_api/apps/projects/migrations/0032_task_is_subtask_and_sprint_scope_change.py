"""Add Task.is_subtask discriminator and SprintScopeChange audit model (ADR-0060 #308)."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0031_task_remaining_points"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="is_subtask",
            field=models.BooleanField(
                default=False,
                db_index=True,
                help_text="True for tasks created via the drawer subtask action (ADR-0060).",
            ),
        ),
        migrations.AddField(
            model_name="historicaltask",
            name="is_subtask",
            field=models.BooleanField(
                default=False,
                db_index=True,
                help_text="True for tasks created via the drawer subtask action (ADR-0060).",
            ),
        ),
        migrations.CreateModel(
            name="SprintScopeChange",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                (
                    "subtask_name",
                    models.CharField(max_length=512),
                ),
                (
                    "added_at",
                    models.DateTimeField(auto_now_add=True),
                ),
                (
                    "added_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="sprint_scope_changes_added",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "sprint",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="scope_changes",
                        to="projects.sprint",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sprint_scope_changes",
                        to="projects.task",
                    ),
                ),
            ],
            options={
                "db_table": "projects_sprintscopechange",
                "ordering": ["added_at"],
            },
        ),
        migrations.AddIndex(
            model_name="sprintscopechange",
            index=models.Index(fields=["task", "sprint"], name="scope_change_task_sprint_idx"),
        ),
    ]
