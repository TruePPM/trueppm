"""Models for the scheduling app — Celery task infrastructure."""

from __future__ import annotations

import uuid

from django.conf import settings
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


class VelocitySuggestion(models.Model):
    """Non-destructive duration recommendation generated on sprint close (ADR-0065).

    When a sprint closes, the drain computes a rolling 6-sprint team velocity
    (``completed_points / sprint_working_days``) and, for tasks in the closing
    sprint with ``story_points`` set, records a suggested
    ``most_likely_duration = story_points / team_velocity_per_day`` here. The
    PM accepts or dismisses each suggestion from the Task Detail Drawer; the
    underlying ``Task.most_likely_duration`` is never overwritten without
    explicit consent so PM-committed baselines stay intact and the
    accept/dismiss history is auditable per (task, sprint).

    A unique constraint on (task, sprint) makes the sprint-close drain
    idempotent: a duplicate run upserts the row rather than producing
    duplicate prompts.

    Not synced to mobile clients — surfaces only in the PM-facing Task Detail
    Drawer.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="velocity_suggestions",
    )
    sprint = models.ForeignKey(
        "projects.Sprint",
        on_delete=models.CASCADE,
        related_name="velocity_suggestions",
    )
    # Suggested most_likely_duration in working days. Stored as integer to match
    # Task.most_likely_duration; rounding happens in the service layer.
    suggested_duration = models.PositiveIntegerField()
    team_velocity_per_day = models.DecimalField(
        max_digits=6,
        decimal_places=3,
        help_text="Rolling 6-sprint average of completed_points / sprint_working_days.",
    )
    # When estimation_mode=SUGGEST_APPROVE the suggestion is flagged so the
    # governance review surface can route the accept decision through a
    # Scheduler-role user; in OPEN and PM_ONLY modes any PM may accept directly.
    flag_for_review = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    # Exactly one of accepted_at / dismissed_at is non-null at a time; the
    # other stays null. The pair encodes the PM decision lifecycle without an
    # extra status enum (similar to the actual_start / actual_finish pattern).
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="accepted_velocity_suggestions",
    )
    dismissed_at = models.DateTimeField(null=True, blank=True)
    dismissed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="dismissed_velocity_suggestions",
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["task", "sprint"],
                name="unique_velocity_suggestion_per_task_sprint",
            ),
        ]
        indexes = [
            # Pending suggestions for a task — the Task Detail Drawer query.
            models.Index(
                fields=["task", "accepted_at", "dismissed_at"],
                name="velocity_sugg_task_pending_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"VelocitySuggestion(task={self.task_id}, sprint={self.sprint_id})"

    @property
    def project_id(self) -> object:
        """Expose the task's project_id so _get_project_id_from_obj can find it.

        Required for IsProjectAdmin.has_object_permission to resolve the project
        context when DRF's get_object() runs check_object_permissions on a
        VelocitySuggestion (no direct FK to Project). Mirrors the same pattern
        used by resources.TaskResource.
        """
        return self.task.project_id

    @property
    def is_pending(self) -> bool:
        """True when neither accepted nor dismissed — pending PM decision."""
        return self.accepted_at is None and self.dismissed_at is None
