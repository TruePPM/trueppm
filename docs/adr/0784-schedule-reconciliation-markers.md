# ADR-0784: Schedule Reconciliation Markers — Preview, Divergence, Rejection

## Status
Accepted (2026-08-04)

## Context

The server owns every scheduled date. The web client writes an optimistic value
so the Gantt and the outline move at pointer speed, and the authoritative value
arrives later — after Celery finishes the CPM run.

Today that arrival is **silent**. Two paths deliver it:

1. `task_dates_updated` (ADR-0091) splices per-task CPM deltas straight into the
   `['tasks', projectId]` React Query cache via `applyTaskDatesDelta`
   (`packages/web/src/hooks/useScheduleTasks.ts`). This is the live path and
   fires within a second or two of the commit.
2. A full refetch — `useScheduleTasks`' 30 s `refetchInterval`, which runs
   **only while the WebSocket is not `live`**, plus any explicit invalidation.

Both replace the optimistic dates in place. The bar slides, the Start/Finish
columns change, and nothing marks what moved. The planner is left to spot the
difference against a plan they were looking at two seconds ago.

The divergence is not rare and it is not a bug to be fixed upstream: the client
approximates the working calendar (it has the weekly `working_days` mask) while
the engine applies the real one (holiday exception rows the client never
receives). A five-day span dropped next to a shutdown week *will* land somewhere
the client did not predict. The client being wrong is the design; hiding it is
the defect.

Rejections have the same shape. `useRescheduleTask.onError` restores the whole
cache snapshot and the row silently returns to where it was. Only the drag/resize
commit popover surfaces a reason — and only while it is still open. Every other
write path (build-mode `EditableCell`, the milestone date popover, paste) reverts
with no explanation at all.

**P3M layer**: Programs and Projects — single-project schedule authoring.
**Repo**: OSS. Nothing here aggregates across programs.

## Decision

A client-side reconciliation state machine with a single pure reducer, one
zustand store, and three surfaces.

### D1 — State machine

One entry per `(taskId, field)`, `field ∈ {start, finish}`:

| State | Meaning | Rendering |
|---|---|---|
| `preview` | Local optimistic value written, server has not answered | date renders *italic* |
| `diverged` | Server answered with a **different** value | `~~old~~ → new` marker, persists |
| `rejected` | Server refused the write | row listed in the pending strip with reason + Retry |

`acked` and `acknowledged` are **not stored states** — they are eviction. An
entry that reconciles equal is deleted; an acknowledged divergence is deleted.
Storing terminal states would grow the map without bound across a long session
for no read that ever consults them.

Transitions:

```
              registerPreview
                    │
                    ▼
                 preview ──── reconcile(equal) ────────────▶ (evicted: acked)
                    │
                    ├──────── reconcile(different) ───────▶ diverged
                    │                                          │
                    ├──────── reject(reason) ─────────────▶ rejected
                    │                                          │
                    └──────── TTL expiry ─────────────────▶ (evicted)
                                                               │
   diverged ── reconcile(different again) ──▶ diverged (`to` updated, `from` kept)
   diverged ── acknowledge ─────────────────▶ (evicted)
   rejected ── retry ───────────────────────▶ preview
   rejected ── dismiss ─────────────────────▶ (evicted)
   any      ── registerPreview (same key) ──▶ preview (supersedes)
   any      ── task absent from snapshot ───▶ (evicted)
   any      ── project switch ──────────────▶ (cleared)
```

Two transitions carry the intent of the issue and are easy to get wrong:

- **A new preview supersedes a diverged entry.** The user has just re-authored
  that value; they are no longer being asked to spot a difference they have
  themselves overwritten. Keeping the old marker would be noise about a date
  that no longer exists.
- **A second divergence keeps `from`.** `from` is the value the *planner*
  believed, not the value of the previous CPM pass. Two cascading runs must read
  as one move away from what they typed, not a chain of intermediate machine
  states they never saw.

**TTL.** A `preview` entry older than `PREVIEW_TTL_MS` (90 s) is evicted with no
marker. It does not become `diverged`: an un-reconciled preview means we never
received an answer, and claiming a divergence we cannot evidence is worse than
dropping the italic. 90 s is three fallback poll intervals — if the socket is
down and the poll is running, reconciliation has had three chances.

### D2 — Where the state lives

A dedicated zustand store, `stores/reconcileStore.ts`, keyed by `projectId` plus
the entry map.

- **Not React Query meta** — the very refetch that carries the authoritative
  dates replaces the entry it would have to survive.
- **Not component state** — `ScheduleView` unmounts on a tab switch, and the
  issue requires the marker to persist *until acknowledged*, not until the
  planner navigates.

The store holds no dates of its own beyond `from`/`to`; the task cache stays the
single source of what the schedule currently is.

### D3 — Where reconciliation is called

One pure reducer, `reconcile(entries, observations, nowMs)`, called from exactly
two sites — matching the two delivery paths above:

1. The `task_dates_updated` handler in `useProjectWebSocket`, **after** the
   splice. Deliberately *not* inside `applyTaskDatesDelta`: that function is pure
   and shared with `mapTask`'s geometry rules, and giving it a store write would
   make every unit test of bar geometry a store test.
2. `useScheduleReconciliation(tasks)` — an effect in `ScheduleView` that diffs
   the arriving tasks array. This covers the full-refetch path, the fallback
   poll, and first load.

Both call the same reducer, so the two paths cannot drift.

### D4 — Who registers a preview

`useRescheduleTask.onMutate`, where the optimistic patch is already applied, and
`useUpdateTask` when the patch carries `planned_start` / `planned_finish`. This
is one choke point per hook rather than one per call site, so drag, resize,
snap-to-project-start, the milestone date popover and build-mode date edits are
all covered without touching their call sites.

`onError` moves the entry to `rejected` with the extracted DRF reason.

### D5 — 🔴 The "cause" text is not derivable client-side, and we do not invent one

The issue's example toast reads *"Finish moved Oct 13 → Oct 16: the pasted 5-day
spec freeze lands on the July shutdown week."*

**The client cannot produce that sentence.** `EffectiveCalendar`
(`packages/web/src/api/types.ts`) carries `working_days` (a weekly bitmask) and
`holiday_count` (**a count**, not the dates). The exception rows that actually
caused the move are never sent to the browser. Neither is the `task_dates_updated`
delta annotated with a reason — it is pure CPM output.

We therefore ship **the fact, not a guess**:

> Finish moved Oct 13 → Oct 16.

…plus a qualifier only where the client can *prove* it from the weekly mask
alone — "Oct 13 is not a working day" — which is exactly the class of cause the
mask can evidence. Where the mask says the old date *was* a working day, the move
came from something the client cannot see (a holiday row, a dependency cascade, a
constraint) and we say nothing further rather than assert a cause.

Inventing a plausible cause is the worst available option: a planner who is told
"the July shutdown week" and finds no shutdown configured will stop trusting
every other marker on the screen.

A server-side `reason` on the CPM delta is the real fix and is **out of scope
here** — filed as a follow-up.

### D6 — Only a task with an open preview can diverge

Divergence is defined **against a local preview**, never against the previous
cached value. A task whose dates change with no open preview is a collaborator's
edit or a CPM cascade onto work the local user did not touch — marking those
would paint the outline on every teammate keystroke.

This is decidable today without new server fields: the presence of an entry *is*
the evidence that this client wrote that value. It also means the strip's count
is honestly scoped — "3 dates changed" means three of *your* dates, which is what
the acknowledgement gesture is for.

Marking cascade moves onto untouched tasks needs the server to say which run
caused them; that is the same follow-up as D5.

### D7 — The review strip is a sibling of the forecast bar, not part of it

The issue names "the Forecast strip". Implemented literally that is wrong twice:

- `ScheduleForecastBar` renders `ForecastEmptyState` — or returns `null` — when
  no Monte Carlo run exists. A project that has never run a simulation would get
  **no reconciliation announcement at all**.
- It is `hidden md:flex`. The announcement would not exist on mobile.

So `ScheduleReconcileStrip` is its own docked strip immediately above the
forecast bar, rendered at every breakpoint and **always mounted** — a live region
that mounts at the same moment its text appears is not reliably announced, so the
element is present and empty when there is nothing to say.

`role="status"` + `aria-live="polite"` for the count and the recomputed
announcement. Hard failures (rejections) route to the **existing**
`ariaAssertiveRef` region already threaded into `useScheduleCommit` rather than a
second assertive region — two assertive regions on one view is how announcements
get lost.

### D8 — "Show N changes" filters, it does not open a dialog

A `reviewFilterActive` flag on the store. `ScheduleView`'s visible-task
derivation narrows to tasks carrying a `diverged` or `rejected` entry while it is
on. Acknowledging the last entry turns the filter off, because an empty filtered
outline reads as "your project is gone".

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Chosen**: zustand store + pure reducer, two call sites | Survives refetch and unmount; one reducer to unit-test; both delivery paths provably identical | New store; preview registration must be remembered in future mutation hooks |
| Diff two consecutive task snapshots, no preview registration | No mutation-hook changes at all | Cannot tell my edit from a collaborator's — every teammate keystroke marks the outline. Fails D6 |
| Hold reconciliation state in React Query `meta` | No new store | The refetch that carries the authoritative dates is the thing that would have to preserve it. Structurally unsound |
| Component state in `ScheduleView` | Simplest | Marker dies on tab switch; the issue requires persistence until acknowledged |
| Server-computed divergence + `reason` field | Real causes; covers cascades onto untouched tasks | API change, new serializer field, CPM must record provenance. Correct eventual answer, far past this issue's scope |

## Consequences

**Easier**

- Every write path gets divergence and rejection surfacing for free by routing
  through the two mutation hooks — no per-call-site work.
- The state machine is a pure reducer over plain data, so the acceptance test
  (`preview → acked → diverged → acknowledged`) is a unit test with no React.
- The two delivery paths share one reducer, so the WS and poll paths cannot
  disagree — the failure mode ADR-0091 had to fix by hand for bar geometry.

**Harder**

- A future mutation hook that writes dates optimistically and forgets to register
  a preview will silently opt out of the whole feature. There is no gate for
  this; the two existing hooks are commented to say so.
- `useRescheduleTask.onError` restores the **entire** `['tasks', projectId]`
  snapshot, so one failed write rolls back unrelated concurrent optimistic
  writes. Pre-existing, made more visible by this change (the rejected row now
  announces itself while its neighbours quietly revert). **Out of scope** —
  follow-up issue.

**Risks**

- The TTL can evict a legitimately slow reconciliation on a very large project,
  dropping the italic without a marker. Chosen deliberately over asserting an
  unevidenced divergence (D1).
- The strip is a second always-present docked element above the forecast bar,
  costing ~28 px of canvas height on short viewports. It collapses to zero height
  when empty.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: **web** only
- Migration required: **no**
- API changes: **no** — this reads `task_dates_updated` and the tasks list as
  they already exist
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution

1. **Broker-down behaviour**: N/A — no async side effects are dispatched by this
   feature. It is a pure client-side read of results that other paths produce.
   When the broker is down the CPM delta never arrives, no reconciliation
   observation is made, and the preview entry expires by TTL (D1) leaving the
   date unmarked rather than falsely acked.
2. **Drain task**: N/A — no outbox rows are written.
3. **Orphan window**: N/A — no drain.
4. **Service layer**: N/A on the API side. The client-side equivalent is the
   single `reconcile()` reducer in
   `packages/web/src/features/schedule/reconcile/reconcileState.ts`; both call
   sites go through it and neither mutates entries directly.
5. **API response on best-effort dispatch**: N/A — no new endpoint.
6. **Outbox cleanup**: N/A. The client-side analogue is entry eviction:
   acknowledge, supersede, task-absent, project switch, and the 90 s preview TTL
   (D1) — the store cannot grow without bound across a session.
7. **Idempotency**: `reconcile()` is idempotent by construction — it compares the
   observed server value against the stored `expected` and derives the next state
   from that comparison alone. Replaying the same `task_dates_updated` delta (the
   ADR-0236 replay window, or the WS and fallback poll both delivering the same
   run) yields the same entry map. This is why reconciliation is a comparison
   against `expected` rather than a counter or an event log.
8. **Dead-letter / failure handling**: A `rejected` entry is the client-side dead
   letter. It is human-actionable by construction — it carries the server's
   reason and a Retry that re-issues the original mutation — and it persists in
   the pending strip until the user retries or dismisses it. There is no retry
   limit and no backoff: retry is a deliberate human gesture, not an automatic
   one, precisely because the common rejection causes (permission, lock,
   validation) do not resolve on their own.
