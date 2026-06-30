"""Time-tracking domain models — logged effort and the running timer (ADR-0185 §2).

``TimeEntry`` is the durable, sync-eligible fact; ``ActiveTimer`` is transient live
state. The split is deliberate (ADR-0185 §2): a ticking timer is derived state, not a
logged fact, so it is *not* a ``VersionedModel`` and a stopped timer is hard-deleted,
not soft-deleted. Nothing here broadcasts — a time entry mutates no shared board state
(ADR-0185 §5).
"""

from __future__ import annotations

import uuid

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
