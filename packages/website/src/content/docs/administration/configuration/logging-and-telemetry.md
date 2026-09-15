---
title: "Logging, telemetry and retention"
description: "Log output, OpenTelemetry export, and data-retention settings."
documentedFor: "0.4"
---

## Logging

| Variable | Default | What it does |
|----------|---------|--------------|
| `DJANGO_LOG_LEVEL` | `INFO` | Fleet-wide log level (`DEBUG`, `INFO`, `WARNING`, `ERROR`). `DEBUG` is verbose enough to matter on a busy instance — Docker's `json-file` driver has no size cap by default, so pair it with log rotation. The Helm chart exposes this as `logging.level`. |
| `TRUEPPM_LOG_JSON` | `false` | Emit one JSON object per log record instead of human-readable console output, so a collector (Loki, ELK, CloudWatch) can index the fields — including the OTel `trace_id` / `span_id` / `request_id` needed for log-to-trace correlation. **`settings.prod` forces this on regardless**, so it only affects non-production settings modules. |
| `SQL_LOG_LEVEL` | `WARNING` | Level for the `django.db.backends` logger. **Development settings only** (`settings/dev.py`); production's logging config does not read it. Set to `DEBUG` to print every SQL statement — the fastest way to find an N+1 locally. |
| `TRUEPPM_POD_NAME` | _(empty)_ | Stable per-pod identity for the OpenTelemetry [export-health record](/administration/observability/#live-export-health) shown on the Telemetry card. Set it from the downward API (`valueFrom.fieldRef.fieldPath: metadata.name`); left empty, the record falls back to `hostname:pid`, which on Kubernetes is already the pod name — this variable is a convenience for a non-Kubernetes deploy or a custom hostname policy, not something export health needs to function. It has no effect on log lines: nothing in the logging pipeline reads it. |

## OpenTelemetry

Telemetry is **opt-in with no default endpoint**: leave `OTEL_EXPORTER_OTLP_ENDPOINT`
empty and no provider is installed at all — a strict no-op with no per-request
cost. The Helm chart renders every variable below from its structured
`observability.otlp.*` block; set them directly only on Compose or a bare
container. See [Observability](/administration/observability/) for collector
wiring.

| Variable | Default | What it does |
|----------|---------|--------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(empty)_ | Your collector, e.g. `http://otel-collector:4317`. **Empty disables telemetry entirely** — this is the master switch, not `TRUEPPM_OTEL_ENABLED`. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` | `grpc` (4317) or `http/protobuf` (4318). Must match what your collector listens for. |
| `OTEL_EXPORTER_OTLP_HEADERS` | _(empty)_ | Comma-separated `key=value` headers, for a SaaS OTLP endpoint's bearer token. Supply through a Secret — it is a credential. |
| `OTEL_SERVICE_NAME` | `trueppm-api` | `service.name` resource attribute. Change it when several TruePPM instances report to one backend. |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | Standard OTel sampler name. Use `parentbased_traceidratio` with the argument below to sample a fraction of traces on a busy instance. |
| `OTEL_TRACES_SAMPLER_ARG` | _(empty)_ | Sampler argument — with `parentbased_traceidratio`, the ratio (`0.1` = 10%). |
| `TRUEPPM_OTEL_ENABLED` | `true` | Master kill switch **within** an already-configured endpoint. Set `false` to stop exporting without unsetting the endpoint, e.g. to isolate telemetry as a suspect during an incident. |
| `TRUEPPM_OTEL_TRACES_ENABLED` | `true` | Export traces. Turn off to keep metrics only — traces are by far the higher-volume signal. |
| `TRUEPPM_OTEL_METRICS_ENABLED` | `true` | Export metrics. |
| `TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED` | `true` | Attach the acting user's id to spans. **Set `false` if your tracing backend is not an appropriate place for user identifiers** — that is a data-protection decision, not a performance one. |
| `TRUEPPM_OTEL_EXPORT_HEALTH_ENABLED` | `true` | Track whether telemetry export is itself succeeding, so a silent collector outage is visible rather than looking like an idle system. |
| `TRUEPPM_OTEL_EXPORT_HEALTH_WINDOW_SECONDS` | `60` | Rolling window over which export attempts are counted. |
| `TRUEPPM_OTEL_EXPORT_HEALTH_HEALTHY_WITHIN_SECONDS` | `150` | A successful export within this many seconds means healthy. Raise it if your collector is behind a flaky link. |
| `TRUEPPM_OTEL_EXPORT_HEALTH_STALENESS_SECONDS` | `600` | No successful export in this long means stale. |

## Retention

Every window below is enforced by a nightly Celery beat job, so **beat must be
running** for any of them to apply. **Never set one to `0`** — a zero-day window
puts the cutoff at the present moment, so the next run deletes everything in
scope. Several of these are also editable in
[Retention & purge](/administration/retention/); the environment variable is the
default the app starts with.

| Variable | Default | What it does |
|----------|---------|--------------|
| `TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` | `30` | Days a trashed project stays recoverable before it is hard-deleted with all its children by CASCADE. **`0` is refused at boot** — it would purge every trashed project on the next tick, irreversibly and with no tombstone. |
| `TRUEPPM_TOMBSTONE_RETENTION_DAYS` | `90` | Days deletion tombstones are kept for the offline sync protocol. This is the **floor on how long a mobile client may stay offline**: a device that syncs after longer than this will not learn about deletions and keeps rows the server has dropped. Raise it if your field users go offline for months; do not lower it below your longest expected offline period. |
| `TRUEPPM_BATCH_OPERATION_RETENTION_DAYS` | `30` | Days batch-operation records (bulk edits, imports) are kept for review before purging. |
| `TRUEPPM_BOARD_EVENT_RETENTION_HOURS` | `24` | **Hours**, not days. Board events back the real-time replay window for a client that reconnects; a longer window costs storage on a table with high write volume. |
