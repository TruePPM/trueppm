# ADR-0138: Command Palette v2 — Role-Scoped Jump Targets + App-Wide Task Drawer

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: taskDrawerStore)

## Context
The base ⌘K command palette shipped in #1166 (mount, fuzzy filter, Jump/Action
groups, OS-aware label, EE gating) — see `packages/web/src/features/shell/commandPalette/`.
It offers only coarse navigation: My Work, Inbox, Programs, and a flat list of
every program/project → overview, plus two global actions (cycle theme, toggle
sidebar).

The v2 voc-audit panel (epic #1163) flagged the palette as a **daily-friction gap
across 4 of 8 personas** and re-scoped #647 to "palette v2: role-scoped jump
targets + quick-actions". The asks:

1. **Jump-to-task opens the task drawer inline** (not a navigation to the Gantt row) — Sarah.
2. **Distinct "Backlog: <project>"** and **"Active Sprint: <project>"** targets — Jordan, Alex.
3. **Sprint-scoped results** (active sprint, sprint retro) — Alex.
4. **Targets registered per role facet** so the palette serves contributors, not just PMs.
5. ~~"Log time on `<last task>`" quick-action~~ — **carved out to #1211**: TruePPM
   has no time-tracking capability yet (no `TimeEntry` model/endpoint exists).
   Building one to back a palette action would balloon this frontend-only feature
   into full-stack. #1211 depends on #926/#100 (time entry) + #1182 (last task).

**P3M layer:** Programs and Projects (OSS). The palette is a navigation/affordance
surface over a single user's reachable projects; it aggregates nothing across
projects upward toward Portfolio. It is OSS.

**The forces / constraints:**
- **Frontend-only.** No API, model, or migration changes. New React Query hooks
  that call *existing* endpoints are in scope; new endpoints are not.
- **No N+1 of hooks.** Role and facet data are **per-project detail** fields
  (`my_facets` on the project detail serializer; `useCurrentUserRole` hits
  `/projects/{id}/members/?self=true`). The project **list** payload exposes
  neither. Fetching role/facets for every project in the list to gate targets is
  an unacceptable N-fetch fan-out at palette-open time.
- **API-first.** Role gating must reflect server-provided role/facets, never an
  invented client-side rule that an MCP/agent client could not reproduce.
- **Opened anywhere.** The palette can be invoked outside a project context
  (`useProjectId()` → `undefined`), so the design must degrade cleanly when there
  is no current project to scope task search / sprint targets to.
- **No collisions with in-flight work.** #1197 edits `features/shell/HealthCluster*`;
  #1076 edits `BoardView`/board chrome; #978 edits settings. The palette subtree
  (`features/shell/commandPalette/`) is isolated. The design must stay inside it
  plus a new store and a one-line AppShell mount — and must **not** refactor
  ScheduleView's or BoardView's existing drawer mounts.

**Verified surface (research phase):**
- Task search: only per-project `GET /projects/{id}/tasks/?search=` (DRF
  `SearchFilter` on `name`). No cross-project search endpoint.
- `TaskDetailDrawer` (`features/schedule/TaskDetailDrawer.tsx`) is mounted in
  ScheduleView (`:1548`, driven by `scheduleStore.selectedTaskId`) and BoardView
  (`:2214`, driven by local state). It takes a **full `Task` object** as a prop;
  no `useTask(id)` hook exists. Internally it calls `useScheduleTasks()` (route
  `projectId`) for subtask counts and `useCurrentUserRole(projectId)`. It touches
  no shell/board-chrome files.
- `methodology` (`AGILE|WATERFALL|HYBRID`, default `HYBRID`) **is** on the
  `useProjects()` list type.
- `useActiveSprint(projectId)` derives the single `ACTIVE` sprint (ADR-0037)
  client-side from `/projects/{id}/sprints/`.
- The current project's `useProject(projectId)` (→ `my_facets`) is **already
  in flight** via `ProjectShell` — so in-context facets cost zero incremental fetch.

## Decision

Adopt a **two-tier command model**. Every palette item is still a `CommandItem`;
the registry is split by how much it knows about the user's role and context.

### Tier 1 — Global targets (all reachable projects/programs, role-agnostic)
Built from the already-loaded `useProjects()` / `usePrograms()` lists. **Zero
per-project fetches.** Gated only by data already on the list payload:
- Project overview (already shipped).
- **"Backlog: <project>"** — shown only when `methodology !== 'WATERFALL'`
  (read from the list field; ADR-0105 backlog is Agile/Hybrid).
- **"Board: <project>"** — navigation to `/projects/:id/board`.

These carry **no role gate** — navigation to a view a user can already reach via
the sidebar is governed server-side by the route's own membership check; the
palette must not invent a stricter client rule.

### Tier 2 — Current-project targets (only when `useProjectId()` is defined)
Built from the **already-cached** detail hooks for the one in-context project —
`useProject` (`my_facets`), `useCurrentUserRole`, `useActiveSprint`, and a
current-project task query. Each is a single fetch (or already cached), so there
is no fan-out:
- **Task search → inline drawer.** A current-project task query
  (`['tasks', projectId]`, the same key `useScheduleTasks` uses) supplies up to a
  capped N (8) fuzzy-matched **"Open task: <name>"** results. Selecting one writes
  the full `Task` + `projectId` into a new `taskDrawerStore` and opens an
  **app-wide drawer** (see below) — no navigation.
- **"Active Sprint: <project>"** + **"Open <sprint> retro"** — from
  `useActiveSprint(projectId)`; suppressed when there is no active sprint.
- **Role/facet-scoped targets** — each Tier-2 `CommandItem` may carry an optional
  `visibleWhen(ctx)` predicate evaluated against the current project's
  **server-provided** `{ role, facets }`. Example: a Product-Owner-facet user sees
  "Groom backlog"; a contributor sees "My tasks in <project>". The predicate reads
  server facts only.

When `useProjectId()` is `undefined`, Tier 2 is empty and the palette shows Tier 1
+ global actions (today's behavior, plus the richer cross-project targets).

### App-wide task drawer (a dedicated store, not a refactor)
Introduce a small **`taskDrawerStore`** (Zustand): `{ task: Task | null,
projectId: string | null }` + `openTask(task, projectId)` / `close()`. Mount a new
**`<GlobalTaskDrawer />`** wrapper once in `AppShell` that renders
`<TaskDetailDrawer task projectId onClose />` when the store is set.

This is deliberately a **separate** code path from the existing ScheduleView /
BoardView drawer mounts (which stay untouched — no collision with #1076's board
work). `TaskDetailDrawer` reads its `task`/`projectId` from props and does not read
`selectedTaskId` itself, so a second independent instance is safe; the palette is
the only writer of `taskDrawerStore`, so the two paths never double-open.

`TaskDetailDrawer`'s internal `useScheduleTasks()` (used only for subtask counts)
keys off the route `projectId`; when the drawer is opened from the palette on a
different/absent route, gain correctness by adding an **optional `projectId`
argument** to `useScheduleTasks` (defaults to the route param — no behavior change
for existing callers) and passing the drawer's `projectId` prop through. This is
the only edit outside `commandPalette/` + the new store + the AppShell mount, and
it stays within `features/schedule/` (no shell/board-chrome overlap).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Two-tier model + dedicated app-wide drawer store (chosen)** | No N+1; role/facets only for in-context project (already cached); isolated to palette subtree + 1 store + 1 AppShell line; no ScheduleView/BoardView refactor → no #1076 collision; API-first (server facts only) | Cross-project targets can't be role-gated (acceptable — they're navigation); a second drawer instance exists in the tree |
| B. Fetch role/facets for every project at palette open | Uniform per-project role gating everywhere | N-fetch fan-out on open (slow, hammers API); violates "no N+1"; most targets are navigation that needs no role gate anyway |
| C. Reuse `scheduleStore.selectedTaskId` for the palette drawer too | No new store | Drawer only renders inside ScheduleView/BoardView → "inline open" fails on Overview/other routes; lifting that mount app-wide refactors BoardView → collides with #1076 |
| D. Add a cross-project task-search endpoint + `useTask(id)` hook | Global task search; clean single-task fetch | New API surface → not frontend-only; larger gate chain; out of #647 scope |
| E. New `useTask(projectId, taskId)` hook calling existing detail endpoint | Single-task fetch decoupled from list cache | Unnecessary: palette task search already loads the `Task` objects it lists, so it can pass the object straight to the store — no extra fetch |

## Consequences
- **Easier:** power users jump to a task and edit it in the drawer from any route;
  contributors get role-relevant targets; Backlog/Board/Sprint become first-class
  destinations. The registry stays a pure, testable `CommandItem[]`.
- **Harder / risks:**
  - A second `TaskDetailDrawer` instance lives in `AppShell`. Mitigated: it is
    conditionally rendered (only when `taskDrawerStore` is set) and the palette is
    its sole writer, so it cannot double-open with the view-local drawers.
  - Tier-2 targets depend on detail hooks that are only "free" because
    `ProjectShell` pre-warms them; if the palette is opened on a project route
    where that prefetch hasn't resolved, Tier-2 targets pop in a beat later
    (acceptable — Tier-1 + actions render immediately).
  - Cross-project targets are not role-gated. Accepted: they are navigation to
    routes whose own membership checks are enforced server-side; the palette must
    not invent a stricter client rule (API-first).
  - Adding an optional param to `useScheduleTasks` is a shared-hook edit; kept
    safe by defaulting to the existing route-param behavior.

## Implementation Notes
- **P3M layer:** Programs and Projects (OSS).
- **Affected packages:** web only.
- **Migration required:** no.
- **API changes:** no. New React Query usage hits only existing endpoints
  (`/projects/{id}/tasks/?search=`, `/projects/{id}/sprints/`,
  `/projects/{id}/members/?self=true`, project detail) — all already consumed.
- **OSS or Enterprise:** OSS (`trueppm-suite`).
- **Files:** new `taskDrawerStore.ts`; new `GlobalTaskDrawer.tsx` (+ 1-line mount
  in `AppShell`); extend `commandItems.ts` (`visibleWhen?`, a `task`/`sprint`
  group/tag), `useCommandItems.ts` (Tier-1/Tier-2 assembly); optional `projectId`
  param on `useScheduleTasks`. No edits to `features/shell/` chrome (TopBar,
  ContextBar, HealthCluster) or board files.

### Durable Execution
1. Broker-down behaviour: **N/A** — pure frontend; no task dispatch, no DB writes
   beyond the existing `useUpdateTask` mutation the drawer already owns (unchanged).
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox / on_commit path.
4. Service layer: **N/A** — no backend code; client reads existing endpoints.
5. API response on best-effort dispatch: **N/A** — no new endpoint; reads only.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: **N/A** — navigation and drawer-open are idempotent client state
   transitions; re-running an item just re-sets the same store value.
8. Dead-letter / failure handling: **N/A** — on a failed read (task/sprint query),
   the palette simply omits those Tier-2 results and shows Tier-1; no retry queue.
