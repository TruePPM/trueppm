# ADR-0013: Board / Kanban View — Data Model, API, and Integration Design

## Status
Accepted with Amendment — BoardColumnConfig model and column management endpoints added (2026-04-13)

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
Schedule canvas (see `packages/web/CLAUDE.md` rule 29).

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

---

## Amendment — 2026-04-13 (Issue #21 reopen)

### Context

Two gaps surfaced in audit:

1. **Hard-coded columns.** The original decision said "server-defined and stable,
   not client-configurable in OSS." VoC panel reversed this: Sarah (PM) and Marcus
   (PMO) both want per-project column configuration (labels, order, WIP limits).
   Full custom status values are still out of scope — the four canonical
   `TaskStatus` values stay authoritative; config only decides **display**.
2. **Visiban bridge** — removed from scope. Deferred to a new enterprise-repo
   issue. A separate OSS issue is opened for Jira integration (higher persona
   priority per VoC).

### Decision

#### New app: `boards`

`packages/api/src/trueppm_api/apps/boards/`. Keeps `projects/models.py` from
growing further and prepares for board-level features (swimlanes, filters) without
polluting the core project entity.

#### New model

```python
# boards/models.py
class BoardColumnConfig(VersionedModel):
    project = OneToOneField(Project, CASCADE, related_name="board_config")
    columns = JSONField(default=_default_columns)
    # columns shape: [{"status": "NOT_STARTED", "label": "To do", "wip_limit": null}, ...]

def _default_columns():
    return [
        {"status": "NOT_STARTED", "label": "To do",       "wip_limit": None},
        {"status": "IN_PROGRESS", "label": "In progress", "wip_limit": None},
        {"status": "ON_HOLD",     "label": "On hold",     "wip_limit": None},
        {"status": "COMPLETE",    "label": "Complete",    "wip_limit": None},
    ]
```

Extends `VersionedModel` (synced to mobile so the board renders the same columns
offline). `project` is OneToOne — at most one config per project.

**Validation:**
- Every `status` in `columns` must be a valid `TaskStatus` choice
- No duplicate statuses
- `wip_limit` is null or a positive int
- At least one column with each of the four canonical statuses
  (prevents orphaning tasks whose status has no column)

#### New endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/projects/{id}/board-config/` | `IsProjectMember` |
| PUT | `/api/v1/projects/{id}/board-config/` | `IsProjectAdmin` |
| POST | `/api/v1/projects/{id}/board-config/reset/` | `IsProjectAdmin` |

PUT uses optimistic concurrency via `server_version` (per `VersionedModel` convention).
Conflict returns 409 with current config; client re-fetches and retries.

#### Frontend

- New section **Board** under `/projects/:id/settings` (NOT a hidden `/boards/config/`
  page — UX sign-off). See ux-design output for layout.
- `useBoardConfig(project_id)` TanStack Query hook; BoardView subscribes.
- On mutation, `broadcast_board_event(project_id, {type: "board_config_updated",
  config})` fires. Open BoardView tabs invalidate their config query.

#### Delete-blocked state

Deleting a column whose `status` has tasks returns 422 with `{detail: "Column has N
tasks. Move or complete them first."}`. UI surfaces this as a blocking modal with
deep-link to tasks filtered to that status.

#### Visiban removed from OSS

The original issue listed Visiban as an opt-in bridge. Deferred to
`trueppm-enterprise#<TBD>`. OSS has no Visiban dependencies, imports, or UI.

### Migration

- `boards/0001_initial.py` — creates `BoardColumnConfig` table
- `boards/0002_backfill_configs.py` — data migration: for every existing Project,
  create a config row with the default 4 columns. Idempotent (skips if exists).

Both migrations are additive. Must pass `migration-check`.

### No-regression surface

- `Task.status` field unchanged; still canonical
- `PATCH /tasks/{id}/` status update path unchanged
- @dnd-kit DnD, keyboard "Move to…" menu, aria-live announcements unchanged
- `task_updated` WebSocket event unchanged
- `task_status_changed` signal unchanged
- `SyncTaskSerializer.status` unchanged
- Existing BoardView falls back to default config when API returns 404 (new projects
  before their config row is created)

### Related

- New enterprise-repo issue: Visiban bridge (TBD)
- New OSS issue: Jira integration (VoC-driven — Marcus + Priya)
