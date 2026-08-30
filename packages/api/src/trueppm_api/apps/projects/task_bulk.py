"""Per-row application for ``POST /projects/{pk}/tasks/bulk/`` (#2723, ADR-0772).

The endpoint used to apply operations in request order and stop at the first
rejection. That was not the clean all-or-nothing rollback it looked like:
``_apply_bulk_operations`` **returned** the error Response rather than raising, so
the enclosing ``transaction.atomic()`` block exited *normally* and every operation
before the rejection committed — while the ``transaction.on_commit`` registrations
for CPM recalculation and the board broadcast were skipped, because the view had
already returned. A partially-applied batch therefore left a silently stale
schedule and no notification to collaborators (#2746).

This module replaces that with per-row application and a 207 response:

    {
      "applied":  [{index, id, op, outcome, task}],
      "rejected": [{index, id, code, message}],
      "skipped":  [{index, id, code, message}],
      "dependencies": {"applied": [...], "rejected": [...]}
    }

``index`` — not ``id`` — is the correlation handle (ADR-0772 §2). A row rejected
because its id is unparseable has no usable id to echo back, and a create that
omitted one has none at all.

Two structural requirements the 207 contract introduces, neither of which the sync
path needs because it aborts wholesale:

- **Per-row savepoints.** A database-level failure (an ``IntegrityError`` the
  serializer did not catch) poisons the enclosing transaction, and any subsequent
  query then raises ``TransactionManagementError``. Continuing to the next row is
  therefore impossible inside a single flat ``atomic()``: each row runs in its own
  savepoint so one row's failure rolls back only that row.
- **Create ids join the lock set.** Under the upsert branch a create id may resolve
  to an existing row, so create ids must be locked with the update/delete targets —
  otherwise the existence check and the write are a TOCTOU window and two concurrent
  batches minting the same id can interleave.
"""

from __future__ import annotations

import dataclasses
import uuid
from typing import TYPE_CHECKING, Any

from django.db import DatabaseError, connection, transaction
from rest_framework.exceptions import PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import can_user_edit_task
from trueppm_api.apps.projects.models import TaskSource
from trueppm_api.apps.projects.refusal_codes import BulkRefusalCode
from trueppm_api.apps.projects.row_identity import (
    is_tombstoned,
    parse_row_uuid,
)

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Project, Task

# ---------------------------------------------------------------------------
# Reject / skip vocabulary
# ---------------------------------------------------------------------------
# The codes themselves — and the notes on what each one means and whether
# retrying is worth the caller's time — live in ``refusal_codes.BulkRefusalCode``,
# which is also what the response serializer publishes as an ``enum`` into the
# OpenAPI schema (#3037). The names below are kept as module constants so the ~46
# call sites in this file read as prose rather than as attribute chains, and are
# bound to ``.value`` so what reaches ``json.dumps`` is a plain ``str`` and not an
# enum member whose repr could drift with a Django version.
#
# Add a code by adding a member there. Writing a bare string literal at a call
# site here puts a code on the wire that the schema does not publish, which is the
# exact defect #3037 was filed about.

CODE_MALFORMED_ID = BulkRefusalCode.MALFORMED_ID.value
CODE_ID_UNAVAILABLE = BulkRefusalCode.ID_UNAVAILABLE.value
CODE_NOT_FOUND = BulkRefusalCode.NOT_FOUND.value
CODE_FORBIDDEN = BulkRefusalCode.FORBIDDEN.value
CODE_INVALID = BulkRefusalCode.INVALID.value
CODE_CONFLICT = BulkRefusalCode.CONFLICT.value
CODE_CYCLIC_DEPENDENCY = BulkRefusalCode.CYCLIC_DEPENDENCY.value
CODE_SELF_REFERENCE = BulkRefusalCode.SELF_REFERENCE.value
CODE_UNRESOLVED_ENDPOINT = BulkRefusalCode.UNRESOLVED_ENDPOINT.value
CODE_TOMBSTONED = BulkRefusalCode.TOMBSTONED.value
CODE_MILESTONE_GATE = BulkRefusalCode.MILESTONE_GATE.value

#: Rejection text for a progress write with nothing to anchor the work to.
#:
#: Emitted from all three op handlers (create, update, delete-cascade), so it lives
#: here rather than being repeated — the three must stay identical, since clients
#: match on the pair (code, message) and a drifted copy reads as a different error.
MSG_PROGRESS_NEEDS_ANCHOR = (
    "Cannot record progress without a planned start date or sprint assignment."
)

#: One resolved edge awaiting the graph guard: (row index, raw row, predecessor, successor).
_EdgeEntry = tuple[int, dict[str, Any], str, str]

#: Maximum operations in one batch.
#:
#: ADR-0772 decides that a cap is *required* and leaves the value to #2723. 500
#: matches ``sync/upload.py``'s ``DEFAULT_MAX_BATCH_ROWS``, so the two write paths
#: bound a batch identically, and it sits comfortably above the largest realistic
#: paste-many. Before this, the endpoint had no cap at all: ``operations`` was a
#: ``ListField(min_length=1)`` with no ``max_length`` and the view declared no
#: throttles, so the only real bounds were ``DATA_UPLOAD_MAX_MEMORY_SIZE`` and the
#: global per-user throttle.
TASK_BULK_MAX_OPERATIONS = 500

#: Maximum dependency edges in one batch. Separate budget from ``operations``: a
#: paste-many of N rows can legitimately carry up to N-1 edges chaining them, so
#: sharing one budget would make the edge count silently eat the row count.
TASK_BULK_MAX_DEPENDENCIES = 500


@dataclasses.dataclass
class BulkOutcome:
    """Accumulator for one batch's per-row results."""

    applied: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    rejected: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    skipped: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    dep_applied: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    dep_rejected: list[dict[str, Any]] = dataclasses.field(default_factory=list)

    #: Task ids that actually changed, in application order — the set the post-commit
    #: recalculation and the ``tasks_bulk_mutated`` broadcast are computed over. A
    #: partial 207 must never broadcast an id it rejected.
    created_ids: list[uuid.UUID] = dataclasses.field(default_factory=list)
    updated_ids: list[uuid.UUID] = dataclasses.field(default_factory=list)
    deleted_ids: list[str] = dataclasses.field(default_factory=list)
    project_start_shifted: bool = False

    def reject(self, index: int, row_id: Any, code: str, message: str) -> None:
        self.rejected.append(
            {
                "index": index,
                "id": str(row_id) if row_id else None,
                "code": code,
                "message": message,
            }
        )

    def skip(self, index: int, row_id: Any, code: str, message: str) -> None:
        self.skipped.append(
            {
                "index": index,
                "id": str(row_id) if row_id else None,
                "code": code,
                "message": message,
            }
        )

    def dep_reject(self, index: int, code: str, message: str, **extra: Any) -> None:
        """Reject one dependency-edge row.

        ``id`` is always ``null`` — dependency ids are server-assigned (ADR-0772), so
        there is never a client-resolvable id to echo back. Still required in the
        dict: ``TaskBulkProblemEntrySerializer`` (reused for both ``rejected`` and
        ``dependencies.rejected``) declares ``id`` as a required, nullable field, and
        the view returns this dict directly rather than through the serializer, so an
        omitted key reaches the client as a schema violation instead of being caught.
        """
        self.dep_rejected.append(
            {"index": index, "id": None, "code": code, "message": message, **extra}
        )

    @property
    def mutated_task_ids(self) -> list[str]:
        """Every task id this batch actually changed."""
        return [str(t) for t in self.created_ids + self.updated_ids] + list(self.deleted_ids)

    @property
    def touched_anything(self) -> bool:
        """Whether any write committed — the condition for recalculating and broadcasting."""
        return bool(self.created_ids or self.updated_ids or self.deleted_ids or self.dep_applied)


@dataclasses.dataclass
class _CachedParent:
    """A placement-cache entry (#2724 perf): a parent resolved and guard-checked once."""

    task: Task
    #: 1-based WBS position the NEXT child placed under this parent should get.
    next_child_index: int


@dataclasses.dataclass
class _PlacementCache:
    """Batch-local memo for :func:`_resolve_bulk_create_placement` (#2724).

    Without this, a paste of N children under one new phase re-queries that phase's
    sibling count on every row via ``_get_siblings`` — a query whose result set grows
    each time, so N rows cost O(N) queries scanning O(N) cumulative locked rows. Each
    distinct parent is resolved and guard-checked (milestone/depth/phase) exactly ONCE
    per batch; every later row targeting the same parent reuses the cached, already-
    validated parent and increments an in-memory counter instead. Root-level rows get
    the same treatment via a single counter, replacing N calls to
    ``_next_root_wbs_path``'s locked ``.count()`` with one.
    """

    parents: dict[str, _CachedParent] = dataclasses.field(default_factory=dict)
    #: Next root-level WBS position, or ``None`` until the first root row asks.
    next_root_index: int | None = None


@dataclasses.dataclass(frozen=True)
class BulkContext:
    """Per-request inputs every row in a batch shares."""

    project: Project
    request: Request
    caller_role: int
    caller: Any
    #: Live rows this batch references, locked FOR UPDATE, keyed by ``str(pk)``.
    #: Includes create-op ids (ADR-0772): under the upsert branch a create id may
    #: resolve to an existing row, so it must be locked with the rest or the
    #: existence check and the write are a TOCTOU window.
    locked_by_id: dict[str, Task]
    #: Ids that resolve to a task in another project (guard 2).
    foreign_ids: set[str]
    #: Provenance to stamp on rows this batch *creates* (#3038, ADR-0786). Defaults
    #: to ``TaskSource.HAND`` — a caller that declares nothing keeps today's
    #: behavior. Never applied to a recreate-as-edit (``_apply_recreate_as_edit``):
    #: that path edits a row that already exists, so its provenance was set when
    #: the row was first created and is not this write's to overwrite.
    source_kind: str = TaskSource.HAND
    #: Mutated in place across rows (#2724) — frozen only blocks reassigning the
    #: attribute itself, not mutating what it points to.
    placement_cache: _PlacementCache = dataclasses.field(default_factory=_PlacementCache)


def _row_serializer_context(ctx: BulkContext) -> dict[str, Any]:
    return {"request": ctx.request, "caller_role": ctx.caller_role}


def _first_error_message(exc: DRFValidationError) -> str:
    """Flatten a DRF validation error to one human sentence for ``rejected[].message``."""
    detail = exc.detail
    if isinstance(detail, dict):
        for field, errors in detail.items():
            first = errors[0] if isinstance(errors, list) and errors else errors
            return f"{field}: {first}"
    if isinstance(detail, list) and detail:
        return str(detail[0])
    return str(detail)


def _validate_or_reject(ser: Any, index: int, row_id: Any, out: BulkOutcome) -> bool:
    """Validate one row's serializer, converting a known failure to a rejection.

    Returns ``True`` when the row validated and the caller may save.

    The three failures are caught separately rather than as one ``Exception`` arm
    because clients match on the pair ``(code, message)`` and each carries a
    different remediation. ``ProgressAnchorError`` and ``MilestoneRollupLockedError``
    both derive from plain ``Exception``, not from ``DRFValidationError``, so the
    order of the arms is not load-bearing.

    Safe to use on the create path even though ``MilestoneRollupLockedError`` cannot
    arise there: ``_enforce_milestone_rollup_lock`` short-circuits on
    ``self.instance is None``, so that arm is dead for an unbound serializer rather
    than newly-reachable behavior.
    """
    from trueppm_api.apps.projects.serializers import (
        MilestoneRollupLockedError,
        ProgressAnchorError,
    )

    try:
        ser.is_valid(raise_exception=True)
    except ProgressAnchorError:
        out.reject(index, row_id, CODE_INVALID, MSG_PROGRESS_NEEDS_ANCHOR)
        return False
    except MilestoneRollupLockedError:
        out.reject(
            index, row_id, CODE_INVALID, "This milestone's progress is rolled up from a sprint."
        )
        return False
    except DRFValidationError as exc:
        out.reject(index, row_id, CODE_INVALID, _first_error_message(exc))
        return False
    return True


def _milestone_gate_applies(task: Task, data: dict[str, Any]) -> bool:
    """Whether a classification op must skip this row rather than re-type it (#2723 §4).

    ``delivery_mode`` and ``is_milestone`` are two encodings of one fact, coupled by
    ``TaskSerializer._reconcile_milestone_signals``. So a classification that sets
    ``delivery_mode`` on a milestone row would silently *un-milestone* it — quietly
    dissolving a gate that the plan's structure depends on.

    A milestone is therefore skipped, not rejected: a classification crossing a gate
    is a documented no-op, never a failure, so one milestone inside a pasted subtree
    cannot fail the rows around it.

    An **explicit** ``is_milestone`` in the same op is a deliberate act by an author
    who can see the row, so it proceeds. The gate only catches the case where the
    caller classified a range and a milestone happened to be inside it.
    """
    from trueppm_api.apps.projects.models import DeliveryMode

    if "delivery_mode" not in data or "is_milestone" in data:
        return False
    if data["delivery_mode"] == DeliveryMode.MILESTONE:
        return False
    return bool(task.is_milestone)


def _resolve_bulk_create_placement(
    index: int,
    row_id: uuid.UUID | None,
    parent_id_raw: Any,
    is_subtask: bool,
    ctx: BulkContext,
    out: BulkOutcome,
) -> tuple[Task | None, str] | None:
    """Resolve a bulk create's WBS placement, or record its rejection and return ``None``.

    Mirrors ``TaskViewSet.perform_create`` rather than duplicating its guards, and
    caches per parent for the batch's duration (``ctx.placement_cache`` — see
    ``_PlacementCache``) so an N-child paste costs O(distinct parents), not O(N),
    in placement queries. Imported locally — ``views`` imports ``task_bulk`` at
    call time (``TaskBulkView.post``), so a module-level import here would be
    circular.
    """
    from trueppm_api.apps.projects.views import (
        _build_wbs_path,
        _next_root_wbs_path,
        _resolve_create_parent,
    )

    cache = ctx.placement_cache

    if not parent_id_raw:
        if cache.next_root_index is None:
            cache.next_root_index = int(_next_root_wbs_path(ctx.project))
        wbs_path = str(cache.next_root_index)
        cache.next_root_index += 1
        return None, wbs_path

    # Unlike `id`, `parent_id` reaches here straight from a raw, unvalidated
    # `DictField` (`data`) — a non-UUID value passed to `.get(pk=...)` raises
    # Django's core `ValidationError`, not DRF's. That type is NOT one of the
    # exceptions `apply_task_operations`'s per-row savepoint catches, so an
    # unparseable `parent_id` would 500 the WHOLE request and roll back every row
    # already applied in this batch — exactly the "one bad row" failure #2723 was
    # written to prevent. Parsed the same way `id` already is (row_identity).
    parent_id = parse_row_uuid(parent_id_raw)
    if parent_id is None:
        out.reject(index, row_id, CODE_MALFORMED_ID, "'parent_id' is not a valid UUID.")
        return None

    cache_key = str(parent_id)
    cached = cache.parents.get(cache_key)
    if cached is not None:
        wbs_path = _build_wbs_path(str(cached.task.wbs_path), cached.next_child_index)
        cached.next_child_index += 1
        return cached.task, wbs_path

    try:
        parent, wbs_path = _resolve_create_parent(ctx.project, parent_id, is_subtask=is_subtask)
    except DRFValidationError as exc:
        out.reject(index, row_id, CODE_INVALID, _first_error_message(exc))
        return None
    next_child_index = int(wbs_path.rsplit(".", 1)[-1]) + 1
    cache.parents[cache_key] = _CachedParent(task=parent, next_child_index=next_child_index)
    return parent, wbs_path


def _spawn_subtask_under(parent_task: Task, task: Task, ctx: BulkContext, out: BulkOutcome) -> None:
    """Record a subtask's spawn and fold the parent's mutation into the batch outcome.

    ``_record_subtask_spawn`` bumps the parent's ``server_version`` — a real mutation
    ``mutated_task_ids`` must carry, or the ``tasks_bulk_mutated`` broadcast silently
    omits it (its own docstring promises "every task id this batch actually changed").
    Skipped when the parent was itself created earlier in this same batch (already in
    ``created_ids``), so the payload never carries a duplicate id.
    """
    from trueppm_api.apps.projects.views import _record_subtask_spawn

    _record_subtask_spawn(parent_task, task, ctx.request.user)
    if parent_task.pk not in out.created_ids and parent_task.pk not in out.updated_ids:
        out.updated_ids.append(parent_task.pk)


def _apply_recreate_as_edit(
    index: int,
    row_id: uuid.UUID | None,
    existing: Task,
    data: dict[str, Any],
    ctx: BulkContext,
    out: BulkOutcome,
) -> None:
    """Apply a ``create`` whose id already exists as an in-place edit (ADR-0772 guard 4).

    The row landed in a prior batch, so this is an idempotent re-create. It is applied
    under the STRICTER *edit* bar, not the create bar. Getting that backwards is the
    trap the guard names: it would turn a client-mintable id into a privilege-escalation
    primitive, letting a Member mint the id of somebody else's task and rewrite it as a
    "create".
    """
    from trueppm_api.apps.projects.serializers import TaskSerializer
    from trueppm_api.apps.projects.services import maybe_record_scope_injection

    if not can_user_edit_task(ctx.request, existing, method="PATCH"):
        out.reject(index, row_id, CODE_FORBIDDEN, "You may not edit this task.")
        return
    # Snapshot BEFORE the serializer save: `ser.save()` mutates the instance in
    # place, so reading `sprint_id` afterwards would compare the new value with
    # itself and the injection would never be detected.
    old_sprint_id = str(existing.sprint_id) if existing.sprint_id else None
    ser = TaskSerializer(existing, data=data, partial=True, context=_row_serializer_context(ctx))
    if not _validate_or_reject(ser, index, row_id, out):
        return
    task = ser.save()
    maybe_record_scope_injection(task, old_sprint_id, ctx.request.user)
    out.updated_ids.append(task.pk)
    out.applied.append({"index": index, "id": str(task.pk), "op": "create", "outcome": "updated"})
    _note_project_start_shift(task, out)


def _apply_create(index: int, op: dict[str, Any], ctx: BulkContext, out: BulkOutcome) -> None:
    """Apply one ``create`` op, honoring the four client-minted-id guards."""
    from trueppm_api.apps.projects.serializers import TaskSerializer
    from trueppm_api.apps.projects.services import maybe_record_scope_injection

    data = dict(op.get("data") or {})
    raw_id = op.get("id")
    row_id: uuid.UUID | None = None

    if raw_id is not None:
        row_id = parse_row_uuid(raw_id)
        if row_id is None:
            out.reject(index, None, CODE_MALFORMED_ID, "'id' is not a valid UUID.")
            return
        if str(row_id) in ctx.foreign_ids:
            out.reject(
                index, row_id, CODE_ID_UNAVAILABLE, "That id is not available — mint a new one."
            )
            return

    existing = ctx.locked_by_id.get(str(row_id)) if row_id is not None else None
    if is_tombstoned(existing):
        out.skip(
            index, row_id, CODE_TOMBSTONED, "That id belongs to a deleted row; not re-created."
        )
        return

    # project is injected from the URL, never read from the row body, so a batch can
    # never create into a different project.
    data.pop("project", None)
    data.pop("wbs_path", None)
    data.pop("id", None)
    # Popped here (not just on the create branch below) so a re-create-as-edit never
    # re-parents an existing row through this path — same as perform_update, which
    # never touches wbs_path on PATCH.
    parent_id_raw = data.pop("parent_id", None)
    is_subtask = str(data.pop("is_subtask", "") or "").lower() in ("true", "1")

    if existing is not None:
        _apply_recreate_as_edit(index, row_id, existing, data, ctx, out)
        return

    # Hierarchy placement (#2724). A batch's rows apply in `operations` order
    # (apply_task_operations), so a child row naming a parent created earlier IN
    # THIS SAME BATCH resolves: the parent's INSERT already committed to this
    # transaction, just not to the outer request's response yet — client-minted
    # ids (ADR-0772) make that forward reference possible without a round trip.
    placement = _resolve_bulk_create_placement(index, row_id, parent_id_raw, is_subtask, ctx, out)
    if placement is None:
        return
    parent_task, wbs_path = placement

    ser = TaskSerializer(
        data={**data, "project": str(ctx.project.pk)}, context=_row_serializer_context(ctx)
    )
    if not _validate_or_reject(ser, index, row_id, out):
        return

    # The client's UUID becomes the primary key verbatim — never remapped. It is
    # passed as an explicit save() kwarg rather than made writable on TaskSerializer,
    # which is shared by the plain REST create and the sync upload: making the field
    # writable would silently hand a caller-supplied PK to every one of them.
    #
    # source_kind rides the same mechanism (#3038): it answers "what wrote this row"
    # and TaskSource.PASTE sat declared and unwritten until this fix. Deliberately
    # NOT paired with a seeded_at stamp — this path saves through TaskSerializer /
    # Task.save(), which stamps edited_at on the very write that creates the row
    # (task_batch_services.py's module docstring), so seeded_at is meant to stay
    # null here. Setting it would pull every pasted row into
    # TaskManager.untouched_seeded()'s "Delete untouched rows (N)" sweep — a
    # different, already-decided question (ADR-0786 §2) that this fix does not
    # reopen. Do not "fix" that by adding seeded_at alongside it.
    save_kwargs: dict[str, Any] = {
        "wbs_path": wbs_path,
        "is_subtask": is_subtask,
        "source_kind": ctx.source_kind,
    }
    if row_id is not None:
        save_kwargs["id"] = row_id
    task = ser.save(**save_kwargs)
    if is_subtask and parent_task is not None:
        _spawn_subtask_under(parent_task, task, ctx, out)
    maybe_record_scope_injection(task, None, ctx.request.user)
    out.created_ids.append(task.pk)
    out.applied.append({"index": index, "id": str(task.pk), "op": "create", "outcome": "created"})
    _note_project_start_shift(task, out)


def _apply_update(index: int, op: dict[str, Any], ctx: BulkContext, out: BulkOutcome) -> None:
    """Apply one ``update`` op under the per-row edit bar.

    **Sprint sovereignty is not optional on this path.** Moving a task into an
    ACTIVE sprint is an *injection* (ADR-0102): it must write a
    ``SprintScopeChange`` and set ``sprint_pending`` so the row is visible but
    excluded from the commitment until someone accepts it. Every other write
    path routes through ``maybe_record_scope_injection`` — ``perform_create`` /
    ``perform_update`` on ``TaskViewSet``, both sync upload buckets, and
    ``_apply_create`` right above. This branch did not, so a bulk sprint write
    landed straight in the commitment and moved the burndown with nothing to
    accept or reject (#3152).
    """
    from trueppm_api.apps.projects.serializers import TaskSerializer
    from trueppm_api.apps.projects.services import maybe_record_scope_injection

    task = _resolve_target(index, op, ctx, out)
    if task is None:
        return
    if not can_user_edit_task(ctx.request, task, method="PATCH"):
        out.reject(index, task.pk, CODE_FORBIDDEN, "You may not edit this task.")
        return

    data = dict(op.get("data") or {})
    data.pop("project", None)
    data.pop("wbs_path", None)
    data.pop("id", None)

    if _milestone_gate_applies(task, data):
        out.skip(
            index,
            task.pk,
            CODE_MILESTONE_GATE,
            "Milestone left unchanged — a classification does not re-type a gate.",
        )
        return

    # Snapshot BEFORE the save, for the same reason `_apply_recreate_as_edit` does.
    old_sprint_id = str(task.sprint_id) if task.sprint_id else None

    ser = TaskSerializer(task, data=data, partial=True, context=_row_serializer_context(ctx))
    if not _validate_or_reject(ser, index, task.pk, out):
        return

    saved = ser.save()
    # Unconditional: the helper self-guards subtasks, unchanged links, rows that
    # are already pending, and non-ACTIVE targets, so there is no condition to
    # restate here that could drift from the one the other write paths use.
    maybe_record_scope_injection(saved, old_sprint_id, ctx.request.user)
    out.updated_ids.append(saved.pk)
    out.applied.append({"index": index, "id": str(saved.pk), "op": "update", "outcome": "updated"})
    _note_project_start_shift(saved, out)


def _apply_delete(index: int, op: dict[str, Any], ctx: BulkContext, out: BulkOutcome) -> None:
    """Soft-delete one row, mirroring ``IsProjectMemberWriteOrOwn``."""
    task = _resolve_target(index, op, ctx, out)
    if task is None:
        return
    if (
        ctx.caller_role < Role.ADMIN
        and not task.assignments.filter(resource__user=ctx.caller).exists()
    ):
        out.reject(
            index,
            task.pk,
            CODE_FORBIDDEN,
            "Only Project Managers and task assignees may delete tasks.",
        )
        return
    task.soft_delete()
    out.deleted_ids.append(str(task.pk))
    out.applied.append({"index": index, "id": str(task.pk), "op": "delete", "outcome": "deleted"})


def _resolve_target(
    index: int, op: dict[str, Any], ctx: BulkContext, out: BulkOutcome
) -> Task | None:
    """Resolve an update/delete op's ``id`` to a live, locked row in this project.

    A missing id, an unparseable id, a foreign id and an unknown id are reported
    with distinct *codes* but none of them asserts that the row exists elsewhere —
    ``not_found`` and ``id_unavailable`` are both non-committal, matching the
    sibling ``_lock_bulk_targets`` behavior and #359.
    """
    raw_id = op.get("id")
    if raw_id is None:
        out.reject(index, None, CODE_INVALID, f"'id' is required for op='{op['op']}'.")
        return None
    row_id = parse_row_uuid(raw_id)
    if row_id is None:
        out.reject(index, None, CODE_MALFORMED_ID, "'id' is not a valid UUID.")
        return None
    task = ctx.locked_by_id.get(str(row_id))
    if task is None or task.is_deleted:
        out.reject(index, row_id, CODE_NOT_FOUND, "No such task in this project.")
        return None
    return task


def _note_project_start_shift(task: Task, out: BulkOutcome) -> None:
    """#867: a row that pulled the project start earlier needs a boundary broadcast."""
    if getattr(task, "_project_start_shifted_from", None) is not None:
        out.project_start_shifted = True


_OP_HANDLERS = {"create": _apply_create, "update": _apply_update, "delete": _apply_delete}


#: The deferred exclusion constraint that guards one live task per (project, wbs_path).
#:
#: Declared ``Deferrable.DEFERRED`` on ``Task.Meta`` because every WBS-rewrite path
#: (indent/outdent/reorder/group/ungroup, structural undo) renumbers a whole sibling
#: level one row at a time and necessarily passes through duplicate intermediate
#: states. See the constraint's own comment in ``models.py`` for the full reasoning.
WBS_PATH_CONSTRAINT = "unique_task_wbs_path_per_project_live"

#: The two statements :func:`_settle_wbs_path_constraint` runs.
#:
#: **Whole literals, not composed from** ``WBS_PATH_CONSTRAINT`` **above.**
#: ``SET CONSTRAINTS`` takes a constraint *name*, which is an identifier — SQL has no
#: parameter placeholder for one, so a parameterized form of these statements does not
#: exist and any composition has to be textual. Semgrep's ``formatted-sql-query`` is a
#: blocking rule and is right to be, and it follows a constant back to its f-string, so
#: moving the interpolation off the call site does not answer it. Repeating the name is
#: the honest answer: there is then no formatting anywhere to justify. The duplication
#: is pinned by ``test_the_statements_name_the_constraint_that_is_declared``.
_SET_WBS_CONSTRAINT_IMMEDIATE = 'SET CONSTRAINTS "unique_task_wbs_path_per_project_live" IMMEDIATE'
_SET_WBS_CONSTRAINT_DEFERRED = 'SET CONSTRAINTS "unique_task_wbs_path_per_project_live" DEFERRED'


def _settle_wbs_path_constraint() -> None:
    """Check the deferred wbs_path constraint now, while the caller's savepoint is open.

    Postgres evaluates a ``DEFERRED`` constraint at ``COMMIT``, **not** at
    ``RELEASE SAVEPOINT``. Without this the per-row savepoint in
    :func:`apply_task_operations` releases cleanly on a colliding row, the handler
    reports success, the 207 body is assembled with that row marked applied — and the
    violation then surfaces when ``ATOMIC_REQUESTS`` commits *after* the view has
    returned, outside DRF's ``exception_handler``. The client gets an opaque 500 in
    place of the 207 the endpoint's contract promises, and the failure names a
    constraint with no row attribution (#3070).

    Setting the constraint ``IMMEDIATE`` drains its pending events right here, so a
    violation is raised inside the savepoint and is attributable to the op that caused
    it. The mode is then restored to ``DEFERRED`` so the *next* row is free to pass
    through its own transient duplicates again — the property the constraint was
    deferred for in the first place. On the failure path the restore is not needed:
    the savepoint rollback reverts ``SET CONSTRAINTS`` along with everything else.

    Postgres-only, and a no-op elsewhere; ``SET CONSTRAINTS`` has no portable
    equivalent and no other backend is supported for this deployment.
    """
    if connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute(_SET_WBS_CONSTRAINT_IMMEDIATE)
        cursor.execute(_SET_WBS_CONSTRAINT_DEFERRED)


def _conflict_message(exc: DatabaseError) -> str:
    """Render a row-level conflict for the 207 body without leaking database text.

    A wbs_path collision arrives as Postgres's exclusion-constraint message, which
    names the constraint and repeats the raw key — neither of which means anything to
    an API client, and the row attribution the client actually needs is already
    carried by the report's ``index``. Every other ``DatabaseError`` keeps its own
    text: those are unclassified by definition, and hiding them would leave the caller
    with no signal at all.
    """
    if WBS_PATH_CONSTRAINT in str(exc):
        return (
            "Another live task in this project already holds this WBS position. "
            "Move or reorder the row and retry."
        )
    return str(exc)


def apply_task_operations(
    operations: list[dict[str, Any]], ctx: BulkContext, out: BulkOutcome
) -> None:
    """Phase 1 — apply every task op, each inside its own savepoint.

    The savepoint is what makes per-row continuation possible at all. A row that
    fails at the database level (an ``IntegrityError`` the serializer did not catch)
    poisons the enclosing transaction; without a savepoint to roll back to, the very
    next query would raise ``TransactionManagementError`` and the remaining rows
    would fail for a reason that has nothing to do with them.

    A savepoint alone is not enough for a **deferred** constraint, though: Postgres
    checks those at ``COMMIT``, so the savepoint releases cleanly and the failure lands
    after the view has returned. :func:`_settle_wbs_path_constraint` closes that gap
    for the one deferred constraint task rows can violate (#3070).
    """
    for index, op in enumerate(operations):
        handler = _OP_HANDLERS.get(op.get("op", ""))
        if handler is None:
            out.reject(index, op.get("id"), CODE_INVALID, f"Unknown op '{op.get('op')}'.")
            continue
        before = _outcome_lengths(out)
        try:
            with transaction.atomic(savepoint=True):
                handler(index, op, ctx, out)
                if _outcome_lengths(out) == before:
                    # The handler neither applied nor reported — defensive only.
                    out.reject(index, op.get("id"), CODE_INVALID, "Operation produced no result.")
                elif op.get("op") != "delete" and len(out.applied) > before[0]:
                    # Only a row that actually wrote can have collided, and a delete
                    # only ever *frees* a path: soft-delete flips ``is_deleted``, which
                    # takes the row out of the constraint's partial condition. Skipping
                    # those two cases keeps the two extra statements off the rows that
                    # cannot need them, which matters on a large batch.
                    _settle_wbs_path_constraint()
        except PermissionDenied as exc:
            _rollback_bookkeeping(out, before)
            out.reject(index, op.get("id"), CODE_FORBIDDEN, str(exc.detail))
        except DRFValidationError as exc:
            _rollback_bookkeeping(out, before)
            out.reject(index, op.get("id"), CODE_INVALID, _first_error_message(exc))
        except DatabaseError as exc:
            # The savepoint has rolled back, so the transaction is usable again and
            # the next row may proceed.
            _rollback_bookkeeping(out, before)
            out.reject(index, op.get("id"), CODE_CONFLICT, _conflict_message(exc))

    _declare_parents_of_created_rows(ctx, out)


def _declare_parents_of_created_rows(ctx: BulkContext, out: BulkOutcome) -> None:
    """Declare every parent this batch has just given a first structural child (#3036).

    The single-row create path does this inline; the ``bulk_create`` importers do it
    through ``declare_containers_in_batch``. This endpoint reached neither — it saves
    per row through ``TaskSerializer`` — so a ``create`` naming an existing
    ``parent_id`` left that parent ``structure_role='work'`` **with children**, and the
    Board's rendering rule (ADR-0843) drew it as a card rather than a lane. That is the
    artifact epic #2946 exists to remove, on the endpoint its own headline gesture uses.

    **Derived from ``out.created_ids``, not recorded as the rows apply.** A handler runs
    inside its own savepoint and ``_rollback_bookkeeping`` truncates ``created_ids`` when
    that savepoint rolls back — so reading the list afterwards is automatically correct
    for the partial-application case, while a parent noted during ``_apply_create`` would
    survive its child's rollback and declare a container for a row that does not exist.

    **One query set for the batch, not one per row.** A 500-op batch under a single
    parent must not become 500 probes; ``declare_ancestors_of_paths`` sweeps the paths
    and locks the ancestor rows in chunks, which is the shape ``declare_containers_in_batch``
    was written to preserve. Rows created *inside* this batch that are themselves parents
    are covered too — they are ancestors of their own children's paths, and by this point
    every row is in the table.

    **A declared parent joins ``updated_ids``, or the promotion is invisible to everyone
    else.** ``tasks_bulk_mutated`` carries the batch's ids so clients refetch *those rows*
    rather than the whole board (#1009), and the parent is not any op's target — so
    leaving it out would broadcast a change set that omits the one row whose rendering
    actually changed, and a collaborator's board would keep drawing a card where there is
    now a lane. It does **not** join ``applied``: that bucket is the per-op report,
    correlated by ``index``, and this row answers to no op.
    """
    from trueppm_api.apps.projects.models import Task, declare_ancestors_of_paths

    if not out.created_ids:
        return
    paths = {
        str(path)
        for path in Task.objects.filter(
            pk__in=out.created_ids, is_subtask=False, is_deleted=False
        ).values_list("wbs_path", flat=True)
        if path
    }
    if not paths:
        return
    for parent in declare_ancestors_of_paths(ctx.project.pk, paths):
        if parent.pk not in out.created_ids and parent.pk not in out.updated_ids:
            out.updated_ids.append(parent.pk)


def _outcome_lengths(out: BulkOutcome) -> tuple[int, ...]:
    return (
        len(out.applied),
        len(out.rejected),
        len(out.skipped),
        len(out.created_ids),
        len(out.updated_ids),
        len(out.deleted_ids),
    )


def _rollback_bookkeeping(out: BulkOutcome, before: tuple[int, ...]) -> None:
    """Discard entries a handler recorded before its savepoint rolled back.

    Without this, a row whose serializer save succeeded and whose *database flush*
    then failed would stay in ``applied`` and in the broadcast id list while its
    write was rolled back — reporting a mutation that did not happen.
    """
    (
        applied,
        rejected,
        skipped,
        created,
        updated,
        deleted,
    ) = before
    del out.applied[applied:]
    del out.rejected[rejected:]
    del out.skipped[skipped:]
    del out.created_ids[created:]
    del out.updated_ids[updated:]
    del out.deleted_ids[deleted:]


class InvalidGraphInput(Exception):
    """The batch's dependency graph is malformed rather than cyclic.

    ``validate_task_graph`` can raise instead of returning a cycle path — a
    pathological summary fan-out beyond the engine's cap, or a ``children_map`` that
    is itself cyclic. That is a 400 on the batch as a whole, **not** a per-edge
    ``cyclic_dependency`` rejection: there is no identified cycle path, so there is
    no principled subset of edges to reject (ADR-0772 §4).
    """


def _cycle_edge_pairs(cycle_path: list[str]) -> set[tuple[str, str]]:
    """Consecutive ``(pred, succ)`` pairs along a reported cycle path.

    ``find_cycle`` returns the path with the first id repeated at the end
    (``["A", "B", "A"]``), so the edges on the cycle are its adjacent pairs.
    """
    return {(cycle_path[i], cycle_path[i + 1]) for i in range(len(cycle_path) - 1)}


def _resolve_edges(
    edge_rows: list[dict[str, Any]], ctx: BulkContext, out: BulkOutcome
) -> list[_EdgeEntry]:
    """Resolve and role-gate every proposed edge; return the survivors.

    Two gates, both per-edge rather than per-request, so a Member's task rows still
    apply and only their edge rows reject (ADR-0772 §3).
    """
    from trueppm_api.apps.projects.models import Task

    survivors: list[_EdgeEntry] = []
    for index, row in enumerate(edge_rows):
        # Dependency ops sit at IsProjectScheduler — one role ABOVE this view's
        # IsProjectMemberWrite floor. Accepting edges under the view's own gate
        # would silently hand dependency authoring to Member.
        if ctx.caller_role < Role.SCHEDULER:
            out.dep_reject(
                index, CODE_FORBIDDEN, "Your role cannot create dependencies on this project."
            )
            continue
        if row.get("id") is not None:
            # Client-minted ids are scoped to Task only. All four guards are written
            # about task ids and none would cover a caller-supplied Dependency.id, so
            # a supplied edge id is rejected rather than ignored.
            out.dep_reject(index, CODE_INVALID, "Dependency ids are server-assigned.")
            continue

        pred = parse_row_uuid(row.get("predecessor"))
        succ = parse_row_uuid(row.get("successor"))
        if pred is None or succ is None:
            out.dep_reject(index, CODE_MALFORMED_ID, "Edge endpoints must be task UUIDs.")
            continue
        # Forward references are legal: an edge may name a task whose create op
        # appears LATER in `operations`, because phase 1 has already materialized
        # every row by the time we get here.
        live = set(
            Task.objects.filter(pk__in=[pred, succ], is_deleted=False).values_list("pk", flat=True)
        )
        if pred not in live or succ not in live:
            out.dep_reject(
                index, CODE_UNRESOLVED_ENDPOINT, "Edge endpoint does not resolve to a live task."
            )
            continue
        survivors.append((index, row, str(pred), str(succ)))
    return survivors


def _drop_offending_edges(
    remaining: list[_EdgeEntry],
    offending_pairs: set[tuple[str, str]],
    out: BulkOutcome,
    code: str,
    message: str,
    offending: list[str],
) -> list[_EdgeEntry] | None:
    """Reject the batch edges the guard blamed; return the survivors.

    Returns ``None`` when nothing was dropped. That is the terminating signal for
    the caller's loop: every edge the guard named is already persisted, so this
    batch offered nothing on the offending path and rejecting more of its own rows
    cannot clear the condition.
    """
    kept = [entry for entry in remaining if (entry[2], entry[3]) not in offending_pairs]
    if len(kept) == len(remaining):
        return None
    for index, _row, pred, succ in remaining:
        if (pred, succ) in offending_pairs:
            out.dep_reject(index, code, message, offending=offending)
    return kept


def _guard_edge_graph(
    survivors: list[_EdgeEntry], ctx: BulkContext, out: BulkOutcome
) -> list[_EdgeEntry]:
    """Run the ADR-0259 graph guard over existing ∪ batch edges, before any write.

    The guard is absolute over what gets written, and what it refuses to write is
    exactly the edges that would close a cycle — so "one bad row out of 38 must not
    discard the other 37" stays true without weakening it. Task rows already applied
    in phase 1 are never rolled back by a cycle.

    Iterates because rejecting one cycle can leave another: each pass drops the batch
    edges lying on the reported path and re-runs. A pass that finds a cycle composed
    entirely of *already-persisted* edges terminates the loop — that is a pre-existing
    condition this batch did not introduce and cannot fix by rejecting its own rows.
    """
    from trueppm_scheduler import InvalidScheduleInput

    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.projects.serializers import _load_project_tasks_and_children_map
    from trueppm_api.apps.scheduling.graph_guard import (
        InfeasibleGraphError,
        validate_task_graph,
    )

    if not survivors:
        return survivors

    task_ids, children_map = _load_project_tasks_and_children_map(ctx.project.pk)
    persisted: list[tuple[str, str]] = [
        (str(p), str(s))
        for p, s in Dependency.objects.filter(
            is_deleted=False, predecessor_id__in=[uuid.UUID(t) for t in task_ids]
        ).values_list("predecessor_id", "successor_id")
    ]

    remaining = list(survivors)
    while remaining:
        batch_edges = [(pred, succ) for _idx, _row, pred, succ in remaining]
        try:
            validate_task_graph(persisted + batch_edges, children_map=children_map)
        except InfeasibleGraphError as exc:
            # Both verdicts reduce to the same shape — a set of offending (pred, succ)
            # pairs — so they share one rejection pass. A self-reference is the edge
            # (x, x) for each blamed node x; a cycle is the adjacent pairs along the
            # reported path.
            if exc.reason == "self_reference":
                offending_pairs = {(node, node) for node in exc.offending}
                code = CODE_SELF_REFERENCE
                message = "A task cannot depend on itself."
            else:
                offending_pairs = _cycle_edge_pairs(exc.offending)
                code = CODE_CYCLIC_DEPENDENCY
                message = "This dependency would create a cycle."

            kept = _drop_offending_edges(
                remaining, offending_pairs, out, code, message, exc.offending
            )
            if kept is None:
                # Nothing of ours is on the offending path — it lies entirely in
                # already-persisted edges, so dropping more of our own rows cannot help.
                break
            remaining = kept
            continue
        except InvalidScheduleInput as exc:
            raise InvalidGraphInput(str(exc)) from exc
        return remaining
    return remaining


def apply_dependency_edges(
    edge_rows: list[dict[str, Any]], ctx: BulkContext, out: BulkOutcome
) -> set[str]:
    """Phase 2 — resolve, guard, then write the batch's dependency edges.

    Runs after phase 1 inside the SAME ``transaction.atomic()``, so a crash between
    the two cannot leave tasks without their batch's edges. Returns the set of
    project ids whose schedule the written edges invalidated — the predecessor's
    project always, plus the successor's when an accepted cross-project edge changes
    the CPM input on both sides (ADR-0120 D3).

    Skipped entirely when the batch carries no edges: the union graph is built from
    every persisted edge in the project, so its cost scales with project size rather
    than batch size, and a paste-many of 38 rows that creates no edges must not pay
    for the rare case that does.
    """
    from trueppm_api.apps.projects.serializers import DependencySerializer

    if not edge_rows:
        return set()

    survivors = _guard_edge_graph(_resolve_edges(edge_rows, ctx, out), ctx, out)
    recalc_project_ids: set[str] = set()

    for index, row, pred, succ in survivors:
        payload = {
            "predecessor": pred,
            "successor": succ,
            "dep_type": row.get("dep_type", "FS"),
            "lag": row.get("lag", 0),
        }
        before = (len(out.dep_applied), len(out.dep_rejected))
        try:
            with transaction.atomic(savepoint=True):
                ser = DependencySerializer(data=payload, context=_row_serializer_context(ctx))
                ser.is_valid(raise_exception=True)
                # Writing through the serializer rather than Dependency.objects is not
                # a style preference: it carries the ADR-0120 D2 consent gate, the
                # cross-program rejection, the merged-program cycle check and the span
                # guard. A direct write re-implements four controls.
                consent = getattr(ser, "_consent", None)
                instance = ser.save(**consent) if consent else ser.save()
                pred_pid = str(instance.predecessor.project_id)
                succ_pid = str(instance.successor.project_id)
                recalc_project_ids.add(pred_pid)
                if pred_pid != succ_pid and not instance.pending_acceptance:
                    recalc_project_ids.add(succ_pid)
                out.dep_applied.append(
                    {
                        "index": index,
                        "id": str(instance.pk),
                        "predecessor": pred,
                        "successor": succ,
                        "pending_acceptance": instance.pending_acceptance,
                    }
                )
        except PermissionDenied as exc:
            del out.dep_applied[before[0] :]
            out.dep_reject(index, CODE_FORBIDDEN, str(exc.detail))
        except DRFValidationError as exc:
            del out.dep_applied[before[0] :]
            out.dep_reject(index, CODE_INVALID, _first_error_message(exc))
        except DatabaseError as exc:
            del out.dep_applied[before[0] :]
            out.dep_reject(index, CODE_CONFLICT, str(exc))

    return recalc_project_ids
