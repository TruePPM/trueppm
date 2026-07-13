"""Read-only aggregation for the System Health overview (#692, ADR-0172).

Composes existing durable-execution signals into a single payload for the
workspace-admin overview dashboard. Pure reads — no writes, no dispatch — so
the whole module is safe to call on a 10 s refresh interval.

Each of the five operator-facing components reports one of four statuses:

* ``ok``      — healthy, nothing to do.
* ``warn``    — needs attention (e.g. dead-lettered tasks parked).
* ``crit``    — broken now (e.g. Beat heartbeat stale).
* ``unknown`` — no backing telemetry exists yet; rendered muted, **never** as an
  error. Only the Retention-purge component is ``unknown`` today, because OSS
  records no purge-run history (resolved when #693 lands that model).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from celery.schedules import crontab
from django.conf import settings
from django.db.models import Count, Q
from django.utils import timezone

from trueppm_api.apps.notifications.models import Notification
from trueppm_api.apps.observability.models import BeatHeartbeat, PurgeRun
from trueppm_api.apps.observability.retention import resolve_retention_map
from trueppm_api.apps.scheduling.models import (
    FailedTask,
    FailedTaskStatus,
    ScheduleRequest,
    ScheduleRequestStatus,
)
from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus

# Status literals shared with the frontend contract (ADR-0172).
STATUS_OK = "ok"
STATUS_WARN = "warn"
STATUS_CRIT = "crit"
STATUS_UNKNOWN = "unknown"

# Per-dependency readiness literals for the unauthenticated /readyz probe (#1894).
# Deliberately coarse — "ok"/"fail" only — so the response never leaks connection
# strings, host names, or driver error text to an unauthenticated caller.
READY_OK = "ok"
READY_FAIL = "fail"

# Upper bound on the readiness DB probe so a wedged/slow database fails the probe
# fast (503) instead of hanging kubelet's readiness call. Two seconds is well
# under a typical kubelet ``timeoutSeconds`` while tolerating a brief blip.
_READY_DB_STATEMENT_TIMEOUT_MS = 2000

# Cache key the readiness probe writes-then-reads to prove a live round-trip to
# Valkey/Redis. Namespaced and short-lived; value is irrelevant.
_READY_CACHE_KEY = "trueppm:readyz:probe"

_SINGLETON_KEY = 1

# A dispatched outbox row younger than this may simply be in flight (the row is
# written before the on_commit dispatch fires), so we don't flag it as stuck.
# Matches the schedule-request drain orphan window.
_OUTBOX_STUCK_THRESHOLD = timedelta(minutes=10)

# A notification still pending after this many failed attempts/age is "stuck".
# The Notification row has no terminal DEAD state, so dispatcher health is a
# heuristic, not an exact signal (ADR-0172 §3).
_NOTIFICATION_STUCK_THRESHOLD = timedelta(hours=1)

# A dead-letter parked longer than this escalates the component from warn→crit.
_DEAD_LETTER_CRIT_THRESHOLD = timedelta(hours=24)

# Retention settings surfaced read-only on the overview (ADR-0172 §2). Each maps
# a settings key to a human label and a unit. ``None`` means purge is disabled.
_RETENTION_KEYS: list[tuple[str, str, str]] = [
    ("TRUEPPM_WEBHOOK_RETENTION_DAYS", "Webhook deliveries", "days"),
    ("TRUEPPM_IMPORT_RETENTION_DAYS", "Import requests", "days"),
    ("HISTORY_RETENTION_DAYS", "Event history", "days"),
    ("TASK_RUN_RETENTION_DAYS", "Task runs", "days"),
    ("TRUEPPM_SYNC_BATCH_RETENTION_HOURS", "Sync batches", "hours"),
]


def _component(key: str, label: str, status: str, state_label: str, meta: str) -> dict[str, str]:
    return {
        "key": key,
        "label": label,
        "status": status,
        "state_label": state_label,
        "meta": meta,
    }


def _humanize_schedule(schedule: object) -> str:
    """Render a Beat schedule entry as an operator-readable cadence string.

    Handles the two forms used in ``CELERY_BEAT_SCHEDULE``: numeric/timedelta
    intervals (the 30 s/60 s drains) and ``crontab`` instances (the nightly and
    hourly purges). All cron times are UTC — Beat runs on UTC (ADR-0081).
    """
    if isinstance(schedule, crontab):
        hours = sorted(schedule.hour)
        minutes = sorted(schedule.minute)
        # An all-hours cron (e.g. crontab(minute=5)) is hourly; a single-hour
        # cron is a once-daily run.
        if len(hours) >= 24 and len(minutes) == 1:
            return f"hourly at :{minutes[0]:02d}"
        if len(hours) == 1 and len(minutes) == 1:
            return f"daily {hours[0]:02d}:{minutes[0]:02d} UTC"
        return "scheduled (cron)"

    if isinstance(schedule, timedelta):
        seconds = schedule.total_seconds()
    elif isinstance(schedule, (int, float)):
        seconds = float(schedule)
    else:
        return "scheduled"

    if seconds < 60:
        return f"every {int(seconds)}s"
    if seconds < 3600:
        return f"every {int(seconds // 60)}m"
    return f"every {int(seconds // 3600)}h"


def _categorize(task: str) -> str:
    """Bucket a Beat task into an operator category for the reference list."""
    if "heartbeat" in task:
        return "heartbeat"
    if "drain" in task:
        return "drain"
    if "purge" in task or "archive" in task:
        return "purge"
    if "burndown" in task or "snapshot" in task:
        return "snapshot"
    return "other"


def _scheduled_tasks() -> list[dict[str, str]]:
    """Static view of the configured Beat schedule (name · cadence · category).

    This is the *configured* schedule, not per-task last-run status — TruePPM
    records only a single global heartbeat, not per-task execution times
    (ADR-0172 §4). Overall Beat liveness is answered by the heartbeat panel.
    """
    rows: list[dict[str, str]] = []
    for name, entry in settings.CELERY_BEAT_SCHEDULE.items():
        task = str(entry.get("task", ""))
        rows.append(
            {
                "name": name,
                "task": task,
                "cadence": _humanize_schedule(entry.get("schedule")),
                "category": _categorize(task),
            }
        )
    rows.sort(key=lambda r: (r["category"], r["name"]))
    return rows


def _beat_status() -> tuple[dict[str, Any], dict[str, str]]:
    """Return (beat panel payload, Celery Beat component card)."""
    row = BeatHeartbeat.objects.filter(singleton_key=_SINGLETON_KEY).first()
    threshold = settings.TRUEPPM_BEAT_STALE_SECONDS

    if row is None:
        panel: dict[str, Any] = {
            "last_heartbeat": None,
            "seconds_since": None,
            "stale": True,
            "stale_threshold_seconds": threshold,
        }
        card = _component(
            "celery_beat", "Celery Beat", STATUS_CRIT, "No heartbeat", "never recorded"
        )
        return panel, card

    seconds_since = int((timezone.now() - row.last_heartbeat).total_seconds())
    stale = seconds_since > threshold
    panel = {
        "last_heartbeat": row.last_heartbeat,
        "seconds_since": seconds_since,
        "stale": stale,
        "stale_threshold_seconds": threshold,
    }
    card = _component(
        "celery_beat",
        "Celery Beat",
        STATUS_CRIT if stale else STATUS_OK,
        "Stale" if stale else "Live",
        f"beat {seconds_since}s ago",
    )
    return panel, card


def _outbox_card() -> dict[str, str]:
    """Health of the transactional outbox dispatchers (CPM + workflow steps)."""
    cutoff = timezone.now() - _OUTBOX_STUCK_THRESHOLD

    sched = ScheduleRequest.objects.aggregate(
        dead=Count("id", filter=Q(status=ScheduleRequestStatus.DEAD)),
        stuck=Count(
            "id",
            filter=Q(status=ScheduleRequestStatus.DISPATCHED, dispatched_at__lt=cutoff),
        ),
    )
    wf = WorkflowOutboxRow.objects.aggregate(
        dead=Count("id", filter=Q(status=WorkflowOutboxStatus.DEAD)),
        stuck=Count(
            "id",
            filter=Q(status=WorkflowOutboxStatus.DISPATCHED, dispatched_at__lt=cutoff),
        ),
    )
    dead = (sched["dead"] or 0) + (wf["dead"] or 0)
    stuck = (sched["stuck"] or 0) + (wf["stuck"] or 0)

    if dead:
        status = STATUS_CRIT
        state = f"{dead} dead"
    elif stuck:
        status = STATUS_WARN
        state = f"{stuck} stuck"
    else:
        status = STATUS_OK
        state = "Healthy"
    return _component(
        "outbox_dispatcher", "Outbox dispatcher", status, state, f"{dead} dead, {stuck} stuck >10m"
    )


def _dead_letter() -> tuple[dict[str, Any], dict[str, str]]:
    """Return (dead-letter summary payload, Dead-letter component card)."""
    by_status_rows = FailedTask.objects.values("status").annotate(n=Count("id")).order_by("status")
    by_status = {row["status"]: row["n"] for row in by_status_rows}
    parked = by_status.get(FailedTaskStatus.DEAD, 0)

    oldest_age_seconds: int | None = None
    top_cause: str | None = None
    if parked:
        dead_qs = FailedTask.objects.filter(status=FailedTaskStatus.DEAD)
        oldest = dead_qs.order_by("last_failed_at").values_list("last_failed_at", flat=True).first()
        if oldest is not None:
            oldest_age_seconds = int((timezone.now() - oldest).total_seconds())
        cause_row = (
            dead_qs.values("exception_type")
            .annotate(n=Count("id"))
            .order_by("-n", "exception_type")
            .first()
        )
        if cause_row is not None:
            top_cause = cause_row["exception_type"]

    summary = {
        "parked": parked,
        "oldest_age_seconds": oldest_age_seconds,
        "top_cause": top_cause,
        "by_status": {
            FailedTaskStatus.DEAD: by_status.get(FailedTaskStatus.DEAD, 0),
            FailedTaskStatus.PENDING_RETRY: by_status.get(FailedTaskStatus.PENDING_RETRY, 0),
            FailedTaskStatus.DISMISSED: by_status.get(FailedTaskStatus.DISMISSED, 0),
            FailedTaskStatus.RETRIED: by_status.get(FailedTaskStatus.RETRIED, 0),
        },
    }

    if (
        parked
        and oldest_age_seconds is not None
        and (oldest_age_seconds > _DEAD_LETTER_CRIT_THRESHOLD.total_seconds())
    ):
        status, state = STATUS_CRIT, f"{parked} parked"
    elif parked:
        status, state = STATUS_WARN, f"{parked} parked"
    else:
        status, state = STATUS_OK, "Clear"
    meta = f"oldest {_format_age(oldest_age_seconds)}" if parked else "no parked tasks"
    card = _component("dead_letter", "Dead-letter alerting", status, state, meta)
    return summary, card


def _notification_card() -> dict[str, str]:
    """Heuristic health of the notification email dispatcher.

    The ``Notification`` row carries no terminal DEAD state — a stuck email just
    accumulates ``email_attempts`` and an ``email_failed_at`` indefinitely. So
    we infer "stuck" from pending rows that have already failed at least once
    and are older than the threshold (ADR-0172 §3).
    """
    cutoff = timezone.now() - _NOTIFICATION_STUCK_THRESHOLD
    stuck = Notification.objects.filter(
        email_pending=True,
        email_attempts__gt=0,
        email_failed_at__lt=cutoff,
    ).count()
    if stuck:
        return _component(
            "notification_dispatcher",
            "Notification dispatcher",
            STATUS_WARN,
            f"{stuck} stuck",
            f"{stuck} failed-pending >1h",
        )
    return _component(
        "notification_dispatcher",
        "Notification dispatcher",
        STATUS_OK,
        "Draining",
        "0 failed-pending",
    )


def _retention() -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Return (retention config rows, Retention-purge component card).

    Values reflect operator overrides (ADR-0173) layered over the ADR-0081
    settings defaults. The card is derived from the latest non-dry-run ``PurgeRun``:
    ``unknown`` until the first run is recorded, then ``ok``/``warn``/``crit`` from
    its outcome — this is what resolves ADR-0172 §3's perpetually-unknown card.
    """
    resolved = resolve_retention_map()
    rows: list[dict[str, Any]] = []
    for key, label, unit in _RETENTION_KEYS:
        value = resolved.get(key)
        rows.append(
            {
                "key": key,
                "label": label,
                "unit": unit,
                "value": value,
                "disabled": value is None,
            }
        )

    last = (
        PurgeRun.objects.exclude(trigger=PurgeRun.Trigger.DRY_RUN).order_by("-started_at").first()
    )
    if last is None:
        card = _component(
            "retention_purge",
            "Retention purge",
            STATUS_UNKNOWN,
            "No telemetry",
            "no purge run recorded yet",
        )
        return rows, card

    age = _format_age(int((timezone.now() - last.started_at).total_seconds()))
    if last.state == PurgeRun.State.FAILED:
        status, state_label = STATUS_CRIT, "Last run failed"
    elif last.state == PurgeRun.State.PARTIAL:
        status, state_label = STATUS_WARN, "Last run partial"
    elif last.state == PurgeRun.State.RUNNING:
        status, state_label = STATUS_OK, "Running"
    else:
        status, state_label = STATUS_OK, "Healthy"
    card = _component(
        "retention_purge",
        "Retention purge",
        status,
        state_label,
        f"last purge {age} ago · {last.rows_deleted:,} rows",
    )
    return rows, card


def _format_age(seconds: int | None) -> str:
    """Compact relative-age string, e.g. '2h20m' or '45s'."""
    if seconds is None:
        return "—"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60}m"
    return f"{seconds // 86400}d"


def _probe_database() -> bool:
    """Prove the primary database is reachable with a bounded ``SELECT 1``.

    Wrapped in a transaction so ``SET LOCAL statement_timeout`` scopes to this
    probe only (it resets at commit/rollback) — a hung or slow database trips the
    timeout and returns ``False`` fast rather than blocking the readiness call.
    Any driver/OperationalError is swallowed into ``False``: the caller only needs
    a boolean, and the exception text must never reach an unauthenticated client.
    """
    from django.db import connection, transaction

    try:
        with transaction.atomic(), connection.cursor() as cursor:
            # statement_timeout is PostgreSQL-only; guard so a non-PG test
            # backend (e.g. sqlite) still runs the SELECT 1 round-trip.
            if connection.vendor == "postgresql":
                cursor.execute(
                    "SET LOCAL statement_timeout = %s",
                    [_READY_DB_STATEMENT_TIMEOUT_MS],
                )
            cursor.execute("SELECT 1")
            return bool(cursor.fetchone() == (1,))
    except Exception:  # any failure means "not ready", by design
        return False


def _probe_cache() -> bool:
    """Prove the Valkey/Redis cache is reachable with a write-then-read round-trip.

    A bare ``get`` can be served from a local layer or return ``None`` for a dead
    backend without erroring, so we ``set`` then ``get`` to force an actual round
    trip. The channel layer shares the same Valkey instance (different logical db),
    so cache reachability is a sufficient proxy for real-time readiness too. Any
    backend error is swallowed into ``False`` — see ``_probe_database``.
    """
    from django.core.cache import cache

    try:
        cache.set(_READY_CACHE_KEY, "1", timeout=5)
        return bool(cache.get(_READY_CACHE_KEY) == "1")
    except Exception:  # any failure means "not ready", by design
        return False


def get_readiness() -> tuple[bool, dict[str, str]]:
    """Probe every hard dependency and return ``(ready, per-dependency statuses)``.

    Backs the unauthenticated ``/api/v1/readyz`` Kubernetes readiness probe
    (#1894): a pod is Ready only when both the database and the Valkey/Redis cache
    answer a live round-trip. Statuses are coarse ``ok``/``fail`` strings so the
    body carries no sensitive infrastructure detail.
    """
    checks = {
        "database": READY_OK if _probe_database() else READY_FAIL,
        "cache": READY_OK if _probe_cache() else READY_FAIL,
    }
    ready = all(state == READY_OK for state in checks.values())
    return ready, checks


def get_system_health() -> dict[str, Any]:
    """Aggregate the full System Health overview payload (ADR-0172 §2).

    Returns the component cards, Beat heartbeat panel + configured schedule,
    dead-letter summary, and read-only retention config. All reads are committed
    state, so the figures reflect work done by the Celery worker/Beat processes
    even though this is served by the web process.
    """
    beat_panel, beat_card = _beat_status()
    dead_letter_summary, dead_letter_card = _dead_letter()
    retention_rows, retention_card = _retention()

    return {
        "generated_at": timezone.now(),
        "components": [
            _outbox_card(),
            beat_card,
            dead_letter_card,
            _notification_card(),
            retention_card,
        ],
        "beat": beat_panel,
        "scheduled_tasks": _scheduled_tasks(),
        "dead_letter": dead_letter_summary,
        "retention": retention_rows,
    }
