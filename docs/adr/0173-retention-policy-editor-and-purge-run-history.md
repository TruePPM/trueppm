# ADR-0173: Runtime Retention Policy + Purge-Run History

## Status
Proposed

## Context

Epic #691 ships a workspace-admin "System Health" operator UI. Its two read-only
surfaces — #692 overview and #694 dead-letter inspector — landed under ADR-0172. That
ADR **deliberately deferred** the third surface, #693 (retention & purge policy editor +
purge log), noting it "requires a net-new DB-backed override model and a purge-run history
model, plus an ADR-0081 amendment." This ADR is that work.

### Backend reality #693 must reconcile

ADR-0081 made the operational retention windows **settings-driven**: five `settings.*`
integers, each read at startup, `None` disables the purge (except
`TRUEPPM_SYNC_BATCH_RETENTION_HOURS`, which is non-nullable):

| Setting | Default | App owning the purge | Internal fn |
|---|---|---|---|
| `HISTORY_RETENTION_DAYS` | 90 | `history` | `_do_purge_history` |
| `TASK_RUN_RETENTION_DAYS` | 30 | `taskruns` | `_do_purge` |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | 7 | `webhooks` | `_do_webhook_purge` |
| `TRUEPPM_IMPORT_RETENTION_DAYS` | 7 | `msproject` | `_do_import_purge` |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | 24 | `sync` | `_do_purge` |

Each table has its **own** nightly Beat entry, staggered 02:00–03:45 UTC to spread load.
There is **no DB model, no write endpoint, no purge-run telemetry** — which is exactly why
`observability/selectors.py::_retention()` hard-codes the Retention-purge card to
`STATUS_UNKNOWN` ("purge-run history not recorded"). Resolving that card is #693's job.

(The `scheduling`, `workflow_engine`, and `idempotency` purges are **out of editor scope** —
they are not operator-tunable retention tables and keep their existing independent Beat
entries untouched.)

**P3M layer:** Operations (single-deployment operator hygiene). Not cross-program
governance — OSS per the adoption-lens boundary. The compliance overlay (locked floors,
`compliance` badge, policy-change **audit trail**, audit-log retention row, unlimited
retention, GDPR/legal-hold) is Enterprise (trueppm-enterprise#137) and is **not** built here.

## Decision

### A. `RetentionPolicy` — a DB override layer over settings (no breaking change)

One row per operational table key. The row is an **override**; absence falls back to the
ADR-0081 setting, so existing `None`-disable and default semantics are preserved for any
deployment that never touches the editor.

```python
class RetentionPolicy(models.Model):           # apps.observability
    key      = CharField(unique=True, choices=RETENTION_KEYS)  # e.g. "HISTORY_RETENTION_DAYS"
    enabled  = BooleanField(default=True)        # False = disabled (unbounded), mirrors settings None
    value    = PositiveIntegerField()            # days (or hours for the sync key); unit derived from key
    updated_at = DateTimeField(auto_now=True)    # last-writer timestamp only — NOT a change trail (that is enterprise#137)
```

UUID PK per convention. **No `server_version`** — this is operator config, not part of the
WatermelonDB offline-sync protocol.

Resolution is a single pure helper, `apps/observability/retention.py`:

```python
def resolve_retention(key) -> int | None:   # None == disabled / unbounded
    try:
        p = RetentionPolicy.objects.get(key=key)
        return p.value if p.enabled else None
    except RetentionPolicy.DoesNotExist:
        return getattr(settings, key, None)
```

The five `_do_*_purge()` functions change one line each: read `resolve_retention(KEY)`
instead of `getattr(settings, KEY)`. `retention.py` imports **nothing** from the owning
apps, so no import cycle is introduced (the apps import the resolver, never the reverse).
`SYNC_BATCH` is editable-but-not-disablable in the editor (`enabled` is forced `True`),
matching its non-nullable backend.

### B. `PurgeRun` — unified purge-run history

```python
class PurgeRun(models.Model):                  # apps.observability
    started_at  = DateTimeField(default=now, db_index=True)
    finished_at = DateTimeField(null=True)
    trigger     = CharField(choices=["scheduled","manual","dry_run"])
    state       = CharField(choices=["running","ok","partial","failed"])
    tables      = JSONField(default=list)       # [{key,label,rows_deleted,bytes_freed,state,error}]
    rows_deleted = PositiveIntegerField(default=0)   # totals across tables
    bytes_freed  = PositiveBigIntegerField(null=True)  # best-effort estimate (see Consequences)
    error        = TextField(blank=True)
```

`_retention()` becomes: query the latest **non-dry-run** `PurgeRun`. None → keep `unknown`.
Latest `ok` → `STATUS_OK` ("last purge 6h ago · 1,234 rows"). Latest `partial`/`failed`, or
a scheduled run overdue past its window → `STATUS_WARN`/`STATUS_CRIT`. The card flips off
`unknown` the first time a run is recorded.

### C. One coordinator task replaces the five staggered nightly entries

The issue's "Run purge now" and a "last-7 purges log" with a *tables-completed* column
describe a **unified run** spanning all editor tables. The current five-independent-tasks
shape cannot produce that. So:

- New `run_retention_purge(run_id=None, *, dry_run=False, trigger="scheduled")` in
  `apps/observability/tasks.py`, `@idempotent_task(on_contention="skip")`. It creates (or
  adopts) a `PurgeRun`, iterates the five tables calling each refactored
  `_do_*_purge(dry_run=…) -> (rows, bytes|None)`, records per-table results, and sets the
  final `state`/`finished_at`.
- The **five per-table nightly Beat entries are removed** and replaced by a single
  coordinator entry. Sequential execution still spreads load over wall-clock time and
  removes any chance of overlap; the unified `PurgeRun` is the observability win. This is a
  deliberate, documented behavior change to ADR-0081 §A's per-table scheduling.
- `on_failure` (decision D, schedule) decides whether a table error **aborts** the run
  (`partial`, remaining tables skipped) or the run **continues** to the next table
  (`partial`, failed table flagged). A clean run is `ok`; a dispatch/setup failure is
  `failed`.

### D. Schedule config — DB self-gating, **no new dependency** (and scope cut)

Today the schedule is static Python in `CELERY_BEAT_SCHEDULE`. Making time-of-day /
frequency operator-editable is the heaviest part of the issue. Three options were weighed
(table below). **Chosen: option (ii), DB self-gating** — a `RetentionSchedule` singleton
the coordinator consults, with Beat firing the coordinator on a fixed sub-daily cadence
that self-gates on the configured window. This stays in the `@idempotent_task` house style
and adds **zero** dependencies (django-celery-beat's `DatabaseScheduler` would be a new
runtime dep + an ops migration + a second source of truth for *all* Beat tasks — far too
much blast radius for one operator knob).

```python
class RetentionSchedule(models.Model):         # apps.observability — enforced singleton
    frequency       = CharField(choices=["daily","weekly","off"], default="daily")
    time_of_day_utc = TimeField(default=time(2, 0))     # UTC, no DST shift — documented
    day_of_week     = PositiveSmallIntegerField(null=True)  # 0–6, only when weekly
    on_failure      = CharField(choices=["stop","continue"], default="continue")
```

Beat runs `run_retention_purge` **every 30 min**; the coordinator self-gates: skip if
`frequency == off`; skip if `now` is before today's `time_of_day_utc` window or (weekly)
the wrong day; skip if a `scheduled` run already started within the current window
(cron-catch-up dedupe, read from `PurgeRun`). This honors the issue's
Daily/Weekly/Off + time-of-day + on-failure without dynamic Beat.

**Scope cut:** the issue's **"concurrency"** knob is dropped — `@idempotent_task(
on_contention="skip")` already guarantees single-flight, so a concurrency setting would be
inert. Documented, not silently omitted. If the user prefers an even smaller MR, the
fallback is an **Off-toggle only** (read-only time-of-day) with full schedule editing
deferred to a follow-up issue — flagged to the user before implementation.

### E. Permission gate: `IsAdminUser` (Django `is_staff`)

Keep `IsAdminUser`, consistent with every other `/health/*` endpoint (ADR-0081 §C,
ADR-0172 §5). The issue says "workspace-admin gate" loosely, but this surface **deletes
data on a single deployment** — deployment-operator (`is_staff`) is the correct, *higher*
bar than a workspace `ADMIN` role, and the overview page that links here is already
`is_staff`. Gating this one write surface on `WorkspaceRole.ADMIN` would split the operator
UI across two trust models. Deviation from the issue wording is explicit and justified.

### F. New ADR (this one), amending two

A net-new model + write surface + coordinator + schedule is too much to fold into accepted
ADR-0081. This ADR **amends ADR-0081 §A** (per-table → coordinator scheduling; settings →
DB override) and **resolves ADR-0172 §3** (the `unknown` Retention-purge card). This ADR
was originally authored as 0090; it was renumbered to **0173** to resolve a number
collision with ADR-0090 (Recurring Tasks) — see #918.

### G. API contract (frontend consumes — all `IsAdminUser`)

- `GET /api/v1/health/retention/` → `{ policies:[{key,label,note,unit,value,enabled,row_count,bytes}], schedule:{frequency,time_of_day_utc,day_of_week,on_failure}, runs:[…last 7 non-dry-run…] }`. `row_count`/`bytes` use `pg_class.reltuples` / `pg_total_relation_size` **estimates** (fast, no full scan on large tables; flagged approximate).
- `PATCH /api/v1/health/retention/` → update policy values/`enabled` + schedule; returns the new state. The save-bar payload.
- `GET /api/v1/health/retention/impact/?key=&days=` → `{ eligible_rows, eligible_bytes }` — synchronous count of rows that *would* become purge-eligible at the proposed window. Backs the dirty-state "lowering this is irreversible; N rows become eligible" banner (issue item 2). Read-only, no dispatch.
- `POST /api/v1/health/retention/runs/` body `{dry_run: bool}` → creates a `PurgeRun`, dispatches the coordinator on commit, returns `202 {"queued": true, "run_id": "…"}`. `dry_run:true` counts without deleting.

Frontend route: `/settings/health/retention`, a sibling of `/settings/health` in the
existing "System" nav group.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. DB override model + resolver** (chosen) | Backward-compatible; settings stay the default; surgical one-line change per purge | One new model + a resolver indirection |
| Mutate `settings` / write a `.env` from the UI | "No model" | Settings are process-startup; can't change at runtime; writing env from a web process is unsafe and non-atomic |
| **C. Coordinator task** (chosen) | Unified run + log; one schedule self-gate; no task overlap | Removes 5 Beat entries (documented behavior change); sequential run is slightly longer wall-clock |
| Keep 5 per-table tasks, group rows in the log | Smaller diff | 5 self-gates for the schedule; "run all now" still needs a coordinator; messy grouping |
| **D-i. django-celery-beat DatabaseScheduler** | Real dynamic Beat | New runtime dependency; migrates *all* Beat scheduling to DB; huge blast radius for one knob |
| **D-ii. DB self-gating coordinator** (chosen) | Dependency-free; idempotent house style; bounded | Beat fires every 30 min and mostly no-ops; needs cron-catch-up dedupe |
| **D-iii. Defer schedule editing entirely** | Smallest MR | Drops a listed issue item; offered to the user as the lighter fallback |
| **E. WorkspaceRole.ADMIN gate** | Matches issue wording | Splits operator UI across two trust models; weaker bar for a destructive surface |

## Consequences

- **Easier:** operators tune retention and trigger/inspect purges from the UI; the
  Retention-purge health card finally reports real state; one unified run/log instead of
  five opaque nightly tasks.
- **Harder:** five Beat entries collapse into one coordinator (tests/docs referencing the
  old entry names must update — regression-check gate); a `reltuples`/`pg_total_relation_size`
  read path is added (perf-check gate); `bytes_freed` is a **best-effort estimate**
  (avg row width × rows, or relation-size delta), documented as approximate — exact byte
  accounting is not promised.
- **Risks:** (1) self-gating cron-catch-up must dedupe correctly or a window is double-run
  or missed — covered by the "scheduled run already started this window" check + the
  idempotent single-flight lock. (2) A lowered retention value purges more on the next run,
  irreversibly — surfaced by the impact endpoint + dirty-state banner before save. (3) The
  coordinator consolidation changes nightly load timing — acceptable and documented.

## Implementation Notes

- **P3M layer:** Operations.
- **Affected packages:** `api` (`apps.observability`: 3 models + migration, `retention.py`
  resolver, `tasks.py` coordinator, viewset/views + urls, serializers; five apps'
  `_do_*_purge` gain a `dry_run` param + structured return and read the resolver;
  `settings/base.py` Beat schedule edit), `web` (new Retention & purge page + hooks +
  regenerated `types.ts`), `docs` (`docs/administration/retention.md` update).
- **Migration required:** **yes** — `RetentionPolicy`, `RetentionSchedule`, `PurgeRun`
  (use `makemigrations`; never hand-write).
- **API changes:** **yes** — four new `/health/retention/*` endpoints (see §G).
- **OSS or Enterprise:** **OSS** (trueppm-suite). `grep -r "trueppm_enterprise" packages/`
  stays zero; no extension point required.

### Durable Execution
1. **Broker-down behaviour:** A purge is a `DELETE`; it dispatches **no** downstream work,
   so the transactional outbox is N/A (same reasoning as ADR-0081 §A). The manual run
   endpoint creates the `PurgeRun` row first, then dispatches in `transaction.on_commit`;
   if `.delay()` raises (broker down), the run is marked `failed` synchronously and the
   202 still returns the `run_id` so the UI shows the failure. Scheduled runs simply don't
   fire until Beat/broker recover — the next window catches up.
2. **Drain task:** N/A — the coordinator is itself a Beat-scheduled maintenance task, not a
   dispatcher; it enqueues nothing.
3. **Orphan window:** N/A for dispatch (no outbox rows). `on_commit` guarantees the
   `PurgeRun` row is visible before the worker adopts it by `run_id`, avoiding a read race.
4. **Service layer:** the run endpoint goes through
   `apps/observability/services.py::start_purge_run(dry_run, trigger)` (creates the row +
   schedules dispatch on commit); no direct `.delay()` from the view.
5. **API response on best-effort dispatch:** `202 {"queued": true, "run_id": "…"}` — house
   style, not a synchronous task id.
6. **Outbox cleanup:** N/A (no outbox rows). `PurgeRun` rows are themselves bounded — the
   coordinator trims to the most recent N (e.g. 50) at the end of each run, so the history
   table is self-purging and needs no separate retention knob.
7. **Idempotency:** `@idempotent_task(on_contention="skip")` gives single-flight. A
   duplicate manual dispatch with the same `run_id` adopts the existing `running` row
   rather than creating a second; scheduled re-entry is deduped by the "already ran this
   window" check. `DELETE`-by-age is naturally idempotent (a second run deletes the
   same-or-fewer rows).
8. **Dead-letter / failure handling:** a permanently failing coordinator marks its
   `PurgeRun` `failed`/`partial` (visible in the log and the health card) and leaves rows
   in place to be re-purged next run — no data loss, no DLQ needed (a purge that doesn't
   run is self-correcting). `on_failure=stop` aborts remaining tables on first error;
   `continue` flags the failed table and proceeds.
</content>
</invoke>
