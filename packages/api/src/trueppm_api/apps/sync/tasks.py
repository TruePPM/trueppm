"""Celery tasks for the sync app.

``purge_sync_batches`` reaps :class:`~trueppm_api.apps.sync.models.SyncBatch`
rows past the dedup window so the idempotency table stays bounded — the
ADR-0081 purge convention applied to the upload envelope (ADR-0082 §Durable
Execution #6).

``reap_domain_tombstones`` hard-deletes per-row soft-deleted tombstones
(``is_deleted=True``) from live projects. VersionedModel rows are soft-deleted
so the mobile sync endpoint can return their IDs as tombstones to offline
clients; once the retention window has passed there is no further value in
keeping the row and it can be hard-deleted. Only rows belonging to live
(non-deleted, non-archived) projects are touched — tombstones in deleted or
archived projects are skipped because those projects may still be restoring.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

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


# ---------------------------------------------------------------------------
# reap_domain_tombstones — hard-delete stale per-row soft-delete tombstones
# ---------------------------------------------------------------------------

# Registry of (Model, project_filter_kwargs, age_field_or_None).
#
# ``age_field`` is the DateTimeField used to enforce the retention window. Two
# flavors are in use: an ``updated_at`` (auto_now=True) column that reflects the
# most recent save (Risk, Sprint), or a ``deleted_at`` column stamped only by
# ``soft_delete()`` (mirrors Attachment.deleted_at) — used by Task and
# Dependency so a tombstone reliably survives TRUEPPM_TOMBSTONE_RETENTION_DAYS
# regardless of when the row last happened to be saved for an unrelated reason.
# ``age_field=None`` remains a valid registry entry for a model that
# deliberately opts out of a grace window, but every model below enforces one —
# an offline mobile client must have a window to reconnect and receive a
# tombstone before it is hard-deleted, or the deleted row becomes a permanent
# phantom on that device.
#
# Extend this list when new VersionedModel subclasses are added that carry
# ``is_deleted`` tombstones in the projects domain.
_TOMBSTONE_MODEL_REGISTRY: list[
    tuple[Any, dict[str, Any], str | None]
] = []  # populated lazily in _build_registry()


def _build_registry() -> list[tuple[Any, dict[str, Any], str | None]]:
    """Build the tombstone model registry with deferred model imports.

    Deferred so the function can be called safely after Django app setup
    completes, avoiding circular imports at module load time.
    """
    from trueppm_api.apps.projects.models import Dependency, Risk, Sprint, Task

    return [
        # Task: deleted_at is stamped in Task.soft_delete() (mirrors Attachment) —
        # enforce the retention window so a tombstone survives long enough for an
        # offline client to reconnect and receive it.
        (
            Task,
            {"project__is_deleted": False, "project__is_archived": False},
            "deleted_at",
        ),
        # Risk: has updated_at — enforce the retention window.
        (
            Risk,
            {"project__is_deleted": False, "project__is_archived": False},
            "updated_at",
        ),
        # Sprint: has updated_at — enforce the retention window.
        (
            Sprint,
            {"project__is_deleted": False, "project__is_archived": False},
            "updated_at",
        ),
        # Dependency: no direct project FK — reap via predecessor. deleted_at is
        # stamped in Dependency.soft_delete() (mirrors Task) — enforce the same
        # retention window. Same-project and cross-project edges are both
        # handled: once the predecessor's project is live and the edge is past
        # the retention window, there is no further sync value in the row.
        (
            Dependency,
            {
                "predecessor__project__is_deleted": False,
                "predecessor__project__is_archived": False,
            },
            "deleted_at",
        ),
    ]


@idempotent_task(
    lock_key_template="reap_domain_tombstones",
    lock_ttl=600,
    on_contention="skip",
    name="sync.reap_domain_tombstones",
)
def reap_domain_tombstones(self: object) -> dict[str, int]:
    """Hard-delete per-row soft-deleted tombstones from live projects.

    Runs nightly via Celery Beat. For each model in ``_TOMBSTONE_MODEL_REGISTRY``:
    - Filters ``is_deleted=True`` rows in live (non-deleted, non-archived) projects.
    - For models with an ``age_field`` (``updated_at`` or ``deleted_at``), further
      restricts to rows older than the ``TRUEPPM_TOMBSTONE_RETENTION_DAYS`` cutoff
      (default 90 days).
    - Hard-deletes the eligible rows.

    Returns a dict mapping ``{app_label.model_name: rows_deleted}`` for each
    model — useful for monitoring and log-based alerting.

    Idempotent and contention-skipping — a concurrent run is a no-op.
    """
    return _do_reap()


def _do_reap(*, override_days: int | None = None) -> dict[str, int]:
    """Business logic for reap_domain_tombstones — extracted for testability.

    Args:
        override_days: Force a specific retention window (days) instead of
            reading ``TRUEPPM_TOMBSTONE_RETENTION_DAYS`` from settings. Useful
            in tests to avoid manipulating global settings.

    Returns:
        Dict mapping ``{app_label.model_name: rows_deleted}`` for every
        model in the registry, including zeros.
    """
    from django.conf import settings
    from django.utils import timezone

    retention_days: int = (
        override_days
        if override_days is not None
        else getattr(settings, "TRUEPPM_TOMBSTONE_RETENTION_DAYS", 90)
    )
    cutoff = timezone.now() - timedelta(days=retention_days)

    counts: dict[str, int] = {}
    for Model, project_filters, age_field in _build_registry():
        label: str = Model._meta.label_lower
        qs = Model.objects.filter(is_deleted=True, **project_filters)
        if age_field is not None:
            qs = qs.filter(**{f"{age_field}__lt": cutoff})
        deleted, _ = qs.delete()
        counts[label] = deleted
        if deleted:
            logger.info(
                "reap_domain_tombstones: hard-deleted %d %s tombstone(s)",
                deleted,
                label,
            )
    return counts
