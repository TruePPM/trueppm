"""Models for the scheduling app — Celery task infrastructure."""

from __future__ import annotations

import uuid

from django.db import models


class ScheduleRequestStatus(models.TextChoices):
    """Lifecycle of a transactional outbox row for CPM recalculation."""

    PENDING = "pending", "Pending"
    DISPATCHED = "dispatched", "Dispatched"
    DONE = "done", "Done"
    DEAD = "dead", "Dead"


class ScheduleRequestReason(models.TextChoices):
    """Why a CPM recalculation was requested — used for audit trail and drain dedup."""

    TASK_CHANGE = "task_change", "Task Change"
    DEPENDENCY_CHANGE = "dependency_change", "Dependency Change"
    SPRINT_CLOSED = "sprint_closed", "Sprint Closed"
    MANUAL = "manual", "Manual"


class ScheduleRequest(models.Model):
    """Transactional outbox record for CPM recalculation requests.

    Each write operation on a project's task graph inserts one row here
    (or silently ignores a duplicate via the partial unique constraint) in
    the same DB transaction. A Celery Beat drain task dispatches pending rows
    every 30 seconds, and recalculate_schedule marks its own row done on
    completion.

    Two partial unique constraints enforce at-most-one pending and at-most-one
    dispatched row per project at any time, so duplicate suppression is cheap
    and correct under concurrent writes.

    Does NOT inherit VersionedModel — not synced to mobile clients.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="schedule_requests",
    )
    status = models.CharField(
        max_length=16,
        choices=ScheduleRequestStatus.choices,
        default=ScheduleRequestStatus.PENDING,
    )
    reason = models.CharField(
        max_length=24,
        choices=ScheduleRequestReason.choices,
        default=ScheduleRequestReason.TASK_CHANGE,
        db_index=True,
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    celery_task_id = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["requested_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(status="pending"),
                name="schedule_request_one_pending_per_project",
            ),
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(status="dispatched"),
                name="schedule_request_one_dispatched_per_project",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "requested_at"],
                name="schedule_request_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"ScheduleRequest({self.project_id}, {self.status})"


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
