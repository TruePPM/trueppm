# ADR-0024: Summary Tasks and WBS Phase Rollup

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: is_summary)

## Context

TruePPM tasks use a flat list with `wbs_path` (PostgreSQL ltree) to encode hierarchy,
but there is no concept of a "summary task" — a parent node whose dates, duration, and
percent_complete roll up from its children. This is table-stakes for any PM switching
from MS Project or Primavera (VoC panel: Sarah 9/10).

The frontend already derives a tree from `wbs_path` strings (`buildWbsTree.ts`) and
renders indentation and expand/collapse in the WBS view, but `is_summary` and `parent_id`
are consumed by `useGanttTasks.ts` without being returned by the API — they are always
`false`/`null` from `TaskSerializer`.

Additionally, users need keyboard shortcuts to restructure the WBS in-place:
indent (make child of previous sibling), outdent (promote to parent level), and
reorder within siblings — matching MS Project conventions.

### P3M Layer
Programs and Projects — single-project WBS hierarchy. OSS repo.

### VoC Panel Summary (avg 6.2/10)
- Sarah (PM) 9/10 — hero feature, MS Project table-stakes
- Marcus (PMO) 7/10 — prerequisite for portfolio rollups
- Priya (Team) 6/10 — benefits from structure, won't use indent/outdent
- David (Resource Mgr) 5/10 — warns against silent assignment stripping
- Janet (COO) 4/10 — invisible, enables future features

### Key Constraints from VoC
1. Indent/outdent must not change task dates or assignments — only hierarchy
2. When a task gains children and had assignments, warn (don't block)
3. Duration-weighted percent_complete rollup
4. Schedule view summary bars visually distinct + collapse/expand
5. Tab/Shift+Tab primary shortcuts (MS Project convention)

## Decision

### 1. `is_summary` and `parent_id` — Queryset Annotations

Both fields are computed, not stored:

- `is_summary`: `Exists(Task.objects.filter(wbs_path__descendant_of=..., is_deleted=False))`
  — true when any non-deleted task's `wbs_path` is a direct child of this task's path.
- `parent_id`: Subquery matching the task whose `wbs_path` equals this task's parent path
  (strip the last ltree segment).

**Why annotations, not columns**: These change when *other* tasks move. Storing them
creates staleness and requires triggers or signals to keep consistent. Annotations are
always correct.

Both are added as read-only fields on `TaskSerializer`.

### 2. Summary Task Rollups

Summary task values are derived, never directly edited:

| Field | Computation | Where |
|-------|------------|-------|
| `early_start` | MIN(children's `early_start`) | Post-CPM step in Celery task |
| `early_finish` | MAX(children's `early_finish`) | Post-CPM step in Celery task |
| `duration` | Working-day span between rollup dates | Post-CPM step in Celery task |
| `percent_complete` | Duration-weighted average of children | Serializer annotation (always fresh) |
| `is_critical` | True if any child is critical | Post-CPM step in Celery task |
| `total_float` | MIN(children's `total_float`) | Post-CPM step in Celery task |

**Why split between CPM post-processing and serializer**: Date/float/critical fields
only change when the schedule is recalculated (CPM runs). `percent_complete` changes
whenever any child's progress is updated — computing it in the serializer ensures it's
always fresh without requiring a full CPM recalculation.

**Why post-CPM, not in the scheduler engine**: The scheduler package has zero Django
dependencies. Rollup computation needs the ORM to traverse children efficiently.
The Celery task already fetches all tasks and writes back CPM results — adding a
rollup pass there is the minimal-complexity approach.

Summary tasks are excluded from the CPM forward/backward pass — they have no
independent duration or constraints. Their dates are purely derived from children.

### 3. Summary Task Dependencies

Summary tasks can participate in the dependency graph, matching MS Project semantics.
This enables phase-to-phase links like "Phase 2 can't start until Phase 1 finishes."

**Resolution rules** — summary dependencies are expanded to leaf-task edges before
the CPM pass:

| Dependency | Resolves to |
|-----------|-------------|
| Summary S → Task T (FS) | S's latest-finishing leaf → T |
| Task T → Summary S (FS) | T → S's earliest-starting leaf |
| Summary A → Summary B (FS) | A's latest-finishing leaf → B's earliest-starting leaf |
| SS/FF/SF variants | Same leaf-resolution logic, matching the dep type semantics |

A new `expand_summary_dependencies()` function in the scheduler package performs
this expansion. The core CPM algorithm is unchanged — it only sees leaf tasks and
expanded edges.

**Circular dependency detection** runs on the expanded graph, so a summary task
depending on its own child is correctly caught as circular.

**Dependency model**: No schema changes needed. `Dependency.predecessor` and
`Dependency.successor` are FK → Task. Summary tasks are just tasks — the FK works
as-is. The expansion happens at CPM computation time, not at storage time.

### 4. Indent/Outdent — New API Endpoints

```
POST /api/v1/projects/{pk}/tasks/{task_id}/indent/
POST /api/v1/projects/{pk}/tasks/{task_id}/outdent/
```

No request body needed — the operation is fully determined by the task's current
position in the WBS.

**Indent** ("make child of previous sibling"):
1. Find previous sibling at same level (by `wbs_path` ordering)
2. If none exists → 400 (can't indent the first task at a level)
3. Append task as last child of previous sibling
4. Recursively update `wbs_path` for the task AND all its descendants
5. Renumber remaining siblings at the old level
6. `SELECT FOR UPDATE` + `transaction.atomic()` on all affected rows
7. Enqueue CPM recalculate + broadcast `tasks_restructured`

**Outdent** ("promote to parent level") — MS Project convention:
1. If task is at root level → 400 (can't outdent)
2. Move task to parent's level, inserting immediately after the parent
3. **Following siblings at the old level become children of the outdented task**
   (MS Project convention — preserves the user's grouping intent)
4. Recursively update all affected `wbs_path` values atomically
5. Renumber siblings at both old and new levels
6. Enqueue CPM recalculate + broadcast `tasks_restructured`

**Response**: `200 { "updated": [{ "id": "...", "wbs_path": "..." }, ...], "warning": "has_assignments" | null }`

The `warning` field is present when the operation causes a task to become a summary
task and that task has existing `TaskResource` entries. The frontend shows a toast.

**Move up/down**: Already handled by existing `TaskReorderView` — frontend computes
new `ordered_ids` and calls the existing reorder endpoint.

### 5. Assignment Guard

- `TaskResource` creation is blocked (400) if the target task `is_summary`
- Existing assignments are **not removed** when a task becomes summary — they are
  preserved but frozen (no new ones can be added)
- The API response includes `"warning": "has_assignments"` when indent causes a
  task to become a summary task and it has existing assignments
- Frontend shows a toast: "This task has resource assignments. Summary tasks cannot
  receive new assignments."

### 6. Keyboard Shortcuts (WBS View)

| Key | Action | Condition |
|-----|--------|-----------|
| Alt+→ | Indent | Task selected, not first at level |
| Alt+← | Outdent | Task selected, not at root |
| Alt+↑ | Move up within siblings | Task selected, not first sibling |
| Alt+↓ | Move down within siblings | Task selected, not last sibling |
| ↑/↓ | Navigate between rows | Always (standard navigation) |

Plain arrow keys are navigation only — reorder requires the Alt modifier to avoid
conflicting with basic row navigation.

> **Amended (#2192, a11y audit 2026-07-18):** indent/outdent were originally bound
> to Tab / Shift+Tab. Intercepting Tab inside the `role="treegrid"` container created
> a WCAG 2.1.2 keyboard trap — focus could never leave the tree, and every escape
> attempt fired a WBS mutation. They are now bound to Alt+→ / Alt+←, consistent with
> the Alt+↑/↓ move bindings; plain Tab propagates normally.

### 7. Schedule Summary Bar Rendering

- `BarType.summary` already exists in `GanttEngineImpl.ts`
- Summary bars: 16px height, downward triangle end caps (MS Project convention)
- Color: `neutral-500` from design system (distinct from regular task `primary-500`)
- Collapse/expand chevron in `TaskListRow` (same pattern as WBS view)
- Hit-testing and drag disabled on summary bars (already implemented)
- Dependency arrows render to/from summary bars with "(phase)" tooltip

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Store `is_summary` + `parent_id` as columns | Faster reads, simpler queries | Staleness — must update on every task move, create, delete. Triggers/signals add complexity |
| Compute rollups in the scheduler engine | Scheduler handles all date math | Breaks zero-Django-dependency rule. Scheduler doesn't have ORM for child traversal |
| Compute rollups only in serializer | Always fresh for all fields | Slow — requires subqueries on every list request. Date rollups don't change often enough to justify |
| Block indent when task has assignments | Prevents data confusion | Too aggressive — VoC says warn, don't block. PMs restructure WBS frequently |
| Expand summary deps at storage time | Simpler CPM input | Creates hidden dependency rows users can't see or manage. Deletion cascades become complex |
| Store expanded edges in a separate table | Auditable, queryable | Extra table, sync complexity, stale if hierarchy changes without dep change |

## Consequences

### What becomes easier
- PMs can structure projects with phases and sub-phases (table-stakes for MS Project migration)
- Phase-to-phase dependencies enable natural scheduling of multi-phase projects
- Schedule view becomes usable for projects with >20 tasks (collapse phases)
- Portfolio rollups (Enterprise) can build on project-level summary data

### What becomes harder
- CPM computation has a pre-processing step (summary dependency expansion) and a
  post-processing step (rollup computation) — the Celery task becomes more complex
- `TaskSerializer` gains two annotation subqueries — list endpoint query complexity increases
- Indent/outdent endpoints must handle recursive ltree rewrites atomically — careful
  locking required to avoid races

### Risks
- **Performance on large projects (>1000 tasks)**: Annotation subqueries for `is_summary`
  and `parent_id` add per-row cost. Mitigated by the GiST index on `wbs_path` and the
  existing pagination. Monitor with `perf-check` before merge.
- **Summary dependency expansion with deep nesting**: Expansion traverses the tree to
  find leaf tasks. For depth >10, this is still O(n) but the constant factor grows.
  Realistic projects rarely exceed depth 6-7.
- **Race conditions on concurrent indent/outdent**: `SELECT FOR UPDATE` on all affected
  rows prevents concurrent modifications. The lock scope is the set of tasks whose
  `wbs_path` changes — typically a small subset of the project.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS)
- **Affected packages**: `scheduler` (summary dep expansion), `api` (endpoints, serializer,
  CPM post-processing), `web` (keyboard shortcuts, Schedule view rendering)
- **Migration required**: No — no new columns. `is_summary` and `parent_id` are annotations.
  Summary rollups write to existing CPM output fields (`early_start`, `early_finish`, etc.)
- **API changes**: Yes — two new endpoints (indent/outdent), two new read-only fields on
  `TaskSerializer` (`is_summary`, `parent_id`), `percent_complete` becomes computed for
  summary tasks
- **OSS or Enterprise**: OSS (trueppm-suite)

### Durable Execution Checklist

1. **Broker down at dispatch**: Indent/outdent enqueues CPM recalculation via
   `enqueue_recalculate()` (existing outbox pattern). No new dispatch path needed.
2. **Drain task**: Uses existing `drain_schedule_requests` Beat task. No new drain.
3. **Orphan window**: Same as existing schedule requests (10-minute filter).
4. **Service layer**: Uses `scheduling/services.py::enqueue_recalculate()`. No direct
   `.delay()` calls.
5. **API response**: Indent/outdent returns 200 synchronously with the updated `wbs_path`
   values. CPM recalculation is async (existing pattern). No `task_id` in response.
6. **Outbox cleanup**: Uses existing nightly purge (7-day retention).

### Implementation Sequence

1. API: `is_summary` + `parent_id` annotations on `TaskSerializer`
2. API: indent/outdent endpoints with ltree rewrite logic
3. API: assignment guard on `TaskResource` creation
4. Scheduler: `expand_summary_dependencies()` function
5. API: summary rollup post-processing in CPM Celery task
6. API: `percent_complete` weighted rollup in serializer
7. Web: keyboard shortcuts (Tab/Shift+Tab/Alt+arrows) in WbsView
8. Web: Schedule summary bar rendering (16px, triangle caps, collapse/expand)
9. Web: dependency arrows to/from summary bars

## Tracking

Tracking: deferred — not yet filed. The summary-task data model shipped, but the
parent percent_complete / schedule-date / scope-delta rollup engine this ADR proposes
is still open work; the closest active issue is #408 (rollup engine, milestone 0.3),
which does not fully cover this ADR's scope.
