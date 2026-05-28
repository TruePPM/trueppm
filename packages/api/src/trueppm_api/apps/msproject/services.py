"""Service layer for MS Project import outbox operations.

Call sites:
  - ``msproject.views`` — deferred via ``transaction.on_commit`` after the
    ImportRequest row is committed
  - ``msproject.tasks._do_import_drain`` — for each PENDING row the drain
    picks up
"""

from __future__ import annotations

import logging

from django.utils import timezone

logger = logging.getLogger(__name__)


def enqueue_import(import_request_id: str) -> None:
    """Attempt to dispatch a PENDING ImportRequest row to Celery.

    Reads the row by ID and tries to call ``import_msproject.delay()``.
    On success the row is flipped to DISPATCHED.  On broker failure the row
    stays PENDING so ``drain_import_queue`` picks it up within 30 seconds.

    Safe to call from ``transaction.on_commit()`` callbacks and from the
    drain task body.  If the row is no longer PENDING (already dispatched by
    a concurrent call) the function is a no-op.
    """
    from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus
    from trueppm_api.apps.msproject.tasks import import_msproject

    try:
        req = ImportRequest.objects.get(id=import_request_id, status=ImportRequestStatus.PENDING)
    except ImportRequest.DoesNotExist:
        return

    try:
        result = import_msproject.delay(
            project_id=str(req.project_id),
            file_content_b64=req.file_content_b64,
            filename=req.filename,
            initiated_by_id=req.initiated_by_id,
            import_request_id=str(req.id),
            creates_project=req.creates_project,
        )
    except Exception:
        logger.warning(
            "enqueue_import: could not dispatch ImportRequest %s — drain will retry",
            import_request_id,
        )
        return

    ImportRequest.objects.filter(id=req.id, status=ImportRequestStatus.PENDING).update(
        status=ImportRequestStatus.DISPATCHED,
        celery_task_id=result.id,
        dispatched_at=timezone.now(),
    )
