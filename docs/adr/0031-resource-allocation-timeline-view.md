# ADR-0031: Resource Allocation Timeline View — Single Project

## Status
Proposed

## Context

Issue #85 requires a resource allocation view for a single project that shows each
resource as a row with their assigned tasks as horizontal spans on a timeline. This
is distinct from the existing `ResourceView` (utilization grid: 32 px day-cells
colored by load %), which already ships under `GET /api/v1/projects/{id}/utilization/`.

The two views answer different questions:

| View | Question answered | Visual metaphor |
|------|------------------|----------------|
| Utilization grid (existing) | How loaded is this person each day? | Heat map |
| Allocation timeline (this ADR) | What is this person working on and when? | Gantt-style spans |

**P3M layer**: Programs and Projects — single-project scope. Cross-project allocation
is an Enterprise feature (#88) and is explicitly out of scope here.

**VoC panel (avg 6.2/10)**:
- Sarah (PM) 8/10 — hero user; needs frictionless inline partial-allocation editing
- David (Resource Mgr) 9/10 — hero user; needs `max_units` visible in row header
- Priya (Team Member) 6/10 — passive consumer; wants "My allocation" shortcut
- Marcus (PMO) 5/10 — tolerates; date range filter must be a primary control

Key blockers the design must address:
1. Partial allocation editing must be inline (no modal) or data quality degrades
2. `max_units` must appear in the row header
3. "My allocation" shortcut (pre-filter to current user + scroll to today)
4. Date range filter as the primary toolbar control (not buried)

**Existing API note**: `GET /api/v1/projects/{id}/utilization/` returns per-resource,
per-day load numbers. It does **not** return task names, task IDs, or task-level
spans. The timeline view needs task-level data; a new endpoint is required.

## Decision

### 1. New API endpoint: `GET /api/v1/projects/{id}/resource-allocation/`

Returns per-resource task spans sufficient to render the timeline and detect
overallocation client-side.

**Query parameters**:
- `start` (ISO date, optional) — window start; defaults to project `start_date`
- `end` (ISO date, optional) — window end; defaults to `MAX(early_finish)` across all project tasks
- `resource` (UUID, optional, repeatable) — filter to specific resource(s)
- `status` (string, optional, repeatable) — filter tasks by status (e.g. `NOT_STARTED,IN_PROGRESS`)

**Response shape**:
```json
{
  "project_id": "...",
  "window_start": "2025-01-01",
  "window_end": "2025-03-31",
  "resources": [
    {
      "id": "...",
      "name": "Ravi Singh",
      "email": "ravi@example.com",
      "max_units": 0.5,
      "tasks": [
        {
          "id": "...",
          "name": "Foundation pour",
          "early_start": "2025-01-05",
          "early_finish": "2025-01-15",
          "units": 0.5,
          "status": "NOT_STARTED"
        }
      ]
    }
  ]
}
```

Resources with no tasks in the window are **excluded** from the response.
Resources with zero assignments anywhere in the project are excluded entirely.

**Overallocation computation**: Client-side. For each resource, walk the sorted task
spans day by day and sum `units`; if the sum exceeds `max_units` on any day, mark
the overlapping tasks as overallocated. Server does not pre-compute this flag —
the data required is small (all spans per resource), and avoiding a second round-trip
to `compute_utilization()` keeps this endpoint's response time under 50 ms on typical
projects (≤200 tasks, ≤50 resources).

**Performance**: Single ORM query via:
```python
TaskResource.objects
    .filter(task__project=project, task__is_deleted=False)
    .select_related("resource", "task")
    .order_by("resource__name", "task__early_start")
```
With the existing index on `TaskResource.resource` and the composite index
`task_utilization_window_idx` on `(project, early_start, early_finish)`,
this is O(assignments) with no N+1 risk.

**RBAC**: Same permission gate as `/utilization/` — `SCHEDULER` role minimum.
Read-only endpoint; all writes continue through `POST/PATCH/DELETE /task-resources/`
per ADR-0028.

### 2. New view mode in existing `ResourceView`: "Timeline" tab

The existing `ResourceView` gains a view-mode toggle in the toolbar:

```
[ Utilization ]  [ Timeline ]          ← segmented control, left of date range
```

Switching is client-state only (no route change, no API refetch until the user
actually selects Timeline). Default mode: Timeline (the new view) for first-time
visitors; persists in `localStorage` per project.

**Toolbar layout (Timeline mode)**:
```
[< Prev]  [Today]  [Next >]    [start ──────── end]    [My allocation]   [Timeline | Utilization]
```
The date range picker is the **primary control** — it renders inline in the toolbar
as a date range input, not inside a secondary menu (VoC: Marcus).

"My allocation" shortcut pre-filters `resource` param to the current user's
resource ID and scrolls the row list to today (VoC: Priya). It is a text button
that toggles; pressing again clears the filter.

### 3. DOM-based timeline renderer (not canvas)

The Gantt view uses a canvas renderer (`GanttRenderer`) optimised for 2,400+ tasks
with drag interactions. The allocation timeline has different requirements:
- Fewer rows (typically ≤50 resources)
- Task spans need inline editing (click → units input) without hit-testing reimplementation
- No drag-to-reschedule (read-focused view; reschedule happens on the Gantt)

Approach: CSS-positioned spans inside a scrollable container, with virtual row
rendering (only rows in viewport ± 2 are mounted). Each row is:

```
[Resource name + max_units badge]  |  [Task spans on a time axis]
```

Task spans use `left` / `width` percentages computed from `(date - windowStart) /
(windowEnd - windowStart)`. This is the same geometry used by the Gantt canvas but
in DOM form.

**Why not canvas**: Inline partial allocation editing (VoC: Sarah) requires a real
`<input>` to be mounted inside the span. Emulating this on canvas adds significant
complexity. The performance argument for canvas does not apply here at ≤50 rows.

### 4. Overallocation rendering

Client walks each resource's sorted task spans:
- Build a day-by-day load map: `{ [isoDate]: totalUnits }`
- For each task span, if any day in `[early_start, early_finish)` has
  `load > max_units`, mark the task span as overallocated

Overallocated spans: red background with `text-[--color-danger-700]` label
(Design System token — see brand skill). Non-overallocated spans: project accent
color. Partial allocation (units < 1.0): stripe pattern overlay or reduced opacity,
with a `{units × 100}%` badge on the span when width ≥ 48 px.

Row header shows: `{name}` + `{max_units × 100}% available` badge
(e.g. "Ravi Singh — 50% available"). This makes red spans self-explanatory
without needing a legend (VoC: David).

### 5. Inline partial allocation editing

Clicking a task span opens an inline popover (not a modal) anchored to the span:

```
┌──────────────────────────┐
│ Foundation pour          │
│ Allocation  [ 50 ]  %    │
│ [Cancel]  [Save]         │
└──────────────────────────┘
```

On Save: `PATCH /api/v1/task-resources/{id}/` with `{"units": 0.5}` per ADR-0028.
The span re-renders optimistically; rolls back on error. This satisfies VoC:Sarah's
frictionless editing requirement without navigating away from the view.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Extend existing utilization grid with task name overlays** | Reuses existing ResourceGrid; no new endpoint | Fundamentally different data model — grid is 32 px cells, not variable-width spans; would require a full rewrite of ResourceGrid internals |
| **Canvas renderer (like Gantt)** | Consistent with GanttRenderer; handles 2,400+ rows | Inline input editing requires complex canvas hit-testing; ≤50 resource rows don't justify the added complexity |
| **Separate nav route `/resources/timeline`** | Clean separation | Fragments the resource section; adds a nav item; toolbar and date state already lives in ResourceView |
| **Server-side overallocation flag** | Authoritative; calendar-aware | Requires calling `compute_utilization()` per request (expensive for large windows); unnecessary for single-project scope where client already has all spans |

## Consequences

**Easier**:
- PMs (Sarah) and resource managers (David) can see who is working on what without
  switching to the Gantt view
- Partial allocation data quality improves due to inline editing lowering friction
- ADR-0030 "team utilization" KPI can query this same endpoint and derive its
  overallocation count from the response
- Foundation for future mobile allocation view (read-only scan of own row)

**Harder**:
- DOM-based timeline must be kept in sync with Gantt's time-axis geometry logic;
  if the Gantt time axis is refactored, `ResourceAllocationTimeline` must be updated
  in tandem
- Client-side overallocation detection is not calendar-aware (does not exclude
  non-working days). This is acceptable for V1 but must be noted in the UI
  (tooltip: "Allocation is calculated in calendar days; your project calendar may
  differ"). Calendar-aware overallocation is deferred to a follow-up.

**Risks**:
- `early_start` / `early_finish` are nullable until CPM runs; the view must handle
  unscheduled tasks gracefully (render them in a "Unscheduled" overflow section
  below the timeline, not crash). 409 handling from `/utilization/` is the model.

## Implementation Notes

- **P3M layer**: Programs and Projects — single-project, OSS
- **Affected packages**: `api` (new view + serializer), `web` (new component + hook)
- **Migration required**: No — new endpoint reads existing tables
- **API changes**: Yes — new `GET /api/v1/projects/{id}/resource-allocation/`
  endpoint in `packages/api/src/trueppm_api/apps/projects/views.py`;
  register in `projects/urls.py` as `@action(detail=True, methods=["get"])`
- **OSS**: Community edition only; cross-project view is Enterprise (#88)
- **Durable execution**: N/A — read-only endpoint, no background work
- **WebSocket**: No new broadcast events; task span data is refreshed by the
  existing `assignment_created/updated/deleted` broadcasts from ADR-0028 (client
  should invalidate the `/resource-allocation/` query on these events)
- **Testing**:
  - API: pytest — response shape, window clamp, RBAC gate, empty project (no
    assignments), unscheduled tasks (null early_start), resource + status filters
  - Web: vitest — overallocation detection logic, span geometry, inline edit flow,
    "My allocation" filter; Playwright E2E for full create-assign-view cycle
