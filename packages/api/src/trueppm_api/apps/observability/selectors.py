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

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, Any

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

if TYPE_CHECKING:  # annotation only — the probes import Django's migration
    from django.db.migrations.loader import MigrationLoader  # machinery lazily.

logger = logging.getLogger(__name__)

# Latch so the DB-ahead override warning is logged once per process rather than
# on every kubelet readiness call. See ``_warn_db_ahead_override_once``.
_db_ahead_override_warned = False

# First conclusive migration state this process observed, latched at the first
# readiness probe. It is what tells a rolled-back pod (booted into "ahead") apart
# from an old pod mid-rollout (booted "in_sync", drifted to "ahead") — a
# distinction the database cannot make. See ``_remember_first_migration_state``.
_first_migration_state: str | None = None

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

# Direction-of-drift literals for the readiness migration check (#2806). Reported
# alongside the coarse ``checks`` map as ``migration_state`` so an operator can tell
# a rolling-forward pod (``behind``) from a rolled-back one (``ahead``) without
# shelling into the pod. Still coarse by design — an enum, never a migration name,
# app label, or count, so the unauthenticated body stays free of internal detail.
READY_MIGRATIONS_IN_SYNC = "in_sync"
READY_MIGRATIONS_BEHIND = "behind"
READY_MIGRATIONS_AHEAD = "ahead"
READY_MIGRATIONS_UNKNOWN = "unknown"

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

# A notification email still queued after this long is not being drained. Measured
# against the IMMUTABLE ``created_at``, never against ``email_failed_at`` — see
# ``_notification_email_signals`` for why that distinction is the whole bug in #2886.
_NOTIFICATION_STUCK_THRESHOLD = timedelta(hours=1)

# Rolling window over which permanently-failed and successful sends are counted.
# Short enough that a resolved outage clears the card without operator action, long
# enough to survive the gaps between drain ticks and low-traffic periods.
_NOTIFICATION_FAILURE_WINDOW = timedelta(hours=1)

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


def notification_email_signals() -> dict[str, Any]:
    """Compute the three notification-email health signals (#2886).

    The previous single signal was ``email_pending=True AND email_attempts>0 AND
    email_failed_at < now-1h``, and it was **mutually unsatisfiable exactly when SMTP
    was what had broken**. Two of its conjuncts are written by the same statement that
    ends a row's life: at ``email_attempts >= EMAIL_MAX_RETRIES`` the drain clears
    ``email_pending`` — so on a 30 s beat a row exhausts its three attempts in about
    90 seconds and leaves the ``email_pending=True`` half of the predicate roughly
    forty times before the one-hour half could ever be reached. And because
    ``email_failed_at`` was rewritten to ``now`` on *every* attempt, it could only age
    past an hour if Beat itself stopped — which ``TruePPMBeatStale`` already covers. A
    completely dead relay reported "Draining / ok" indefinitely, verified over four
    real drain ticks.

    The replacement is three signals, each of which is *positive evidence* of a
    specific failure rather than an inference from state that the failure path erases:

    ``queued_aging``
        ``email_pending=True`` and ``created_at`` older than the threshold. The age is
        measured on ``created_at``, which is ``auto_now_add`` and which **no code
        path ever writes again** — so unlike ``email_failed_at`` it cannot be reset
        out from under the comparison. The drain's only two exits from
        ``email_pending=True`` are a success and an attempt-exhaustion, both of which
        occur within the 5-minute orphan window plus three ticks (~6 min 30 s). A row
        still pending at one hour therefore means rows are not being completed at all:
        Beat is dead, the worker is gone, or the transport cannot even be built (the
        #2886 item-2 fail-closed path, which deliberately leaves rows pending rather
        than burning their retries).

    ``failed_recent``
        The terminal state, derived with no new column: ``email_pending=False`` and
        ``email_sent_at IS NULL`` and ``email_attempts >= EMAIL_MAX_RETRIES`` and
        ``email_failed_at`` within the window. Every one of those four conjuncts is
        asserted by the single ``UPDATE`` the drain issues on the final failed
        attempt, so the terminal write cannot clear the evidence — it *is* the
        evidence. And the window wants ``email_failed_at`` to be **recent** rather
        than old, so the predicate becomes satisfiable at the instant of failure
        instead of requiring an hour of aging the failure path itself prevented.

    ``sent_recent``
        Successful sends in the same window. Paired with ``failed_recent`` this
        separates "some mail bounces" from "no mail is getting out at all", which is
        the dead-relay fingerprint and the only one that warrants ``crit``.

    ``transport``
        Read-derived transport classification (see
        ``notifications.email_backend.transport_status``). Names the cause when the
        configured credential cannot be decrypted, so an operator does not have to
        infer it from a backlog.

    A note on precision, since a health signal that over-claims is its own bug:
    ``failed_recent`` counts every notification whose email was permanently
    undeliverable, which includes causes that are not the relay — a recipient with no
    address on file, or a source comment deleted before the drain reached it. The card
    labels the count as failed sends, which is what it is; it does not claim the relay
    specifically. The relay verdict is the ``failed_recent > 0 and sent_recent == 0``
    conjunction.

    Returns:
        ``{"queued_aging": int, "failed_recent": int, "sent_recent": int,
        "transport": str}``.
    """
    from trueppm_api.apps.notifications.email_backend import transport_status
    from trueppm_api.apps.notifications.tasks import EMAIL_MAX_RETRIES

    now = timezone.now()
    stuck_cutoff = now - _NOTIFICATION_STUCK_THRESHOLD
    window_cutoff = now - _NOTIFICATION_FAILURE_WINDOW

    queued_aging = Notification.objects.filter(
        email_pending=True,
        email_sent_at__isnull=True,
        created_at__lt=stuck_cutoff,
    ).count()
    failed_recent = Notification.objects.filter(
        email_pending=False,
        email_sent_at__isnull=True,
        email_attempts__gte=EMAIL_MAX_RETRIES,
        email_failed_at__gte=window_cutoff,
    ).count()
    sent_recent = Notification.objects.filter(email_sent_at__gte=window_cutoff).count()

    return {
        "queued_aging": queued_aging,
        "failed_recent": failed_recent,
        "sent_recent": sent_recent,
        "transport": transport_status(),
    }


def _notification_card() -> dict[str, str]:
    """Health of the notification email dispatcher (#2886).

    Escalation order, most-specific cause first — see
    :func:`notification_email_signals` for what each signal proves:

    * ``crit`` — the configured transport's credential cannot be decrypted. No mail
      leaves the workspace until an operator re-enters it.
    * ``crit`` — mail permanently failed in the window and nothing succeeded in it.
      This is the dead-relay fingerprint.
    * ``warn`` — mail permanently failed, but other mail also got through.
    * ``warn`` — the queue is aging: rows have sat pending past the threshold, so
      nothing is completing them.
    * ``ok`` — no failures, no aging backlog, credential usable.
    """
    from trueppm_api.apps.notifications.email_backend import TRANSPORT_UNDECRYPTABLE

    signals = notification_email_signals()
    failed = int(signals["failed_recent"])
    sent = int(signals["sent_recent"])
    aging = int(signals["queued_aging"])

    def card(status: str, state_label: str, meta: str) -> dict[str, str]:
        return _component(
            "notification_dispatcher", "Notification dispatcher", status, state_label, meta
        )

    if signals["transport"] == TRANSPORT_UNDECRYPTABLE:
        return card(
            STATUS_CRIT,
            "Credential unusable",
            "the stored SMTP password cannot be decrypted — re-enter it",
        )
    if failed and not sent:
        return card(
            STATUS_CRIT,
            "Delivery failing",
            f"{failed} permanently failed in the last hour, 0 delivered",
        )
    if failed:
        return card(
            STATUS_WARN,
            f"{failed} failed",
            f"{failed} permanently failed, {sent} delivered in the last hour",
        )
    if aging:
        return card(
            STATUS_WARN,
            f"{aging} queued",
            f"{aging} still queued after >1h — the drain is not completing rows",
        )
    return card(STATUS_OK, "Draining", f"0 failed, {sent} delivered in the last hour")


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


def _has_migrations_unknown_to_image(loader: MigrationLoader) -> bool:
    """Report whether the database records migrations this image does not ship.

    This is the **DB-ahead** half of the readiness migration check, and it cannot
    be expressed as a migration plan: ``migration_plan()`` walks *this image's*
    graph, and a migration the image never shipped is not a node in that graph, so
    it can never appear in the plan no matter how the targets are chosen. Detecting
    a rolled-back image therefore has to compare the recorded rows against what is
    on disk, which is what this does (#2806).

    Two deliberate exclusions keep it from crying wolf:

    * **Squash-replaced originals.** The project squashes with ``replaces=`` and
      keeps the original migration files on disk, so their recorded rows normally
      resolve against ``disk_migrations`` directly. A recorded row is still treated
      as known when it is merely *named* in some disk migration's ``replaces=``
      list, so a future squash that does drop the originals cannot flip every pod
      to not-ready.
    * **Apps this image does not install.** Rows are only judged for app labels in
      ``loader.migrated_apps`` — the installed apps that have a migrations module.
      A row for an app that is absent from ``INSTALLED_APPS`` is ignored, because
      this image ships no code that reads those tables, so their schema cannot
      disagree with it. Flagging them would make two legitimate, safe operations
      permanently unready: removing an optional app from settings, and running the
      community image against a database an Enterprise image migrated (the
      Enterprise apps' tables sit inert, exactly like the additive-upgrade case).
      The cost of that posture is that a downgrade whose *only* difference is a
      dropped app goes undetected — accepted, since the surviving apps' schema is
      what this image's code actually touches.
    """
    known: set[tuple[str, str]] = set(loader.disk_migrations)
    for migration in loader.disk_migrations.values():
        # Indexed rather than unpacked: a hand-written ``replaces`` entry is
        # occasionally a list, and Django reads it positionally too.
        known.update((entry[0], entry[1]) for entry in migration.replaces or ())
    return any(
        key not in known for key in loader.applied_migrations if key[0] in loader.migrated_apps
    )


def _probe_migrations() -> str:
    """Classify how this image's migrations relate to the connected database.

    Returns one of ``in_sync`` / ``behind`` / ``ahead`` / ``unknown``. A pod is
    ready only on ``in_sync``; the other three keep it out of the Service.

    * ``behind`` — this image ships migrations the database has not applied. This
      is the rolling-*forward* window: the ``migrate`` init container is still
      bringing the schema up while old-image pods serve, and a new pod that took
      traffic now would error or write against a half-migrated schema (#2217).
      Detected with ``MigrationExecutor.migration_plan`` over the full leaf set —
      a non-empty plan means unapplied or in-flight steps.
    * ``ahead`` — the database records migrations this image does not ship. Two
      very different situations produce it: an image rolled back without restoring
      the schema, and an old pod still serving while a newer pod's ``migrate``
      moves the schema under it. The probe reports both identically because the
      database cannot tell them apart; ``get_readiness`` decides which one gates,
      from the state the process booted into. A plan is structurally blind to this
      state either way (see ``_has_migrations_unknown_to_image``), which is why it
      is a separate comparison rather than a wider target set.
    * ``unknown`` — the check itself failed. Any error is swallowed into a
      not-ready state, consistent with the DB and cache probes: no exception text
      may reach an unauthenticated client.

    Neither direction is a data-compatibility check. ``ahead`` says the recorded
    schema is newer than this code; it says nothing about whether a destructive
    migration already discarded data the old code needs. Rolling back across a
    destructive change still requires restoring the pre-upgrade backup.
    """
    from django.db import connection, transaction
    from django.db.migrations.executor import MigrationExecutor

    try:
        # Same envelope as ``_probe_database``, for two reasons. (1) ``ATOMIC_REQUESTS``
        # is on, so a failure in the loader's own queries would poison the request's
        # transaction and make the *database* probe that runs after this one report
        # ``fail`` for a healthy database — an operator sent chasing the wrong outage.
        # The savepoint keeps the failure local. (2) The loader reads the migration
        # table and the catalog unbounded otherwise; the timeout keeps a wedged
        # database from hanging kubelet's readiness call here too.
        with transaction.atomic(), connection.cursor() as cursor:
            if connection.vendor == "postgresql":
                cursor.execute(
                    "SET LOCAL statement_timeout = %s",
                    [_READY_DB_STATEMENT_TIMEOUT_MS],
                )
            executor = MigrationExecutor(connection)
            # A non-empty plan ⇒ steps this code expects are not applied yet.
            if executor.migration_plan(executor.loader.graph.leaf_nodes()):
                return READY_MIGRATIONS_BEHIND
            if _has_migrations_unknown_to_image(executor.loader):
                return READY_MIGRATIONS_AHEAD
            return READY_MIGRATIONS_IN_SYNC
    except Exception:  # any failure means "not ready", by design
        return READY_MIGRATIONS_UNKNOWN


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


def _remember_first_migration_state(state: str) -> str | None:
    """Latch the first conclusive migration state this process observed.

    This is what separates a **rolled-back** pod from an **old pod mid-rollout**,
    which the database alone cannot distinguish — both are "image older than the
    recorded schema". The difference is when the pod met that schema:

    * A pod that boots into ``ahead`` was started against a database already newer
      than its code. That is a rollback (or an old-image pod scaled up after the
      migration), and it must not take traffic.
    * A pod that booted ``in_sync`` and *drifted* to ``ahead`` is the ordinary
      forward rolling upgrade: the new pod's ``migrate`` init container moved the
      schema while this pod kept serving. Gating here would empty the Service of
      endpoints exactly when the new pods are not Ready yet — the outage
      expand-migrate-contract exists to avoid.

    ``unknown`` never latches: a probe that failed says nothing about which side of
    the schema this pod started on, and latching it would freeze the wrong verdict.
    """
    global _first_migration_state
    if _first_migration_state is None and state != READY_MIGRATIONS_UNKNOWN:
        _first_migration_state = state
    return _first_migration_state


def _warn_db_ahead_override_once() -> None:
    """Log the open DB-ahead gate once per process.

    Once, not per probe: kubelet calls readiness every ~10 s, and a line at that
    rate is noise an operator learns to filter — which would defeat the point.
    The module-level latch is deliberately not reset; a pod restart re-arms it,
    which is exactly when the posture is worth restating.
    """
    global _db_ahead_override_warned
    if _db_ahead_override_warned:
        return
    _db_ahead_override_warned = True
    logger.warning(
        "TRUEPPM_READYZ_ALLOW_DB_AHEAD is enabled and this pod is reporting ready "
        "with a database ahead of its image: it is serving older code against a "
        "newer recorded schema. Intended only for a rollback whose migrations have "
        "been classified as additive-only. Return the setting to false after "
        "rolling forward."
    )


def get_readiness() -> tuple[bool, dict[str, str], str]:
    """Probe every hard dependency; return ``(ready, statuses, migration_state)``.

    Backs the unauthenticated ``/api/v1/readyz`` Kubernetes readiness probe
    (#1894): a pod is Ready only when the database and the Valkey/Redis cache
    answer a live round-trip **and** its migrations agree with the recorded schema
    — a pod whose own migrations are not applied yet (#2217) and a pod that booted
    against a schema newer than its code (#2806) are both kept out of the Service.

    ``statuses`` stays a coarse ``ok``/``fail`` map — that contract is what the
    body's freedom from infrastructure detail rests on, and adding a reason there
    would break it. The migration drift direction is returned separately and
    surfaced as its own ``migration_state`` field, so an operator can tell "still
    migrating" from "this image is older than the schema" without a shell.

    ``ahead`` gates the pod **only when the pod booted into it**. A pod that
    started against a database already newer than its code is a rollback, and it
    must not take traffic; a pod that booted ``in_sync`` and drifted to ``ahead``
    is the ordinary forward rolling upgrade, where the new pod's ``migrate`` init
    container moves the schema while this one keeps serving. Gating the second
    case would empty the Service of endpoints at the exact moment the new pods are
    not Ready yet — a self-inflicted outage on every upgrade, and the reason
    expand-migrate-contract exists. ``_remember_first_migration_state`` holds that
    distinction, which the database alone cannot express.

    Even a gated ``ahead`` is a guess the probe cannot verify: it knows the schema
    is newer, not whether the old code can serve it. So
    ``TRUEPPM_READYZ_ALLOW_DB_AHEAD`` lets an operator who has read the release's
    migrations and classified them additive-only complete the image-only rollback
    the upgrade runbook recommends. Neither the latch nor the flag touches
    ``behind`` — nothing makes a half-migrated pod safe to serve.

    When the flag *is* suppressing an ``ahead`` state, ``checks["migrations"]``
    reads ``ok`` while ``migration_state`` reads ``ahead`` — deliberate, but it
    means every monitor that watches only ``status``/``checks`` (all of the
    existing ones, by the compatibility promise above) sees green on a pod
    knowingly serving older code against a newer schema. So the suppression also
    logs a WARNING, once per process: an override set during one incident must not
    silently cover the *next* rollback, which may be the destructive one.
    """
    migration_state = _probe_migrations()
    booted_into = _remember_first_migration_state(migration_state)
    ahead_gates = (
        migration_state == READY_MIGRATIONS_AHEAD and booted_into == READY_MIGRATIONS_AHEAD
    )
    override_in_use = ahead_gates and settings.TRUEPPM_READYZ_ALLOW_DB_AHEAD
    if override_in_use:
        _warn_db_ahead_override_once()
    migrations_ok = migration_state in (
        READY_MIGRATIONS_IN_SYNC,
        READY_MIGRATIONS_AHEAD,
    ) and (not ahead_gates or override_in_use)
    checks = {
        "database": READY_OK if _probe_database() else READY_FAIL,
        "cache": READY_OK if _probe_cache() else READY_FAIL,
        "migrations": READY_OK if migrations_ok else READY_FAIL,
    }
    ready = all(state == READY_OK for state in checks.values())
    return ready, checks, migration_state


def _telemetry() -> dict[str, Any]:
    """Read-only OpenTelemetry exporter posture for the System Health page (#2022).

    Surfaces whether OTLP export is live and the effective transport/sampler so an
    operator can confirm *from the app* why spans/metrics are (or are not) arriving,
    without shelling into the pod to read env. Pure ``settings`` reads — telemetry
    stays env/Helm-configured and is never writable here.

    ``OTEL_EXPORTER_OTLP_HEADERS`` is deliberately never included: it carries the
    export bearer token (``authorization=Bearer …``) and must not be disclosed even
    to an admin. ``enabled`` mirrors the bootstrap gate — export is live only when an
    endpoint is set *and* the master ``TRUEPPM_OTEL_ENABLED`` switch is on.
    """
    from trueppm_api.apps.observability.otel import provider

    endpoint = settings.OTEL_EXPORTER_OTLP_ENDPOINT.strip()
    enabled = bool(endpoint) and settings.TRUEPPM_OTEL_ENABLED
    return {
        "enabled": enabled,
        "endpoint": endpoint,
        "endpoint_configured": bool(endpoint),
        "protocol": settings.OTEL_EXPORTER_OTLP_PROTOCOL,
        "service_name": settings.OTEL_SERVICE_NAME,
        # Resource identity — the service.version / edition the canary and every
        # real span carry, so the operator can match this card to what lands in
        # their backend. Cheap: package metadata + a settings read.
        "service_version": provider.service_version(),
        "edition": str(getattr(settings, "TRUEPPM_EDITION", "community")),
        # Raw per-signal toggles — reported as configured, so an operator can see a
        # signal is switched off even while the overall exporter is live.
        "traces_enabled": settings.TRUEPPM_OTEL_TRACES_ENABLED,
        "metrics_enabled": settings.TRUEPPM_OTEL_METRICS_ENABLED,
        "sampler": settings.OTEL_TRACES_SAMPLER,
        "sampler_arg": settings.OTEL_TRACES_SAMPLER_ARG,
        # Live cluster export-health strip (ADR-0601, #2109). Additive block that
        # aggregates the worker/beat pods actually exporting. Skipped (available:
        # false) when export is off — the card shows the config posture there and
        # never renders the strip — so an unconfigured deployment pays no Valkey
        # round-trip on this read.
        "live": _export_health_live(enabled),
    }


def _export_health_live(enabled: bool) -> dict[str, Any]:
    """Aggregate cross-process OTLP export health for the live Telemetry strip.

    Returns ``{"available": False}`` when export is disabled or the metrics store is
    unreachable, so ``_telemetry()`` never fabricates a number: the FE keeps the
    config-only posture in that case. The ``state`` verdict is computed server-side
    (in :mod:`otel.export_health`) so the card and any API/agent consumer agree.
    """
    if not enabled:
        return {"available": False}
    from trueppm_api.apps.observability.otel import export_health

    return export_health.read_export_health(
        traces_enabled=settings.TRUEPPM_OTEL_TRACES_ENABLED,
        metrics_enabled=settings.TRUEPPM_OTEL_METRICS_ENABLED,
    )


def _security() -> dict[str, Any]:
    """Read-only security posture for the System Health page (ADR-0604).

    Currently surfaces whether API rate limiting is enabled. ``rate_limiting_enabled``
    is False only when an operator has both set ``TRUEPPM_RATE_LIMIT_ENABLED=false``
    and provided the acknowledgment (see :mod:`trueppm_api.core.ratelimit`) — i.e. all
    DRF throttling is off. Surfaced ONLY on this admin-gated endpoint, never on the
    public ``/health/`` / ``/readyz`` / ``/edition/`` probes, so a disabled protection
    is not advertised to anonymous callers. Pure settings read — deploy-time operator
    config, never writable here.
    """
    return {
        "rate_limiting_enabled": bool(getattr(settings, "RATE_LIMIT_ENABLED", True)),
    }


def get_system_health() -> dict[str, Any]:
    """Aggregate the full System Health overview payload (ADR-0172 §2).

    Returns the component cards, Beat heartbeat panel + configured schedule,
    dead-letter summary, read-only retention config, and read-only telemetry
    (OTel exporter) posture. All reads are committed state, so the figures reflect
    work done by the Celery worker/Beat processes even though this is served by the
    web process.
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
        "telemetry": _telemetry(),
        "security": _security(),
    }
