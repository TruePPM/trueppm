"""Celery tasks for object change history maintenance."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from celery import shared_task  # type: ignore[import-untyped]
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(name="history.purge_old_records")  # type: ignore[misc]
def purge_old_history_records() -> dict[str, Any]:
    """Delete historical records older than HISTORY_RETENTION_DAYS.

    Registered in CELERY_BEAT_SCHEDULE to run nightly. Returns a summary
    dict for logging and monitoring.

    When HISTORY_RETENTION_DAYS is None the task exits immediately — this
    disables automatic purging for enterprise deployments that retain records
    indefinitely (or archive them to cold storage via the history_record_created
    signal before purging).
    """
    from trueppm_api.apps.projects.models import Dependency, Project, Task

    retention_days: int | None = getattr(settings, "HISTORY_RETENTION_DAYS", 90)
    if retention_days is None:
        logger.info("purge_old_history_records: HISTORY_RETENTION_DAYS=None, skipping purge")
        return {"status": "skipped", "reason": "unlimited retention"}

    cutoff = timezone.now() - timedelta(days=retention_days)
    totals: dict[str, int] = {}
    for model in (Project, Task, Dependency):
        label = model.__name__
        deleted, _ = model.history.filter(  # type: ignore[attr-defined]
            history_date__lt=cutoff
        ).delete()
        totals[label] = deleted
        if deleted:
            logger.info(
                "purge_old_history_records: deleted %d Historical%s rows older than %s",
                deleted,
                label,
                cutoff.date(),
            )

    total = sum(totals.values())
    logger.info(
        "purge_old_history_records: total %d rows deleted (cutoff=%s)", total, cutoff.date()
    )
    return {"status": "ok", "deleted": totals, "cutoff": cutoff.isoformat()}
