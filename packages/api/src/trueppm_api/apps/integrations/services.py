"""Service layer for user-scoped external task sync (ADR-0097 §4).

``enqueue_external_sync`` is the single entry point that queues a read-only pull
of one ``(user, source)`` connection. It follows the canonical transactional
outbox shape (ADR-0017/0019): write an ``ExternalSyncRequest`` row inside a
transaction, then a best-effort ``transaction.on_commit`` dispatch of the
``external_sync`` Celery task. If the broker is down the row stays ``PENDING``
and the 300 s ``drain-external-sync`` Beat task recovers it.

Never call ``external_sync.delay()`` directly from a view — the outbox row is
what makes the pull survive a broker outage (ADR-0097 §Durable Execution #4).
"""

from __future__ import annotations

import logging
import uuid

from django.db import IntegrityError, transaction
from django.utils import timezone

from .external_sources import EXTERNAL_TASK_SOURCES
from .models import (
    ExternalSyncRequest,
    ExternalSyncRequestReason,
    ExternalSyncRequestStatus,
)

logger = logging.getLogger(__name__)

# Minimum spacing between *manual* refreshes of one connection (ADR-0097
# §Resolution #5 "per-user cooldown ≥60 s"). The partial-unique constraint
# already coalesces a burst onto one in-flight pull; this outer bound also
# rate-limits back-to-back refreshes *after* a pull completes, so a user
# hammering the button cannot walk Jira's rate budget. The opt-in poll and the
# on-open refresh are exempt — they are already low-frequency by construction.
MANUAL_SYNC_COOLDOWN_SECONDS = 60


class SyncCooldownActive(Exception):
    """A manual refresh was requested inside the per-connection cooldown window.

    Carries ``retry_after`` (seconds) so the view can answer ``429`` with a
    ``Retry-After`` header rather than silently swallowing the request.
    """

    def __init__(self, retry_after: int) -> None:
        self.retry_after = retry_after
        super().__init__(f"Sync cooldown active — retry in {retry_after}s")


def enqueue_external_sync(
    user_id: int,
    source: str,
    *,
    reason: ExternalSyncRequestReason = ExternalSyncRequestReason.MANUAL,
) -> ExternalSyncRequest | None:
    """Queue a read-only pull of one external-source connection (outbox + dispatch).

    Idempotent: if a ``PENDING`` row already exists for ``(user, source)`` it is
    adopted (coalescing a burst of triggers onto one pull) rather than stacking a
    second Jira fetch — mirrors ``scheduling.enqueue_recalculate``.

    Args:
        user_id: Owner of the connection (rows are strictly per-user).
        source: An ``EXTERNAL_TASK_SOURCES`` key (e.g. ``"jira"``).
        reason: Why the pull was queued — forensics only.

    Returns:
        The queued (or adopted) ``ExternalSyncRequest``, or ``None`` if a race
        transitioned the pending row out from under the adopt path.

    Raises:
        ValueError: ``source`` is not a registered external task source.
        SyncCooldownActive: ``reason`` is ``MANUAL`` and the last request for this
            connection is inside :data:`MANUAL_SYNC_COOLDOWN_SECONDS`.
    """
    if EXTERNAL_TASK_SOURCES.get(source) is None:
        raise ValueError(f"Unknown external task source {source!r}.")

    now = timezone.now()

    # Manual-refresh cooldown (ADR-0097 §Resolution #5). Measured from the most
    # recent request's ``requested_at`` regardless of its terminal state, so a
    # completed pull still blocks an immediate re-trigger. Poll / on-open reasons
    # skip this — they are already spaced by their Beat cadence.
    if reason == ExternalSyncRequestReason.MANUAL:
        last = (
            ExternalSyncRequest.objects.filter(user_id=user_id, source=source)
            .order_by("-requested_at")
            .first()
        )
        if last is not None:
            elapsed = (now - last.requested_at).total_seconds()
            if elapsed < MANUAL_SYNC_COOLDOWN_SECONDS:
                raise SyncCooldownActive(
                    retry_after=max(1, int(MANUAL_SYNC_COOLDOWN_SECONDS - elapsed))
                )

    req: ExternalSyncRequest
    try:
        with transaction.atomic():
            req = ExternalSyncRequest.objects.create(user_id=user_id, source=source, reason=reason)
    except IntegrityError:
        # A PENDING row already exists (partial-unique constraint). Adopt it — it
        # may be stranded (its own dispatch failed on a broker blip) and every
        # subsequent trigger would otherwise pile up behind it. Re-dispatching now
        # collapses them into one pull with the latest Jira data.
        existing = ExternalSyncRequest.objects.filter(
            user_id=user_id,
            source=source,
            status=ExternalSyncRequestStatus.PENDING,
        ).first()
        if existing is None:
            # Race: the row left PENDING between the insert and this lookup — the
            # other writer already dispatched it, so there is nothing to do.
            return None
        req = existing

    _dispatch_on_commit(req.id)
    return req


def _dispatch_on_commit(request_id: uuid.UUID) -> None:
    """Register a best-effort ``external_sync`` dispatch for after commit.

    The dispatch is deferred to ``transaction.on_commit`` so the outbox row is
    durably committed before the worker reads it. A broker error is swallowed —
    the row stays ``PENDING`` and ``drain_external_sync`` re-dispatches it.
    """

    def _dispatch() -> None:
        from .tasks import external_sync

        try:
            result = external_sync.delay(str(request_id))
        except Exception:
            logger.exception(
                "enqueue_external_sync: immediate dispatch failed for request %s "
                "— drain_external_sync will retry",
                request_id,
            )
            return
        # Flip to DISPATCHED only if still PENDING, so a concurrent drain that
        # already dispatched this row is not clobbered.
        ExternalSyncRequest.objects.filter(
            id=request_id, status=ExternalSyncRequestStatus.PENDING
        ).update(
            status=ExternalSyncRequestStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=timezone.now(),
        )

    transaction.on_commit(_dispatch)
