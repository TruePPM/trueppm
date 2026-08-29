---
title: Beat Liveness
description: How TruePPM detects a dead Celery Beat process, the heartbeat endpoint that survives total task-infrastructure failure, and how to wire it into monitoring.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

Every asynchronous job in TruePPM — CPM recalculation drains, webhook delivery,
MS Project imports, retention purges, notification email — is driven by periodic
**Celery Beat** tasks. There is exactly **one Beat process** per install: the Helm
chart pins its Deployment to `replicas: 1` with a `Recreate` strategy, and the
Compose stacks run a single `celery-beat` service. If it dies, every drain stops
and the outbox tables accumulate indefinitely, with no signal until a downstream
consumer notices missing work.

To make that failure visible, the API records a **heartbeat** and exposes it for
monitoring.

:::note[Edition]
Redundant Beat with leader-election failover is an Enterprise HA feature
(`enterprise#20`). This page covers the basic detection layer every adopter gets.
:::

For the broader picture — what survives a pod loss, what a Beat outage actually
costs you, and how to make the rest of the stack redundant — see
[Durability & Redundancy](/administration/durability/).

## How it works

- A `beat.heartbeat` task runs **every 30 s** and writes the current time to a single
  `BeatHeartbeat` row.
- `GET /api/v1/health/beat/` reads that row and reports whether the heartbeat is
  **stale** — older than `TRUEPPM_BEAT_STALE_SECONDS` (default **120 s**, i.e. four
  missed beats). Staleness is computed on read, so the endpoint reports the truth even
  when Beat and the workers are completely down — the one detector that survives total
  task-infrastructure failure.
- A `beat.check_stale_heartbeat` task runs **every 60 s** and logs a `WARNING` when the
  heartbeat is stale — a secondary, in-cluster signal for deployments with no external
  monitoring.

:::note
A Beat-scheduled stale check (rather than a self-rescheduling worker chain) is used on
purpose: it self-heals on Beat restart and cannot silently lose itself. Total Beat +
worker death is detected externally via the endpoint, not from inside the cluster. See
ADR-0081 for the full rationale.
:::

## The `/api/v1/health/beat/` endpoint

Requires a **staff (admin)** account — it exposes operational state, so it is gated with
`IsAdminUser`. Responses:

| Condition | Status | Body |
|---|---|---|
| Heartbeat fresh | `200 OK` | `{"last_heartbeat": "<iso8601>", "stale": false}` |
| Heartbeat stale | `503 Service Unavailable` | `{"last_heartbeat": "<iso8601>", "stale": true}` |
| No heartbeat recorded yet | `503 Service Unavailable` | `{"last_heartbeat": null, "stale": true}` |

The `200` / `503` split lets status-code-driven monitoring alert without parsing the
body.

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_JWT" \
  https://trueppm.example.com/api/v1/health/beat/
# exits non-zero (curl -f) when Beat is stale (HTTP 503)
```

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `TRUEPPM_BEAT_STALE_SECONDS` | `120` | Age past which the heartbeat is considered stale, for both the endpoint flag and the WARNING log |

## Recurring-task occurrence generation

The other Beat-scheduled job worth knowing by name is
`projects.generate_recurring_occurrences`, which runs **hourly** and materializes
recurring-task occurrences lazily — only those due within
`TRUEPPM_RECURRENCE_HORIZON_DAYS` (default 14), rather than the full, possibly
infinite series. A missed tick self-heals on the next one, because generation is
idempotent through a per-occurrence unique constraint, so nothing is lost if Beat
briefly stops. See [Recurring tasks](/features/recurring-tasks/) for the feature
itself and [Configuration](/administration/configuration/) for the knob.

## Wiring it into Kubernetes / monitoring

`/api/v1/health/beat/` is **authenticated**, so it is not a drop-in `httpGet` liveness
probe. Use it as follows:

- **Basic API liveness** → the unauthenticated `GET /api/v1/health/` returns
  `200 {"status": "ok"}` while the API process is up. It is a *process-alive* check and
  nothing more: it opens no database connection and touches no cache, so a pod whose
  datastores are unreachable still answers `200`. Do **not** point a *readiness* probe
  at it — readiness needs a dependency-aware check, which is a separate endpoint. See
  [Durability & Redundancy](/administration/durability/#health-and-readiness-endpoints)
  for which endpoint belongs on which probe.
- **Beat liveness alerting** → scrape `GET /api/v1/health/beat/` from Prometheus (or any
  monitor) with a bearer token, and alert on a non-`200` status code. This is the
  recommended external detector for the single-Beat SPOF.
- **No external monitoring?** → the `beat.check_stale_heartbeat` WARNING in the worker
  logs is your fallback signal; forward worker logs to your aggregator and alert on the
  `check_stale_heartbeat` message.

## Related pages

- [Durability & Redundancy](/administration/durability/) — what survives a pod, node, or
  datastore loss, and the step-up ladder to a redundant install.
- [System Health](/administration/system-health/) — the in-app Beat panel and
  dead-letter inspector.
- [Troubleshooting](/administration/troubleshooting/) — symptom-keyed diagnosis,
  including "Celery is not processing anything".
- [Dead-letter Alerting](/administration/dead-letter-alerting/) — what happens to work
  that fails permanently rather than never starting.
