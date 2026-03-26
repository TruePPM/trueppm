# ADR-0001: WBS Tree, Task List, and Calendar View Architecture (Issue #40)

## Status
Proposed

## Context

Issue #40 requires three new views in the project workspace alongside the existing Gantt:
WBS Tree (drag-to-reorder, inline editing), Task List (sortable/filterable table, multi-select
bulk actions, CSV export), and Calendar (monthly grid, date-range task bars, milestones).

Several architectural questions must be resolved before frontend work begins:

1. View routing strategy
2. WBS reorder API — does one exist? What does "reorder" mean for an ltree path?
3. WBS code column — computed client-side or returned by API?
4. Bulk actions — batch endpoint or N individual PATCHes?
5. CSV export — client-side or API endpoint?
6. Calendar data model — `early_start`/`early_finish` sufficient?

## Decision

### Q1 — View routing: React Router (already in use)

React Router v7 is already wired in `router.tsx`. The routes `/wbs`, `/list`, and `/calendar`
are already declared as `PlaceholderView` stubs. **Use React Router for view switching.**

Rationale:
- URL is the correct home for "which view am I on" — bookmarkable, shareable, navigable with
  browser back/forward, and required for deep-linking from notifications or external tools.
- The offline-first constraint does not conflict with client-side routing. React Router operates
  entirely in-browser; the SPA shell is cached by the service worker. URL state survives hard
  refreshes because the server returns `index.html` for all routes.
- A Zustand view-state atom would be redundant with the URL and would prevent bookmarking.
  URL hash (`/#/wbs`) is inferior: it leaks into analytics, breaks `<NavLink>` active detection
  without extra config, and is the legacy SPA approach predating the History API.
- `ViewTabs` and `BottomNav` already use `<NavLink>` — they need no changes.

### Q2 — WBS reorder API: new `POST /api/v1/tasks/reorder/` action endpoint required

**The current API has no reorder endpoint.** `TaskViewSet` exposes standard CRUD; there is no
`@action` for reorder.

WBS reorder is not a PATCH to `wbs_path` on a single task. Moving a node in an ltree hierarchy
requires updating `wbs_path` on the moved node **and** all descendants (subtree), plus
potentially renumbering siblings. For example, moving task `1.2` before `1.1` requires:

- `1.2` → `1.1`
- `1.1` → `1.2`
- All children of old `1.2` (e.g. `1.2.1`, `1.2.2`) → `1.1.1`, `1.1.2`
- All children of old `1.1` (e.g. `1.1.1`) → `1.2.1`

This is a multi-row atomic operation — it cannot be expressed as N independent PATCHes without
risk of transient constraint violations and partial-update race conditions on concurrent clients.

**Required backend addition:**

```
POST /api/v1/projects/{project_id}/tasks/reorder/
Body: { "task_id": "<uuid>", "new_parent_id": "<uuid>|null", "position": <int> }
```

The endpoint must:
1. Run inside a `SELECT FOR UPDATE` on all affected task rows.
2. Recompute all `wbs_path` values for moved node and subtree atomically.
3. Increment `server_version` on every affected row (for mobile sync tombstoning).
4. Broadcast `task_reordered` via `broadcast_board_event()` inside `transaction.on_commit()`.
5. Enqueue `recalculate_schedule.delay()` on commit (WBS reorder may change summary task
   roll-ups even though it does not change dependencies).

**This is a 🔴 BLOCKER for WBS Tree frontend work.** The frontend drag-drop handler will have
nowhere to commit the reorder without this endpoint.

### Q3 — WBS code column: computed client-side from `wbs_path`

The API already returns `wbs_path` as a dotted ltree string (e.g., `"1.2.3"`). The WBS code
column visible to the user IS the `wbs_path` value, formatted identically. There is no separate
"WBS code" field on the model.

Decision: The frontend renders `task.wbs_path` directly as the WBS code column. No API change
needed. The WBS Tree component reads `wbs_path` to construct the tree structure client-side
(split on `.`, infer depth and parent from path segments).

This means the frontend must not maintain a parallel WBS numbering scheme — it is always
authoritative from the server after a reorder.

### Q4 — Bulk actions: new batch endpoint required

N individual PATCHes for multi-select delete or assign are unacceptable:
- Each PATCH triggers a `recalculate_schedule` Celery job — N PATCHes fire N jobs redundantly.
- N PATCHes generate N WebSocket broadcasts — connected clients receive N updates instead of 1.
- Network cost on mobile is proportional to N.

**Required backend addition:**

```
POST /api/v1/projects/{project_id}/tasks/bulk/
Body: {
  "task_ids": ["<uuid>", ...],
  "action": "delete" | "assign_resource",
  "payload": { "resource_id": "<uuid>" }   // only for assign_resource
}
```

The endpoint must:
1. Validate all task IDs belong to the project (no cross-project IDOR).
2. Execute the operation atomically.
3. Enqueue exactly one `recalculate_schedule.delay()` on commit.
4. Broadcast one `tasks_bulk_updated` event on commit.

**This is a 🔴 BLOCKER for Task List bulk actions.** The CSV export feature is independent of
this endpoint and can ship without it.

### Q5 — CSV export: client-side via TanStack Query cache

Decision: **Client-side CSV export using the TanStack Query cache.** No new API endpoint needed.

Rationale:
- The Task List view already requires the full task list in the TanStack Query cache to render.
  Client-side export is effectively free — no additional network round-trip.
- Papa Parse (or a lightweight hand-rolled CSV serializer) operates entirely in-browser; the
  only columns exported are already in the `Task` type (id, wbs, name, start, finish, duration,
  progress, isCritical, isComplete).
- At 1000+ tasks: a 1000-row CSV with ~10 columns is roughly 100–200 KB serialized. The
  JavaScript `Blob` + `URL.createObjectURL` download pattern handles this trivially in modern
  browsers. No memory concern at this scale.
- A dedicated API export endpoint adds backend maintenance burden and is only superior when
  the client does not already have the full dataset (e.g., paginated API). Since the Gantt and
  Task List require the full project task list anyway, the cache is always warm.
- Offline export works naturally: the cached data is available without network access.

**No new dependency** is needed — the export can be a small utility function. If column
customization (user-selected fields) is required in a future issue, a backend endpoint becomes
appropriate at that time.

### Q6 — Calendar data model: `early_start`/`early_finish` is sufficient for v1

The Task model already has `early_start` and `early_finish` (CPM-computed), `duration`, and
`percent_complete`. The calendar view needs: task name, start date, end date, milestone flag,
and critical flag. All of these exist.

`actual_start`/`actual_finish` are not on the model and are not needed for v1. The calendar
view will render CPM-scheduled dates. Actual vs. planned comparison is a PMO-tier feature and
belongs in the Enterprise repo.

The `Task` frontend type already maps `early_start` → `start` and `early_finish` → `finish`
(see `src/types/index.ts`). No model or API change needed for the calendar.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Zustand view-state atom for view switching | Simpler setup | Not bookmarkable, breaks browser nav, redundant with Router |
| URL hash routing | Works without server config | Legacy approach, poor NavLink support, analytics noise |
| React Router (chosen) | URL = shareable state, already wired | None at this project's current stage |
| N individual PATCHes for bulk | No backend work | N redundant Celery jobs, N WS events, mobile cost |
| Batch endpoint (chosen) | Single job, single event, offline-safe | Requires new endpoint (backend work) |
| API CSV export | Server-controlled formatting, large datasets | Round-trip, backend code, offline unusable |
| Client-side CSV (chosen) | Offline, no backend, uses warm cache | Not suitable if paginated API (not the case here) |
| Inline wbs_path PATCH for reorder | No new endpoint | Race conditions, partial updates, N server_version increments |
| Atomic reorder action (chosen) | Safe, atomic, single broadcast | Requires new endpoint |

## Consequences

**Easier:**
- View routing is already structurally in place — replacing `PlaceholderView` with real components
  requires no routing changes.
- Calendar can ship without any backend work.
- Task List (read, sort, filter, CSV export) can ship without any backend work beyond wiring
  `useGanttTasks` to the real API.
- WBS code column requires no backend work.

**Harder:**
- WBS Tree and bulk actions are blocked on two new backend endpoints before any UI integration
  testing can be done against the real API. Frontend can be built against fixture data in the
  interim (following the existing stub-hook pattern).

**Risks:**
- The ltree bulk reorder logic is non-trivial. Path collision during sibling renumbering must be
  handled carefully (use a two-phase rename: temp paths first, then final paths).
- The `SELECT FOR UPDATE` on the reorder endpoint combined with the CPM Celery task could create
  lock contention on large projects. Mitigate by keeping the lock scope to the affected subtree
  only, not the entire project's tasks.

## Implementation Notes

- Affected packages: `api` (two new endpoints), `web` (three new view components)
- Migration required: no (no model changes)
- API changes: yes
  - `POST /api/v1/projects/{project_id}/tasks/reorder/`
  - `POST /api/v1/projects/{project_id}/tasks/bulk/`
- OSS: both endpoints are OSS (community edition)
- Frontend stub hooks follow the pattern in `useGanttTasks.ts` — fixture data first, real hook
  once API is merged
- WBS Tree drag-drop library: evaluate `@dnd-kit/core` (already a common pairing with React 19;
  no existing dnd dependency in `package.json` — requires dependency review before adding)
- Calendar: evaluate `react-big-calendar` or a lightweight grid component (no existing calendar
  dependency — requires dependency review)
- CSV export: implement as a plain utility function in `src/lib/exportCsv.ts`; no new npm package
  needed for basic comma-separated export
