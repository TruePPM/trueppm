# ADR-0205: Web SyncStatusBadge — calm offline state from the client write queue

## Status
Accepted

## Context
TruePPM's differentiator is honest offline behavior for a self-hosted P3M tool
(persona: Sarah, the PM on a job site with no signal). Issue #374 asks for a
persistent, *calm* sync indicator in the web app shell — not a scary "connection
lost" modal — that tells the user whether their edits have reached the server:

- `Synced` (silent), `Syncing N` (spinner + count), `Offline · N pending`
  (calm orange), `Error` (red, retry).
- Click → a modal listing pending writes, the last error, a manual retry, the
  last-sync timestamp, and drain progress.
- Same vocabulary a future mobile/PWA surface would use.

**What already exists on the web client:**

- `navigator.onLine` + `online`/`offline` events (already consumed by
  `OfflineBanner.tsx`).
- **TanStack Query mutation cache.** `queryClient` (`src/lib/queryClient.ts`) uses
  the default `networkMode: 'online'`, so mutations issued while offline are
  *paused* (not failed) and auto-resume on reconnect. The cache therefore already
  is the client-side write queue: in-flight mutations, paused mutations, and
  errored mutations are all first-class, queryable state via `useMutationState`.
- `wsConnectionStore` — the live-update WebSocket channel (`Live`/`Reconnecting`/
  `stale`), surfaced in the bottom `StatusBar` (#643). This is a *read-freshness*
  signal, a separate concern from the *write queue*, and is intentionally NOT
  reused here.

**What does not exist:** a dedicated offline outbox store, and any client-side
`lastSyncAt` value.

The transactional outbox named in the issue is a *backend* durability primitive
(ADR-0082/0068); on the web client the equivalent live state is the TanStack
Query mutation cache. There is no need for a new backend endpoint — every value
the badge needs is already derivable client-side.

## Decision
Derive the badge state entirely on the client. No new API endpoint, model, or
migration.

**Sources**
1. `navigator.onLine` via a small reusable `useOnlineStatus()` hook (extracted
   from the pattern already in `OfflineBanner`).
2. TanStack Query mutation cache via `useMutationState`:
   - `inFlightCount` — mutations with `status === 'pending'` that are not paused.
   - `pausedCount` — mutations with `isPaused === true` (queued while offline).
   - `errorCount` + `lastError` — mutations with `status === 'error'`.
3. A tiny Zustand `syncStatusStore` holding `lastSyncAt: number | null`, bumped by
   a global `MutationCache` `onSuccess` handler registered on `queryClient`.

**State machine** (`useSyncStatus()` returns a discriminated `SyncStatus`):

```
kind: 'offline' | 'error' | 'syncing' | 'synced'

precedence (first match wins):
  !online                       → offline  (calm orange)   pending = paused + inFlight
  online && errorCount > 0      → error    (red, retry)
  online && inFlightCount > 0   → syncing  (spinner)       count = inFlightCount
  otherwise                     → synced   (silent)        lastSyncAt shown in modal
```

Rationale for precedence: when offline the user cannot act on an error and the
paused writes *are* the story, so `offline` dominates — calm, not alarming. Only
once online does an error (a write that failed and needs attention) escalate to
red. In-flight drain is the least urgent signal.

**Manual retry**
- `queryClient.resumePausedMutations()` resumes offline-paused writes.
- For errored mutations, iterate `queryClient.getMutationCache().getAll()`, filter
  `status === 'error'`, and call `mutation.continue()` on each to re-run it.
- Both are wired to the modal's "Retry now" button; the button is a no-op-safe
  call (resuming with nothing paused is harmless).

**Placement.** The issue says "right of search"; the v2 shell (ADR-0134) has no
literal search box — ⌘K is the search affordance — so the badge lives in the
TopBar right cluster, immediately left of the `NotificationBell`, mirroring the
existing `TaskRunIndicator` / `NotificationBell` badge-plus-panel pattern. On
`< md` the badge stays visible (offline trust matters most on mobile); the modal
is full-viewport-centered and focus-trapped (`useFocusTrap`), matching
`KeyboardShortcutsModal`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Derive from TanStack Query mutation cache + navigator.onLine + lastSyncAt store (**chosen**) | No backend work; binds to real live write state; auto-pauses/resumes are built in | Couples the badge to TanStack Query mutation semantics |
| New `/sync/status/` backend endpoint returning pending count + last sync | "Server truth" | Server cannot know the *client's* unsent writes — the pending queue is inherently client-side; adds an endpoint for state that already exists locally; violates "avoid inventing a backend endpoint" |
| Reuse `wsConnectionStore` | Already wired | Conflates read-channel liveness with write-queue state; a live socket says nothing about unsent edits |
| A brand-new persistent IndexedDB outbox for web | Survives reload | Large scope (a web WatermelonDB analog); out of scope for #374; premature before mobile parity |

## Consequences
- **Easier:** a truthful, always-visible trust signal with zero backend surface;
  the mutation cache already models pause/resume/error so the badge is a pure
  projection of existing state.
- **Harder:** the badge's fidelity is bounded by how mutations are issued — a
  write that bypasses TanStack Query (raw axios without a mutation) is invisible
  to it. This is acceptable: app writes go through mutation hooks, and the badge
  documents "tracked writes." A follow-up can audit stray raw writes.
- **Risk:** `lastSyncAt` resets on reload (in-memory store). Acceptable for a
  session-scoped trust signal; persisting it is a deliberate non-goal for #374.
- Vocabulary (`Synced` / `Syncing` / `Offline · N pending` / `Error`) is fixed
  here so a future RN/PWA surface mirrors it verbatim.

## Implementation Notes
- P3M layer: Programs and Projects (Operations-adjacent) — a single user's own
  edit stream. Not cross-project; firmly OSS.
- Affected packages: web only. No api, scheduler, mobile, or helm changes.
- Migration required: no.
- API changes: no.
- OSS or Enterprise: OSS (`trueppm-suite`). A personal, client-side write-state
  indicator is table-stakes adoption UX, not org governance.

### Durable Execution
1. Broker-down behaviour: **N/A** — this is a read-only client projection of the
   in-browser TanStack Query mutation cache. It dispatches no Celery work and
   commits nothing to the DB. The underlying mutations' durability is owned by
   their own endpoints (unchanged by this ADR).
2. Drain task: **N/A** — no server-side async work introduced. "Drain" here means
   the client resuming paused mutations via `resumePausedMutations()`, which is
   TanStack Query's in-memory queue, not a Celery/Beat drain.
3. Orphan window: **N/A** — no outbox rows or `transaction.on_commit()` callbacks.
4. Service layer: **N/A** — no backend dispatch path. Client logic lives in
   `useSyncStatus()` and `syncStatusStore`.
5. API response on best-effort dispatch: **N/A** — no new endpoint.
6. Outbox cleanup: **N/A** — no server outbox rows created. The client mutation
   cache is GC'd by TanStack Query's own `gcTime`.
7. Idempotency: **N/A for server work.** Client retry is idempotent-by-projection:
   `resumePausedMutations()` and `mutation.continue()` operate on the existing
   mutation instances, so pressing "Retry now" twice does not duplicate a write —
   an already-running mutation is not re-enqueued.
8. Dead-letter / failure handling: A mutation that errors terminally stays in the
   cache with `status === 'error'` and surfaces as the red `Error` state with its
   message in the modal until the user retries or it is GC'd. No server DLQ is
   involved.
