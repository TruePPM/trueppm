"""Celery tasks for object change history maintenance."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.db import OperationalError
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)


def _history_purge_counts(
    *, dry_run: bool = False, override_value: int | None = None
) -> dict[str, int]:
    """Return ``{model_name: rows}`` purged (or eligible, when ``dry_run``).

    The window comes from ``resolve_retention`` (operator override → the
    HISTORY_RETENTION_DAYS default, ADR-0173); ``None`` disables the purge and
    yields an empty dict. ``override_value`` forces a hypothetical window.
    """
    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.projects.models import Dependency, Project, Task

    retention_days = (
        override_value
        if override_value is not None
        else resolve_retention("HISTORY_RETENTION_DAYS")
    )
    if retention_days is None:
        return {}

    cutoff = timezone.now() - timedelta(days=retention_days)
    totals: dict[str, int] = {}
    for model in (Project, Task, Dependency):
        qs = model.history.filter(history_date__lt=cutoff)
        totals[model.__name__] = qs.count() if dry_run else qs.delete()[0]
    return totals


def _do_history_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Total historical rows purged (or eligible, when ``dry_run``) across all
    history tables. The coordinator-facing entry point (ADR-0173 §C)."""
    return sum(_history_purge_counts(dry_run=dry_run, override_value=override_value).values())


@idempotent_task(
    lock_key_template="history_purge",
    lock_ttl=600,
    on_contention="skip",
    name="history.purge_old_records",
    autoretry_for=(ConnectionError, OperationalError),
    retry_backoff=60,
    retry_backoff_max=600,
    retry_jitter=True,
    max_retries=3,
    soft_time_limit=300,
    time_limit=360,
    acks_late=True,
)
def purge_old_history_records(self: object) -> dict[str, Any]:
    """Delete historical records older than the resolved HISTORY retention window.

    Still dispatchable directly, but no longer on its own Beat schedule — the
    consolidated retention coordinator owns scheduled purging (ADR-0173 §C).
    Returns a summary dict for logging and monitoring.

    When the window resolves to None the task exits immediately — this disables
    automatic purging for deployments that retain records indefinitely (or archive
    them to cold storage via the history_record_created signal before purging).
    """
    from trueppm_api.apps.observability.retention import resolve_retention

    retention_days = resolve_retention("HISTORY_RETENTION_DAYS")
    if retention_days is None:
        logger.info("purge_old_history_records: retention disabled, skipping purge")
        return {"status": "skipped", "reason": "unlimited retention"}

    cutoff = timezone.now() - timedelta(days=retention_days)
    totals = _history_purge_counts()
    for label, deleted in totals.items():
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
