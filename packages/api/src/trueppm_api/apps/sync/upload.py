"""Apply logic for the mobile sync upload (push) endpoint (ADR-0082, #667).

Kept in its own module to keep ``views.py`` focused on the SyncBatch
idempotency/atomicity orchestration. The single public entry point is
:func:`apply_task_changes`, called from ``ProjectSyncView.post`` inside the
batch's ``transaction.atomic`` block.

Conflict resolution is plain last-writer-wins: each row is applied
unconditionally and ``server_version`` is bumped. Field-level merge / 409
conflict bodies are owned by #322 and intentionally not implemented here.

Apply reuses ``TaskSerializer`` — the same serializer the REST PATCH path uses —
so mobile writes inherit identical validation and business rules (progress-anchor
gate, milestone invariant, sprint cross-project IDOR check, auto-promote on
past planned_start). This is deliberate: the upload path must never be able to
do something a member could not do via ``PATCH /tasks/{id}/``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from django.conf import settings
from rest_framework.exceptions import PermissionDenied, ValidationError

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.models import Task

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Project

# v1 writable surface (ADR-0082 §B): mobile may push only the ``tasks``
# collection. Any other key is rejected with 400 rather than silently dropped.
WRITABLE_COLLECTIONS = frozenset({"tasks"})

# Fields the apply layer controls itself — stripped from every incoming row so a
# client cannot reparent a task to another project or forge identity/version.
# (CPM-output and sync-bookkeeping fields are already read-only on TaskSerializer
# and dropped on input automatically.) ``wbs_path`` is writable on TaskSerializer
# but the WBS tree is server-managed — stripping it here keeps the upload from
# corrupting the hierarchy without going through the reparent logic.
_STRIPPED_ROW_KEYS = frozenset({"id", "project", "wbs_path"})

# Default cap on total rows (created + updated + deleted) in one upload batch.
# The whole batch applies inside a single transaction; an unbounded batch would
# hold that transaction (and per-task row locks) open arbitrarily long. The
# per-user request throttle limits frequency, not payload size — this limits
# size. Overridable via settings.TRUEPPM_SYNC_BATCH_MAX_ROWS.
DEFAULT_MAX_BATCH_ROWS = 500


@dataclass
class BatchApplyResult:
    """Outcome of applying one upload batch — drives the response + broadcasts."""

    created: list[dict[str, Any]] = field(default_factory=list)
    updated: list[dict[str, Any]] = field(default_factory=list)
    deleted: list[dict[str, Any]] = field(default_factory=list)
    # (event_type, task_id) pairs to broadcast on_commit, mirroring single-row writes.
    events: list[tuple[str, str]] = field(default_factory=list)
    # Highest server_version touched — a convenience watermark for the client.
    max_version: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.created or self.updated or self.deleted)


def _can_write_existing(task: Task, user_pk: Any, role: int) -> bool:
    """Mirror ``IsProjectMemberWriteOrOwn`` for an existing task.

    ADMIN+ edit any task; Resource Manager (SCHEDULER) cannot edit task content;
    a Team Member may edit only tasks assigned to them; Viewer cannot write.
    Keeping this identical to the REST object permission is what prevents the
    upload path from becoming a privilege-escalation bypass.
    """
    if role >= Role.ADMIN:
        return True
    if role == Role.SCHEDULER:
        return False
    if role == Role.MEMBER:
        return task.assignee_id is not None and task.assignee_id == user_pk
    return False


def _content(row: dict[str, Any]) -> dict[str, Any]:
    """Strip server-controlled keys from an incoming row."""
    return {k: v for k, v in row.items() if k not in _STRIPPED_ROW_KEYS}


def apply_task_changes(
    *,
    project: Project,
    request: Request,
    role: int,
    changes: dict[str, Any],
) -> BatchApplyResult:
    """Apply a WatermelonDB-shaped delta for the ``tasks`` collection.

    Processing order is created → updated → deleted so an update or delete that
    references a row created earlier in the same batch resolves. Any row that
    fails its RBAC check raises ``PermissionDenied``, which rolls the whole batch
    back (all-or-nothing) — a batch carrying a forbidden op is rejected entirely.

    Raises:
        ValidationError: malformed envelope or an unsupported collection key.
        PermissionDenied: a row the caller may not write.
    """
    from trueppm_api.apps.projects.serializers import TaskSerializer

    if not isinstance(changes, dict):
        raise ValidationError({"changes": "Must be an object."})
    unsupported = set(changes) - WRITABLE_COLLECTIONS
    if unsupported:
        raise ValidationError(
            {
                "changes": f"Unsupported collection(s): {', '.join(sorted(unsupported))}. "
                f"Only {', '.join(sorted(WRITABLE_COLLECTIONS))} may be uploaded."
            }
        )

    tasks = changes.get("tasks", {})
    if not isinstance(tasks, dict):
        raise ValidationError({"changes.tasks": "Must be an object."})

    # Bound the batch so one request cannot hold a long transaction open.
    max_rows = getattr(settings, "TRUEPPM_SYNC_BATCH_MAX_ROWS", DEFAULT_MAX_BATCH_ROWS)
    row_count = sum(
        len(tasks.get(bucket, []) or []) for bucket in ("created", "updated", "deleted")
    )
    if row_count > max_rows:
        raise ValidationError(
            {"changes": f"Batch too large: {row_count} rows exceeds the limit of {max_rows}."}
        )

    user = request.user
    ctx = {"request": request, "caller_role": role, "project": project}
    result = BatchApplyResult()

    def _bump(version: int) -> None:
        result.max_version = max(result.max_version, version)

    # --- created (upsert by client-generated id) ------------------------------
    for row in tasks.get("created", []) or []:
        row_id = row.get("id")
        if not row_id:
            raise ValidationError({"tasks.created": "Each created row requires an 'id'."})
        existing = Task.objects.filter(pk=row_id).first()
        if existing is not None:
            # Idempotent re-create (the row already landed in a prior batch) —
            # apply as an update, but enforce the stricter edit permission.
            if not _can_write_existing(existing, user.pk, role):
                raise PermissionDenied("You may not edit this task.")
            ser = TaskSerializer(existing, data=_content(row), partial=True, context=ctx)
            ser.is_valid(raise_exception=True)
            task = ser.save()
            result.events.append(("task_updated", str(task.pk)))
        else:
            # New row. role >= MEMBER (the endpoint gate) is the create bar,
            # matching TaskViewSet create (IsProjectMemberWrite). project is
            # injected from the URL (not the client row, which is stripped) so a
            # push can never create into a different project.
            data = _content(row)
            data["project"] = project.pk
            ser = TaskSerializer(data=data, context=ctx)
            ser.is_valid(raise_exception=True)
            task = ser.save(id=row_id)
            result.events.append(("task_created", str(task.pk)))
        result.created.append({"id": str(task.pk), "server_version": task.server_version})
        _bump(task.server_version)

    # --- updated --------------------------------------------------------------
    for row in tasks.get("updated", []) or []:
        row_id = row.get("id")
        if not row_id:
            raise ValidationError({"tasks.updated": "Each updated row requires an 'id'."})
        target = Task.objects.filter(pk=row_id, project=project, is_deleted=False).first()
        if target is None:
            # Unknown or already-tombstoned row — skip; the next pull reconciles
            # it via the tombstone. Not an error: a benign offline/online race.
            continue
        if not _can_write_existing(target, user.pk, role):
            raise PermissionDenied("You may not edit this task.")
        ser = TaskSerializer(target, data=_content(row), partial=True, context=ctx)
        ser.is_valid(raise_exception=True)
        saved = ser.save()
        result.updated.append({"id": str(saved.pk), "server_version": saved.server_version})
        result.events.append(("task_updated", str(saved.pk)))
        _bump(saved.server_version)

    # --- deleted --------------------------------------------------------------
    for del_id in tasks.get("deleted", []) or []:
        target = Task.objects.filter(pk=del_id, project=project, is_deleted=False).first()
        if target is None:
            continue  # already gone — idempotent
        if not _can_write_existing(target, user.pk, role):
            raise PermissionDenied("You may not delete this task.")
        target.soft_delete()  # bumps server_version, sets deleted_version, cascades
        result.deleted.append({"id": str(target.pk), "server_version": target.server_version})
        result.events.append(("task_deleted", str(target.pk)))
        _bump(target.server_version)

    return result
