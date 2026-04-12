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
    """A registered outbound webhook subscription scoped to a project."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="webhooks",
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
        ]

    def __str__(self) -> str:
        return f"Webhook {self.id} → {self.url}"


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
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Delivery {self.id} [{self.status}]"
