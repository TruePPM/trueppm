"""Celery tasks for taskruns app."""

from __future__ import annotations

import logging
from typing import Any

from celery import shared_task
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(name="taskruns.purge_old_records")
def purge_old_task_runs() -> dict[str, Any]:
    """Delete completed/failed/cancelled TaskRun records older than retention window.

    Controlled by TASK_RUN_RETENTION_DAYS setting (default 30). Set to None to
    disable auto-purge.
    """
    from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

    retention_days: int | None = getattr(settings, "TASK_RUN_RETENTION_DAYS", 30)
    if retention_days is None:
        return {"deleted": 0, "skipped": "retention disabled"}

    cutoff = timezone.now() - timezone.timedelta(days=retention_days)
    terminal_statuses = [
        TaskRunStatus.SUCCESS,
        TaskRunStatus.FAILED,
        TaskRunStatus.CANCELLED,
    ]
    deleted, _ = TaskRun.objects.filter(
        status__in=terminal_statuses,
        completed_at__lt=cutoff,
    ).delete()

    logger.info(
        "purge_old_task_runs: deleted %d records older than %d days",
        deleted,
        retention_days,
    )
    return {"deleted": deleted}
