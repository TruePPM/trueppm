"""Django models for MS Project import outbox."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class ImportRequestStatus(models.TextChoices):
    """Lifecycle of a transactional outbox row for MS Project imports."""

    PENDING = "pending", "Pending"
    DISPATCHED = "dispatched", "Dispatched"
    DONE = "done", "Done"
    DEAD = "dead", "Dead"


class ImportRequest(models.Model):
    """Transactional outbox record for MS Project file imports.

    The view writes one row inside transaction.atomic() and defers the
    Celery dispatch via transaction.on_commit().  If the broker is
    unavailable the row stays PENDING and drain_import_queue picks it up
    within 30 seconds.

    Unlike ScheduleRequest there is no at-most-one-pending constraint:
    a project can have multiple imports queued (e.g. user uploads a
    revised file while the previous import is still in flight).

    The file content is stored as base64-encoded text so it survives
    broker outages without relying on Redis.  Base64 inflates the payload
    by ~33%, so the stored row scales with the upload cap
    (settings.MSPROJECT_MAX_UPLOAD_MB, default 50 MB → ~67 MB stored).

    Does NOT inherit VersionedModel — not synced to mobile clients.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="import_requests",
    )
    status = models.CharField(
        max_length=16,
        choices=ImportRequestStatus.choices,
        default=ImportRequestStatus.PENDING,
    )
    # True when this import created the project it targets (ADR-0092,
    # create-from-import). It makes the import idempotent: the task wipes the
    # project's tasks before bulk-create, so an orphan-drain re-dispatch
    # converges instead of duplicating. Import-into-existing-project leaves
    # this False and stays additive.
    creates_project = models.BooleanField(default=False)
    filename = models.CharField(max_length=255)
    # Base64-encoded file content; avoids re-encoding on each drain attempt.
    file_content_b64 = models.TextField()
    initiated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    celery_task_id = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["requested_at"]
        indexes = [
            models.Index(
                fields=["status", "requested_at"],
                name="import_request_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"ImportRequest({self.project_id}, {self.filename}, {self.status})"
