---
title: OpenTelemetry & OTLP Export
description: How to export TruePPM's traces and metrics to your own OpenTelemetry collector over OTLP — an opt-in, off-by-default integration configured with environment variables or Helm values.
---


:::note[Lands in 0.4 (first beta)]
OpenTelemetry export **ships in TruePPM 0.4**, the first beta — the provider and
configuration groundwork, **trace instrumentation** (spans for HTTP requests,
database queries, Celery tasks, WebSocket connections, and the CPM / Monte Carlo
scheduling engine), and **native metrics** (request latency/count, Celery task
duration, transactional-outbox depth/lag, and database backend counts) (#707–#710).
:::

TruePPM will export distributed **traces** and **metrics** using
[OpenTelemetry](https://opentelemetry.io/) (OTel), the vendor-neutral CNCF
standard, over the OTLP protocol. Point it at your existing observability stack —
Grafana Tempo/Alloy, Jaeger, an OpenTelemetry Collector, or a SaaS APM — with no
custom exporter code.

Export is **opt-in and off by default**. There is **no default endpoint**: until
you configure a collector, TruePPM installs no telemetry provider at all — a
strict no-op that costs nothing per request and opens no outbound connection.
Telemetry is a deliberate operator choice, never a silent egress.

## What 0.4 will ship

- A provider bootstrap that builds the OTel `TracerProvider` / `MeterProvider` at
  API startup and wires the OTLP exporter — **only** when an endpoint is set.
- The opt-in configuration surface below (environment variables + Helm values).
- A stable `trueppm.*` span-, metric-, and resource-attribute naming convention.
- **Trace instrumentation** for HTTP requests, database queries, Celery tasks,
  WebSocket connections, and the scheduling engine (see
  [Instrumented spans](#instrumented-spans) below).
- **Native metrics** for request latency/count, Celery task duration, transactional
  outbox depth/lag, and database backend counts (see
  [Instrumented metrics](#instrumented-metrics) below).

Configure a collector now and you immediately see TruePPM's resource identity, the
trace spans, and the metrics below. Traces and metrics export over the **same** OTLP
endpoint and can be toggled independently with `TRUEPPM_OTEL_TRACES_ENABLED` /
`TRUEPPM_OTEL_METRICS_ENABLED`.

## Turning it on

Telemetry is active only when the master switch is on **and** an OTLP endpoint is
set. Setting the endpoint is what turns export on.

### Environment variables

TruePPM reads the well-known upstream `OTEL_*` variables, so they match every
other OpenTelemetry-emitting service in your cluster, plus a few `TRUEPPM_OTEL_*`
switches for behavior the standard variables do not express.

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(empty)* | **The gate.** Your collector URL, e.g. `http://otel-collector:4317`. Empty means telemetry is **off**. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` | `grpc` (port 4317) or `http/protobuf` (port 4318). Match your collector. |
| `OTEL_EXPORTER_OTLP_HEADERS` | *(empty)* | Comma-separated `key=value` pairs sent with every export, e.g. `authorization=Bearer <token>` for a SaaS backend. |
| `OTEL_SERVICE_NAME` | `trueppm-api` | The `service.name` reported on every span and metric. |
| `TRUEPPM_OTEL_ENABLED` | `true` | Master kill switch. Set `false` to disable export while leaving the endpoint configured. |
| `TRUEPPM_OTEL_TRACES_ENABLED` | `true` | Export traces (when telemetry is on). |
| `TRUEPPM_OTEL_METRICS_ENABLED` | `true` | Export metrics (when telemetry is on). |

Export is enabled when `TRUEPPM_OTEL_ENABLED` is true **and**
`OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty. Leaving the endpoint empty — the
default — keeps the provider a no-op regardless of the other switches.

### Helm values

The chart exposes these settings under `observability.otlp.*` and renders them
into the standard environment variables for **both** the API and the Celery
worker/beat, so traces and metrics from background work carry the same identity as
the web tier.

```yaml
observability:
  otlp:
    # Collector endpoint. Empty (the default) = telemetry off.
    endpoint: "http://otel-collector:4317"
    protocol: "grpc"          # or "http/protobuf" (port 4318)
    serviceName: "trueppm-api"
    enabled: true             # master switch
    tracesEnabled: true
    metricsEnabled: true
    # Optional OTLP headers. Prefer headersSecret for tokens so they never
    # render into a plaintext manifest; `headers` is the inline fallback.
    headers: ""
    headersSecret:
      name: ""                # e.g. "trueppm-otlp"
      key: "headers"
```

When your collector requires an authorization token, put it in a Kubernetes
Secret and reference it with `headersSecret` rather than the inline `headers`
field, so the token never appears in the rendered Deployment:

```yaml
observability:
  otlp:
    endpoint: "https://otlp.example-apm.com:4317"
    headersSecret:
      name: "trueppm-otlp"
      key: "headers"
```

```bash
kubectl create secret generic trueppm-otlp \
  --from-literal=headers="authorization=Bearer <your-token>"
```

## What TruePPM reports

Every span and metric carries these **resource attributes** identifying the
process:

| Attribute | Value |
|---|---|
| `service.name` | `OTEL_SERVICE_NAME` (default `trueppm-api`) |
| `service.version` | The running TruePPM API version |
| `service.namespace` | `trueppm` |
| `trueppm.edition` | `community` or `enterprise` |

TruePPM-owned span attributes and metric dimensions live under the reserved
**`trueppm.*`** namespace (for example `trueppm.project.id`, `trueppm.task.id`,
`trueppm.user.role`, `trueppm.outbox.name`), so you can filter and group TruePPM
signals cleanly in your backend. Attributes that follow OpenTelemetry's own semantic
conventions (`http.*`, `db.*`, `messaging.*`) keep their standard keys.

## Instrumented spans

With a collector configured, TruePPM emits these spans out of the box. Every span
is a child of the request or task that produced it, so a single trace links an
HTTP request through its database queries and any Celery work it enqueues.

| Source | What you get | Key attributes |
|---|---|---|
| **HTTP requests** (Django) | One server span per API request, with route, method, and status | `http.*` semantic conventions |
| **Database** (psycopg) | One span per SQL statement | `db.*` semantic conventions. SQL is **never** modified — comment injection is off. |
| **Celery tasks** | One span per task; trace context propagates from the enqueuing request into the worker, so a recompute links back to the request that triggered it | `messaging.*` semantic conventions |
| **WebSocket** (Channels/ASGI) | One span per WebSocket connection | `http.*` (ASGI) semantic conventions |
| **CPM recompute** | `schedule.cpm` span timing a full critical-path recompute | `trueppm.project.id`, `trueppm.schedule.recompute_reason`, `trueppm.schedule.task_count`, `trueppm.schedule.dependency_count`, `trueppm.schedule.critical_count` |
| **Monte Carlo** | `schedule.monte_carlo` span timing a probabilistic forecast (including what-if) | `trueppm.project.id`, `trueppm.schedule.simulation_count` |

:::note[Database spans dominate the volume]
One span per SQL statement means the database is by far the largest span source.
Export runs on a background batch processor and drops rather than blocks on a slow
collector, so it never adds latency to a request — but size your collector's
ingest for the query volume, or sample at the collector.
:::

## Instrumented metrics

With a collector configured, TruePPM exports these metrics over OTLP on a periodic
interval. The HTTP and Celery families follow OpenTelemetry's semantic conventions;
the outbox, database, broker, and WebSocket families are TruePPM-specific instruments
under the `trueppm.*` namespace.

| Metric | Type | What it measures | Dimensions |
|---|---|---|---|
| `http.server.request.duration` | histogram | API request latency | `http.*` semantic conventions |
| `http.server.active_requests` | up/down counter | In-flight API requests | `http.*` semantic conventions |
| `flower.task.runtime.seconds` | histogram | Celery task duration | task name, worker |
| `trueppm.outbox.depth` | gauge | Live backlog of a transactional outbox (rows not yet done) | `trueppm.outbox.name` (`schedule` \| `workflow`), `trueppm.outbox.state` (`pending` \| `dispatched`) |
| `trueppm.outbox.oldest_age_seconds` | gauge | Age of the oldest not-yet-done outbox row — the dispatch **lag** (0 when empty) | `trueppm.outbox.name` |
| `trueppm.db.connections` | gauge | Server-side PostgreSQL backend count for the current database | `trueppm.db.state` (`active` \| `idle` \| `idle_in_transaction` \| `other`) |
| `trueppm.broker.queue.depth` | gauge | Celery messages **waiting** in the broker (Valkey/Redis `LLEN`), downstream of the outboxes | `messaging.destination.name` (queue, e.g. `celery`) |
| `trueppm.ws.connections.active` | up/down counter | Active WebSocket connections accepted by this process's Channels consumers | — |
| `trueppm.ws.broadcast.count` | counter | WebSocket board-event broadcasts fanned out to a project group | — |

The two `trueppm.outbox.*` metrics are the operational signal for TruePPM's durable
execution: a rising `depth` or `oldest_age_seconds` means the CPM-recompute or
workflow-step dispatchers are falling behind. They complement the System Health
overview, which reports the same backlog in the admin UI. `trueppm.broker.queue.depth`
measures the next stage — messages the dispatchers have handed to Celery but no
worker has yet picked up — so a healthy outbox paired with a rising broker depth
points at under-scaled workers rather than a stuck dispatcher. The two `trueppm.ws.*`
instruments give WebSocket real-time collaboration its first quantitative signal:
how many live sockets a node holds and how much it is fanning out.

:::caution[Aggregate the `trueppm.*` gauges with `max`/`last`, never `sum`]
The `trueppm.outbox.*` and `trueppm.db.connections` gauges read **shared database
state**, and `trueppm.broker.queue.depth` reads the **shared broker**. Every TruePPM
process that exports telemetry — the web API, the Celery worker, and Celery beat —
reports the same cluster-wide figure as its own series (kept distinct by
`service.instance.id`). Summing across instances multiplies the true value; a
dashboard or alert must aggregate these gauges with `max` or `last` (for example
`max by (trueppm_outbox_name) (trueppm_outbox_depth)`). The HTTP, Celery, and
`trueppm.ws.*` metrics are **per-process** counts and rates — they aggregate
normally with `sum` across instances.
:::

:::note[TruePPM uses persistent connections, not a client-side pool]
`trueppm.db.connections` is the server-side backend count from `pg_stat_activity`,
because TruePPM holds persistent connections (`CONN_MAX_AGE`) rather than a
client-side connection pool. It answers "how close is this database to
`max_connections`?" — for per-pooler saturation, scrape your PgBouncer/pooler
directly.
:::

### Scraping with Prometheus

TruePPM exports metrics over **OTLP only** — there is no `/metrics` scrape endpoint,
which keeps telemetry a single, deliberate, opt-in egress with no always-on surface.
If your stack is Prometheus-native, run an [OpenTelemetry
Collector](https://opentelemetry.io/docs/collector/) as a bridge: receive TruePPM's
OTLP metrics and re-expose them for Prometheus to scrape.

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:            # point OTEL_EXPORTER_OTLP_ENDPOINT at this collector
exporters:
  prometheus:
    endpoint: "0.0.0.0:9464"   # Prometheus scrapes the collector here
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
```

## Structured logging & trace correlation

Alongside OTLP export, TruePPM 0.4 **will emit structured application logs**
correlated with the traces above. In production the API will write **single-line
JSON** to stdout — one object per log record — so your log stack (Loki,
Elasticsearch, CloudWatch) can index the fields directly instead of parsing free
text. Development keeps human-readable console output.

Every record will carry three correlation fields:

| Field | Value |
|---|---|
| `trace_id` | The active OpenTelemetry trace id (32-hex), or `null` when no span is active |
| `span_id` | The active span id (16-hex), or `null` |
| `request_id` | A per-request id, adopted from an inbound `X-Request-ID` header when present and otherwise generated, and echoed back on the response `X-Request-ID` header |

Because `trace_id` / `span_id` are formatted identically to the ids on the exported
spans, a slow request seen in Tempo/Jaeger can be pivoted straight to the exact log
lines emitted while that trace was active — and a user quoting the `X-Request-ID`
from their browser's network tab lets an operator find that request's logs directly.

:::note[Log correlation, not log export]
0.4 will ship structured logs to **stdout** for your existing log collector to
scrape. Shipping these records to the OTLP collector as OpenTelemetry log signals
is planned for a later release; for now, collect logs the way you already collect
container stdout.
:::

Two environment variables will control logging:

| Variable | Default | Purpose |
|---|---|---|
| `DJANGO_LOG_LEVEL` | `INFO` | Root log level (`DEBUG`, `INFO`, `WARNING`, `ERROR`). |
| `TRUEPPM_LOG_JSON` | `false` (base) / forced `true` in production | Emit JSON when `true`; human-readable console lines when `false`. Production always emits JSON. |

## Enterprise

The provider is an OSS extension point. The TruePPM Enterprise edition attaches
its own exporters and instrumentation against the **same** provider — no
additional collector wiring is required on your side beyond the settings above.
