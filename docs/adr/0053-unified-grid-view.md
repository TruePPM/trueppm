# ADR-0053: Unified Grid View — Consolidate Table and WBS into a Single Surface

## Status
Accepted

## Context

The web app today ships two near-overlapping top-level views:

- **Table** (`packages/web/src/features/tasklist/TaskListView.tsx`) at `/projects/:id/list`
- **WBS** (`packages/web/src/features/wbs/WbsView.tsx`) at `/projects/:id/wbs`

Both render the same `Task[]` from `useScheduleTasks()` with slightly different chrome:
the Table flattens, sorts, filters, and group-by-cycles (none/phase/owner/status); the WBS
indents, drags-to-reparent, and supports indent/outdent keyboard moves. Hierarchy is a
*property of the grid*, not a *separate grid*.

Two top-level entries force a "which one do I open?" decision the user shouldn't have to
make. VoC panel (issue #334) confirmed: Sarah 8/10, Marcus 9/10, Alex 3/10 (improves with
Flat default), David 6/10 (improves with group-by-resource). No 🔴 blockers.

This ADR scopes the consolidation: one route, one navigation entry, one component, three
display modes selectable from a control inside the view (Flat / Outline / Grouped). The
mode toggle is component state, not a route change.

The OSS boundary is clean (`grep "trueppm_enterprise" packages/` returns six matches —
all comments and docstrings, zero imports). Single-project Grid is OSS; cross-project
portfolio grid stays Enterprise.

## Decision

### 1. Component structure — one shell, three mode adapters

```
features/grid/
├── GridView.tsx              # shell: toolbar, filter rail, mode toggle, mode dispatch
├── modes/
│   ├── FlatMode.tsx          # virtualized flat list (former TaskListView body, no group)
│   ├── OutlineMode.tsx       # tree + drag-to-reparent + indent/outdent (former WbsView body)
│   └── GroupedMode.tsx       # group-by selector (phase/owner/status/resource) + virtualized
├── shared/
│   ├── TaskRow.tsx           # the row used by Flat and Grouped (extracted from TaskListView)
│   ├── FilterRail.tsx        # search + chip rail (extracted from TaskListView)
│   ├── GridToolbar.tsx       # toolbar with mode toggle, group-by selector, +Task, expand-all
│   ├── getPhase.ts           # task → phase name helper (extracted, shared by Flat + Grouped)
│   └── columnDefs.ts         # column header config used across modes
├── persistence.ts            # localStorage I/O for mode + group-by
└── GridView.test.tsx
```

The shell owns: data fetch, project-id, error/empty/loading shells, toolbar, filter rail,
mode toggle, and selection store. The mode adapters own: virtualization (Flat/Grouped use
`@tanstack/react-virtual`; Outline uses no virtualization — tree fits in DOM), row build,
and mode-specific keyboard handlers (Outline gets Tab/Shift+Tab/Alt+arrow).

### 2. Mode dispatch — component state with localStorage persistence

Mode is a `useState<GridMode>` value inside `GridView`, NOT a URL search param. Reasons:

- Issue #334 specifies the toggle is **not a route**. A `?mode=outline` query string would
  re-introduce route-noise and break the shell's `currentView` derivation in `ViewTabs`.
- Modes are user preferences, not shareable artifacts. The shareable URL is `/grid` —
  recipients should land on their own preferred mode (or the methodology default), not
  the sender's.
- ADR-0001's "React Router for view switching" rule is honored: `/grid` IS a route;
  modes inside it are not.

### 3. Persistence — localStorage, per-project, versioned

Key convention follows the existing pattern (`trueppm.<area>.<setting>.v<N>` from
`trueppm.schedule.columnWidths.v4`, `trueppm.heatmap.window.v1`, ADR-0045).

```
trueppm.grid.mode.${projectId}.v1        → 'flat' | 'outline' | 'grouped'
trueppm.grid.groupBy.${projectId}.v1     → 'phase' | 'owner' | 'status' | 'resource'
```

Per-project (not global) so a Sarah/Marcus user can use Outline on their planning
project and Flat on their sprint-only project without switching every time. Reading from
localStorage is wrapped in a try/catch; failure falls through to the methodology default.

### 4. Methodology default — precedence chain

```
effectiveMode =
  persistedMode (localStorage[trueppm.grid.mode.${projectId}.v1])
  ?? methodologyDefault(project.methodology)
  ?? 'outline'
```

Methodology default mapping (per issue body):

| Methodology | Default mode |
|---|---|
| WATERFALL | Outline |
| AGILE     | Flat    |
| HYBRID    | Outline |

`useProject(projectId)` already returns `methodology`; defaults to `'HYBRID'` while the
fetch is pending (matches the existing `ViewTabs.tsx:55` pattern).

### 5. Migration — routes, tabs, and old-link compatibility

**Routes** (`packages/web/src/router.tsx`):
- Add `{ path: 'grid', element: <GridView /> }`
- Replace `{ path: 'wbs', ... }` with `{ path: 'wbs', element: <Navigate to="../grid" replace /> }`
- Replace `{ path: 'list', ... }` with `{ path: 'list', element: <Navigate to="../grid" replace /> }`

The `<Navigate>` redirects keep all existing bookmarks, shared URLs, and the post-login
`next=` rewrite logic working. They never render a real view, so the old components can
be deleted.

**ViewTabs** (`packages/web/src/features/shell/ViewTabs.tsx`):
- Remove the `wbs` entry (line 24).
- Replace `{ view: 'list', label: 'Table', Icon: ListIcon }` (line 25) with
  `{ view: 'grid', label: 'Grid', Icon: ListIcon }`.

**BottomNav** (`packages/web/src/features/shell/BottomNav.tsx`):
- Replace `{ view: 'list', label: 'Table', Icon: ListIcon }` (line 24) with
  `{ view: 'grid', label: 'Grid', Icon: ListIcon }`. WBS was already omitted on mobile.

**methodologyTabs** (`packages/web/src/features/shell/methodologyTabs.ts`):
- Remove `wbs` and `list` from all hidden-set rules.
- Add `grid` (visible for all three methodologies — the Grid replaces the entries that
  were already visible: Table for all three; WBS for WATERFALL+HYBRID; AGILE previously
  hid WBS, but Flat mode is the AGILE default so AGILE users still get a useful surface).

**No banner/toast notification on the change.** The redirect renames "WBS" + "Table" to
"Grid" silently — the surface is already familiar; the only change is one tab in
the strip. Users who follow an old `/wbs` or `/list` link land in the right place.

### 6. Feature-parity checklist — what survives the merge

| Feature | Source | New location |
|---|---|---|
| Sort columns (wbs/name/start/finish/duration/progress) | TaskListView | Flat + Grouped |
| Filter rail (search, owner, status chips) | TaskListView | shell — applies to all modes |
| Group-by (phase/owner/status) | TaskListView (cycle button) | Grouped mode (dropdown selector) |
| Group-by resource | NEW | Grouped mode (multi-assignee task appears under each resource) |
| Bulk select + delete with confirm strip | TaskListView | shell — applies to Flat + Grouped (Outline keeps its row-level selection) |
| CSV export | TaskListView | shell — exports the currently-filtered task set |
| Virtualized rows | TaskListView | Flat + Grouped |
| Tree view, indent levels, summary rollups | WbsView | Outline |
| Drag-to-reparent (`@dnd-kit/sortable`) | WbsView | Outline |
| Drag-to-reorder within siblings | WbsView | Outline |
| Tab/Shift+Tab indent/outdent | WbsView | Outline |
| Alt+ArrowUp/Down reorder | WbsView | Outline |
| Expand/collapse all | WbsView | Outline |
| Predecessors column (`formatPredecessors`) | WbsView | Outline (kept Outline-only — Flat row is already 9 columns wide) |
| TaskFormModal "+ Task" / "+ Child" | WbsView | shell (Outline-aware: "+ Child" only shown in Outline) |
| aria-live drag announcements | WbsView | Outline |

### 7. Group-by-resource semantics

`useScheduleTasks().tasks[].assignees: { resourceId, name, units }[]` is N:N. A task
with three assignees appears under three resource groups when grouped by resource. The
Grouped header includes a count: `Alice Smith (4 tasks)`. Multi-assignee tasks count
once per group. An "Unassigned" group surfaces tasks with `assignees.length === 0`.

This duplication is intentional — a resource manager grouping by resource wants to see
*everything that resource is on*, including shared work. A note in the Grouped mode
documentation clarifies the duplication.

### 8. Shared utilities — moves and re-exports

`buildWbsTree`, `flattenVisible`, `collectAllIds` are imported by `ScheduleView.tsx:14`
(the schedule view's task-list panel uses the WBS tree to render summary parents). To
avoid breaking that import, the helpers move:

- `packages/web/src/features/wbs/buildWbsTree.ts` → `packages/web/src/features/grid/shared/buildWbsTree.ts`
- `packages/web/src/features/wbs/formatPredecessor.ts` → `packages/web/src/features/grid/shared/formatPredecessor.ts`
- `packages/web/src/features/wbs/WbsRow.tsx` → `packages/web/src/features/grid/modes/OutlineRow.tsx` (renamed)

`ScheduleView.tsx:14` updates to import from `@/features/grid/shared/buildWbsTree`.
`useWbsStore` stays in `packages/web/src/stores/wbsStore.ts` (already at the stores level
— no import path change for `ScheduleView.tsx`).

`getPhase` is extracted from TaskListView into `features/grid/shared/getPhase.ts` so
both Flat and Grouped modes can use it.

### 9. Test migration

| Existing | New |
|---|---|
| `features/tasklist/TaskListView.test.tsx` (18 cases) | `features/grid/GridView.test.tsx` — migrate cases for Flat mode + add Grouped + Outline cases + mode-switching + persistence + methodology default |
| `features/wbs/buildWbsTree.test.ts` | `features/grid/shared/buildWbsTree.test.ts` — same cases, new path |
| `features/wbs/formatPredecessor.test.ts` | `features/grid/shared/formatPredecessor.test.ts` — same cases, new path |
| (no WbsView.test.tsx exists today) | — covered by Outline-mode cases in GridView.test.tsx |
| `stores/wbsStore.test.ts` | unchanged (store stays at `stores/`) |

**E2E spec migration** (3 specs touch these routes):
- `e2e/view-switching.spec.ts` — replace `/wbs` and `/list` blocks with a single `/grid` block plus mode-toggle assertions
- `e2e/wave5-views.spec.ts` — same
- `e2e/schedule.spec.ts` — update tab-name assertions from `WBS`/`Table` to `Grid`
- New: `e2e/wave3-grid-view.spec.ts` — open Grid, switch modes, verify data continuity (same task names visible across modes)

### 10. Implementation order — one MR

The migration ships as a single MR (no half-states):

1. Move `buildWbsTree`, `formatPredecessor`, and create `getPhase` shared utilities
2. Update `ScheduleView.tsx:14` to import from new paths (tests must stay green here)
3. Build `GridView.tsx` shell + persistence helpers
4. Build `FlatMode.tsx` + `GroupedMode.tsx` (re-uses TaskListView body)
5. Build `OutlineMode.tsx` (re-uses WbsView body, with WbsRow renamed to OutlineRow)
6. Wire router: add `/grid`, redirect `/wbs` and `/list`
7. Wire `ViewTabs.tsx` and `BottomNav.tsx` (remove wbs/list, add grid)
8. Wire `methodologyTabs.ts`
9. Migrate tests; delete `TaskListView.tsx` + `TaskListView.test.tsx` + `WbsView.tsx`
10. Update `docs/ux/p3m-vs-oss-views.md` to list "Grid" instead of "WBS / Table"

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. One shell, three mode adapters (chosen)** | Single source of truth for toolbar + filter rail; mode-specific virtualization; clean test boundary per mode | More files; mode adapters need to share a row component |
| B. One monolithic component with `mode` switch | Fewer files | Already-large TaskListView (~700 LOC) merged with WbsView (~500 LOC) yields a 1200+ LOC file; testing each mode independently becomes hard |
| C. Three independent components, parent dispatches | Clean per-mode boundary | Toolbar + filter rail duplicated three times; chrome state management ping-pongs through props |
| D. URL search param `?mode=outline` | Shareable mode link | Conflicts with issue ("not a route"); breaks `currentView` derivation; modes are preferences not artifacts |
| E. Server-persisted mode (per-user setting) | Survives device switches | Costs API surface, model migration, cache invalidation; ADR-0045 precedent says localStorage is fine for transient UI prefs |

## Consequences

**What becomes easier:**
- One navigation entry instead of two — fewer "which one?" decisions
- Toolbar features (CSV export, bulk delete, search, filter chips) automatically apply to
  all three modes instead of being half-implemented across two components
- Group-by-resource (David's missing feature) is a one-line addition to the existing
  group-by selector
- Methodology presets become more meaningful: AGILE projects default to Flat (sprint
  scoping); WATERFALL projects default to Outline (planning hierarchy)

**What becomes harder:**
- Mode adapters share state (filter, selection, sort). Wiring this through props or a
  shared store needs care to avoid cross-mode leak (e.g. a Flat-mode sort doesn't apply
  to Outline, where wbs ordering is fixed by tree structure)
- Outline mode's drag-to-reparent must coexist with Flat/Grouped's bulk-select. The
  shell gates the bulk-action toolbar to Flat + Grouped only; Outline shows its own
  toolbar variant (no bulk select).

**Risks:**
- **Bookmarks for `/wbs` and `/list`** keep working via redirect. If a user has the URL
  written into a runbook or shared in chat, the redirect lands them on Grid — silent,
  but the URL bar updates. No 404s.
- **ADR-0001 amendment** — that ADR proposed `/wbs` and `/list` as separate views. This
  ADR supersedes that part of ADR-0001. ADR-0001 is `Proposed`, not `Accepted`, so no
  formal supersedure record is required, but the new ADR text should reference it.
- **ADR-0041 amendment** — the methodology preset matrix listed `wbs` and `list` as
  separate entries. After this consolidation, both become `grid`. The matrix in ADR-0041
  needs an inline amendment note pointing here.
- **Test migration risk** — 18 TaskListView cases + 3 e2e specs touching the routes.
  Stale-mock check is the primary post-implementation gate before MR.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project task surface)
- **Affected packages**: web (only)
- **Migration required**: no (frontend-only, no DB changes)
- **API changes**: no (no new endpoints, existing `useScheduleTasks` polling unchanged)
- **OSS or Enterprise**: OSS — single-project surface; cross-project grid stays Enterprise

### Durable Execution

1. **Broker-down behaviour**: N/A — frontend-only consolidation. No new server dispatch
   paths; existing mutation hooks (`useUpdateTask`, `useBulkDeleteTasks`,
   `useReorderTasks`, `useIndentTask`, `useOutdentTask`, `useReparentTask`) already follow
   the established outbox-backed CPM recalc path.
2. **Drain task**: N/A — no new async work introduced.
3. **Orphan window**: N/A — no new outbox rows introduced.
4. **Service layer**: N/A — no new server-side service. The existing `enqueue_recalculate`
   path is invoked indirectly via the unchanged mutation hooks.
5. **API response on best-effort dispatch**: N/A — no new endpoint.
6. **Outbox cleanup**: N/A — no new outbox category.
7. **Idempotency**: N/A on the server. On the client, `localStorage.setItem` is naturally
   idempotent; mode reads tolerate parse failures by falling through to methodology
   default.
8. **Dead-letter / failure handling**: N/A — no new task. Client-side: a corrupt
   localStorage value (string outside the GridMode union) is treated as missing and
   falls through to the methodology default.
