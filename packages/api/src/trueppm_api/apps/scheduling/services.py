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

from trueppm_api.apps.scheduling.models import ScheduleRequestReason

logger = logging.getLogger(__name__)


def enqueue_recalculate(
    project_id: str,
    reason: ScheduleRequestReason = ScheduleRequestReason.TASK_CHANGE,
) -> None:
    """Insert a ScheduleRequest outbox row and attempt immediate dispatch.

    Safe to call from:
      - ``transaction.on_commit()`` callbacks (HTTP request context)
      - Celery task bodies (no ambient transaction; ``atomic()`` opens its own)

    The ``reason`` is recorded on the outbox row purely for forensics — it does
    not change dispatch behavior. When the same project already has a PENDING
    row, the existing row's reason is preserved (whatever triggered the queue
    first wins) so debugging "why did this recalc fire?" still points at the
    initial cause rather than the last edit to pile on.

    If a pending row already exists for the project we adopt it — coalescing
    every edit that happened while it was waiting into a single CPM run — and
    still attempt the immediate dispatch.  Without this, a stranded pending
    row (e.g. from an earlier broker outage) would silently swallow every
    subsequent edit until ``drain_schedule_queue`` ran, which is the failure
    mode that produced #314.

    If the broker is unavailable the row is left PENDING and
    ``drain_schedule_queue`` picks it up within 30 seconds.
    """
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus

    req: ScheduleRequest
    try:
        with transaction.atomic():
            req = ScheduleRequest.objects.create(project_id=project_id, reason=reason)
    except IntegrityError:
        # A pending row already exists. Adopt it instead of returning — the
        # existing row may be stranded (the request that created it failed to
        # dispatch, e.g. broker outage) and every subsequent edit will pile up
        # on it. Re-dispatching it now coalesces all those edits into a single
        # CPM run with the latest data.
        existing = ScheduleRequest.objects.filter(
            project_id=project_id,
            status=ScheduleRequestStatus.PENDING,
        ).first()
        if existing is None:
            # Race: row transitioned out of PENDING between insert + lookup.
            # The other writer already dispatched it; nothing to do.
            return
        req = existing

    # Best-effort immediate dispatch — reduces recalculation latency when the
    # broker is healthy.  Failure here is not fatal; the row stays PENDING.
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    try:
        result = recalculate_schedule.delay(project_id)
    except Exception:
        # Use logger.exception so the broker error and stack trace are visible.
        # A previous regression (#314) silently swallowed `OperationalError:
        # Connection refused` here for weeks because logger.warning hid the
        # cause — the cascade quietly stopped firing for every dependency edit.
        logger.exception(
            "enqueue_recalculate: could not immediately dispatch for project %s "
            "— drain task will pick it up within 30 s",
            project_id,
        )
        return

    from django.utils import timezone

    # Guard the PENDING→DISPATCHED transition with a savepoint: another row for
    # this project may already be DISPATCHED (stranded by a missing worker — the
    # CI integration env, or a Celery outage in prod) and the partial unique
    # index `schedule_request_one_dispatched_per_project` will reject the
    # update. Treat that as the same situation as a broker outage: leave the
    # row PENDING and let `drain_schedule_queue` coalesce on the next tick.
    try:
        with transaction.atomic():
            ScheduleRequest.objects.filter(id=req.id, status=ScheduleRequestStatus.PENDING).update(
                status=ScheduleRequestStatus.DISPATCHED,
                celery_task_id=result.id,
                dispatched_at=timezone.now(),
            )
    except IntegrityError:
        logger.warning(
            "enqueue_recalculate: project %s already has a DISPATCHED outbox row "
            "— leaving new request PENDING for drain_schedule_queue to coalesce",
            project_id,
        )
