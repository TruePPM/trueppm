"""Celery tasks for taskruns app."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


def _do_taskrun_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_old_task_runs — extracted for testability.

    Deletes terminal (SUCCESS/FAILED/CANCELLED) TaskRun rows older than the window
    resolved by ``resolve_retention`` (operator override → the
    TASK_RUN_RETENTION_DAYS default, ADR-0173); ``None`` disables the purge. Returns
    rows deleted, or the eligible count when ``dry_run``; ``override_value`` forces
    a hypothetical window.
    """
    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

    retention_days = (
        override_value
        if override_value is not None
        else resolve_retention("TASK_RUN_RETENTION_DAYS")
    )
    if retention_days is None:
        return 0

    cutoff = timezone.now() - timedelta(days=retention_days)
    qs = TaskRun.objects.filter(
        status__in=[TaskRunStatus.SUCCESS, TaskRunStatus.FAILED, TaskRunStatus.CANCELLED],
        completed_at__lt=cutoff,
    )
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    logger.info("purge_old_task_runs: deleted %d records", deleted)
    return deleted


@shared_task(name="taskruns.purge_old_records")  # type: ignore[untyped-decorator]
def purge_old_task_runs() -> dict[str, Any]:
    """Delete completed/failed/cancelled TaskRun records older than the window.

    Still dispatchable directly, but no longer on its own Beat schedule — the
    consolidated retention coordinator owns scheduled purging (ADR-0173 §C).
    Controlled by TASK_RUN_RETENTION_DAYS (default 30) plus any operator override;
    a resolved window of None disables auto-purge.
    """
    from trueppm_api.apps.observability.retention import resolve_retention

    if resolve_retention("TASK_RUN_RETENTION_DAYS") is None:
        return {"deleted": 0, "skipped": "retention disabled"}
    return {"deleted": _do_taskrun_purge()}
