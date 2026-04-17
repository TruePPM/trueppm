"""Webhook dispatch helper — called from transaction.on_commit callbacks."""

from __future__ import annotations

import logging
from typing import Any

import redis as redis_lib
from kombu.exceptions import (  # type: ignore[import-untyped]
    OperationalError as KombuOperationalError,
)

logger = logging.getLogger(__name__)

# Transient broker/connection errors that must not bubble out of dispatch —
# the delivery row stays PENDING and drain_webhook_queue retries it.  Narrow
# on purpose so serialization or programming bugs are not silently swallowed.
_BROKER_ERRORS = (KombuOperationalError, ConnectionError, redis_lib.ConnectionError)


def dispatch_webhooks(project_id: str, event_type: str, payload: dict[str, Any]) -> None:
    """Query matching active webhooks and enqueue a delivery task for each.

    This function MUST be called inside a ``transaction.on_commit`` callback
    (same as ``broadcast_board_event``) so that delivery is never enqueued
    for a rolled-back mutation.
    """
    from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery
    from trueppm_api.apps.webhooks.tasks import deliver_webhook

    webhooks = Webhook.objects.filter(
        project_id=project_id,
        is_active=True,
        events__contains=[event_type],
    )

    for webhook in webhooks:
        delivery = WebhookDelivery.objects.create(
            webhook=webhook,
            event_type=event_type,
            payload=payload,
        )
        try:
            deliver_webhook.delay(str(delivery.pk))
            logger.debug(
                "dispatch_webhooks: enqueued delivery %s for webhook %s (%s)",
                delivery.pk,
                webhook.pk,
                event_type,
            )
        except _BROKER_ERRORS:
            # Broker unavailable — delivery row stays PENDING with attempt_count=0
            # so drain_webhook_queue picks it up within _DRAIN_ORPHAN_MINUTES.
            logger.warning(
                "dispatch_webhooks: broker unavailable — delivery %s will be drained",
                delivery.pk,
            )
