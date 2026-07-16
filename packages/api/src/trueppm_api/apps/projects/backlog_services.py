"""Service layer for the program backlog pull-down (ADR-0069 Erratum, #737).

The pull action is the one place where a program-level ``BacklogItem`` crosses
into a project: it converts a PROPOSED item into a project-backlog ``Task``
(``status=BACKLOG``, ``sprint=NULL``) and records the conversion on the item.
Sprint sovereignty is preserved by design — pull never assigns a sprint
(Morgan's VoC blocker, resolved in ADR-0069).

Kept as a service (not inline in the view) so the atomic transition is testable
in isolation and reusable by a future batch-pull from Sprint Planning.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemStatus,
    BacklogItemType,
    Label,
    LabelColor,
    Project,
    Task,
    TaskLabel,
    TaskStatus,
    TaskType,
)

# Map the program intake taxonomy (ADR-0069) onto the project work-item taxonomy
# (ADR-0105). The two enums are reconciled (#1995): every intake type maps to a
# distinct Task type so a pulled bug/spike/chore keeps its kind instead of
# silently collapsing to a plain task. ``chore`` is the intake name for
# ``TaskType.TECH_DEBT``; ``feature`` has no Task analogue and maps to ``TASK``.
_ITEM_TYPE_TO_TASK_TYPE: dict[str, TaskType] = {
    BacklogItemType.EPIC: TaskType.EPIC,
    BacklogItemType.STORY: TaskType.STORY,
    BacklogItemType.TASK: TaskType.TASK,
    BacklogItemType.BUG: TaskType.BUG,
    BacklogItemType.SPIKE: TaskType.SPIKE,
    BacklogItemType.CHORE: TaskType.TECH_DEBT,
    BacklogItemType.FEATURE: TaskType.TASK,
}


class BacklogItemNotPullable(Exception):
    """Raised when a pull is attempted on an item that is not PROPOSED.

    The view maps this to ``409 Conflict`` — the item was already pulled or
    archived (or a concurrent pull won the row lock first).
    """


class CrossProgramPullError(Exception):
    """Raised when the pull target project does not belong to the item's program.

    The view maps this to ``400 Bad Request``. Single-program scoping is the OSS
    boundary (ADR-0069): a program backlog item can only be pulled into one of
    its own program's projects, never into another program's project.
    """


def pull_to_project_backlog(
    item_id: str,
    project: Project,
    actor: Any,
) -> Task:
    """Atomically convert a PROPOSED ``BacklogItem`` into a project-backlog Task.

    Locks the item ``FOR UPDATE`` and asserts it is still PROPOSED before doing
    any work, so two concurrent pulls cannot both succeed — the loser raises
    :class:`BacklogItemNotPullable` (→ 409). The new Task lands in the project
    backlog (``status=BACKLOG``, ``sprint=None``); the item is flipped to PULLED
    with ``pulled_task``/``pulled_at``/``pulled_by`` recorded. Both rows bump
    ``server_version`` via their ``save()``.

    On commit it enqueues a CPM recalculation (existing scheduling outbox — no
    new outbox category), broadcasts a ``task_created`` board event, and fires the
    ``task.created`` outbound webhook (#752) — matching every other Task-create
    path so external subscribers see backlog pulls like any other create. All
    three are deferred with ``transaction.on_commit`` so a rolled-back pull never
    leaks a recalc request, a phantom WS event, or a webhook delivery.

    Args:
        item_id: PK of the ``BacklogItem`` to pull.
        project: The resolved target ``Project`` (must belong to the item's program).
        actor: The user performing the pull (recorded as ``pulled_by``).

    Returns:
        The created project-backlog ``Task``.

    Raises:
        BacklogItem.DoesNotExist: if no such item exists.
        CrossProgramPullError: if ``project`` is not in the item's program.
        BacklogItemNotPullable: if the item is not in PROPOSED status.
    """
    # Call-time import (not module-level) to avoid a views→services→views cycle.
    # By the time this service runs, the app is fully loaded, so reusing the
    # canonical task payload builder keeps the pull's task.created shape identical
    # to the REST create path with zero drift risk.
    from trueppm_api.apps.projects.views import _task_webhook_payload
    from trueppm_api.apps.scheduling.services import enqueue_recalculate
    from trueppm_api.apps.sync.broadcast import broadcast_board_event
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    new_label_ids: list[str] = []
    with transaction.atomic():
        item = BacklogItem.objects.select_for_update().get(pk=item_id, is_deleted=False)

        if project.program_id != item.program_id:
            raise CrossProgramPullError("The target project is not part of this program.")

        if item.status != BacklogItemStatus.PROPOSED:
            raise BacklogItemNotPullable(
                f"This item is '{item.status}' and can no longer be pulled."
            )

        task = Task.objects.create(
            project=project,
            name=item.title,
            # BacklogItem.description maps to Task.notes — Task has no separate
            # description field; the Board/drawer render notes as the body.
            notes=item.description,
            story_points=item.story_points,
            status=TaskStatus.BACKLOG,
            sprint=None,
            # ADR-0105: carry the intake item's type into the project work-item
            # taxonomy so a pulled story/bug/spike keeps its kind. The taxonomies
            # are reconciled (#1995), so ``.get`` always hits; the TASK fallback is
            # defensive only (an unknown value can no longer be created).
            type=_ITEM_TYPE_TO_TASK_TYPE.get(item.item_type, TaskType.TASK),
        )

        # Carry the intake item's free-text tags onto the task as project labels
        # (#1992) so a PO's thematic grouping survives the crossing. Runs inside
        # the atomic block so a rolled-back pull leaves no orphan labels.
        new_label_ids = _apply_tags_as_labels(task, project, item.tags, actor)

        item.status = BacklogItemStatus.PULLED
        item.pulled_task = task
        item.pulled_at = timezone.now()
        item.pulled_by = actor if getattr(actor, "is_authenticated", False) else None
        # server_version is bumped automatically by VersionedModel.save() (it is
        # stripped from update_fields and incremented via F()), so it is omitted here.
        item.save(update_fields=["status", "pulled_task", "pulled_at", "pulled_by"])

    project_id = str(project.pk)
    task_id = str(task.pk)
    # source="backlog_pull" tells external consumers which surface originated the
    # create (ADR-0065 X-Source semantics) so a pull is distinguishable from a
    # board/schedule/sync create on the same task.created event.
    webhook_payload = _task_webhook_payload(task, source="backlog_pull")
    # CPM recalc via the existing scheduling outbox (ADR-0027). A BACKLOG task is
    # excluded from the CPM graph, so this coalesces to a no-op run today, but we
    # keep it on the standard Task-create path for consistency and forward-safety.
    transaction.on_commit(lambda: enqueue_recalculate(project_id))
    transaction.on_commit(
        lambda: broadcast_board_event(project_id, "task_created", {"id": task_id})
    )

    # Any labels coined from the item's tags are new project vocabulary — tell open
    # boards/label managers so they can render the pulled task's pills (#1992). Bind
    # the id through a function arg so closure late-binding can't collapse the loop's
    # events to the last id.
    def _broadcast_label(lid: str) -> None:
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "label_created", {"id": lid})
        )

    for _label_id in new_label_ids:
        _broadcast_label(_label_id)

    # Bind the payload via a default arg so closure late-binding can never swap it
    # if this function grows more branches later (matches inbound_sync.py).
    def _dispatch(pid: str = project_id, wp: dict[str, Any] = webhook_payload) -> None:
        dispatch_webhooks(pid, "task.created", wp)

    transaction.on_commit(_dispatch)
    return task


def _apply_tags_as_labels(
    task: Task,
    project: Project,
    tags: list[str],
    actor: Any,
) -> list[str]:
    """Carry a pulled item's free-text tags onto the task as project labels (#1992).

    Each tag becomes — or, case-insensitively, reuses — a project-scoped ``Label``
    and is attached to ``task`` via ``TaskLabel``. Reuse keeps the catalog from
    sprouting a near-duplicate on every pull; new labels take the neutral default
    slot (``SLATE``) appended to the end of the palette order, which a project admin
    can recolor later. Idempotent per tag via ``TaskLabel.get_or_create``.

    Must be called inside the pull's ``transaction.atomic`` block so a rolled-back
    pull leaves no orphan labels. The label soft cap is honored: once the project is
    at the ceiling, further *new* tags are skipped (existing matches still attach) so
    a pull can never blow past the curation floor the ``LabelViewSet`` enforces.

    Args:
        task: The freshly created project-backlog Task to label.
        project: The task's project (labels are project-scoped).
        tags: The item's tags — already normalized (trimmed, de-duped) by the
            serializer's ``validate_tags``.
        actor: The pulling user, recorded as ``created_by`` on any new label.

    Returns:
        The ids of labels *created* here (not reused), so the caller can broadcast
        ``label_created`` once the transaction commits.
    """
    if not tags:
        return []
    # Call-time import mirrors the pull's views import — avoids a services→views cycle.
    from trueppm_api.apps.projects.views import _label_soft_cap

    cap = _label_soft_cap()
    live = Label.objects.filter(project=project, is_deleted=False)
    label_count = live.count()
    next_position = (live.aggregate(m=Max("position"))["m"] or 0) + 1
    creator = actor if getattr(actor, "is_authenticated", False) else None

    created_ids: list[str] = []
    for tag in tags:
        # Label.name is capped at 50 chars; BacklogItem tags are unbounded, so clamp
        # to keep an over-long tag from raising instead of degrading gracefully.
        name = tag[:50]
        label = Label.objects.filter(project=project, name__iexact=name, is_deleted=False).first()
        if label is None:
            if label_count >= cap:
                # At the curation ceiling — skip coining a new label but keep going;
                # a pull must not fail because the project's label catalog is full.
                continue
            try:
                # Savepoint the create so a concurrent pull that coined the same tag
                # first raises only a local IntegrityError (on uniq_label_name_per_project)
                # instead of poisoning the whole pull transaction. Without the nested
                # atomic the outer pull would roll back to a transient 500.
                with transaction.atomic():
                    label = Label.objects.create(
                        project=project,
                        name=name,
                        color=LabelColor.SLATE,
                        position=next_position,
                        created_by=creator,
                    )
            except IntegrityError:
                # Lost the race — the other transaction's label is now committed and
                # visible; reuse it (exact-name match, since the unique constraint is
                # on exact (project, name)). Fall through to attach it.
                label = Label.objects.filter(project=project, name=name, is_deleted=False).first()
                if label is None:
                    continue
            else:
                next_position += 1
                label_count += 1
                created_ids.append(str(label.pk))
        TaskLabel.objects.get_or_create(task=task, label=label)
    return created_ids


def reset_pulled_item_on_task_delete(task_id: str) -> None:
    """Reset a BacklogItem to PROPOSED when its pulled Task is (soft-)deleted.

    Rollback path (ADR-0069): if the Task created by a pull is deleted, the
    originating item must become re-pullable. ``pulled_task`` is ``SET_NULL`` so
    deletion never cascades to the item; this restores the lifecycle by clearing
    the pull bookkeeping and flipping the item back to PROPOSED.

    Idempotent and a no-op when no item points at the task. Called from the Task
    post_save soft-delete receiver (TruePPM Tasks soft-delete, not hard-delete).
    """
    item = BacklogItem.objects.filter(pulled_task_id=uuid.UUID(task_id), is_deleted=False).first()
    if item is None or item.status != BacklogItemStatus.PULLED:
        return
    item.status = BacklogItemStatus.PROPOSED
    item.pulled_task = None
    item.pulled_at = None
    item.pulled_by = None
    # server_version auto-bumps in VersionedModel.save() — omitted from update_fields.
    item.save(update_fields=["status", "pulled_task", "pulled_at", "pulled_by"])
