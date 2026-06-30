# ADR-0082: Mobile Sync Upload — Transactional Batch Atomicity

## Status: Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class SyncBatch)

## Context

TruePPM's mobile offline store (WatermelonDB, ADR-0026) syncs in two directions:
a **pull** (server → client delta, keyed on `server_version`) and a **push**
(client → server upload of offline edits). Today only the pull half exists
(`ProjectSyncView` GET at `/api/v1/projects/{pk}/sync/`). There is **no server
upload endpoint** — the push half was deferred ("when it lands," per #322).

Issue #667 specifies the upload half's durability contract: when a client uploads
a delta batch and the connection drops mid-commit, the retry must not double-apply
or dead-end. The required guarantees are **all-or-nothing per batch** and
**idempotent retry** keyed on a client-generated batch id.

This is **not** the inbound integration push (`task-sync/`, ADR-0068) — that is an
external-tool → TruePPM path authenticated by a project API token, one external
task per request, idempotent by `(project, source, external_id)`. The mobile
upload is a member-authenticated, multi-row, offline-edit replay path.

**P3M layer:** Programs and Projects (OSS) — single-project task edits replayed
from a PM/team member's offline device. No cross-program aggregation.

**Scope (user-approved).** This ADR covers the **server-side** upload endpoint +
the `SyncBatch` idempotency/atomicity envelope only. Conflict resolution is **plain
last-writer-wins (LWW)**; field-level merge and 409 conflict bodies are owned by
**#322** and explicitly not implemented here. The mobile SDK (`client_batch_id`
generation/reuse) and Detox E2E are deferred to follow-up issues — there is no
React Native package in the repo yet.

## Decision

### A. Endpoint

`POST /api/v1/projects/{pk}/sync/` — same path as the pull GET, new verb. Members
already know this URL from the pull; co-locating push keeps the protocol one route.
This is implemented: `ProjectSyncView.post()` in
`packages/api/src/trueppm_api/apps/sync/views.py` (route `name="project-sync"` in
`sync/urls.py`) applies the delta and snapshots the response inside one atomic
transaction keyed on `client_batch_id`. The server-side push contract is therefore fully
named here — only the mobile SDK (client batch-id generation/reuse) and Detox E2E remain
deferred follow-ups (see Consequences / tracking footer).

Request body (WatermelonDB push shape + batch envelope):

```jsonc
{
  "client_batch_id": "<uuid>",          // required; client-generated, stable across retries
  "last_pulled_at": 1234,               // optional, advisory only (LWW ignores it; #322 may use it)
  "changes": {
    "tasks": {
      "created": [ { "id": "<client-uuid>", "name": "...", "status": "...", ... } ],
      "updated": [ { "id": "<uuid>", "server_version": 7, "percent_complete": 50, ... } ],
      "deleted": [ "<uuid>", "<uuid>" ]
    }
  }
}
```

Response (also the snapshot stored for idempotent replay):

```jsonc
{
  "client_batch_id": "<uuid>",
  "applied": {
    "tasks": {
      "created": [ { "id": "<uuid>", "server_version": 1 } ],
      "updated": [ { "id": "<uuid>", "server_version": 8 } ],
      "deleted": [ { "id": "<uuid>", "server_version": 9 } ]
    }
  },
  "timestamp": 9   // max server_version after apply; client advances its pull watermark
}
```

### B. Writable table surface

**`tasks` only** in v1. Task is the primary offline-editable entity (status,
percent_complete, notes, assignee, planned dates, create/delete). The apply layer
is a registry `{collection: apply_fn}` so adding collections later is additive, not
a rewrite. Any other collection key in `changes` → **400** (explicit reject, never
silent drop). CPM-output fields (`early_start`, floats, `is_critical`) are
**server-owned** and ignored if present in an uploaded row. `wbs_path` is also
server-managed (the tree is maintained by the reparent logic) and is stripped
from every uploaded row. A batch is capped at `TRUEPPM_SYNC_BATCH_MAX_ROWS`
(default 500, summed across created/updated/deleted) so one request cannot hold
the apply transaction open arbitrarily long; over the cap → 400.

Rationale for excluding the other pulled tables now: `Dependency` needs server-side
cycle detection (ADR-0055); `ProjectMembership` is an RBAC surface; `Calendar`/CPM
fields are server-derived; `Risk`/`Sprint`/retros carry richer invariants. None are
realistically edited on a phone offline in 0.4. Keeping v1 to `tasks` makes the MR
reviewable and the atomicity/idempotency machinery is table-agnostic regardless.

### C. SyncBatch model

Plain `models.Model` (server infrastructure — never pulled by the client; mirrors
`SprintCloseRequest`). App label `sync`; first model in the app, so a new
`migrations/0001_initial.py`.

| Field | Type | Notes |
|---|---|---|
| `id` | UUIDField PK | standard idiom |
| `client_batch_id` | UUIDField | client-generated dedup key |
| `project` | FK → Project, CASCADE | scoping + reaping |
| `status` | CharField(choices) | `pending` → `completed` |
| `response_body` | JSONField(default=dict) | snapshotted success response |
| `response_status` | PositiveSmallIntegerField | HTTP status to replay (200) |
| `created_at` | DateTimeField(auto_now_add) | freshness + reaping |

Constraints / indexes:
- `UniqueConstraint(fields=["project", "client_batch_id"], name="syncbatch_project_client_batch_uniq")`
  — **project-scoped**. A retry always targets the same project endpoint, so a
  per-project unique index is a sufficient concurrency backstop (see D), and
  scoping the dedup key to the project means one project can never replay
  another project's stored response by reusing its `client_batch_id` (IDOR).
- `Index(fields=["created_at"], name="syncbatch_created_idx")` — for the reaper.

### D. Idempotency + concurrency algorithm

Freshness window = **24h** (`created_at > now − 24h`). The endpoint:

1. **Fast path (no lock):** if a `SyncBatch` with this `client_batch_id` exists,
   is fresh, and `status == completed` → return its stored `response_body` /
   `response_status`. No re-apply.
2. **Apply path:** `with transaction.atomic():`
   a. `SyncBatch.objects.create(client_batch_id=…, project=…, status="pending")` as
      the **first** write. The unique constraint serializes concurrent duplicates:
      a second in-flight request with the same id **blocks** on the index until the
      first transaction commits or aborts (Postgres unique-insert semantics).
   b. Apply the delta (per-row, LWW — see E) collecting applied ids + new versions.
   c. Set `response_body`, `response_status=200`, `status="completed"`; save.
   d. Register `on_commit` broadcasts (F) and one coalesced CPM recalc.
3. **Duplicate backstop:** if `create()` raises `IntegrityError` (the blocking sibling
   committed first, or a stale row exists), re-fetch the row:
   - fresh + completed → return stored response (the lost-ACK retry case).
   - **expired** → delete the stale row and re-run the apply once (satisfies "expired
     batch id re-runs"). Belt-and-suspenders with the reaper.
   - fresh + still pending (extremely rare true race) → **409** "batch in progress,
     retry" — the client re-POSTs and gets the stored response on the next attempt.

All-or-nothing: any exception inside the atomic block rolls back the row writes
**and** the `SyncBatch` row together → **5xx**, nothing committed, client re-uploads
the whole batch under the same `client_batch_id`.

### E. Conflict resolution — LWW (scope-limited)

Per-row apply is unconditional last-writer-wins: the uploaded value is applied and
`server_version` bumped, regardless of the row's incoming `server_version`. No 409,
no field-merge — **#322 owns** richer conflict handling and will layer on top of this
envelope. `last_pulled_at` is accepted and ignored. This is a deliberate, documented
limitation: two devices editing the same task field offline → last upload wins.

- **created**: `Task.objects.create(id=<client uuid>, project=project, …)` →
  `server_version=1`, `short_id` auto-allocated, `wbs_path=None` (lands in backlog,
  matching inbound_sync's parentless path). Idempotent: if the id already exists
  (a created row arriving twice across batches), treat as an update.
- **updated**: load the Task, set allowed client-writable fields, `save(update_fields=…)`
  — `save()` bumps `server_version`, stamps `status_changed_at`, coerces
  `percent_complete`. CPM/server-owned fields rejected from the field set.
- **deleted**: `task.soft_delete()` — bumps `server_version`, sets `deleted_version`,
  cascades to dependency edges + subtasks. The tombstone propagates on the next pull.

### F. Broadcast

Per applied row, emit the existing event type (`task_created` / `task_updated` /
`task_deleted`) via `broadcast_board_event()` wrapped in `transaction.on_commit()`,
exactly like `inbound_sync.py`, so existing web board consumers react. Mobile
batches are small (a handful of offline edits), so per-row fanout is acceptable and
keeps the contract identical to single-row writes. One coalesced
`enqueue_recalculate(project_id)` covers CPM for the whole batch.

### G. RBAC

Endpoint gate: `IsAuthenticated` + `role >= Role.MEMBER` (writers; Viewers cannot
push) + an archived-project check mirroring `IsProjectNotArchived` (an archived
project is hard read-only, #530 — the upload must not be a back-channel around
it). **Per-row object permission mirrors `TaskViewSet`** so the upload path is not
a privilege-escalation bypass of the REST PATCH path — whatever a Member may not do
via `PATCH /tasks/{id}/`, they may not do here either. Verified against `TaskViewSet`
object perms during implementation; a divergence is a security bug, not a quality nit.

### H. Throttling

Reuse the Redis-backed throttle pattern (`projects/throttles.py`). New
`SyncUploadThrottle` keyed `rate:sync_upload:{project_id}:{user_id}`, 60 req/min
steady — generous for batched offline replay, bounded against a runaway client.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **SyncBatch table + unique-constraint dedup (chosen)** | All-or-nothing via one atomic block; HTTP-layer idempotency the protocol lacks; concurrency handled by the index | New model + reaper; ~24h of rows retained |
| Generic `Idempotency-Key` header (#6) only | One mechanism for all endpoints | Doesn't express batch shape; dedup must span the multi-collection WatermelonDB delta, not a single request hash; #6 is unbuilt |
| `select_for_update` on a pre-created lock row | Avoids IntegrityError handling | Lock held across the whole apply (long); needs a row to lock before one exists |
| Per-row idempotency (no batch envelope) | Simpler model | Loses all-or-nothing; a half-applied batch is exactly the failure mode #667 exists to prevent |
| Support all 10 pulled tables now | "Complete" | Cycle detection, RBAC, CPM-owned fields per table — unreviewable in one MR; no offline-edit demand for most |

## Consequences

- **Easier:** mobile (when built) gets a safe retry contract — replay the same
  `client_batch_id` until ACK, no double-apply. Web clients stay live via existing
  board events. The apply registry makes adding writable collections incremental.
- **Harder:** introduces the project's first HTTP-layer idempotency store and a new
  Beat purge task. LWW means silent loss on concurrent same-field edits until #322.
- **Risks:** (1) the concurrent-pending 409 window is real but narrow; documented and
  tested. (2) LWW data loss — mitigated by being explicit + #322 follow-up. (3) Reaper
  must run or the table grows — covered by the purge task + the expired-row delete in
  the apply path.

## Implementation Notes

- **P3M layer:** Programs and Projects (OSS).
- **Affected packages:** api (sync app: model, migration, serializers, view, urls,
  throttle, purge task; settings for retention), docs.
- **Migration required:** yes — `sync/migrations/0001_initial.py` (new `SyncBatch`).
- **API changes:** yes — new `POST /api/v1/projects/{pk}/sync/`; OpenAPI via
  `@extend_schema`.
- **OSS or Enterprise:** OSS. `grep -r trueppm_enterprise packages/` stays zero.

### Durable Execution

1. **Broker-down behaviour:** the upload itself is a synchronous, atomic DB write —
   no broker involved in the commit. Its only async side effect (CPM recalc) goes
   through the existing transactional outbox via `enqueue_recalculate()`; broker-down
   leaves an outbox row the existing drain re-dispatches. Broadcasts are best-effort
   on_commit (no outbox row needed, per the broadcast helper's durability note).
2. **Drain task:** none new. Reuses the existing schedule-request outbox drain
   (`enqueue_recalculate`). No new category of async work is introduced by the upload.
3. **Orphan window:** N/A for the upload write (synchronous, committed before
   response). The reused CPM outbox drain keeps its existing 10-min orphan filter.
4. **Service layer:** CPM via `scheduling/services.py::enqueue_recalculate()`. The
   apply logic gets a new module `sync/upload.py::apply_upload_batch()` (mirrors
   `projects/inbound_sync.py`), not a `.delay()` at the view.
5. **API response on best-effort dispatch:** the upload returns **synchronously** with
   the applied versions (200); it is a DB write, not a queued job — no `{"queued":true}`.
   The coalesced CPM recalc it triggers is best-effort outbox as everywhere else.
6. **Outbox cleanup:** `SyncBatch` rows are purged by a new nightly Beat task
   `sync.purge_sync_batches` (`@idempotent_task(on_contention="skip")`) deleting rows
   older than `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` (default 24, matching the dedup
   window). Follows the ADR-0081 purge convention so this does not repeat the
   "missing purge" gap ADR-0081 hardened.
7. **Idempotency:** key = `client_batch_id` (unique constraint). Duplicate within 24h →
   stored response replayed, zero re-apply. Concurrency serialized by the unique-insert
   block + `IntegrityError` backstop (§D). Expired duplicate → stale row deleted, batch
   re-runs.
8. **Dead-letter / failure handling:** an apply failure rolls the whole batch back
   (5xx); there is no partial state and nothing to dead-letter — the client re-uploads
   the same `client_batch_id`. The purge task is idempotent and contention-skips; its
   permanent failure only delays GC (bounded growth, alertable via Beat liveness,
   ADR-0081), never corrupts data.
