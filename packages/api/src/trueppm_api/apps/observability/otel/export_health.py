"""Cross-process OTLP export-health record for the live Telemetry card (ADR-0601, #2109).

The read-only System Health "Telemetry" card (#2022/#2110) reports export
*configuration* but no live numbers, because the SDK export pipeline
(``BatchSpanProcessor`` / ``PeriodicExportingMetricReader``) discards the
``SpanExportResult`` / ``MetricExportResult`` it gets back. This module recovers
that signal without touching the export path's behaviour.

Two facts drive the design (see ADR-0601 for the full rationale):

1. **The web pod that serves ``/settings/health`` exports almost nothing.** The
   real span/metric volume is on the Celery worker and beat pods, so a count read
   from the web process would be a misleadingly-small number. The card therefore
   needs a *cluster* view, not a per-process one — TruePPM's honesty-to-operator
   rule (no fabricated numbers) makes a wrong-scope figure worse than none.
2. **Valkey is already a hard dependency** (Celery ``/0``, channels ``/1``, cache +
   throttle counters ``/2``). Each exporting pod self-reports its per-signal health
   into ``/2`` under the ``otel:exphealth:`` prefix; :func:`read_export_health`
   aggregates the live pods into the cluster figure the card shows.

Every write is **best-effort and non-fatal**: the recorder wrappers always
propagate the wrapped exporter's own return value and never raise into the SDK's
export loop, and a Valkey outage degrades the card to its config-only posture
rather than fabricating a number. This mirrors the discipline the observable
gauges already follow — telemetry must never destabilize the process it observes.

Eviction note: these keys carry TTLs and share the ``/2`` logical DB with the
Django cache and the throttle counters, which already require the Valkey
``maxmemory-policy`` to be ``noeviction`` (the default). An evicted record can only
degrade to the neutral ``never`` state — never the red ``stalled`` alarm, which
requires a surviving ``last_success_at`` — so the card stays honest even under a
misconfigured eviction policy.
"""

from __future__ import annotations

import logging
import os
import socket
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import redis
from django.conf import settings
from opentelemetry.sdk.metrics.export import MetricExporter, MetricExportResult
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

if TYPE_CHECKING:
    from collections.abc import Sequence

    from opentelemetry.sdk.metrics.export import MetricsData
    from opentelemetry.sdk.trace import ReadableSpan

logger = logging.getLogger(__name__)

# Valkey key prefix; ``/2`` is the throttle/cache logical DB (see module docstring).
_KEY_PREFIX = "otel:exphealth:"

# A pod's record is considered live for this long after its last export attempt
# (success OR failure — both refresh the record); a pod that stops exporting
# entirely expires out of the aggregate after this and the signal reads `never`.
# Deliberately wider than HEALTHY_WITHIN_SECONDS so a signal that has gone quiet or
# overdue is still *observed* (as idle / stalled) before it expires — a shorter TTL
# would mask a stalled signal as a premature `never`.
STALENESS_SECONDS = 600
# A success within this window ⇒ healthy. Beyond it (but still a live record) ⇒
# stalled for metrics (fixed-cadence, so overdue is authoritative) or idle for
# traces (volume-driven, so quiet is legitimate — never a red alarm). Sized a few
# multiples of the default 60s metric export interval so normal cadence jitter
# never flaps the state.
HEALTHY_WITHIN_SECONDS = 150
# The rolling window the exported-item counts cover ("N spans / 60s"). Reported to
# the FE as ``window_seconds`` so the denominator is never hard-coded in the UI.
WINDOW_SECONDS = 60

# Signal identifiers used in keys and payloads.
SIGNAL_TRACES = "traces"
SIGNAL_METRICS = "metrics"

_pool: redis.ConnectionPool | None = None


def _client() -> redis.Redis:
    """Return a redis client on the throttle/cache logical DB (``/2``).

    Reuses the throttle module's connection-pool idiom (``ConnectionPool.from_url``)
    so export-health writes share one bounded pool rather than opening a socket per
    export.
    """
    global _pool
    if _pool is None:
        _pool = redis.ConnectionPool.from_url(
            f"{settings.REDIS_URL}/2",  # /2 is the throttle/cache DB (noeviction)
            decode_responses=True,
            # Bound both the aggregate read (on the polled /settings/health request
            # thread) and the recorder write (on the SDK export thread) so a silently
            # hung Valkey — a TCP blackhole, which a plain refused/reset would not be —
            # can never wedge either. A timeout raises redis.TimeoutError (a
            # RedisError), which the reader catches (→ available:false) and the
            # recorder swallows.
            socket_timeout=2,
            socket_connect_timeout=2,
        )
    return redis.Redis(connection_pool=_pool)


def _pod_id() -> str:
    """Stable per-pod identity for the record.

    ``TRUEPPM_POD_NAME`` (K8s downward API) when set, else
    ``socket.gethostname():<pid>`` — on Kubernetes the hostname *is* the pod name,
    so the fallback is a stable, no-config default.
    """
    name = str(getattr(settings, "TRUEPPM_POD_NAME", "") or "").strip()
    if name:
        return name
    return f"{socket.gethostname()}:{os.getpid()}"


def _iso(epoch: float | None) -> str | None:
    """Render an epoch timestamp as ``…Z`` ISO-8601, or ``None``."""
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, tz=UTC).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Recorder — one instance per signal, written only from the SDK export thread.
# ---------------------------------------------------------------------------


class ExportHealthRecorder:
    """Publishes one signal's export health for this pod into Valkey.

    A single instance per signal (traces / metrics). Its ``record_*`` methods are
    called only from that signal's dedicated SDK background export thread
    (``BatchSpanProcessor`` / ``PeriodicExportingMetricReader`` each own one), so
    the in-process ring buffer has exactly one writer and needs no lock. Every
    Valkey write is wrapped so a store failure is logged at debug and swallowed —
    it must never propagate into the export loop.
    """

    def __init__(self, signal: str, service_name: str) -> None:
        self._signal = signal
        self._service = service_name
        self._pod = _pod_id()
        # epoch-second -> items exported in that second, pruned to the trailing
        # WINDOW_SECONDS. Sums to the pod's own "items in the last 60s".
        self._buckets: dict[int, int] = {}

    def _items_in_window(self, now: int) -> int:
        """Sum exported items over the trailing ``WINDOW_SECONDS``, pruning old slots."""
        cutoff = now - WINDOW_SECONDS
        for sec in [s for s in self._buckets if s <= cutoff]:
            del self._buckets[sec]
        return sum(self._buckets.values())

    def record_success(self, item_count: int) -> None:
        """Record a successful export of ``item_count`` items (spans / data points)."""
        try:
            now = int(time.time())
            self._buckets[now] = self._buckets.get(now, 0) + max(item_count, 0)
            self._write(
                {
                    "last_success_at": now,
                    "items_60s": self._items_in_window(now),
                    "service": self._service,
                    "exporting": "1",
                },
                now,
            )
        except Exception:
            logger.debug("export-health: success record failed", exc_info=True)

    def record_failure(self, error: str) -> None:
        """Record a failed export, keeping a truncated error string for the card."""
        try:
            now = int(time.time())
            # last_success_at is intentionally NOT cleared: the reader compares
            # last_error_at vs last_success_at to decide failing-vs-recovered.
            self._write(
                {
                    "last_error_at": now,
                    "last_error": (error or "export failed")[:200],
                    "service": self._service,
                    "exporting": "1",
                },
                now,
            )
        except Exception:
            logger.debug("export-health: failure record failed", exc_info=True)

    def _write(self, fields: dict[str, Any], now: int) -> None:
        """Atomically upsert this pod's hash + refresh the live-pod index."""
        client = _client()
        pod_key = f"{_KEY_PREFIX}pod:{self._signal}:{self._pod}"
        idx_key = f"{_KEY_PREFIX}idx:{self._signal}"
        pipe = client.pipeline()
        pipe.hset(pod_key, mapping=fields)
        pipe.expire(pod_key, STALENESS_SECONDS)
        pipe.zadd(idx_key, {self._pod: now})
        # The index outlives a single staleness window so a burst of dead members
        # is trimmed lazily by the reader rather than expiring the whole index.
        pipe.expire(idx_key, STALENESS_SECONDS * 4)
        pipe.execute()


# ---------------------------------------------------------------------------
# Wrapping exporters — compose the real OTLP exporter, record its result.
# ---------------------------------------------------------------------------


def _safe_record(fn: Any, *args: Any) -> None:
    """Run a recorder call, swallowing any error.

    Belt-and-braces around the recorder's own internal guard: the wrapper's
    non-fatal contract (a recording side effect can never raise into the SDK
    export loop) must hold regardless of the recorder implementation.
    """
    try:
        fn(*args)
    except Exception:
        logger.debug("export-health: recorder call failed", exc_info=True)


class RecordingSpanExporter(SpanExporter):
    """Delegating ``SpanExporter`` that records each export's outcome (ADR-0601 §1).

    Inserted between ``build_span_exporter()`` and the ``BatchSpanProcessor``.
    ``export`` always returns the wrapped exporter's own ``SpanExportResult`` and
    re-raises any exception it raises (preserving the SDK's exact behaviour); the
    recording is a swallowed side effect, so this wrapper can never change, slow,
    or break export.
    """

    def __init__(self, wrapped: SpanExporter, recorder: ExportHealthRecorder) -> None:
        self._wrapped = wrapped
        self._recorder = recorder

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            result = self._wrapped.export(spans)
        except Exception as exc:  # record then re-raise — behaviour unchanged
            # Record only the exception TYPE, never str(exc): the routine network/auth
            # failures are already swallowed by the exporter and return FAILURE (below),
            # so this branch is for unexpected exceptions — recording the type keeps the
            # "the OTLP bearer token never reaches the browser" invariant structural,
            # not dependent on upstream exporters continuing to hide it. Full detail
            # goes to the server log.
            logger.debug("export-health: span export raised", exc_info=True)
            _safe_record(self._recorder.record_failure, type(exc).__name__)
            raise
        if result == SpanExportResult.SUCCESS:
            _safe_record(self._recorder.record_success, len(spans))
        else:
            _safe_record(self._recorder.record_failure, "span exporter returned FAILURE")
        return result

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._wrapped.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._wrapped.shutdown()


class RecordingMetricExporter(MetricExporter):
    """Delegating ``MetricExporter`` that records each export's outcome (ADR-0601 §1).

    Mirrors :class:`RecordingSpanExporter` for metrics. The base ``MetricExporter``
    carries the temporality/aggregation preferences the ``PeriodicExportingMetricReader``
    reads off the exporter, so they are copied from the wrapped exporter to stay
    transparent to the reader.
    """

    def __init__(self, wrapped: MetricExporter, recorder: ExportHealthRecorder) -> None:
        self._wrapped = wrapped
        self._recorder = recorder
        super().__init__(
            preferred_temporality=getattr(wrapped, "_preferred_temporality", None),
            preferred_aggregation=getattr(wrapped, "_preferred_aggregation", None),
        )

    def export(
        self, metrics_data: MetricsData, timeout_millis: float = 10_000, **kwargs: Any
    ) -> MetricExportResult:
        try:
            result = self._wrapped.export(metrics_data, timeout_millis=timeout_millis, **kwargs)
        except Exception as exc:  # record then re-raise — behaviour unchanged
            # Type only, never str(exc) — see RecordingSpanExporter.export for why.
            logger.debug("export-health: metric export raised", exc_info=True)
            _safe_record(self._recorder.record_failure, type(exc).__name__)
            raise
        if result == MetricExportResult.SUCCESS:
            _safe_record(self._recorder.record_success, _count_data_points(metrics_data))
        else:
            _safe_record(self._recorder.record_failure, "metric exporter returned FAILURE")
        return result

    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        return self._wrapped.force_flush(timeout_millis)

    def shutdown(self, timeout_millis: float = 30_000, **kwargs: Any) -> None:
        self._wrapped.shutdown(timeout_millis=timeout_millis, **kwargs)


def _count_data_points(metrics_data: MetricsData) -> int:
    """Count metric data points in a ``MetricsData`` batch (bounded, once per interval)."""
    total = 0
    try:
        for resource_metrics in metrics_data.resource_metrics:
            for scope_metrics in resource_metrics.scope_metrics:
                for metric in scope_metrics.metrics:
                    total += len(metric.data.data_points)
    except Exception:
        return total
    return total


# ---------------------------------------------------------------------------
# Reader — aggregate live pods into the cluster view for _telemetry().
# ---------------------------------------------------------------------------


def read_export_health(
    *,
    traces_enabled: bool,
    metrics_enabled: bool,
    now_epoch: float | None = None,
) -> dict[str, Any]:
    """Aggregate live pods into the ``live`` block consumed by the Telemetry card.

    Returns ``{"available": False}`` when the recorder is disabled by config or the
    store is unreachable — the FE then keeps the config-only posture rather than
    showing a fabricated number. Otherwise returns the additive ``live`` block
    (ADR-0601 §3): ``window_seconds``, ``pods_reporting``, and a per-signal block
    carrying the server-computed ``state`` verdict, cluster ``last_success`` /
    ``last_error``, and the summed item count.

    Args:
        traces_enabled: Whether the traces signal is enabled by config.
        metrics_enabled: Whether the metrics signal is enabled by config.
        now_epoch: Reference time (defaults to ``time.time()``); injectable for tests.
    """
    if not getattr(settings, "TRUEPPM_OTEL_EXPORT_HEALTH_ENABLED", True):
        return {"available": False}
    now = now_epoch if now_epoch is not None else time.time()
    try:
        client = _client()
        traces, trace_pods = _read_signal(client, SIGNAL_TRACES, enabled=traces_enabled, now=now)
        metrics, metric_pods = _read_signal(
            client, SIGNAL_METRICS, enabled=metrics_enabled, now=now
        )
    except redis.RedisError:
        logger.debug("export-health: aggregate read failed", exc_info=True)
        return {"available": False}
    return {
        "available": True,
        "window_seconds": WINDOW_SECONDS,
        "pods_reporting": len(trace_pods | metric_pods),
        "traces": traces,
        "metrics": metrics,
    }


def _read_signal(
    client: redis.Redis, signal: str, *, enabled: bool, now: float
) -> tuple[dict[str, Any], set[str]]:
    """Read + aggregate one signal's live pods. Returns (block, live-pod set)."""
    idx_key = f"{_KEY_PREFIX}idx:{signal}"
    cutoff = now - STALENESS_SECONDS
    # Trim members that have gone stale, then read only the live ones by score —
    # bounded by live-pod count, never a KEYS/SCAN over the keyspace.
    client.zremrangebyscore(idx_key, "-inf", f"({cutoff}")
    # redis-py types read commands as Awaitable|Any for the sync/async-generic client;
    # the sync client returns the concrete list (same pattern the throttles type-ignore).
    pod_ids: list[str] = list(client.zrangebyscore(idx_key, cutoff, "+inf"))  # type: ignore[arg-type]
    hashes: list[dict[str, str]] = []
    if pod_ids:
        pipe = client.pipeline()
        for pod in pod_ids:
            pipe.hgetall(f"{_KEY_PREFIX}pod:{signal}:{pod}")
        hashes = pipe.execute()

    last_success: float | None = None
    last_error_at: float | None = None
    last_error: str | None = None
    items = 0
    for h in hashes:
        if not h:
            continue
        success_at = _as_float(h.get("last_success_at"))
        if success_at is not None and (last_success is None or success_at > last_success):
            last_success = success_at
        error_at = _as_float(h.get("last_error_at"))
        if error_at is not None and (last_error_at is None or error_at > last_error_at):
            last_error_at = error_at
            last_error = h.get("last_error")
        items += _as_int(h.get("items_60s"))

    state = _state(
        signal, enabled=enabled, last_success=last_success, last_error_at=last_error_at, now=now
    )
    block = {
        "state": state,
        "last_success_at": _iso(last_success),
        "last_success_age_seconds": (int(now - last_success) if last_success is not None else None),
        "items_per_window": items,
        "last_error": last_error if state in ("failing", "stalled") else None,
        "last_error_at": _iso(last_error_at) if state in ("failing", "stalled") else None,
        "pods_reporting": len(pod_ids),
    }
    return block, set(pod_ids)


def _state(
    signal: str,
    *,
    enabled: bool,
    last_success: float | None,
    last_error_at: float | None,
    now: float,
) -> str:
    """Server-side export-health verdict for one signal (ADR-0601 §4).

    Kept server-side (not derived in the browser) so the card, the API, and any
    future MCP/agent consumer agree on "is export healthy?". ``stalled`` requires a
    surviving ``last_success`` — an evicted or never-seen record can only reach the
    neutral ``never``, never the red alarm.
    """
    if not enabled:
        return "disabled"
    # Most recent recorded outcome is an error → failing (the red "queue backing up").
    # `last_success is None` first so the comparison only runs when it is a float.
    if last_error_at is not None and (last_success is None or last_error_at > last_success):
        return "failing"
    if last_success is None:
        return "never"  # enabled but nothing exported yet (or record expired/evicted)
    if now - last_success <= HEALTHY_WITHIN_SECONDS:
        return "healthy"
    # A live record whose last success is beyond the healthy window. Metrics export
    # on a fixed cadence, so an overdue success is authoritative evidence the
    # collector is gone → stalled. Traces are volume-driven, so a quiet system
    # legitimately produces none → neutral idle (never a red alarm).
    return "stalled" if signal == SIGNAL_METRICS else "idle"


def _as_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: str | None) -> int:
    try:
        return int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def reset_pool_for_testing() -> None:
    """Drop the cached connection pool so a test can rebind ``REDIS_URL``."""
    global _pool
    _pool = None
