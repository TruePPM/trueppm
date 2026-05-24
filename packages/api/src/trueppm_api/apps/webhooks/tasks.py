"""Celery tasks for outbound webhook delivery."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import urllib.error
import urllib.request
from datetime import timedelta

from celery import shared_task
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# Deliveries created more than this many minutes ago with attempt_count == 0
# are considered stranded (the .delay() call was lost) and re-dispatched by the
# drain.  Deliveries created *within* the window are left alone — they may still
# be inside a transaction.on_commit() pipeline.
_DRAIN_ORPHAN_MINUTES = 5

# Exponential backoff countdown sequence (seconds): 30, 60, 120, 240, 480
_MAX_RETRIES = 5
_BACKOFF_BASE = 30


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    max_retries=_MAX_RETRIES,
    retry_backoff=_BACKOFF_BASE,
    retry_backoff_max=600,
    retry_jitter=True,
    soft_time_limit=30,
    time_limit=60,
    acks_late=True,
    reject_on_worker_lost=True,
)
def deliver_webhook(self: object, delivery_id: str) -> None:
    """POST a webhook payload to the registered URL with HMAC-SHA256 signature.

    Retries with exponential backoff on network errors and non-2xx responses.
    After final failure the delivery is marked as failed.
    """
    from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

    try:
        delivery = WebhookDelivery.objects.select_related("webhook").get(pk=delivery_id)
    except WebhookDelivery.DoesNotExist:
        logger.warning("deliver_webhook: delivery %s not found, skipping", delivery_id)
        return

    webhook = delivery.webhook
    if not webhook.is_active:
        logger.info("deliver_webhook: webhook %s is inactive, skipping", webhook.pk)
        delivery.status = DeliveryStatus.FAILED
        delivery.completed_at = timezone.now()
        delivery.save(update_fields=["status", "completed_at"])
        return

    body = json.dumps(delivery.payload, default=str, sort_keys=True).encode("utf-8")
    signature = hmac.new(
        webhook.secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()

    delivery.attempt_count += 1

    req = urllib.request.Request(
        webhook.url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-TruePPM-Signature": f"sha256={signature}",
            "X-TruePPM-Event": delivery.event_type,
            "X-TruePPM-Delivery": str(delivery.pk),
            # Per-subscription monotonic sequence (#664). Stable across retries —
            # the same delivery row keeps its number. Consumers MAY use it to
            # detect gaps (a missing number signals a lost event) and reorder
            # events that arrive out of order. It is a hint, not a strict-order
            # or exactly-once guarantee.
            "X-TruePPM-Webhook-Sequence": str(delivery.sequence_number),
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # nosec B310 — URL originates from admin-configured Webhook.url (URLField), not user-supplied input
            status_code = resp.status
    except urllib.error.HTTPError as exc:
        status_code = exc.code
    except (urllib.error.URLError, OSError) as exc:
        # Network error — retry.
        logger.warning(
            "deliver_webhook: delivery %s network error: %s (attempt %d/%d)",
            delivery.pk,
            exc,
            delivery.attempt_count,
            _MAX_RETRIES,
        )
        delivery.save(update_fields=["attempt_count"])
        if delivery.attempt_count >= _MAX_RETRIES:
            delivery.status = DeliveryStatus.FAILED
            delivery.completed_at = timezone.now()
            delivery.save(update_fields=["status", "completed_at"])
            return
        raise self.retry(  # type: ignore[attr-defined]
            countdown=_BACKOFF_BASE * (2 ** (delivery.attempt_count - 1)),
        ) from None

    delivery.response_status = status_code

    if 200 <= status_code < 300:
        delivery.status = DeliveryStatus.SUCCESS
        delivery.completed_at = timezone.now()
        delivery.save(update_fields=["status", "response_status", "attempt_count", "completed_at"])
        return

    # Non-2xx: retry if attempts remain.
    logger.warning(
        "deliver_webhook: delivery %s got HTTP %d from %s (attempt %d/%d)",
        delivery.pk,
        status_code,
        webhook.url,
        delivery.attempt_count,
        _MAX_RETRIES,
    )
    delivery.save(update_fields=["response_status", "attempt_count"])

    if delivery.attempt_count >= _MAX_RETRIES:
        delivery.status = DeliveryStatus.FAILED
        delivery.completed_at = timezone.now()
        delivery.save(update_fields=["status", "completed_at"])
        return

    raise self.retry(  # type: ignore[attr-defined]
        countdown=_BACKOFF_BASE * (2 ** (delivery.attempt_count - 1)),
    )


# ---------------------------------------------------------------------------
# Webhook delivery drain
# ---------------------------------------------------------------------------


def _do_drain_webhooks() -> None:
    """Dispatch any WebhookDelivery rows that were never enqueued.

    A delivery row is considered stranded when:
      - status is PENDING  (not yet successfully delivered or failed)
      - attempt_count == 0 (the .delay() call after creation was lost)
      - created_at is older than _DRAIN_ORPHAN_MINUTES

    Deliveries with attempt_count > 0 are inside Celery's built-in retry
    chain and must not be re-dispatched here.
    """
    from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

    cutoff = timezone.now() - timedelta(minutes=_DRAIN_ORPHAN_MINUTES)
    stranded = list(
        WebhookDelivery.objects.filter(
            status=DeliveryStatus.PENDING,
            attempt_count=0,
            created_at__lt=cutoff,
        ).select_related("webhook")
    )

    for delivery in stranded:
        if not delivery.webhook.is_active:
            delivery.status = DeliveryStatus.FAILED
            delivery.completed_at = timezone.now()
            delivery.save(update_fields=["status", "completed_at"])
            logger.info(
                "_do_drain_webhooks: marked delivery %s failed — webhook inactive",
                delivery.pk,
            )
            continue

        try:
            deliver_webhook.delay(str(delivery.pk))
            logger.info(
                "_do_drain_webhooks: re-dispatched stranded delivery %s",
                delivery.pk,
            )
        except Exception:
            logger.warning(
                "_do_drain_webhooks: broker unavailable — delivery %s stays pending",
                delivery.pk,
            )


@idempotent_task(
    lock_key_template="drain_webhook_queue",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="webhooks.drain_webhook_queue",
)
def drain_webhook_queue(self: object) -> None:
    """Beat task: drain stranded PENDING webhook deliveries every 30 seconds."""
    _do_drain_webhooks()


# ---------------------------------------------------------------------------
# Webhook delivery retention purge (ADR-0081)
# ---------------------------------------------------------------------------


def _do_webhook_purge() -> None:
    """Business logic for purge_old_deliveries — extracted for testability.

    Deletes only terminal (SUCCESS/FAILED) deliveries: PENDING rows may still be
    re-dispatched by the drain, so they are never purged regardless of age. A
    retention of None disables the purge entirely (unbounded retention).
    """
    from django.conf import settings
    from django.utils import timezone

    from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

    retention_days = settings.TRUEPPM_WEBHOOK_RETENTION_DAYS
    if retention_days is None:
        return

    cutoff = timezone.now() - timedelta(days=retention_days)
    deleted, _ = WebhookDelivery.objects.filter(
        status__in=[DeliveryStatus.SUCCESS, DeliveryStatus.FAILED],
        created_at__lt=cutoff,
    ).delete()
    logger.info("purge_old_deliveries: deleted %d row(s)", deleted)


@idempotent_task(
    lock_key_template="purge_old_deliveries",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="webhooks.purge_old_deliveries",
)
def purge_old_deliveries(self: object) -> None:
    """Delete terminal WebhookDelivery rows older than the retention window.

    Runs nightly via Celery Beat. Keeps the delivery table small so the
    (status, created_at) index scans in the drain stay fast on high-traffic boards.
    """
    _do_webhook_purge()
