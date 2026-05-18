"""ADR-0071: uplift SprintRetro + RetroActionItem to VersionedModel,
add team_visibility to SprintRetro, and create TaskSuggestedAssignee.

Migration safety:
- Adding ``server_version``, ``is_deleted``, ``deleted_version`` to two
  populated tables with non-null defaults is metadata-only. Existing rows
  backfill to ``server_version=0`` (sync-protocol compatible since "since=0"
  means "give me everything"). New rows take server_version=1+ via
  ``VersionedModel.save``.
- ``team_visibility`` defaults to ``TEAM_ONLY`` — the conservative
  psych-safety default per ADR-0071 §3. Existing retros backfill to this.
- ``TaskSuggestedAssignee`` is a new model; the partial unique constraint
  uses ``state="pending"`` literal (no model class import needed).
"""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0034_inbound_task_sync"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # --- SprintRetro uplift -----------------------------------------------
        migrations.AddField(
            model_name="sprintretro",
            name="server_version",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        migrations.AddField(
            model_name="sprintretro",
            name="is_deleted",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="sprintretro",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name="sprintretro",
            name="team_visibility",
            field=models.CharField(
                choices=[
                    ("team_only", "Team Only"),
                    ("project", "Project"),
                    ("org", "Org"),
                ],
                default="team_only",
                max_length=12,
            ),
        ),
        # --- RetroActionItem uplift ------------------------------------------
        migrations.AddField(
            model_name="retroactionitem",
            name="server_version",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        migrations.AddField(
            model_name="retroactionitem",
            name="is_deleted",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="retroactionitem",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
        # --- TaskSuggestedAssignee (new) -------------------------------------
        migrations.CreateModel(
            name="TaskSuggestedAssignee",
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
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                (
                    "deleted_version",
                    models.BigIntegerField(blank=True, editable=False, null=True),
                ),
                ("reason", models.TextField(blank=True, default="")),
                (
                    "source",
                    models.CharField(
                        choices=[
                            ("retrospective", "Retrospective"),
                            ("other", "Other"),
                        ],
                        default="retrospective",
                        max_length=24,
                    ),
                ),
                (
                    "state",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("accepted", "Accepted"),
                            ("declined", "Declined"),
                            ("revoked", "Revoked"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=12,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("accepted_at", models.DateTimeField(blank=True, null=True)),
                ("declined_at", models.DateTimeField(blank=True, null=True)),
                (
                    "suggested_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="suggestions_made",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "suggested_user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_suggestions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="suggested_assignees",
                        to="projects.task",
                    ),
                ),
            ],
            options={
                "db_table": "projects_tasksuggestedassignee",
                "indexes": [
                    models.Index(
                        fields=["suggested_user", "state"],
                        name="suggestion_user_state_idx",
                    ),
                    models.Index(
                        fields=["task", "state"],
                        name="suggestion_task_state_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=["task", "suggested_user"],
                        condition=models.Q(state="pending", is_deleted=False),
                        name="unique_pending_suggestion_per_user_per_task",
                    ),
                ],
            },
        ),
    ]
