"""Models for long-running task progress tracking."""

from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import models


class TaskRunStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    RUNNING = "running", "Running"
    SUCCESS = "success", "Success"
    FAILED = "failed", "Failed"
    CANCELLED = "cancelled", "Cancelled"


class TaskRun(models.Model):
    """Persisted record of a single Celery task execution with live progress state.

    Not extended from VersionedModel — this is a server-side audit record, not
    synced to mobile. `result_summary` is a structured JSONField so Enterprise can
    store workflow stage payloads here without a schema change.
    """

    id = models.UUIDField(primary_key=True, default=uuid4, editable=False)
    task_name = models.CharField(max_length=255)
    celery_task_id = models.CharField(max_length=255, db_index=True)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="task_runs",
    )
    initiated_by = models.ForeignKey(
        get_user_model(),
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="task_runs",
    )
    status = models.CharField(
        max_length=10,
        choices=TaskRunStatus.choices,
        default=TaskRunStatus.PENDING,
        db_index=True,
    )
    progress_pct = models.SmallIntegerField(null=True, blank=True)
    progress_msg = models.TextField(blank=True, default="")
    result_summary = models.JSONField(null=True, blank=True)
    error_detail = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["project", "status", "created_at"],
                name="taskrun_project_status_created_idx",
            ),
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"TaskRun({self.task_name}, {self.status})"
