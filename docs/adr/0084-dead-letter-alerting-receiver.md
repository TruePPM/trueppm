# ADR-0084: OSS Dead-Letter Alerting Receiver

## Status
Proposed

## Context

**P3M layer:** Operations (operator/maintenance telemetry). Repo: **OSS** — a solo PM
self-hosting TruePPM must know when their background work has silently died; this is not
cross-program governance.

When a Celery task exhausts its retries, `scheduling/deadletter.py::record_failed_task()`
upserts a `FailedTask` row (status `DEAD`) and logs `logger.error(...)`. **Nothing else is
wired to that event** — no operator-facing alert, no counter, no enterprise hook. A solo
operator has no signal that work was dead-lettered short of reading the admin viewset by hand.

ADR-0017 ("Celery Task Hardening") established the `FailedTask` model and four Django signals
(`celery_task_started / succeeded / failed / retried` in `scheduling/signals.py`) bridged from
Celery framework signals in `SchedulingConfig.ready()`, documented as the enterprise
PagerDuty/Slack alerting extension point. ADR-0080 §C buckets full dead-letter tooling under
"1.0 engine maturity," but the *alerting* gap is a Day-1 ops problem that does not need to wait
for the workflow interface.

Three forces shape the design:

1. **No dedicated permanent-failure signal exists.** `celery_task_failed` is bridged from
   Celery's `task_failure`, which fires on *every* failure — including failures that will be
   retried. It therefore cannot be used to alert "this is permanently dead" without
   double-firing on every transient blip. A distinct signal is required.

2. **No metrics client is installed and none is precedented.** There is no
   statsd/prometheus_client/datadog/opentelemetry dependency in `packages/api/pyproject.toml`,
   and ADR-0081 deliberately models OSS observability as **DB-backed state + structured logs +
   HTTP endpoints scraped by Prometheus** (the `/health/beat/` 200/503 pattern), not as a
   metrics-emission pipe.

3. **A process-local counter is incorrect by construction.** `record_failed_task()` runs in
   the **Celery worker** process; a Prometheus scrape or the #692 dashboard query hits the
   **web** process. An in-process `int`/`Counter` incremented in the worker is invisible to the
   scraper. The counter must live in a store shared across processes. `FailedTask` already *is*
   that store — one durable row per dead-lettered `task_id`.

## Decision

Add a dedicated permanent-failure signal, an OSS log-only receiver, and a Prometheus-text
metrics endpoint that **derives** the counter from `FailedTask`. No new model, no new
dependency, no Redis counter.

### 1. Signal (`scheduling/signals.py`)

Add a fifth sibling to the existing `celery_task_*` family:

```python
# Sent when a Celery task is permanently dead-lettered (retries exhausted).
# kwargs: task_id, task_name, exception, traceback_str, project_id (None if unknown)
celery_task_permanently_failed = django.dispatch.Signal()
```

Naming follows the existing `celery_task_*` family for a stable enterprise extension contract
(the issue's informal `task_permanently_failed` maps to this). The signal docstring carries the
enterprise-registration example, mirroring `projects/signals.py` — **zero OSS imports of
`trueppm_enterprise`.**

### 2. Fire point (`scheduling/deadletter.py::record_failed_task()`)

Fire the signal **after** the `update_or_create` block, **only when `created is True`**, so the
alert fires once per newly dead-lettered `task_id` and the `failure_count++` repeat branch does
not re-alert. Thread an optional `project_id: str | None = None` parameter through
`record_failed_task()` and pass it from the sole caller `_dead_letter_current` (where
`project_id` is in scope as `recalculate_schedule`'s first arg). For any future generic
`task_failure`-bridged path, `project_id` is `None` — acceptable per the issue's "if available."
**No heuristic sniffing of `args`/`kwargs`.**

### 3. OSS receiver (`scheduling/receivers.py`, registered via `SchedulingConfig.ready()`)

Pattern A (import-for-side-effects, identical to `NotificationsConfig.ready()`):
`from . import receivers  # noqa: F401`. The receiver:

- Emits a structured `logger.warning(...)` with `extra={"task_name", "task_id",
  "exception_type", "project_id"}`. WARNING is intentionally a distinct, lower-severity line
  from the existing `logger.error` in `record_failed_task` (which records the raw failure; this
  records the *alert*).
- Is **exception-safe** — wrapped so an alerting failure can never mask or re-raise into the
  dead-letter recording path. A receiver on the failure path that can itself fail is a footgun.
- Does **no DB write.** The durable record already exists (`FailedTask`).

### 4. Counter exposure (`observability` app — Prometheus text endpoint)

Add `GET /api/v1/health/dead-letter/` (`IsAdminUser`, bearer-scrapeable, mirroring
`/health/beat/` from ADR-0081) emitting Prometheus text format derived from `FailedTask`:

```
# HELP trueppm_task_dead_letter_parked Permanently dead-lettered Celery tasks currently awaiting operator action, by task name.
# TYPE trueppm_task_dead_letter_parked gauge
trueppm_task_dead_letter_parked{task_name="scheduling.recalculate_schedule"} 3
```

Computed as `FailedTask.objects.filter(status=DEAD).values("task_name").annotate(n=Count("id"))`.
This is typed a **gauge**, not a counter: it counts *currently parked* dead-letters, so it falls
when a task is dismissed, retried, or purged (the issue's informal "counter" wording is honored
by exposing the `{task_name}`-labelled metric; the Prometheus type is corrected to gauge for
semantic accuracy). It satisfies the AC "counter metric exposed", is cross-process correct (reads
committed DB rows, so it sees dead-letters the Celery worker recorded even though the web process
serves the scrape), adds zero dependencies, and gives #692 a ready source for parked count /
oldest age / top cause / alerts-fired-24h (all derivable from `FailedTask` columns: `status`,
`first_failed_at`, `exception_type`).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Reuse `celery_task_failed`, no new signal** | No signal added | Fires on every transient failure → alert storms; cannot mean "permanent." Breaks the contract. Rejected. |
| **B. Add `statsd`/`prometheus_client` dependency + real counter** | "Real" metrics; standard | New dep (dependency-agent + Apache-2.0 license review), new scrape infra, unprecedented in any ADR, and *still* needs a shared registry across worker/web. Over-built for a Day-1 gap. |
| **C. Process-local in-memory counter** | Trivial | Incorrect: increment in worker invisible to web-process scrape. Rejected on correctness. |
| **D. New `DeadLetterAlert` model in observability** | Explicit alert audit; stores "alerts-fired-24h" directly | Redundant with `FailedTask` (one row already = one dead-letter = one OSS alert); adds a migration and a DB write on the failure path (new failure mode). Defer until alert dedup/suppression is a real requirement. |
| **E (chosen). Dedicated signal + log-only receiver + FailedTask-derived Prometheus endpoint** | No new model, no new dep, cross-process correct, matches ADR-0081 philosophy, unblocks #692, receiver can't fail the failure path | Counter is computed per-scrape (cheap: indexed `status`, bounded cardinality by `task_name`); "alerts-fired-24h" is derived, not a literal alert log |

## Consequences

- **Easier:** Enterprise registers PagerDuty/Slack by connecting one receiver to
  `celery_task_permanently_failed` in its own `AppConfig.ready()` — no OSS change. #692 reads
  one endpoint. No new operational moving parts (no dep, no model, no migration).
- **Harder:** The counter is query-derived, so a future need for true event-stream metrics
  (rate over time, P95 latency) would still require the deferred metrics backend (tracked at
  1.0 per ADR-0080 §C / observability #656). Acceptable.
- **Risks:** (1) A signal receiver on the failure path that raises could mask the original
  failure — mitigated by mandatory exception-safety. (2) Unbounded `task_name` cardinality
  would bloat the Prometheus series — bounded in practice because task names are a small static
  set of registered Celery tasks.

## Implementation Notes

- P3M layer: **Operations**
- Affected packages: **api** (`scheduling`: signals, deadletter, receivers, apps; `observability`:
  views, urls). No web/mobile/scheduler/helm change.
- Migration required: **no** (no schema change — the key design win)
- API changes: **yes** — new `GET /api/v1/health/dead-letter/` (admin-only, Prometheus text)
- OSS or Enterprise: **OSS** (Enterprise registers an additional receiver against the new signal)

### Durable Execution
1. **Broker-down behaviour:** N/A — the receiver is a synchronous in-process Django signal
   handler running inside the Celery worker that is already handling the failure. No new
   dispatch, no `.delay()`.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A — no new dispatch path. The signal `.send()` is added inside the
   existing `record_failed_task()` helper.
5. **API response on best-effort dispatch:** N/A — the new endpoint is a synchronous read
   (Prometheus scrape), returns 200 with the metric text.
6. **Outbox cleanup:** N/A. `FailedTask` retention is governed separately (retention/purge,
   #661/#693); this ADR adds no new rows.
7. **Idempotency:** The signal fires only on `created is True` in `update_or_create`, so a
   re-delivered dead-letter for the same `task_id` does not re-alert. The derived counter is
   inherently idempotent (one `FailedTask` row per `task_id`, counted by query).
8. **Dead-letter / failure handling:** This *is* the dead-letter alerting. The OSS terminal
   behaviour: `FailedTask(status=DEAD)` row (pre-existing) + WARNING alert log + signal for
   enterprise receivers. Re-trigger of a dead-lettered task is out of scope (ADR-0080's
   `workflow_retry` management command / the FailedTask retry action, #693-adjacent). The
   receiver itself must never raise.
