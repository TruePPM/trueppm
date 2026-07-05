# ADR-0220: Board offline — persistent IndexedDB card-status write queue

## Status
Accepted

## Context
Sarah (PM) works on a construction site three days a week with no signal. Her
one-question test for the board is "does this work on my phone with no signal?"
The most common job-site action is moving a card between statuses
(NOT_STARTED → IN_PROGRESS → REVIEW). Issue #606 asks for *minimum-viable* board
offline: the board renders from the last fetch, status-change writes queue
locally and survive a reload, and they flush honestly on reconnect.

**What already exists (ADR-0205, "Web SyncStatusBadge").** The web client's write
queue today is the TanStack Query mutation cache with `networkMode: 'online'`:
mutations issued while offline are *paused in memory* and auto-resume on
reconnect. ADR-0205 explicitly **considered and deferred** "a brand-new
persistent IndexedDB outbox for web" as out of scope for #374, "premature before
mobile parity." **#606 is that deferred follow-up** — the in-memory pause is lost
on reload, which is exactly the job-site failure mode (close the tab in a dead
zone, lose the queued moves).

**What the board looks like today.** `useUpdateTaskStatus()`
(`packages/web/src/hooks/useBoardTasks.ts`) does a plain
`PATCH /tasks/{id}/ {status, parent_id?, sprint_id?}` with **no optimistic
update** — the card only moves once the success refetch of `['tasks', projectId]`
lands. Offline, the mutation pauses and the card does not move at all. Board data
comes from `useScheduleTasks` (`['tasks',id]` + `['dependencies',id]`) and
`useBoardConfig` (`['boardConfig',id]`). `Task.serverVersion` (optional) is
carried on every task from the list endpoint. `useOnlineStatus()`, the imperative
`toast` API, and the `SyncStatusBadge` state machine all already exist.

**No PWA infrastructure exists** — no `vite-plugin-pwa`, no service worker, no
manifest, no `idb` dependency, no query-cache persistence.

**P3M layer:** Programs and Projects — a single user's own edit stream on one
project's board. Not cross-project. Firmly OSS.

## Decision
Add a **persistent, board-scoped IndexedDB write queue** for card-status changes,
plus a **last-fetch board read snapshot**, entirely on the client. No API, model,
or migration change — the queue replays the *existing* `PATCH /tasks/{id}/`.

This is a deliberate, scoped divergence from ADR-0205 for **this one write path**:
the persistent queue is needed for reload-durability, which the in-memory mutation
cache cannot provide. All other writes keep using ADR-0205's in-memory pause.

### 1. Durability: IndexedDB, one entry per task (LWW by construction)
A tiny IndexedDB database (`trueppm-board-offline`) with two object stores:
- `cardStatusQueue`, `keyPath: 'taskId'` — an upsert keyed by task id **is**
  last-write-wins per task: a second offline move of the same card overwrites the
  first, so only the latest queued status flushes. Each row also stores
  `baseServerVersion` (the `Task.serverVersion` observed when the move was queued)
  for conflict detection.
- `boardSnapshot`, `keyPath: 'projectId'` — the last successful board fetch
  (`tasks`, `dependencies`, `boardConfig`), written on every successful board load.

The `idb` package (Jake Archibald, ISC — Apache-2.0 compatible, ~1 kB gz) wraps the
raw IndexedDB API. Hand-rolling raw IDB request/transaction plumbing for a
two-store DB is error-prone and adds no value.

### 2. Reactive mirror: a Zustand store over the durable queue
`boardOutboxStore` (Zustand) holds the queued ops in memory keyed by task id and
is the **reactive** source cards subscribe to for the pending-sync badge.
IndexedDB is the durable source of truth; the store is hydrated from it on mount
and every `enqueue`/`remove` writes through to IndexedDB. This keeps components
re-rendering on queue changes (Zustand convention) while durability lives in IDB.

### 3. Offline write path (optimistic + queue)
`useUpdateTaskStatus()` becomes connectivity-aware without changing its
`.mutate(vars)` call sites in `BoardView`:
- **Online** → the existing TanStack mutation runs unchanged, so board moves stay
  server-authoritative *and* remain visible to the ADR-0205 `SyncStatusBadge`
  (which projects the mutation cache). No regression to the online path.
- **Offline** (`!navigator.onLine`) → apply an **optimistic update** to the
  `['tasks', projectId]` cache (snapshotting the prior value for revert), enqueue
  the op to the outbox store (→ IndexedDB), and show a per-card pending badge. No
  network call is attempted.

### 4. Flush on reconnect (honest last-write-wins + conflict)
A single flusher, mounted once by the board, hydrates the store on mount and
listens for the `online` event. On reconnect it:
1. Refetches `['tasks', projectId]` so the client holds current server state
   (including each task's current `serverVersion`).
2. For each queued op (already collapsed to one-per-task):
   - **Conflict** — if the server's current `serverVersion` has **advanced beyond**
     the op's `baseServerVersion`, someone else changed the card while we were
     offline. We do **not** clobber it: surface a calm conflict toast, revert the
     optimistic value (server wins), and drop the op.
   - **No conflict** — replay `PATCH /tasks/{id}/` with the queued status; on
     success remove the op and clear its badge; on terminal error surface the
     existing "couldn't move the card" toast and drop the op (the refetch
     reconciles the card to server truth).
3. Invalidate `['tasks', projectId]` once at the end to reconcile.

Conflict detection is **honest without an API change**: the PATCH endpoint does not
do server-side optimistic-concurrency rejection, so we compare the version we
*based our edit on* against the version the server *now* reports. Advancing means a
concurrent edit; yielding to the server (revert + toast) is the safe, truthful
choice rather than silently overwriting.

### 5. Read snapshot (criterion 1) without a service worker
On every successful board fetch the snapshot store is updated. When the board
mounts **offline** with an empty query cache, the three board queries are seeded
from the snapshot (`queryClient.setQueryData`) so the board renders the last
known state. The **app-shell service worker** (caching the JS bundle so a *cold*
reload works with no network at all) is **deferred to the PWA-shell issues
(#1425/#1427)** — it is a separate toolchain concern, and #606 explicitly scopes
out "offline read before first successful fetch." Seeding from a prior snapshot is
exactly the in-scope behavior; a cold-start SW is not required by any acceptance
criterion.

### 6. Pending-sync affordance
A `PendingSyncBadge` on each queued card, mirroring the existing calm-orange
offline vocabulary (`bg-semantic-at-risk-bg` / `text-semantic-at-risk`, cloud-off
glyph) from `SyncStatusBadge` and the compact chip structure of
`PendingAcceptanceChip`. It clears when the op flushes.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Persistent IndexedDB queue + snapshot, replay existing PATCH (chosen)** | Survives reload (the job-site case); no API change; honest conflict handling; online path unchanged so ADR-0205 badge unaffected | New client subsystem; a second write-queue concept alongside ADR-0205's in-memory one (scoped to board card-status only) |
| Keep ADR-0205's in-memory mutation pause | Zero new code | Loses queued moves on reload — the exact failure #606 exists to fix |
| Stand up `vite-plugin-pwa` + Workbox now for the read cache | True cold-start offline | Whole new toolchain + manifest + SW lifecycle; out of scope for #606; owned by #1425/#1427; none of #606's acceptance criteria need it |
| Add server-side optimistic-concurrency (If-Match / expected_version) | "Correct" conflict rejection | Requires an API change — #606 is explicitly frontend-only; client-side base-vs-current version compare is sufficient and honest |
| Hand-roll raw IndexedDB | No dependency | More code, easy to get transactions wrong; `idb` is ISC, tiny, battle-tested |

## Consequences
- **Easier:** status moves work offline and survive reload; conflicts are surfaced
  honestly instead of silently overwriting; the pattern (persistent op queue +
  base-version conflict compare) is a template the mobile/PWA surfaces can mirror.
- **Harder:** two write-queue mechanisms now coexist (ADR-0205 in-memory for
  general writes; this persistent one for board card-status). The divergence is
  documented and deliberately narrow — only card-status, only the board.
- **Risk:** the board snapshot read cache does not survive a *cold* bundle load
  offline (no SW yet); accepted and scoped to #1425/#1427. The queue's fidelity is
  bounded to card-status moves — offline task creation, detail edits, and phase
  reorder remain out of scope for v1 (explicitly).
- The global `SyncStatusBadge` (ADR-0205) does **not** count offline-queued board
  moves (they bypass the mutation cache while offline); the **per-card** badge is
  the #606 signal. Wiring the persistent queue count into the global badge is a
  documented follow-up, not required by #606.

## Implementation Notes
- P3M layer: Programs and Projects (Operations-adjacent) — a single user's own
  edit stream on one board. Not cross-project. OSS.
- Affected packages: **web only**. No api, scheduler, mobile, or helm changes.
- Migration required: no.
- API changes: **no** — replays the existing `PATCH /tasks/{id}/`.
- New dependency: `idb` (ISC license, Apache-2.0 compatible).
- OSS or Enterprise: **OSS** (`trueppm-suite`). Personal, client-side offline
  editing is table-stakes adoption UX, not org governance.

### Durable Execution
This feature introduces **no server-side async work**. It is a browser-only write
queue that replays an existing synchronous REST endpoint. The durability primitive
here is the browser's IndexedDB, not a Celery/outbox pipeline.
1. Broker-down behaviour: **N/A** — no Celery dispatch; the "outbox" is client-side
   IndexedDB and the "broker" is the network, whose absence is the designed-for
   case (queue locally, flush on `online`).
2. Drain task: **N/A** — no server Beat task; the "drain" is the client `online`
   flush replaying `PATCH /tasks/{id}/`.
3. Orphan window: **N/A** — no `transaction.on_commit()` rows; queued ops live in
   IndexedDB and are flushed client-side.
4. Service layer: **N/A** — no backend dispatch path. Client logic lives in
   `cardStatusQueue.ts`, `boardOutboxStore`, and the board flusher.
5. API response on best-effort dispatch: **N/A** — no new endpoint; the replayed
   PATCH returns its normal synchronous 200.
6. Outbox cleanup: queued ops are deleted from IndexedDB as they flush (success or
   terminal error). No server rows are created, so no server retention applies.
7. Idempotency: replay is idempotent by projection — a card-status PATCH is
   naturally idempotent (setting `status = REVIEW` twice is the same result), and
   the one-entry-per-task keying means a task cannot be double-queued. A conflict
   (server `serverVersion` advanced) drops the op instead of retrying, so a stale
   write is never replayed.
8. Dead-letter / failure handling: a queued op that fails terminally on replay
   surfaces the existing error toast and is dropped; the end-of-flush refetch
   reconciles the card to server truth. There is no server DLQ (no server work).
