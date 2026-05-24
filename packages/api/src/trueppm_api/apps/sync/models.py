"""Models for the sync app.

The only model here is :class:`SyncBatch`, the idempotency + atomicity
envelope for a mobile offline **upload** batch (ADR-0082, issue #667). It is
server infrastructure — the mobile client never pulls it as a domain row — so
it is a plain ``models.Model`` (not ``VersionedModel``), mirroring the
transactional-outbox style of ``projects.SprintCloseRequest``.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.db import models
from django.utils import timezone


class SyncBatchStatus(models.TextChoices):
    """Lifecycle of an upload batch envelope (ADR-0082 §D)."""

    PENDING = "pending", "Pending"
    COMPLETED = "completed", "Completed"


class SyncBatch(models.Model):
    """Records a mobile upload batch so a retry is a no-op, not a double-apply.

    A mobile client generates a stable ``client_batch_id`` (UUID) per delta and
    re-uploads the *same* id until it sees an ACK. The first request that wins
    the unique-constraint race applies the delta and snapshots its HTTP response
    here, inside the same transaction as the row writes (all-or-nothing). A
    later request carrying the same id — the lost-ACK retry — returns the stored
    response without re-applying anything.

    Concurrency is serialized by the ``client_batch_id`` unique constraint:
    Postgres blocks a concurrent duplicate INSERT until the first transaction
    commits or aborts, after which the duplicate either reads the committed row
    (replay) or proceeds (the first attempt rolled back). See
    ``sync.views.ProjectSyncView.post`` for the full algorithm.

    Rows are dedup-relevant only within the freshness window
    (``TRUEPPM_SYNC_BATCH_RETENTION_HOURS``, default 24h); the
    ``sync.purge_sync_batches`` Beat task reaps older rows so the table stays
    bounded (ADR-0081 purge convention).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Client-generated dedup key. Uniqueness (and every lookup) is scoped to
    # the project: a retry always targets the same project endpoint, so the
    # per-project unique index is a sufficient concurrency backstop, while
    # scoping prevents one project replaying another project's stored response
    # (the dedup lookup must never cross the project boundary — see views.post).
    client_batch_id = models.UUIDField()
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="sync_batches",
    )
    status = models.CharField(
        max_length=12,
        choices=SyncBatchStatus.choices,
        default=SyncBatchStatus.PENDING,
        db_index=True,
    )
    # Verbatim success response so a retry replays byte-identically.
    response_body = models.JSONField(default=dict, blank=True)
    response_status = models.PositiveSmallIntegerField(default=200)
    created_at = models.DateTimeField(auto_now_add=True)

    objects: models.Manager[SyncBatch] = models.Manager()

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "client_batch_id"],
                name="syncbatch_project_client_batch_uniq",
            ),
        ]
        indexes = [
            # Reaper scans by age; the index keeps the nightly purge cheap.
            models.Index(fields=["created_at"], name="syncbatch_created_idx"),
        ]

    def __str__(self) -> str:
        return f"SyncBatch({self.client_batch_id}, {self.status})"

    def is_fresh(self, *, ttl_hours: int = 24) -> bool:
        """Return True if this batch is still within the dedup window.

        A duplicate of a *fresh* completed batch replays the stored response; a
        duplicate of an *expired* batch re-runs the apply (the stale row is
        deleted first). ``ttl_hours`` is supplied by the caller from
        ``settings.TRUEPPM_SYNC_BATCH_RETENTION_HOURS``.
        """
        return self.created_at > timezone.now() - timedelta(hours=ttl_hours)
