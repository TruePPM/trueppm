# ADR-0060: Subtasks on Tasks (#308)

## Status
Proposed

## Context

Issue #308 adds one level of hierarchical child tasks ("subtasks") beneath any task.
Requirements (resolved in VoC/design phase, VoC avg 5.5/10 overall, 6.3/10 OSS personas,
no 🔴 blockers):

- Subtasks inherit the parent's project/board context
- Independently assignable; own status, planned_start, effort estimate
- Rollup: parent progress = weighted average of subtask progress (existing `get_percent_complete()`)
- CPM participants: parent.finish = max(subtask.finish); parent.start = min(subtask.start);
  dependencies on the parent node fan out to subtask leaves
- Depth limit: one level only — a subtask cannot itself have subtasks
- UI: inline creation in task drawer, subtask list section, progress indicators
- Assigned subtasks surface in "My Tasks" without extra navigation
- Subtasks added to in-sprint tasks generate a scope-change audit event (Alex/Scrum concern)
- All subtask data must be derivable from the REST API alone — no client-side reconstruction
  from ltree path math or history table joins (required for mobile, Mac, and Windows parity)
- Gantt: subtasks hidden by default; parent renders as summary bar; expand toggle shows them

The issue title referred to a "self-referential Task FK." This ADR supersedes that framing.

**Existing hierarchy mechanism**: `wbs_path` (PostgreSQL ltree). `parent_id` and `is_summary`
are RawSQL annotations computed at query time from ltree — no stored FK exists (ADR-0024).
The web frontend already types `parentId: string | null` and `isSummary: boolean` from these
annotations.

**Critical constraint from ADR-0024**: `parent_id` and `is_summary` are annotation-only.
Adding a stored `parent_id` FK alongside `wbs_path` would create two authoritative hierarchy
sources that must be kept in sync — a direct violation of ADR-0024's single-source-of-truth.

## Decision

**Extend the existing ltree/WBS mechanism. Do not add a self-referential FK.**

Subtasks are WBS leaf nodes created as ltree children of their parent via the existing
`TaskViewSet.create()` path (which already accepts `parent_id` and auto-assigns `wbs_path`).
The parent task's `is_summary` annotation becomes `True` automatically once it has children —
no new stored field is needed for that.

**Add one stored field**: `is_subtask: BooleanField(default=False, db_index=True)`. This
field is the semantic discriminator between WBS phase/milestone children (created via the
Gantt indent/reparent UX, `is_subtask=False`) and drawer-created decomposition children
(`is_subtask=True`). It also serves as the depth-1 enforcement gate: the subtask creation
endpoint rejects requests where `parent.is_subtask == True`.

**Why `is_subtask` is needed despite ltree encoding the relationship**: A task at WBS depth 2
(child of a phase) has a `parent_id` annotation pointing at the phase. Without a stored
discriminator, there is no way to distinguish "may this task receive drawer-subtasks?" from
"this task is already a WBS child." The `is_subtask` boolean resolves this ambiguity with
a single migration.

### CPM participation

Parent tasks with subtasks become CPM summary nodes. The existing
`expand_summary_dependencies()` fans out the parent's dependency edges to leaf children before
the forward/backward pass; the existing `_collect_leaves()` excludes summary nodes from the
pass. No changes to the scheduler engine or the `children_map` build (which is already
constructed from `wbs_path` at dispatch time in `scheduling/tasks.py`).

The `is_subtask` field must be added to the Python scheduler `Task` dataclass and Rust serde
structs (ADR-0015 conformance requirement) for any future WASM parity, even if the field is
not used in the CPM algorithm itself.

### Depth-1 enforcement

At the `TaskViewSet.create()` layer: when `is_subtask=True` is included in the request body
(or a dedicated `POST /tasks/{id}/subtasks/` action is used), validate `parent.is_subtask == False`.
Return 400 with `"detail": "Subtasks cannot have subtasks"` on violation. No DB-level CHECK
constraint — the application layer validation is sufficient and avoids schema complexity.

### Broadcast strategy

On subtask create:
1. Fire `task_created` for the new subtask (standard path, already in `TaskViewSet`).
2. Explicitly bump parent `server_version` via
   `Task.objects.filter(pk=parent_id).update(server_version=F("server_version") + 1)`
   and fire `task_updated` for the parent, so sync clients detect the parent's new
   `is_summary=True` state without a full recompute poll.

This produces two broadcast events per subtask create — accepted; avoids a full page reload
on the parent.

### Sprint scope-change audit

When a subtask is added to a task that belongs to a sprint (`task.sprint_id is not None`),
write a `SprintScopeChange` row atomically with the subtask creation. This is a new OSS
model (one migration, four columns: `task_id`, `sprint_id`, `subtask_name` denormalized,
`added_by_id`, `added_at`). Rows are soft-displayed until the sprint closes or the subtask
is removed.

Rationale for a dedicated model over `django-simple-history` query: the history approach
requires a fragile join on history timestamps vs. sprint start date, scans unbounded history
rows, and breaks if the exclusion list changes. The dedicated model is written once, read
with a single prefetch, and is stable across all client platforms (web, mobile, Mac, Windows)
that consume the REST API.

A `subtask_sprint_scope_changed` Django signal is still fired (OSS) so the enterprise audit
receiver can capture the event without touching the OSS model. The `SprintScopeChange` model
is the canonical source for scope-change display; the signal is the enterprise extension point.

`sprint_scope_changes: [{subtask_name, added_by_name, added_at}]` is included as a
prefetched field on `TaskSerializer` — no extra round-trip for any client on drawer open.

### Gantt visibility

Subtasks (`is_subtask=True`) are excluded from the initial Gantt row list. The parent summary
bar gains an expand toggle (count badge: "3 subtasks"). Expanding inlines the subtask bars
as indented leaf rows beneath the parent. The existing `wbsStore.ts` expand/collapse state
is extended with a `subtaskExpanded: Set<string>` map.

### My Tasks

`ProjectMyTasksView` filters `Task.objects.filter(assignee_id=request.user.pk)` — subtasks
appear here by default since they carry an `assignee` FK. No view change needed. Frontend
should render subtasks with a parent-task label so context is clear.

### Board visibility

`is_subtask=True` tasks appear in board columns by default (they have status, assignee, sprint).
A "Hide subtasks" filter toggle is added to the board filter bar (same pattern as the existing
sprint toggle) so teams can declutter. Default is show, not hide — avoids hiding committed work.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Stored self-referential FK (original issue framing) | Explicit, queryable, familiar | Duplicates `wbs_path`; naming conflict with existing `parent_id` annotation; two hierarchy sources violates ADR-0024 |
| ltree-only, no new field | No migration beyond existing | Cannot distinguish WBS phase-children from subtask-children; depth-1 enforcement requires fragile path-depth arithmetic on arbitrary WBS structures |
| ltree + `is_subtask` boolean (chosen) | Single hierarchy source; clean discriminator; one-column migration | Must be set correctly on creation; still requires WBS path rewrite on subtask create (same as indent) |
| Separate `SubTask` model | Clean semantic isolation | All existing relations (Dependency, TaskResource, History, Sprint) would need duplication; CPM engine would need a second task type |

## Consequences

**Easier**:
- CPM, Gantt, progress rollup, `server_version` sync all work without engine changes
- `get_percent_complete()`, `is_summary`, `parent_id` annotations work immediately for subtask parents
- `django-simple-history` tracks subtask mutations automatically (no exclusion list changes needed)

**Harder**:
- Gantt expand/collapse for subtasks needs new `wbsStore` state and renderer support
- Board needs a "Hide subtasks" toggle
- `is_subtask` must be correctly set on creation — the `TaskIndentView` and `TaskOutdentView`
  paths must NOT set `is_subtask=True` (they manage WBS structure, not drawer subtasks)
- `SyncTaskSerializer` must include `is_subtask` for future mobile sync correctness (mobile
  package does not exist yet, but the field must be in the sync output from day one)

**Risks**:
- A task that is both a WBS phase child AND has drawer-subtasks will have `is_subtask=False`
  but be a summary task. The parent-of-parent depth in the WBS can be arbitrary. This is
  intentional and handled cleanly by `is_subtask` as the discriminator.
- Soft-delete cascade: `Task.soft_delete()` currently cascades only to `Dependency` edges.
  Soft-deleting a parent task must also cascade to `is_subtask=True` children. Update
  `soft_delete()` to add: `Task.objects.filter(parent_id_annotation=self.pk, is_subtask=True)`
  — or more precisely, use ltree: `Task.objects.filter(wbs_path__descendant=self.wbs_path, is_subtask=True).soft_delete()`.
- `TaskBulkSerializer` and `TaskReorderView` do not currently set `is_subtask`. Bulk
  operations on subtask rows must preserve the existing `is_subtask` value.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **OSS or Enterprise**: OSS (`trueppm-suite`)
- **Affected packages**: `api`, `web`
- **Migration required**: Yes — `0032_task_is_subtask_and_sprint_scope_change.py`:
  1. `ALTER TABLE projects_task ADD COLUMN is_subtask BOOLEAN NOT NULL DEFAULT FALSE` (`db_index=True`)
  2. Create `projects_sprintscopechange`: `id` UUID PK, `task_id` FK→Task (CASCADE),
     `sprint_id` FK→Sprint (CASCADE), `subtask_name` CharField(512), `added_by_id`
     FK→User (SET_NULL, nullable), `added_at` DateTimeField(auto_now_add=True)
- **API changes**:
  - `TaskSerializer`: add `is_subtask` (writable on create, read-only after; default False)
  - `TaskViewSet.create()`: when `is_subtask=True`, validate `parent.is_subtask == False`
    and that `parent_id` is present; set `wbs_path` as child of parent via existing logic
  - `TaskViewSet` new action or filter: `GET /tasks/?parent=<uuid>&is_subtask=true` for
    listing a task's subtasks (board and drawer use this)
  - On subtask create: bump parent `server_version`, fire `task_updated` for parent
  - `SyncTaskSerializer`: add `is_subtask` field
  - Scheduler input: add `is_subtask` to `trueppm_scheduler.models.Task` dataclass and
    Rust conformance structs (ADR-0015); field is informational for now, not used in CPM
- **Test layers required**:
  - pytest: subtask create/delete/cascade, depth-1 enforcement (400 on subtask-of-subtask),
    parent `server_version` bump, CPM recalculation triggered, sprint scope signal fires
  - vitest: drawer subtask section rendering, My Tasks includes subtask, progress rollup display
  - Playwright E2E: create subtask from drawer, complete subtask updates parent progress,
    attempt subtask-of-subtask is rejected

### Durable Execution

1. **Broker-down behaviour**: subtask create/delete mutations call
   `enqueue_recalculate(project_id, changed_task_ids={parent_id, subtask_id})` via the
   existing `ScheduleRequest` outbox. If the broker is down at dispatch, the outbox drain
   re-dispatches on next tick — no durability gap.
2. **Drain task**: reuses the existing `scheduling/tasks.py` `recalculate_schedule` drain.
   No new drain needed; subtask mutations produce a `ScheduleRequest` row like any task mutation.
3. **Orphan window**: existing 10-minute orphan filter on `ScheduleRequest` applies unchanged.
4. **Service layer**: call `scheduling/services.py::enqueue_recalculate()` from subtask
   create/delete views. Never call `recalculate_schedule.delay()` directly (ADR-0027).
5. **API response on best-effort dispatch**: subtask creation returns 201 synchronously.
   CPM recompute is async; no `{"queued": true}` response needed at the creation endpoint
   since clients receive the CPM result via the existing `schedule_complete` WebSocket event.
6. **Outbox cleanup**: existing 7-day retention / nightly purge on `ScheduleRequest` applies.
7. **Idempotency**: subtask creation is safe to retry — the `(project, wbs_path)` uniqueness
   on Task means a duplicate create returns 400 or the existing row. The `enqueue_recalculate`
   drain coalesces multiple `ScheduleRequest` rows for the same project (ADR-0027).
8. **Dead-letter / failure handling**: existing `FailedTask` dead-letter path in
   `scheduling/tasks.py` applies. No new DLQ path. If CPM recompute fails permanently,
   the existing `task_dead_lettered` broadcast fires on the `system` channel.
