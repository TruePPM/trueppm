"""Service layer for the Jira import outbox (mirrors msproject.services)."""

from __future__ import annotations

import logging

from django.utils import timezone

logger = logging.getLogger(__name__)


def enqueue_jira_import(import_request_id: str) -> None:
    """Attempt to dispatch a PENDING JiraImportRequest row to Celery.

    Safe to call from ``transaction.on_commit()`` and from the drain body. On a
    broker outage the row stays PENDING so ``drain_jira_import_queue`` retries
    within 30 seconds; a no-op if the row is no longer PENDING.
    """
    from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus
    from trueppm_api.apps.jiraimport.tasks import import_jira

    try:
        req = JiraImportRequest.objects.get(id=import_request_id, status=JiraImportStatus.PENDING)
    except JiraImportRequest.DoesNotExist:
        return

    try:
        result = import_jira.delay(
            project_id=str(req.project_id),
            file_content_b64=req.file_content_b64,
            filename=req.filename,
            initiated_by_id=req.initiated_by_id,
            import_request_id=str(req.id),
        )
    except Exception:
        logger.warning(
            "enqueue_jira_import: could not dispatch JiraImportRequest %s — drain will retry",
            import_request_id,
        )
        return

    JiraImportRequest.objects.filter(id=req.id, status=JiraImportStatus.PENDING).update(
        status=JiraImportStatus.DISPATCHED,
        celery_task_id=result.id,
        dispatched_at=timezone.now(),
    )
