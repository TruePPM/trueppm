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

    **``seq`` is a per-project, dense, commit-ordered sequence (ADR-1285, #4386).**
    It is drawn from the project's :class:`BoardEventSequence` row in the *same*
    transaction as this row's INSERT, so the counter's row lock is held until the
    event commits: within one project, commit order equals allocation order and the
    committed values are 1, 2, 3, … with no holes. That is what lets a client treat
    ``seq > last + 1`` as "a frame is missing or still in flight" and ``seq <= last``
    as a genuine duplicate, and lets the consumer prove a replay complete by
    counting rows. The previous design used the global ``BigAutoField`` PK, which
    could not support either: other projects' traffic interleaved it (so the next
    frame on a project was almost never ``last + 1``), two workers' sends could
    arrive in the reverse of allocation order and the later-allocated one would
    make the client drop the other as a duplicate, and the delta between frames
    leaked instance-wide event volume to every project member.

    ``seq`` is nullable for one reason: a pod running the pre-#4386 code during a
    rolling update INSERTs without it. Such a row is live-only — the replay query
    filters ``seq`` non-null and the allocator never counted it, so it neither
    creates a false gap nor gets replayed. Rows are reaped past
    ``TRUEPPM_BOARD_EVENT_RETENTION_HOURS`` (default 24h) by the
    ``sync.purge_board_events`` Beat task (the ADR-0081 purge convention).
    """

    # id: implicit BigAutoField PK (DEFAULT_AUTO_FIELD) — row identity only; the
    # wire sequence is ``seq`` (ADR-1285).
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="board_events",
    )
    seq = models.BigIntegerField(null=True, blank=True, editable=False)
    event_type = models.CharField(max_length=64)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects: models.Manager[BoardEvent] = models.Manager()

    class Meta:
        ordering = ["id"]
        constraints = [
            # One event per (project, seq). Its index also serves the replay query
            # ``WHERE project_id=? AND seq > ? AND seq <= ? ORDER BY seq``. NULLs
            # (rolling-update rows, see the class docstring) are distinct in a
            # Postgres unique index, so they never collide.
            models.UniqueConstraint(fields=["project", "seq"], name="boardevent_project_seq_uniq"),
        ]
        indexes = [
            # The reaper scans by age; keeps the nightly purge cheap.
            models.Index(fields=["created_at"], name="boardevent_created_idx"),
        ]

    def __str__(self) -> str:
        return f"BoardEvent(seq={self.seq}, {self.event_type}, project={self.project_id})"


class BoardEventSequence(models.Model):
    """Per-project allocator for :attr:`BoardEvent.seq` (ADR-1285, #4386).

    One row per project that has ever persisted a replayable event, created lazily
    on the first one. ``value`` is the last allocated ``seq`` and therefore also the
    replay head the consumer reports as ``latest_seq``.

    **Why a row lock and not a PostgreSQL SEQUENCE** — the same reason as
    :class:`ProgramSyncSequence` and the ``sync_seq`` allocator (ADR-0686):
    ``nextval()`` is non-transactional, so it would hand out values with no
    relationship to commit order and leave holes on rollback. Allocating by
    ``UPDATE … RETURNING`` in the event's own transaction holds this row's lock
    until that transaction commits, which is what makes the committed values dense
    and commit-ordered.

    **Why its own row and not a column on ``Project``.** ``Project.last_sync_version``
    is held locked for the *whole* apply of a sync upload, and ``Project`` rows are
    also taken ``FOR UPDATE`` by several domain transactions. Broadcasts run in
    ``on_commit`` callbacks; putting their allocator on the project row would make
    every broadcast on a project wait behind any of those, and couple a transport
    counter to domain locking. A dedicated row is locked only for the few
    milliseconds of one event INSERT, and nothing else ever locks it, so it cannot
    take part in a lock cycle with the project row.
    """

    project = models.OneToOneField(
        "projects.Project",
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="board_event_sequence",
    )
    value = models.BigIntegerField(default=0, editable=False)

    objects: models.Manager[BoardEventSequence] = models.Manager()

    def __str__(self) -> str:
        return f"BoardEventSequence(project={self.project_id}, value={self.value})"


class ProgramSyncSequence(models.Model):
    """Installation-wide monotonic allocator for the program sync cursor (ADR-0747).

    Exactly one row, pk=1. Every synced write to ``Program`` or
    ``ProgramMembership`` draws the next value from it and stamps the row's
    ``sync_seq``, so those values are totally ordered installation-wide, ``MAX`` is
    a meaningful checkpoint, and ``sync_seq__gt=since`` is a correct delta filter.

    **Why a table row and not a PostgreSQL SEQUENCE.** ``nextval()`` would avoid
    this row's write lock, and would be wrong. Sequences are non-transactional, so
    they grant no relationship between allocation order and commit order: one
    transaction could allocate 100, a later one allocate 101 and commit first, and a
    pull between the two commits would report 101 and permanently skip 100 — the
    exact defect this replaces, reintroduced as a race. Allocating by ``UPDATE``
    holds this row's write lock until commit, so commit order equals allocation
    order. The lock is the correctness mechanism, not overhead.

    **Why installation-wide and not per-program.** ``Program`` rows have no single
    owning entity to sequence from the way a ``Task`` has its project (ADR-0686).
    The accessible set is per-user — the union of the caller's programs — so a
    scalar cursor over per-program sequences would reintroduce the same
    hot-row-outruns-cold-row failure one level up. Ordering every program-scoped
    write against one counter is what makes a scalar cursor sound.

    The cost is that program writes serialize installation-wide. That is acceptable
    because program writes are rare and administrative — create, rename, add or
    remove a member — never a hot path or a bulk import. See ADR-0747 for the
    escape hatch if that ever changes.
    """

    #: The single row's primary key. Named so call sites read as intent.
    SINGLETON_PK = 1

    id = models.BigAutoField(primary_key=True)
    value = models.BigIntegerField(default=0, editable=False)

    objects: models.Manager[ProgramSyncSequence] = models.Manager()

    class Meta:
        verbose_name = "program sync sequence"
        verbose_name_plural = "program sync sequence"

    def __str__(self) -> str:
        return f"ProgramSyncSequence(value={self.value})"
