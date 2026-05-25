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

    Fans out to BOTH project-scoped webhooks (events on this project) and
    program-scoped webhooks (events on any project within the program that
    owns this project) per ADR-0076. The two queries are combined with a
    single ``Q`` union so the database performs the OR in one round-trip.
    """
    from django.db.models import Q

    from trueppm_api.apps.integrations.registry import (
        OUTGOING_CHANNEL_PROVIDERS,
        OutgoingChannelEvent,
    )
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery
    from trueppm_api.apps.webhooks.tasks import deliver_webhook

    # Resolve the project's program (if any) so program-scoped webhooks fire
    # for events on any of the program's projects. One extra SELECT for the
    # program FK; cached by Django's queryset evaluation.
    program_id = Project.objects.filter(pk=project_id).values_list("program_id", flat=True).first()

    scope_filter = Q(project_id=project_id)
    if program_id is not None:
        scope_filter |= Q(program_id=program_id)

    webhooks = Webhook.objects.filter(
        scope_filter,
        is_active=True,
        events__contains=[event_type],
    )

    event = OutgoingChannelEvent(event_type=event_type, project_id=str(project_id), payload=payload)

    for webhook in webhooks:
        # Render per-webhook: each subscription may have a different format
        # (one project can have a Slack webhook and a generic JSON webhook on
        # the same event). The rendered dict is frozen onto the delivery row,
        # so deliver_webhook posts it verbatim and the row is the audit record
        # of exactly what was sent. An un-registered format (e.g. an Enterprise
        # provider after a downgrade) degrades to the raw payload rather than
        # 500ing — matches ProviderRegistry.get() returning None by design.
        provider_cls = OUTGOING_CHANNEL_PROVIDERS.get(webhook.format)
        rendered = provider_cls().render(event) if provider_cls is not None else payload
        delivery = WebhookDelivery.objects.create(
            webhook=webhook,
            event_type=event_type,
            payload=rendered,
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
