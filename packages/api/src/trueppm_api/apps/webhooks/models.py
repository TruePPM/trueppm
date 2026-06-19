"""Models for outbound webhook subscriptions and delivery tracking."""

from __future__ import annotations

import uuid
from typing import Any

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models, transaction


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


ALL_WEBHOOK_EVENTS = [e.value for e in WebhookEventType]

# Hard cap on the number of OSS webhook event types (ADR-0083, raised 11→14 by
# ADR-0147 for the agile trio). Adding a 15th event requires its own ADR — this is
# the gate against the per-customer event proliferation that is the explicit
# Enterprise upsell. The trio are first-party domain events, not custom/user-defined
# events, so the upsell line is unaffected. ``test_event_type_cap`` fails loudly if
# WebhookEventType drifts from this number.
OSS_WEBHOOK_EVENT_CAP = 14


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
    secret = models.CharField(max_length=255)
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
