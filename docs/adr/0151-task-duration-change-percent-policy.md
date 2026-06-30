# ADR-0151: Percent-Complete Behavior on Task Duration Change — Keep-Default Policy + Duration-Change Audit Events

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class TaskDurationChangeEvent)

## Context

When a scheduled task that has a recorded `percent_complete` has its `duration`
changed (extended or shortened), TruePPM has historically had **no defined
behavior** for the `%` value. Today the value is silently retained — a task at
30% on 5 days still reads 30% after extending to 10 days. That happens to be the
behavior we want as the *default*, but it has never been a *decision*: it is an
accident of the fact that nothing in the task-update path couples the two fields
(`TaskSerializer.update()` does not touch `percent_complete` when `duration`
changes). The same accident means the change is **invisible** — there is no
audit trail, no signal to earned-value/burndown consumers, and no org-level
lever to enforce a consistent earned-value convention across a program.

A first-pass proposal — a two-step "Are you sure?" + "what's the new %?" modal
with a prorated default — was put through the Voice-of-Customer panel
(`.claude/personas.md`) and **rejected** as the shipping default (avg 4.2/10,
two 🔴 blockers from Sarah and Priya on mobile friction; "prorate" presented as
fact is a lie about progress). The revised, panel-approved proposal (issue #414)
is the spec this ADR implements.

**P3M layer:** Programs and Projects (single project, task, schedule) → **OSS**.
The org-level *policy lever* is a workspace/program/project setting that a PM or
program manager sets for their own program — it is **not** cross-program
governance, so it stays OSS. (A hard, non-overridable enterprise *enforcement*
of one policy across many programs would be an Enterprise extension registered
against the same override-policy seam ADR-0135 already established — out of scope
here.)

### Forces
- **Correctness:** dashboards, earned value, and burndown must not silently
  operate on a `%` that no longer reflects reality, **and** must not have a
  prorated guess presented as a real measurement.
- **No modal-spam / mobile-first:** the panel killed per-edit modals; the guard
  must never block an edit and must be invisible on mobile.
- **Auditability (Janet/Marcus, SOC 2):** every duration change must be a
  first-class, queryable event with old/new values and an actor.
- **Bulk cascade:** a predecessor slip propagating to N successors via CPM must
  produce **zero** prompts. (It also produces zero duration-change *events*,
  because a slip moves dates, not durations — see §5.)
- **No new external contract surface this release:** the OSS webhook event set is
  at its cap (`OSS_WEBHOOK_EVENT_CAP = 14`, ADR-0147 amending ADR-0083).

## Decision

Implement #414 as an **API-first backend slice**. The policy and the events are
fully usable via the REST/WS API in this MR; the desktop inline "Recalc %?"
affordance, the mobile rules, the admin policy-setting UI, and the burndown
changes-log *visual* surfacing are a filed frontend follow-up (see
**Decomposition** below). Because the default policy is `keep` — which is exactly
today's behavior — shipping the backend without the UI changes **nothing** for
existing users until a PM opts into `prorate`/`confirm`. There is no orphaned
half-feature.

### 1. Default = `keep` (lock the existing behavior)
`TaskSerializer.update()` continues to leave `percent_complete` untouched on a
duration change under the default policy. This becomes an explicit, test-locked
decision rather than an accident.

### 2. Duration-change audit event — a dedicated lightweight model
Add `TaskDurationChangeEvent` (plain `models.Model`, append-only, mirroring the
`ApiTokenAuditEntry` audit pattern — UUID PK, **no** `server_version`, not a
`VersionedModel`):

| field | type | note |
|---|---|---|
| `id` | UUIDField PK | |
| `task` | FK Task (CASCADE) | |
| `actor` | FK User (SET_NULL, null) | null for CPM-cascade events |
| `old_duration` | IntegerField | working days |
| `new_duration` | IntegerField | working days |
| `percent_complete_at_change` | FloatField | the `%` immediately before the change |
| `percent_complete_after` | FloatField null | set only when policy mutated `%` (prorate) |
| `policy_applied` | CharField | `keep` \| `prorate` \| `confirm` |
| `source` | CharField | `user_edit` \| `cpm_cascade` |
| `sprint` | FK Sprint (SET_NULL, null) | set when the task was in an **active** sprint at change time |
| `created_at` | DateTimeField auto_now_add | |

**Why a dedicated model rather than reusing `HistoricalRecords` (ADR-0011):**
(a) we need policy / `percent_after` / `source` metadata and a clean broadcast
hook that the generic history table cannot carry; (b) a typed event table is the
natural feed for the future unified task-activity timeline (ADR-0096, Proposed) —
`task_duration_changed` becomes one of its event sources; (c) it is future-proof
for bulk write paths: if a future engine change ever writes durations via
`bulk_update()` (which **bypasses** `save()`/`simple_history` entirely), a typed
table captures the change where history structurally cannot — the `source` field
already reserves the `cpm_cascade` value for that case (see §5).

### 3. Inheritable org policy — `task_duration_change_percent_policy`
Follow the ADR-0135 inheritable-settings pattern exactly:
- **Workspace** (root, non-nullable): `CharField(choices=keep|prorate|confirm,
  default="keep")`.
- **Program** and **Project** (nullable overrides): same choices, `null=True`.
- New resolver module `task_duration_settings.py` mirroring `sharing_settings.py`
  (`resolve_effective_duration_policy(obj)` → Project override → Program override
  → Workspace value), exposed as `effective_task_duration_change_percent_policy`
  SerializerMethodFields on the Project/Program/Workspace serializers.
- Writes to the override fields are **admin-only** (role ≥ ADMIN, the same gate
  the other inheritable settings use) and are **audited** automatically via the
  existing `HistoricalRecords` on Workspace/Program/Project (the field is not in
  `_HISTORY_EXCLUDED_BASE`), satisfying "admin-only + audited on change" without
  a new audit table.

### 4. Policy semantics in the user-edit path
In `TaskSerializer.update()`, when `duration` changes on a task with
`percent_complete > 0`, resolve the effective policy and:
- **`keep`** (default): do not modify `%`. Record the event
  (`policy_applied=keep`, `percent_complete_after=null`).
- **`prorate`**: set `% = round(old_pct * old_dur / new_dur, 1)` (clamped to
  [0,100]); record the event with `percent_complete_after`.
- **`confirm`**: **server keeps `%` unchanged** and records the event
  (`policy_applied=confirm`). "Confirm" is a *client* affordance — the server
  never auto-mutates; the desktop UI renders an inline confirm and, on
  acceptance, issues a normal subsequent `PATCH percent_complete=<n>`. On mobile,
  `confirm` is silently treated as `keep` (no UI, no mutation). This keeps the
  server contract uniform and the friction client-side.

Emit a single WS-only `task_duration_changed` broadcast (deferred via
`transaction.on_commit()`) carrying `{task_id, old_duration, new_duration,
percent_complete_at_change, percent_complete_after, policy_applied}` so the
desktop client can render the affordance/confirm without a refetch.

### 5. The CPM-cascade path — no duration-change events in the current engine
AC9 ("a predecessor slip propagating to N successors produces N events, zero
prompts") rests on the premise that a CPM cascade *changes durations*. It does
not. A predecessor slip moves successors' **start/finish dates** (early/late
bounds, float) — their planned `duration` is an **input** to CPM, not an output,
and is never recomputed from a slip. The only place `recalculate_schedule`
mutates the `duration` column at all is the **summary-task display-span**
(`scheduling/tasks.py` line ~613: a summary's duration is overwritten with the
calendar-day span of its children purely so the Gantt column shows a value). A
summary's stored `percent_complete` is always `0` — its `%` is a rollup computed
on read, never persisted — so it is excluded by the `% > 0` guard anyway, and a
summary's display-span is not a *planned duration* whose change is meaningful to
earned value.

Therefore **the cascade path records no `TaskDurationChangeEvent` rows in the
current engine**, and this MR adds **no code to the perf-critical recalc path**.
AC9's operative requirement — *zero prompts on cascade* — is satisfied
**structurally**: the cascade path never invokes `TaskSerializer.update()` or any
prompt logic, so it is impossible for it to prompt. The existing
`task_dates_updated` broadcast already carries the moved dates (and the unchanged
`duration`) to the live UI.

The `source` field on `TaskDurationChangeEvent` retains its `cpm_cascade` choice
so that **if a future engine change persists a leaf task's *remaining* duration
back to `Task.duration`** (e.g. an ADR-0132 data-date writeback, or a bulk
duration tool), the cascade recorder can be added against that specific change —
as a guarded pass that excludes summary/milestone tasks — with tests that
actually exercise it. Adding an unreachable recorder now would be hot-path
overhead and a test that asserts nothing. This is listed as a conditional
follow-up in **Decomposition**.

### 6. WS-only event, no webhook
`task_duration_changed` is added to `FROZEN_WS_EVENT_TYPES` and the
`websockets.md` taxonomy as **WS-only** — like `sprint_scope_changed`. It is
deliberately **not** a webhook: the OSS webhook set is at its cap (14), external
consumers already see duration via the existing `task.updated` webhook, and a new
external contract is not warranted for a live-UI signal. No cap bump, no ADR-0083
amendment.

### 7. Read access
Expose duration-change history via a small read-only DRF `@action`
(`GET /api/v1/tasks/{id}/duration-events/`, member+), paginated, newest-first.
This is the API surface the future history endpoint (#413/ADR-0096) and the
deferred frontend will both consume.

### Decomposition (what this MR does NOT do — filed follow-up)
Deferred to a frontend follow-up issue, because the surfaces it touches
(`TaskListRow.tsx`, the settings shell) are held by other agents' active
worktrees (#740/#748, #976) and because UX gates belong with the UI:
- Desktop inline "Recalc %?" affordance + ~10s lifecycle + `confirm` inline UI.
- Mobile suppression of the affordance/confirm.
- Admin policy-setting `<select>` in workspace/project settings.
- Burndown / Sprint changes-log *visual* markers (the event already carries
  `sprint_id`; this MR records the data, the follow-up renders it).
- AC10 allocation-impact hint — deferred independently (depends on #408 resource
  scope; the field is not yet wired).

Deferred **conditionally** (only when an engine change makes it reachable):
- A cascade duration-change recorder in `recalculate_schedule` — built *with* the
  future change that first persists a leaf's recomputed duration via
  `bulk_update()` (§5). Not built now because it would record zero events against
  the current engine.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Keep-default + dedicated event model + inheritable policy (chosen)** | Correct default with zero behavior change; full audit incl. cascade; org lever; no webhook-cap churn; clean feed for ADR-0096 | New model + 2 migrations; cascade emission must live in the recalc path |
| B. Reuse `HistoricalRecords` for the audit event | No new model | No policy / percent_after / source metadata, no clean broadcast hook, not a typed feed for ADR-0096; and structurally blind to any future `bulk_update()` write path (history bypass) |
| C. Prorate by default | "Looks" self-consistent | Panel-rejected — lies about progress; the duration often changed *because* progress advanced |
| D. Two-step modal (original proposal) | Explicit | Panel-rejected (4.2/10) — modal-spam, fatal mobile friction |
| E. New webhook event for `task.duration_changed` | External integrations get the signal | Exceeds `OSS_WEBHOOK_EVENT_CAP=14` → ADR-0083/0147 amendment + new external contract for a live-UI signal; `task.updated` already conveys duration |

## Consequences

### Easier
- Earned-value, burndown, and portfolio consumers get a typed, queryable
  duration-change feed with old/new values and actor.
- PMs/programs can enforce one earned-value convention (`keep`/`prorate`/
  `confirm`) without per-PM judgment, inherited W→P→P like every other setting.
- The event table is a ready-made source for the unified activity timeline
  (ADR-0096).

### Harder
- One more inheritable setting to reason about (mitigated: identical mechanics to
  ADR-0135/0116, shared resolver shape).
- Cascade event emission adds a bounded pass over changed tasks inside the
  recalc; must stay O(changed tasks) and not re-query per task (see perf note).

### Risks
- **Migration-number collision** with in-flight #976 (attachment policy, also
  adding workspace + projects migrations). Mitigation: sequential numbering now
  (projects `0087`, workspace `0011`); second-to-merge renumbers; CI
  `api:migration-numbering` guards duplicates.
- **WS-event frozen-set drift**: adding `task_duration_changed` requires the same
  change to `FROZEN_WS_EVENT_TYPES` (`test_broadcast.py`) and `websockets.md` in
  this MR or `test_ws_event_type_set_is_frozen` fails.

## Implementation Notes
- P3M layer: Programs and Projects (OSS).
- Affected packages: **api** (models, serializers, sync broadcast taxonomy),
  **website** (docs/api/websockets.md taxonomy). No scheduling/recalc change (§5).
  No scheduler-engine change. No web this MR (deferred).
- Migration required: **yes** — projects `0087` (TaskDurationChangeEvent +
  nullable policy overrides on Program/Project + historical mirrors), workspace
  `0011` (non-null policy default on Workspace).
- API changes: **yes** — `effective_task_duration_change_percent_policy` +
  writable override fields on Project/Program/Workspace serializers; new
  `GET /tasks/{id}/duration-events/` action; new WS-only `task_duration_changed`
  event.
- OSS or Enterprise: **OSS** (`trueppm-suite`). The non-overridable
  enforcement variant is a future Enterprise extension against the ADR-0135
  override-policy seam — not built here.

### Durable Execution
1. **Broker-down behaviour:** N/A for new async work — this feature adds **no**
   Celery task. The audit event row is written in the *same DB transaction* as the
   user task update, so it is durable with the change that triggered it. The only
   fire-and-forget is the `task_duration_changed`
   WS broadcast, which reuses the existing best-effort `broadcast_board_event()`
   + `transaction.on_commit()` path (identical durability profile to
   `task_updated`): if the channel layer is down the live hint is lost but the
   event row persists and the next page load reads it via the read action.
2. **Drain task:** N/A — no new async category; no outbox row is introduced. The
   event write is synchronous; the broadcast reuses the existing channels path,
   which (like all current task broadcasts) is intentionally best-effort, not
   outboxed.
3. **Orphan window:** N/A — no drain, no outbox.
4. **Service layer:** CPM recalculation continues to go through
   `scheduling/services.py::enqueue_recalculate()`, unchanged — this MR adds no
   code to the recalc path (§5). The user-edit event is recorded synchronously in
   `TaskSerializer.update()` within the request transaction; no new dispatch path.
5. **API response on best-effort dispatch:** N/A — the `PATCH` is synchronous and
   returns the updated task; the event is recorded inline, not queued. No
   `{"queued": true}`.
6. **Outbox cleanup:** N/A — no outbox. `TaskDurationChangeEvent` rows are an
   append-only audit trail (like `ApiTokenAuditEntry`) and are retained
   indefinitely in 0.3; a future purge policy, if needed, is a separate decision.
7. **Idempotency:** User edit records exactly one event per `PATCH` that actually
   changes `duration` (guarded by an `old != new` check; a no-op duration write,
   or a write that sets `duration` to its current value, records nothing). There
   is no cascade event path to make idempotent (§5).
8. **Dead-letter / failure handling:** N/A — no standalone task. Event recording
   is part of the atomic transaction of its trigger; on failure the whole
   transaction (task update or recalc writeback) rolls back together, so an
   event can never be orphaned from its change nor a change from its event.
