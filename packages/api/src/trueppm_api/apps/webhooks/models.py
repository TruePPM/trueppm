"""Models for outbound webhook subscriptions and delivery tracking."""

from __future__ import annotations

import uuid
from typing import Any

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models, transaction
from django.utils import timezone

from trueppm_api.apps.integrations.encryption import decrypt_secret, encrypt_secret


class WebhookEventType(models.TextChoices):
    TASK_CREATED = "task.created", "Task Created"
    TASK_UPDATED = "task.updated", "Task Updated"
    TASK_DELETED = "task.deleted", "Task Deleted"
    DEPENDENCY_CREATED = "dependency.created", "Dependency Created"
    DEPENDENCY_DELETED = "dependency.deleted", "Dependency Deleted"
    SCHEDULE_RECALCULATED = "schedule.recalculated", "Schedule Recalculated"
    PROJECT_CREATED = "project.created", "Project Created"
    # Four new task events added in #638 (ADR-0083). task.due_date_changed
    # currently fires on planned_start changes — #690 rebinds it to a dedicated
    # planned_finish deadline field.
    TASK_ASSIGNED = "task.assigned", "Task Assigned"
    TASK_ASSIGNEE_CHANGED = "task.assignee_changed", "Task Assignee Changed"
    TASK_MENTIONED = "task.mentioned", "Task Mentioned"
    TASK_DUE_DATE_CHANGED = "task.due_date_changed", "Task Due Date Changed"
    # Agile trio added in #1073 (ADR-0147). First-party domain events — they make
    # the sprint-sovereignty story (ADR-0102/0104) observable to external tooling.
    # sprint.closed's completion snapshot is velocity and is privacy-gated in its
    # payload builder per ADR-0104 (see _sprint_closed_webhook_payload).
    SPRINT_ACTIVATED = "sprint.activated", "Sprint Activated"
    SPRINT_CLOSED = "sprint.closed", "Sprint Closed"
    SPRINT_SCOPE_CHANGED = "sprint.scope_changed", "Sprint Scope Changed"
    # Risk / baseline / comment domain events added in #1082 (ADR-0206). First-party
    # domain events that extend the catalog beyond agile so external reporting and
    # alerting tooling can observe the risk register, baseline captures, and the
    # comment thread. risk.escalated fires when computed severity (probability ×
    # impact) increases; risk.closed on the transition into CLOSED. comment.created
    # carries no comment body (privacy-conservative) and is distinct from
    # task.mentioned, which fires only when a comment mentions someone.
    RISK_OPENED = "risk.opened", "Risk Opened"
    RISK_ESCALATED = "risk.escalated", "Risk Escalated"
    RISK_CLOSED = "risk.closed", "Risk Closed"
    BASELINE_CAPTURED = "baseline.captured", "Baseline Captured"
    COMMENT_CREATED = "comment.created", "Comment Created"


ALL_WEBHOOK_EVENTS = [e.value for e in WebhookEventType]

# Hard cap on the number of OSS webhook event types (ADR-0083, raised 11→14 by
# ADR-0147 for the agile trio, then 14→19 by ADR-0206 for the risk/baseline/comment
# domain events). Adding a 20th event requires its own ADR — this is the gate
# against the per-customer event proliferation that is the explicit Enterprise
# upsell. These are all first-party domain events, not custom/user-defined events,
# so the upsell line is unaffected. ``test_event_type_cap`` fails loudly if
# WebhookEventType drifts from this number.
OSS_WEBHOOK_EVENT_CAP = 19

# Reserved, non-domain event type used by the "Send test" action (#2884). It is
# deliberately NOT a WebhookEventType member: no subscription can select it and
# no domain mutation emits it, but a test ping is a real delivery — it renders
# through the subscription's provider, allocates a sequence number, and carries
# the ``_meta`` envelope like any other delivery, so a consumer doing in-body gap
# detection does not see a phantom jump when an admin clicks Test.
PING_EVENT_TYPE = "ping"

# Consecutive terminal delivery failures after which a subscription is
# automatically deactivated (#2884). Before this existed, a revoked receiver
# answering 404/410 was retried forever with no state change: `is_active` was
# only ever written by a human PATCH, so the queue and the receiver both burned
# indefinitely. Five is one working day's worth of noise for a low-traffic
# project and about a minute for a busy one — high enough that a brief receiver
# outage does not trip it (a transient 5xx recovers within the retry chain and
# resets the counter on the next success), low enough that a permanently broken
# endpoint stops being retried.
AUTO_DISABLE_CONSECUTIVE_FAILURES = 5


class Webhook(models.Model):
    """A registered outbound webhook subscription.

    Polymorphically scoped to either a Project or a Program (ADR-0076).
    A program-scoped webhook fires for events on any project within the
    program; a project-scoped webhook fires only for that project. The DB
    constraint enforces XOR — exactly one of project/program is set.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="webhooks",
        null=True,
        blank=True,
        help_text="Set when the webhook fires for events on a single project. "
        "Exactly one of project/program is non-null (DB constraint).",
    )
    program = models.ForeignKey(
        "projects.Program",
        on_delete=models.CASCADE,
        related_name="webhooks",
        null=True,
        blank=True,
        help_text="Set when the webhook fires for events on any project within "
        "this program. Exactly one of project/program is non-null (DB constraint).",
    )
    url = models.URLField(max_length=2048)
    # Fernet ciphertext of the HMAC signing secret (#2885, ADR-0049 §3). This was
    # the last plaintext secret in the product; every sibling secret
    # (IntegrationCredential PAT, inbound git webhook secret, SSO client_secret,
    # workspace SMTP password) already used this at-rest pattern, so a pg_dump or
    # a read-only SQL finding yielded signing keys that let an attacker forge
    # accepted deliveries at every registered receiver.
    #
    # Encrypted rather than hashed: signing needs the plaintext at delivery time
    # (the same reason BoardAutomation.secret_ciphertext is encrypted and
    # ApiToken's is hashed). Read and written through the ``secret`` property
    # below, which keeps ``Webhook.objects.create(secret=...)`` and
    # ``webhook.secret`` working — Django's ``Model.__init__`` routes an unknown
    # kwarg to a same-named property with a setter.
    secret_ciphertext = models.BinaryField(default=b"", blank=True, editable=False)
    events = ArrayField(
        models.CharField(max_length=30, choices=WebhookEventType.choices),
        help_text="List of event types this webhook subscribes to.",
    )
    # Outgoing payload format (#638, ADR-0049/0083). NOT a TextChoices — validated
    # at write time against OUTGOING_CHANNEL_PROVIDERS.keys() in the serializer, so
    # Enterprise can register slack_app/teams without an OSS migration. Existing
    # rows backfill to "generic" (the historical pass-through behavior).
    format = models.CharField(max_length=32, default="generic")
    is_active = models.BooleanField(default=True)
    # Per-subscription delivery-health counters (#2884). Before these existed the
    # only evidence of a failing endpoint was the per-webhook delivery log, which
    # is Admin-only and purges terminal rows after TRUEPPM_WEBHOOK_RETENTION_DAYS
    # (default 7) — so an outage older than a week left no trace anywhere.
    #
    # ``consecutive_failures`` counts *terminal* failures (a delivery that will
    # never be attempted again), not individual attempts, and resets to 0 on the
    # next success. ``disabled_at``/``disabled_reason`` are set only by the
    # automatic guard, never by a human PATCH, so the UI can distinguish "an admin
    # paused this" from "TruePPM gave up on this".
    consecutive_failures = models.PositiveIntegerField(
        default=0,
        help_text="Terminal delivery failures since the last success. Resets to 0 "
        "on any successful delivery.",
    )
    last_failure_at = models.DateTimeField(null=True, blank=True)
    last_failure_reason = models.CharField(max_length=255, blank=True, default="")
    disabled_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When the automatic failure guard deactivated this subscription. "
        "Null when it is active, or when an admin deactivated it by hand.",
    )
    disabled_reason = models.CharField(max_length=255, blank=True, default="")
    # Per-subscription monotonic counter for outgoing deliveries (#664). Lives on
    # the subscription, NOT derived from WebhookDelivery rows, because the
    # retention purge (ADR-0081) deletes terminal deliveries — deriving the next
    # value from the delivery table would reuse sequence numbers after a purge
    # and silently corrupt the consumer-side gap-detection contract.
    delivery_sequence = models.BigIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
    )

    class Meta:
        indexes = [
            models.Index(fields=["project", "is_active"], name="webhook_project_active_idx"),
            models.Index(fields=["program", "is_active"], name="webhook_program_active_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(project__isnull=False, program__isnull=True)
                    | models.Q(project__isnull=True, program__isnull=False)
                ),
                name="webhook_scope_xor",
            ),
        ]

    def __str__(self) -> str:
        return f"Webhook {self.id} → {self.url}"

    @property
    def is_program_scoped(self) -> bool:
        """True when this webhook fires for events on any project in a program."""
        return self.program_id is not None

    @property
    def secret(self) -> str:
        """The plaintext HMAC signing secret, decrypted from ``secret_ciphertext``.

        Server-side only — it is never serialized to a client (the API echoes an
        auto-generated secret exactly once at create time and a ``secret_set``
        boolean thereafter). Returns ``""`` when no secret is stored, which the
        delivery task treats as a configuration error rather than signing with an
        empty key.
        """
        if not self.secret_ciphertext:
            return ""
        return decrypt_secret(self.secret_ciphertext)

    @secret.setter
    def secret(self, plaintext: str) -> None:
        """Fernet-encrypt ``plaintext`` into ``secret_ciphertext`` (#2885).

        A setter rather than an explicit ``set_secret()`` method so every existing
        write path — ``Webhook.objects.create(secret=...)``, DRF's
        ``setattr``-based ``ModelSerializer.update``, and fixtures — keeps working
        against the encrypted column with no call-site change. Writing a new value
        is the rotation path: the previous ciphertext is overwritten.
        """
        self.secret_ciphertext = encrypt_secret(plaintext) if plaintext else b""

    @property
    def secret_set(self) -> bool:
        """Whether a signing secret is stored (the only thing the API exposes)."""
        return bool(self.secret_ciphertext)

    def record_delivery_success(self) -> None:
        """Clear the failure counters after a delivery succeeds (#2884).

        Guarded on a non-zero counter so the common case (a healthy webhook
        delivering thousands of events) issues no UPDATE at all. Written with a
        queryset update rather than ``save()`` because the caller holds a delivery
        row, not a lock on the subscription, and two concurrent deliveries to the
        same webhook would otherwise race on a stale in-memory copy.
        """
        if not (self.consecutive_failures or self.last_failure_at or self.disabled_at):
            return
        Webhook.objects.filter(pk=self.pk).update(
            consecutive_failures=0,
            last_failure_at=None,
            last_failure_reason="",
        )
        self.consecutive_failures = 0
        self.last_failure_at = None
        self.last_failure_reason = ""

    def record_delivery_failure(self, reason: str) -> bool:
        """Count one *terminal* delivery failure; auto-disable past the threshold.

        Called only when a delivery will never be attempted again — a permanent
        client error, an exhausted retry chain, or an SSRF block. Attempts inside a
        live retry chain must not be counted here, or a single event's five
        attempts would trip the guard on their own.

        The increment uses ``F()`` so concurrent fan-out to the same subscription
        cannot lose a count, then re-reads the committed value to decide whether to
        deactivate. Returns ``True`` when this call deactivated the subscription,
        so the caller can log the transition once.
        """
        now = timezone.now()
        Webhook.objects.filter(pk=self.pk).update(
            consecutive_failures=models.F("consecutive_failures") + 1,
            last_failure_at=now,
            last_failure_reason=reason[:255],
        )
        failures: int = (
            Webhook.objects.filter(pk=self.pk)
            .values_list("consecutive_failures", flat=True)
            .first()
            or 0
        )
        self.consecutive_failures = failures
        self.last_failure_at = now
        self.last_failure_reason = reason[:255]

        if failures < AUTO_DISABLE_CONSECUTIVE_FAILURES:
            return False
        # Only the first call across the threshold flips the flag, so a webhook
        # already deactivated (by the guard or by an admin) is not re-stamped.
        disabled_reason = (
            f"Automatically deactivated after {failures} consecutive failed "
            f"deliveries. Last failure: {reason}"
        )[:255]
        updated = Webhook.objects.filter(pk=self.pk, is_active=True).update(
            is_active=False,
            disabled_at=now,
            disabled_reason=disabled_reason,
        )
        if updated:
            self.is_active = False
            self.disabled_at = now
            self.disabled_reason = disabled_reason
        return bool(updated)


def _next_delivery_sequence(webhook_id: uuid.UUID | str) -> int:
    """Atomically allocate the next per-subscription delivery sequence number.

    Locks the Webhook row with ``select_for_update`` and increments its
    ``delivery_sequence`` counter inside an explicit transaction. The lock is
    held until commit, so concurrent deliveries to the same subscription receive
    strictly increasing, *contiguous* numbers — a gap at the consumer therefore
    signals a genuinely lost event, which is the whole point of the gap-detection
    contract (#664).

    The explicit ``transaction.atomic()`` is required because ``dispatch_webhooks``
    runs from a ``transaction.on_commit`` callback (autocommit context); without
    the surrounding transaction the increment + read-back would race.
    """
    with transaction.atomic():
        webhook = Webhook.objects.select_for_update().get(pk=webhook_id)
        webhook.delivery_sequence += 1
        webhook.save(update_fields=["delivery_sequence"])
        return webhook.delivery_sequence


class DeliveryStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    SUCCESS = "success", "Success"
    FAILED = "failed", "Failed"


class WebhookDelivery(models.Model):
    """Record of a single webhook delivery attempt (or series of retries)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    webhook = models.ForeignKey(
        Webhook,
        on_delete=models.CASCADE,
        related_name="deliveries",
    )
    # ``choices`` documents the subscribable domain events; it is validation-only
    # (no DB constraint), which is what lets the reserved PING_EVENT_TYPE — not a
    # WebhookEventType member because nothing can subscribe to it — be recorded
    # here as a real delivery.
    event_type = models.CharField(max_length=30, choices=WebhookEventType.choices)
    payload = models.JSONField()
    # Monotonic per-subscription sequence, allocated once on INSERT and never
    # changed across retries (the same row keeps its number). Sent to the
    # consumer in the X-TruePPM-Webhook-Sequence header so it can detect gaps
    # and reorder out-of-order events. The default of 0 is only a placeholder
    # for the add-column migration; every row created through save() is assigned
    # a real value >= 1 via _next_delivery_sequence().
    sequence_number = models.BigIntegerField(default=0, editable=False)
    status = models.CharField(
        max_length=10,
        choices=DeliveryStatus.choices,
        default=DeliveryStatus.PENDING,
    )
    response_status = models.SmallIntegerField(null=True, blank=True)
    attempt_count = models.SmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["webhook", "created_at"], name="delivery_webhook_created_idx"),
            models.Index(fields=["status", "created_at"], name="delivery_status_created_idx"),
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Delivery {self.id} [{self.status}]"

    def save(self, *args: Any, **kwargs: Any) -> None:
        # Allocate the per-subscription sequence on INSERT only, so the number is
        # stable across the Celery retry chain (deliver_webhook re-saves the same
        # row on every attempt and must not re-number it).
        if self._state.adding and not self.sequence_number:
            self.sequence_number = _next_delivery_sequence(self.webhook_id)
        super().save(*args, **kwargs)
