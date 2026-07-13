"""Time-tracking domain models — logged effort and the running timer (ADR-0185 §2).

``TimeEntry`` is the durable, sync-eligible fact; ``ActiveTimer`` is transient live
state. The split is deliberate (ADR-0185 §2): a ticking timer is derived state, not a
logged fact, so it is *not* a ``VersionedModel`` and a stopped timer is hard-deleted,
not soft-deleted. Nothing here broadcasts — a time entry mutates no shared board state
(ADR-0185 §5).
"""

from __future__ import annotations

import uuid
from typing import Any

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from trueppm_api.apps.projects.models import VersionedModel


class TimeEntrySource(models.TextChoices):
    """Provenance of a logged entry — drives the UI/undo affordance."""

    MANUAL = "manual", "Manual"
    TIMER = "timer", "Timer"


class TimeEntry(VersionedModel):
    """A contributor's logged effort against a task (ADR-0185 §2).

    The durable, sync-eligible record of *where a user's hours went*. The row is owned
    by the logger: ``user`` is server-set to ``request.user`` and is never client-
    supplied, so the entry is IDOR-safe by construction. Duration is canonical integer
    ``minutes`` (1..1440) to avoid the decimal-hours rounding drift the constraint
    exists to prevent — the client formats ``h:mm``.

    There is **no** uniqueness constraint on ``(user, task, entry_date)``: a contributor
    may legitimately log multiple entries against the same task on the same day (two
    sessions). The weekly grid aggregates them.
    """

    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="time_entries",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="time_entries",
    )
    minutes = models.PositiveIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(1440)],
    )
    entry_date = models.DateField(default=timezone.localdate)
    note = models.CharField(max_length=500, blank=True)
    source = models.CharField(
        max_length=10,
        choices=TimeEntrySource.choices,
        default=TimeEntrySource.MANUAL,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    # Soft-delete accountability (issue #1888). The base ``VersionedModel.soft_delete()``
    # only flips ``is_deleted``, so a removed entry left no trace of *when* or *by whom*
    # — and the task activity stream, which filtered ``is_deleted=False``, silently
    # dropped its ``time_logged`` event too. That is an EVM/billing integrity gap: logged
    # hours could be revised or removed with no record. These fields let the stream
    # synthesize a ``time_deleted`` event, mirroring the ``TaskComment``/``TaskAttachment``
    # soft-delete precedent. ``deleted_by`` is the acting user (always the owner — entries
    # are self-scoped) and SET_NULLs on account deletion, so the event actor goes null.
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deleted_time_entries",
    )

    class Meta:
        db_table = "timetracking_time_entry"
        indexes = [
            # Header today/week rollup + weekly grid read.
            models.Index(fields=["user", "entry_date"]),
            # Grid cell (task, date) upsert/aggregate.
            models.Index(fields=["user", "task", "entry_date"]),
            # Per-project sync delta pull (task → server_version).
            models.Index(fields=["task", "server_version"]),
        ]

    def __str__(self) -> str:
        return f"TimeEntry({self.user_id}, {self.minutes}m, {self.entry_date})"

    def soft_delete(self, *, actor: Any | None = None) -> None:
        """Stamp ``deleted_at``/``deleted_by`` before delegating to the base soft-delete.

        Mirrors ``Dependency.soft_delete()``'s stamping (issue #1888): the base
        ``VersionedModel.soft_delete()`` persists the whole row, so setting these two
        fields first writes them in the same UPDATE that flips ``is_deleted``. Without
        the timestamp the activity stream could not order or surface the ``time_deleted``
        event, so a removed entry vanished from the ``time_logged`` feed with no trace.
        """
        self.deleted_at = timezone.now()
        self.deleted_by = actor
        super().soft_delete()


class ActiveTimer(models.Model):
    """The running stopwatch — transient live state, deliberately NOT versioned (ADR-0185 §2).

    Elapsed time is derived (``now - started_at``); the row carries no logged fact, so
    syncing it as versioned WatermelonDB rows would churn for a value the client
    recomputes locally. The ``OneToOneField(user)`` is the singleton guarantee — a user
    has at most one running timer at the DB level (cleaner than a partial unique on a
    status flag). ``stop`` finalizes it into a ``TimeEntry`` and *deletes* this row
    (no tombstone to sync); it is recovered after a reload via ``GET /me/timer/``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="active_timer",
    )
    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="+",
    )
    started_at = models.DateTimeField()
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "timetracking_active_timer"

    def __str__(self) -> str:
        return f"ActiveTimer({self.user_id} -> {self.task_id})"


class TimesheetSubmission(models.Model):
    """A contributor's "I marked this week done" signal — a per-user-per-week marker (ADR-0224).

    Deliberately **not** a :class:`VersionedModel` (mirrors :class:`ActiveTimer`): submitting a
    week is an inherently *online* action on a web-first surface, and the row carries no field a
    client edits offline, so WatermelonDB version/tombstone machinery would churn sync for a
    boolean-shaped signal. It is the whole submission state machine 0.4 ships — no approver, no
    lock, no return; the 0.5 approval epic (#100) reads or extends this row's existence +
    ``submitted_at`` as its "Submitted" signal without migrating :class:`TimeEntry`.

    ``week_start`` is canonicalized to the ISO Monday by the view before write, so the
    ``(user, week_start)`` uniqueness cannot fragment into off-by-a-day rows. Un-submit hard-
    deletes the row (no tombstone — not sync-eligible).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="timesheet_submissions",
    )
    week_start = models.DateField()
    submitted_at = models.DateTimeField()

    class Meta:
        db_table = "timetracking_timesheet_submission"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "week_start"],
                name="uniq_timesheet_submission_user_week",
            ),
        ]

    def __str__(self) -> str:
        return f"TimesheetSubmission({self.user_id}, week of {self.week_start})"
