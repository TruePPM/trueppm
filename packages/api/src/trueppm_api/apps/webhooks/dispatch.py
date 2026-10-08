"""Webhook dispatch helper — called from transaction.on_commit callbacks."""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import redis as redis_lib
from kombu.exceptions import (  # type: ignore[import-untyped]
    OperationalError as KombuOperationalError,
)

logger = logging.getLogger(__name__)

# Transient broker/connection errors that must not bubble out of dispatch —
# the delivery row stays PENDING and drain_webhook_queue retries it.  Narrow
# on purpose so serialization or programming bugs are not silently swallowed.
_BROKER_ERRORS = (KombuOperationalError, ConnectionError, redis_lib.ConnectionError)


def build_delivery_body(
    webhook: Any,
    event_type: str,
    payload: dict[str, Any],
    sequence: int,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Render ``payload`` for ``webhook``'s format and add the ``_meta`` envelope.

    The single place a delivery body is constructed. It exists because the
    "Send test" action used to build its ping inline as
    ``{"event": "ping", "webhook_id": ...}`` — skipping the renderer entirely and
    omitting ``_meta`` — while the real dispatch path did both (#2884). A
    ``slack``-format subscription (the modal's default) therefore rejected the test
    body with 400 ``invalid_payload``, so the admin's only diagnostic tool reported
    success on a guaranteed failure, and the ping still consumed a sequence number
    with no ``_meta.sequence`` to match, breaking the documented "always identical"
    invariant and firing phantom gap alarms on every Test click.

    Args:
        webhook: The subscription being delivered to (supplies ``format``).
        event_type: The event type, including the reserved ``ping``.
        payload: The domain payload to render.
        sequence: The already-allocated per-subscription sequence number. Passed in
            rather than allocated here because ``render()`` runs before the delivery
            row exists, and the stored row must equal the wire body (ADR-0083).
        project_id: Project the event belongs to, when known. Falls back to the
            webhook's own project so a program-scoped ping still carries a scope.

    Returns:
        The exact dict to persist as ``WebhookDelivery.payload`` and POST verbatim.
    """
    from trueppm_api.apps.integrations.registry import (
        OUTGOING_CHANNEL_PROVIDERS,
        OutgoingChannelEvent,
    )

    scope_id = project_id or (str(webhook.project_id) if webhook.project_id else "")
    event = OutgoingChannelEvent(event_type=event_type, project_id=scope_id, payload=payload)
    # An un-registered format (e.g. an Enterprise provider after a downgrade)
    # degrades to the raw payload rather than 500ing — matches
    # ProviderRegistry.get() returning None by design.
    provider_cls = OUTGOING_CHANNEL_PROVIDERS.get(webhook.format)
    rendered = provider_cls().render(event) if provider_cls is not None else payload
    # ``_meta`` is a reserved top-level namespace (ADR-0089): the generic body is a
    # flat domain dict, so a bare ``sequence`` key could collide with a future event
    # field, and Slack ignores an unknown ``_meta`` key — one uniform rule covers
    # every format. A fresh dict so the shared rendered/payload object is never
    # mutated across the fan-out.
    return {**rendered, "_meta": {"sequence": sequence}}


def _drop_webhooks_without_live_member_owner(webhooks: list[Any], project_id: str) -> list[Any]:
    """Keep a webhook only when its registrant is a live Admin+ member of the firing project.

    Originally written for program-scoped webhooks (#4310): a program-scoped
    webhook fires for events on every member project, but the program grant is
    not a read grant on the project, so its registrant must hold live
    ``ProjectMembership`` on the project the event came from. #4325 extends the
    identical check to project-scoped webhooks — the ADR-0161 amendment's "project-
    scoped webhooks are unchanged" reasoning was never actually true for a
    project-scoped webhook's own registrant losing membership on that very
    project, only for the cross-project *program* grant the amendment was about.
    A project-scoped webhook's only possible firing project is the one it is
    scoped to, so the same ``project_id`` the caller passes in is also the right
    membership check for it — no separate query shape needed.

    #4330 adds a role floor on top of that same ``ProjectMembership`` row:
    membership alone (any role) used to be enough to keep receiving events, but
    the delivery-log read endpoint (``ProjectWebhookViewSet.get_permissions``)
    has always been Admin-only — payloads are documented information disclosure
    beyond plain project membership (#903). A registrant demoted to Viewer or
    Member (not removed) kept receiving the same payloads via dispatch that they
    could no longer read back through the delivery log, which is the gap #4330
    closes: dispatch now requires ``role >= Role.ADMIN`` on that live
    membership, matching ``IsProjectAdmin`` (the project-scoped read gate)
    exactly so the two cannot drift again.

    This project-role check runs identically for program-scoped webhooks,
    because the membership source here is always the firing project, never the
    program — a program grant was never a project-read grant (#4310), so a
    program-scoped registrant has always needed live membership on the
    specific member project an event comes from, in addition to (not instead
    of) the program-level check in
    ``_drop_program_webhooks_without_live_program_admin_owner`` below, which
    #4330 also adds to close the matching gap on the *program* axis.

    Membership is read here, at dispatch time, so a removed member, or one
    demoted below Admin, stops receiving events on the next write rather than
    when the subscription is edited.

    Fails closed: a webhook whose ``created_by`` is NULL (the registrant was
    deleted — ``SET_NULL``) or whose registrant is deactivated is dropped.

    One membership query per event, not per webhook: all distinct registrants
    of the candidate webhooks (project- and program-scoped alike) are resolved
    together against ``project_id``.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role

    owner_ids = {w.created_by_id for w in webhooks if w.created_by_id}
    if not owner_ids:
        live_owners: set[Any] = set()
    else:
        live_owners = set(
            ProjectMembership.live()
            .filter(
                project_id=project_id,
                user_id__in=owner_ids,
                user__is_active=True,
                role__gte=Role.ADMIN,
            )
            .values_list("user_id", flat=True)
        )
    return [w for w in webhooks if w.created_by_id in live_owners]


def _drop_program_webhooks_without_live_program_admin_owner(
    webhooks: list[Any], program_id: UUID | None
) -> list[Any]:
    """Keep a program-scoped webhook only when its registrant also holds a live
    Admin+ ``ProgramMembership`` on the program itself (#4330).

    ``_drop_webhooks_without_live_member_owner`` above gates every webhook,
    project- and program-scoped alike, on the registrant's role on the FIRING
    PROJECT — necessary because a program grant was never a project-read grant
    (#4310). But the program-scoped delivery-log read gate
    (``ProgramWebhookViewSet._check_delivery_log_access`` plus ``IsProgramAdmin``
    in ``get_permissions``) is keyed on the registrant's *program* role, not
    their project role: it requires them to still be the webhook's creator AND
    still hold Program Admin+ on the program. Without this second check, a
    creator demoted to Program Viewer — while remaining Project Admin on the
    firing project, which is all the function above verifies — would keep
    receiving full program-webhook payloads via dispatch that the read gate
    would already refuse them, the same class of gap #4330 closed on the
    project axis. A program-scoped webhook's dispatch eligibility is therefore
    the AND of both functions, not a replacement of one by the other: the
    project-role check is still required (a program grant alone has never been
    a project-read grant), and this program-role check is now required too.

    Project-scoped webhooks (``program_id`` is ``None`` on the webhook row) are
    untouched — they pass straight through regardless of this project's
    resolved ``program_id``.

    One membership query per event, not per webhook, and skipped entirely
    (zero extra queries) whenever no program-scoped webhook survives the
    project-role filter — the common case for a project with no program, or
    whose program-scoped webhooks already failed that first check. All
    program-scoped candidates in a single ``dispatch_webhooks`` call share the
    same ``program_id`` (the queryset that builds ``webhooks`` filters on
    exactly one project's resolved program), so one lookup against that single
    ``program_id`` resolves every program-scoped registrant together.
    """
    from trueppm_api.apps.access.models import ProgramMembership, Role

    program_webhooks = [w for w in webhooks if w.program_id is not None]
    if not program_webhooks or program_id is None:
        return webhooks

    owner_ids = {w.created_by_id for w in program_webhooks if w.created_by_id}
    if not owner_ids:
        live_program_admins: set[Any] = set()
    else:
        live_program_admins = set(
            ProgramMembership.live()
            .filter(
                program_id=program_id,
                user_id__in=owner_ids,
                user__is_active=True,
                role__gte=Role.ADMIN,
            )
            .values_list("user_id", flat=True)
        )
    return [w for w in webhooks if w.program_id is None or w.created_by_id in live_program_admins]


def dispatch_webhooks(project_id: str, event_type: str, payload: dict[str, Any]) -> None:
    """Query matching active webhooks and enqueue a delivery task for each.

    This function MUST be called inside a ``transaction.on_commit`` callback
    (same as ``broadcast_board_event``) so that delivery is never enqueued
    for a rolled-back mutation.

    Fans out to BOTH project-scoped webhooks (events on this project) and
    program-scoped webhooks (events on any project within the program that
    owns this project) per ADR-0076. The two queries are combined with a
    single ``Q`` union so the database performs the OR in one round-trip.
    Either scope is then dropped if its registrant lacks a live Admin+
    membership on this project (#4310, #4325, #4330) — see
    ``_drop_webhooks_without_live_member_owner``. A program-scoped webhook is
    further dropped if its registrant also lacks a live Admin+ membership on
    the program itself (#4330) — see
    ``_drop_program_webhooks_without_live_program_admin_owner``.
    """
    from django.db.models import Q

    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.webhooks.models import (
        Webhook,
        WebhookDelivery,
        _next_delivery_sequence,
    )
    from trueppm_api.apps.webhooks.tasks import deliver_webhook

    # Resolve the project's program (if any) so program-scoped webhooks fire
    # for events on any of the program's projects. One extra SELECT for the
    # program FK; cached by Django's queryset evaluation.
    program_id = Project.objects.filter(pk=project_id).values_list("program_id", flat=True).first()

    scope_filter = Q(project_id=project_id)
    if program_id is not None:
        scope_filter |= Q(program_id=program_id)

    webhooks = list(
        Webhook.objects.filter(
            scope_filter,
            is_active=True,
            events__contains=[event_type],
        )
    )
    webhooks = _drop_webhooks_without_live_member_owner(webhooks, project_id)
    webhooks = _drop_program_webhooks_without_live_program_admin_owner(webhooks, program_id)

    for webhook in webhooks:
        # Render per-webhook: each subscription may have a different format
        # (one project can have a Slack webhook and a generic JSON webhook on
        # the same event). The rendered dict is frozen onto the delivery row,
        # so deliver_webhook posts it verbatim and the row is the audit record
        # of exactly what was sent.
        #
        # render() runs before the row exists, so we pre-allocate the sequence
        # number (#664) and pass it to create() as both the body value and
        # ``sequence_number`` — WebhookDelivery.save()'s lazy-allocation guard then
        # no-ops, keeping this a single write where the stored row equals the wire
        # body (ADR-0083 audit invariant).
        sequence = _next_delivery_sequence(webhook.id)
        body = build_delivery_body(webhook, event_type, payload, sequence, str(project_id))
        delivery = WebhookDelivery.objects.create(
            webhook=webhook,
            event_type=event_type,
            payload=body,
            sequence_number=sequence,
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
