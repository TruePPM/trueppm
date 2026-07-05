---
title: OpenTelemetry & OTLP Export
description: How to export TruePPM's traces and metrics to your own OpenTelemetry collector over OTLP — an opt-in, off-by-default integration configured with environment variables or Helm values.
---


:::note[Lands in 0.4 (first beta)]
The OpenTelemetry foundation described here **ships in TruePPM 0.4**, the first
beta. It is the provider and configuration groundwork; richer business-logic spans
across views, the ORM, Celery, and the scheduler engine follow in later 0.4 work
(#707–#710).
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

## What this release ships

- A provider bootstrap that builds the OTel `TracerProvider` / `MeterProvider` at
  API startup and wires the OTLP exporter — **only** when an endpoint is set.
- The opt-in configuration surface below (environment variables + Helm values).
- A stable `trueppm.*` span- and resource-attribute naming convention.

Auto-instrumented spans for individual endpoints, database queries, and Celery
tasks are **not** part of this foundation; they arrive in later 0.4 work. Once you
configure a collector now, you will see TruePPM's resource identity and any spans
emitted by instrumentation as it lands — without re-configuring anything.

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

TruePPM-owned span attributes live under the reserved **`trueppm.*`** namespace
(for example `trueppm.project.id`, `trueppm.task.id`, `trueppm.user.role`), so you
can filter and group TruePPM signals cleanly in your backend. Attributes that
follow OpenTelemetry's own semantic conventions (`http.*`, `db.*`, `messaging.*`)
keep their standard keys.

## Enterprise

The provider is an OSS extension point. The TruePPM Enterprise edition attaches
its own exporters and instrumentation against the **same** provider — no
additional collector wiring is required on your side beyond the settings above.
