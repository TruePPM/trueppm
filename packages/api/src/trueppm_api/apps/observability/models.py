"""Models for Beat liveness observability (ADR-0081)."""

from __future__ import annotations

import uuid

from django.db import models


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
