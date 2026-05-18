"""Retrospective service layer (ADR-0071).

Two operations: promote a ``RetroActionItem`` into a project-backlog ``Task``
(``promote_retro_action_item``) and atomically promote + pull into a
``PLANNED`` sprint as one SCHEDULER+ action (``pull_carryover_item_to_sprint``).

Sprint sovereignty is enforced at this layer: ``promote_retro_action_item``
never accepts a sprint argument; the resulting Task is unconditionally created
with ``sprint=None``. The only path that puts a retro action item into a
sprint is ``pull_carryover_item_to_sprint``, which requires SCHEDULER+ role
and an explicit ``target_sprint`` argument.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

if TYPE_CHECKING:
    from django.contrib.auth.models import User

    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        Sprint,
        Task,
        TaskSuggestedAssignee,
    )

logger = logging.getLogger(__name__)


class AlreadyPromotedError(ValidationError):
    """Raised when promote is attempted on an action item that already has a Task.

    Carries ``existing_task_id`` so the view layer can include it in the 409
    response payload (the client can navigate to the existing task instead of
    retrying).
    """

    def __init__(self, existing_task_id: str) -> None:
        super().__init__("Action item already promoted.")
        self.existing_task_id = existing_task_id


def promote_retro_action_item(
    action_item: RetroActionItem,
    actor: User,
) -> Task:
    """Promote a RetroActionItem into a project-backlog Task.

    Atomic:
      1. SELECT FOR UPDATE on the action item; assert promoted_task_id IS NULL
         (else raise AlreadyPromotedError).
      2. Create Task(status=BACKLOG, sprint=None) in the action item's project.
      3. If the action item's assignee differs from the actor, create a
         TaskSuggestedAssignee (PENDING) instead of setting Task.assignee.
         Self-claim binds Task.assignee directly.
      4. Stamp action_item.promoted_task_id = task.pk and save.
      5. On commit: broadcast ``task_created`` + enqueue CPM recalculate.

    The new Task is unconditionally ``sprint=None``. Sprint assignment is a
    separate SCHEDULER+ action (see ``pull_carryover_item_to_sprint``).
    """
    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        SuggestionSource,
        SuggestionState,
        Task,
        TaskStatus,
        TaskSuggestedAssignee,
    )
    from trueppm_api.apps.scheduling.models import ScheduleRequestReason
    from trueppm_api.apps.scheduling.services import enqueue_recalculate
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    with transaction.atomic():
        # Re-read with row lock; the in-memory action_item passed in may be stale.
        locked = (
            RetroActionItem.objects.select_for_update()
            .select_related("retro__sprint__project")
            .get(pk=action_item.pk)
        )
        if locked.promoted_task_id is not None:
            raise AlreadyPromotedError(str(locked.promoted_task_id))

        project = locked.retro.sprint.project
        retro_short_id = locked.retro.sprint.short_id or str(locked.retro.sprint_id)[:8]

        # Self-claim binds Task.assignee directly; assigning someone else
        # creates a soft suggestion the assignee must accept on My Work.
        is_self_claim = locked.assignee_id is not None and locked.assignee_id == actor.pk
        bound_assignee = locked.assignee if is_self_claim else None

        task = Task.objects.create(
            project=project,
            name=locked.text[:255],
            duration=1,
            status=TaskStatus.BACKLOG,
            sprint=None,
            assignee=bound_assignee,
            story_points=locked.story_points,
            notes=f'source: "retrospective" (from Sprint {retro_short_id} retro)',
        )

        suggestion: TaskSuggestedAssignee | None = None
        if locked.assignee_id is not None and not is_self_claim:
            # locked.assignee_id guard above narrows locked.assignee to non-None
            # at runtime; cast for mypy since FK type still includes None.
            suggested_user = locked.assignee
            assert suggested_user is not None
            suggestion = TaskSuggestedAssignee.objects.create(
                task=task,
                suggested_user=suggested_user,
                suggested_by=actor,
                source=SuggestionSource.RETROSPECTIVE,
                state=SuggestionState.PENDING,
                reason=f"from retro of Sprint {retro_short_id}",
            )

        locked.promoted_task_id = task.pk
        locked.save(update_fields=["promoted_task_id"])

        project_id = str(project.pk)
        task_id = str(task.pk)
        action_item_id = str(locked.pk)
        retro_id = str(locked.retro_id)

        def _on_commit_dispatch() -> None:
            # Default args freeze closure values at registration time so any
            # mutation after this point cannot affect what's broadcast.
            broadcast_board_event(
                project_id,
                "task_created",
                {
                    "task_id": task_id,
                    "source": "retrospective",
                    "retro_id": retro_id,
                    "action_item_id": action_item_id,
                },
            )
            if suggestion is not None:
                broadcast_board_event(
                    project_id,
                    "suggestion_created",
                    {
                        "task_id": task_id,
                        "suggestion_id": str(suggestion.pk),
                        "suggested_user_id": locked.assignee_id,
                    },
                )
            enqueue_recalculate(
                project_id,
                reason=ScheduleRequestReason.TASK_CHANGE,
            )

        transaction.on_commit(_on_commit_dispatch)

    return task


def pull_carryover_item_to_sprint(
    action_item: RetroActionItem,
    target_sprint: Sprint,
    actor: User,
) -> Task:
    """Atomically promote an action item and assign the resulting Task to a sprint.

    SCHEDULER+ role is enforced at the view layer; this service trusts the
    caller has been gated. The target sprint must be in the same project as
    the action item's source retro (raises ValidationError otherwise).

    Behaviour:
      - If the action item is already promoted, reuses the existing Task and
        sets ``task.sprint = target_sprint``.
      - Otherwise calls ``promote_retro_action_item`` first, then sets
        ``task.sprint = target_sprint``.
      - Fires a single ``task_updated`` broadcast at commit (in addition to
        the ``task_created`` broadcast from promotion, if the promote happened
        in this call) — clients can dedupe by task_id.

    Returns the Task in its post-assign state (sprint set).
    """
    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        Sprint,
        SprintState,
        Task,
    )
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    with transaction.atomic():
        locked = (
            RetroActionItem.objects.select_for_update()
            .select_related("retro__sprint__project")
            .get(pk=action_item.pk)
        )
        source_project_id = locked.retro.sprint.project_id

        target_locked = Sprint.objects.select_for_update().get(pk=target_sprint.pk)
        if target_locked.project_id != source_project_id:
            raise ValidationError(
                "Target sprint must be in the same project as the retro action item."
            )
        if target_locked.state != SprintState.PLANNED:
            raise ValidationError(
                "Carryover pull is only permitted into PLANNED sprints; "
                f"target sprint state is {target_locked.state}."
            )

        if locked.promoted_task_id is None:
            # Promote first; the service handles broadcast + recalc enqueue.
            # Note: promote_retro_action_item opens its own atomic block but
            # uses the outer transaction (Django nests via savepoints).
            task = promote_retro_action_item(locked, actor)
        else:
            task = Task.objects.select_for_update().get(pk=locked.promoted_task_id)

        task.sprint = target_locked
        task.save(update_fields=["sprint", "server_version"])

        project_id = str(source_project_id)
        task_id = str(task.pk)
        sprint_id = str(target_locked.pk)

        def _broadcast_carryover() -> None:
            broadcast_board_event(
                project_id,
                "task_updated",
                {"task_id": task_id, "sprint_id": sprint_id, "source": "retro_carryover"},
            )

        transaction.on_commit(_broadcast_carryover)

    return task


def reset_promoted_task_on_delete(task_id: str) -> None:
    """Reset RetroActionItem.promoted_task_id to NULL when its Task is soft-deleted.

    Wired to the ``Task`` post_delete (or post_save when ``is_deleted=True``)
    signal so a re-deleted Task automatically frees the originating action
    item to be re-promoted. ADR-0071 §2 rollback.
    """
    from trueppm_api.apps.projects.models import RetroActionItem

    updated = RetroActionItem.objects.filter(promoted_task_id=task_id).update(promoted_task_id=None)
    if updated:
        logger.info(
            "reset_promoted_task_on_delete: freed %s action items linked to task %s",
            updated,
            task_id,
        )


def now_utc() -> datetime:
    """Centralized timezone-aware now for tests to monkey-patch."""
    return timezone.now()
