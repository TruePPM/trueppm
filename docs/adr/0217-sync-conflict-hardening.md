# ADR-0217: Sync conflict hardening — explicit detection beyond server_version LWW

## Status
Accepted

## Context
Every synced model (`VersionedModel`) resolves concurrent writes with
`server_version` last-writer-wins (LWW). The loser's entire row is discarded and no
signal reaches the user — even when the two writers touched *disjoint* fields (one
edits a task's due date, the other its status). This is the realistic
"two-PMs-editing-at-once" case, and today it silently loses work (issue #322).

Two write patterns need hardening:

1. **In-place field edits** on the durable entities a PM actually co-edits — `Task`,
   `Project`, `Risk`. These already carry `HistoricalRecords`, which records the
   per-field before/after of every prior write. We can therefore reconstruct *which
   fields changed since the client's known version* and compare that to the fields the
   client is trying to change.
2. **Reorder / drag operations**, where the client computes a new `position` /
   `priority_rank` locally. Two simultaneous drags crisscross because each computed its
   target from a now-stale neighbor set.

`Card` in the issue text refers to a Kanban **board card**, which is a `Task` — there is
no separate `Card` model. `Comment` (`TaskComment`) is an **append-only, immutable**
model (no `HistoricalRecords`, 15-minute self-edit window, not a `VersionedModel`): there
is no in-place concurrent-edit surface to merge, so it is intentionally out of scope for
field-level merge and stays as-is (documented, not stubbed).

VoC panel average 8.0/10 (Sarah/PM 9, Nadia/API 8). Two 🟡 blockers folded into the
decision: (a) the 409 conflict body must not leak field values the requester cannot read;
(b) a successful merge must return **both** change sets so the client (and an AI agent
actor) can reconcile its cache rather than re-fetch blindly.

## Decision

### Part 1 — Field-level merge on stale PATCH (Task, Project, Risk)

A generic, model-agnostic helper `resolve_field_conflict()` plus a thin DRF mixin
`FieldLevelMergeMixin` live in `apps/sync/conflict.py`. The mixin wraps
`update`/`partial_update` on the three target viewsets.

Protocol:
- The client sends the version it last saw as `base_version` — accepted either as the
  `X-Base-Version` request header or a `base_version` body key (header preferred; body is
  the offline-friendly fallback). Absent `base_version` → today's LWW behavior is
  preserved (fully backward compatible).
- On write, if `instance.server_version <= base_version`, the client is current → normal
  write, no conflict path.
- If `instance.server_version > base_version`, a concurrent write happened. The helper
  reads `HistoricalRecords` rows with `history_date`/version newer than the client's base
  and unions their `diff_against` changed-field names → `concurrent_fields`. It intersects
  that with the payload's changed fields → `overlap`.
  - **Disjoint** (`overlap == ∅`): apply the patch, `server_version` bumps atomically as
    usual, return **200** with body
    `{"merged": {...client fields...}, "concurrent": {...fields others changed...},
    "server_version": N}`. The client merges both sets into its cache.
  - **Overlapping**: return **409** with
    `{"conflict_fields": [...], "server_value": {...}, "client_value": {...},
    "server_version": N}`. `server_value` is filtered through the serializer's
    representation for the requesting user, so no field the requester cannot read is
    exposed (RBAC blocker resolved).

The mechanism is generic over any `VersionedModel` carrying `HistoricalRecords`; Enterprise
registers additional models against the same mixin without forking logic.

### Part 2 — Server-side reorder endpoint (board cards)

A generic service `reorder_by_anchor()` in `apps/projects/reorder_services.py` computes a
new dense `priority_rank` for a single item relative to an anchor:
`{"item_id", "before_id" | "after_id" | "end"}`. It selects the sibling group
`FOR UPDATE` (ordered by `priority_rank`), computes the target rank as the midpoint of the
two neighbors (or `max+step` for `end`), and — when the fractional gap collapses —
renormalizes the group to dense `* 10` ranks inside the same locked transaction. Two
concurrent reorders serialize on the row lock, so the final order is deterministic with no
crisscross.

Exposed as `POST /tasks/{id}/reorder` on `TaskViewSet` (board card = Task). A **direct
`PATCH` that changes `priority_rank`** on a Task now returns **400** with
`{"code": "reorder_deprecated", "detail": ..., "endpoint": "tasks/{id}/reorder"}` — the
deprecation pointer. (The existing list-based `product-backlog/reorder` and `queue/reorder`
actions remain; this adds the single-item anchor form the issue specifies.)

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Field-level merge via HistoricalRecords (chosen) | Reuses existing audit rows; no new storage; generic | Merge fidelity bounded by history retention |
| Full CRDT / OT sync engine | Handles every concurrent case | Massive scope; not needed for two-editor case; out of alpha budget |
| Per-field `version` columns | Precise | Schema churn on every synced model; migration-heavy; breaks sync watermark model |
| Keep LWW, only add a client "you were overwritten" toast | Trivial | Still loses the loser's work; treats the symptom |
| Reorder: keep client-computed position + 409 replay | No new endpoint | Crisscross still possible between fetch and write; the issue explicitly asks for server-computed position |

## Consequences
- **Easier**: two people editing different fields of the same task both keep their work;
  reorder under contention is deterministic; agents get a structured, machine-actionable
  409 instead of silent loss.
- **Harder**: the write path for three viewsets now has a conflict branch (well-contained
  in one mixin); clients must send `base_version` to opt into merge (absent → LWW, so no
  break).
- **Risks**: merge accuracy depends on `HistoricalRecords` capturing the intervening
  writes — bulk `update()` paths bypass history, so those bumps look like an
  "unknown-fields" concurrent change; we treat an unresolvable/history-gap case
  conservatively as a **conflict (409)**, never a silent merge. Documented in
  `docs/architecture/sync.md`.

## Implementation Notes
- P3M layer: **Programs and Projects** (single-project entities) — OSS.
- Affected packages: `api` (sync + projects), `web` (mutation hooks, board/schedule drag).
- Migration required: **no** — no new fields; `priority_rank` and `HistoricalRecords`
  already exist on the target models.
- API changes: yes — `X-Base-Version`/`base_version` on PATCH (Task/Project/Risk); new
  `POST /tasks/{id}/reorder`; `priority_rank` PATCH → 400.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Cross-project / cross-portfolio merge
  semantics and rejected-write forensics remain Enterprise (issue table).

### Durable Execution
1. Broker-down behaviour: N/A — conflict resolution and reorder are **synchronous**
   request-scoped DB writes. The reorder already schedules a CPM recalc via the existing
   `enqueue_recalculate()` service on commit; no new async dispatch is introduced.
2. Drain task: N/A — no new async category. Reuses `scheduling/services.py::enqueue_recalculate`.
3. Orphan window: N/A — no outbox row created by this feature.
4. Service layer: reorder goes through new `apps/projects/reorder_services.py::reorder_by_anchor`;
   CPM recalc through the existing `enqueue_recalculate`.
5. API response: synchronous — 200 (merge), 409 (conflict), or reorder 200 with the new rank.
   No best-effort dispatch, so no `{"queued": true}`.
6. Outbox cleanup: N/A — no outbox rows.
7. Idempotency: reorder is idempotent under the `FOR UPDATE` lock (re-issuing the same
   anchor recomputes the same target rank; both target actions covered by `IdempotencyMixin`
   on the viewset). Field merge is idempotent — a replayed disjoint PATCH is a no-op once
   the client's fields already match.
8. Dead-letter / failure handling: N/A — synchronous; a failed write rolls back the
   transaction and returns 4xx/5xx to the caller. History-gap ambiguity fails **closed**
   (409), never silently merges.
