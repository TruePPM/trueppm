# ADR-0160: Board-level activity feed (filterable, board-scoped)

## Status
Accepted (2026-06-21)

## Context
The board has no activity feed of its own. The only change history surface is the
per-task drawer (`TaskHistoryView`, `GET /projects/{id}/tasks/{task_id}/history/`),
which diffs one task's `HistoricalTask` rows. The board's audit is "tucked inside the
Schedule History tab" — auditors and the PMO (Marcus 8/10, #325 VoC) want the board's
audit *on the board*: a single time-ordered, filterable feed of every card mutation
across the whole board, with attribution. Alex (6) uses it for mid-sprint scope-change
audit; Sarah (6) for "a card I didn't touch moved overnight".

**P3M layer**: Programs and Projects (single project, board-scoped). **OSS** — a team
needs its own board audit to run its program; it is not cross-program governance.

This is a **backend slice**: the read aggregator + endpoint. The web panel and the live
`board.activity` WebSocket push are deferred to a web follow-up — the live push only has
value with the panel consuming it, and wiring it would mean hooking every task-mutation
path (a far larger change than the read endpoint that delivers the audit value).

## Decision
A read-only aggregator endpoint `GET /api/v1/projects/{id}/board/activity` that joins
existing change-history sources into one time-ordered feed. **No new model, no migration**
— every event already has a durable home.

### Event sources (Option C — expose existing rows, synthesize nothing new)
1. **Task field changes** — `HistoricalTask` (django-simple-history on `Task`). Each
   `update` row is diffed against the same task's immediately-prior row into a curated,
   board-relevant field allowlist (`name`, `status`, `percent_complete`, `story_points`,
   `remaining_points`, `assignee`), reusing the `TaskHistoryView` diff logic generalized
   project-wide → `task_updated`. `create` rows → `task_created`, `delete` rows →
   `task_deleted`.
2. **Sprint transitions** — derived from the same `HistoricalTask` rows' `sprint_id`
   delta (held out of the field allowlist above so a sprint move is one first-class event,
   not a generic field change): null→id `entered_sprint`, id→null `exited_sprint`, id→id'
   `moved_sprint`, each carrying the sprint reference (the #325 AC's first-class
   mid-sprint scope events).
3. **Comments** — `TaskComment` creates surface as `comment_added` (author + created_at).

**Deliberately one source for sprint events.** `SprintScopeChange` (ADR-0102) records the
*accept-gate status* (pending/accepted/rejected) of a **post-activation** injection — the
*same* logical "task entered sprint X" fact that the `HistoricalTask` sprint delta already
yields. Sourcing both would double-count every mid-sprint injection, so v1 derives the
entered/exited events uniformly from `HistoricalTask` (covers pre- and post-activation
identically) and **defers** surfacing the accept/reject *status* as an enrichment to the
web follow-up — out of scope for the AC, which asks only for `entered_sprint`/`exited_sprint`
with a sprint reference.

### Unified event row shape
`{ id, event_type, actor, timestamp, task_id, task_name, changes: [{field, old, new}], sprint_id? }`
— `id` is a per-source-stable string (`hist:<history_id>`, `comment:<uuid>`,
`scope:<uuid>`) so the client can dedupe/key; `actor` is the username (null for
programmatic writes); `changes` is empty for non-diff events (comment/create).

### Aggregation & pagination (keyset via `until`, list-paginated — the codebase idiom)
The feed is built in Python (the `TaskHistoryView` precedent paginates a Python list),
**bounded** so it never loads all history:
- Each source is queried for events with `timestamp < until` (cursor; default = now),
  ordered DESC, capped at `OVERFETCH × limit` rows, `select_related` on the actor/task.
- `HistoricalTask` diffs are computed **within the fetched batch** (group by task, diff
  consecutive) — no per-row `prev_record` query (no N+1). The generous over-fetch means
  the returned page's rows have their prior-in-batch present; the documented edge is that
  a change whose prior row fell outside the batch shows with an empty `changes` list.
- The three source lists are merge-sorted by `timestamp` DESC, server-side filters are
  applied (`actor`, `type`, `since`), and the top `limit` are returned with
  `next_until` = the oldest returned timestamp (null when the window is exhausted). The
  client infinite-scrolls by passing `next_until` back as `until` — keyset pagination, no
  offset rebuild, no cursor-on-non-unique-leading-field trap (the reason the codebase
  already prefers limit/offset over DRF `CursorPagination`).

### Filtering (server-side, per AC)
- `type=<event_type[,event_type]>` — filter by event kind.
- `actor=<user_id>` — filter by who.
- `since=<iso>` / `until=<iso>` — time window (`until` doubles as the keyset cursor).
All filtering happens server-side over the merged list before the `limit` is applied.

### RBAC + field visibility
- `permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]` — any
  project member (Viewer+) reads the feed, mirroring `TaskHistoryView`. A non-member is
  404/403; archived projects are read-blocked consistently.

  > **Amendment (2026-07-13, #1890):** the "archived projects are read-blocked" claim
  > above was never true — `IsProjectNotArchived` passes all `SAFE_METHODS`, so it was a
  > no-op on these GET-only views. The permission has been removed from both
  > `BoardActivityView` and `TaskHistoryView`: history/activity is a read-only audit
  > surface that deliberately stays accessible after a project is archived, matching the
  > history app's views. The effective permissions are
  > `[IsAuthenticated, IsProjectMember]`.
- **Field-level cost gating** (#325 AC: "Viewer doesn't see cost-field deltas"): there are
  **no cost/budget fields on `Task` yet** (intentionally absent until the cost model #73
  ships). So the allowlist carries none today, and the gate is implemented as a
  role-checked allowlist filter (`_membership_role` → drop `_COST_FIELDS` deltas below
  `Role.MEMBER`) that is a no-op now but is the ready seam the moment cost fields land —
  the AC is satisfied structurally, not deferred.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **C: aggregate existing rows in a bounded Python merge (chosen)** | No migration, no new model; reuses HistoricalTask/TaskComment/SprintScopeChange; the `TaskHistoryView` list-pagination precedent | Python merge bounded by over-fetch; a deep-page change whose prior fell outside the batch shows no field diff (documented) |
| A new `BoardActivityEvent` table written on every mutation | O(1) feed reads, exact diffs | A new write on every task change (perf + a migration + a backfill for existing history); duplicates data simple-history already holds |
| `prev_record` per HistoricalTask row | Always-correct diffs | N+1 (one query per feed row) — perf-check blocker on a list endpoint |
| DRF `CursorPagination` over a DB UNION | Native cursor | No single queryset (3 heterogeneous tables); cursor on a non-unique `timestamp` leading field is the trap the codebase already avoids |

## Consequences
- **Easier**: the board gets its own audit on the board; reuses three existing durable
  sources with zero schema change; the cost-RBAC seam is ready for #73; the read endpoint
  is independently shippable and testable without the web panel.
- **Harder**: the aggregator's bounded Python merge is more code than a single queryset;
  the diff-completeness edge on deep pages must be documented; a future high-volume board
  may want the materialized `BoardActivityEvent` table (Alternative A) — this ADR is the
  v1 that defers that until the read pattern proves it necessary.
- **Risks**: (1) N+1 across tasks in the diff — mitigated by the batch-and-diff-in-Python
  design (no `prev_record`) + `select_related`. (2) unbounded scan — mitigated by the
  `until` cursor + per-source `OVERFETCH × limit` cap. (3) double-counting a sprint move
  — avoided by sourcing sprint events from `HistoricalTask` only, not also
  `SprintScopeChange`. (4) timestamp ties at a page boundary — the `until` keyset uses
  strict `<`; a sub-millisecond tie across sources is a theoretical dupe/skip on one
  boundary, acceptable for an audit panel and noted.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (board-scoped, single project).
- **Affected packages**: api (`board_activity.py` aggregator service +
  `BoardActivityView` + serializer + url; reuses `_HISTORY_DIFF_FIELDS` shape). Web (the
  collapsible board panel + filter chips + live `board.activity` WS) — **deferred to a
  follow-up**. No scheduler, no mobile, no helm.
- **Migration required**: **no** — read-only aggregation over existing rows.
- **API changes**: yes — `GET /projects/{id}/board/activity?since=&until=&actor=&type=&limit=`
  returning `{results: [...event rows...], next_until}`. Regenerate OpenAPI.
- **OSS or Enterprise**: **OSS**.
- **Deferred (web follow-up)**: the board activity panel, filter chips, click-through to
  the card drawer, and the live `board.activity` WebSocket broadcast (which would hook the
  existing task-mutation/broadcast paths). Filed as a follow-up to #325.

### Durable Execution
1. **Broker-down**: N/A — a pure read endpoint, no async side effects, no dispatch.
2. **Drain task**: N/A — no async work.
3. **Orphan window**: N/A.
4. **Service layer**: a new `board_activity.py` (`build_board_activity(project, …)`), pure
   read; no `.delay()`.
5. **API response**: synchronous `200` with the paginated feed.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: a read — naturally idempotent; the same `until`/filters return the same
   page.
8. **Dead-letter / failure**: N/A — validation errors (bad `until`/`since`/`type`) → `400`.

## Amendment B — backend follow-ups (#1264, 2026-06-22)

The original ADR deferred three backend items to a follow-up (#1264): the live
`board.activity` WebSocket push, a composite `HistoricalTask` perf index, and surfacing
the `SprintScopeChange` accept/reject status as a sprint-event enrichment. This amendment
resolves all three.

### B1 — Live updates reuse the existing card-sync events; no new WS event type

The deferral assumed the live push would need a **new** `board.activity` event that "hooks
every task-mutation/broadcast path." That assumption is now obsolete: every source the feed
aggregates **already broadcasts** today —

| Feed source | Existing event (ADR-0152 / #327) |
|---|---|
| Task field diffs (`task_created`/`task_updated`/`task_deleted`) | `task_created`, `task_updated`, `task_deleted` |
| Sprint delta (`entered`/`exited`/`moved_sprint`) | `sprint_scope_changed` |
| Comment creates (`comment_added`) | `task_comment_created` |

A new `board.activity` event would either (a) carry the full activity **row** — which would
force re-implementing the read-time RBAC gating (`_COST_FIELDS`, the velocity audience) **on
the wire**, the exact anti-pattern ADR-0152 forbids ("the broadcast **must not carry field
values**"; clients re-read through the role-gated serializer) — or (b) be a values-free
"ping" that fires on the **same commits** as the five events above, i.e. pure duplication of
an existing signal.

**Decision:** add no new event. The panel goes live by subscribing to the existing
value-free card-sync events and invalidating its `['board-activity', projectId]` query
(refetch the head page through the **already-gated read API** → RBAC-safe by construction).
This is **frontend-only wiring and belongs to #1261**; the `FROZEN_WS_EVENT_TYPES` contract
is **unchanged**. #1264's backend MR therefore ships nothing for B1 except this contract
decision.

### B2 — Composite `(project_id, history_date)` index on `historicaltask`

The feed and the existing `burn_series`/`sprint_daily_delta` services scan
`HistoricalTask.objects.filter(project_id=…, history_date__lte=…)`, but the table has only
single-column indexes → a filtered scan that the FK index leads, then sorts. #1189 tracked
this as a 0.4 optimization (bounded today by `HISTORY_RETENTION_DAYS=90`); it is the same
index #1264 lists.

**Decision:** add it now (closing #1189). The historical model is auto-generated by
django-simple-history, so the index must not enter Django's migration **state** (the
generated model's `Meta` does not declare it → `makemigrations --check` would then demand a
`RemoveIndex`). It is therefore added DB-side only via raw `RunSQL`
(`CREATE INDEX CONCURRENTLY IF NOT EXISTS htask_proj_hist_date_idx ON projects_historicaltask
(project_id, history_date)`, reverse `DROP INDEX CONCURRENTLY IF EXISTS …`) with no
`state_operations`, in a **non-atomic** migration (`atomic = False`, required for
`CREATE INDEX CONCURRENTLY`). `RunSQL` names the columns directly — sidestepping field
resolution on the generated model — and `IF NOT EXISTS`/`IF EXISTS` keep both directions
idempotent (safe on a reused test DB and on re-run). This establishes the repo's first
concurrent-index migration; non-locking, so safe on a live table.

### B3 — `scope_change_status` enrichment on `entered_sprint` events

`SprintScopeChange.status` (`pending`/`accepted`/`rejected`, ADR-0102) records the
post-activation accept-gate outcome of a mid-sprint injection. v1 sourced sprint events from
`HistoricalTask` only (to avoid double-counting) and deferred the status. The aggregator now
enriches each `entered_sprint` event with `scope_change_status` via a **single batched**
lookup keyed by `(task_id, sprint_id)` (index-covered by the existing
`scope_change_task_sprint_idx`) — `None` for pre-activation entries (no row), else the
status. Pure **read-layer**, no new write path, no N+1. `status` is **not** cost-gated, so it
is Viewer-readable like the rest of the feed (consistent with the drawer's `SprintSection`
scope-change chip).

### Durable Execution (Amendment B)
Unchanged from the base ADR — B1 adds no broadcast (reuses existing best-effort `on_commit`
events), B3 is a read-path enrichment, and B2 is a schema-only migration. No async work, no
dispatch, no outbox. Items 1–8 remain **N/A** for the same reasons stated above.
