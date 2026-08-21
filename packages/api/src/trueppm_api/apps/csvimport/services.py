"""Service layer for the CSV import outbox (mirrors jiraimport.services)."""

from __future__ import annotations

import logging

from django.utils import timezone

logger = logging.getLogger(__name__)


def enqueue_csv_import(import_request_id: str) -> None:
    """Attempt to dispatch a PENDING CsvImportRequest row to Celery.

    Safe to call from ``transaction.on_commit()`` and from the drain body. On a
    broker outage the row stays PENDING so ``drain_csv_import_queue`` retries
    within 30 seconds; a no-op if the row is no longer PENDING.
    """
    from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
    from trueppm_api.apps.csvimport.tasks import import_csv

    try:
        req = CsvImportRequest.objects.get(id=import_request_id, status=CsvImportStatus.PENDING)
    except CsvImportRequest.DoesNotExist:
        return

    try:
        result = import_csv.delay(
            project_id=str(req.project_id),
            file_content_b64=req.file_content_b64,
            filename=req.filename,
            column_map=req.column_map,
            date_order=req.date_order,
            initiated_by_id=req.initiated_by_id,
            import_request_id=str(req.id),
        )
    except Exception:
        logger.warning(
            "enqueue_csv_import: could not dispatch CsvImportRequest %s — drain will retry",
            import_request_id,
        )
        return

    CsvImportRequest.objects.filter(id=req.id, status=CsvImportStatus.PENDING).update(
        status=CsvImportStatus.DISPATCHED,
        celery_task_id=result.id,
        dispatched_at=timezone.now(),
    )
