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

from django.conf import settings
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
    # (project, actor_user): a retry always targets the same project endpoint as
    # the same authenticated user, so that composite unique index is a sufficient
    # concurrency backstop, while scoping prevents one project — or one user —
    # replaying another's stored response (the dedup lookup must never cross the
    # project or actor boundary — see views.post, #887/#894).
    client_batch_id = models.UUIDField()
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="sync_batches",
    )
    # Actor scoping (#894): the stored response body carries task ids,
    # server_versions, and the sync watermark for the rows *this user* pushed.
    # Keying dedup on (project, client_batch_id) alone let any project member
    # replay another member's batch by reusing its client_batch_id and read back
    # that user's response — an information leak across actors. Scoping
    # uniqueness and the replay lookup to the actor closes it: a reused id from a
    # different user is a distinct batch, never a replay of someone else's.
    # Nullable so the migration is backfill-safe for rows written before this
    # field existed (those legacy rows simply never match a new actor-scoped
    # lookup and age out of the freshness window).
    actor_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sync_batches",
        null=True,
        blank=True,
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
            # Actor-scoped uniqueness (#894): two different users may legitimately
            # reuse the same client_batch_id; only a same-(project, actor) duplicate
            # is a replay. Scoping the constraint to the actor prevents one user's
            # batch from blocking — or being replayed by — another's.
            models.UniqueConstraint(
                fields=["project", "actor_user", "client_batch_id"],
                name="syncbatch_project_actor_client_batch_uniq",
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


class BoardEvent(models.Model):
    """Bounded per-project replay buffer for WebSocket events (ADR-0236, #321).

    Real-time broadcasts are best-effort: a client that disconnects loses every
    event sent during the gap. Each replayable broadcast persists one ``BoardEvent``
    row here so a reconnecting client can request ``?since=<seq>`` and replay only
    the events it missed — instead of a broad refetch storm — and recover the
    incremental ``task_dates_updated`` CPM splices a refetch-on-focus would drop.

    Like :class:`SyncBatch`, this is server infrastructure, never pulled as a synced
    domain row, so it is a plain ``models.Model`` (no ``server_version``).

    **The primary key is the sequence.** The ``BigAutoField`` ``id`` is assigned
    atomically by Postgres at INSERT, so it is globally monotonic with no lost or
    duplicate values under concurrent commits. Clients only need a strictly
    increasing-per-project value for a ``seq > since`` comparison and tolerate gaps
    (other projects' rows interleave the global sequence), so the PK *is* the
    per-project sequence — no per-project counter row or dedicated sequence is
    needed. The wire exposes it as ``seq``.

    Rows are reaped past ``TRUEPPM_BOARD_EVENT_RETENTION_HOURS`` (default 24h) by
    the ``sync.purge_board_events`` Beat task, keeping the buffer bounded (the
    ADR-0081 purge convention). Because ``created_at`` is monotonic with ``id`` at
    that granularity, the purge removes a contiguous low-``id`` prefix — which is
    what lets the consumer use "oldest surviving id" as the gap-detection
    watermark (see ``consumers.py``).
    """

    # id: implicit BigAutoField PK (DEFAULT_AUTO_FIELD) — doubles as the sequence.
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="board_events",
    )
    event_type = models.CharField(max_length=64)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects: models.Manager[BoardEvent] = models.Manager()

    class Meta:
        # Replay streams strictly by ascending sequence (the PK).
        ordering = ["id"]
        indexes = [
            # The replay query: WHERE project_id=? AND id > ? ORDER BY id.
            models.Index(fields=["project", "id"], name="boardevent_project_seq_idx"),
            # The reaper scans by age; keeps the nightly purge cheap.
            models.Index(fields=["created_at"], name="boardevent_created_idx"),
        ]

    def __str__(self) -> str:
        return f"BoardEvent(seq={self.pk}, {self.event_type}, project={self.project_id})"

    @property
    def seq(self) -> int:
        """The wire sequence — an alias for the monotonic PK (ADR-0236)."""
        return self.pk
