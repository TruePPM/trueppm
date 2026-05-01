"""Signal receivers for the projects app.

Burndown UPSERT on task status change is the primary connection here. When a
task in an ACTIVE sprint changes status, today's ``SprintBurnSnapshot`` row
is recomputed and written via the unique ``(sprint, snapshot_date)`` index —
naturally idempotent under concurrent writes.
"""

from __future__ import annotations

import logging
from typing import Any

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
