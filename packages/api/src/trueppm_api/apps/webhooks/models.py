"""Models for outbound webhook subscriptions and delivery tracking."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models


class WebhookEventType(models.TextChoices):
    TASK_CREATED = "task.created", "Task Created"
    TASK_UPDATED = "task.updated", "Task Updated"
    TASK_DELETED = "task.deleted", "Task Deleted"
    DEPENDENCY_CREATED = "dependency.created", "Dependency Created"
    DEPENDENCY_DELETED = "dependency.deleted", "Dependency Deleted"
    SCHEDULE_RECALCULATED = "schedule.recalculated", "Schedule Recalculated"
    PROJECT_CREATED = "project.created", "Project Created"


ALL_WEBHOOK_EVENTS = [e.value for e in WebhookEventType]


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
    is_active = models.BooleanField(default=True)
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
