"""Backfill wbs_path for tasks that were created before auto-assignment was added.

Tasks with null wbs_path have no hierarchy information (parent_id is derived
from wbs_path, not stored separately), so they are assigned sequential root-level
paths within their project, ordered by short_id (project-scoped insertion order).
"""

from __future__ import annotations

from typing import Any

from django.db import migrations


def _backfill_wbs_paths(apps: Any, schema_editor: object) -> None:
    Task = apps.get_model("projects", "Task")

    # Order by short_id, not pk: Task.id is a UUID (random), so pk ordering is
    # non-deterministic. short_id is allocated from Project.object_sequence on
    # INSERT and zero-padded to 8 hex digits, so its lexicographic order matches
    # creation order within a project. Backfill from migration 0015 ensures
    # every pre-existing Task has a short_id assigned.
    null_tasks = (
        Task.objects.filter(wbs_path__isnull=True, is_deleted=False)
        .order_by("project_id", "short_id")
        .values_list("id", "project_id")
    )

    project_root_counts: dict[Any, int] = {}
    updates = []
    for task_id, project_id in null_tasks:
        # Count existing root-level tasks (wbs_path matches ^\d+$) for this project.
        # Computed once per project and cached; the update list preserves order so
        # each new task sees the correct next position.
        if project_id not in project_root_counts:
            project_root_counts[project_id] = Task.objects.filter(
                project_id=project_id,
                is_deleted=False,
                wbs_path__isnull=False,
                wbs_path__regex=r"^\d+$",
            ).count()
        project_root_counts[project_id] += 1
        updates.append((task_id, str(project_root_counts[project_id])))

    for task_id, new_path in updates:
        Task.objects.filter(id=task_id).update(wbs_path=new_path)


def _noop(apps: object, schema_editor: object) -> None:
    # Reversing would require knowing the original null state, which is not
    # stored.  Accept data loss on reverse — this migration is additive only.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0018_estimation_governance"),
    ]

    operations = [
        migrations.RunPython(_backfill_wbs_paths, _noop, elidable=True),
    ]
