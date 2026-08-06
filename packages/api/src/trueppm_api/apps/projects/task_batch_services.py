"""Recording and undo for the schedule outline's batch write operations (ADR-0810, #2756).

Three write paths — paste-many (#2724), subtree classification cascade (#2735), and
CSV/Excel import (#2732) — each get a server-recorded, one-shot ⌘Z undo, following
``template_services.py::undo_template_application()``'s pattern: the ledger row is
written inside the same transaction as the batch write, and undo skips any row a
person has since touched rather than blindly reverting it.

The touched-since check here is **not** ``edited_at IS NOT NULL``
(``template_services._has_been_touched``). That check is correct for template-apply
because ``materialize_structure`` writes via ``bulk_create``, which bypasses
``Task.save()`` and leaves ``edited_at`` at ``None`` until a person actually edits the
row. Paste-many creates through the normal ``TaskSerializer``/``Task.save()`` path,
which stamps ``edited_at`` on the very save that creates the row (a write is human
unless it opts out, ADR-0786 §4) — so "touched = edited_at is not None" would report
every freshly pasted row as already touched and undo nothing. Comparing a row's
*current* ``server_version`` (``VersionedModel``, ADR-0686) against the value it held
the moment this module snapshotted it is the check that actually answers "has anyone
changed this since the operation", independent of which write path produced the row.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils import timezone

if TYPE_CHECKING:
    from trueppm_api.apps.csvimport.models import CsvImportRequest
    from trueppm_api.apps.projects.models import (
        CascadeClassificationOperation,
        PasteManyOperation,
        Project,
    )

#: Shape shared by every ``created_task_versions``/``task_snapshots`` lookup: the
#: rows a caller believes an operation touched, mapped to the ``server_version``
#: recorded at operation time.
_VersionSnapshot = dict[str, int]


def _snapshot_versions(task_ids: list[uuid.UUID]) -> _VersionSnapshot:
    """Read back each row's current ``server_version`` right after a batch write.

    Must be called in the same transaction as the write, before it commits, so the
    versions recorded are exactly what the write just produced — the baseline undo
    compares against later.
    """
    from trueppm_api.apps.projects.models import Task

    if not task_ids:
        return {}
    rows = Task.objects.filter(pk__in=task_ids).values_list("pk", "server_version")
    return {str(pk): version for pk, version in rows}


def _partition_touched(snapshot: _VersionSnapshot) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    """Split a snapshot's rows into (untouched, touched) by comparing server_version.

    A row missing from the current read (hard-deleted by the tombstone reap) counts
    as touched — nothing to revert, and reporting it "kept" rather than crashing.
    """
    from trueppm_api.apps.projects.models import Task

    if not snapshot:
        return [], []
    ids = [uuid.UUID(k) for k in snapshot]
    current = dict(
        Task.objects.filter(pk__in=ids, is_deleted=False).values_list("pk", "server_version")
    )
    untouched: list[uuid.UUID] = []
    touched: list[uuid.UUID] = []
    for id_str, recorded_version in snapshot.items():
        task_id = uuid.UUID(id_str)
        current_version = current.get(task_id)
        if current_version is None or current_version != recorded_version:
            touched.append(task_id)
        else:
            untouched.append(task_id)
    return untouched, touched


# ── Paste-many (#2724) ──────────────────────────────────────────────────────────


def record_paste_many_operation(
    project: Project, applied_by: Any, created_ids: list[uuid.UUID]
) -> PasteManyOperation | None:
    """Write the undo ledger row for one paste-many batch create.

    Call inside the same ``transaction.atomic()`` block as the bulk create, after
    the rows exist but before the transaction commits — the version snapshot must
    read back what the paste just wrote. Returns ``None`` (records nothing) when
    the batch created no rows, matching every other operation's "nothing to undo,
    nothing to record" behavior.
    """
    from trueppm_api.apps.projects.models import PasteManyOperation

    if not created_ids:
        return None
    return PasteManyOperation.objects.create(
        project=project,
        applied_by=applied_by,
        created_task_versions=_snapshot_versions(created_ids),
    )


def undo_paste_many_operation(operation: PasteManyOperation) -> dict[str, int]:
    """Reverse one paste-many batch — soft-deletes the rows it created.

    Idempotent: a second call against an already-undone operation is a no-op that
    returns the original result rather than raising. ``select_for_update`` on the
    operation row, inside its own transaction, closes the race a bare ``undone_at``
    check would leave open — two concurrent ⌘Z's (double keypress, retried
    request) serialize instead of both passing the check and double-processing.
    """
    from trueppm_api.apps.projects.models import PasteManyOperation, SyncBatchOperationStatus, Task

    with transaction.atomic():
        operation = PasteManyOperation.objects.select_for_update().get(pk=operation.pk)
        if operation.undone_at is not None:
            return dict(operation.result_summary.get("undo") or {"deleted": 0, "kept": 0})

        untouched, touched = _partition_touched(operation.created_task_versions or {})
        if untouched:
            for row in Task.objects.filter(pk__in=untouched, is_deleted=False):
                row.soft_delete()

        result = {"deleted": len(untouched), "kept": len(touched)}
        operation.status = SyncBatchOperationStatus.UNDONE
        operation.undone_at = timezone.now()
        operation.result_summary = {**(operation.result_summary or {}), "undo": result}
        operation.save(update_fields=["status", "undone_at", "result_summary"])
    return result


# ── Cascade classification (#2735) ──────────────────────────────────────────────

#: The classification fields a cascade can change — see task_classification.py's
#: ``_classify_row``. Kept as a tuple here rather than imported, since importing
#: from task_classification would create a circular import (that module has no
#: reason to know about the undo ledger).
_CLASSIFICATION_FIELDS = ("governance_class", "parent_governance_inherited", "delivery_mode")


def record_cascade_classification_operation(
    project: Project,
    applied_by: Any,
    subtree_id: uuid.UUID,
    before_after: dict[str, dict[str, Any]],
) -> CascadeClassificationOperation | None:
    """Write the undo ledger row for one classification cascade.

    ``before_after`` maps ``str(task_id) -> {"before": {...}, "after": {...}}`` for
    every row the cascade actually changed (built by the caller from the snapshot
    taken before ``_classify_row`` mutates each row in memory). The current
    ``server_version`` of each row is folded in here, in the same transaction as
    the write, for the same reason as paste-many's snapshot.
    """
    from trueppm_api.apps.projects.models import CascadeClassificationOperation

    if not before_after:
        return None
    versions = _snapshot_versions([uuid.UUID(k) for k in before_after])
    task_snapshots = {
        task_id: {**pair, "version": versions.get(task_id)}
        for task_id, pair in before_after.items()
    }
    return CascadeClassificationOperation.objects.create(
        project=project,
        applied_by=applied_by,
        subtree_id=subtree_id,
        task_snapshots=task_snapshots,
    )


def undo_cascade_classification_operation(
    operation: CascadeClassificationOperation,
) -> dict[str, int]:
    """Reverse one cascade — restores each untouched row's prior classification.

    Unlike paste-many/import-fix, cascade rows always pre-exist: undo writes the
    "before" field values back rather than deleting anything. Locks the operation
    row for the same reason as :func:`undo_paste_many_operation`.
    """
    from trueppm_api.apps.projects.models import (
        CascadeClassificationOperation,
        SyncBatchOperationStatus,
        Task,
    )

    with transaction.atomic():
        operation = CascadeClassificationOperation.objects.select_for_update().get(pk=operation.pk)
        if operation.undone_at is not None:
            return dict(operation.result_summary.get("undo") or {"reverted": 0, "kept": 0})

        snapshots = operation.task_snapshots or {}
        version_snapshot = {task_id: entry.get("version") for task_id, entry in snapshots.items()}
        untouched, touched = _partition_touched(version_snapshot)

        reverted = 0
        if untouched:
            rows = {row.pk: row for row in Task.objects.filter(pk__in=untouched, is_deleted=False)}
            for task_id in untouched:
                row = rows.get(task_id)
                if row is None:
                    continue
                before = snapshots[str(task_id)]["before"]
                for field in _CLASSIFICATION_FIELDS:
                    if field in before:
                        setattr(row, field, before[field])
                row.save(update_fields=[f for f in _CLASSIFICATION_FIELDS if f in before])
                reverted += 1

        result = {"reverted": reverted, "kept": len(touched)}
        operation.status = SyncBatchOperationStatus.UNDONE
        operation.undone_at = timezone.now()
        operation.result_summary = {**(operation.result_summary or {}), "undo": result}
        operation.save(update_fields=["status", "undone_at", "result_summary"])
    return result


# ── Import-fix (#2732) ──────────────────────────────────────────────────────────
#
# Async, unlike its two siblings above (ADR-0810 amendment) — CsvImportView.post
# only enqueues the import_csv Celery task. There is no separate ImportFixOperation
# model: apps/csvimport/models.py's CsvImportRequest already is the outbox row for
# this operation (project, status, initiated_by, result_summary, celery_task_id), so
# recording the undo set is two new fields on that row, not a parallel table.


def finalize_import_fix_operation(
    csv_import_request_id: str, created_task_ids: list[uuid.UUID]
) -> None:
    """Stamp the version snapshot onto a CsvImportRequest as its import completes.

    Call inside the same ``transaction.atomic()`` block that claims the row
    (``_claim_import``, DISPATCHED -> DONE) and runs ``import_project`` — the
    same same-transaction guarantee as the other two operations' ledger row.
    Takes an id and does a filtered update, matching ``_claim_import``'s own
    idiom in this call path, rather than a fetch-mutate-save round trip.
    """
    from trueppm_api.apps.csvimport.models import CsvImportRequest

    if not created_task_ids:
        return
    CsvImportRequest.objects.filter(pk=csv_import_request_id).update(
        created_task_versions=_snapshot_versions(created_task_ids)
    )


def undo_import_fix_operation(csv_import_request: CsvImportRequest) -> dict[str, int]:
    """Reverse one CSV import — soft-deletes the rows it created.

    Mirrors :func:`undo_paste_many_operation`, including the row lock. The
    caller (view) is expected to have already checked ``status ==
    CsvImportStatus.DONE`` for a clear 400 on a not-yet-terminal or failed
    import; the re-check under lock here is the concurrency backstop, same
    reasoning as the other two undo functions.
    """
    from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
    from trueppm_api.apps.projects.models import Task

    with transaction.atomic():
        csv_import_request = CsvImportRequest.objects.select_for_update().get(
            pk=csv_import_request.pk
        )
        if csv_import_request.status != CsvImportStatus.DONE:
            return dict(csv_import_request.result_summary.get("undo") or {"deleted": 0, "kept": 0})

        untouched, touched = _partition_touched(csv_import_request.created_task_versions or {})
        if untouched:
            for row in Task.objects.filter(pk__in=untouched, is_deleted=False):
                row.soft_delete()

        result = {"deleted": len(untouched), "kept": len(touched)}
        csv_import_request.status = CsvImportStatus.UNDONE
        csv_import_request.undone_at = timezone.now()
        csv_import_request.result_summary = {
            **(csv_import_request.result_summary or {}),
            "undo": result,
        }
        csv_import_request.save(update_fields=["status", "undone_at", "result_summary"])
    return result


# Purge lives in apps/projects/tasks.py (purge_expired_batch_operations),
# alongside purge_expired_project_exports — see that module for why, and
# ADR-0810's amendment for the correction (TemplateApplication has no purge
# job to sit "alongside"; this mirrors the export-job purge shape instead).
