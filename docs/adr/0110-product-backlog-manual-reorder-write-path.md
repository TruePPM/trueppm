# ADR-0110: Product Backlog Manual Drag-to-Reorder Write Path

## Status
Proposed

Extends ADR-0105 (PO Product-Backlog Hierarchy, Acceptance Criteria, and Prioritization
Scoring). ADR-0105 established the read model, the `priority_rank`/`sprint_rank` fields,
the one-shot auto-rank action, and the principle "auto-rank writes `priority_rank`; manual
drag always wins." It did **not** specify the manual drag write path. This ADR closes that
gap for #494 (grooming view), and confirms the reuse paths for #921 (inline quick-add) and
#922 (scoring columns).

## Context
The Product Backlog grooming view (#494) is the PO's primary daily surface: BACKLOG-status,
sprint-less, non-epic stories grouped by `parent_epic`, ordered by `Task.priority_rank`
(lower = higher priority). Today the only writer of `priority_rank` from this surface is the
**one-shot** auto-rank action (`POST .../product-backlog/auto-rank`, ADR-0105 DA-11), which
sorts by the active prioritization model and writes dense ranks `1..N`.

The headline capability of #494 — **manual drag-to-reorder** — has no write path. We must
decide the endpoint shape, the rank rebalancing strategy, the concurrency model (two POs
grooming the same backlog), the interaction with auto-rank's "manual wins" semantics, and
whether the mutation broadcasts. We must also confirm whether #921 quick-add and #922
scoring columns need new backend surface or can reuse what ADR-0105 already shipped.

**P3M layer:** Programs and Projects (single-project backlog ordering). OSS.

A near-exact precedent already exists: `PhaseReorderView` (`views.py`) reorders WBS-L1 phase
columns by writing `priority_rank = position * 10` under `transaction.atomic()` +
`select_for_update()`, with per-row `server_version` optimistic locking (409 on stale) and a
deferred `phases_reordered` broadcast. This ADR adopts that proven shape rather than
inventing a new one.

## Decision

### 1. Endpoint shape — dedicated `@action`, full ordered list
Add `POST /projects/{id}/product-backlog/reorder` as an `@action(detail=True)` on
`ProjectViewSet`, co-located with the sibling `product_backlog_auto_rank` action.

- **Not** `PATCH /tasks/{id}` with a bare `priority_rank` write: a single drag would force
  the client to compute and PATCH N rows (every row whose rank shifts), with no atomicity or
  server-side conflict detection across the batch.
- **Not** a standalone `APIView` (as `PhaseReorderView` is): an `@action` on `ProjectViewSet`
  inherits `IdempotencyMixin` (via `ProjectScopedViewSet`) and reuses the existing
  `IsProjectBacklogManager` permission branch, exactly mirroring the auto-rank sibling.

Request body — the **complete** ordered list of backlog stories in target order, each with
its client-known `server_version` for optimistic locking (mirrors `PhaseReorderView`):

```json
{
  "stories": [
    {"id": "<uuid>", "server_version": 12},
    {"id": "<uuid>", "server_version": 7}
  ]
}
```

Sending the full list (not a `{moved_id, before_id}` delta) matches both existing reorder
endpoints (`TaskReorderView`, `PhaseReorderView`), is race-resistant in combination with the
`server_version` check, and is bounded: the grooming GET returns the project's BACKLOG
stories unpaginated, so the client already holds the full set.

### 2. Rebalancing strategy — dense sequential `1..N`, full renumber
The service renumbers every supplied story to dense integers `1..N` in list order. Because a
full-list reorder rewrites the whole sequence, sparse/fractional/LexoRank keys buy nothing —
they exist to avoid renumbering neighbors on a single-item insert, which we are not doing.
Dense `1..N` also keeps the manual order **identical in shape** to auto-rank's output
(`enumerate(ordered, start=1)`), so a subsequent auto-rank diff is clean.

Only rows whose `priority_rank` actually changes are written, each via
`task.save(update_fields=["priority_rank", "server_version"])` — never `bulk_update` — so
every changed row bumps `server_version` (sync) and writes `HistoricalTask` (audit),
consistent with ADR-0105's auto-rank and `seed_sprint_rank`.

### 3. Concurrency — `server_version` optimistic lock + row lock
Inside `transaction.atomic()`: `select_for_update()` the affected rows, then verify every
supplied `server_version` against the live row. If **any** is stale, abort the whole batch
with `409 Conflict` (`{"detail": "stale", "conflicts": [<id>...]}`) and write nothing — the
client refetches the grooming view and retries. This is the `PhaseReorderView` contract.
Two POs grooming concurrently: the second commit sees bumped versions and gets a 409 rather
than silently clobbering the first PO's reorder.

### 4. "Manual wins" needs no sticky flag
Auto-rank is **one-shot and button-triggered only** — nothing reranks the backlog in the
background. Therefore "manual drag always wins" requires no per-row sticky/`manual_rank` flag:
a manual reorder simply overwrites `priority_rank`, and a later *explicit* auto-rank overwrites
it again (the PO chose to). There is no automatic process to fight. We explicitly reject a
sticky-flag design as unnecessary state.

### 5. Scope guard — rank only, never `sprint_rank`, never reparent
The reorder writes `priority_rank` only. It never writes `sprint_rank` (ADR-0105 §5's one-way
guard: in-sprint sequencing never mutates the product backlog, and vice-versa). It never
changes `parent_epic`: dragging a story between epic groups in the UI is **out of scope** for
this ADR (rank-only). Cross-epic reparent-by-drag, if wanted, is a separate follow-up.

### 6. Broadcast — reuse `backlog_reranked`
On commit, emit `broadcast_board_event(project_id, "backlog_reranked", {"project_id": ...})`
via `transaction.on_commit()` — the **same** event auto-rank already emits, so the web client's
existing handler invalidates the grooming query with no new event type. No CPM recalculation:
BACKLOG stories are sprint-less and absent from the schedule, so `priority_rank` has zero
effect on CPM (unlike `PhaseReorderView`, which does enqueue a recalc because phases are
scheduled).

### 7. #921 inline quick-add — reuse `TaskViewSet` POST
No new endpoint. Quick-add issues `POST /tasks/` with `{name, project, status: "BACKLOG",
type: "STORY"}`. `priority_rank` is left `NULL`; PostgreSQL sorts NULLs last under
`ORDER BY priority_rank ASC`, so a new story lands at the **bottom** of the backlog — the
correct default (the PO grooms it upward). `TaskViewSet.perform_create` already broadcasts
`task_created`. The client must send `status=BACKLOG` and `type=STORY` explicitly (there is no
BACKLOG defaulting on the generic create path).

### 8. #922 scoring columns — already served, render-only
ADR-0105's `product_backlog` GET serializes each story via `TaskSerializer` with the active
`prioritization_model` in context, so the computed `score` is already on every row. Surfacing
the scoring column is a **frontend render** change only — no backend work.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Dedicated `@action`, full list, dense `1..N`, server_version lock (**chosen**) | Atomic; matches `PhaseReorderView`/`TaskReorderView` precedent; inherits idempotency + permission; conflict-safe; shape matches auto-rank | Sends full list each drag (bounded, acceptable) |
| `PATCH /tasks/{id}` single `priority_rank` | Trivial; field already writable | N client writes per drag; no batch atomicity; no cross-row conflict detection; lost-update races |
| Fractional / LexoRank sparse keys | O(1) single-item insert, no neighbor renumber | Pointless under full-list renumber; needs a new key field + migration; diverges from `PositiveIntegerField` + auto-rank's `1..N` |
| Sticky `manual_rank` flag for "manual wins" | Explicit precedence record | Unnecessary — auto-rank is one-shot/button-only, nothing to fight; extra column + migration |
| Standalone `APIView` like `PhaseReorderView` | Direct copy | Must re-add `IdempotencyMixin` + permission plumbing the `@action` gets free; splits the product-backlog family across viewset + urls.py |

## Consequences
- **Easier:** the grooming view gets a conflict-safe drag write that reuses the auto-rank
  permission, idempotency, broadcast event, and rank shape — minimal new surface.
- **Easier:** #921 and #922 need no backend work; #921 is a create call, #922 is render-only.
- **Harder / risks:**
  - The client must send a complete, current ordered list with fresh `server_version`s; a
    stale snapshot yields 409 and a forced refetch. The UI must handle 409 by refetching and
    replaying the drag (or surfacing "backlog changed, reloaded").
  - Full-list renumber writes up to N `HistoricalTask` rows per reorder. Bounded by
    per-project BACKLOG story count; acceptable at expected scale, same as auto-rank.
  - Cross-epic reparent-by-drag is explicitly deferred; the UI must visually constrain drag to
    reordering, not reparenting, or a follow-up ADR must cover reparent semantics.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (new `@action` + `reorder_backlog` service), web (drag, scoring
  column, quick-add), docs/website (feature page already added on this branch)
- Migration required: **no** — reuses existing `Task.priority_rank`
- API changes: **yes** — `POST /projects/{id}/product-backlog/reorder`; OpenAPI regenerated
- OSS or Enterprise: **OSS**

### Durable Execution
1. **Broker-down behaviour:** N/A for durability — the only async side effect is a best-effort
   `broadcast_board_event` deferred via `transaction.on_commit()`. A dropped broadcast costs a
   client a real-time refresh, not data integrity; this matches the existing auto-rank and
   `PhaseReorderView` reorder paths, neither of which uses the outbox. The rank write itself is
   synchronous and transactional.
2. **Drain task:** N/A — no Celery task is enqueued (no CPM recalc; BACKLOG stories are out of
   the schedule).
3. **Orphan window:** N/A — no outbox row.
4. **Service layer:** new `reorder_backlog(project, ordered: list[tuple[id, server_version]],
   actor) -> int` in `projects/product_backlog_services.py`, alongside `auto_rank`.
5. **API response on best-effort dispatch:** synchronous `200 {"updated": <count>}`; `409
   {"detail": "stale", "conflicts": [...]}` on optimistic-lock failure; `400` on unknown/
   non-backlog ids. Not a queued/202 response — the write is synchronous.
6. **Outbox cleanup:** N/A — no outbox row.
7. **Idempotency:** `IdempotencyMixin` (ADR-0170, inherited via `ProjectScopedViewSet`) makes a
   retried POST with the same `Idempotency-Key` return the stored response. Independently, the
   operation is naturally idempotent: re-applying the same target order writes nothing (each
   row already equals its computed rank → no-op skip), and the `server_version` check rejects a
   replay against a since-changed backlog with 409.
8. **Dead-letter / failure handling:** N/A — synchronous atomic request; failures surface as
   400/409 to the caller, nothing to dead-letter. The whole batch is rolled back on any error.
