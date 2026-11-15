"""One-time repair: retire FF/SF links into a summary task that predate #4437.

ADR-0370's successor-side amendment makes the CPM engine refuse every recalculation
of a project holding a Finish-to-Finish or Start-to-Finish link whose successor is a
summary. Rows written before the rule can already hold one, so an upgrade would turn a
working project into one that cannot be scheduled. This repair tombstones them and logs
each so the planner can redraw the link between subtasks.

Lives outside the migration so a test can exercise it: importing a migration module
couples the suite to migration file names, which a squash deletes. It touches only the
model classes it is handed, never live model code, so it runs against migration-state
models.
"""

from __future__ import annotations

import logging
from typing import Any

from django.db.models import F
from django.utils import timezone

logger = logging.getLogger(__name__)

#: Link types refused when the successor is a summary. Duplicated from
#: ``scheduling.graph_guard.SUMMARY_FORBIDDEN_INBOUND_LINK_TYPES`` on purpose: a data
#: migration pins the rule as of the release that shipped it, and must not move when
#: the live constant does.
INBOUND_FORBIDDEN_TYPES = ("FF", "SF")


def _summary_ids(rows: Any) -> set[str]:
    """Ids among ``(id, wbs_path)`` rows with a direct child — the engine's definition.

    Same rule as ``summary_link_guard.summary_ids_from_paths``, restated here so the
    migration depends on no other module that a later refactor could move.
    """
    by_path = {str(path): str(row_id) for row_id, path in rows if path}
    summaries: set[str] = set()
    for path in by_path:
        parent, _, _ = path.rpartition(".")
        if parent in by_path:
            summaries.add(by_path[parent])
    return summaries


def retire_inbound_summary_links(
    dependency_model: Any, task_model: Any, project_model: Any
) -> list[Any]:
    """Tombstone every live FF/SF dependency whose successor is a summary task.

    A summary is a live task with a live direct child by WBS path — the CPM's own
    children map (:func:`_summary_ids`), computed per project because WBS paths
    are only unique within one. The retire mirrors ``Dependency.soft_delete``: the
    row is kept as a tombstone with ``server_version`` bumped, ``deleted_version`` and
    ``deleted_at`` stamped, and a fresh ``sync_seq`` drawn from the owning (predecessor's)
    project so an offline client's next delta delivers the tombstone. Idempotent: a
    second run finds no live offending link.

    Args:
        dependency_model: ``Dependency`` (live class or migration-state model).
        task_model: ``Task`` likewise.
        project_model: ``Project`` likewise; its ``last_sync_version`` is the cursor.

    Returns:
        The retired dependency rows, for the caller or a test to inspect.
    """
    candidates = list(
        dependency_model.objects.filter(
            is_deleted=False,
            dep_type__in=INBOUND_FORBIDDEN_TYPES,
            successor__is_deleted=False,
        )
        .select_related("predecessor", "successor")
        .order_by("pk")
    )
    if not candidates:
        return []

    summaries_by_project: dict[Any, set[str]] = {}
    for project_id in {dep.successor.project_id for dep in candidates}:
        rows = task_model.objects.filter(project_id=project_id, is_deleted=False).values_list(
            "pk", "wbs_path"
        )
        summaries_by_project[project_id] = _summary_ids(rows)

    retired: list[Any] = []
    for dep in candidates:
        if str(dep.successor_id) not in summaries_by_project[dep.successor.project_id]:
            continue
        owner_id = dep.predecessor.project_id
        project_model.objects.filter(pk=owner_id).update(
            last_sync_version=F("last_sync_version") + 1
        )
        sync_seq = project_model.objects.values_list("last_sync_version", flat=True).get(
            pk=owner_id
        )
        new_version = dep.server_version + 1
        dependency_model.objects.filter(pk=dep.pk).update(
            is_deleted=True,
            server_version=new_version,
            deleted_version=new_version,
            deleted_at=timezone.now(),
            sync_seq=sync_seq,
        )
        logger.warning(
            "retired %s link %s into summary task %s (predecessor %s, project %s): "
            "a summary cannot be the successor of a Finish-to-Finish or "
            "Start-to-Finish link (ADR-0370, #4437); redraw it between subtasks",
            dep.dep_type,
            dep.pk,
            dep.successor_id,
            dep.predecessor_id,
            dep.successor.project_id,
        )
        retired.append(dep)
    return retired
