"""Signal receivers for the projects app.

Burndown UPSERT on task status change is the primary connection here. When a
task in an ACTIVE sprint changes status, today's ``SprintBurnSnapshot`` row
is recomputed and written via the unique ``(sprint, snapshot_date)`` index —
naturally idempotent under concurrent writes.
"""

from __future__ import annotations

import logging
from typing import Any

from django.db.models.signals import post_save
from django.dispatch import receiver

from trueppm_api.apps.projects.signals import task_status_changed

logger = logging.getLogger(__name__)


@receiver(task_status_changed)
def _on_task_status_changed(
    sender: Any,
    task: Any,
    old_status: str | None,
    new_status: str,
    **kwargs: Any,
) -> None:
    """Update today's burn snapshot when a sprint-tracked task moves columns.

    No-op when the task is not in any sprint, or when its sprint is not in
    ACTIVE state. A FAILED upsert is logged but never raised — burndown is a
    secondary observation and must not block the primary status write.
    """
    from trueppm_api.apps.projects.models import SprintState
    from trueppm_api.apps.projects.services import upsert_burndown_for_sprint

    sprint = getattr(task, "sprint", None)
    if sprint is None or sprint.state != SprintState.ACTIVE:
        return
    try:
        upsert_burndown_for_sprint(sprint)
    except Exception:
        logger.exception(
            "task_status_changed: burndown upsert failed for sprint=%s task=%s",
            sprint.pk,
            task.pk,
        )


def _register_task_soft_delete_receiver() -> None:
    """Register the Task post_save receiver that frees RetroActionItem links.

    Wrapped in a function so the import of Task (which would create an import
    cycle if done at module top) happens after the models app is fully loaded.
    Called from ``ProjectsConfig.ready()``.
    """
    from trueppm_api.apps.projects.models import Task

    @receiver(post_save, sender=Task)
    def _on_task_save_reset_promoted(
        sender: Any,
        instance: Any,
        created: bool,
        **kwargs: Any,
    ) -> None:
        """Reset RetroActionItem.promoted_task_id when its Task is soft-deleted.

        ADR-0071 §2 rollback: when the promoted Task is soft-deleted, the
        originating action item must become re-promotable. VersionedModel
        soft_delete sets is_deleted=True and saves; this receiver detects
        that transition.

        No-op for INSERT and for any save where is_deleted=False — the common
        case of a normal Task update.
        """
        if created or not getattr(instance, "is_deleted", False):
            return
        from trueppm_api.apps.projects.retro_services import (
            reset_promoted_task_on_delete,
        )

        try:
            reset_promoted_task_on_delete(str(instance.pk))
        except Exception:
            logger.exception(
                "task soft-delete: failed to reset promoted_task_id for task=%s",
                instance.pk,
            )


def _register_milestone_rollup_receiver() -> None:
    """Register the Task post_save receiver that fires the milestone rollup.

    ADR-0074: when a task assigned to a sprint changes (status, story points,
    sprint membership), and that sprint targets a milestone, recompute the
    milestone rollup live. This is the "instant Gantt update" path — the
    authoritative recompute on sprint close still runs inside the drain.

    Bails out early for the common case (no sprint, no target milestone) so
    the receiver adds negligible overhead to non-sprint task writes. Errors
    are logged and swallowed; the rollup is a cosmetic side effect and must
    never block a primary task write.

    Wrapped in a function for the same import-timing reason as the soft-delete
    receiver above. Called from ``ProjectsConfig.ready()``.
    """
    from trueppm_api.apps.projects.models import Task

    @receiver(post_save, sender=Task, dispatch_uid="milestone_rollup_on_task_save")
    def _on_task_save_recompute_rollup(
        sender: Any,
        instance: Any,
        created: bool,
        **kwargs: Any,
    ) -> None:
        sprint_id = getattr(instance, "sprint_id", None)
        if sprint_id is None or getattr(instance, "is_deleted", False):
            return
        from trueppm_api.apps.projects.models import Sprint

        # One small query — index hit on PK. The cheap filter is paying for
        # itself by short-circuiting the common "task not linked to a
        # sprint-with-milestone" case before any rollup work.
        milestone_id = (
            Sprint.objects.filter(pk=sprint_id, is_deleted=False)
            .values_list("target_milestone_id", flat=True)
            .first()
        )
        if milestone_id is None:
            return
        from trueppm_api.apps.projects.services import recompute_milestone_rollup

        try:
            recompute_milestone_rollup(milestone_id)
        except Exception:
            logger.exception(
                "milestone rollup: recompute failed for task=%s milestone=%s",
                instance.pk,
                milestone_id,
            )
