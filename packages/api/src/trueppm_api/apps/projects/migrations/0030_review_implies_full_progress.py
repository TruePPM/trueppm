"""Backfill: tasks with status=REVIEW must also have percent_complete=100.

Mirrors migration 0029 (COMPLETE backfill) for the REVIEW state. The new
Task.save() invariant (Option E, VoC 2026-05-08) treats REVIEW as
"work-done, awaiting sign-off" — semantically 100% delivered, the only
difference from COMPLETE is whether the PM has signed off. The display
clamp + SPI math both depend on this row-level invariant; without it,
existing pre-Option-E REVIEW rows with sub-100 progress keep skewing
forecasts.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations


def coerce_review_to_full_progress(apps: Any, schema_editor: Any) -> None:
    Task = apps.get_model("projects", "Task")
    Task.objects.filter(status="REVIEW").exclude(percent_complete=100).update(
        percent_complete=100.0,
    )


def noop_reverse(apps: Any, schema_editor: Any) -> None:
    return


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0029_complete_implies_full_progress"),
    ]

    operations = [
        migrations.RunPython(coerce_review_to_full_progress, noop_reverse),
    ]
