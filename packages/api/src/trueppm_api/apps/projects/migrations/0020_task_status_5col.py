"""5-column board model: add BACKLOG and REVIEW to TaskStatus; migrate ON_HOLD → BACKLOG.

Issue #178 — Claude Design handoff phase 0.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations, models

_NEW_CHOICES = [
    ("BACKLOG", "Backlog"),
    ("NOT_STARTED", "Not started"),
    ("IN_PROGRESS", "In progress"),
    ("REVIEW", "Review"),
    ("ON_HOLD", "On hold"),
    ("COMPLETE", "Complete"),
]


def _migrate_on_hold_to_backlog(apps: Any, schema_editor: object) -> None:
    Task = apps.get_model("projects", "Task")
    Task.objects.filter(status="ON_HOLD").update(status="BACKLOG")


def _reverse_migrate(apps: Any, schema_editor: object) -> None:
    # Reverse: BACKLOG has no direct predecessor in the old enum; map back to NOT_STARTED.
    # REVIEW has no predecessor either; map back to IN_PROGRESS.
    Task = apps.get_model("projects", "Task")
    Task.objects.filter(status="BACKLOG").update(status="NOT_STARTED")
    Task.objects.filter(status="REVIEW").update(status="IN_PROGRESS")


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0019_backfill_wbs_paths"),
    ]

    operations = [
        # 1. Expand choices on Task.status (no column-type change — still CharField max_length=12)
        migrations.AlterField(
            model_name="task",
            name="status",
            field=models.CharField(
                choices=_NEW_CHOICES,
                db_index=True,
                default="NOT_STARTED",
                max_length=12,
            ),
        ),
        # 2. Expand choices on HistoricalTask.status
        migrations.AlterField(
            model_name="historicaltask",
            name="status",
            field=models.CharField(
                choices=_NEW_CHOICES,
                db_index=True,
                default="NOT_STARTED",
                max_length=12,
            ),
        ),
        # 3. Data migration: ON_HOLD → BACKLOG
        migrations.RunPython(_migrate_on_hold_to_backlog, _reverse_migrate, elidable=True),
    ]
