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

from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemStatus,
    Project,
    Task,
    TaskStatus,
)


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
        )

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

    # Bind the payload via a default arg so closure late-binding can never swap it
    # if this function grows more branches later (matches inbound_sync.py).
    def _dispatch(pid: str = project_id, wp: dict[str, Any] = webhook_payload) -> None:
        dispatch_webhooks(pid, "task.created", wp)

    transaction.on_commit(_dispatch)
    return task


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
