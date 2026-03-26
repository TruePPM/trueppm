# ADR-0013: Board / Kanban View — Data Model, API, and Integration Design

## Status
Proposed

## Context

Issue #21 adds a Kanban board tab to the project workspace. Columns represent task
workflow state (Not Started / In Progress / On Hold / Complete). Dragging a card
between columns updates the task's status and triggers CPM recalculation.

**P3M layer**: Programs and Projects — single project scope. The program/portfolio
variant (swimlanes per project within a program) is out of scope for OSS and is
tracked in `trueppm-enterprise#41`.

**VoC**: Avg 5.6/10 overall; 9/10 for Priya (Team Member) and 8/10 for Sarah (PM)
— the two personas who update task status daily. Key blockers: schedule write-back
on drag, and assignee filter as the default view.

**Blocker discovered in analysis**: `Task` has no `status` field. The board columns
require adding one. `percent_complete` (0.0–1.0) already exists but is independent —
a task can be 60% complete and still be On Hold. The two fields are not redundant.

## Decision

### Data Model

Add `status` to the `Task` model:

```python
class TaskStatus(models.TextChoices):
    NOT_STARTED = "NOT_STARTED", "Not started"
    IN_PROGRESS  = "IN_PROGRESS",  "In progress"
    ON_HOLD      = "ON_HOLD",      "On hold"
    COMPLETE     = "COMPLETE",     "Complete"
```

```python
# On Task model
status = models.CharField(
    max_length=12,
    choices=TaskStatus.choices,
    default=TaskStatus.NOT_STARTED,
    db_index=True,
)
```

**`status` and `percent_complete` are independent.** A PM can mark a task On Hold at
40% complete, or mark it Complete while keeping `percent_complete` at 0.8 if they
choose to track it that way. The scheduler does not derive status from
`percent_complete` (or vice versa). This is an explicit product decision: do not
auto-sync the two fields — that would silently override PM intent.

**No status → CPM coupling in v1.** The CPM engine currently ignores `status` and
drives the schedule from `duration`, `dependencies`, and `early_start`. Completed
tasks do not get special CPM treatment in v1; the PM manages `percent_complete`
separately. This can be revisited when actual-vs-planned tracking is designed.

**Indexes**: `(project_id, status)` for the board column query pattern. A
`(project_id, assignee_id, status)` partial index is deferred until the "My tasks"
filter query volume justifies it.

**Migration**: one non-destructive `ALTER TABLE` — adding a nullable-then-default
column. Safe on live PostgreSQL without lock (Django handles this via separate
`ALTER COLUMN SET DEFAULT` + `UPDATE` steps on the `RunSQL`-free migration path).

### API

No new endpoint. The board reuses the existing task list and task update endpoints:

| Action | Endpoint | Notes |
|---|---|---|
| Load board | `GET /api/v1/projects/{pk}/tasks/?is_deleted=false` | Returns all tasks; frontend groups into columns client-side |
| Drag card | `PATCH /api/v1/projects/{pk}/tasks/{id}/` `{"status": "IN_PROGRESS"}` | Triggers CPM recalculation via existing `perform_update` path |
| Filter by assignee | `GET /tasks/?assignee={user_id}` | `assignee` filter already exists on `TaskViewSet` |

**No server-side column grouping endpoint.** Grouping 4 columns from ≤500 tasks
client-side is trivially cheap. A `/board/` endpoint would duplicate the task list
with worse cache semantics and more surface area to maintain.

**Rationale for no new endpoint**: `TaskViewSet` already does pagination, search,
ordering, assignee filter, and soft-delete exclusion. Adding a board-specific
endpoint would create two representations of the same data, diverge over time, and
require a second set of permission tests. The existing endpoint is sufficient.

### Column Order

Server-defined and stable. The canonical order is:

```
NOT_STARTED → IN_PROGRESS → ON_HOLD → COMPLETE
```

Defined as a constant in `TaskStatus` (Python `TextChoices` ordering is insertion
order). The frontend renders columns in this order — no client-configurable column
reordering in OSS. User-configurable columns are an Enterprise concern.

### CPM Recalculation

`PATCH /tasks/{id}/` with `status` in the payload triggers the existing
`recalculate_schedule.delay(project_id)` path in `TaskViewSet.perform_update`.
No special handling required. The board drag is exactly equivalent to an inline
edit in the task list — same PATCH, same Celery task, same `cpm_complete` WebSocket
event.

**Debounce**: if a user drags a card rapidly between columns (unlikely but possible),
each intermediate PATCH queues a recalculation. The Celery task is idempotent
(last writer wins on CPM fields). For v1 this is acceptable. A drag-end
debounce on the frontend (fire PATCH only on pointerup, not on every enter/leave)
prevents the pathological case.

### Real-Time Updates

Reuse `task_updated` WebSocket event (already emitted by `TaskViewSet.perform_update`
on every PATCH). The board subscribes to the project room and moves cards on
`task_updated` events — no new event type needed.

The `cpm_complete` event triggers a card re-sort within columns if ordering by
`early_start` or `total_float` is enabled (post-v1 enhancement). In v1 the board
does not re-sort on CPM completion.

### OSS Extension Point

A `task_status_changed` Django signal, parallel to `risk_changed`:

```python
# projects/signals.py (add alongside risk_changed)
task_status_changed = django.dispatch.Signal()
# Payload kwargs: task (Task instance), old_status (str), new_status (str)
# Emitted only when status field changes.
```

Enterprise attaches a receiver for portfolio event streams (e.g., updating a
program-level "cards moved this week" metric) without modifying OSS code.

**Guard**: emit only when `status` is in `update_fields` (or on full save where
`status` actually changed). Compare old/new values to avoid redundant signals on
unrelated `PATCH`es.

### Offline Behaviour

**Online-only in v1.** The drag interaction is inherently a real-time gesture — it
fires a PATCH immediately on `pointerup`. No offline queue for board drags.

The mobile sync pull already includes task `status` in `SyncTaskSerializer`
(it will be added when the field lands). Offline users reading the board see the
last-synced state. Write operations (drag) require connectivity and fail gracefully
with a toast: "You're offline — move not saved."

This is consistent with the drag-preview offline guard already implemented for the
Gantt canvas (see `packages/web/CLAUDE.md` rule 29).

### Overallocation Indicator

Deferred to after issue #22 (Resource view) ships the utilization API. The card
will have a slot for an overallocation dot (David's 5/10 item), but it renders empty
in v1. The API contract (`GET /projects/{pk}/resources/utilization/`) is defined by
#22; the board will consume it once it exists.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Derive status from `percent_complete` (0→NOT_STARTED, 0<x<1→IN_PROGRESS, 1→COMPLETE) | No migration | Loses ON_HOLD state; overwrites PM intent; no way to express "done but not 100%" |
| New `/board/` endpoint with server-side column grouping | Slightly less client work | Duplicates task list; two permission surfaces; diverges over time |
| User-configurable columns | Flexible | Needs a new config model and migration; Enterprise concern |
| Debounce PATCH during drag (fire only on column-enter, not pointerup) | Fewer round trips | Complex to implement; intermediate states get lost |
| `task_status_changed` as a new WebSocket event instead of signal | Simpler for Enterprise consumers | Breaks API-first; WebSocket is a delivery mechanism, not an extension point |

## Consequences

**Positive:**
- `Task.status` unblocks the board and is immediately useful in the task list view
  (sortable, filterable status column — a common request).
- No new API surface → no new RBAC surface → no new security review scope.
- Board drag reuses the full existing mutation stack (validation, history, broadcast,
  CPM) for free.
- `task_status_changed` signal is ready for Enterprise without future OSS change.

**Negative:**
- Migration required. Non-destructive but it is a schema change that must be
  coordinated with the mobile schema version.
- `status` and `percent_complete` being independent requires user education —
  "why are there two completion indicators?" The UI must make the distinction clear.
- WatermelonDB mobile schema needs `status` column added (`sync/serializers.py`
  `SyncTaskSerializer` must include `status`).

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `packages/api` (model + migration + signal), `packages/web`
  (new `features/board/` directory)
- **Migration required**: yes — `projects.0011_task_status` (non-destructive)
- **API changes**: `status` field added to `TaskSerializer` (writable); `status`
  filter added to `TaskViewSet`; `SyncTaskSerializer` updated to include `status`
- **OSS or Enterprise**: OSS (`trueppm-suite`)

**New files:**
- `packages/api/src/trueppm_api/apps/projects/migrations/0011_task_status.py`
- `packages/web/src/features/board/BoardView.tsx`
- `packages/web/src/features/board/BoardColumn.tsx`
- `packages/web/src/features/board/BoardCard.tsx`
- `packages/web/src/hooks/useBoard.ts`

**Modified files:**
- `packages/api/src/trueppm_api/apps/projects/models.py` — add `TaskStatus`, `Task.status`
- `packages/api/src/trueppm_api/apps/projects/serializers.py` — add `status` to `TaskSerializer`
- `packages/api/src/trueppm_api/apps/projects/views.py` — add `status` to filter fields; emit signal
- `packages/api/src/trueppm_api/apps/projects/signals.py` — add `task_status_changed`
- `packages/api/src/trueppm_api/apps/sync/serializers.py` — add `status` to `SyncTaskSerializer`
- `packages/web/src/router.tsx` — add `/board` route
- `packages/web/src/features/shell/ViewTabs.tsx` — activate Board tab
- `packages/web/src/features/shell/BottomNav.tsx` — activate Board tab

**Related ADRs:**
- ADR-0001: WBS Tree, Task List, and Calendar View Architecture
- ADR-0002: UI Harmonization (ViewTabs / BottomNav patterns)
- `trueppm-enterprise#41`: Program/portfolio Kanban (swimlanes per project)
