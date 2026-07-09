"""Apply logic for the mobile sync upload (push) endpoint (ADR-0082, #667).

Kept in its own module to keep ``views.py`` focused on the SyncBatch
idempotency/atomicity orchestration. The single public entry point is
:func:`apply_task_changes`, called from ``ProjectSyncView.post`` inside the
batch's ``transaction.atomic`` block.

Conflict resolution mirrors the REST ``perform_update`` field-level guard
(ADR-0217, #1718): a row whose ``base_version`` (its own ``base_version`` key, or
the batch's ``last_pulled_at`` watermark) is stale is checked against the fields a
concurrent writer changed. A disjoint edit still applies (field-level merge); an
overlapping one is reported as a per-row conflict entry and **skipped** — it does
not bump ``server_version`` and does not broadcast. This closes the lost-update
hole where routing a stale edit through ``/sync/`` bypassed the REST 409 that a
stale ``PATCH`` would have hit. A row that omits any base version keeps plain
last-writer-wins, so existing clients are unaffected.

Apply reuses ``TaskSerializer`` — the same serializer the REST PATCH path uses —
so mobile writes inherit identical validation and business rules (progress-anchor
gate, milestone invariant, sprint cross-project IDOR check, auto-promote on
past planned_start). This is deliberate: the upload path must never be able to
do something a member could not do via ``PATCH /tasks/{id}/``.

Per-row edit/delete permission likewise calls ``can_user_edit_task`` (the ADR-0133
source of truth) directly rather than re-implementing the role matrix, so the
upload path can never drift from REST — it previously omitted the Product Owner
facet, silently rolling back a PO's whole offline batch the moment one groomed
EPIC/STORY row was touched (#1771). Edits pass ``method="PATCH"`` and deletes
``method="DELETE"`` so the PO-may-groom-but-not-delete asymmetry is preserved.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from trueppm_api.apps.access.permissions import can_user_edit_task
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


class SyncIdCollision(APIException):
    """A client-generated id in the ``created`` bucket already exists in another project.

    Raised when the upserted row's id resolves to a task the caller's URL-scoped
    project does not own. This is an IDOR guard (#887): without it the upsert
    would treat the foreign row as an idempotent re-create and apply the caller's
    content using their role on the *URL* project, not the project that actually
    owns the row. A 409 forces the offline client to regenerate the id and retry,
    rather than silently mutating a task in a project it cannot see.
    """

    status_code = status.HTTP_409_CONFLICT
    default_detail = (
        "A task with this client-generated id already exists in another project. "
        "Regenerate the id and re-upload."
    )
    default_code = "sync_id_collision"


@dataclass
class BatchApplyResult:
    """Outcome of applying one upload batch — drives the response + broadcasts."""

    created: list[dict[str, Any]] = field(default_factory=list)
    updated: list[dict[str, Any]] = field(default_factory=list)
    deleted: list[dict[str, Any]] = field(default_factory=list)
    # Rows rejected by the field-level conflict guard (#1718): each entry carries the
    # REST-parity 409 body (conflict_fields / server_value / client_value /
    # server_version) plus the row ``id``. A conflicting row is NOT applied — it is
    # absent from created/updated and never bumps server_version or broadcasts.
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    # (event_type, task_id) pairs to broadcast on_commit, mirroring single-row writes.
    events: list[tuple[str, str]] = field(default_factory=list)
    # Highest server_version touched — a convenience watermark for the client.
    max_version: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.created or self.updated or self.deleted)


def _content(row: dict[str, Any]) -> dict[str, Any]:
    """Strip server-controlled keys from an incoming row."""
    return {k: v for k, v in row.items() if k not in _STRIPPED_ROW_KEYS}


def _row_base_version(row: dict[str, Any], batch_base: int | None) -> int | None:
    """The ``server_version`` the client last saw for this row (#1718 conflict guard).

    Prefer a row-level ``base_version`` key (mirroring the REST ``base_version`` body
    key that :func:`~trueppm_api.apps.sync.conflict.parse_base_version` reads) for
    per-row precision; fall back to the batch's ``last_pulled_at`` watermark when the
    row omits it. ``None`` (neither present, or unparseable) preserves the pre-#1718
    last-writer-wins behavior, so existing clients are fully backward compatible.

    Note the row's own ``server_version`` field is deliberately NOT used as the base:
    it is a read-only, server-owned field (stripped on input) and clients have long
    sent arbitrary values there as an opaque marker — repurposing it as a conflict
    base would silently change their semantics.
    """
    raw = row.get("base_version")
    if raw is None or isinstance(raw, bool):
        return batch_base
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return batch_base
    return value if value >= 0 else batch_base


def apply_task_changes(
    *,
    project: Project,
    request: Request,
    role: int,
    changes: dict[str, Any],
    last_pulled_at: int | None = None,
) -> BatchApplyResult:
    """Apply a WatermelonDB-shaped delta for the ``tasks`` collection.

    Processing order is created → updated → deleted so an update or delete that
    references a row created earlier in the same batch resolves. Any row that
    fails its RBAC check raises ``PermissionDenied``, which rolls the whole batch
    back (all-or-nothing) — a batch carrying a forbidden op is rejected entirely.

    A stale edit whose fields overlap a concurrent writer's is NOT an error: it is
    collected in ``result.conflicts`` and skipped (mirroring the REST 409 rather
    than aborting the batch), so the client reconciles just that row while the rest
    commit. ``last_pulled_at`` is the batch's high-water mark from its last pull and
    is the default per-row conflict base (a row may override it with ``base_version``).

    Raises:
        ValidationError: malformed envelope or an unsupported collection key.
        PermissionDenied: a row the caller may not write.
    """
    from trueppm_api.apps.projects.serializers import TaskSerializer
    from trueppm_api.apps.projects.services import maybe_record_scope_injection
    from trueppm_api.apps.sync.conflict import check_row_conflict

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

    # Bulk-fetch every row the batch references in one query so each bucket loop
    # below is a dict lookup, not a per-row SELECT (#809). A 500-row batch
    # previously issued up to 500 Task.objects.filter(...).first() round-trips.
    # Keyed by str(pk) because in_bulk()'s UUID keys won't match the string ids in
    # the JSON payload.
    #
    # SECURITY (#887): this lookup is scoped to ``project``. The created-bucket
    # upsert treats a hit as an idempotent re-create and applies content after a
    # role check on the *URL-scoped* project; if the lookup were unscoped a client
    # could land a created row whose id collides with a task in a different
    # project and mutate it using their role here, not their (possibly absent)
    # role there — a cross-project IDOR. Scoping the fetch means a foreign id
    # simply isn't in ``existing_by_id``; the created loop then probes
    # project-unscoped *only* to distinguish a genuine cross-project collision
    # (→ 409, regenerate) from a fresh id (→ create). The updated and deleted
    # loops re-apply their project + is_deleted predicate in Python as a backstop.
    _batch_ids = {
        str(rid)
        for bucket in ("created", "updated")
        for row in (tasks.get(bucket, []) or [])
        if (rid := row.get("id"))
    } | {str(del_id) for del_id in (tasks.get("deleted", []) or []) if del_id}
    existing_by_id: dict[str, Task] = (
        {str(t.pk): t for t in Task.objects.filter(pk__in=_batch_ids, project=project)}
        if _batch_ids
        else {}
    )

    # --- created (upsert by client-generated id) ------------------------------
    # Pre-compute which created ids resolve to a task in *another* project so a
    # collision is a 409 rather than a silent foreign-row mutation (#887).
    created_ids = {str(rid) for row in (tasks.get("created", []) or []) if (rid := row.get("id"))}
    cross_project_ids: set[str] = set()
    if created_ids:
        # Only ids absent from the project-scoped fetch can be foreign; probe just
        # those, so the common (all-local) batch issues no extra query.
        unknown_ids = created_ids - set(existing_by_id)
        if unknown_ids:
            cross_project_ids = {
                str(pk)
                for pk in Task.objects.filter(pk__in=unknown_ids)
                .exclude(project=project)
                .values_list("pk", flat=True)
            }

    for row in tasks.get("created", []) or []:
        row_id = row.get("id")
        if not row_id:
            raise ValidationError({"tasks.created": "Each created row requires an 'id'."})
        if str(row_id) in cross_project_ids:
            raise SyncIdCollision()
        existing = existing_by_id.get(str(row_id))
        if existing is not None:
            # Idempotent re-create (the row already landed in a prior batch) —
            # apply as an update, but enforce the stricter edit permission.
            if not can_user_edit_task(request, existing, method="PATCH"):
                raise PermissionDenied("You may not edit this task.")
            old_sprint_id = str(existing.sprint_id) if existing.sprint_id else None
            # We already know this row exists (it came from the batched
            # existing_by_id fetch), so tell VersionedModel.save() to skip its
            # per-row exists() probe. DRF's serializer.save() can't forward a
            # save() kwarg, so the known state is carried on the instance (#1527).
            existing._sync_known_exists = True  # type: ignore[attr-defined]
            ser = TaskSerializer(existing, data=_content(row), partial=True, context=ctx)
            ser.is_valid(raise_exception=True)
            # An idempotent re-create is an in-place edit, so it can lose a concurrent
            # update just like the updated bucket — guard it identically (#1718).
            conflict = check_row_conflict(ser, _row_base_version(row, last_pulled_at))
            if conflict is not None:
                result.conflicts.append({"id": str(existing.pk), **conflict})
                continue
            task = ser.save()
            maybe_record_scope_injection(task, old_sprint_id, user)
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
            # A task created directly into an ACTIVE sprint via sync (old link =
            # None) still enters pending-acceptance, not the commitment.
            maybe_record_scope_injection(task, None, user)
            result.events.append(("task_created", str(task.pk)))
        result.created.append({"id": str(task.pk), "server_version": task.server_version})
        _bump(task.server_version)

    # --- updated --------------------------------------------------------------
    for row in tasks.get("updated", []) or []:
        row_id = row.get("id")
        if not row_id:
            raise ValidationError({"tasks.updated": "Each updated row requires an 'id'."})
        target = existing_by_id.get(str(row_id))
        if target is None or target.project_id != project.pk or target.is_deleted:
            # Unknown, cross-project, or already-tombstoned row — skip; the next
            # pull reconciles it via the tombstone. Not an error: a benign
            # offline/online race. (Predicate mirrors the original
            # filter(pk=row_id, project=project, is_deleted=False).)
            continue
        if not can_user_edit_task(request, target, method="PATCH"):
            raise PermissionDenied("You may not edit this task.")
        # ADR-0102 §4: capture the prior sprint link so a task linked to an ACTIVE
        # sprint via sync enters pending-acceptance, same as the REST PATCH path —
        # otherwise an offline edit could land work straight into the commitment.
        old_sprint_id = str(target.sprint_id) if target.sprint_id else None
        # ``target`` came from the batched existing_by_id fetch — the row exists, so
        # skip VersionedModel.save()'s per-row exists() probe (#1527). Carried on the
        # instance because DRF's serializer.save() can't forward a save() kwarg.
        target._sync_known_exists = True  # type: ignore[attr-defined]
        ser = TaskSerializer(target, data=_content(row), partial=True, context=ctx)
        ser.is_valid(raise_exception=True)
        # Field-level lost-update guard (#1718): if this stale edit overlaps a field a
        # concurrent writer changed since the client's base version, skip it and report
        # a per-row conflict rather than silently clobbering — mirrors the REST 409.
        # Skipping before save() means no server_version bump and no broadcast for it.
        # No batch N+1: check_row_conflict short-circuits (no query) unless the row's
        # server_version has actually advanced past the client's base, so the bounded
        # history read runs only for the typically-tiny contended subset, not per row.
        conflict = check_row_conflict(ser, _row_base_version(row, last_pulled_at))
        if conflict is not None:
            result.conflicts.append({"id": str(target.pk), **conflict})
            continue
        saved = ser.save()
        maybe_record_scope_injection(saved, old_sprint_id, user)
        result.updated.append({"id": str(saved.pk), "server_version": saved.server_version})
        result.events.append(("task_updated", str(saved.pk)))
        _bump(saved.server_version)

    # --- deleted --------------------------------------------------------------
    for del_id in tasks.get("deleted", []) or []:
        target = existing_by_id.get(str(del_id))
        if target is None or target.project_id != project.pk or target.is_deleted:
            continue  # unknown, cross-project, or already gone — idempotent
        if not can_user_edit_task(request, target, method="DELETE"):
            raise PermissionDenied("You may not delete this task.")
        target.soft_delete()  # bumps server_version, sets deleted_version, cascades
        result.deleted.append({"id": str(target.pk), "server_version": target.server_version})
        result.events.append(("task_deleted", str(target.pk)))
        _bump(target.server_version)

    return result
