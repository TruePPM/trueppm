"""Celery tasks for Beat liveness observability (ADR-0081)."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING

from trueppm_api.core.idempotent import idempotent_task

if TYPE_CHECKING:
    from trueppm_api.apps.observability.models import PurgeRun

logger = logging.getLogger(__name__)

# The fixed singleton row key — every heartbeat upsert targets this one row.
_SINGLETON_KEY = 1


def _do_heartbeat() -> None:
    """Business logic for beat.heartbeat — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.observability.models import BeatHeartbeat

    BeatHeartbeat.objects.update_or_create(
        singleton_key=_SINGLETON_KEY,
        defaults={"last_heartbeat": timezone.now()},
    )


def _do_check_stale() -> bool:
    """Business logic for beat.check_stale_heartbeat — extracted for testability.

    Returns True when the heartbeat is stale (or has never been recorded), logging
    a WARNING in that case. The primary detector is ``GET /api/v1/health/beat/``;
    this is a secondary in-cluster signal for deployments with no external monitor.
    A Beat-scheduled check (not a self-rescheduling worker chain) is used on purpose:
    it self-heals on Beat restart and cannot silently lose itself (ADR-0081 §B).
    """
    from django.conf import settings
    from django.utils import timezone

    from trueppm_api.apps.observability.models import BeatHeartbeat

    threshold = settings.TRUEPPM_BEAT_STALE_SECONDS
    row = BeatHeartbeat.objects.filter(singleton_key=_SINGLETON_KEY).first()
    if row is None:
        logger.warning("check_stale_heartbeat: no heartbeat recorded yet")
        return True

    age_seconds = (timezone.now() - row.last_heartbeat).total_seconds()
    if age_seconds > threshold:
        logger.warning(
            "check_stale_heartbeat: heartbeat is %.0fs old (threshold %ds) — "
            "Celery Beat may be down",
            age_seconds,
            threshold,
        )
        return True
    return False


@idempotent_task(
    lock_key_template="beat_heartbeat",
    lock_ttl=25,
    on_contention="skip",
    soft_time_limit=10,
    time_limit=20,
    acks_late=True,
    reject_on_worker_lost=True,
    name="beat.heartbeat",
)
def heartbeat(self: object) -> None:
    """Beat task: record a liveness heartbeat every 30 seconds."""
    _do_heartbeat()


@idempotent_task(
    lock_key_template="beat_check_stale_heartbeat",
    lock_ttl=50,
    on_contention="skip",
    soft_time_limit=10,
    time_limit=20,
    acks_late=True,
    reject_on_worker_lost=True,
    name="beat.check_stale_heartbeat",
)
def check_stale_heartbeat(self: object) -> None:
    """Beat task: log a WARNING when the heartbeat is stale (every 60 seconds)."""
    _do_check_stale()


# ---------------------------------------------------------------------------
# Retention purge coordinator (ADR-0090)
# ---------------------------------------------------------------------------

# Keep the purge-run history table self-bounded — no separate retention knob.
_PURGE_RUN_KEEP = 50


def _should_run_scheduled(now: datetime | None = None) -> bool:
    """Decide whether a scheduled purge is due (ADR-0090 §D self-gating).

    Beat fires the coordinator every 30 min; this gate keeps it a no-op except
    inside the operator's configured window. Returns False when the schedule is
    Off, before today's ``time_of_day_utc``, on the wrong weekday (Weekly), or if a
    scheduled run already started in the current window (cron catch-up dedupe).
    """
    from django.utils import timezone

    from trueppm_api.apps.observability.models import PurgeRun, RetentionSchedule

    schedule = RetentionSchedule.objects.first()
    if schedule is None:
        # No row yet → behave as the model defaults (Daily @ 02:00 UTC).
        schedule = RetentionSchedule()

    if schedule.frequency == RetentionSchedule.Frequency.OFF:
        return False

    current = now or timezone.now()
    if (
        schedule.frequency == RetentionSchedule.Frequency.WEEKLY
        and current.weekday() != schedule.day_of_week
    ):
        return False

    window_start = current.replace(
        hour=schedule.time_of_day_utc.hour,
        minute=schedule.time_of_day_utc.minute,
        second=0,
        microsecond=0,
    )
    if current < window_start:
        return False

    already_ran = PurgeRun.objects.filter(
        trigger=PurgeRun.Trigger.SCHEDULED, started_at__gte=window_start
    ).exists()
    return not already_ran


def _execute_run(run: PurgeRun, *, dry_run: bool) -> None:
    """Run every operational table's purge into one PurgeRun (ADR-0090 §C).

    Honors the schedule's ``on_failure``: ``stop`` aborts on first table error;
    ``continue`` flags the failed table and proceeds. The run is ``ok`` when every
    table succeeds, ``failed`` when all fail, else ``partial``.
    """
    from django.utils import timezone

    from trueppm_api.apps.observability.models import PurgeRun, RetentionSchedule
    from trueppm_api.apps.observability.purge_registry import (
        estimate_freed_bytes,
        get_purge_specs,
    )
    from trueppm_api.apps.observability.retention import spec_for

    schedule = RetentionSchedule.objects.first()
    on_failure = schedule.on_failure if schedule else RetentionSchedule.OnFailure.CONTINUE

    tables: list[dict[str, object]] = []
    total_rows = 0
    total_bytes = 0
    failures = 0
    for spec in get_purge_specs():
        meta = spec_for(spec.key)
        try:
            rows = spec.purge(dry_run=dry_run)
            freed = estimate_freed_bytes(spec.db_tables, rows)
            tables.append(
                {
                    "key": spec.key,
                    "label": meta["label"],
                    "rows": rows,
                    "bytes": freed,
                    "state": "ok",
                    "error": "",
                }
            )
            total_rows += rows
            if freed:
                total_bytes += freed
        except Exception as exc:
            failures += 1
            logger.exception("retention purge failed for table %s", spec.key)
            tables.append(
                {
                    "key": spec.key,
                    "label": meta["label"],
                    "rows": 0,
                    "bytes": None,
                    "state": "failed",
                    "error": str(exc)[:500],
                }
            )
            if on_failure == RetentionSchedule.OnFailure.STOP:
                break

    if failures == 0:
        state = PurgeRun.State.OK
    elif failures == len(tables):
        state = PurgeRun.State.FAILED
    else:
        state = PurgeRun.State.PARTIAL

    run.state = state
    run.finished_at = timezone.now()
    run.tables = tables
    run.rows_deleted = total_rows
    run.bytes_freed = total_bytes or None
    run.save(update_fields=["state", "finished_at", "tables", "rows_deleted", "bytes_freed"])

    _trim_runs()


def _trim_runs() -> None:
    """Keep only the most recent ``_PURGE_RUN_KEEP`` purge runs (self-bounding)."""
    from trueppm_api.apps.observability.models import PurgeRun

    keep_ids = list(
        PurgeRun.objects.order_by("-started_at").values_list("id", flat=True)[:_PURGE_RUN_KEEP]
    )
    PurgeRun.objects.exclude(id__in=keep_ids).delete()


@idempotent_task(
    lock_key_template="retention_purge_coordinator",
    lock_ttl=600,
    on_contention="skip",
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
    name="retention.run_purge",
)
def run_retention_purge(self: object, run_id: str | None = None, dry_run: bool = False) -> None:
    """Coordinator: purge all five operational tables as one unified run.

    Two entry points (ADR-0090 §C/§D):

    * **Scheduled** — Beat fires this with no ``run_id`` every 30 min; it self-gates
      on the configured window and creates its own ``PurgeRun`` when due.
    * **Manual / dry-run** — the API creates the ``PurgeRun`` first and dispatches
      with its ``run_id``, so the row is visible (``on_commit``) before adoption.

    Idempotent and single-flight via the Redis lock; a scheduled re-entry inside the
    same window is additionally deduped by ``_should_run_scheduled``.
    """
    from trueppm_api.apps.observability.models import PurgeRun

    if run_id is None:
        if not _should_run_scheduled():
            return
        run = PurgeRun.objects.create(
            trigger=PurgeRun.Trigger.SCHEDULED, state=PurgeRun.State.RUNNING
        )
    else:
        existing = PurgeRun.objects.filter(id=run_id).first()
        if existing is None:
            logger.warning("run_retention_purge: PurgeRun %s not found, skipping", run_id)
            return
        run = existing

    _execute_run(run, dry_run=dry_run)
