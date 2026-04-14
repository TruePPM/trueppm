# ADR-0028: Resource Assignment Write Flow

## Status
Proposed

## Context

Issue #97: TruePPM has a `TaskResource` model and `/api/v1/task-resources/` CRUD endpoint,
and ADR-0025 shipped read-only assignment display (assignee chips in the Gantt). But there
is no UI to create, update units on, or remove assignments. This blocks end-to-end testing
of the resource utilization view (issue #22) and is a table-stakes PM workflow (VoC panel
avg 7.0/10, David Resource Mgr 9/10).

**P3M Layer**: Programs and Projects — single-project task-resource assignment. OSS repo.

### VoC Panel Summary (avg 7.0/10)

- Sarah (PM) 8/10 — table-stakes, was working around the gap
- Marcus (PMO Director) 6/10 — needs this to feed the utilization view
- Priya (Team Member) 7/10 — passive benefit from correct allocation data
- David (Resource Manager) 9/10 — hero feature; top blocker: no over-allocation warning
- Janet (Executive Sponsor) 5/10 — cares only that it unblocks the utilization view

### Top VoC Blockers

1. **Units field ambiguity** — `DecimalField(1.0 = full-time)` vs. user expectation of
   integer percent. Wrong values silently corrupt the utilization view.
2. **No over-allocation guard at assignment time** — data can be stored incorrectly
   without warning. David and Marcus need at least a soft warning.

### Relevant prior ADRs

- ADR-0024: Summary task assignment guard already implemented in
  `TaskResourceViewSet.perform_create` (`resources/views.py` lines 55–78)
- ADR-0025: `TaskAssignmentSerializer` nested read-only on `TaskSerializer.assignments`
  already ships; `task.assignments` is available on the frontend `Task` type
- ADR-0027: `enqueue_recalculate` will gain `changed_task_ids` kwarg — resource
  assignments should pass the affected task ID to scope incremental CPM
- ADR-0017/0018: All async dispatch goes through `scheduling/services.py::enqueue_recalculate()`,
  never `.delay()` directly

## Decision

### 1. API Design — Use the existing `/api/v1/task-resources/` sub-resource

Keep `TaskSerializer.assignments` strictly read-only. Use the existing
`TaskResourceViewSet` for all writes:

```
POST   /api/v1/task-resources/          body: { task, resource, units }  → 201
PATCH  /api/v1/task-resources/{id}/     body: { units }                  → 200
DELETE /api/v1/task-resources/{id}/                                       → 204
GET    /api/v1/task-resources/?task={uuid}                               → 200 list
```

No router changes needed — the registration already exists (`resources/urls.py` line 11).

**Why not nested writes on `TaskSerializer`?**
- Making `assignments` writable requires replacing the read-only `TaskAssignmentSerializer`
  with a writable nested serializer plus `create()`/`update()` logic on `TaskSerializer`
  itself — surgery to a serializer loaded on every task list request.
- The summary-task guard (ADR-0024) already lives in `TaskResourceViewSet.perform_create`
  (`resources/views.py` lines 55–78). Moving writes into `TaskSerializer` would require
  duplicating or re-homing that guard.
- The frontend already patterns dedicated hooks per viewset (see `useCreateDependency` /
  `useDeleteDependency`). Assignment hooks follow the same pattern.

### 2. Scheduler Trigger — `transaction.on_commit` in `TaskResourceViewSet`

Add `transaction.on_commit` callbacks to `perform_create`, `perform_update`, and
`perform_destroy` on `TaskResourceViewSet`, following the identical pattern used in
`projects/views.py` (lines 352, 365, 378, etc.):

```python
from trueppm_api.apps.scheduling.services import enqueue_recalculate
from trueppm_api.apps.sync.broadcast import broadcast_board_event
from django.db import transaction

# In perform_create (after serializer.save(), inside the existing summary guard):
task = serializer.instance.task
project_id = str(task.project_id)
task_id = str(task.id)
transaction.on_commit(lambda: enqueue_recalculate(project_id, changed_task_ids=[task_id]))
transaction.on_commit(lambda: broadcast_board_event(project_id, "assignment_created", {"task_id": task_id}))

# perform_update and perform_destroy follow the same pattern.
# In perform_destroy, capture task_id before deletion.
```

**Why not signals?** ADR-0027 explicitly rejects signal-driven accumulation: "signals create
hidden coupling, and a missed signal silently degrades every downstream user's data." Signals
also fire from test fixtures, management commands, and import tasks that already call
`enqueue_recalculate` themselves — causing double-enqueues. The view-layer `on_commit` is
correct, auditable, and consistent with every other mutation in the codebase.

**`changed_task_ids` forward-compatibility:** Pass `changed_task_ids=[task_id]` to
`enqueue_recalculate`. Until ADR-0027 ships and the kwarg is implemented, add it as a
no-op keyword argument to the current `enqueue_recalculate` signature to avoid import
errors.

### 3. Units Field — Decimal model, integer percent UI

The model stores `units` as a decimal fraction (existing schema, no model change needed).
The API accepts and returns the same decimal. The UI presents and accepts integer percent
(1–200), converting on read (`× 100`) and write (`÷ 100`).

- Sarah types `50` (50%). Frontend sends `0.5`. She never sees `0.5`.
- David's tooltip shows `"50% max"` matching the UI entry. Correct.

**Valid range:** `0.01`–`2.00` on the model (permits planned overtime / over-assignment).
Add server-side validation to `TaskResourceSerializer`:

```python
def validate_units(self, value):
    if value <= 0:
        raise serializers.ValidationError("Units must be greater than 0.")
    if value > 2.0:
        raise serializers.ValidationError("Units cannot exceed 200% (2.0).")
    return value
```

**Over-allocation soft warning (VoC Blocker 2):** After a successful `POST`, return a
`warnings` array in the 201 response if the resource's total committed `units` across
non-complete tasks in the same project exceeds `resource.max_units`. The assignment is
saved regardless — this is informational only:

```json
{
  "id": "...",
  "task": "...",
  "resource": "...",
  "units": 0.5,
  "warnings": [
    {
      "code": "resource_overallocated",
      "detail": "Alice Chen is now at 120% allocation across active tasks."
    }
  ]
}
```

The aggregation (`SUM(units)` filtered to `task__status != 'complete'`) runs synchronously
in `perform_create` before returning 201. Index `TaskResource.resource` (see migration note)
to keep this fast. The frontend renders a dismissible amber toast on any `warnings` entry.

### 4. Resource Search — Use existing `GET /api/v1/resources/?search=`

`ResourceViewSet` already has `filter_backends = [SearchFilter, OrderingFilter]` and
`search_fields = ["name", "email"]` (`resources/views.py` lines 28–29). No new endpoint
is needed.

**Frontend picker:**
- Text input, debounced 200ms, minimum 1 character
- `GET /api/v1/resources/?search={query}&ordering=name`
- Render: `"{name}" ({max_units * 100}% max)` — surfaces the resource's availability cap
- On drawer open (no query yet): preload `GET /api/v1/resources/?ordering=name&limit=20`
  so the picker is immediately usable
- Resources already assigned to this task shown as disabled ("Already assigned"), filtered
  client-side from `task.assignments`

### 5. Concurrency — 409 on duplicate assignment; no `server_version` on `TaskResource`

**Duplicate assignment:** Catch `IntegrityError` from `unique_together` in `perform_create`
and return HTTP 409 Conflict (not 400 — the request is well-formed; the conflict is a
state-of-the-world issue). Add a minimal exception class:

```python
from rest_framework.exceptions import APIException

class Conflict(APIException):
    status_code = 409
    default_code = "conflict"
    default_detail = "A conflicting resource record already exists."
```

Frontend handles 409 with a toast: "Resource already assigned to this task."

**`server_version` on `TaskResource`:** Not needed. The only writable field on an existing
assignment is `units`. Simultaneous `units` PATCHes on the same assignment are extremely
unlikely and last-write-wins is acceptable — units changes do not cascade CPM effects the
way task date changes do. Adding `server_version` requires a migration, 8 bytes per row,
and client-side version tracking for marginal safety gain.

**PATCH/DELETE race:** A `PATCH` racing with a `DELETE` returns 404 from DRF's standard
`get_object()`. Frontend handles with a "not found" error toast and refreshes task state.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Nested writable `assignments` on `TaskSerializer` PATCH | One endpoint call per batch | Serializer surgery; summary guard duplication; flattened error surface; loads on every task list request |
| New sub-resource `/api/v1/tasks/{id}/assignments/` | RESTfully co-located with task | New router + view; `TaskResourceViewSet` already exists — redundant code |
| Use existing `TaskResourceViewSet` (chosen) | Zero new routes; guard already there; consistent with dependency hook pattern | Client must know task-resources URL — acceptable, same as how dependencies work |
| Signal-based scheduler trigger | No viewset changes | Violates ADR-0027 principle; double-enqueue risk from imports and management commands |
| Frontend explicit recalculate call | Gives user explicit control | Breaks automatic recalculation VoC requirement; gap if drawer is closed before recalculate |
| Integer percent in model | Matches user mental model | Breaking schema change; inconsistency with `Resource.max_units` decimal field |
| Dedicated autocomplete endpoint | Smaller payload, purpose-built | Redundant with existing `SearchFilter`; unnecessary for ≤1k resources |

## Consequences

### What becomes easier

- Resource assignment is writable from the task drawer with zero new backend routes
- Scheduler recalculates automatically on every assignment change, consistent with all
  other task and dependency mutations
- Over-allocation soft warning satisfies David's top VoC blocker without blocking the PM
- Units displayed as percent (1–200) resolves Sarah's mental model mismatch while keeping
  the decimal schema consistent with `Resource.max_units`
- ADR-0027 incremental CPM can scope recalculation to the affected task subgraph once
  that ADR ships — the `changed_task_ids=[task_id]` call is already wired

### What becomes harder

- `TaskResourceViewSet` now has recalculation + broadcast wiring that future mutation
  methods must not forget — same standing requirement as `projects/views.py`
- Frontend picker requires debounce, loading state, empty state, already-assigned guard,
  and units conversion — more complexity than a plain `<select>` (mitigated by following
  the `AddDepRow` pattern already in `TaskDetailDrawer.tsx`)

### Risks

- **Over-allocation warning query performance:** `SUM(units)` across a resource's active
  assignments runs synchronously in the 201 path. Mitigated by: filtering to
  `task__status != 'complete'` and adding `db_index=True` on `TaskResource.resource`.
- **`assignment_created` broadcast before CPM finishes:** Clients receiving
  `assignment_created` must refresh `task.assignments` but must not assume CPM output
  fields (`early_start`, `early_finish`, `is_critical`) are updated — those arrive via
  the existing `cpm_complete` broadcast. Document this contract in the hook.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS)
- **Affected packages**: `api` (resources/views.py, resources/serializers.py), `web`
  (new hooks, TaskDetailDrawer.tsx)
- **Migration required**: Yes — one migration: add `db_index=True` on `TaskResource.resource`
  FK. Currently unindexed; needed for the over-allocation warning aggregation. Additive,
  safe on live PostgreSQL.
- **API changes**: `TaskResourceViewSet` gains `perform_update`, `perform_destroy`,
  `enqueue_recalculate` + `broadcast_board_event` in all three mutating methods;
  `TaskResourceSerializer` gains `validate_units`; `perform_create` gains over-allocation
  warning logic and 409 conflict handling.
- **OSS or Enterprise**: OSS (trueppm-suite)

### Durable Execution Checklist

1. **Broker down at dispatch?** `transaction.on_commit(enqueue_recalculate(...))` writes
   the `ScheduleRequest` outbox row atomically before dispatch. Existing
   `drain_schedule_queue` Beat task picks it up within 30 seconds. No durability gap.
2. **Drain task needed?** No new drain task. Existing `drain_schedule_queue` handles
   assignment-triggered requests identically to task/dependency-triggered ones.
3. **Orphan window?** Unchanged — existing 10-minute filter on the drain task.
4. **Service layer?** Yes — `scheduling/services.py::enqueue_recalculate()`. Same import
   pattern as `projects/views.py` line 62. Never call `recalculate_schedule.delay()` directly.
5. **API response when broker is best-effort?** `POST`/`PATCH`/`DELETE` return synchronous
   201/200/204 with assignment data. CPM recalculation is async. No Celery `task_id` in
   the assignment response.
6. **Outbox cleanup?** Existing `purge_old_schedule_requests` nightly Beat task. No change.

### Implementation Sequence

1. `api`: `TaskResourceSerializer.validate_units` (range 0.01–2.00)
2. `api`: `db_index=True` on `TaskResource.resource` FK + migration
3. `api`: `Conflict` exception class; wrap `perform_create` in `try/except IntegrityError → 409`
4. `api`: Over-allocation warning aggregation in `perform_create`; add `warnings` to 201 response
5. `api`: `perform_update` + `perform_destroy` on `TaskResourceViewSet` with `enqueue_recalculate`
   + `broadcast_board_event`
6. `api`: Wire `enqueue_recalculate` + `broadcast_board_event` into the existing `perform_create`
   (after the summary guard, using `transaction.on_commit`)
7. `web`: `useTaskAssignments(taskId)` hook — `GET /api/v1/task-resources/?task={id}`
8. `web`: `useCreateAssignment`, `useUpdateAssignment`, `useDeleteAssignment` mutation hooks
9. `web`: `AssignmentsSection` component in `TaskDetailDrawer.tsx` (new `<section>` below
   Successors, following existing section pattern with `aria-label`, `h3` header tokens)
10. `web`: Resource picker sub-component with debounced search + preload-20 on open
11. `web`: Units input — `<input type="number" min="1" max="200">` with `%` suffix label;
    convert `÷100` on send, `×100` on receive
12. `web`: Over-allocation warning amber toast from `warnings` in 201 response
13. `tests` (api): `perform_create` — summary guard (400), duplicate (409),
    over-allocation warning present/absent, valid create + scheduler enqueued;
    `perform_update` — units validation, scheduler enqueued; `perform_destroy` — scheduler enqueued
14. `tests` (web): `AssignmentsSection` — renders existing assignments, add flow (happy path
    + 409 conflict toast + over-allocation toast), remove flow, units conversion (50 → 0.5 → 50),
    summary task (no section rendered)

### Related ADRs

- ADR-0024: Summary task guard on `TaskResourceViewSet.perform_create` (unchanged)
- ADR-0025: Read-only `assignments` nested field on `TaskSerializer` (unchanged)
- ADR-0027: Incremental CPM — `changed_task_ids=[task_id]` call already wired; becomes
  effective when that ADR ships
- ADR-0017: `recalculate_schedule` retry/time-limit policies apply unchanged
- ADR-0018: `recalculate_schedule` is `@idempotent_task(on_contention="queue")` — unchanged
