"""Partial covering index for GET /me/work/ cross-project queries (ADR-0065 Gap 2)."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    """Add a partial composite index on Task(assignee, status) WHERE NOT is_deleted.

    The My Work endpoint scans across all projects for a single user's active
    assignments. The index stores ``(assignee, status)`` for every non-soft-
    deleted task; the runtime query then narrows further with
    ``status != 'BACKLOG'``, which PG resolves by walking the index entries
    for that assignee and skipping BACKLOG. The partial predicate is on
    ``is_deleted`` only so the index supports both the BACKLOG-excluded
    cross-project list and any future per-status filter on the same access
    pattern without needing a separate index per status.

    None of the existing Task indexes cover the ``(assignee, status)`` lookup;
    without this index a sequential scan over the full task table would
    scale linearly with org size.
    """

    dependencies = [
        ("projects", "0032_task_is_subtask_and_sprint_scope_change"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="task",
            index=models.Index(
                fields=["assignee", "status"],
                condition=models.Q(is_deleted=False),
                name="task_assignee_status_idx",
            ),
        ),
    ]
