# ADR-0040: Wave 3 Schedule — Bar Render, Task Drawer, and Unscheduled Gutter

## Status
Accepted

## Context

Wave 3 of the design-aligned UI roll-out targets three schedule-view improvements
(issues #212, #210, #213):

1. **Bar render (#212)**: Gantt bars in light mode have poor legibility — task name
   rendered inside the colored bar causes low-contrast text. The design calls for the
   `percent_complete` chip to live *inside* the bar and the task name to render
   *outside* (right of the bar end, or left-aligned above the bar when the bar is
   too narrow).

2. **Task detail drawer (#210)**: `TaskDetailDrawer.tsx` exists with four tabs
   (Dependencies | Estimates | History | Baseline) from ADR-0032. Wave 3 completes
   the header section — owner display, float, critical-path indicator — and verifies
   the History tab surfaces system events (date changes, reassignments) not just
   manual notes.

3. **Unscheduled gutter (#213)**: Tasks with no CPM schedule dates (`early_start IS
   NULL`) have nowhere to appear on the canvas. The design calls for a dedicated drop
   zone below the main timeline. Dragging a task from the gutter onto the timeline
   sets `planned_start` to the drop date, transitions status from BACKLOG →
   NOT_STARTED, and enqueues a CPM recalculation.

P3M layer: **Programs and Projects** (single-project schedule tooling).
OSS boundary: clean — no enterprise imports required.

VoC panel average: 6.2/10. Hero personas: Sarah (PM, 9/10) and Alex (SM, 7/10).
Key VoC constraints incorporated:
- Drawer must work on mobile (touch-friendly, same slide-in)
- Activity feed must include system events, not comments only
- Owner field should show passive overalloc indicator
- Unscheduled gutter is single-project scope in this wave

## Decision

### #212 — Bar render

Modify `GanttRenderer.ts` → `drawTaskBar()`:

- **% chip**: render a small rounded rect (min-width 28px) inside the bar anchored
  to the left edge, clipped to bar bounds. Text: `Math.round(percent_complete * 100) + '%'`
  in JetBrains Mono 10px, `semantic-on-critical` / `semantic-on-surface` token
  depending on `is_critical`. Omit if bar width < 32px.
- **Task name**: always rendered *outside* the bar — right of bar end with 4px gap,
  `text-xs font-mono text-semantic-text-secondary`, clipped to row width. Falls back
  to left-of-bar when bar is flush right.
- No change to bar fill tokens (already correct in ADR-0014).

### #210 — Task drawer

`TaskDetailDrawer.tsx` header section additions (rendered above the tab bar):

- **Owner row**: `task.assignee` display name + avatar initials chip. If the
  assignee's current `ProjectResource.units` across all active tasks exceeds 1.0,
  render a passive amber `⚠ over-allocated` pill — no navigation, tooltip only.
  Overalloc signal requires a read-only annotation on `TaskSerializer`:
  `assignee_is_overallocated: bool` (annotated in `TaskViewSet.get_queryset()` via
  a simple `Exists` subquery — see Implementation Notes).
- **Date row**: `early_start → early_finish` (working dates). If baseline exists,
  show `BL: baseline_start → baseline_finish` below in muted type. These fields are
  already in `TaskSerializer`.
- **Float row**: `total_float` displayed as "Nd float" (0d in red for critical tasks).
  Already in `TaskSerializer`.

History tab: already fetches `GET /tasks/{id}/history/` which returns
`HistoricalRecord` rows from django-simple-history. `assignee` and
`planned_start`/`actual_start`/`actual_finish` are all tracked fields (not in the
excluded list). No backend changes needed — the activity feed already contains
system events. Frontend: ensure the History tab renders change-type labels
("Assignee changed", "Start date moved") derived from `FieldDiffSerializer.field`.

### #213 — Unscheduled gutter

**What "unscheduled" means** *(refined by #317, 2026-05-04)*: a task appears in
the gutter only when **all** of these hold:

- `status === 'NOT_STARTED'` — the canonical "To Do" state
- no PM-committed start (`planned_start IS NULL`). We deliberately do **not**
  check `early_start`: CPM populates `early_start` for every task it
  processes, so as soon as a card is promoted out of BACKLOG it has a
  CPM-computed start even if the PM has never opened it. The gutter wants
  "the PM hasn't committed yet" semantics, not "no row exists in the
  scheduler"
- not a summary task
- not assigned to a sprint (`sprint IS NULL`) — sprint membership is itself a
  scheduling commitment

This deliberately **excludes**:

- `BACKLOG` ideas (live on the board until promoted to `NOT_STARTED`)
- `IN_PROGRESS` / `REVIEW` / `COMPLETE` tasks without dates — those are a data
  integrity bug, not "needs scheduling"; they render an inline `⚠ missing dates`
  chip on the task list row instead (`text-semantic-at-risk` per design rule 7)
- Sprint-committed `NOT_STARTED` tasks — the sprint is the container

**Promotion path BACKLOG → schedule**:

1. PM transitions a BACKLOG card to `NOT_STARTED` on the Board view.
2. Card now appears in the Unscheduled gutter on the Schedule view.
3. PM drags the card from the gutter onto the timeline to set dates (or uses the
   row overflow menu's "Set planned start" affordance).

A drag-direct-from-Board promotion gesture is a follow-up (separate 0.2 issue).

**Canvas layout**: the gutter is a separate DOM section (not on the canvas) rendered
below `CanvasScheduleTimeline`. It shares the same horizontal scroll container and
uses the same `GanttScaleData` instance for date-to-pixel conversion so the ruler
lines up.

**Drag-to-promote gesture**: gutter task rows use Pointer Events API. On
`pointerdown` + 4px move threshold (matching `GanttDragFSM` rule), a floating DOM
preview follows the pointer. On drop over the canvas area, `GanttScaleData.leftToDate()`
converts the drop X to a `DateString`. A `PATCH /tasks/{id}/` with
`{planned_start: date, status: "NOT_STARTED"}` is issued. The existing
`TaskViewSet.perform_update()` triggers `enqueue_recalculate()` via
`transaction.on_commit()`. No new endpoint needed.

**Cancel**: Esc or drop outside the canvas reverts the preview. The gutter row
returns to its resting state.

**New component**: `UnscheduledGutter.tsx` — driven by a `useUnscheduledTasks()`
selector that filters the existing TanStack Query task cache (no additional API
call). Renders a header strip ("X unscheduled") + scrollable task rows.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| % chip outside bar (right of bar end) | Always readable | Clutters label area; conflicts with task name |
| Render gutter on a 4th canvas layer | Fully consistent with canvas rendering | Cross-layer drag-from-DOM-to-canvas is harder; DOM approach already used for aria overlay |
| New `TaskActivityLog` model for activity feed | Dedicated event stream, extensible | Duplicates django-simple-history; adds migration; deferred to ADR-0011 |
| Fetch assignee overalloc via separate `/resources/utilization/` endpoint | Accurate | Extra round-trip per drawer open; annotation is O(1) added to existing queryset |

## Consequences

- Bar legibility improves immediately in light mode for all bar widths.
- `TaskDetailDrawer` header becomes the single place to see owner + float + dates
  without navigating to a dedicated resource or baseline view.
- Unscheduled tasks are no longer invisible — PMs can drag them onto the timeline
  without leaving the schedule view (Sarah's "parking lot" workflow).
- `TaskSerializer` gains one read-only annotation (`assignee_is_overallocated`).
  This is a non-breaking additive change.
- The gutter shares `GanttScaleData` state — both sections must scroll together
  horizontally. `CanvasScheduleTimeline` must expose its scaleData via context or
  prop drilling.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `api`, `web`
- Migration required: **no** (annotation computed at query time, no new fields)
- API changes: **yes** — `assignee_is_overallocated` added to `TaskSerializer`
  (read-only, backwards-compatible). No new endpoint: the field rides the existing
  `GET /api/v1/tasks/` and `GET /api/v1/tasks/{id}/` responses (TaskViewSet list /
  retrieve). Implemented at `serializers.py` (`assignee_is_overallocated =
  BooleanField(read_only=True)`) and annotated in `TaskViewSet.get_queryset()`
  (`views.py`, `Exists(overallocated_subq)`).
- OSS or Enterprise: **OSS** (trueppm-suite)

### `assignee_is_overallocated` annotation

```python
# In TaskViewSet.get_queryset(), add:
from django.db.models import OuterRef, Subquery, FloatField, functions
from trueppm_api.apps.resources.models import TaskResource

overallocated_subq = (
    TaskResource.objects
    .filter(
        resource__user=OuterRef("assignee"),
        task__project=OuterRef("project"),
        task__status__in=["NOT_STARTED", "IN_PROGRESS", "REVIEW"],
    )
    .values("resource__user")
    .annotate(total=models.Sum("units"))
    .filter(total__gt=1.0)
    .values("total")[:1]
)
queryset = queryset.annotate(
    assignee_is_overallocated=models.Exists(overallocated_subq)
)
```

### Durable Execution

1. **Broker-down behaviour**: drag-to-promote issues a `PATCH /tasks/{id}/` write.
   The existing `TaskViewSet.perform_update()` calls
   `enqueue_recalculate()` inside `transaction.on_commit()`, which uses the
   transactional outbox pattern. If the broker is down, the outbox drain
   re-dispatches within 30 s. No new durability gap introduced.
2. **Drain task**: N/A — reuses the existing `drain_schedule_requests` Beat task
   (semantics match: any pending ScheduleRequest row for the project).
3. **Orphan window**: N/A — reuses existing drain; orphan window already set to
   10 min in `drain_schedule_requests`.
4. **Service layer**: `enqueue_recalculate(project_id)` in
   `scheduling/services.py` — existing function, called from `TaskViewSet` on
   every task write.
5. **API response on best-effort dispatch**: The `PATCH /tasks/{id}/` returns 200
   with the updated task. The CPM recalculation is fire-and-forget from the
   client's perspective; no `202 queued` needed (consistent with all other task
   mutations).
6. **Outbox cleanup**: N/A — reuses existing 7-day purge for `ScheduleRequest`.
7. **Idempotency**: N/A — reuses existing idempotency on `ScheduleRequest`
   (deduplicated by `project_id` with `get_or_create`).
8. **Dead-letter / failure handling**: N/A — reuses existing `FailedTask`
   dead-letter table and alert threshold from ADR-0017.
