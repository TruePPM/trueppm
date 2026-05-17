# ADR-0066: Schedule Canvas Interactivity — Hover Dependency Chains and Right-Click Menu Expansion

## Status
Proposed

## Context

Two related Schedule-canvas affordances are bundled in one MR:

- **#475** — hover-to-reveal predecessor (blue) / successor (green) dependency chains, with non-chain rows and arrows dimmed. Read-only visualization on the canvas + task list panel.
- **#477** — right-click context menu expansion. Adds **Mark complete** (Space toggle), **Add predecessor…** / **Add successor…** (open a dependency picker pre-filtered by mode), and **Duplicate** (⌘D). Existing items (Edit, Indent, Outdent, Insert below [disabled], Convert to milestone, Delete) keep their behavior.

The bundle shares the same canvas surface, hit-test path, and keyboard-shortcut registry, so a single ADR covers both. The VoC panel (avg 4.0/10) is misleadingly low — 3 of 6 personas (Janet, Marcus, Priya) are out of scope for canvas-row interactions. Sarah (PM, target user) scores 7/10 with the chain highlight matching her #1 pain point. Alex's sprint-awareness concern is partially addressed by filing #480 (sprint blast-radius hint as a follow-up) and resolved in this ADR for the Duplicate action specifically.

This ADR resolves nine open architectural questions ahead of ux-design and implementation.

P3M layer: **Programs/Projects** (single-project Schedule canvas). OSS.

## Decision

### Q1 — Duplicate via existing `POST /api/v1/tasks/`, no new endpoint
The existing `TaskViewSet.create()` already accepts `parent_id` from the request body and computes WBS path placement under `select_for_update()` with `_renumber_siblings()`. The frontend reads the source task, POSTs name + duration + assignee + `parent_id` (and optionally `sprint=null` per Q2). Server handles WBS placement, server_version bump, and `broadcast_board_event("task_created")` via `transaction.on_commit()`. No migration, no new permission gate, no new serializer field.

### Q2 — Duplicate inherits sprint membership; toast with Undo when sprint is ACTIVE
Default behavior is "duplicate in the same context" — clone inherits `sprint_id` from the source. This matches the Jira/Linear/Asana convention and the 95% case where a PM duplicating a task wants a sibling in the same parent and sprint. Alex's hard-NO is *silent* mid-sprint scope addition; a visible toast resolves it without forcing the friction of default-to-backlog on every duplicate.

Toast policy (only when source's sprint status is `ACTIVE`):
- Copy: *"Added to Sprint &lt;name&gt; · Undo"*
- Undo action: re-PATCH the duplicate to `sprint: null` (moves it to backlog)
- Duration: 6 seconds (standard transient toast)
- No toast when source sprint is PLANNED, COMPLETED, CANCELLED, or null — those cases either pose no scope risk or have no sprint to add to

When #372 (CPM-aware sprint commitment) ships, the same gate will run on any drag-into-sprint, so the duplicate path inherits the enforcement for free.

### Q3 — Optimistic Mark complete with rollback via existing error parser
The Mark complete mutation sends `PATCH /tasks/{id}` with `{status: "COMPLETE"}` only. The serializer auto-injects `actual_finish`, `actual_start`, `remaining_points=0`, and `Task.save()` coerces `percent_complete=100`. Client adds optimistic update to `useUpdateTask` (or a new thin `useToggleComplete` wrapper) — snapshots the task before mutate, applies status flip optimistically, rolls back on 4xx/5xx and surfaces the existing `parseProgressAnchorError(error)` toast if the response is `code: "progress_requires_anchor"`. Auto-REVIEW Option-E does not fire because we send `status` explicitly. The toggle reverses Mark complete by emitting the previous status (snapshotted on click).

### Q4 — New lightweight `ScheduleDependencyPicker` modal, not a reuse of `PredecessorsEditor`
The existing `PredecessorsEditor` is embedded inside `TaskFormModal` (Board feature), predecessor-only, and row-list shaped. The Schedule canvas needs a quick modal: open → search → pick → save → close. Build a new component (~150 LOC) accepting `mode: 'predecessor' | 'successor'` and `taskId`. It reuses the existing `useAddDependency` hook (POST `/api/v1/dependencies/`) and the schedule's loaded task list. Successor mode passes the inverse predecessor/successor pair to the same endpoint. No API change.

### Q5 — Space rebound on focused row; ⌘D registered in `useScheduleKeyboard` with `preventDefault`
- `TaskListRow.onKeyDown` currently consumes both Enter and Space to "open drawer" — duplicate behavior. **Change**: Enter keeps "open drawer"; Space toggles Mark complete on the focused row (unless an edit cell is active or the active element is editable).
- ⌘D / Ctrl+D registers in `useScheduleKeyboard` with explicit `e.preventDefault()` to suppress the browser bookmark dialog. Handler fires on the focused row's task.
- Both shortcuts get entries in `KeyboardCheatsheet`.
- Board view's keyboard map is untouched (see Q9).

### Q6 — Precomputed adjacency + rAF-coalesced hover updates
Build a `Map<taskId, {predecessors: Set<taskId>, successors: Set<taskId>}>` from the dep set, invalidated on dep mutation (TanStack Query cache key `['dependencies', projectId]`). Hover BFS is **O(V+E)** over the precomputed adjacency — sub-millisecond at 500 tasks. `GanttEngine` gains a new method `setHoveredTaskId(id: string | null)` on the interface (interface-breaking; tracked here per the file-header convention). The engine emits a new `task-hover` event with `{taskId | null}`. A React `useDependencyHover(hoveredId)` hook computes `predecessorChain` + `successorChain` sets, coalesced through `requestAnimationFrame` so at most one chain update fires per frame. The task list panel reuses the existing `focusChainIds` prop pattern (already passed to `TaskListRow`) — the hook produces the prop value, no new wiring.

### Q7 — Single amber focus ring; last-gesture wins between hover and keyboard focus
There is only ever one "active row" — whichever the user gestured at last. Mouse hover sets it; keyboard Tab focus sets it. The dashed amber `#FCD34D` ring renders on that row in both modes; chain highlight activates from the same source. No double-ring case. Amber is acceptable in dark mode (verify in ux-review). No new tokens needed.

### Q8 — Explicit desktop-only via `hidden lg:block`; no touch listeners bound
Both #475 and #477 use the ADR-0064 convention: `hidden lg:block` (≥ 1024px). Hover, right-click, and the keyboard shortcuts (Space, ⌘D) bind only on `lg+` screens. The bundle docs page (and the existing legend overlay docs) note the desktop-only constraint. Touch parity for the chain highlight is filed in **#481** (tap-to-pin) and deferred until Schedule-canvas-on-touch is decided. Touch parity for the right-click menu is out of scope here and not yet filed.

### Q9 — Scope #477 to Schedule view only; file Board context menu as a separate issue
The Board view has no right-click menu today; #477's original "works in both Schedule and Board view" criterion is dropped. Rationale:
- Board already has its own affordances (column drag for status, BoardCard overflow menu, KeyboardCheatsheet shortcuts)
- Board keyboard map is J/K/H/L based and registered ad-hoc — ⌘D/Space wiring is a different keyboard story
- A Board context menu introduces affordance duplication risk that deserves its own evaluation

A new issue will be filed for **Board view right-click context menu** as a separate scope decision.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Q1A:** Frontend-only duplicate via existing POST (chosen) | No new API surface; reuses WBS lock + broadcast | Two round-trips (GET source if not cached, POST clone) |
| **Q1B:** New `POST /tasks/{id}/duplicate/` server endpoint | Single round-trip; server can enforce "no deps" | New endpoint, new permission, new migration; ~+200 LOC for minimal frontend savings |
| **Q2A:** Inherit sprint + Undo toast on ACTIVE (chosen) | Matches Jira/Linear/Asana defaults; zero-friction for the 95% case; toast is non-silent so Alex's hard-NO is satisfied | One transient toast on every ACTIVE-sprint duplicate |
| **Q2B:** Default to backlog | Uniform across sprint state; nothing to dismiss | Annoying friction in the common case; user drags into sprint after every duplicate |
| **Q2C:** Modal confirm on ACTIVE | Explicit decision | Defeats ⌘D speed; modal-spam pattern Alex also calls out |
| **Q4A:** New `ScheduleDependencyPicker` modal (chosen) | Right-shaped for canvas UX; small, focused | One more component to maintain |
| **Q4B:** Reuse `PredecessorsEditor` from Board's `TaskFormModal` | Single picker | Embedded in modal; row-list shape doesn't match single-pick UX; would need to refactor |
| **Q5A:** Space = Mark complete; Enter = open drawer (chosen) | Aligns with common task-list conventions; removes today's redundant Enter/Space duplication | Behavior change — needs cheatsheet entry + UX-review attention |
| **Q5B:** Different key (e.g. `c`) for Mark complete | No collision with current Enter/Space | Less discoverable; #477 acceptance criterion calls out Space explicitly |
| **Q6A:** Precomputed adjacency (chosen) | Fast (sub-ms BFS); simple invalidation key | Adjacency rebuilt on every dep mutation — fine, bounded by O(V+E) |
| **Q6B:** Lazy BFS, no precomputation | Lower memory | Allocates maps on every hover; GC pressure during rapid mouse movement |
| **Q9A:** Schedule only, file Board separately (chosen) | Tight scope; respects Board's distinct keyboard model | Bundle issue text needs an update |
| **Q9B:** Add right-click menu to Board in same bundle | Original #477 scope | Doubles surface area; Board has no menu primitive today; affordance overlap |

## Consequences

**What becomes easier:**
- Sarah's "what moves downstream when a task slips" answered in two visual sweeps without spreadsheet juggling.
- Mark complete, duplicate, and dep add reachable in one gesture from the canvas — no drawer round-trip for the most-frequent actions.
- Future #480 (sprint blast-radius hint) plugs into the same `useDependencyHover` adjacency cache.

**What becomes harder:**
- Behavior change on Space (was "open drawer," now "toggle complete") needs a documented release-note line and `KeyboardCheatsheet` entry.
- `GanttEngine` interface gains `setHoveredTaskId` + `task-hover` event — implementations (`GanttEngineImpl`, `GanttEngineStub`) and any downstream tests update in lockstep.

**Risks:**
- ⌘D `preventDefault` failures on Firefox/Safari edge cases (some browser builds intercept ⌘D before the page handler). Test cross-browser; document fallback ("right-click → Duplicate" always works).
- Optimistic Mark complete + a slow `progress_requires_anchor` rollback could flash the row green then revert. Acceptable; rollback uses existing toast pattern.
- The ACTIVE-sprint Undo toast adds a transient interruption to every duplicate inside a running sprint; acceptable trade-off versus the friction of default-to-backlog, but worth a UX-review check that the toast doesn't fight other transient surfaces (auto-REVIEW prompt, cycle-detection toast).

## Implementation Notes

- P3M layer: **Programs/Projects** (single-project Schedule canvas)
- Affected packages: `web` (only)
- Migration required: no
- API changes: no — `useAddDependency`, `useUpdateTask`, and `TaskViewSet.create()` cover all paths
- OSS or Enterprise: **OSS** (single project, single canvas, no portfolio surface)

### Durable Execution

1. **Broker-down behaviour**: N/A — both features are synchronous API calls (PATCH /tasks/, POST /tasks/, POST /dependencies/). No outbox; no Celery dispatch from this bundle. CPM recalculation on Mark complete or Duplicate flows through the existing `scheduling/services.py::enqueue_recalculate()` path that those endpoints already trigger; this bundle adds no new dispatch point.
2. **Drain task**: N/A — no new async work category.
3. **Orphan window**: N/A — no outbox rows produced.
4. **Service layer**: N/A — bundle is frontend-only; relies on existing serializer-level transition logic in `TaskSerializer.update()` and existing `enqueue_recalculate()`.
5. **API response on best-effort dispatch**: N/A — all responses synchronous (200/201/4xx).
6. **Outbox cleanup**: N/A.
7. **Idempotency**: Mark complete is idempotent (PATCH `status` to the same value is a no-op at the model level; `Task.save()` only fires `task_status_changed` when `status` actually changes per the `_status_changed` flag at models.py:491). Duplicate is **not** idempotent — repeating the POST creates a second copy; this is correct behavior for a user-driven duplicate action. The frontend disables the ⌘D handler for ~250 ms after firing to prevent accidental double-press.
8. **Dead-letter / failure handling**: N/A — synchronous API calls; failures surface as toasts with the existing error-parser path.

## New sub-issues to file before implementation

1. **Board view right-click context menu** — split off from #477's original scope (Q9). Separate evaluation of whether Board needs a context menu primitive at all.
