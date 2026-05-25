# ADR-0086: System Health Operator UI — Read API Surface

## Status
Proposed

## Context

Epic #691 adds a workspace-admin "System Health" operator UI for the durable-execution
layer (transactional outbox, Celery Beat, dead-letter queue, retention purge). The
backend mechanics landed across 0.2 — ADR-0081 (Beat liveness + retention hardening) and
ADR-0084 (dead-letter alerting receiver) — but there is **no UI** for an operator to
inspect health or triage dead-lettered tasks.

This ADR covers the **two read-only surfaces shippable now**:

- **#692 — System health overview dashboard** (live, 10 s refresh).
- **#694 — Dead-letter inspector** (read-only list + detail).

The third surface, **#693 — retention & purge policy editor**, is **deliberately split
to a separate MR**. Retention values are settings-driven and `None`-disablable per
ADR-0081 §A/§D; making them runtime-editable requires a net-new DB-backed override model
and a purge-run history model, plus an ADR-0081 amendment. That work does not belong in a
read-only MR and is tracked separately.

**P3M layer:** Operations (single-deployment operator hygiene). This is **not**
cross-program governance — it serves the self-hosting operator of a single workspace, so
it is OSS per the adoption-lens boundary. (The compliance-grade overlay — locked retention
floors, policy-change audit trail, immutable audit-log retention — is Enterprise,
trueppm-enterprise#137.)

**VoC note:** the 8-persona panel scored this 3.25/10 — a *wrong-panel* artifact, since
none of TruePPM's product personas is a self-hosting operator/sysadmin (the actual
audience). The one genuine cross-persona finding — a non-admin, in-app "background
processing degraded" signal — is split to **#723** and is out of scope here.

### Backend reality that shapes this design

The issue specs were drafted from a `System Health.html` mockup that assumed
**webhook-delivery semantics** (HTTP status codes, per-attempt backoff log, per-subscriber
breakdown). The OSS dead-letter model is **`FailedTask`** — a generic *Celery* dead-letter
with `exception_type`, `exception_message`, `traceback`, a single `failure_count`, and
`args`/`kwargs`. It has **no** HTTP codes, **no** per-attempt log, **no** subscriber
dimension. The design must be reframed to the data that actually exists.

## Decision

### 1. Dead-letter inspector reads `FailedTask` directly — no new model

Per ADR-0084 (which explicitly rejected a `DeadLetterAlert` model), the inspector queries
**`FailedTask`** via the **existing** `FailedTaskViewSet` (`GET /api/v1/admin/failed-tasks/`,
`IsAdminUser`). We do **not** also surface `WebhookDelivery` — conflating Celery
dead-letters with HTTP delivery failures would muddy the inspector, and webhook deliveries
are already exposed project-scoped under `WebhookViewSet`.

The mockup's "attempt log with backoff/latency/HTTP code" is reframed to an **attempt
summary** backed by real fields: `first_failed_at`, `last_failed_at`, `failure_count`,
`exception_type`. We do **not** fabricate per-attempt rows we cannot reconstruct.

Backend change is minimal — **add filtering** to the existing viewset (no new endpoint, no
model, no migration):

- `?status=` (`dead` | `pending_retry` | `dismissed` | `retried`)
- `?task_name=` (icontains)
- `?failed_after=` / `?failed_before=` (ISO; filter on `last_failed_at`)
- default ordering `-last_failed_at` (already the model default).

The detail endpoint `GET /api/v1/admin/failed-tasks/{id}/` already returns the full record,
including `args`/`kwargs`/`traceback` — these **are** the "payload viewer" content and are
appropriate to expose to `IsAdminUser` (see §5). The viewset's existing `retry`/`dismiss`
write actions remain on the backend but are **not wired into the 0.2 UI** (deferred to 0.4,
#652).

### 2. One new read-only aggregation endpoint for the overview

`GET /api/v1/health/system/` — a function view in **`apps.observability`** (the established
home for `/health/*` per ADR-0081/0084), `permission_classes=[IsAdminUser]`, always HTTP
200 with statuses in the body (unlike `/health/beat/`'s 200/503 probe contract). It
composes existing signals in a handful of aggregate queries (no N+1; safe for 10 s refresh):

```jsonc
{
  "generated_at": "2026-05-25T17:00:00Z",
  "components": [
    { "key": "outbox_dispatcher",      "label": "Outbox dispatcher",      "status": "ok",      "state_label": "Healthy",  "meta": "0 dead, 0 stuck >10m" },
    { "key": "celery_beat",            "label": "Celery Beat",            "status": "ok",      "state_label": "Live",     "meta": "last beat 8s ago" },
    { "key": "dead_letter",            "label": "Dead-letter alerting",   "status": "warn",    "state_label": "3 parked", "meta": "oldest 2h20m" },
    { "key": "notification_dispatcher","label": "Notification dispatcher","status": "ok",      "state_label": "Draining", "meta": "0 failed-pending" },
    { "key": "retention_purge",        "label": "Retention purge",        "status": "unknown", "state_label": "No telemetry", "meta": "purge-run history not recorded in OSS" }
  ],
  "beat": {
    "last_heartbeat": "2026-05-25T16:59:52Z",
    "seconds_since": 8,
    "stale": false,
    "stale_threshold_seconds": 120
  },
  "scheduled_tasks": [
    { "name": "beat-heartbeat", "task": "beat.heartbeat", "cadence": "every 30s", "category": "heartbeat" },
    { "name": "drain-webhook-queue", "task": "webhooks.drain_webhook_queue", "cadence": "every 30s", "category": "drain" },
    { "name": "webhook-deliveries-purge-nightly", "task": "webhooks.purge_old_deliveries", "cadence": "daily 03:30 UTC", "category": "purge" }
    // … derived statically from settings.CELERY_BEAT_SCHEDULE
  ],
  "dead_letter": {
    "parked": 3,
    "oldest_age_seconds": 8400,
    "top_cause": "ConnectionError",
    "by_status": { "dead": 3, "pending_retry": 1, "dismissed": 0, "retried": 5 }
  },
  "retention": [
    { "key": "TRUEPPM_WEBHOOK_RETENTION_DAYS", "label": "Webhook deliveries", "days": 7,  "disabled": false },
    { "key": "TRUEPPM_IMPORT_RETENTION_DAYS",  "label": "Import requests",    "days": 7,  "disabled": false },
    { "key": "HISTORY_RETENTION_DAYS",         "label": "Event history",      "days": 90, "disabled": false },
    { "key": "TASK_RUN_RETENTION_DAYS",        "label": "Task runs",          "days": 30, "disabled": false },
    { "key": "TRUEPPM_SYNC_BATCH_RETENTION_HOURS", "label": "Sync batches", "hours": 24, "disabled": false }
  ]
}
```

Read-only `inline_serializer` is used for OpenAPI schema generation (matching the existing
`beat_health`/`dead_letter_metrics` convention — `apps.observability` has no `serializers.py`).

### 3. Component status derivation + graceful degradation

| Component | Backing signal | Status rule | Degrades to |
|---|---|---|---|
| Outbox dispatcher | `ScheduleRequest` (+ `WorkflowOutboxRow`) status counts | `crit` if any `dead`; `warn` if any `dispatched` older than the 10 min orphan window; else `ok` | n/a (always queryable) |
| Celery Beat | `BeatHeartbeat.last_heartbeat` | `crit` if stale (> `TRUEPPM_BEAT_STALE_SECONDS`) or never recorded; else `ok` | n/a |
| Dead-letter alerting | `FailedTask` where `status=dead` | `crit` if oldest dead > 24 h; `warn` if any dead; else `ok` | n/a |
| Notification dispatcher | `Notification` aggregate (`email_pending` + `email_failed_at` + `email_attempts`) | `warn` if any `email_pending=True AND email_attempts>0 AND email_failed_at` older than 1 h; else `ok` (heuristic — no terminal "dead" state exists) | n/a |
| Retention purge | **none** (no purge-run model exists) | always **`unknown`** | **`unknown`** — explicit, never fabricated |

The **`unknown`** state is a first-class status, rendered as a neutral/muted card (not
green, not red), with meta copy "purge-run history not recorded in OSS." It is resolved
when #693 introduces a purge-run history model.

### 4. Scheduled-tasks list is the configured schedule, not last-run

There is **no per-task last-run tracking** (only the single global `BeatHeartbeat`). The
scheduled-tasks list is derived **statically** from `settings.CELERY_BEAT_SCHEDULE` — `name`,
`task`, `cadence` (humanized from the crontab/interval), and `category` (heartbeat / drain /
purge / snapshot). It is **informational** ("here's what Beat runs and how often"); overall
Beat liveness is answered by the heartbeat panel. No `last_run` column in 0.2 — inventing
per-task tracking is out of scope.

### 5. Permission gate: `IsAdminUser` (Django `is_staff`)

Confirmed consistent with ADR-0081 §C and ADR-0084: for a single-deployment OSS install
there is no project in scope, and `IsAdminUser` is the idiomatic global-admin gate. This is
**not** project-scoped 5-role RBAC. Exposing `args`/`kwargs`/`traceback` (potentially
sensitive) to `is_staff` only is acceptable — it is the same trust level that already reads
`/health/dead-letter/` metrics and the existing `FailedTaskViewSet` detail. The
aggregation endpoint exposes **no** payloads (counts + config only); payloads appear only in
the dead-letter **detail** view, which the operator explicitly drills into.

### 6. OSS/Enterprise boundary

No extension point is required for #692/#694. ADR-0029 governs *frontend* slot injection;
backend `/health/*` endpoints are OSS infrastructure, not injected by Enterprise. Enterprise
adds *signal receivers* (ADR-0084) and *slot components* (ADR-0029/0030), not health
endpoints. `grep -r "trueppm_enterprise" packages/` remains zero in OSS.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Aggregation endpoint** (chosen) | One round-trip per 10 s refresh; single query budget to perf-check; stable frontend contract | One new (small) view to maintain |
| Frontend composes existing `/health/beat/` + `/health/dead-letter/` + N | No new backend | 3+ requests every 10 s; `/health/dead-letter/` is Prometheus text (needs client-side parsing); no place to compose component statuses or retention config; worse perf |
| Surface `WebhookDelivery` in the inspector too | Matches the mockup's HTTP-code columns | Conflates two failure domains; deliveries are project-scoped, not a workspace dead-letter; no admin cross-webhook endpoint exists |
| New `DeadLetterAlert`/`PurgeRun` models now | Real per-attempt + purge telemetry | Explicitly rejected by ADR-0084; migration + write-path cost; belongs with #693 |

## Consequences

**Easier:** operators get health visibility + dead-letter triage with **zero new models and
zero migrations**; the contract is API-first and stable; #693's harder persistence questions
are isolated.

**Harder:** the UI will visibly differ from the `System Health.html` mockup — no HTTP-code
columns, no per-attempt backoff log, no per-subscriber breakdown, and a muted "unknown"
Retention-purge card. This is intentional (honest to the data) and must be reflected in
ux-design and docs.

**Risks:** (1) the Notification-dispatcher status is a heuristic (no terminal dead state) —
documented as best-effort. (2) The aggregation endpoint must stay within query budget at
10 s refresh — perf-check gate before merge. (3) ADR number 0086 chosen to avoid colliding
with an in-flight (unmerged) 0085 in a parallel worktree.

## Implementation Notes

- **P3M layer:** Operations.
- **Affected packages:** `api` (`apps.observability` new aggregation view + url; `apps.scheduling` viewset filtering), `web` (new System health nav group, overview + dead-letter inspector pages, hooks, regenerated `types.ts`), `docs` (`docs/administration/`).
- **Migration required:** **no.**
- **API changes:** **yes** — new `GET /api/v1/health/system/`; filter params added to existing `GET /api/v1/admin/failed-tasks/`.
- **OSS or Enterprise:** **OSS** (trueppm-suite).

### Durable Execution
1. **Broker-down behaviour:** N/A — this feature has no async side effects. It is pure read aggregation (`GET`) plus a client-side "Force refresh" (re-fetch). No `.delay()`, no dispatch.
2. **Drain task:** N/A — no new async work. (It *reads* existing outbox/dead-letter/heartbeat state populated by existing drains; it adds none.)
3. **Orphan window:** N/A for dispatch. The aggregation *applies* the existing 10 min orphan threshold when classifying `dispatched` outbox rows as "stuck", to avoid flagging in-flight commits — but it creates no rows itself.
4. **Service layer:** N/A — no dispatch path. Aggregation logic lives in a read-only `apps/observability/selectors.py` (or inline in the view); no `services.py` mutation function.
5. **API response on best-effort dispatch:** N/A — all endpoints are synchronous reads returning 200 with data.
6. **Outbox cleanup:** N/A — no outbox rows created.
7. **Idempotency:** Reads are inherently idempotent; "Force refresh" is a safe repeatable `GET`.
8. **Dead-letter / failure handling:** N/A as a *producer*. This feature is a read *consumer* of the dead-letter table (`FailedTask`); it adds no task that could itself fail permanently. Existing retry/dismiss actions on `FailedTaskViewSet` are unchanged and remain `IsAdminUser`-gated (UI deferred to 0.4, #652).

### API-first endpoint contract (frontend consumes)
- `GET /api/v1/health/system/` → overview payload (shape above). `IsAdminUser`. 10 s `refetchInterval`.
- `GET /api/v1/admin/failed-tasks/?status=&task_name=&failed_after=&failed_before=` → paginated list. `IsAdminUser`.
- `GET /api/v1/admin/failed-tasks/{id}/` → full detail incl. `args`/`kwargs`/`traceback` (payload viewer). `IsAdminUser`.
- Frontend routes: `/settings/health` (overview, #692) and `/settings/health/dead-letters` (inspector, #694), under the workspace settings shell, new "System" nav group.
