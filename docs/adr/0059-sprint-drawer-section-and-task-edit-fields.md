# ADR-0059: Sprint Drawer Section, Status/Progress Editing, and SprintBacklogTable Task-Add

## Status
Accepted

## Context

Wave/10 shipped the full Sprint API and 95% of the Sprint view (SprintsView,
SprintHeader, SprintBacklogTable, SprintBurndownChart, PlanSprintModal,
CloseSprintDialog, all sprint hooks). Three gaps remain:

1. No way to assign or change a task's sprint from the task detail drawer — the only
   path was the Board's TaskFormModal (gated by `agile_features`). User discovery
   path was Sprints view → see tasks → no way to add more.
2. Task status is read-only in the drawer (OverviewSection shows a dot + label). #405.
3. % complete is absent from the drawer entirely. #406.
4. SprintBacklogTable is display-only; its `⌘K to add task` hint is unwired.

All required API surface already exists (`PATCH /tasks/{id}/` handles `sprint`,
`status`, and `percent_complete`). `useTaskMutations` already includes all three
in `UpdateTaskPayload`. Zero API changes are needed.

## Decision

### 1. SprintSection drawer section (priority 150)

A new `SprintSection.tsx` registered at priority 150 (between Overview at 100 and
Dependencies at 200). Guards: `canRender: !task.isSummary && !task.isMilestone`.

**When task has no sprint:** render a sprint selector — a `<select>` populated by
`useSprints(projectId)` filtered to PLANNED + ACTIVE sprints (never COMPLETED or
CANCELLED). On change, fires `updateTask({ sprint: id })`. If no assignable sprints
exist, shows "No active or planned sprints — create one in the Sprints tab" (empty
state, no selector).

**When task has a sprint:** render the sprint name, state badge, and date range as
a read-display. Below that, a "Change sprint" inline selector (same dropdown) and
a "Remove from sprint" button that fires `updateTask({ sprint: null })`.

**agile_features gate:** handled inside the component — if `useSprints` returns an
empty list and no PLANNED/ACTIVE sprints exist, the section shows the empty state
rather than a confusing empty dropdown. No `canRender` guard on `agile_features`
(it's a project property, not on the task, and `canRender` runs synchronously before
any hook data is available).

### 2. Status selector in OverviewSection (#405)

Replace the read-only status display (colored dot + label) with an editable
`<select>` for the five canonical statuses: BACKLOG, NOT_STARTED, IN_PROGRESS,
REVIEW, COMPLETE.

**ADR-0057 transition rules enforced:**
- BACKLOG is excluded from the selector when `task.status` is IN_PROGRESS, REVIEW, or
  COMPLETE (those demotions require `BacklogDemoteConfirmDialog`). For pre-alpha, emit
  the confirm dialog on BACKLOG selection rather than hiding the option.
- COMPLETE auto-sets percent_complete=100 server-side (model save) — no client-side
  coerce needed; the TanStack Query cache updates on invalidation.

Fires `updateTask({ id: taskId, projectId, status: value })` on change (no blur delay
— status is a deliberate discrete action).

### 3. % complete editor in OverviewSection (#406)

Add a numeric input (0–100, step 1, suffix "%" label) below the status field in
OverviewSection.

**Summary tasks:** render as read-only (server returns a child-weighted average via
`to_representation()`). Label: "Progress (rolled up)".

**Leaf tasks with status=COMPLETE:** disabled — server will ignore the value anyway
(model coerces to 100 on COMPLETE save).

**Input behavior:** debounced 400 ms, fires on blur. Clamps to [0, 100] before
dispatch. Value initialized from `task.progress` (which maps to `percent_complete`
in the mapper).

Fires `updateTask({ id: taskId, projectId, percent_complete: value })`.

### 4. SprintBacklogTable task-add (#228)

Replace the aspirational `⌘K to add task` hint with a real "＋ Add task" button in
the SprintBacklogTable section header. On click (and on ⌘K via a `useEffect`
keydown handler scoped to the Sprints view), opens `TaskFormModal` (ADR-0052) with
`sprint` pre-populated to the active sprint ID. TaskFormModal already handles this
— `sprint` is in `CreateTaskPayload`.

The ⌘K keydown listener lives in `SprintsView.tsx` (mirroring how
`useScheduleKeyboard` is scoped to ScheduleView), not in the table component itself.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Bespoke inline task-add form in SprintBacklogTable | No modal transition | Duplicates TaskFormModal validation, misses notes/assignees/dates; violates ADR-0052 |
| Gate SprintSection by canRender + async agile_features | Clean mount/unmount | canRender is synchronous — can't call hooks; would require changing registry interface |
| Status as segmented button group in drawer | Visually clear | 5 statuses don't fit at drawer width without wrapping; inconsistent with board column-move pattern |
| Percent_complete as range slider | Mobile-friendly | Imprecise for fine-grained values; Schedule bar already has the visual; numeric input is more authoritative |

## Consequences

- Sprint assignment becomes available from the task drawer for the first time — closes
  the "no way to add to a sprint" gap discovered at sprint-view launch.
- Status and % complete editing consolidate into the drawer, reducing the Schedule →
  Board round-trip for basic task state updates.
- Every status/% PATCH enqueues a CPM rerun (existing TaskViewSet behavior) — this is
  acceptable and expected; the CPM engine ignores these fields but the queue cost is low.
- BacklogDemoteConfirmDialog is introduced in OverviewSection — one new component.

## Implementation Notes

- P3M layer: Programs and Projects (single-project task management)
- Affected packages: web only
- Migration required: no
- API changes: no (all fields already in serializer)
- OSS: yes — sprint assignment is part of the OSS agile bridge (ADR-0036/0037)

### Durable Execution
1. Broker-down behaviour: N/A — pure UI mutations via `useTaskMutations`; the Django
   TaskViewSet already handles CPM re-enqueue via `transaction.on_commit`.
2. Drain task: N/A — no new async dispatch path; existing CPM drain covers it.
3. Orphan window: N/A — existing drain handles; this ADR adds no new outbox rows.
4. Service layer: N/A — mutations go through existing `TaskViewSet.perform_update()`.
5. API response: synchronous 200 (existing TaskViewSet behavior).
6. Outbox cleanup: N/A.
7. Idempotency: N/A — PATCH is idempotent by nature; duplicate fires overwrite the same field.
8. Dead-letter / failure handling: N/A — `useTaskMutations` surfaces errors via React Query
   error state; optimistic updates roll back automatically on failure.
