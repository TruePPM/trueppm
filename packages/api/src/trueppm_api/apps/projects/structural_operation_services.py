"""Recording and undo for the schedule outline's structural acts (ADR-0880, #2974, #3006).

Six gestures reshape the WBS — indent, outdent, reparent, reorder, group, ungroup — and
until this module none of them could be reversed. The session trail (#2948) could say what
happened and not put it back.

All six are reversed by **one** function. Parenthood in this tree is ``wbs_path`` and
nothing else (there is no ``parent_id`` column — see ``models.structural_parent``), so the
entire outline shape is one string per row and "restore the shape" is "restore N strings"
regardless of which gesture produced it. ``undo_structural_operation()`` therefore never
branches on ``StructuralOperation.kind``; a future structural act becomes undoable by
recording a snapshot, with no new inverse code.

Two reuses are wrong here, and both look obvious:

**Do not reuse ``task_batch_services._partition_touched``.** It is correct for paste-many
and cascade, whose fields are independent per row: skipping a touched row leaves the others
consistent. ``wbs_path`` is a tree and its rows are not independent. Restoring a subset can
mint a *duplicate* path, and nothing anywhere in the stack would catch it — there is no
``UniqueConstraint`` on ``(project, wbs_path)``, ``LtreeField`` has no validators, and no
runtime integrity check exists. The next ``rewrite_level`` over that level then reads a
collapsed ``_subtree_snapshot`` bucket and writes garbled paths into the *other* twin's
descendants. Undo here is all-or-nothing: if anything it would write has moved, it refuses.

**Do not reuse ``models.cascade_task_children_restore``.** Restoring a container is not the
same act as restoring a task. That helper resurrects earlier-deleted subtasks — its own
docstring concedes the tradeoff, which was accepted for a user who explicitly clicked
Restore on a row they deleted, not for someone reversing a *grouping*. ``perform_ungroup``
only refuses on *live* subtasks, so a container carrying tombstones ungroups cleanly and a
cascade on undo would silently un-delete them. Undo restores exactly the ids it recorded.
(Its missing project scope — an unscoped ``wbs_path__startswith`` that matched the same
path in every other project — was fixed in #3010; the reuse is still wrong for the reason
above.)
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from trueppm_api.apps.projects.refusal_codes import StructuralUndoBlockedReason

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Project, StructuralOperation

#: Ceiling on how many rows one operation may record.
#:
#: ``MAX_GROUP_SELECTION`` bounds group and ungroup; nothing bounds the other four.
#: ``_get_descendants`` has no limit, so an outdent near the root pulls its whole
#: descendant set *plus* every following sibling it adopts, and a root-level reorder is
#: unbounded in level width. Left uncapped, one reparent on a large project would write two
#: maps of tens of thousands of entries inside the hot write transaction (ADR-0880 §7).
#:
#: Past the cap the act still succeeds — only its *reversal* is refused, and the ledger row
#: records itself ``undoable=False`` so the trail can say so rather than offering a control
#: that fails.
STRUCTURAL_OPERATION_MAX_REGION = 2000


class StructuralUndoRejected(Exception):
    """A refusal that maps to a structured 409 rather than a 500.

    Mirrors ``task_grouping.GroupingRejected``: carries a machine-branchable ``code``
    beside the human sentence, so a client can branch without parsing prose.
    """

    def __init__(self, code: str, detail: str, *, extra: dict[str, Any] | None = None) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.extra = extra or {}

    @property
    def body(self) -> dict[str, Any]:
        return {"code": self.code, "detail": self.detail, **self.extra}


# ── Region capture ──────────────────────────────────────────────────────────────


def reduce_region_roots(paths: set[str]) -> list[str]:
    """Drop any path that already sits under another in the set.

    ``{"1", "1.2"}`` reduces to ``{"1"}`` — capturing 1's subtree already captures
    1.2's. ``""`` is the project root and absorbs everything.
    """
    cleaned = {p for p in paths if p is not None}
    if "" in cleaned:
        return [""]
    out: list[str] = []
    for path in sorted(cleaned):
        if any(path == kept or path.startswith(f"{kept}.") for kept in out):
            continue
        out.append(path)
    return out


def capture_shape(
    project_id: Any, region_roots: list[str], *, limit: int | None = None
) -> dict[str, str]:
    """Read every live row at-or-under ``region_roots`` as ``{task id: wbs_path}``.

    The region is the whole subtree of each root, not just the rows a gesture moved.
    That is deliberate: a row someone else *adds* into an affected level is invisible to
    a per-row check, and it is exactly what produces an orphan when the undo puts the
    surrounding paths back (a row whose parent path no longer exists resolves
    ``parent_id = NULL`` and silently renders at the project root).

    ``limit`` reads at most ``limit + 1`` rows, so the caller can detect an oversized
    region without materializing it. A root-level gesture reduces to ``[""]``, which is
    the whole project — on a large plan that is tens of thousands of rows pulled into a
    dict inside the hot write transaction, twice, only to be discarded when the size
    cap rejects them. The extra row is what makes "more than the cap" distinguishable
    from "exactly the cap".
    """
    from trueppm_api.apps.projects.models import Task

    if not region_roots:
        return {}
    rows = Task.objects.filter(project_id=project_id, is_deleted=False).exclude(wbs_path=None)
    if region_roots != [""]:
        clause = Q()
        for root in region_roots:
            clause |= Q(wbs_path=root) | Q(wbs_path__startswith=f"{root}.")
        rows = rows.filter(clause)
    pairs = rows.values_list("pk", "wbs_path")
    if limit is not None:
        pairs = pairs.order_by("pk")[: limit + 1]
    return {str(pk): str(path) for pk, path in pairs}


class StructuralCapture:
    """Brackets a structural write so the ledger row can be built from both sides.

    Usage inside the endpoint's existing ``transaction.atomic()``::

        capture = StructuralCapture.begin(project.pk, {parent_path})
        ...  # perform the restructure
        capture.record(project=project, applied_by=request.user, kind=..., anchors=[task.pk])

    ``begin`` must run *before* the write and ``record`` *after* it, both inside the same
    transaction, so ``shape_after`` is exactly what the write produced — the baseline the
    undo precondition compares against later.
    """

    def __init__(
        self,
        project_id: Any,
        region_roots: list[str],
        shape_before: dict[str, str],
        *,
        oversized: bool = False,
    ):
        self.project_id = project_id
        self.region_roots = region_roots
        self.shape_before = shape_before
        self.oversized = oversized

    @classmethod
    def begin(cls, project_id: Any, region_roots: set[str]) -> StructuralCapture:
        roots = reduce_region_roots(region_roots)
        # Bounded read. The cap has to be applied HERE, not after both reads: measuring
        # the region by materializing it means an oversized act pays the full cost
        # anyway and then throws the result away, which is the opposite of what a cap
        # is for.
        shape = capture_shape(project_id, roots, limit=STRUCTURAL_OPERATION_MAX_REGION)
        if len(shape) > STRUCTURAL_OPERATION_MAX_REGION:
            return cls(project_id, roots, {}, oversized=True)
        return cls(project_id, roots, shape)

    def record(
        self,
        *,
        project: Project,
        applied_by: Any,
        kind: str,
        anchors: list[uuid.UUID] | None = None,
        created_task_ids: list[uuid.UUID] | None = None,
        deleted_task_ids: list[uuid.UUID] | None = None,
        removed_dependency_ids: list[uuid.UUID] | None = None,
    ) -> StructuralOperation:
        """Write the ledger row. Returns it so the endpoint can echo ``operation_id``."""
        from trueppm_api.apps.projects.models import StructuralOperation, Task

        created = list(created_task_ids or [])
        deleted = list(deleted_task_ids or [])
        # A minted row is not in shape_before and a soft-deleted one drops out of
        # shape_after, so neither is covered by the shape comparison. They are recorded
        # and precondition-checked on their own terms (ADR-0880 §2).
        #
        # An oversized region skips the second read entirely — there is nothing to
        # compare it against and nothing will be persisted.
        shape_after = (
            {}
            if self.oversized
            else capture_shape(
                self.project_id, self.region_roots, limit=STRUCTURAL_OPERATION_MAX_REGION
            )
        )
        region_size = len(set(self.shape_before) | set(shape_after)) + len(created) + len(deleted)
        undoable = not self.oversized and region_size <= STRUCTURAL_OPERATION_MAX_REGION

        created_versions: dict[str, int] = {}
        if undoable and created:
            created_versions = {
                str(pk): version
                for pk, version in Task.objects.filter(
                    pk__in=created, project_id=self.project_id
                ).values_list("pk", "server_version")
            }

        return StructuralOperation.objects.create(
            project=project,
            applied_by=applied_by if getattr(applied_by, "is_authenticated", False) else None,
            kind=kind,
            undoable=undoable,
            region_roots=self.region_roots,
            # An oversized region is not worth persisting — the row exists to tell the
            # trail the act happened and cannot be reversed, not to carry a payload
            # nothing will read.
            shape_before=self.shape_before if undoable else {},
            shape_after=shape_after if undoable else {},
            anchor_task_ids=list(anchors or []),
            created_task_ids=created,
            deleted_task_ids=deleted,
            created_task_versions=created_versions,
            removed_dependency_ids=list(removed_dependency_ids or []),
            result_summary={
                "region_size": region_size,
                "moved": sum(
                    1 for k, v in shape_after.items() if self.shape_before.get(k) not in (None, v)
                ),
                **({} if undoable else {"not_undoable": "region_too_large"}),
            },
        )


# ── Undoability, as a server fact ───────────────────────────────────────────────


def _newest_active_id(operation: StructuralOperation) -> uuid.UUID | None:
    """The id of the operation at the top of this actor's stack in this project.

    Scoped per actor so ⌘Z means "undo *your* last structural act" — a collaborator's
    unrelated act in a disjoint region must not block you (ADR-0880 §8).
    """
    from trueppm_api.apps.projects.models import StructuralOperation, SyncBatchOperationStatus

    return (
        StructuralOperation.objects.filter(
            project_id=operation.project_id,
            applied_by_id=operation.applied_by_id,
            status=SyncBatchOperationStatus.ACTIVE,
        )
        .order_by("-created_at")
        .values_list("pk", flat=True)
        .first()
    )


def undo_blocked_reason(operation: StructuralOperation, *, check_shape: bool = True) -> str:
    """Why this operation cannot be undone right now, or ``""`` if it can.

    ``status`` cannot answer this on its own — its own docstring says the only question
    it answers is whether the row has *already* been undone, while undoability here also
    varies with live shape, stack position and region size. Computing it server-side is
    what stops the web trail and an API client from disagreeing (ADR-0880 §8a).

    Deliberately excludes the role check: authority depends on the *caller*, and this is
    a property of the operation. The view adds ``forbidden`` for the caller it has.

    ``check_shape=False`` skips the drift comparison — the one arm that costs a
    full-region read. The list endpoint passes it because the answer is racy anyway
    (it can flip between a client reading the list and pressing Undo) and the ``409``
    on the write is authoritative regardless. The detail endpoint and the undo itself
    ask the full question.
    """
    from trueppm_api.apps.projects.models import SyncBatchOperationStatus

    if operation.status == SyncBatchOperationStatus.UNDONE:
        return StructuralUndoBlockedReason.ALREADY_UNDONE.value
    if not operation.undoable:
        return StructuralUndoBlockedReason.TOO_LARGE.value
    if _newest_active_id(operation) != operation.pk:
        return StructuralUndoBlockedReason.NOT_TOP_OF_STACK.value
    if check_shape and _describe_shape_drift(operation):
        return StructuralUndoBlockedReason.SHAPE_CHANGED.value
    return StructuralUndoBlockedReason.NONE.value


def _shape_drift(operation: StructuralOperation) -> list[dict[str, Any]]:
    """Rows that moved, vanished, or appeared inside the affected region."""
    drift: list[dict[str, Any]] = []
    recorded: dict[str, str] = operation.shape_after or {}
    live = capture_shape(operation.project_id, operation.region_roots)
    for task_id, path in recorded.items():
        actual = live.get(task_id)
        if actual is None:
            drift.append({"task_id": task_id, "expected_path": path, "change": "removed"})
        elif actual != path:
            drift.append(
                {
                    "task_id": task_id,
                    "expected_path": path,
                    "actual_path": actual,
                    "change": "moved",
                }
            )
    drift.extend(
        {"task_id": task_id, "actual_path": path, "change": "added"}
        for task_id, path in live.items()
        if task_id not in recorded
    )
    return drift


def _tombstone_drift(operation: StructuralOperation) -> list[dict[str, Any]]:
    """Rows this act soft-deleted that somebody has since restored by another route."""
    from trueppm_api.apps.projects.models import Task

    if not operation.deleted_task_ids:
        return []
    still_deleted = set(
        Task.objects.filter(
            pk__in=operation.deleted_task_ids,
            project_id=operation.project_id,
            is_deleted=True,
        ).values_list("pk", flat=True)
    )
    return [
        {"task_id": str(task_id), "change": "restored_elsewhere"}
        for task_id in operation.deleted_task_ids
        if task_id not in still_deleted
    ]


def _minted_row_drift(operation: StructuralOperation) -> list[dict[str, Any]]:
    """Rows this act minted that have since been edited or deleted.

    Undo soft-deletes these, so an edit somebody made to a grouped phase's name — the
    obvious thing to do right after grouping — must block the undo rather than silently
    take the rename with it.
    """
    from trueppm_api.apps.projects.models import Task

    if not operation.created_task_ids:
        return []
    current = dict(
        Task.objects.filter(
            pk__in=operation.created_task_ids,
            project_id=operation.project_id,
            is_deleted=False,
        ).values_list("pk", "server_version")
    )
    drift: list[dict[str, Any]] = []
    for task_id, recorded_version in (operation.created_task_versions or {}).items():
        actual_version = current.get(uuid.UUID(task_id))
        if actual_version is None:
            drift.append({"task_id": task_id, "change": "deleted"})
        elif actual_version != recorded_version:
            drift.append({"task_id": task_id, "change": "edited"})
    return drift


def _edge_drift(operation: StructuralOperation) -> list[dict[str, Any]]:
    """Edges this act removed that somebody has since restored by another route."""
    from trueppm_api.apps.projects.models import Dependency

    if not operation.removed_dependency_ids:
        return []
    still_removed = set(
        Dependency.objects.filter(
            pk__in=operation.removed_dependency_ids, is_deleted=True
        ).values_list("pk", flat=True)
    )
    return [
        {"dependency_id": str(dep_id), "change": "restored_elsewhere"}
        for dep_id in operation.removed_dependency_ids
        if dep_id not in still_removed
    ]


def _describe_shape_drift(operation: StructuralOperation) -> list[dict[str, Any]]:
    """Every way the current state differs from what the operation left behind.

    Covers all four payload dimensions, not just the shape. An earlier draft checked
    ``shape_after`` alone and used that guarantee to justify relaxing the role bar — but a
    soft-deleted row is absent from both ``shape_after`` and the live shape, so the
    comparison matches *whatever happened to it*, and undo would have resurrected a
    container and its CPM edges into a region collaborators had since worked in.
    """
    return [
        *_shape_drift(operation),
        *_tombstone_drift(operation),
        *_minted_row_drift(operation),
        *_edge_drift(operation),
    ]


# ── Undo ────────────────────────────────────────────────────────────────────────


def _raise_if_undo_blocked(locked: Any) -> None:
    """Refuse the undo when the recorded act can no longer be reversed safely.

    Kept together because the three reasons are one decision with three outcomes,
    and each carries operator-facing copy that has to stay beside its condition.
    """
    reason = undo_blocked_reason(locked)
    if reason == StructuralUndoBlockedReason.TOO_LARGE:
        raise StructuralUndoRejected(
            StructuralUndoBlockedReason.TOO_LARGE.value,
            "This change affected too many rows to be reversed automatically.",
        )
    if reason == StructuralUndoBlockedReason.NOT_TOP_OF_STACK:
        raise StructuralUndoRejected(
            StructuralUndoBlockedReason.NOT_TOP_OF_STACK.value,
            "Undo the more recent change first.",
            extra={"blocking_operation_id": str(_newest_active_id(locked))},
        )
    if reason == StructuralUndoBlockedReason.SHAPE_CHANGED:
        raise StructuralUndoRejected(
            StructuralUndoBlockedReason.SHAPE_CHANGED.value,
            "The outline has changed here since — this can no longer be undone.",
            extra={"changed": _describe_shape_drift(locked)},
        )


def _restore_deleted_rows(locked: Any, task_model: Any) -> int:
    """Undo step 1 — restore soft-deleted rows: exact ids, project-scoped, no cascade.

    This is what returns an ungrouped wrapper with its original id, name, notes and
    labels: a soft delete retains them, so nothing needed snapshotting.

    ``on_conflict="repath"`` for the same reason step 2 skips a colliding edge rather
    than failing: an undo that abandons part-way leaves the caller with neither state
    (#3071). ``unique_task_wbs_path_per_project_live`` covers live rows only, so a row
    soft-deleted by this act had its number freed the instant the act ran, and anything
    created since may be sitting on it. The constraint is DEFERRED, so an unguarded
    restore would raise at COMMIT with a constraint name and no row attribution. Step 3
    re-asserts ``shape_before`` immediately after and will move most of these back where
    they belong; re-pathing here only has to make the row legal enough to reach it.

    Caller holds ``transaction.atomic()`` — ``select_for_update()`` below requires it.
    """
    restored = 0
    for row in task_model.objects.select_for_update().filter(
        pk__in=locked.deleted_task_ids, project_id=locked.project_id, is_deleted=True
    ):
        row.restore(on_conflict="repath")
        restored += 1
    return restored


def _restore_dependencies(locked: Any, task_model: Any, dependency_model: Any) -> tuple[int, int]:
    """Undo step 2 — restore edges, returning ``(restored, skipped)``.

    Only where both endpoints are live and the row would not collide on
    ``unique_dependency``. ``capture_graph_state`` builds its edge list from tasks
    filtered ``is_deleted=False``, so an edge pointing at a tombstone is not in the graph
    the feasibility guard validates — it structurally cannot catch what this step writes.
    Guarding here is the primary control.

    Caller holds ``transaction.atomic()`` — ``select_for_update()`` below requires it.
    """
    restored = 0
    skipped = 0
    for dep in dependency_model.objects.select_for_update().filter(
        pk__in=locked.removed_dependency_ids,
        is_deleted=True,
        predecessor__project_id=locked.project_id,
    ):
        endpoints_live = (
            task_model.objects.filter(
                pk__in=[dep.predecessor_id, dep.successor_id],
                project_id=locked.project_id,
                is_deleted=False,
            ).count()
            == 2
        )
        collides = (
            dependency_model.objects.filter(
                predecessor_id=dep.predecessor_id,
                successor_id=dep.successor_id,
                dep_type=dep.dep_type,
                is_deleted=False,
            )
            .exclude(pk=dep.pk)
            .exists()
        )
        if not endpoints_live or collides:
            skipped += 1
            continue
        dep.restore()
        restored += 1
    return restored, skipped


def _restore_shape(locked: Any, task_model: Any) -> int:
    """Undo step 3 — put the outline shape back, returning the number of rows moved.

    Caller holds ``transaction.atomic()`` — ``select_for_update()`` below requires it.
    """
    restored = 0
    rows_by_id = {
        str(row.pk): row
        for row in task_model.objects.select_for_update().filter(
            pk__in=[uuid.UUID(k) for k in (locked.shape_before or {})],
            project_id=locked.project_id,
        )
    }
    for task_id, path in (locked.shape_before or {}).items():
        target = rows_by_id.get(task_id)
        if target is None or str(target.wbs_path) == path:
            continue
        target.wbs_path = path
        target.save(update_fields=["wbs_path"])
        restored += 1
    return restored


def _unmint_created_rows(locked: Any, task_model: Any) -> int:
    """Undo step 4 — un-mint what the act minted.

    Caller holds ``transaction.atomic()`` — ``select_for_update()`` below requires it.
    """
    removed = 0
    for row in task_model.objects.select_for_update().filter(
        pk__in=locked.created_task_ids, project_id=locked.project_id, is_deleted=False
    ):
        row.soft_delete()
        removed += 1
    return removed


def undo_structural_operation(
    operation: StructuralOperation,
    *,
    undone_by: Any = None,
    authorize: Any = None,
) -> dict[str, int]:
    """Reverse one structural act. All-or-nothing, idempotent, kind-agnostic.

    ``authorize`` is called with the list of ``Task`` rows the forward act itself gated
    on plus, separately, the rows this undo will delete or restore — the view supplies it
    so the permission vocabulary stays in the view layer. It must raise to refuse.

    Returns the undo summary. A second call on an already-undone row returns the recorded
    summary unchanged rather than raising: a double ⌘Z is a no-op, not an error, matching
    ``undo_paste_many_operation``.
    """
    from trueppm_api.apps.projects.models import (
        Dependency,
        StructuralOperation,
        SyncBatchOperationStatus,
        Task,
    )
    from trueppm_api.apps.projects.task_grouping import assert_graph_feasible, capture_graph_state

    with transaction.atomic():
        locked = StructuralOperation.objects.select_for_update().get(pk=operation.pk)
        if locked.status == SyncBatchOperationStatus.UNDONE:
            return dict(locked.result_summary.get("undo", {}))

        _raise_if_undo_blocked(locked)

        # `graph_before` must be read before step 1 writes any edge: undo restores
        # dependencies, so unlike group/ungroup the differential guard below is live on
        # this path and needs a true pre-undo baseline (ADR-0880 §7a).
        graph_before = capture_graph_state(locked.project_id)

        if authorize is not None:
            authorize(
                move_rows=list(
                    Task.objects.filter(
                        pk__in=locked.anchor_task_ids,
                        project_id=locked.project_id,
                        is_deleted=False,
                    )
                ),
                # Only rows the act SOFT-DELETED are gated at delete grade. Rows it
                # MINTED are not: `perform_group` creates its container with no
                # assignee and demands no delete authority to make it, so demanding
                # delete authority to un-make it denies a Member the reversal of
                # their own group — the exact asymmetry this design exists to
                # remove, reproduced one layer down. Un-minting is gated by the
                # authority the mint required, which is the anchors above.
                restore_rows=list(
                    Task.objects.filter(
                        pk__in=locked.deleted_task_ids,
                        project_id=locked.project_id,
                    )
                ),
            )

        # Steps 1-4 each run inside this transaction; see the helpers for why each
        # guards the way it does.
        deleted_restored = _restore_deleted_rows(locked, Task)

        deps_restored, deps_skipped = _restore_dependencies(locked, Task, Dependency)

        restored = _restore_shape(locked, Task)

        created_removed = _unmint_created_rows(locked, Task)

        # A row that gained or lost children needs its shadow values re-parked. Every
        #    distinct parent path on either side of the restore is a candidate; reading
        #    from current state (not replaying the act) means this converges even on the
        #    paths where the forward endpoints skip it.
        _resync_shadow_values(locked)

        assert_graph_feasible(locked.project_id, graph_before)

        summary = {
            "restored": restored,
            "created_removed": created_removed,
            "deleted_restored": deleted_restored,
            "dependencies_restored": deps_restored,
            "dependencies_skipped": deps_skipped,
        }
        locked.status = SyncBatchOperationStatus.UNDONE
        locked.undone_at = timezone.now()
        locked.undone_by = undone_by if getattr(undone_by, "is_authenticated", False) else None
        locked.result_summary = {**locked.result_summary, "undo": summary}
        locked.save(
            update_fields=["status", "undone_at", "undone_by", "result_summary"],
        )

        _broadcast_and_recalc(locked.project_id)
        return summary


def _resync_shadow_values(operation: StructuralOperation) -> None:
    """Re-park own_status/own_estimate and structure_role on every affected parent.

    Persists through :func:`resync_container_declarations`. The earlier version called
    ``sync_structure_shadow_values`` and stopped there — which mutates the instance and
    returns whether a write is needed, so the whole pass converged in memory and was
    discarded at the end of the loop (#3010). Undo's own tests could not see it: they
    assert the restored tree shape, and the shape was always right.
    """
    from trueppm_api.apps.projects.models import Task, resync_container_declarations

    parent_paths = {
        path.rsplit(".", 1)[0]
        for shape in (operation.shape_before or {}, operation.shape_after or {})
        for path in shape.values()
        if "." in path
    }
    if not parent_paths:
        return
    # Lock and read all N parents in ONE statement, then tell the helper not to
    # re-read them. Letting it re-SELECT each row it was just handed made this pass
    # O(N) round trips, and `STRUCTURAL_OPERATION_MAX_REGION` bounds N at 2000.
    # Ordered by wbs_path so concurrent undos in the same region queue rather than
    # deadlock.
    resync_container_declarations(
        *Task.objects.select_for_update()
        .filter(
            project_id=operation.project_id, is_deleted=False, wbs_path__in=sorted(parent_paths)
        )
        .order_by("wbs_path"),
        already_locked=True,
    )


def _broadcast_and_recalc(project_id: Any) -> None:
    """Post-commit hooks mirroring the forward acts' own, so clients need no change.

    The six structural endpoints all emit ``tasks_restructured`` with an empty payload and
    enqueue a recalculation; an undo is the same kind of mutation and emits the same event,
    so existing collaborator clients already handle it.
    """
    from trueppm_api.apps.scheduling.services import enqueue_recalculate
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    project_id_str = str(project_id)
    transaction.on_commit(lambda: enqueue_recalculate(project_id_str))
    transaction.on_commit(lambda: broadcast_board_event(project_id_str, "tasks_restructured", {}))


def may_undo(request: Request, operation: StructuralOperation) -> bool:
    """Whether this caller clears the actor-or-Admin bar. Never raises.

    Exists so the serializer can report ``forbidden`` rather than advertising an
    enabled Undo on a row that will 403 — the serializer's whole reason for computing
    undoability server-side is that the web trail and an API client must not each
    guess separately, and authority is part of the answer.
    """
    try:
        require_structural_undo_authority(request, operation)
    except Exception:
        return False
    return True


def require_structural_undo_authority(request: Request, operation: StructuralOperation) -> None:
    """Gate an undo: your own act at the act's own authority, anyone else's at Admin+.

    ``_require_admin`` (``batch_operation_views``) demands Admin for every batch undo,
    reasoning that undo "removes work other collaborators may already be building on top
    of". That premise does not hold here: the all-or-nothing precondition refuses outright
    if anything the undo would write has moved, so the hazard the Admin bar exists for is
    unreachable. Importing it would re-impose ADR-0773's asymmetry — a Member may indent
    and could not un-indent — with no safety left to justify it. This follows
    ``IsProjectAdminOrSessionOwner``'s shape instead: Admin **or** the actor.
    """
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.access.models import Role
    from trueppm_api.apps.access.permissions import _membership_role

    if operation.applied_by_id == getattr(request.user, "pk", None):
        return
    role = _membership_role(request, str(operation.project_id))
    if role is None or role < Role.ADMIN:
        raise PermissionDenied(
            "You need at least Project Manager role to undo someone else's change."
        )
