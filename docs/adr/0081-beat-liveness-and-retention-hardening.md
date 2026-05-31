# ADR-0081: Beat Liveness Detection and Outbox Retention Hardening

## Status: Accepted

## Context

TruePPM's durability surface (transactional outbox + Celery, see ADR-0080 and
[[project_durable_execution.md]]) depends on a **single Celery Beat process** to
drive every periodic drain and purge. Two gaps in the OSS edition fall out of that:

1. **Unbounded outbox growth.** `scheduling.purge_old_schedule_requests`,
   `msproject.purge_old_import_requests`, and the sprint-close purge keep their
   respective tables small, but `WebhookDelivery` has **no purge** — high-traffic
   boards generate thousands of delivery rows per day. The import purge also exists
   but **hardcodes a 7-day window** with no operator override, and `ImportRequest`
   rows carry multi-MB `file_content_b64` blobs.
2. **Beat is a silent SPOF.** If Beat dies, every drain stops and the outbox tables
   accumulate indefinitely with **no signal** until a downstream consumer notices
   missing work. Single-pod deployments — the common OSS shape — have no redundancy.
   Enterprise HA (enterprise#20) adds redundant Beat with leader election on top;
   this ADR covers the basic detection layer every adopter needs.

These ship together (issues #661, #662) because both are Beat-periodic-task
hardening on the same outbox plumbing and share the retention/observability surface.

**P3M layer:** Infrastructure (cross-layer). Foundational plumbing under Programs
and Projects (OSS); Enterprise HA layers redundancy on top.

## Decision

### A. Retention purge (#661)

- New `webhooks.purge_old_deliveries` Beat task deletes `WebhookDelivery` rows in a
  **terminal** state (`SUCCESS` or `FAILED`) older than the retention window. `PENDING`
  rows are never purged — the drain may still re-dispatch them. Age is measured by
  `created_at`. Business logic lives in `_do_webhook_purge()` for testability, mirroring
  the existing `_do_import_purge()` / `_do_purge()` pattern.
- The existing `msproject._do_import_purge()` is **retrofitted** to read its retention
  window from a setting instead of a hardcoded 7 days.
- Retention windows are configurable via Django settings, **default 7 days**, and
  `None` disables the purge (matching the existing `HISTORY_RETENTION_DAYS` /
  `TASK_RUN_RETENTION_DAYS` semantics).
- Settings are **`TRUEPPM_`-prefixed**: `TRUEPPM_WEBHOOK_RETENTION_DAYS`,
  `TRUEPPM_IMPORT_RETENTION_DAYS`. See decision D below.
- The webhook purge runs at **03:30 UTC**, a distinct offset from the import purge
  (02:45) to spread nightly load.

### B. Beat liveness detection (#662)

- New `apps.observability` app owns a singleton `BeatHeartbeat` model
  (`last_heartbeat: DateTimeField`, enforced single row via a unique `singleton_key`).
- `beat.heartbeat` task runs **on Beat every 30 s** and upserts `last_heartbeat = now()`.
- `GET /api/v1/health/beat/` is the **primary external detector**: it reads
  `last_heartbeat`, computes `stale = (now - last_heartbeat) > TRUEPPM_BEAT_STALE_SECONDS`
  on read, and returns `{"last_heartbeat": ..., "stale": bool}`. It returns **HTTP 503
  when stale** (or when no heartbeat has ever been recorded) and **200 when fresh**, so
  status-code-driven monitoring (Prometheus blackbox, alerting) needs no body parsing.
- `beat.check_stale_heartbeat` task runs **on Beat every 60 s** and logs a structured
  `WARNING` when the heartbeat is stale — a secondary, in-cluster signal for adopters
  with no external monitoring.

**Why the endpoint is the detector and not a self-rescheduling worker chain (the
mechanism #662 originally proposed):** no in-cluster task can reliably detect "all my
task infrastructure is dead" — if Beat *and* workers are gone, nothing in the cluster
runs to notice. That detection must be **external**, and the endpoint (read from
Postgres) works precisely when everything else is down. A self-rescheduling
`apply_async(countdown=...)` chain dies silently on any worker restart (deploys, OOM,
autoscaling — routine events) and never re-arms, losing the detector exactly the way
this issue is meant to prevent. Once the endpoint owns real detection, a **Beat-scheduled**
`check_stale` is strictly better than the chain: it self-heals on Beat restart and
catches the narrow case the endpoint can't log (Beat alive but the heartbeat task
specifically wedged). The chain's only theoretical edge — surviving Beat death — is the
exact case the endpoint already covers.

### C. Endpoint access control

`GET /api/v1/health/beat/` is gated with DRF `IsAdminUser` (`is_staff`). Rationale:
the heartbeat exposes operational state (`stale: true` tells a prober "this deployment's
async pipeline is stalled right now"), which a hardened/compliance posture wants behind
auth. There is **no project in scope** for a Beat health check, so the project-scoped
`IsProjectAdmin` is the wrong tool; `IsAdminUser` is the idiomatic global-admin gate for
a single-deployment OSS install. The **existing unauthenticated `GET /api/v1/health/`**
remains the k8s `httpGet` liveness probe; `/health/beat/` is the **authenticated admin
diagnostic**, scrapeable by Prometheus with a bearer token (which keys on the 503/200
status code). This deviates from the issue's "k8s liveness wiring" framing in favor of
the security lens — accepted explicitly.

### D. Setting naming

New tunables use the **`TRUEPPM_` prefix** (`TRUEPPM_WEBHOOK_RETENTION_DAYS`,
`TRUEPPM_IMPORT_RETENTION_DAYS`, `TRUEPPM_BEAT_STALE_SECONDS`). The codebase is split —
`TRUEPPM_EDITION` is prefixed while `HISTORY_RETENTION_DAYS` / `TASK_RUN_RETENTION_DAYS`
are bare — so there is no single convention to honor. The prefix is chosen for env-var
namespacing hygiene: in a shared k8s ConfigMap/Secret, `TRUEPPM_`-prefixed vars are
greppable and collision-free. Existing bare retention settings are left as-is (renaming
them would be a breaking change for current deployments).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Stale-detect via self-rescheduling worker chain** (issue #662 original) | Survives Beat death | Dies silently on worker restart and never re-arms — the exact silent failure it should catch; can't detect total infra death anyway |
| **Endpoint-as-detector + Beat-scheduled check_stale** (chosen) | External detector works when Beat/workers are down; in-cluster check self-heals on restart; simple | If nothing scrapes the endpoint and Beat is down, the WARNING log can't fire (acceptable — that's what external monitoring is for) |
| **`/health/beat/` AllowAny** (issue framing) | Usable as a vanilla k8s httpGet probe | Leaks operational state to unauthenticated probers; existing `/health/` already covers basic liveness |
| **`/health/beat/` IsAdminUser** (chosen) | Operational state behind auth; idiomatic global-admin gate | Not usable as a plain k8s httpGet probe — needs token-auth scrape (Prometheus) |
| **Bare setting names** (match `HISTORY_RETENTION_DAYS`) | Consistent with sibling retention knobs | Loses env-var namespacing; codebase is already split so consistency is weak |
| **Drop `WebhookDelivery` rows on a row-count cap instead of age** | Bounds table size directly | Age-based matches every other purge; predictable; simpler operator mental model |

## Consequences

- **Easier:** webhook delivery and import tables stay bounded with operator-tunable
  retention; operators get a real liveness signal for the Beat SPOF (endpoint + log);
  retention behavior is uniform across outbox tables.
- **Harder:** one more app (`observability`) and two more Beat entries to reason about;
  `/health/beat/` is not a drop-in k8s httpGet probe (needs token auth), which must be
  documented for ops.
- **Risks:** if an operator sets a retention window to `None` (disable), the table grows
  unbounded — documented as an explicit opt-out. If no external monitor scrapes
  `/health/beat/` *and* Beat is down, detection falls back to "downstream consumer
  notices missing work" — the pre-existing baseline, not a regression.

## Implementation Notes

- P3M layer: Infrastructure (cross-layer; serves Programs and Projects in OSS)
- Affected packages: `api` (new `observability` app, webhook purge task, retention
  settings, retrofit import purge, health endpoint); `docs`
  (`administration/retention.md`, `administration/durability.md`, `api/`)
- Migration required: **yes** — new `observability_beatheartbeat` table (single row).
- API changes: **yes** — `GET /api/v1/health/beat/` (IsAdminUser; 200 fresh / 503 stale;
  body `{last_heartbeat, stale}`).
- OSS or Enterprise: **OSS**. Enterprise HA (redundant Beat + leader election) is
  enterprise#20 and layers on this detection.

### Durable Execution

Two distinct workloads; answered separately.

**Webhook / import retention purge (#661):**
1. Broker-down behaviour: **N/A** — a purge is a `DELETE`; it dispatches no async work.
2. Drain task: **N/A** — the purge *is* a Beat task, not a dispatcher; it does not enqueue.
3. Orphan window: **N/A** — only terminal rows (`SUCCESS`/`FAILED` for webhooks;
   `DONE`/`DEAD` for imports) are deleted; in-flight `PENDING` rows are excluded by the
   status filter, so there is no race with `transaction.on_commit()`.
4. Service layer: **N/A** — periodic maintenance; logic in `_do_webhook_purge()` /
   `_do_import_purge()` for testability, no view/signal dispatch path.
5. API response on best-effort dispatch: **N/A** — no API surface.
6. Outbox cleanup: this **is** the cleanup. Retention `TRUEPPM_WEBHOOK_RETENTION_DAYS` /
   `TRUEPPM_IMPORT_RETENTION_DAYS`, default 7 days, `None` disables.
7. Idempotency: `DELETE` is naturally idempotent; `@idempotent_task(on_contention="skip")`
   prevents overlapping runs; a second run deletes the same-or-fewer rows.
8. Permanent failure: `acks_late`; the next nightly run retries. No dead-letter needed —
   a failed purge leaves rows in place to be re-purged, never loses data.

**Beat heartbeat (#662):**
1. Broker-down behaviour: `beat.heartbeat` is a Beat task doing one DB `UPDATE`. If the
   broker is down the task never runs — which *is* the outage the staleness detector
   surfaces. No outbox needed; the heartbeat row is the signal.
2. Drain task: **N/A** — no dispatch.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — internal; logic in `_do_heartbeat()` / `_do_check_stale()`.
5. API response on best-effort dispatch: `GET /health/beat/` returns
   `200 {last_heartbeat, stale:false}` when fresh, `503 {last_heartbeat, stale:true}`
   when stale (or `last_heartbeat:null` before the first beat).
6. Outbox cleanup: **N/A** — single-row model, no growth, no purge.
7. Idempotency: the heartbeat upsert (`update_or_create(singleton_key=1, ...)`) is
   idempotent; `check_stale` is read-only + log. Both `on_contention="skip"`.
8. Permanent failure: a failing heartbeat *is* the detected condition (endpoint reports
   stale; `check_stale` logs WARNING). No DLQ — silence here is the signal, surfaced by
   the detector rather than discarded.
