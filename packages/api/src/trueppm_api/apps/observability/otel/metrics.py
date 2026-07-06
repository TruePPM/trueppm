"""OpenTelemetry native metric emission (ADR-0223 Phase 2, #710).

The Foundation (:mod:`.provider`, #708) built the metrics export pipeline — a
``MeterProvider`` with a ``PeriodicExportingMetricReader`` that pushes over OTLP —
but registers no application instruments. This module is Phase 2: it registers the
TruePPM-specific **observable gauges** that have no library auto-instrumentor, and
is called from ``ObservabilityConfig.ready()`` immediately after
:func:`~.instrumentation.instrument`.

Two of #710's four metric families live here; the other two come free from the
library auto-instrumentors once a meter provider is threaded through
``instrument()`` — Django's ``http.server.*`` (request latency/count) and Celery's
``flower.task.runtime.seconds`` (task duration):

* ``trueppm.outbox.depth`` / ``trueppm.outbox.oldest_age_seconds`` — the live
  backlog and lag of the two transactional outboxes (CPM recompute + workflow
  step dispatch). Sourced from the same committed reads the System Health overview
  does (``observability.selectors``).
* ``trueppm.db.connections`` — server-side PostgreSQL backend count for the current
  database, by state, from ``pg_stat_activity``.

**Observable, not synchronous.** These are ``ObservableGauge`` instruments: the SDK
invokes each callback once per export interval (default 60 s) on the reader's
background thread. That means no per-request cost and no need to hook every outbox
transition — which a synchronous ``UpDownCounter`` would require (it would have to
be incremented/decremented at every enqueue and drain site).

**Cluster-wide — aggregate with ``max`` / ``last``, never ``sum``.** Every process
that runs ``ready()`` (web, Celery worker, Celery beat) registers these gauges and
reads the *same* shared PostgreSQL state, so each process emits the whole-cluster
figure as its own series (kept distinct by ``service.instance.id``). Summing across
instances multiplies the true value; dashboards and alerts must aggregate these
gauges with ``max`` or ``last``. This is called out in
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
    from opentelemetry.metrics import CallbackOptions, Meter

    from .provider import OTelBootstrapContext

logger = logging.getLogger(__name__)

# Metric-instrument names. Owned by this module (a namespace distinct from the
# attribute keys in :mod:`.attributes`); kept as constants so tests and docs refer
# to a single source of truth.
OUTBOX_DEPTH = "trueppm.outbox.depth"
OUTBOX_OLDEST_AGE = "trueppm.outbox.oldest_age_seconds"
DB_CONNECTIONS = "trueppm.db.connections"

# Server-side statement timeout for the pg_stat_activity probe, so a slow or
# contended database can never stall the exporter's collection thread. It is set
# on the metrics thread's dedicated connection only.
_DB_PROBE_TIMEOUT_MS = 2_000

_installed = False


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
    global _installed
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
    _installed = True
    logger.info("OpenTelemetry native metrics registered (3 instruments)")


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


def reset_for_testing() -> None:
    """Clear the idempotency guard so a test can re-register against a fresh reader.

    Test-suite only. Observable gauges cannot be unregistered from a ``MeterProvider``,
    so tests pass a *new* in-memory ``meter_provider`` per case and reset this guard
    between them; production registers exactly once.
    """
    global _installed
    _installed = False
