"""Data-backfill helpers for the projects app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).
"""

from __future__ import annotations

from typing import Any

from django.db.models import F


def backfill_risk_short_ids(apps: Any, schema_editor: Any) -> None:
    """Renumber existing risks to a contiguous decimal sequence per project (#929).

    Existing risks carry 8-char hex short_ids allocated from the shared
    ``object_sequence`` — the bug behind every register row collapsing to
    ``R-0000``. For each project, order *all* risks (including soft-deleted ones)
    by ``created_at`` and assign ``1, 2, 3 …`` as the new decimal ``short_id``,
    then set ``project.risk_sequence`` to the high-water mark so new risks never
    reuse a number.

    Soft-deleted risks are included in the ordering on purpose: the VoC panel
    required immutability with *no reuse after deletion* (deletion leaves a gap —
    "where is R-8?" is an expected audit finding, not a bug). Numbering only the
    live rows would silently re-pack the sequence and reuse a dead risk's number.

    ``server_version`` is bumped on every renumbered risk so offline/mobile
    clients re-pull the corrected identifier on their next sync delta. The writes
    use bulk ``.update()`` / ``bulk_update()`` — a one-time data correction, not
    an audited user edit, so they intentionally leave no HistoricalRisk rows
    (matching the 0071 backfill precedent).
    """
    Project = apps.get_model("projects", "Project")
    Risk = apps.get_model("projects", "Risk")

    for project_id in Project.objects.values_list("pk", flat=True):
        risks = list(Risk.objects.filter(project_id=project_id).order_by("created_at", "pk"))
        if not risks:
            continue

        # Two-pass renumber. ``unique_risk_short_id_per_project`` is a plain
        # (non-deferrable) UniqueConstraint, so Postgres checks it per-row inside
        # the bulk UPDATE. Writing the final decimals in one pass is only safe
        # because legacy hex short_ids can't equal a bare decimal — but a
        # mixed-version deploy window (new app code minting decimal short_ids
        # before this migration runs) could break that assumption and abort the
        # migration with an IntegrityError. Routing through a sentinel namespace
        # that is disjoint from BOTH legacy hex (uppercase ``[0-9A-F]``) and the
        # final decimals (the lowercase ``x`` prefix guarantees this) makes the
        # renumber collision-proof regardless of the starting values.
        for seq, risk in enumerate(risks, start=1):
            risk.short_id = f"x{seq:07d}"
        Risk.objects.bulk_update(risks, ["short_id"], batch_size=2000)
        for seq, risk in enumerate(risks, start=1):
            risk.short_id = str(seq)
        Risk.objects.bulk_update(risks, ["short_id"], batch_size=2000)

        # Bump server_version so sync clients see the changed short_id. Done as a
        # single bulk UPDATE per project rather than per-row save().
        Risk.objects.filter(project_id=project_id).update(server_version=F("server_version") + 1)
        Project.objects.filter(pk=project_id).update(risk_sequence=len(risks))


def _backfill_wbs_paths(apps: Any, schema_editor: object) -> None:
    """Assign sequential root-level wbs_path values to tasks that have none (#138).

    Tasks with null wbs_path have no hierarchy information (parent_id is derived
    from wbs_path, not stored separately), so they are assigned sequential
    root-level paths within their project, ordered by short_id (project-scoped
    insertion order).
    """
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
