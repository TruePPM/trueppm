# Beat liveness and durability

Every asynchronous job in TruePPM — CPM recalculation drains, webhook delivery,
MS Project imports, retention purges, notification email — is driven by periodic
**Celery Beat** tasks. In a single-pod deployment (the common self-hosted shape) there
is exactly **one Beat process**. If it dies, every drain stops and the outbox tables
accumulate indefinitely, with no signal until a downstream consumer notices missing work.

To make that failure visible, the API records a **heartbeat** and exposes it for
monitoring. (Redundant Beat with leader-election failover is an Enterprise HA feature,
enterprise#20; this page covers the basic detection layer every adopter gets.)

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

> A Beat-scheduled stale check (rather than a self-rescheduling worker chain) is used on
> purpose: it self-heals on Beat restart and cannot silently lose itself. Total Beat +
> worker death is detected externally via the endpoint, not from inside the cluster. See
> ADR-0081 for the full rationale.

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
| `TRUEPPM_RECURRENCE_HORIZON_DAYS` | `14` | Look-ahead window (days) for recurring-task occurrence generation — see below |

## Recurring-task occurrence generation

Recurring tasks (daily standups, weekly status reports, monthly reviews) are spawned by
the `projects.generate_recurring_occurrences` Beat task, which runs **hourly**. It
materializes occurrences **lazily** — only those due within
`TRUEPPM_RECURRENCE_HORIZON_DAYS` (default 14) — rather than the full, possibly infinite
series. A missed hourly tick self-heals on the next one (generation is idempotent via a
per-occurrence unique constraint), so no occurrence is lost if Beat briefly stops.

Recurring templates and their generated occurrences are deliberately **excluded from CPM
and Monte Carlo** — they are parallel, calendar-driven activities, not nodes in the
schedule's logical network. There is no operator action required; the exclusion is
enforced in the scheduling engine (ADR-0090).

## Wiring it into Kubernetes / monitoring

`/api/v1/health/beat/` is **authenticated**, so it is not a drop-in `httpGet` liveness
probe. Use it as follows:

- **Basic API liveness/readiness probes** → keep using the unauthenticated
  `GET /api/v1/health/`, which returns `200 {"status": "ok"}` while the API process is up.
- **Beat liveness alerting** → scrape `GET /api/v1/health/beat/` from Prometheus (or any
  monitor) with a bearer token, and alert on a non-`200` status code. This is the
  recommended external detector for the single-Beat SPOF.
- **No external monitoring?** → the `beat.check_stale_heartbeat` WARNING in the worker
  logs is your fallback signal; forward worker logs to your aggregator and alert on the
  `check_stale_heartbeat` message.
