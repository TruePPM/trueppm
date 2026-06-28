"""Sprint-boundary firewall — cross-project slip conflict detection (ADR-0120 D4).

The program-scoped CPM pass (ADR-0120 D3) computes *honest* dates: it never freezes
them. When an accepted cross-project dependency pushes a committed task in an ACTIVE
sprint past its ``sprint.finish_date``, that is a conflict the **downstream** team
must see and acknowledge — but the ripple must never silently mutate what the team
committed to (sprint window, membership, status, points, commitment math). This
module is the detection half: it runs inside the program write-back transaction and
upserts one :class:`CrossProjectSlipConflict` row per slipping task, idempotently.

Attribution (which cross edge gets the blame) is deterministic so re-runs converge
on one row per ``(sprint, task)`` instead of flapping: the cross edges are processed
tightest-first (earliest-finishing predecessor, ties broken by edge id) and the first
edge whose downstream reaches a task owns it. A task slipping purely from *in-project*
causes is never flagged here — only the cross-project ripple is the firewall's concern.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from trueppm_api.apps.projects.program_schedule import ProgramScheduleGraph


def _attribute_cross_downstream(graph: ProgramScheduleGraph) -> dict[str, Any]:
    """Map each leaf task to the cross-project edge that constrains it, deterministically.

    Returns ``{leaf_task_id: Dependency}`` for every leaf reachable from an accepted
    cross-project edge. The tightest edge (earliest-finishing predecessor, ties by
    edge id) wins, so the attribution is stable across re-runs regardless of dict
    iteration order — the property the idempotent ``(sprint, task)`` upsert relies on.
    """
    from trueppm_scheduler.engine import _collect_leaves

    result_map = graph.result_map
    leaf_ids = graph.leaf_ids
    children_map = graph.children_map

    # Forward leaf adjacency from the expanded edges the CPM actually ran on.
    adjacency: dict[str, list[str]] = {}
    for sd in graph.expanded_deps:
        adjacency.setdefault(str(sd.predecessor_id), []).append(str(sd.successor_id))

    cross_deps = [d for d in graph.db_deps if d.predecessor.project_id != d.successor.project_id]

    def _predecessor_finish(dep: Any) -> date:
        # Summary predecessors are rolled up into result_map before this runs, so a
        # leaf or summary predecessor both resolve here; date.max sorts undated last.
        sched = result_map.get(str(dep.predecessor_id))
        finish = getattr(sched, "early_finish", None) if sched is not None else None
        return finish or date.max

    attributed: dict[str, Any] = {}
    # Tightest constraint first; the first edge to reach a leaf keeps it.
    for dep in sorted(cross_deps, key=lambda d: (_predecessor_finish(d), str(d.pk))):
        successor_id = str(dep.successor_id)
        if successor_id in leaf_ids:
            seeds = [successor_id]
        else:
            # A cross edge into a summary constrains that summary's leaves.
            seeds = [lid for lid in _collect_leaves(successor_id, children_map) if lid in leaf_ids]

        seen: set[str] = set()
        queue = list(seeds)
        while queue:
            node = queue.pop()
            if node in seen:
                continue
            seen.add(node)
            attributed.setdefault(node, dep)
            queue.extend(adjacency.get(node, []))

    return attributed


def detect_and_upsert_slip_conflicts(graph: ProgramScheduleGraph) -> list[Any]:
    """Detect and upsert cross-project sprint-boundary slip conflicts (ADR-0120 D4).

    For every leaf task that is (1) downstream of an accepted cross-project edge,
    (2) a member of an ACTIVE sprint it is committed to (``sprint_pending=False``),
    and (3) whose program-true ``early_finish`` lands strictly past that sprint's
    (inclusive) ``finish_date``, upsert one :class:`CrossProjectSlipConflict` keyed
    ``(sprint, task)``. Rows that previously slipped but no longer do (task moved
    out, sprint extended/closed, edge rejected, float absorbed) are auto-resolved.

    Lifecycle (idempotent under re-run):

    * **new** → create UNRESOLVED, unacknowledged.
    * **still slipping, unacknowledged** → refresh ``pushed_to`` / attribution.
    * **slipping worse after acknowledgment** (``pushed_to`` increased) → bump
      ``re_slip_count`` and clear the acknowledgment so the badge re-lights — the SM
      sees it came back worse, not a silent date change.
    * **still slipping, acknowledged, not worse** → keep the acknowledgment, refresh
      ``pushed_to`` / attribution.
    * **was auto-resolved, now slipping again** → re-open (UNRESOLVED, ack cleared).
    * **no longer slipping** → AUTO_RESOLVED (kept for audit, off the badge).

    Must run inside the program write-back transaction so a conflict is never visible
    against dates that did not commit. Returns the list of currently-open rows.
    """
    from django.utils import timezone

    from trueppm_api.apps.projects.models import (
        CrossProjectSlipConflict,
        SlipConflictResolution,
        SprintState,
    )

    now = timezone.now()
    result_map = graph.result_map
    db_task_by_id = graph.db_task_by_id
    member_ids = [p.id for p in graph.member_projects]

    attributed = _attribute_cross_downstream(graph)

    detected: set[tuple[Any, Any]] = set()  # (sprint_id, task_id) currently slipping
    open_rows: list[Any] = []
    # Member projects whose conflict set changed this pass (a slip newly detected
    # or a stale one auto-resolved) — broadcast targets so peers refetch the badge
    # live (#1359). A pass with no slip activity adds nothing here and broadcasts
    # nothing, keeping the program recompute quiet on clean schedules.
    affected_project_ids: set[Any] = set()

    for task_id, dep in attributed.items():
        db_task = db_task_by_id.get(task_id)
        if db_task is None:
            continue
        # Only committed members of an ACTIVE sprint can experience a boundary slip.
        # sprint_pending tasks are mid-sprint injections the team hasn't committed to
        # yet, so excluding them avoids firing a conflict for uncommitted work.
        if db_task.sprint_id is None or db_task.sprint_pending:
            continue
        sprint = db_task.sprint  # prefetched via tasks__sprint in the gather
        if sprint is None or sprint.state != SprintState.ACTIVE:
            continue

        sched = result_map.get(task_id)
        early_finish = getattr(sched, "early_finish", None) if sched is not None else None
        # Strict greater-than: finish_date is the inclusive last day of the sprint, so
        # a task finishing *on* the boundary is on time, not a slip.
        if early_finish is None or not (early_finish > sprint.finish_date):
            continue

        detected.add((sprint.pk, db_task.pk))
        affected_project_ids.add(db_task.project_id)
        row = _upsert_conflict(sprint, db_task, dep, early_finish, now)
        if row.is_open:
            open_rows.append(row)

    # Auto-resolve any previously-open conflict in a member project that is no longer
    # in the detected set — the slip went away between passes. Kept for audit; off
    # the open-conflict badge. select_related("task") so each stale row's project id
    # is available for the broadcast fan-out without an extra query per row.
    stale = [
        c
        for c in CrossProjectSlipConflict.objects.filter(
            resolution=SlipConflictResolution.UNRESOLVED,
            task__project_id__in=member_ids,
        )
        .select_related("task")
        .only("id", "sprint_id", "task_id", "task__project_id")
        if (c.sprint_id, c.task_id) not in detected
    ]
    if stale:
        CrossProjectSlipConflict.objects.filter(pk__in=[c.pk for c in stale]).update(
            resolution=SlipConflictResolution.AUTO_RESOLVED,
            resolved_at=now,
        )
        affected_project_ids.update(c.task.project_id for c in stale)

    # Fan a slip_conflicts_updated broadcast out to every project whose conflict
    # set changed this pass so a mounted conflict badge/view refetches live
    # instead of waiting on the next poll (#1359). Runs inside the program
    # write-back transaction, so on_commit defers correctly until those dates
    # commit; snapshot to plain strings for the deferred closure.
    if affected_project_ids:
        from django.db import transaction

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        broadcast_ids = [str(pid) for pid in affected_project_ids]

        def _on_commit() -> None:
            for project_id in broadcast_ids:
                broadcast_board_event(project_id, "slip_conflicts_updated", {})

        transaction.on_commit(_on_commit)

    return open_rows


def _upsert_conflict(sprint: Any, task: Any, dependency: Any, pushed_to: date, now: Any) -> Any:
    """Create or update the single conflict row for ``(sprint, task)``; return it."""
    from trueppm_api.apps.projects.models import (
        CrossProjectSlipConflict,
        SlipConflictResolution,
    )

    row, created = CrossProjectSlipConflict.objects.get_or_create(
        sprint=sprint,
        task=task,
        defaults={
            "dependency": dependency,
            "pushed_to": pushed_to,
            "resolution": SlipConflictResolution.UNRESOLVED,
        },
    )
    if created:
        return row

    fields: list[str] = []

    if row.resolution == SlipConflictResolution.AUTO_RESOLVED:
        # Was resolved, now slipping again — re-open as a fresh, unacknowledged
        # conflict so the badge re-lights.
        row.resolution = SlipConflictResolution.UNRESOLVED
        row.resolved_at = None
        row.acknowledged_by = None
        row.acknowledged_at = None
        fields += ["resolution", "resolved_at", "acknowledged_by", "acknowledged_at"]
    elif row.acknowledged_at is not None and pushed_to > row.pushed_to:
        # Slipped *further* after acknowledgment — re-open the badge and record that
        # it came back worse, rather than silently editing the date under the ack.
        row.re_slip_count += 1
        row.acknowledged_by = None
        row.acknowledged_at = None
        fields += ["re_slip_count", "acknowledged_by", "acknowledged_at"]

    if row.pushed_to != pushed_to:
        row.pushed_to = pushed_to
        fields.append("pushed_to")
    if row.dependency_id != (dependency.pk if dependency else None):
        row.dependency = dependency
        fields.append("dependency")

    if fields:
        row.save(update_fields=fields)
    return row
