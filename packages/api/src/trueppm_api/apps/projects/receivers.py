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
