"""Celery tasks for outbound webhook delivery."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import urllib.error
import urllib.request

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)

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
