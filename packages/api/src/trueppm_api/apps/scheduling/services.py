"""Service layer for scheduling outbox operations.

This module is the canonical home for ``enqueue_recalculate`` — the function
that writes a ``ScheduleRequest`` outbox row and attempts an immediate
best-effort Celery dispatch.  It lives in the ``scheduling`` app because it
directly manages ``ScheduleRequest``, which is owned by that app.

Call sites:
  - ``projects.views`` — task/dependency mutations (via ``transaction.on_commit``)
  - ``scheduling.views`` — manual trigger endpoint (direct call, inside
    ``ATOMIC_REQUESTS`` transaction)
  - ``msproject.tasks`` — post-import recalculation (direct call, Celery task
    has already committed its writes)
"""

from __future__ import annotations

import logging

from django.db import IntegrityError, transaction

logger = logging.getLogger(__name__)


def enqueue_recalculate(project_id: str) -> None:
    """Insert a ScheduleRequest outbox row and attempt immediate dispatch.

    Safe to call from:
      - ``transaction.on_commit()`` callbacks (HTTP request context)
      - Celery task bodies (no ambient transaction; ``atomic()`` opens its own)

    If a pending row already exists for the project the call is a no-op
    (idempotent by design — the partial unique index raises IntegrityError
    which is swallowed).  If the broker is unavailable the row is left
    PENDING and ``drain_schedule_queue`` picks it up within 30 seconds.
    """
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus

    try:
        with transaction.atomic():
            req = ScheduleRequest.objects.create(project_id=project_id)
    except IntegrityError:
        # A pending row already exists — drain task will handle it.
        return

    # Best-effort immediate dispatch — reduces recalculation latency when the
    # broker is healthy.  Failure here is not fatal; the row stays PENDING.
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    try:
        result = recalculate_schedule.delay(project_id)
    except Exception:
        logger.warning(
            "enqueue_recalculate: could not immediately dispatch for project %s "
            "— drain task will pick it up within 30 s",
            project_id,
        )
        return

    from django.utils import timezone

    ScheduleRequest.objects.filter(id=req.id, status=ScheduleRequestStatus.PENDING).update(
        status=ScheduleRequestStatus.DISPATCHED,
        celery_task_id=result.id,
        dispatched_at=timezone.now(),
    )
