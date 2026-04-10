"""Models for the scheduling app — Celery task infrastructure."""

from __future__ import annotations

import uuid

from django.db import models


class FailedTaskStatus(models.TextChoices):
    """Lifecycle of a dead-lettered Celery task."""

    PENDING_RETRY = "pending_retry", "Pending Retry"
    DEAD = "dead", "Dead"
    DISMISSED = "dismissed", "Dismissed"
    RETRIED = "retried", "Retried"


class FailedTask(models.Model):
    """Persistent record of a Celery task that exhausted all retries.

    Does NOT inherit VersionedModel — not synced to mobile, not part of the
    project data graph. Exists for admin visibility and manual retry/dismiss.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task_name = models.CharField(max_length=255, db_index=True)
    task_id = models.CharField(max_length=255, unique=True)
    args = models.JSONField(default=list)
    kwargs = models.JSONField(default=dict)
    exception_type = models.CharField(max_length=255)
    exception_message = models.TextField()
    traceback = models.TextField()
    failure_count = models.PositiveIntegerField(default=1)
    first_failed_at = models.DateTimeField(auto_now_add=True)
    last_failed_at = models.DateTimeField(auto_now=True)
    status = models.CharField(
        max_length=16,
        choices=FailedTaskStatus.choices,
        default=FailedTaskStatus.DEAD,
        db_index=True,
    )

    class Meta:
        ordering = ["-last_failed_at"]
        indexes = [
            models.Index(fields=["status", "last_failed_at"], name="failed_task_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.task_name} ({self.task_id}) — {self.status}"
