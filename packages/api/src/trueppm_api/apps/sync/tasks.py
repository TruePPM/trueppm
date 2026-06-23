"""Celery tasks for the sync app.

``purge_sync_batches`` reaps :class:`~trueppm_api.apps.sync.models.SyncBatch`
rows past the dedup window so the idempotency table stays bounded — the
ADR-0081 purge convention applied to the upload envelope (ADR-0082 §Durable
Execution #6).
"""

from __future__ import annotations

import logging
from datetime import timedelta

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)


@idempotent_task(
    lock_key_template="purge_sync_batches",
    lock_ttl=300,
    on_contention="skip",
    name="sync.purge_sync_batches",
)
def purge_sync_batches(self: object) -> None:
    """Delete SyncBatch rows older than the retention window.

    Runs nightly via Celery Beat. Rows are only dedup-relevant within
    ``TRUEPPM_SYNC_BATCH_RETENTION_HOURS`` (default 24h); past that, the same
    ``client_batch_id`` is allowed to re-run, so the row carries no value.
    Idempotent and contention-skipping — a second concurrent run is a no-op.
    """
    _do_purge()


def _do_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_sync_batches — extracted for testability.

    The window (in hours) comes from ``resolve_retention`` (operator override →
    the TRUEPPM_SYNC_BATCH_RETENTION_HOURS default, ADR-0173). This window is
    non-nullable, so it is never disabled. Returns rows deleted, or the eligible
    count when ``dry_run``; ``override_value`` forces a hypothetical window.
    """
    from django.utils import timezone

    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.sync.models import SyncBatch

    ttl_hours = (
        override_value
        if override_value is not None
        else resolve_retention("TRUEPPM_SYNC_BATCH_RETENTION_HOURS")
    )
    if ttl_hours is None:
        return 0
    cutoff = timezone.now() - timedelta(hours=ttl_hours)
    qs = SyncBatch.objects.filter(created_at__lt=cutoff)
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    if deleted:
        logger.info("purge_sync_batches: deleted %d expired batch row(s)", deleted)
    return deleted
