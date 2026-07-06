# ADR-0247: Offline blocker-flag write queue

## Status
Accepted

## Context
Flagging a task blocked (ADR-0124: `blocked_reason` + optional `blocker_type` and
soft `blocking_task` link) is today a live `PATCH /tasks/{id}/` from `BlockerSection`
via `useUpdateTask`. On a job site with no signal the write fails, so the feature
**does not exist** for the persona it matters to most — Sarah (PM), 3 days/week in the
field, whose #1 evaluation criterion (🔴, #1159) is "flag it blocked *right then,
standing there*." A free-text reason typed and lost to a failed request is worse than
no affordance at all.

ADR-0220 already solved the structurally identical problem for board **card-status**
moves: a durable client-side IndexedDB queue, an optimistic cache patch, a reactive
mirror for the "pending sync" badge, and a flush-on-reconnect that replays the same
`PATCH /tasks/{id}/` the online path uses. This ADR extends that proven shape to the
blocker write. It is a **delta on ADR-0220**, not a new design.

Two facts shape the deltas:
- The blocker write and the board share the same TanStack cache key `['tasks', projectId]`
  (`useScheduleTasks`, `useUpdateTask`), so the optimistic patch mechanics are identical.
- ADR-0217 already added server-side **field-level merge** on a stale Task `PATCH`
  (opt in with `X-Base-Version`, 409 only on an overlapping same-field edit). A blocker
  flag writes a **disjoint field set** (`blocked_reason`/`blocker_type`/`blocking_task`),
  so this lets a queued flag survive an unrelated concurrent edit instead of being
  dropped — which is exactly what the 🔴 use case needs.

P3M layer: Programs and Projects → Operations (a contributor/field-PM action on one
task). Firmly OSS: personal, client-side offline editing is table-stakes adoption UX,
not org governance. `grep -rn trueppm_enterprise packages/web/src/features/**/offline/`
returns zero.

## Decision
Add a blocker-scoped offline write path mirroring ADR-0220's three-layer structure,
with three justified divergences.

1. **Durable queue — separate IndexedDB database `trueppm-blocker-offline` (v1), one
   store `blockerQueue` keyed by `taskId`, LWW upsert.** Not a second store on the
   board's `trueppm-board-offline` DB: sharing a DB name across two independently-loaded
   modules forces both to open the same monotonic `DB_VERSION` and both `upgrade`
   callbacks to know every store — a coupling that buys nothing. A distinct DB keeps the
   blocker queue self-contained and reload-durable. Pure helpers (`hasServerAdvanced`,
   `collapseLatestPerTask`, optimistic patch, PATCH-body builder) mirror
   `cardStatusQueue.ts` and are unit-tested without IndexedDB. IndexedDB is touched
   lazily so importing the pure helpers in jsdom is a no-op (degrades to in-memory).

2. **Optimistic patch reflects "flagged now" locally.** Queuing a flag patches the
   cached task with `blockedReason`/`blockerType`/`blockingTask` **and sets
   `blockedAgeSeconds = 0`** so `isFlagged` (`blockedAgeSeconds != null`) flips true
   immediately and the reason is readable to its author offline. Unblock queues
   `blocked_reason: ''` and patches `blockedAgeSeconds = null`. The real
   `blocked_since`/`blocked_by`/age are server-stamped and reconcile on the post-flush
   `invalidateQueries`.

3. **Conflict model: replay with `X-Base-Version` (ADR-0217 field merge), not ADR-0220's
   pre-emptive client-side yield.** Each queued op snapshots `baseServerVersion` at
   enqueue. On flush we replay the identical blocker `PATCH` **carrying
   `X-Base-Version: baseServerVersion`**. The server field-merges a disjoint concurrent
   edit and only 409s on a genuine overlap of the blocker fields themselves; on 409 we
   yield to the server (drop the op, refetch, calm conflict toast via the existing
   `handleSyncConflict`). This is the deliberate divergence from ADR-0220, whose blunt
   "server advanced → drop" would discard Sarah's flag if anyone touched any field of
   the task while she was offline — unacceptable for this specific write.

4. **Mount-independent flush in the shell.** ADR-0220 wires its flush inside
   `useBoardOffline`, mounted only by `BoardView`. The blocker drawer (`BlockerSection`)
   is not always mounted, so a `useBlockerOffline()` hook is mounted **once in
   `AppShell`** (always present on authenticated routes). It hydrates the reactive
   mirror, and on the browser `online` event (and once on mount if already online with a
   non-empty queue) flushes every queued op grouped by `projectId`. A queued flag
   therefore syncs on reconnect even if the user never reopens the drawer or the board.

5. **UI — "will sync when online" affordance.** A `useIsBlockerPendingSync(taskId)`
   selector drives a badge in `BlockerSection` mirroring `PendingSyncBadge`:
   `bg-semantic-at-risk-bg text-semantic-at-risk`, cloud-off glyph, `role="status"`,
   `aria-label="Blocker flag queued — it will save when you reconnect."` (color + glyph
   + text, WCAG 1.3.1 / 1.4.1). When offline the flag/save/unblock actions **enqueue
   instead of being disabled**; a helper line states the write is queued.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Second store on the board DB (`trueppm-board-offline` v2) | one DB | forces version-coordination across two independent modules; couples unrelated queues |
| **Separate `trueppm-blocker-offline` DB (chosen)** | fully decoupled, self-contained, matches "scoped narrowly" | one extra IndexedDB DB (negligible) |
| Reuse ADR-0220 client-side yield-to-server | identical to board | drops the flag on *any* unrelated concurrent edit — defeats the 🔴 case |
| **Replay with `X-Base-Version` field merge (chosen)** | flag survives disjoint edits; reuses ADR-0217; no API change | slightly more nuanced flush path |
| Flush from the drawer only | simplest | queued flag never syncs unless the drawer is reopened while online |

## Consequences
- **Easier:** field-PMs can flag blockers offline and trust they sync; the pattern is a
  faithful, testable mirror of ADR-0220; no API, model, or migration change.
- **Harder:** a second small client subsystem to keep coherent with ADR-0220; the
  shared `['tasks', projectId]` cache now has two independent offline writers (board
  card-status + blocker) — both LWW-per-task on disjoint field sets, so they compose,
  but future offline writers should consolidate rather than proliferate.
- **Risks:** IndexedDB unavailable (private mode / jsdom) degrades to in-memory (queued
  flag lost on reload) — same accepted bound as ADR-0220. A blocker-field overlap
  (two people editing the same task's blocker while one is offline) yields to the server
  and the offline author is told; acceptable and honest.

## Implementation Notes
- P3M layer: Programs and Projects → Operations
- Affected packages: web only
- Migration required: no
- API changes: no (reuses `PATCH /tasks/{id}/` and the existing ADR-0217 `X-Base-Version`
  header; server field-level merge already covers `Task` blocker fields)
- OSS or Enterprise: OSS (`trueppm-suite`)

### Durable Execution
This is a **client-side** durability feature; the "queue" is browser IndexedDB, not a
server outbox. Server-side async items are therefore N/A.
1. Broker-down behaviour: N/A — no server dispatch; the client IndexedDB queue *is* the
   durability mechanism, and it survives reload/crash by design.
2. Drain task: N/A (client) — the analog is the `AppShell` `online`-event flush, which
   also runs once on mount if the queue is non-empty (no queued flag is stranded).
3. Orphan window: N/A — no server rows; a just-enqueued op is immediately flushable.
4. Service layer: reuses `PATCH /tasks/{id}/` via `apiClient`; no new server service.
5. API response on best-effort dispatch: N/A — the online replay returns the normal
   synchronous `200`; offline, the client owns the queued state (badge), not the server.
6. Outbox cleanup: a queued op is deleted on successful flush or on a 409 yield; LWW
   upsert keyed by `taskId` bounds the queue to one row per task.
7. Idempotency: replaying a blocker `PATCH` is idempotent (setting the same
   `blocked_reason`/type/link twice is a server no-op; LWW). Duplicate flush is prevented
   by removing the op immediately after a `200`/409 and by the per-task upsert key.
8. Dead-letter / failure handling: a transient replay error keeps the op queued for the
   next `online` flush (no silent drop); a 409 field-overlap is terminal — yield to the
   server, drop the op, refetch, and tell the user via `handleSyncConflict`. There is no
   server DLQ because there is no server-side task.
