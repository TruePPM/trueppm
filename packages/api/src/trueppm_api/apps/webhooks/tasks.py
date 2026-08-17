"""Celery tasks for outbound webhook delivery."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import urllib.error
import urllib.request
from datetime import timedelta
from typing import TYPE_CHECKING

from celery import shared_task
from django.utils import timezone

if TYPE_CHECKING:  # pragma: no cover — import cycle: models imports nothing here
    from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery

from trueppm_api.apps.integrations.encryption import CredentialEncryptionError
from trueppm_api.apps.integrations.http import (
    EgressBlocked,
    EgressError,
    NoRedirectHandler,
    assert_url_allowed,
)
from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# Deliveries created more than this many minutes ago with attempt_count == 0
# are considered stranded (the .delay() call was lost) and re-dispatched by the
# drain.  Deliveries created *within* the window are left alone — they may still
# be inside a transaction.on_commit() pipeline.
_DRAIN_ORPHAN_MINUTES = 5

# Exponential backoff. The countdown is 30 * 2**(attempt_count - 1), and a
# delivery is terminal once attempt_count reaches _MAX_RETRIES — so only FOUR
# countdowns are ever scheduled (30, 60, 120, 240) and the five attempts execute at
# t = 0, 30, 90, 210, 450 seconds. Total span 450s (7.5 min), not the 15.5 min the
# full 30/60/120/240/480 sequence would imply: the 480s step is unreachable because
# the attempt it would delay is the one that fails terminally instead.
_MAX_RETRIES = 5
_BACKOFF_BASE = 30

# Redirect-disabled opener (#808). The default urllib opener follows 3xx
# responses to arbitrary destinations, which would let a malicious receiver
# bounce a signed webhook payload at a private/loopback/cloud-metadata host
# *after* assert_url_allowed has validated the original URL. We share the same
# no-redirect handler used by the integrations SSRF chokepoint so the guard is
# implemented once.
_no_redirect_opener = urllib.request.build_opener(NoRedirectHandler)

# 4xx statuses that are nonetheless worth retrying (#2884). Everything else in
# the 4xx range is a *permanent* client error — the request itself is wrong, so
# replaying it byte-for-byte cannot succeed. Before this split, a revoked Slack
# incoming webhook answering 404/410 burned five attempts over ~7.5 minutes for
# every matching event, forever, with no state change on the subscription.
#   408 Request Timeout / 425 Too Early — the receiver is asking for a retry.
#   429 Too Many Requests — rate limited; the backoff is exactly the remedy.
_RETRYABLE_4XX = frozenset({408, 425, 429})

# Clock skew tolerance we recommend consumers apply to X-TruePPM-Signature-V2's
# timestamp (ADR-0837). Documented here because the value only has meaning as a
# pair with the retry backoff below: the signature is recomputed on *every*
# attempt, so the fifth and final attempt — 450s (7.5 min) after the first, well
# outside this window — still carries a fresh timestamp and is never stale.
SIGNATURE_TOLERANCE_SECONDS = 300


class WebhookDeliveryFailed(Exception):
    """A webhook delivery reached a terminal failure and will not be retried.

    Carried into ``record_failed_task`` so the delivery shows up in the
    dead-letter queue with a readable cause. Never raised out of the task — the
    delivery row, not an exception, is the record of what happened.
    """


def _is_permanent_http_status(status_code: int) -> bool:
    """Whether ``status_code`` means "do not retry this delivery" (#2884)."""
    return 400 <= status_code < 500 and status_code not in _RETRYABLE_4XX


def _sign(secret: str, body: bytes, timestamp: str) -> tuple[str, str]:
    """Return the (legacy, timestamped) signature values for one delivery.

    Two signatures are emitted during the deprecation window (ADR-0837):

    - **legacy** — ``HMAC-SHA256(secret, body)``, the recipe published since 0.1
      and carried in ``X-TruePPM-Signature`` as ``sha256=<hex>``. It has no
      timestamp, so a captured delivery verifies forever; a receiver that stores
      seen ``X-TruePPM-Delivery`` ids is protected against duplicate *processing*
      but cannot *detect* a replay.
    - **timestamped** — ``HMAC-SHA256(secret, "<unix>.<body>")``, carried in
      ``X-TruePPM-Signature-V2`` as ``t=<unix>,v1=<hex>``. Binding the timestamp
      into the signed material is what makes it unforgeable: an attacker replaying
      a captured body cannot move the timestamp forward without the secret, so a
      consumer rejecting timestamps outside ``SIGNATURE_TOLERANCE_SECONDS`` bounds
      the replay window. ``v1`` names the HMAC scheme *inside* the header (Stripe's
      convention, which integrators recognize); the recipe version is the header
      name.
    """
    key = secret.encode("utf-8")
    legacy = hmac.new(key, body, hashlib.sha256).hexdigest()
    timestamped = hmac.new(
        key,
        timestamp.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return legacy, timestamped


def _dead_letter_delivery(
    task: object,
    delivery_id: str,
    project_id: str | None,
    reason: str,
) -> None:
    """Park a terminally-failed webhook delivery in the dead-letter queue (#2884).

    Every terminal branch below marks the delivery FAILED and *returns* — the task
    never raises, deliberately, because a raise would put Celery's retry machinery
    back in charge of something we have already decided not to retry. But
    dead-letter recording keys on Celery permanent failure, so before this existed
    ``trueppm_task_dead_letter_parked`` stayed at zero no matter how many
    deliveries died: no metric, no ``dead-letter alert:`` log line, and the only
    evidence purged after 7 days.

    Calling ``record_failed_task`` directly gives the FAILED state a real consumer
    — a ``FailedTask`` row, the ``celery_task_permanently_failed`` extension signal
    (so the OSS alert receiver logs and Enterprise's PagerDuty receiver fires), and
    the health-endpoint counter — without pretending the task crashed.

    The ``task_id`` falls back to a delivery-derived key when there is no live
    Celery request (the drain and the test suite call the task synchronously), so
    repeated failures of the same delivery bump ``failure_count`` on one row rather
    than flooding the queue.

    ``task_name`` and ``args`` are a **replay record, not display metadata**: the
    dead-letter admin's requeue action feeds them straight to
    ``current_app.send_task(failed.task_name, args=..., kwargs=...)``. So
    ``task_name`` must be the *registered* name — ``deliver_webhook.name``, read off
    the task rather than written out, because this module's other two tasks declare
    an explicit short ``name=`` and this one does not — and ``args``/``kwargs`` must
    bind to ``deliver_webhook.run(delivery_id)``. Getting either wrong makes a
    requeue a silent no-op (``NotRegistered``, message dropped) or a worker-side
    ``TypeError`` while the endpoint answers 200 and stamps the row ``RETRIED`` —
    which is the same "the diagnostic tool reports success on a guaranteed failure"
    shape #2884 exists to remove. The webhook id therefore travels in ``reason``,
    not as an invented kwarg.
    """
    from trueppm_api.apps.scheduling.deadletter import record_failed_task

    request = getattr(task, "request", None)
    task_id = getattr(request, "id", None) or f"webhook-delivery-{delivery_id}"
    try:
        record_failed_task(
            task_name=deliver_webhook.name,
            task_id=str(task_id),
            args=[delivery_id],
            kwargs={},
            exception=WebhookDeliveryFailed(reason),
            project_id=project_id,
        )
    except Exception:
        # Dead-letter recording is observability, not delivery: a failure here
        # must never mask the delivery outcome we just persisted.
        logger.exception("deliver_webhook: could not dead-letter delivery %s", delivery_id)


def _fail_delivery(
    task: object,
    delivery: WebhookDelivery,
    webhook: Webhook,
    *,
    reason: str,
    operator_reason: str = "",
    extra_fields: tuple[str, ...] = (),
    count_against_guard: bool = True,
) -> None:
    """Mark a delivery terminally failed and run every consequence of that (#2884).

    One helper for all six terminal branches (SSRF block, unusable signing secret,
    unresolvable host with retries exhausted, network error with retries exhausted,
    permanent 4xx, non-2xx with retries exhausted) so none of them can drift out of
    sync with the others — which is exactly how the dead-letter gap arose.

    ``count_against_guard=False`` still records and parks the failure but keeps it
    out of the consecutive-failure counter. Two branches use it, for the same
    reason: the counter is meant to measure *the receiver's* health under production
    traffic, and neither of those failures is evidence of that.

    ``reason`` lands in ``Webhook.last_failure_reason``, which is readable at
    **Viewer** level, so it must stay free of deployment detail. ``operator_reason``
    overrides it for the dead-letter record only — the Admin/operator surface — the
    same split ``validate_url`` already makes between its curated 400 message and its
    server-side log line.
    """
    from trueppm_api.apps.webhooks.models import PING_EVENT_TYPE, DeliveryStatus

    delivery.status = DeliveryStatus.FAILED
    delivery.completed_at = timezone.now()
    delivery.save(update_fields=[*extra_fields, "status", "completed_at"])

    # A test ping is a human probe, not production traffic. Counting it made the
    # admin's own debugging loop the trip wire: five clicks on Test against a broken
    # receiver deactivated the subscription, which is the opposite of what a
    # diagnostic tool should do.
    is_probe = delivery.event_type == PING_EVENT_TYPE
    auto_disabled = False
    if count_against_guard and not is_probe:
        auto_disabled = webhook.record_delivery_failure(reason)

    if auto_disabled:
        logger.warning(
            "deliver_webhook: webhook %s auto-deactivated after %d consecutive "
            "failed deliveries (%s)",
            webhook.pk,
            webhook.consecutive_failures,
            reason,
        )

    # The deactivation is folded into the dead-letter reason rather than only logged.
    # Once a subscription is inactive the `not is_active` branch above deliberately
    # stops parking its deliveries, so the dead-letter stream — the only push signal
    # an operator has — goes quiet at exactly the moment the integration dies. That
    # silence needs an explanation, and this record is the last one before it: it is
    # what makes "the alerts stopped" readable as "we gave up on this webhook"
    # rather than as "the receiver recovered".
    dead_letter_reason = f"webhook {webhook.pk}: {operator_reason or reason}"
    if auto_disabled:
        dead_letter_reason += (
            " — SUBSCRIPTION DEACTIVATED; no further deliveries will be attempted "
            "or reported until an admin re-enables it"
        )
    _dead_letter_delivery(
        task,
        str(delivery.pk),
        str(webhook.project_id) if webhook.project_id else None,
        dead_letter_reason,
    )


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
    """POST a webhook payload to the registered URL with HMAC-SHA256 signatures.

    Retries with exponential backoff on network errors, 5xx responses, and the
    retryable 4xx set. A *permanent* 4xx is not retried (#2884). Every terminal
    outcome marks the delivery failed, counts against the subscription's
    consecutive-failure guard, and is parked in the dead-letter queue.
    """
    from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

    try:
        delivery = WebhookDelivery.objects.select_related("webhook").get(pk=delivery_id)
    except WebhookDelivery.DoesNotExist:
        logger.warning("deliver_webhook: delivery %s not found, skipping", delivery_id)
        return

    webhook = delivery.webhook
    if not webhook.is_active:
        # Not counted against the failure guard and not dead-lettered: an inactive
        # subscription is a *deliberate* state (an admin paused it, or the guard
        # already gave up on it), so re-parking every skipped delivery would bury
        # the genuine failures under noise from a webhook nobody expects to fire.
        logger.info("deliver_webhook: webhook %s is inactive, skipping", webhook.pk)
        delivery.status = DeliveryStatus.FAILED
        delivery.completed_at = timezone.now()
        delivery.save(update_fields=["status", "completed_at"])
        return

    body = json.dumps(delivery.payload, default=str, sort_keys=True).encode("utf-8")

    # An unusable secret has two shapes and BOTH must be terminal here.
    #
    # Empty ciphertext is unreachable through the API (the serializer requires or
    # generates a secret) but possible for a row whose backfill left it blank.
    # Undecryptable ciphertext is the likelier one: it is what a database restored
    # without its INTEGRATION_ENCRYPTION_KEY, or a key rotated without the matching
    # re-encrypt, produces — and ``secret_ciphertext`` tests non-empty, so
    # ``secret_set`` still reports True.
    #
    # Letting the decryption error propagate would be the worst available outcome:
    # it escapes before ``attempt_count`` is incremented, so the row keeps
    # (PENDING, attempt_count=0) — exactly the selector ``_do_drain_webhooks`` uses
    # — and the drain re-dispatches it every 30 seconds forever. The purge only
    # reclaims terminal rows, the failure guard never counts it, and the API keeps
    # reporting the subscription healthy. Signing with an empty key is no better: a
    # receiver would either skip verification or trust ``b""``.
    try:
        secret = webhook.secret
    except CredentialEncryptionError:
        logger.exception("deliver_webhook: webhook %s signing secret is undecryptable", webhook.pk)
        secret = ""
        # Curated, deliberately vague. `last_failure_reason` is readable at Viewer
        # level, and "your INTEGRATION_ENCRYPTION_KEY changed" is a deployment-level
        # diagnostic — the same reasoning that put the delivery log behind Admin
        # (#903). The operator detail is in the logger.exception above and in the
        # dead-letter record; the Viewer-visible field says only that it is broken.
        secret_error = "Signing secret is unusable — contact an administrator"
        secret_operator_error = (
            "Signing secret could not be decrypted — INTEGRATION_ENCRYPTION_KEY has "
            "changed since this webhook was registered"
        )
    else:
        secret_error = "" if secret else "No signing secret is stored for this webhook"
        secret_operator_error = ""

    if secret_error:
        delivery.attempt_count += 1
        _fail_delivery(
            self,
            delivery,
            webhook,
            reason=secret_error,
            operator_reason=secret_operator_error,
            extra_fields=("attempt_count",),
        )
        return

    # Recomputed on every attempt, not once per delivery: the final attempt lands
    # 450s after the first, so a timestamp fixed at first-attempt time would put it
    # outside the recommended 300s tolerance and a consumer would reject a
    # legitimate redelivery as stale.
    timestamp = str(int(timezone.now().timestamp()))
    signature, timestamped_signature = _sign(secret, body, timestamp)

    delivery.attempt_count += 1

    # SSRF guard (ADR-0049 §3): Webhook.url is configured by a project admin —
    # an RBAC role, not an infra operator — so outbound delivery is untrusted
    # egress. Re-resolve and reject private / loopback / link-local targets at
    # delivery time (not only at registration) to close the DNS-rebinding
    # window, reusing the same chokepoint as the integrations PAT / git-link
    # calls. Without this, an admin could point a webhook at 169.254.169.254
    # (cloud metadata) or an RFC1918 cluster service.
    try:
        assert_url_allowed(webhook.url)
    except EgressBlocked as exc:
        # Permanent: a private/loopback/bad-scheme URL will never be deliverable.
        logger.warning(
            "deliver_webhook: delivery %s blocked by SSRF guard: %s",
            delivery.pk,
            exc,
        )
        _fail_delivery(
            self,
            delivery,
            webhook,
            reason="Blocked by the SSRF egress guard (URL resolves to a "
            "private, loopback, or link-local address)",
            extra_fields=("attempt_count",),
            # Kept out of the auto-disable counter: assert_url_allowed re-resolves
            # DNS on every delivery, so anyone with influence over how the receiver's
            # hostname resolves — a dynamic-DNS receiver, a poisoned resolver, a
            # momentary RFC1918 answer — could otherwise deactivate an admin's
            # integration in five resolution windows. The block itself still stands
            # (the delivery is refused and parked); it just is not evidence about the
            # receiver's health.
            count_against_guard=False,
        )
        return
    except EgressError as exc:
        # Host did not resolve — transient, treated like any network error: retry.
        logger.warning(
            "deliver_webhook: delivery %s SSRF pre-check could not resolve host: %s "
            "(attempt %d/%d)",
            delivery.pk,
            exc,
            delivery.attempt_count,
            _MAX_RETRIES,
        )
        if delivery.attempt_count >= _MAX_RETRIES:
            _fail_delivery(
                self,
                delivery,
                webhook,
                reason=f"Host did not resolve after {_MAX_RETRIES} attempts",
                extra_fields=("attempt_count",),
            )
            return
        delivery.save(update_fields=["attempt_count"])
        raise self.retry(  # type: ignore[attr-defined]
            countdown=_BACKOFF_BASE * (2 ** (delivery.attempt_count - 1)),
        ) from None

    req = urllib.request.Request(
        webhook.url,
        data=body,
        headers={
            "Content-Type": "application/json",
            # Legacy body-only signature (ADR-0837). Still emitted through the
            # deprecation window so every receiver implementing the 0.1–0.3
            # published recipe keeps verifying without a code change.
            "X-TruePPM-Signature": f"sha256={signature}",
            # Timestamped signature — the recipe 0.4 freezes. `t` is bound into
            # the signed material, so it cannot be moved by a replaying attacker.
            #
            # The timestamp is deliberately NOT also broken out into a standalone
            # header. A convenience copy would be unauthenticated, and a consumer
            # bounding its replay window on it gains nothing: an attacker replaying
            # a capture edits that one header to "now", the freshness check passes,
            # and the HMAC still verifies over the original `t` inside this header.
            # The whole protection would be voided by a one-header edit, so the only
            # timestamp we publish is the signed one (ADR-0837).
            "X-TruePPM-Signature-V2": f"t={timestamp},v1={timestamped_signature}",
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
        # Redirect-disabled opener (#808): a webhook receiver returning
        # 302/307 Location: http://169.254.169.254/... (cloud metadata) or an
        # RFC1918 host would otherwise be re-fetched *without* re-running the
        # SSRF guard, with the original signed payload preserved on a 307/308.
        # NoRedirectHandler surfaces the 3xx as-is so callers see it and retry
        # via the existing non-2xx path.
        with _no_redirect_opener.open(req, timeout=10) as resp:  # nosec B310 — URL passed the assert_url_allowed() SSRF guard above (ADR-0049 §3); redirects disabled
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
        if delivery.attempt_count >= _MAX_RETRIES:
            _fail_delivery(
                self,
                delivery,
                webhook,
                reason=f"Network error after {_MAX_RETRIES} attempts: {type(exc).__name__}",
                extra_fields=("attempt_count",),
            )
            return
        delivery.save(update_fields=["attempt_count"])
        raise self.retry(  # type: ignore[attr-defined]
            countdown=_BACKOFF_BASE * (2 ** (delivery.attempt_count - 1)),
        ) from None

    delivery.response_status = status_code

    if 200 <= status_code < 300:
        delivery.status = DeliveryStatus.SUCCESS
        delivery.completed_at = timezone.now()
        delivery.save(update_fields=["status", "response_status", "attempt_count", "completed_at"])
        # Clears the consecutive-failure counter, so a receiver that recovers
        # inside the guard's threshold never gets auto-deactivated.
        webhook.record_delivery_success()
        return

    if _is_permanent_http_status(status_code):
        # Permanent client error: the receiver rejected the request itself, so
        # replaying identical bytes cannot succeed (#2884). One attempt, then
        # terminal — this is where the "revoked receiver answers 410 and we retry
        # it forever" loop is cut.
        logger.warning(
            "deliver_webhook: delivery %s got permanent HTTP %d from %s — not retrying",
            delivery.pk,
            status_code,
            webhook.url,
        )
        _fail_delivery(
            self,
            delivery,
            webhook,
            reason=f"Permanent client error HTTP {status_code} — not retried",
            extra_fields=("response_status", "attempt_count"),
        )
        return

    # Retryable non-2xx (5xx, 408/425/429, or a 3xx the no-redirect opener
    # surfaced): retry if attempts remain.
    logger.warning(
        "deliver_webhook: delivery %s got HTTP %d from %s (attempt %d/%d)",
        delivery.pk,
        status_code,
        webhook.url,
        delivery.attempt_count,
        _MAX_RETRIES,
    )

    if delivery.attempt_count >= _MAX_RETRIES:
        _fail_delivery(
            self,
            delivery,
            webhook,
            reason=f"HTTP {status_code} after {_MAX_RETRIES} attempts",
            extra_fields=("response_status", "attempt_count"),
        )
        return

    delivery.save(update_fields=["response_status", "attempt_count"])
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


def _do_webhook_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_old_deliveries — extracted for testability.

    Deletes only terminal (SUCCESS/FAILED) deliveries: PENDING rows may still be
    re-dispatched by the drain, so they are never purged regardless of age. The
    window comes from ``resolve_retention`` (operator override → settings default,
    ADR-0173); ``None`` disables the purge entirely (unbounded retention).

    Returns the number of rows deleted, or — when ``dry_run`` — the number that
    *would* be deleted. ``override_value`` forces a hypothetical window (used by the
    impact estimate) regardless of the saved policy.
    """
    from django.utils import timezone

    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

    retention_days = (
        override_value
        if override_value is not None
        else resolve_retention("TRUEPPM_WEBHOOK_RETENTION_DAYS")
    )
    if retention_days is None:
        return 0

    cutoff = timezone.now() - timedelta(days=retention_days)
    qs = WebhookDelivery.objects.filter(
        status__in=[DeliveryStatus.SUCCESS, DeliveryStatus.FAILED],
        created_at__lt=cutoff,
    )
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    logger.info("purge_old_deliveries: deleted %d row(s)", deleted)
    return deleted


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
