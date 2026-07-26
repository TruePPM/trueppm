"""Outbox model for CSV / Excel import (mirrors jiraimport.JiraImportRequest).

A dedicated outbox — rather than a ``source`` discriminator on the MS Project
``ImportRequest`` — keeps the three drains independent (ADR-0259, restated in
ADR-0632): no drain has to branch on file type, and the CSV surface can evolve
without touching the MSP or Jira paths.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class CsvImportStatus(models.TextChoices):
    """Lifecycle of a CSV import outbox row."""

    PENDING = "pending", "Pending"
    DISPATCHED = "dispatched", "Dispatched"
    DONE = "done", "Done"
    DEAD = "dead", "Dead"


class CsvImportRequest(models.Model):
    """A durable record of an uploaded spreadsheet awaiting / running import.

    The file content is committed to the row before any Celery dispatch is
    attempted, so a broker outage at upload time cannot lose the import — the
    row stays PENDING and ``drain_csv_import_queue`` picks it up within 30
    seconds. The base64 payload is cleared once the row reaches a terminal state
    (DONE / DEAD) since it is only needed for pre-terminal retry.

    ``column_map`` persists the wizard's confirmed header→field overrides
    alongside the file, so a drain re-dispatch replays the operator's mapping
    rather than falling back to auto-detection and importing different columns
    than the ones they confirmed.

    ``result_summary`` is the terminal outcome the launching Schedule polls:
    counts plus the row-level errors that made an import a partial success.
    Keeping it on the row is what stops an async failure being silently
    swallowed (the #2151 defect class).

    Does NOT inherit VersionedModel — not synced to mobile clients.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="csv_import_requests",
    )
    status = models.CharField(
        max_length=16,
        choices=CsvImportStatus.choices,
        default=CsvImportStatus.PENDING,
    )
    filename = models.CharField(max_length=255)
    file_content_b64 = models.TextField()
    column_map = models.JSONField(default=dict, blank=True)
    result_summary = models.JSONField(default=dict, blank=True)
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
                name="csv_import_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"CsvImportRequest({self.project_id}, {self.filename}, {self.status})"
