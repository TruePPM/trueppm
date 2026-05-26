"""Celery tasks for MS Project import."""

from __future__ import annotations

import base64
import logging
from collections.abc import Generator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

from celery import shared_task

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# An import task running longer than this is considered orphaned by the drain.
# Slightly longer than soft_time_limit (540 s = 9 min) to let the task time
# out and record its own failure before drain resets the row.
_IMPORT_ORPHAN_MINUTES = 15


class _NoOpTracker:
    """Fallback when TaskRunTracker is not available."""

    task_run_id = None

    def update(self, pct: int, msg: str = "") -> None:
        logger.info("import.msproject progress: %d%% -- %s", pct, msg)

    def set_result(self, result: dict[str, Any]) -> None:
        logger.info("import.msproject result: %s", result)


@contextmanager
def _get_tracker(
    celery_task: Any,
    project_id: str,
    initiated_by_id: int | None,
) -> Generator[Any, None, None]:
    """Try to use TaskRunTracker; fall back to no-op if not available."""
    try:
        from trueppm_api.apps.taskruns.tracker import TaskRunTracker

        with TaskRunTracker(
            celery_task,
            project_id=project_id,
            task_name="import.msproject",
            initiated_by_id=initiated_by_id,
        ) as tracker:
            yield tracker
    except ImportError:
        yield _NoOpTracker()


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    name="msproject.import_file",
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
)
def import_msproject(
    self: Any,
    project_id: str,
    file_content_b64: str,
    filename: str,
    initiated_by_id: int | None = None,
    import_request_id: str | None = None,
) -> dict[str, Any]:
    """Import an MS Project file (.mpp or .xml) into an existing project.

    The file content is passed as base64-encoded string to avoid binary
    issues with the Celery/Redis message broker.

    When dispatched via the ImportRequest outbox, import_request_id is set
    so the row can be marked DONE on successful completion.

    After import, triggers a CPM recalculation via the scheduling outbox.
    """
    with _get_tracker(self, project_id, initiated_by_id) as tracker:
        file_content = base64.b64decode(file_content_b64)
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        tracker.update(5, f"Parsing {filename}...")

        if ext == "mpp":
            from trueppm_api.apps.msproject.parser import parse_mpp

            project_data = parse_mpp(file_content)
        elif ext == "xml":
            from trueppm_api.apps.msproject.parser import parse_xml

            project_data = parse_xml(file_content)
        else:
            raise ValueError(f"Unsupported file format: .{ext}. Expected .mpp or .xml")

        from trueppm_api.apps.msproject.importer import import_project

        summary = import_project(project_id, project_data, tracker=tracker)
        tracker.set_result(summary)

        if summary["tasks_created"] > 0:
            # Use the outbox service rather than a direct .delay() call so that
            # a broker outage at import-completion time does not silently drop
            # the recalculation.  The Celery task context has no ambient
            # transaction, so enqueue_recalculate opens its own atomic() block.
            from trueppm_api.apps.scheduling.services import enqueue_recalculate

            enqueue_recalculate(project_id)

    if import_request_id:
        _mark_import_done(import_request_id)

    return summary


def _mark_import_done(import_request_id: str) -> None:
    """Flip the ImportRequest row to DONE after successful completion."""
    from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

    ImportRequest.objects.filter(
        id=import_request_id, status=ImportRequestStatus.DISPATCHED
    ).update(status=ImportRequestStatus.DONE)


@idempotent_task(
    lock_key_template="drain_import_queue",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="msproject.drain_import_queue",
)
def drain_import_queue(self: object) -> None:
    """Dispatch any pending ImportRequest outbox rows.

    Runs every 30 seconds via Celery Beat.  Also recovers orphaned dispatched
    rows older than _IMPORT_ORPHAN_MINUTES (import soft_time_limit is 9 min,
    so 15 min ensures the prior task has either completed or timed out).
    """
    _do_import_drain()


@idempotent_task(
    lock_key_template="purge_old_import_requests",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="msproject.purge_old_import_requests",
)
def purge_old_import_requests(self: object) -> None:
    """Delete done/dead ImportRequest rows older than 7 days.

    Runs nightly via Celery Beat.  Keeps file_content_b64 blobs from
    accumulating in the database indefinitely.
    """
    _do_import_purge()


def _do_import_drain() -> None:
    """Business logic for drain_import_queue — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=_IMPORT_ORPHAN_MINUTES)

    recovered = ImportRequest.objects.filter(
        status=ImportRequestStatus.DISPATCHED,
        dispatched_at__lt=orphan_cutoff,
    ).update(status=ImportRequestStatus.PENDING, celery_task_id="")
    if recovered:
        logger.warning("drain_import_queue: recovered %d orphaned row(s)", recovered)

    pending = list(ImportRequest.objects.filter(status=ImportRequestStatus.PENDING))
    dispatched = 0
    for req in pending:
        try:
            result = import_msproject.delay(
                project_id=str(req.project_id),
                file_content_b64=req.file_content_b64,
                filename=req.filename,
                initiated_by_id=req.initiated_by_id,
                import_request_id=str(req.id),
            )
        except Exception:
            logger.warning(
                "drain_import_queue: broker unavailable — ImportRequest %s stays pending",
                req.id,
            )
            continue
        ImportRequest.objects.filter(id=req.id, status=ImportRequestStatus.PENDING).update(
            status=ImportRequestStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
        dispatched += 1

    if dispatched or recovered:
        logger.info("drain_import_queue: dispatched=%d recovered=%d", dispatched, recovered)


def _do_import_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_old_import_requests — extracted for testability.

    Retention comes from ``resolve_retention`` (operator override → the
    TRUEPPM_IMPORT_RETENTION_DAYS default, ADR-0090); ``None`` disables the purge,
    keeping ImportRequest blobs indefinitely. Returns rows deleted, or the eligible
    count when ``dry_run``; ``override_value`` forces a hypothetical window.
    """
    from django.utils import timezone

    from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus
    from trueppm_api.apps.observability.retention import resolve_retention

    retention_days = (
        override_value
        if override_value is not None
        else resolve_retention("TRUEPPM_IMPORT_RETENTION_DAYS")
    )
    if retention_days is None:
        return 0

    cutoff = timezone.now() - timedelta(days=retention_days)
    qs = ImportRequest.objects.filter(
        status__in=[ImportRequestStatus.DONE, ImportRequestStatus.DEAD],
        requested_at__lt=cutoff,
    )
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    logger.info("purge_old_import_requests: deleted %d row(s)", deleted)
    return deleted
