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
from typing import TYPE_CHECKING, Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

if TYPE_CHECKING:
    from django.contrib.auth.models import User

    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        Sprint,
        Task,
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


def lock_project_before_items(project_id: Any) -> None:
    """Take the project row lock that every sync-cursor draw takes, before item locks.

    The one global lock order for retro writers is **project row, then
    ``RetroActionItem`` rows** (#4628). A Task soft-delete already runs in that order:
    its ``save()`` draws a sync cursor (locking the project row) and only then does
    ``reset_promoted_task_on_delete`` update items. Retro save, promote and carryover
    used to lock items first and reach the project later through their own cursor
    draws, so a retro save racing the soft-delete of one of its promoted tasks could
    deadlock. Callers must be inside ``transaction.atomic()``.

    Carryover also locks a ``Sprint``, and that lock goes **before** this one: the
    full order is target sprint, then project, then items. Every other sprint row
    locker draws a cursor after it, so it runs sprint then project: activate and
    cancel (``SprintViewSet``) lock a PLANNED sprint and then ``save()`` it, and
    ``close_sprint`` locks the ACTIVE sprint and then saves it. A carryover that
    took the project first and the sprint second would deadlock against a cancel
    or activate of its target sprint. See ``_lock_carryover_target_sprint``.
    """
    from trueppm_api.apps.projects.models import Project

    list(Project.objects.select_for_update(of=("self",)).filter(pk=project_id).values("pk"))


def _lock_carryover_target_sprint(sprint_pk: Any) -> Sprint:
    """Lock the carryover target sprint so its state cannot change before commit.

    Taken before the project lock (see ``lock_project_before_items``). It is
    ``FOR NO KEY UPDATE`` rather than ``FOR UPDATE`` because ``close_sprint`` moves
    carried tasks into its ``carry_over_to`` sprint, usually the same PLANNED sprint
    a carryover targets, after it already holds the project lock. Each moved task's
    foreign key takes ``FOR KEY SHARE`` on that sprint, which ``FOR UPDATE`` would
    block, closing a sprint, project, sprint cycle. ``FOR NO KEY UPDATE`` still
    conflicts with the ``FOR UPDATE`` that activate, cancel and close take, so the
    state check stays serialized against them.
    """
    from trueppm_api.apps.projects.models import Sprint

    return Sprint.objects.select_for_update(no_key=True).get(pk=sprint_pk)


def _project_id_of_item(item_pk: Any) -> Any:
    """Unlocked read of an item's project id (immutable, so safe before any lock)."""
    from trueppm_api.apps.projects.models import RetroActionItem

    return RetroActionItem.objects.values_list("retro__sprint__project_id", flat=True).get(
        pk=item_pk
    )


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
        # Project lock first, then the item row (#4628 global lock order).
        lock_project_before_items(_project_id_of_item(action_item.pk))
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

        # Snapshot every broadcast value to a plain scalar *at registration time*
        # so the deferred dispatch can never read a later-mutated (or by-then
        # garbage-collected) ORM instance (#1323). `suggestion.pk` and
        # `locked.assignee_id` were the last live ORM reads left in the closure.
        project_id = str(project.pk)
        task_id = str(task.pk)
        action_item_id = str(locked.pk)
        retro_id = str(locked.retro_id)
        suggestion_id = str(suggestion.pk) if suggestion is not None else None
        suggested_user_id = locked.assignee_id

        def _on_commit_dispatch() -> None:
            # Same ``id``-omission defect as the carryover ``task_updated`` below
            # (#2843), found by the payload-shape guard rather than by the audit:
            # every other ``task_created`` site emits ``{"id": ...}``, and a client
            # keying on ``payload.id`` cannot see this one at all. ``task_id`` stays
            # for one release; drop it after 0.5.
            broadcast_board_event(
                project_id,
                "task_created",
                {
                    "id": task_id,
                    "task_id": task_id,
                    "source": "retrospective",
                    "retro_id": retro_id,
                    "action_item_id": action_item_id,
                },
            )
            if suggestion_id is not None:
                broadcast_board_event(
                    project_id,
                    "suggestion_created",
                    {
                        "task_id": task_id,
                        "suggestion_id": suggestion_id,
                        "suggested_user_id": suggested_user_id,
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
        SprintState,
        Task,
    )
    from trueppm_api.apps.sync.broadcast import defer_task_updated

    with transaction.atomic():
        # Sprint, then project, then item (#4628 global lock order).
        target_locked = _lock_carryover_target_sprint(target_sprint.pk)
        lock_project_before_items(_project_id_of_item(action_item.pk))
        locked = (
            RetroActionItem.objects.select_for_update()
            .select_related("retro__sprint__project")
            .get(pk=action_item.pk)
        )
        source_project_id = locked.retro.sprint.project_id

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

        task_id = str(task.pk)
        sprint_id = str(target_locked.pk)

        # Through the ADR-0152 helper so the frame carries ``changed_fields`` and the
        # post-save ``version`` (the ``save`` above bumped it). Unattributed: the
        # pull-to-sprint hook does not refresh the actor's ``['tasks']`` cache, so the
        # actor's own client must refetch rather than skip the frame as a self-echo.
        # ``task_id`` / ``sprint_id`` / ``source`` are the keys this site already
        # published (``task_id`` predates the ``id`` fix in #2843); ``extra`` keeps
        # them without letting them override the standard keys.
        defer_task_updated(
            task,
            changed_fields=["sprint"],
            extra={"task_id": task_id, "sprint_id": sprint_id, "source": "retro_carryover"},
        )

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
