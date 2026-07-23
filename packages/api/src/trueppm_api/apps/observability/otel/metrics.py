"""OpenTelemetry native metric emission (ADR-0223 Phase 2, #710).

The Foundation (:mod:`.provider`, #708) built the metrics export pipeline — a
``MeterProvider`` with a ``PeriodicExportingMetricReader`` that pushes over OTLP —
but registers no application instruments. This module is Phase 2: it registers the
TruePPM-specific **observable gauges** that have no library auto-instrumentor, and
is called from ``ObservabilityConfig.ready()`` immediately after
:func:`~.instrumentation.instrument`.

Two of #710's four metric families live here as ``ObservableGauge`` instruments; a
third — the (synchronous) ``trueppm.task.duration_seconds`` histogram — was added
by #1917. The fourth, Django's ``http.server.*`` (request latency/count), comes
free from the library auto-instrumentor once a meter provider is threaded through
``instrument()``:

* ``trueppm.outbox.depth`` / ``trueppm.outbox.oldest_age_seconds`` — the live
  backlog and lag of the two transactional outboxes (CPM recompute + workflow
  step dispatch). Sourced from the same committed reads the System Health overview
  does (``observability.selectors``).
* ``trueppm.db.connections`` — server-side PostgreSQL backend count for the current
  database, by state, from ``pg_stat_activity``.
* ``trueppm.broker.queue.depth`` — the number of Celery messages *waiting* in the
  broker (Valkey/Redis), by queue, from ``LLEN`` (#1900). The ``outbox.*`` gauges
  measure the transactional-outbox **tables** (rows the dispatchers have not yet
  handed to Celery); this gauge measures the **broker backlog** downstream of them
  (messages Celery has accepted but no worker has picked up) — a distinct, and
  previously unmeasured, stage of the pipeline.
* ``trueppm.task.duration_seconds`` (#1917) — wall-clock duration of every Celery
  task execution, by task name and outcome. Distinct from (and additive to) the
  Celery auto-instrumentor's own ``flower.task.runtime.seconds``: that one only
  exists when ``CeleryInstrumentor`` is wired (Phase 1, #709) *and* a meter
  provider is bound, whereas this one is timed directly off the
  ``SchedulingConfig`` Celery-signal bridge, independent of the auto-instrumentor.

Two **synchronous** WS instruments also live here (#1900) — WebSocket/Channels
observability was spans-only, with no connection or fan-out signal:

* ``trueppm.ws.connections.active`` — an ``UpDownCounter`` incremented when a
  Channels consumer accepts a socket and decremented when it disconnects, via
  :func:`record_ws_connection_opened` / :func:`record_ws_connection_closed`.
* ``trueppm.ws.broadcast.count`` — a ``Counter`` incremented once per board-event
  fan-out at the broadcast point (``apps/sync/broadcast``), via
  :func:`record_ws_broadcast`.

**Observable vs synchronous.** The outbox/DB and broker gauges are
``ObservableGauge`` instruments: the SDK invokes each callback once per export
interval (default 60 s) on the reader's background thread. That means no per-request
cost and no need to hook every outbox transition — which a synchronous
``UpDownCounter`` would require. The two WS instruments and the task-duration
histogram *are* synchronous: a connection open/close, a broadcast, and a task
completion are discrete events with no shared state to poll — there is nothing for a
callback to read, so they are recorded at the event site instead. The WS instruments
are held as module globals set by :func:`install_metrics` and stay ``None`` (a cheap
no-op at the record site) whenever telemetry is disabled or metrics are off; the
task-duration ``Histogram`` behaves the same way.

**Cluster-wide — aggregate with ``max`` / ``last``, never ``sum``.** Every process
that runs ``ready()`` (web, Celery worker, Celery beat) registers these gauges and
reads the *same* shared state — PostgreSQL for the outbox/DB gauges, the Valkey
broker for ``broker.queue.depth`` — so each process emits the whole-cluster figure
as its own series (kept distinct by ``service.instance.id``). Summing across
instances multiplies the true value; dashboards and alerts must aggregate these
gauges with ``max`` or ``last``. The two synchronous WS instruments are the
exception: they count *per-process* events (this process's own sockets and
broadcasts), so they aggregate normally with ``sum``. This is called out in
``docs/administration/observability.md``.

**Best-effort and non-fatal.** Each callback is wrapped so a database hiccup yields
*no* observation for that cycle rather than raising on the exporter thread, and a
short server-side ``statement_timeout`` bounds the ``pg_stat_activity`` probe so a
slow database can never stall metric collection. Telemetry must never destabilise
the process it observes.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast

from django.db import DatabaseError, connections
from django.utils import timezone
from opentelemetry.metrics import Observation

from . import attributes
from .provider import get_meter

if TYPE_CHECKING:
    from opentelemetry.metrics import (
        CallbackOptions,
        Counter,
        Histogram,
        Meter,
        UpDownCounter,
    )

    from .provider import OTelBootstrapContext

logger = logging.getLogger(__name__)

# Metric-instrument names. Owned by this module (a namespace distinct from the
# attribute keys in :mod:`.attributes`); kept as constants so tests and docs refer
# to a single source of truth.
OUTBOX_DEPTH = "trueppm.outbox.depth"
OUTBOX_OLDEST_AGE = "trueppm.outbox.oldest_age_seconds"
DB_CONNECTIONS = "trueppm.db.connections"
BROKER_QUEUE_DEPTH = "trueppm.broker.queue.depth"
WS_CONNECTIONS_ACTIVE = "trueppm.ws.connections.active"
WS_BROADCAST_COUNT = "trueppm.ws.broadcast.count"
TASK_DURATION_SECONDS = "trueppm.task.duration_seconds"
RATELIMIT_ENABLED = "trueppm.ratelimit.enabled"

# Server-side statement timeout for the pg_stat_activity probe, so a slow or
# contended database can never stall the exporter's collection thread. It is set
# on the metrics thread's dedicated connection only.
_DB_PROBE_TIMEOUT_MS = 2_000

# Socket-level timeout (seconds) for the broker LLEN probe, so a slow or
# unreachable Valkey/Redis broker can never stall the exporter's collection
# thread — the broker analogue of _DB_PROBE_TIMEOUT_MS.
_BROKER_PROBE_TIMEOUT_S = 2.0

_installed = False

# Synchronous WS instruments, set once by install_metrics and left None when
# telemetry is disabled (the record_* helpers then no-op). Module globals rather
# than callback-registered because a socket open/close and a broadcast are discrete
# events recorded at the event site, not polled state.
_ws_connections: UpDownCounter | None = None
_ws_broadcasts: Counter | None = None

# The task-duration instrument, unlike the observable gauges above, is a plain
# (synchronous) Histogram: there is no "current value" a callback can sample —
# each Celery task execution is one observation, recorded by the SchedulingConfig
# Celery-signal bridge (task_prerun/task_postrun) at the moment it completes.
# None until install_metrics() creates it (i.e. metrics disabled, or not yet
# registered), which record_task_duration() treats as "nothing to record".
_task_duration_histogram: Histogram | None = None


def install_metrics(context: OTelBootstrapContext, *, meter_provider: Any = None) -> None:
    """Register the TruePPM observable gauges against the bootstrap context.

    Called from ``ObservabilityConfig.ready()`` after ``instrument()``. A strict
    no-op when telemetry is disabled or metrics are turned off, and idempotent
    across repeated ``ready()`` calls (test runner / autoreloader), mirroring the
    Foundation's cost profile.

    Args:
        context: The context from ``provider.bootstrap()``. When ``context.enabled``
            is ``False`` or ``context.meter_provider`` is ``None`` (metrics off),
            this returns immediately without registering any instrument.
        meter_provider: Provider to obtain the meter from. Defaults to the process
            global (which ``bootstrap()`` already set to ``context.meter_provider``);
            a test overrides it to read from an in-memory metric reader.
    """
    global _installed, _ws_connections, _ws_broadcasts, _task_duration_histogram
    if _installed:
        return
    if not context.enabled or context.meter_provider is None:
        return

    meter = _resolve_meter(meter_provider)
    meter.create_observable_gauge(
        OUTBOX_DEPTH,
        callbacks=[_observe_outbox_depth],
        unit="{row}",
        description="Live backlog of a transactional outbox — rows not yet done, by state.",
    )
    meter.create_observable_gauge(
        OUTBOX_OLDEST_AGE,
        callbacks=[_observe_outbox_oldest_age],
        unit="s",
        description="Age of the oldest not-yet-done row in a transactional outbox (0 when empty).",
    )
    meter.create_observable_gauge(
        DB_CONNECTIONS,
        callbacks=[_observe_db_connections],
        unit="{connection}",
        description="Server-side PostgreSQL backend count for the current database, by state.",
    )
    meter.create_observable_gauge(
        BROKER_QUEUE_DEPTH,
        callbacks=[_observe_broker_queue_depth],
        unit="{message}",
        description="Celery messages waiting in the broker (Valkey/Redis) LLEN, by queue.",
    )
    meter.create_observable_gauge(
        RATELIMIT_ENABLED,
        callbacks=[_observe_ratelimit_enabled],
        unit="{status}",
        description=(
            "1 when API rate limiting is enabled, 0 when an operator has disabled it (ADR-0604)."
        ),
    )
    # UpDownCounter (not a gauge): active WS connections is a running total mutated
    # by discrete +1/-1 events at the consumer, with no shared state to poll.
    _ws_connections = meter.create_up_down_counter(
        WS_CONNECTIONS_ACTIVE,
        unit="{connection}",
        description="Active WebSocket connections accepted by this process's Channels consumers.",
    )
    # Counter (monotonic): board-event fan-outs at the broadcast point, so an
    # operator can see real-time push volume and rate.
    _ws_broadcasts = meter.create_counter(
        WS_BROADCAST_COUNT,
        unit="{broadcast}",
        description="WebSocket board-event broadcasts fanned out to a project group.",
    )
    _task_duration_histogram = meter.create_histogram(
        TASK_DURATION_SECONDS,
        unit="s",
        description=(
            "Celery task execution wall-clock duration, from task_prerun to "
            "task_postrun, by task name and outcome (#1917)."
        ),
    )
    _installed = True
    logger.info("OpenTelemetry native metrics registered (8 instruments)")


def _resolve_meter(meter_provider: Any) -> Meter:
    """Return the meter to register instruments on (test seam via meter_provider)."""
    if meter_provider is not None:
        return cast("Meter", meter_provider.get_meter(attributes.NAMESPACE))
    return get_meter(attributes.NAMESPACE)


# --- Observable-gauge callbacks --------------------------------------------
# Each is invoked once per export interval on the reader's background thread and
# returns the current sample. All DB access is wrapped: a DatabaseError yields no
# observation for the cycle (a gap), never an exception on the exporter thread.


def _observe_outbox_depth(options: CallbackOptions) -> Iterable[Observation]:
    """Current not-done backlog per (outbox, lifecycle state)."""
    try:
        rows = _outbox_depth_rows()
    except DatabaseError:
        logger.debug("outbox depth probe skipped (database error)", exc_info=True)
        return []
    return [
        Observation(count, {attributes.OUTBOX_NAME: name, attributes.OUTBOX_STATE: state})
        for name, state, count in rows
    ]


def _observe_outbox_oldest_age(options: CallbackOptions) -> Iterable[Observation]:
    """Age in seconds of the oldest not-done row per outbox (0 when empty)."""
    try:
        rows = _outbox_oldest_age_rows()
    except DatabaseError:
        logger.debug("outbox oldest-age probe skipped (database error)", exc_info=True)
        return []
    return [Observation(age, {attributes.OUTBOX_NAME: name}) for name, age in rows]


def _observe_db_connections(options: CallbackOptions) -> Iterable[Observation]:
    """Server-side PostgreSQL backend count for the current database, by state."""
    try:
        rows = _db_connection_rows()
    except DatabaseError:
        logger.debug("db connections probe skipped (database error)", exc_info=True)
        return []
    return [Observation(count, {attributes.DB_STATE: state}) for state, count in rows]


def _observe_broker_queue_depth(options: CallbackOptions) -> Iterable[Observation]:
    """Waiting Celery message count per broker queue (LLEN), or no observation on error.

    Catches ``Exception`` (broad), not ``DatabaseError``: the probe talks to the
    Valkey/Redis broker via redis-py, whose failure modes (``ConnectionError``,
    ``TimeoutError``, ``RedisError``) are unrelated to Django's DB exceptions. Any
    of them must yield a gap for the cycle, never propagate onto the exporter thread.
    """
    try:
        rows = _broker_queue_depth_rows()
    except Exception:
        logger.debug("broker queue depth probe skipped (broker error)", exc_info=True)
        return []
    return [Observation(depth, {attributes.BROKER_QUEUE: name}) for name, depth in rows]


def _observe_ratelimit_enabled(options: CallbackOptions) -> Iterable[Observation]:
    """1 when API rate limiting is enabled, 0 when an operator has disabled it (ADR-0604).

    A static config flag, not a probe — no DB/Redis access — so operators can alert
    on ``trueppm.ratelimit.enabled == 0`` (all DRF throttling off).
    """
    from django.conf import settings

    enabled = getattr(settings, "RATE_LIMIT_ENABLED", True)
    return [Observation(1 if enabled else 0, {})]


# --- Synchronous histogram: task duration (#1917) --------------------------


def record_task_duration(task_name: str, duration_seconds: float, outcome: str) -> None:
    """Record one Celery task execution into the ``trueppm.task.duration_seconds`` histogram.

    Called from the Celery-framework signal bridge in
    ``SchedulingConfig.ready()`` (``task_prerun``/``task_postrun``) — those are
    process-wide Celery signals, so this fires for every task that runs in the
    process, not only tasks the scheduling app defines. Adds no query: the
    duration is timed in-process between the two signals and passed in.

    A no-op when metrics are disabled or not yet registered — install_metrics()
    only creates ``_task_duration_histogram`` when a meter provider is bound, so
    the default (telemetry-off) deployment pays nothing per task beyond this
    early return. Recording is wrapped so an exporter/SDK error can never
    surface as (or cause) a failure in the task whose duration it is reporting.

    Args:
        task_name: The Celery task's registered name (e.g. ``scheduling.recalculate``).
        duration_seconds: Wall-clock time from ``task_prerun`` to ``task_postrun``.
        outcome: Lower-cased terminal Celery state for this execution, e.g.
            ``success`` | ``failure`` | ``retry`` | ``rejected`` | ``ignored``.
    """
    if _task_duration_histogram is None:
        return
    try:
        _task_duration_histogram.record(
            duration_seconds,
            {
                attributes.CELERY_TASK_NAME: task_name,
                attributes.CELERY_TASK_OUTCOME: outcome,
            },
        )
    except Exception:
        logger.debug("task duration recording skipped (metric error)", exc_info=True)


# --- Sampling queries (imported lazily so a disabled deployment stays light) ---
# The outbox counts mirror observability.selectors' System Health reads: PENDING +
# DISPATCHED are the live, not-yet-terminal backlog (DONE / DEAD are terminal —
# DEAD is surfaced by the dead-letter signal, not counted as depth here).


def _outbox_depth_rows() -> list[tuple[str, str, int]]:
    """Return (outbox, state, count) for each outbox × {pending, dispatched}."""
    from django.db.models import Count, Q

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
    from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus

    sched = ScheduleRequest.objects.aggregate(
        pending=Count("id", filter=Q(status=ScheduleRequestStatus.PENDING)),
        dispatched=Count("id", filter=Q(status=ScheduleRequestStatus.DISPATCHED)),
    )
    wf = WorkflowOutboxRow.objects.aggregate(
        pending=Count("id", filter=Q(status=WorkflowOutboxStatus.PENDING)),
        dispatched=Count("id", filter=Q(status=WorkflowOutboxStatus.DISPATCHED)),
    )
    return [
        ("schedule", "pending", sched["pending"] or 0),
        ("schedule", "dispatched", sched["dispatched"] or 0),
        ("workflow", "pending", wf["pending"] or 0),
        ("workflow", "dispatched", wf["dispatched"] or 0),
    ]


def _outbox_oldest_age_rows() -> list[tuple[str, float]]:
    """Return (outbox, oldest-not-done-age-seconds) for each outbox (0 when empty).

    The two outboxes timestamp their rows on different fields — ``ScheduleRequest``
    uses ``requested_at``, ``WorkflowOutboxRow`` uses ``created_at`` — so the oldest
    row is found on the correct column for each.
    """
    from django.db.models import Min

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
    from trueppm_api.apps.workflow_engine.models import WorkflowOutboxRow, WorkflowOutboxStatus

    now = timezone.now()
    sched_non_terminal = [ScheduleRequestStatus.PENDING, ScheduleRequestStatus.DISPATCHED]
    wf_non_terminal = [WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.DISPATCHED]

    oldest_sched = ScheduleRequest.objects.filter(status__in=sched_non_terminal).aggregate(
        oldest=Min("requested_at")
    )["oldest"]
    oldest_wf = WorkflowOutboxRow.objects.filter(status__in=wf_non_terminal).aggregate(
        oldest=Min("created_at")
    )["oldest"]
    return [
        ("schedule", _age_seconds(now, oldest_sched)),
        ("workflow", _age_seconds(now, oldest_wf)),
    ]


def _age_seconds(now: datetime, timestamp: datetime | None) -> float:
    """Non-negative age of ``timestamp`` relative to ``now``; 0.0 when ``None``."""
    if timestamp is None:
        return 0.0
    return max(0.0, (now - timestamp).total_seconds())


def _db_connection_rows() -> list[tuple[str, int]]:
    """Return (state-bucket, backend-count) from pg_stat_activity for this database.

    Runs on the exporter's collection thread against that thread's own persistent
    Django connection. A short ``statement_timeout`` bounds the probe. Raw
    ``pg_stat_activity.state`` values collapse into four low-cardinality buckets so
    the metric never explodes dimension count.
    """
    conn = connections["default"]
    with conn.cursor() as cursor:
        # set_config() accepts a bind parameter where bare SET does not, so the
        # timeout is passed as a parameter rather than interpolated into SQL.
        # is_local=false keeps it session-scoped, matching SET statement_timeout.
        cursor.execute(
            "SELECT set_config('statement_timeout', %s, false)",
            [str(int(_DB_PROBE_TIMEOUT_MS))],
        )
        cursor.execute(
            "SELECT state, count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() GROUP BY state"
        )
        raw = cursor.fetchall()

    buckets: dict[str, int] = {}
    for state, count in raw:
        bucket = _bucket_pg_state(state)
        buckets[bucket] = buckets.get(bucket, 0) + int(count)
    return sorted(buckets.items())


def _bucket_pg_state(state: str | None) -> str:
    """Collapse a raw pg_stat_activity.state into a stable, low-cardinality bucket."""
    if not state:
        # NULL state = background/system backends (autovacuum, walwriter) or
        # track_activities off; grouped as "other" rather than a null dimension.
        return "other"
    normalized = state.lower()
    if normalized == "active":
        return "active"
    if normalized == "idle":
        return "idle"
    if normalized.startswith("idle in transaction"):
        return "idle_in_transaction"
    return "other"


def _broker_queue_depth_rows() -> list[tuple[str, int]]:
    """Return (queue-name, waiting-message-count) for each Celery broker queue.

    With the Valkey/Redis broker each Celery queue is a Redis LIST keyed by the
    queue name, so ``LLEN`` is the count of messages **waiting** for a worker.
    Tasks a worker has already reserved have left the list and are not counted —
    this is the *broker backlog*, the stage downstream of the transactional
    outboxes (``trueppm.outbox.*`` measure rows the dispatchers have not yet handed
    to Celery; this measures what Celery holds but no worker has picked up).

    A short redis-py socket timeout bounds the probe so an unreachable broker can
    never stall the exporter thread; the client is always closed afterward.
    """
    import redis
    from django.conf import settings

    queue_names = _broker_queue_names()
    client = redis.from_url(
        settings.CELERY_BROKER_URL,
        socket_timeout=_BROKER_PROBE_TIMEOUT_S,
        socket_connect_timeout=_BROKER_PROBE_TIMEOUT_S,
    )
    try:
        # redis-py types llen() as a sync/async union; the sync client returns int.
        return [(name, int(cast("int", client.llen(name)))) for name in queue_names]
    finally:
        client.close()


def _broker_queue_names() -> list[str]:
    """Celery queue names whose broker backlog to probe.

    Read from the live Celery app config rather than hard-coded: TruePPM defines no
    custom routing, so this is the single ``task_default_queue`` (``celery``), but
    if an operator configures ``task_queues`` the probe follows those names instead.
    """
    from trueppm_api.celery import app

    configured = getattr(app.conf, "task_queues", None)
    if configured:
        names = [
            str(name)
            for q in configured
            if (name := getattr(q, "name", None) or (isinstance(q, dict) and q.get("name")))
        ]
        if names:
            return names
    default = getattr(app.conf, "task_default_queue", None) or "celery"
    return [str(default)]


# --- Synchronous WS instrument record sites -------------------------------
# Called from the Channels consumer (connect/disconnect) and the broadcast helper.
# Each is a strict no-op until install_metrics has run (instrument is None), and each
# swallows any instrument error so a metric can never destabilise the WS or broadcast
# path it observes — telemetry is best-effort, exactly like the gauges above.


def record_ws_connection_opened() -> None:
    """Increment the active-WS-connection gauge when a consumer accepts a socket."""
    _add_ws_connection(1)


def record_ws_connection_closed() -> None:
    """Decrement the active-WS-connection gauge when a consumer disconnects."""
    _add_ws_connection(-1)


def _add_ws_connection(delta: int) -> None:
    counter = _ws_connections
    if counter is None:
        return
    try:
        counter.add(delta)
    except Exception:
        logger.debug("ws connection metric skipped", exc_info=True)


def record_ws_broadcast() -> None:
    """Count one board-event fan-out at the broadcast point (``apps/sync/broadcast``)."""
    counter = _ws_broadcasts
    if counter is None:
        return
    try:
        counter.add(1)
    except Exception:
        logger.debug("ws broadcast metric skipped", exc_info=True)


def reset_for_testing() -> None:
    """Clear the idempotency guard so a test can re-register against a fresh reader.

    Test-suite only. Observable gauges (and the task-duration histogram) cannot
    be unregistered from a ``MeterProvider``, so tests pass a *new* in-memory
    ``meter_provider`` per case and reset this guard between them; production
    registers exactly once. Also drops the synchronous WS instrument handles so a
    subsequent ``install_metrics`` rebinds them to the new provider (and the
    ``record_*`` helpers no-op in between).
    """
    global _installed, _ws_connections, _ws_broadcasts, _task_duration_histogram
    _installed = False
    _ws_connections = None
    _ws_broadcasts = None
    _task_duration_histogram = None
