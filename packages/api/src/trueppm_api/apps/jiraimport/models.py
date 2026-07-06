"""Outbox model for offline Jira import (mirrors msproject.ImportRequest).

A dedicated outbox — rather than a ``source`` discriminator on the MS Project
``ImportRequest`` — keeps the two drains independent (ADR-0257): the MSP drain
does not have to branch on file type, and the Jira import surface can evolve
without touching the MSP path.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class JiraImportStatus(models.TextChoices):
    """Lifecycle of a Jira import outbox row."""

    PENDING = "pending", "Pending"
    DISPATCHED = "dispatched", "Dispatched"
    DONE = "done", "Done"
    DEAD = "dead", "Dead"


class JiraImportRequest(models.Model):
    """A durable record of an uploaded Jira XML export awaiting / running import.

    The file content is committed to the row before any Celery dispatch is
    attempted, so a broker outage at upload time cannot lose the import — the row
    stays PENDING and ``drain_jira_import_queue`` picks it up within 30 seconds.
    The ~base64 payload is cleared once the row reaches a terminal state
    (DONE / DEAD) since it is only needed for pre-terminal retry.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="jira_import_requests",
    )
    status = models.CharField(
        max_length=16,
        choices=JiraImportStatus.choices,
        default=JiraImportStatus.PENDING,
    )
    filename = models.CharField(max_length=255)
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
                name="jira_import_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"JiraImportRequest({self.project_id}, {self.filename}, {self.status})"
