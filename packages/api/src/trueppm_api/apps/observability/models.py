"""Models for Beat liveness observability (ADR-0081) and the retention policy
editor + purge-run history (ADR-0173)."""

from __future__ import annotations

import uuid
from datetime import time

from django.db import models
from django.utils import timezone

from trueppm_api.apps.observability.retention import RETENTION_KEY_CHOICES


class BeatHeartbeat(models.Model):
    """Single-row liveness marker upserted by the ``beat.heartbeat`` task.

    A live Celery Beat process refreshes ``last_heartbeat`` every 30 s. A stale
    value means Beat (or the worker draining its queue) has stopped — every drain
    and purge runs from that single Beat process, so its death is a silent SPOF.
    Staleness is surfaced by ``GET /api/v1/health/beat/`` (primary, external) and
    the ``beat.check_stale_heartbeat`` WARNING log (secondary, in-cluster).

    The ``singleton_key`` unique constraint enforces exactly one row: every upsert
    targets ``singleton_key=1``, so concurrent heartbeats update rather than insert.
    Not a synced model — it carries no ``server_version`` and never reaches clients.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    singleton_key = models.PositiveSmallIntegerField(unique=True, default=1, editable=False)
    last_heartbeat = models.DateTimeField()

    def __str__(self) -> str:
        return f"BeatHeartbeat(last_heartbeat={self.last_heartbeat.isoformat()})"


class RetentionPolicy(models.Model):
    """Operator override for one ADR-0081 retention window (ADR-0173 §A).

    A row is an *override* layered over the ``settings.*`` default — its absence
    means "use the default", so a deployment that never opens the editor behaves
    exactly as before. ``enabled=False`` disables the purge (unbounded retention),
    mirroring the settings ``None`` semantics. ``value`` is in the window's native
    unit (days for four tables, hours for sync batches). Resolution goes through
    :func:`trueppm_api.apps.observability.retention.resolve_retention`.

    Not a synced model — operator config, never reaches clients, no
    ``server_version``. ``updated_at`` is a last-writer timestamp only; the full
    policy-change *audit trail* is the Enterprise overlay (trueppm-enterprise#137).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    key = models.CharField(max_length=64, unique=True, choices=RETENTION_KEY_CHOICES)
    enabled = models.BooleanField(default=True)
    value = models.PositiveIntegerField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "retention policies"

    def __str__(self) -> str:
        state = f"{self.value}" if self.enabled else "disabled"
        return f"RetentionPolicy({self.key}={state})"


class RetentionSchedule(models.Model):
    """Singleton config for when the consolidated purge coordinator runs (ADR-0173 §D).

    A single row (``singleton_key=1``) the coordinator self-gates on: it skips when
    ``frequency='off'``, before the configured ``time_of_day_utc`` window, or (when
    ``weekly``) on the wrong ``day_of_week``. ``on_failure`` decides whether a
    table error aborts the run (``stop``) or flags the table and continues
    (``continue``). All times are UTC with no DST shift — surfaced in the UI copy.
    Not a synced model.
    """

    class Frequency(models.TextChoices):
        DAILY = "daily", "Daily"
        WEEKLY = "weekly", "Weekly"
        OFF = "off", "Off"

    class OnFailure(models.TextChoices):
        CONTINUE = "continue", "Continue and flag the failed table"
        STOP = "stop", "Stop the run on first error"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    singleton_key = models.PositiveSmallIntegerField(unique=True, default=1, editable=False)
    frequency = models.CharField(max_length=8, choices=Frequency.choices, default=Frequency.DAILY)
    time_of_day_utc = models.TimeField(default=time(2, 0))
    # 0=Monday … 6=Sunday, matching datetime.weekday(). Only meaningful when weekly.
    day_of_week = models.PositiveSmallIntegerField(null=True, blank=True)
    on_failure = models.CharField(
        max_length=8, choices=OnFailure.choices, default=OnFailure.CONTINUE
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"RetentionSchedule({self.frequency} @ {self.time_of_day_utc} UTC)"


class PurgeRun(models.Model):
    """One unified retention-purge run across the six operational tables (ADR-0173 §B).

    The coordinator records a row per run — scheduled, manual, or dry-run — with a
    per-table breakdown in ``tables``. This is the backing for the "recent purges"
    log and flips the System Health Retention-purge card off ``unknown``
    (resolves ADR-0172 §3). The table is self-bounding: the coordinator trims to
    the most recent rows after each run, so it needs no separate retention knob.
    """

    class Trigger(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"
        MANUAL = "manual", "Manual"
        DRY_RUN = "dry_run", "Dry run"

    class State(models.TextChoices):
        RUNNING = "running", "Running"
        OK = "ok", "OK"
        PARTIAL = "partial", "Partial"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    started_at = models.DateTimeField(default=timezone.now, db_index=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    # default=SCHEDULED is self-documenting: every PurgeRun is written by the
    # coordinator, which always sets ``trigger`` explicitly, but the field-level
    # default makes the most common case (the periodic Celery beat run) obvious
    # without reading the writer (#841).
    trigger = models.CharField(max_length=10, choices=Trigger.choices, default=Trigger.SCHEDULED)
    state = models.CharField(max_length=8, choices=State.choices, default=State.RUNNING)
    # [{"key","label","rows","bytes","state","error"}] — one entry per attempted table.
    tables = models.JSONField(default=list)
    rows_deleted = models.PositiveIntegerField(default=0)
    bytes_freed = models.PositiveBigIntegerField(null=True, blank=True)
    error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-started_at"]

    def __str__(self) -> str:
        return f"PurgeRun({self.trigger} {self.state} @ {self.started_at.isoformat()})"
