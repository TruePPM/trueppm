# ADR-0025: Gantt Resource Assignment Display

## Status
Proposed

## Context

The `TaskResource` model and `/task-resources/` CRUD endpoint exist, but the Gantt
view has no visibility into resource assignments. Users cannot see who is assigned
to a task without navigating to a separate resource view. This is a basic expectation
for any PM switching from MS Project or Primavera (VoC: Sarah 8/10).

The feature is read-only display — no assignment editing from the Gantt. Chips show
assignee initials in the task list row; the canvas bar optionally shows the first
assignee's initials when the bar is wide enough (>= 48px).

### P3M Layer
Programs and Projects — single-project task-resource visibility. OSS repo.

### VoC Panel Summary (avg 6.2/10)
- Sarah (PM) 8/10 — daily need, MS Project table-stakes
- Marcus (PMO) 6/10 — building block for cross-project resource view
- Priya (Team) 7/10 — passive benefit in standups
- David (Resource Mgr) 7/10 — wants units tooltip, sees it as foundation
- Janet (COO) 3/10 — wrong layer for her

### Key Constraints from VoC
1. Units/allocation tooltip on hover (David's top ask)
2. Full name in aria-label (accessibility + PDF export)
3. Chips are read-only — no filter interaction yet
4. Canvas bar label conditional on bar width >= 48px
5. Data must support cross-project aggregation later (Marcus)

## Decision

### 1. API: Nested `assignments` Field on TaskSerializer

Add a read-only nested field to `TaskSerializer`:

```python
assignments = TaskAssignmentSerializer(source="assignments", many=True, read_only=True)
```

Where `TaskAssignmentSerializer` returns:
```json
{
  "resource_id": "uuid",
  "resource_name": "Alice Chen",
  "units": 0.6
}
```

**Why nested on TaskSerializer, not a separate fetch**: The Gantt loads all tasks for
a project in one paginated call. Adding assignments inline avoids N+1 separate calls
to `/task-resources/`. The data is small (typically 1-3 assignments per task).

**Prefetch**: `TaskViewSet.get_queryset()` adds
`prefetch_related("assignments__resource")` to avoid N+1 queries on the nested
serializer.

### 2. Frontend: Task Type and Hook Changes

Add to `ApiTask`:
```typescript
assignments: Array<{
  resource_id: string;
  resource_name: string;
  units: number;
}>;
```

Add to `Task` type:
```typescript
assignees: Array<{
  resourceId: string;
  name: string;
  units: number;
}>;
```

`mapTask()` maps snake_case API → camelCase frontend type.

### 3. TaskListRow: Assignee Chips

- Render up to 2 circular initials chips (16px diameter) to the right of the task name
- Chips: `bg-brand-primary/20 text-gantt-text-primary rounded-full text-[10px]`
  — exception to rule 50 (text-[10px] prohibition): these are decorative labels inside
  a 16px circle, not body text. The full name is in the `aria-label`.
- Overflow: `+N` chip in same style when > 2 assignees
- Tooltip on hover: `"{Full Name} ({units * 100}%)"` (VoC: David's top ask)
- `aria-label="{name} assigned"` on each chip
- Summary tasks: no chips (assignments are on leaf tasks)
- Unassigned tasks: no chips, no placeholder

### 4. Canvas Bar: Assignee Initials Label

- When bar pixel width >= 48px and task has >= 1 assignment:
  show first assignee's initials right-aligned inside the bar
- Uses `gantt-text-primary` (#E8E8E8) at 10px font size
- Right-aligned with 4px padding from bar right edge
- Clipped to bar bounds (no overflow)
- Not rendered on summary bars or milestone diamonds

### 5. No Migration Required

No new columns or tables. The nested serializer reads from the existing
`TaskResource` model via the `assignments` related manager.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Separate API call to /task-resources/?project=X | Keeps TaskSerializer simple | Extra HTTP call, client-side join needed, loading state complexity |
| Add `assignee_names` as a comma-separated annotation | Single string, no nested serializer | Loses structure (units, resource_id), can't render individual chips |
| Use Task.assignee (User FK) instead of TaskResource | Simpler — single FK | Only supports one assignee, no units, different from the resource model |

## Consequences

### What becomes easier
- PMs see resource assignments directly in the Gantt without navigating away
- Cross-project resource views (Enterprise) can reuse the same API shape
- Mobile sync can include assignment data in the task payload

### What becomes harder
- TaskSerializer response size grows slightly (3 extra fields per assignment)
- prefetch_related on every task list query adds one JOIN

### Risks
- **Performance with many assignments**: Capped at 10 assignments per task by
  `TaskResource.unique_together` and practical limits. Not a concern.
- **Task.assignee vs TaskResource confusion**: `Task.assignee` (User FK) is a legacy
  field for simple "who owns this" without resource modeling. `TaskResource` is the
  formal resource assignment with units. Both coexist — `assignee` is the quick-assign
  field, `TaskResource` is the full model. Document this in code comments.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS)
- **Affected packages**: `api` (serializer, prefetch), `web` (types, hook, TaskListRow, GanttRenderer)
- **Migration required**: No
- **API changes**: Yes — `TaskSerializer` gains a nested `assignments` read-only field
- **OSS or Enterprise**: OSS (trueppm-suite)

### Durable Execution Checklist
Not applicable — this is a read-only display feature with no async dispatch, no
background work, and no side effects.

### Implementation Sequence
1. API: `TaskAssignmentSerializer` + nested field on `TaskSerializer` + prefetch
2. Web: Update `ApiTask`, `Task` type, `mapTask()` in `useGanttTasks`
3. Web: Assignee chips in `TaskListRow` with tooltip and aria-label
4. Web: Canvas bar initials label in `GanttRenderer.ts::drawTaskBar()`
5. Web: Tests for chip rendering, overflow, tooltip, empty state
