# ADR-0601: Live OTLP export health via a cross-process Valkey record

## Status

Accepted (2026-07-23)

> Enriches the read-only System Health "Telemetry" card ([ADR-0223](0223-opentelemetry-provider-bootstrap.md)
> foundation, cards #2022 / #2110) with a **live** export-health strip. It is
> purely additive: the existing `_telemetry()` posture keys and the on-demand
> test-export are unchanged, and the OSS enterprise provider-hook contract
> (`OTelBootstrapContext`) is not touched. Issue #2109.

## Context

The Telemetry card today reports **configuration posture** (endpoint, protocol,
sampler, per-signal toggles) plus an on-demand canary "test export". It shows no
live numbers, and its own docstring says so: *"it does NOT show live span/metric
counts — the exporters don't record them (tracked in #2109)."* The Claude Design
handoff for #2109 wants a live strip — *"last successful export · 8s ago · 1,204
spans + 340 metric points / 60s"* — that degrades to a stalled indicator — *"no
export for 6h 12m, queue backing up"* — when the collector disappears.

Two facts shape the design:

1. **The web pod that serves `/settings/health` exports almost nothing itself.**
   The real span/metric volume is on the Celery worker and beat pods. A count
   read from the *web* process would be a misleadingly-small (often zero) number
   presented as if it were the deployment's export rate. TruePPM's honesty-to-
   operator constraint (the no-`STUB`/no-fabricated-numbers rule) makes a
   per-process figure worse than no figure.

2. **The SDK exporters already know the answer but discard it.**
   `SpanExporter.export()` returns `SpanExportResult.SUCCESS/FAILURE` and
   `MetricExporter.export()` returns `MetricExportResult.SUCCESS/FAILURE`, both
   with the batch of items in hand — but `_build_tracer_provider` /
   `_build_meter_provider` wrap the raw exporter in `BatchSpanProcessor` /
   `PeriodicExportingMetricReader` and never observe the result.

The issue lists three ways to source the figure:

1. **This-process stats only** (clearly labeled). Rejected: on the web pod this
   is ~zero and misleads the operator (fact 1). Labeling does not fix a number
   that is structurally wrong for the question the card answers ("is my
   deployment exporting?").
2. **Aggregate cross-process via a shared store.** Valkey is already a hard
   dependency (Celery broker `/0`, channels `/1`, cache + throttle counters
   `/2`). Every pod that runs an exporter can self-report; the selector sums
   across live pods. Chosen.
3. **Derive the figure from the exported `trueppm.*` metrics themselves.**
   Rejected: it requires TruePPM to hold read credentials and a query client for
   *each* backend flavor (Prometheus, Tempo, …) — a whole new subsystem — and it
   is **circular for the exact failure the strip must detect**: when export is
   broken the backend has no data, so "collector down" is indistinguishable from
   "nothing exported". The whole point of the stalled indicator is to know
   export failed *independently* of whether the backend received anything, which
   only the exporting process can assert.

## Decision

**Option 2.** Each process that owns an OSS OTLP exporter records its own
per-signal export health into Valkey; `_telemetry()` aggregates the live pods
into a cluster view. The card degrades gracefully — falling back to today's
config-only posture — whenever the shared store is unavailable, so a Valkey blip
never turns the card into a liar.

### 1. Recorder mechanism

Introduce two thin **wrapping exporters** — `RecordingSpanExporter(SpanExporter)`
and `RecordingMetricExporter(MetricExporter)` — that compose (not subclass) the
real OTLP exporter and are inserted in `_build_tracer_provider` /
`_build_meter_provider` *between* `build_span_exporter()` (resp. the metric
exporter) and the `BatchSpanProcessor` / `PeriodicExportingMetricReader`. Their
`export(batch)` delegates to the wrapped exporter, keeps the returned
`SpanExportResult` / `MetricExportResult`, and then — inside a blanket
`try/except Exception: pass` — hands the outcome (success → timestamp + item
count; failure → timestamp + a truncated error string) to a per-pod
`ExportHealthRecorder`; the wrapped exporter's return value is **always
propagated unchanged**. This makes the recorder strictly best-effort and
non-fatal: a Valkey outage, a bug in the recorder, or a serialization error can
neither alter the export result nor raise into the SDK's export loop, and
`shutdown()` / `force_flush()` delegate straight through. Thread-safety is free:
`BatchSpanProcessor` and `PeriodicExportingMetricReader` each call `export()`
from a single dedicated background thread, so a signal's in-process ring buffer
has exactly one writer and needs no lock — the only cross-process mutation is the
atomic Redis pipeline below.

Item counts: spans are `len(batch)`; metric data points are counted by a bounded
walk of the `MetricsData` (`resource_metrics → scope_metrics → metrics →
data.data_points`), which runs once per metric export interval (~60 s) and is
negligible.

### 2. Shared-store schema (Valkey `/2`, prefix `otel:exphealth:`)

Reuse the throttle/cache logical DB `{REDIS_URL}/2` with the throttle module's
connection-pool idiom (`redis.ConnectionPool.from_url(...)`), under a dedicated
key prefix so nothing collides. Per signal `S ∈ {traces, metrics}`:

- **Per-pod hash** `otel:exphealth:pod:<S>:<pod_id>` with fields
  `last_success_at`, `last_error_at`, `last_error` (truncated ≤ 200 chars),
  `items_60s` (the pod's own rolling count over the trailing 60 s, computed from
  a 60-slot per-second ring buffer), `service` (`service.name`), `exporting`
  (`"1"` when this signal's exporter is installed). Written with a pipeline
  `HSET` + `EXPIRE` on every export; **TTL = staleness window (600 s)**,
  so a pod that dies stops refreshing and its key expires out of the aggregate.
- **Live-pod index** `otel:exphealth:idx:<S>` — a ZSET, member = `pod_id`, score
  = last-update epoch, `ZADD`ed on every export. The selector reads live pods
  with a single `ZRANGEBYSCORE (now − staleness) +inf` (no `KEYS`/`SCAN`), then
  pipelines `HGETALL` for just those pods, and opportunistically trims dead
  members with `ZREMRANGEBYSCORE -inf (now − staleness)`. Read cost is bounded by
  the live-pod count (O(10)), not the keyspace.

**Pod identity** (`pod_id`): `TRUEPPM_POD_NAME` if set (K8s downward API),
otherwise `socket.gethostname():<pid>` — on Kubernetes the hostname *is* the pod
name, so this is a stable, no-config default.

**Rolling count → "1,204 spans / 60 s"**: each pod maintains `items_60s` as the
sum of exported items over the trailing 60 seconds (a rolling *count* over a
fixed window, matching the handoff copy — not an instantaneous rate). The cluster
figure is `sum(items_60s)` over the live pods for that signal. `window_seconds`
(60) is reported so the FE renders the denominator honestly rather than
hard-coding it.

### 3. `_telemetry()` payload additions

All existing keys stay. Add one nested, additive `live` block. When the store is
unreachable the block is `{"available": false}` and the FE falls back to today's
config-only view.

```jsonc
"live": {
  "available": true,          // false ⇒ Valkey unreachable; FE hides the strip, keeps config posture
  "window_seconds": 60,       // window the *_items counts cover
  "pods_reporting": 3,        // distinct live pods across both signals
  "traces": {
    "state": "healthy",       // healthy | idle | failing | stalled | never | disabled
    "last_success_at": "2026-07-23T12:00:08Z", // ISO-8601, or null
    "last_success_age_seconds": 8,             // computed vs generated_at (avoids browser clock skew), or null
    "items_per_window": 1204,                  // spans exported across live pods in the last window_seconds
    "last_error": "connection refused",        // truncated, or null
    "last_error_at": "2026-07-23T05:48:00Z",   // ISO-8601, or null
    "pods_reporting": 2
  },
  "metrics": {
    "state": "healthy",
    "last_success_at": "2026-07-23T12:00:08Z",
    "last_success_age_seconds": 8,
    "items_per_window": 340,                    // metric data points across live pods
    "last_error": null,
    "last_error_at": null,
    "pods_reporting": 3
  }
}
```

The **backend owns the `state` verdict** (see §4) rather than shipping raw
numbers for the FE to interpret — this keeps the honesty logic server-side and
MCP-reachable (a first-class fact, per the AI-readiness gate), and guarantees the
web and any future API/agent consumer agree on "is export healthy?".

`last_success_age_seconds` is computed against `get_system_health()`'s
`generated_at`, not the browser clock, so cross-pod/browser clock skew can never
produce a nonsensical "8 s ago" against a stale timestamp.

### 4. `state` semantics (per signal)

Computed server-side from config + the live aggregate:

- **`disabled`** — the signal's export is off by config (`enabled=false` for the
  whole exporter, or the per-signal toggle off). Muted; not an error.
- **`never`** — enabled, no live pod has ever recorded a success, and no live
  error. Fresh boot / nothing exported yet → FE: "waiting for first export…".
- **`failing`** — enabled and the most-recent recorded outcome across live pods
  is an error (`last_error_at` newer than `last_success_at`). → the handoff's
  "queue backing up" red state, showing the error string.
- **`stalled`** — enabled, has succeeded before, but the last success is older
  than `HEALTHY_WITHIN` (150 s) while the record is still **live** (within the
  `STALENESS` TTL). Applied to the **metrics** signal:
  `PeriodicExportingMetricReader` exports on a fixed cadence regardless of
  traffic, so an overdue success is authoritative evidence the collector is gone.
  *Note the mechanics:* a collector that is actively **rejecting** exports reads as
  `failing`, not `stalled`, because each failed attempt records a fresh
  `last_error` — `stalled` is specifically the "exports stopped happening" case.
- **`idle`** — **traces only**: enabled, last success older than `HEALTHY_WITHIN`
  but no error. Traces are volume-driven (`BatchSpanProcessor` exports only when
  there are spans), so a quiet, low-traffic system legitimately produces none —
  this must read as neutral ("no spans to export recently"), **not** the red
  stalled indicator.
- **`healthy`** — enabled and a success within `HEALTHY_WITHIN` (150 s).

**Threshold relationship (important):** `STALENESS` (600 s, the per-pod record TTL)
is deliberately **wider** than `HEALTHY_WITHIN` (150 s). A shorter TTL would expire
an overdue record before it could be classified `stalled`/`idle`, masking it as a
premature `never`. So: `healthy` ≤ 150 s → `stalled`/`idle` 150–600 s → `never`
beyond 600 s (or no live pod). Item counts are only *rendered* in `healthy`, so a
lingering record in the 150–600 s band never surfaces a stale count.

FE strip mapping: `healthy` → "last successful export · 8 s ago · 1,204 spans /
60 s"; `failing`/`stalled` → the red "no export for 6h 12m, queue backing up" +
error; `never` → "waiting for first export…"; `idle` → neutral "no spans to
export recently"; `disabled` → muted; `available:false` → "live export stats
unavailable (metrics store unreachable)".

### 5. Configuration (additive, env / settings, safe defaults)

All knobs are env/settings-configured and mirrored into the Helm chart
(`observability.otlp.exportHealth.*` + the downward-API pod name) via the
`trueppm.observabilityEnv` helper, so they render onto all three tiers (api,
celery-worker, celery-beat) exactly like the existing OTEL vars — and, like them,
emit nothing when no endpoint is set.

- `TRUEPPM_OTEL_EXPORT_HEALTH_ENABLED` (default `true`) — kill switch for the
  recorder; when off, the wrappers are not installed and `live.available` is
  `false`. Helm: `observability.otlp.exportHealth.enabled`.
- `TRUEPPM_OTEL_EXPORT_HEALTH_STALENESS_SECONDS` (default `600`),
  `TRUEPPM_OTEL_EXPORT_HEALTH_HEALTHY_WITHIN_SECONDS` (default `150`),
  `TRUEPPM_OTEL_EXPORT_HEALTH_WINDOW_SECONDS` (default `60`) — the three thresholds
  from §4, operator-tunable for unusual export cadences. Helm:
  `observability.otlp.exportHealth.{stalenessSeconds,healthyWithinSeconds,windowSeconds}`
  (unset ⇒ app default). The **STALENESS > HEALTHY_WITHIN** invariant is not
  clamped — a violating config is honored but logged as a warning (once/process),
  degrading an overdue signal to the neutral `never` rather than a false alarm.
  The module keeps the same values as named constant defaults so tests and the
  settings accessors share one source of truth. Changing the window re-labels the
  strip automatically (the FE reads `window_seconds` from the payload).
- `TRUEPPM_POD_NAME` — per-pod identity for the record; the Helm chart injects it
  from the Kubernetes downward API (`fieldRef: metadata.name`), so each pod's
  record carries a stable, human-readable name. Unset, the app falls back to
  `socket.gethostname():<pid>` (which is already the pod name on K8s).

## Consequences

- **The card answers the real question honestly.** Cluster numbers reflect the
  worker/beat pods that actually export, not the web pod. When Valkey is down the
  card silently reverts to the config posture it shows today — no fabricated
  numbers, ever.
- **Zero risk to the export path.** The recorder is a delegating wrapper whose
  every side effect is inside `try/except: pass` and whose return value is the
  wrapped exporter's own — a recorder failure cannot destabilize, slow, or break
  export. Writes ride the SDK's existing background export threads, never a
  request.
- **Cheap reads.** One `ZRANGEBYSCORE` + a pipelined `HGETALL` per signal,
  bounded by live-pod count. `_telemetry()` stays a fast, read-only selector.
- **OSS, no governance angle.** This is operator observability — "is my
  deployment exporting to my collector?" — squarely the self-hosting-operator
  persona, with no cross-program/portfolio or org-identity dimension. It stays in
  `trueppm-suite`.
- **Composes with the enterprise provider hook unchanged.** The recorder wraps
  the **OSS** exporter inside `_build_*_provider`; an enterprise hook still
  attaches its own processors/exporters via `ctx.tracer_provider.add_span_processor(...)`.
  `OTelBootstrapContext` gains no field, so `_CONTEXT_SCHEMA_VERSION` is **not**
  bumped and the cross-repo contract is byte-compatible. Enterprise's own
  exporters are not recorded by this card (they are a separate processor) — which
  is correct: the card reports the health of the OSS export pipeline.
- **Tests:** pytest — recorder records success/failure/counts and is non-fatal
  when the wrapped exporter *and* Valkey both raise; `_telemetry()` aggregates
  multiple pods, computes each `state`, and returns `available:false` on a Redis
  error. vitest — `state → strip` mapping incl. `idle` vs `stalled`. Playwright —
  System Health with a healthy live strip and with `available:false` fallback.

## Open questions

- ✅ **RESOLVED — Valkey eviction policy on the shared `/2` DB.** These keys carry
  TTLs and live on the same logical DB as the Django cache. If the operator has
  configured a `maxmemory-policy` that can evict TTL'd keys under memory pressure
  (`allkeys-lru`, etc.), the per-pod hashes could vanish while export is perfectly
  healthy. **Decision:** co-locate on `/2` (not a dedicated logical DB) and
  document `noeviction` as the deployment requirement in the observability admin
  page — this is already the de-facto contract, since the atomic throttle counters
  (`core/redis_throttle`) already depend on `noeviction` on this same DB, so no new
  deployment constraint is introduced. As defence-in-depth against a misconfigured
  deployment, the `state` computation treats an **evicted / missing** record as
  `never` (neutral "waiting for first export…"), **never** as the red `stalled`
  alarm: `stalled` requires a previously-recorded `last_success_at`, which eviction
  removes, so an evicted key can only degrade to the neutral state — the card stays
  honest rather than raising a false alarm.
- ✅ **RESOLVED — Pod identity / Helm downward API.** The Helm chart now injects
  `TRUEPPM_POD_NAME` from the downward API (`fieldRef: metadata.name`) so each pod's
  record carries a stable, human-readable name for future per-pod drill-downs; the
  `socket.gethostname():<pid>` fallback remains for non-Helm deployments.
- 🟡 **`idle` tolerance for traces.** This ADR decides a quiet low-traffic system
  must show traces as neutral `idle`, not red `stalled`, and uses the fixed-cadence
  metrics signal as the true collector heartbeat. Confirm the operator-facing copy
  distinguishes "no traffic to export" from "collector unreachable" clearly enough.
- 🟡 **`STALLED_AFTER` default (300 s).** Should scale with the configured metric
  export interval (e.g. `3 × interval`) rather than a flat constant if operators
  run long metric intervals. Tunable later; the flat default is fine for launch.
- 🟡 **Metric data-point counting** relies on walking `MetricsData`. Confirm the
  count semantics the operator expects ("340 metric points / 60 s") match data
  points and not time series or metric streams.
