# ADR-0055: Server-Side Cycle Detection on Dependency Create / Update

## Status
Accepted

## Context
The API today accepts any dependency create as long as predecessor and successor exist
and the user is a project member; cycles are only discovered later when
`recalculate_schedule` runs and raises `CyclicDependencyError`. The result is a vague
`CPM ⚠` chip in the toolbar with no banner, no recovery hint, and a schedule frozen at
its previous values. Users have no way to know that the last dependency they added is
the cause, which existing edges form the cycle they just closed, or that the recovery
action is to delete one of the edges in the cycle.

This ADR resolves the architecture for issue #356: validate cycles at create time,
return a structured 400, and surface a clear toast in the frontend with the cycle
nodes resolved to task names.

P3M layer: **Programs and Projects** (single-project dep graph). OSS.

## Decision

### 1. Cycle detection lives in the scheduler (single source of truth)

Extend `packages/scheduler/src/trueppm_scheduler/engine.py` with two new public helpers
and re-export them from `trueppm_scheduler/__init__.py`:

```python
def find_cycle(
    edges: list[tuple[str, str]],
    children_map: Mapping[str, list[str]] | None = None,
) -> list[str] | None:
    """Return cycle as ordered task IDs (with first repeated at end), or None.

    If children_map is provided, summary→leaf edges are expanded before detection
    so logical cycles through summary tasks are caught.
    """
```

The implementation reuses the existing private `_check_cycles` and
`expand_summary_dependencies` (currently at `engine.py:189` and `engine.py:380`); the
new `find_cycle` is a thin wrapper that returns the cycle list instead of raising.

The API imports it directly. Scheduler remains the single source of truth for graph
correctness — this ADR follows the "Django wraps the scheduler; scheduler never wraps
Django" rule.

**Rejected:** duplicating the algorithm in the API (drift risk, two places to fix the
next bug); hybrid where API does cheap checks and scheduler does big-graph checks
(splits ownership; same drift risk for marginal speedup that we don't measurably need
— see decision 8).

### 2. Hook point: `DependencySerializer.validate()`

Add cycle detection alongside the existing same-project check at `serializers.py:502`.
On cycle, raise:

```python
raise serializers.ValidationError(
    {"detail": "cyclic_dependency", "cycle": [...]},
    code="cyclic_dependency",
)
```

DRF's behavior: when `ValidationError(detail=)` receives a dict, that dict becomes the
400 response body verbatim. This produces exactly the spec'd shape without overriding
the viewset's `create()`. The serializer needs `project_id` to load existing edges; it
gets it from `self.context["request"]` (the viewset already passes request via
`get_serializer_context`).

**Rejected:** overriding `DependencyViewSet.perform_create` to catch a custom
exception. More code, no benefit — the serializer already validates same-project and
is the natural extension point.

### 3. Leaf-graph expansion semantics

Reuse `expand_summary_dependencies(tasks, deps, children_map)` (engine.py:380),
which already does:
- Cross-product expansion: a summary→leaf edge becomes N×M leaf-to-leaf edges
- Deduplication
- Self-loop drop (edges where `predecessor == successor` after expansion)

"Summary task" operationally = task that has children in `children_map`. The frontend
already uses `task.is_summary`; backend computation builds `children_map` from
`Task.objects.filter(parent_id__in=...)`. Both produce the same set.

The cycle-detection flow:
1. Load all existing `Dependency` rows for the project (single query, returns
   `(predecessor_id, successor_id)` tuples)
2. Append the proposed new edge
3. Build `children_map` from `Task.objects.filter(project_id=...).values('id', 'parent_id')`
4. Call `expand_summary_dependencies` to get the leaf graph
5. Call `find_cycle` on the leaf edges
6. If cycle returned, raise the 400 with the cycle (in task-ID space — but see decision 7
   for what gets returned)

### 4. Atomicity: no transaction needed

`serializer.validate()` runs before `serializer.save()`, so the row is never written
on a cycle. No `transaction.atomic()` block required; no rollback semantics to
maintain. This is materially cleaner than the perform_create approach.

### 5. Indent / outdent / reparent: N/A with justification

These endpoints only manipulate `parent_id` and WBS path; they do not create FS
dependencies. A reparent cannot create a finish-to-start cycle because no edge in the
`Dependency` table is added or modified. Reparent already has its own descendant-cycle
check at `views.py:1614` ("Cannot reparent under own descendant.").

The only path that could create an FS cycle is dependency create / update. Defense in
depth at the indent/outdent endpoints would be guarding against a class of bug that
the data model prohibits. Leave as documented N/A.

### 6. Frontend: extend existing inline error surface, don't build a new toast primitive

`TaskFormModal` already has `setSubmitError` rendered inline below the Save button.
For this issue we:
- Add `role="alert"` to the existing error container
- Render the cycle-resolved task names (decision 7 makes this a one-liner)
- Preserve `form.predecessors` on error (just don't reset on the catch path)

Building a global Toast primitive is justified for the next batch (#352 session-expired
banner has a similar need), but pulling it into this MR mixes two concerns. The
inline-error pattern is sufficient for the cycle case — the user is already inside the
modal that triggered the error, and the message renders inches from the action.

**Rejected:** new `<Toast>` primitive (scope creep into #352's natural territory).

### 7. Cycle path resolution: API returns rich objects

Return:

```json
{
  "detail": "cyclic_dependency",
  "cycle": [
    {"id": "uuid-1", "name": "Find 3 suppliers", "hex_id": "a1b2c3"},
    {"id": "uuid-2", "name": "Validate", "hex_id": "d4e5f6"},
    {"id": "uuid-1", "name": "Find 3 suppliers", "hex_id": "a1b2c3"}
  ]
}
```

The issue's "list of task IDs" phrasing is shorthand for the algorithm output; the
toast UX requirement explicitly needs names ("show task NAMES not UUIDs"). Returning
rich objects:
- Avoids a frontend race where the user just created the cycle so the task isn't in
  cache yet
- Saves a roundtrip
- Aligns with the principle that errors should be self-contained

The first/last node is repeated to make the cycle path unambiguous when rendered:
`A → B → A`. The frontend renders `cycle.map(n => n.name).join(' → ')` and applies
the `>4 nodes ⇒ truncate middle with …` rule from the issue.

### 8. Performance: always run, no gating

`networkx.find_cycle` is O(V+E). For a 5,000-task / 8,000-edge project that's ~13K
operations — sub-millisecond on modern Python. Loading the dep list is one `values_list`
query (<50 ms for 8K rows). Total budget on a worst-case-realistic project: <100 ms
synchronously per dep create. Well within an acceptable interactive write latency.

No per-project gating, no graph caching. Always run.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Duplicate cycle algorithm in API | No scheduler import at create time | Drift risk; two places to maintain; loses single-source-of-truth |
| Override viewset.create() | More control over response shape | Unnecessary — DRF already supports dict-shaped ValidationError |
| Build reusable Toast primitive | Sets up #352 banner | Scope creep; extends review surface; we have a working inline-error path |
| Return cycle as bare UUID list | Matches issue's literal phrasing | Frontend race condition for newly-created tasks; extra roundtrip; loses hex_id |
| Gate cycle check on project size | Saves microseconds | Hides perf cost behind conditional we have to maintain; never measurably needed |

## Consequences

### Easier
- Users get a clear, actionable error at create time instead of a silent CPM freeze
- Future "why did the schedule break?" investigations have one fewer plausible cause
- The scheduler exposes a public `find_cycle` that other call sites can reuse (e.g.
  the frontend later if we add client-side preflight)

### Harder
- The dep create response shape now varies between standard DRF validation errors
  (`{"non_field_errors": [...]}`) and our structured cycle error (`{"detail":
  "cyclic_dependency", "cycle": [...]}`). Frontend must handle both. We add a small
  parser in `useTaskMutations.ts`.
- `DependencySerializer.validate` now does a DB round-trip per create. Acceptable per
  decision 8, but worth noting on perf review.

### Risks
- **Children_map staleness:** if a task's `parent_id` changes between when we load
  the children map and when the create commits, we could miss a logical cycle. This
  is a TOCTOU window of microseconds in the same request; the `unique_dependency`
  unique constraint catches the worst case (duplicate edge) at the DB level. Document
  as accepted risk; revisit if reports surface.
- **Bulk dep import (e.g. MS Project):** the import path may build edges in a loop
  without re-running cycle detection per edge. Out of scope for this ADR; file as
  follow-up if MS Project import allows cycles to enter the DB.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project dep graph). OSS.
- **Affected packages**: scheduler, api, web
- **Migration required**: no
- **API changes**: yes — `POST /dependencies/` and `PATCH /dependencies/{id}/` may
  now return 400 with `{"detail": "cyclic_dependency", "cycle": [{id, name, hex_id}, …]}`.
  Update `docs/api/openapi.json` and `docs/api/dependencies.md` (or equivalent).
- **OSS or Enterprise**: OSS

### Implementation order

1. **Scheduler**: add `find_cycle()` public wrapper; export from `__init__.py`. Add
   tests for: 2-cycle, 3-cycle, self-loop, no-false-positive long chain, no-false-
   positive diamond, cycle through summary expansion. (Most exist already at
   `tests/test_engine.py:329/347/487`; verify and fill gaps.)
2. **API**: extend `DependencySerializer.validate()` to load existing edges + new
   edge, call `find_cycle`, raise structured `ValidationError`. Add 8 pytest cases
   (per issue AC). Verify response shape matches spec.
3. **Frontend**: parse 400 response in `useAddDependency.onError` /
   `useRemoveDependency.onError` (no `useUpdateDependency` exists per explore — drop
   from issue AC). Update `TaskFormModal` error display: `role="alert"`,
   cycle-name string, no form-state reset on error path. Vitest coverage:
   - `useTaskMutations.test.ts`: hook surfaces structured cycle error to caller
   - `TaskFormModal` integration: cycle 400 → alert toast with names
   - `TaskFormModal` integration: form predecessors preserved after error
4. **Playwright**: `e2e/dependency-cycle.spec.ts`. Mock `POST /dependencies/` to
   return 400 + cycle payload. Open task drawer, attempt to add cycling predecessor,
   assert toast text + role=alert. Reload, assert no new dep persisted.
5. **Docs**: `docs/api/` update for the new error shape; `docs/features/` callout if
   user-facing docs already cover dep editing.
6. **Changelog**: `changelog.d/356.fixed.md`.

### Test layering (confirmation)

| Layer | File | Coverage |
|-------|------|----------|
| Scheduler unit | `packages/scheduler/tests/test_engine.py` | `find_cycle` + summary expansion |
| API pytest | `packages/api/tests/projects/test_dependencies.py` | 8 cases per issue AC |
| Web vitest | `packages/web/src/hooks/useTaskMutations.test.ts`, `TaskFormModal/*.test.tsx` | 3 cases per issue AC |
| E2E Playwright | `packages/web/e2e/dependency-cycle.spec.ts` | golden path + a11y |

### Durable Execution

1. **Broker-down behaviour:** N/A — this is a synchronous validation in the API
   request/response path. No async dispatch is added by this change. (Existing
   `_enqueue_recalculate` on successful create is untouched and continues to use the
   established outbox pattern.)
2. **Drain task:** N/A — no new async work introduced.
3. **Orphan window:** N/A — no outbox rows written by this validation.
4. **Service layer:** N/A for the validation itself. Existing
   `scheduling/services.py::enqueue_recalculate` is unchanged and still gates
   downstream CPM.
5. **API response on best-effort dispatch:** N/A — synchronous 400 on cycle, 201 on
   success (unchanged). Recalc enqueue is unchanged.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** Validation is pure — same input always produces same accept/reject
   decision. The DB write is gated by the existing `unique_dependency` unique
   constraint, so a double-submit produces 400 (constraint violation) on the second
   attempt rather than a duplicate row.
8. **Dead-letter / failure handling:** N/A — synchronous validation has no retry
   semantics. A 400 is returned to the caller and the user can adjust and retry.
