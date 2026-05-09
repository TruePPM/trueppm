"""Backfill: tasks with status=COMPLETE must have percent_complete=100.

Mirrors the new save() invariant introduced for #381 / epic #361 so the
display clamp on the board and the underlying record agree. Without this
backfill, existing rows that were written under the old "loose coupling"
docstring stay at sub-100 percent_complete and the SPI calculation keeps
treating finished work as partially done.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations


def coerce_complete_to_full_progress(apps: Any, schema_editor: Any) -> None:
    Task = apps.get_model("projects", "Task")
    Task.objects.filter(status="COMPLETE").exclude(percent_complete=100).update(
        percent_complete=100.0,
    )


def noop_reverse(apps: Any, schema_editor: Any) -> None:
    # Reverse is intentionally a no-op: we cannot reconstruct the prior
    # sub-100 values, and rolling back to a state where status=COMPLETE
    # disagrees with progress is the bug we just fixed.
    return


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0028_normalize_notes_field"),
    ]

    operations = [
        migrations.RunPython(coerce_complete_to_full_progress, noop_reverse),
    ]
