"""Celery tasks for the idempotency app — retention purge (ADR-0170)."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import OperationalError
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)


def _do_purge(retention_hours: int) -> int:
    """Delete IdempotencyKey rows older than the retention window. Returns deleted count."""
    from trueppm_api.apps.idempotency.models import IdempotencyKey

    cutoff = timezone.now() - timedelta(hours=retention_hours)
    deleted, _ = IdempotencyKey.objects.filter(created_at__lt=cutoff).delete()
    return deleted


@idempotent_task(
    lock_key_template="idempotency_purge",
    lock_ttl=300,
    on_contention="skip",
    name="idempotency.purge_old_keys",
    autoretry_for=(ConnectionError, OperationalError),
    retry_backoff=60,
    retry_backoff_max=600,
    retry_jitter=True,
    max_retries=3,
    soft_time_limit=120,
    time_limit=180,
    acks_late=True,
)
def purge_old_idempotency_keys(self: object) -> dict[str, Any]:
    """Delete IdempotencyKey rows older than IDEMPOTENCY_RETENTION_HOURS.

    Registered in CELERY_BEAT_SCHEDULE to run hourly (a nightly job would let rows live
    up to ~48h, violating the 24h contract). When IDEMPOTENCY_RETENTION_HOURS is None,
    purging is disabled (enterprise unlimited-retention convention, matching the
    *_RETENTION_DAYS = None pattern).
    """
    retention_hours: int | None = getattr(settings, "IDEMPOTENCY_RETENTION_HOURS", 24)
    if retention_hours is None:
        logger.info("purge_old_idempotency_keys: retention disabled, skipping")
        return {"status": "skipped", "reason": "unlimited retention"}

    deleted = _do_purge(retention_hours)
    if deleted:
        logger.info(
            "purge_old_idempotency_keys: deleted %d rows older than %d hours",
            deleted,
            retention_hours,
        )
    return {"deleted": deleted}
