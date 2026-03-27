# ADR-0014: Gantt Canvas Rendering Fixes and Task Planned-Start Constraint

## Status
Accepted

## Context

Two distinct problems were found during Gantt review:

### Problem 1 — Canvas alignment (rendering bugs)

The custom canvas Gantt renderer has four bugs that cause visual misalignment:

1. **No `HEADER_HEIGHT` offset** — `TaskListHeader` is 28 px (h-7) and sits above the
   scrollable row area. The canvas has no equivalent header region. Bar row 0 is painted
   at canvas y=0, which is vertically coincident with the task-list header, not with row 0
   of the task list. Every bar is 28 px too high.

2. **`drawRowBands` ignores scrollTop** — alternating row-band fills use `i * ROW_HEIGHT`
   with no scrollTop subtraction. Bands drift away from their rows as soon as the user
   scrolls.

3. **`drawDependencyArrows` ignores scrollTop** — arrow y-coordinates use
   `rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2` with no scrollTop offset. Task bars are drawn
   with `ctx.translate(0, −scrollTop)`. At scrollTop > 0 arrows are detached from bars.

4. **No timeline date header** — `GanttRenderer.ts` has no `drawTimelineHeader` function.
   Users cannot read dates from the chart.

### Problem 2 — Drag does not save

`useDragCpm.ts` calls `commitDrag()` with no `confirmedStart` on drag-end, and nothing
in the codebase watches `phase === 'committing'` to fire a PATCH. Even if a PATCH were
wired, there is nothing to PATCH: `early_start` and `early_finish` are CPM-computed
read-only fields. There is no writable start-date field on `Task`.

The core question is how drag-to-reschedule should work in a CPM model. Four options
were evaluated (see Alternatives).

Sarah (PM, VoC 8/10) expects drag to actually persist a schedule change.

## Decision

### Rendering fixes (MR !A — `fix/gantt-canvas-rendering`)

Add `HEADER_HEIGHT = 28` to `GanttRenderer.ts`. Draw a two-row timeline header (major
unit above minor unit) at canvas y = 0..HEADER_HEIGHT on every full repaint. Offset all
bar, band, grid-line, and arrow y-coordinates by HEADER_HEIGHT. Fix `drawRowBands` to
subtract `scrollTop`. Fix `drawDependencyArrows` to subtract `scrollTop` (pass it as a
parameter — do not add a translate that would affect the arrow stroke width). Update the
scrollable content-area height in `GanttView.tsx` from `tasks.length * 28` to
`HEADER_HEIGHT + tasks.length * ROW_HEIGHT`.

### Task constraint — `planned_start` field (MR !B — `feat/task-planned-start`)

Add `planned_start: date | null` to the `Task` model (nullable, no default, indexed).
Semantic: "start no earlier than this date" (SNET). The CPM forward pass applies this
constraint as a floor: `early_start = max(CPM-computed early_start, planned_start)`.

- **Single field, not a constraint table.** The constraint is 1:1 per task for alpha.
  A `constraint_type` column may be added later without breaking changes.
- **SNET only for alpha.** MS Project's full set (SNLT, MSO, MFO, FNET, FNLT) is
  post-alpha. The absence of `constraint_type` implies SNET.
- **Belongs on `Task`, not a separate model.** No join cost is justified at alpha scale.
- **Resize drag → PATCH `duration`** (already writable). No new field needed for resize.

The `trueppm-scheduler` forward pass must accept `planned_start` per task and apply the
floor before propagating to successors.

`planned_start` is included in `SyncTaskSerializer` so mobile clients receive it in
delta pulls and the on-device CPM WASM respects it offline (issue #26).

### Drag save wiring (MR !C — `fix/gantt-drag-save`, depends on !B)

1. In `useDragCpm.ts`, `drag-task-end` handler: convert `ev.left` to an ISO date via
   `leftToDate(ev.left, engine.scales)` and pass it to `commitDrag(confirmedStart)`.
2. Add a `useGanttCommit` hook (or `useEffect` in `GanttView`) that watches
   `phase === 'committing'`: fire `PATCH /api/v1/tasks/{id}/` with
   `{ planned_start: confirmedStart }`. On success, invalidate the tasks query and
   reset the drag store to `idle`. On failure, set `phase: 'error'`.
3. Resize drag end: convert `resize-task-end` `ev.right` to a new finish date, compute
   `newDuration = workingDaysBetween(task.start, newFinishDate)`, and PATCH
   `{ duration: newDuration }`.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| A — `planned_start` constraint (chosen) | CPM-correct; works offline; maps to PMI SNET concept; downstream tasks cascade | Requires scheduler change; migration; slightly more complex than C |
| B — Drag = duration change only | No new field; resize already works | Misleading UX — move cursor implies relocation, not compression |
| C — `task_offset_days` additive | Trivial to implement | Offset stacks on CPM shifts causing double-movement; breaks schedule integrity |
| D — Preview-only, no save | No changes needed now | Violates Sarah's core requirement; not alpha-credible |

## Consequences

- **Easier**: Gantt is visually correct from !A onward. Drag-to-reschedule persists
  after !C. Schedule integrity is maintained — CPM still drives all other dates.
- **Harder**: CPM engine must handle the `planned_start` floor in the forward pass.
  Schedules with many constraints can become over-constrained; the PM must manage them.
- **Risks**: If `planned_start` is set and a predecessor slips past it, the task
  silently starts late anyway (floor is not a hard lock). This is correct CPM
  behavior but may surprise users expecting a "must start on" lock. Surface this
  in the UI with a tooltip on constrained tasks post-alpha.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages:
  - !A — `web` only
  - !B — `api`, `scheduler`, `web` (SyncTaskSerializer)
  - !C — `web` only
- Migration required: yes (!B — `planned_start` nullable column on `projects_task` and `projects_historicaltask`)
- API changes: yes (!B — `planned_start` added to `TaskSerializer` as writable field; included in `SyncTaskSerializer`)
- OSS or Enterprise: OSS (`trueppm-suite`)
