"""Celery tasks for Beat liveness observability (ADR-0081)."""

from __future__ import annotations

import logging

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# The fixed singleton row key — every heartbeat upsert targets this one row.
_SINGLETON_KEY = 1


def _do_heartbeat() -> None:
    """Business logic for beat.heartbeat — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.observability.models import BeatHeartbeat

    BeatHeartbeat.objects.update_or_create(
        singleton_key=_SINGLETON_KEY,
        defaults={"last_heartbeat": timezone.now()},
    )


def _do_check_stale() -> bool:
    """Business logic for beat.check_stale_heartbeat — extracted for testability.

    Returns True when the heartbeat is stale (or has never been recorded), logging
    a WARNING in that case. The primary detector is ``GET /api/v1/health/beat/``;
    this is a secondary in-cluster signal for deployments with no external monitor.
    A Beat-scheduled check (not a self-rescheduling worker chain) is used on purpose:
    it self-heals on Beat restart and cannot silently lose itself (ADR-0081 §B).
    """
    from django.conf import settings
    from django.utils import timezone

    from trueppm_api.apps.observability.models import BeatHeartbeat

    threshold = settings.TRUEPPM_BEAT_STALE_SECONDS
    row = BeatHeartbeat.objects.filter(singleton_key=_SINGLETON_KEY).first()
    if row is None:
        logger.warning("check_stale_heartbeat: no heartbeat recorded yet")
        return True

    age_seconds = (timezone.now() - row.last_heartbeat).total_seconds()
    if age_seconds > threshold:
        logger.warning(
            "check_stale_heartbeat: heartbeat is %.0fs old (threshold %ds) — "
            "Celery Beat may be down",
            age_seconds,
            threshold,
        )
        return True
    return False


@idempotent_task(
    lock_key_template="beat_heartbeat",
    lock_ttl=25,
    on_contention="skip",
    soft_time_limit=10,
    time_limit=20,
    acks_late=True,
    reject_on_worker_lost=True,
    name="beat.heartbeat",
)
def heartbeat(self: object) -> None:
    """Beat task: record a liveness heartbeat every 30 seconds."""
    _do_heartbeat()


@idempotent_task(
    lock_key_template="beat_check_stale_heartbeat",
    lock_ttl=50,
    on_contention="skip",
    soft_time_limit=10,
    time_limit=20,
    acks_late=True,
    reject_on_worker_lost=True,
    name="beat.check_stale_heartbeat",
)
def check_stale_heartbeat(self: object) -> None:
    """Beat task: log a WARNING when the heartbeat is stale (every 60 seconds)."""
    _do_check_stale()
