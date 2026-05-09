# ADR-0058: Schedule Dep-Type UX Polish and Milestone Edit Completeness (#249 + #253)

## Status
Accepted

## Context

Two 0.1 issues target the Schedule view's build-mode usability:

**#249 — Dependency editing UX**
The `DependenciesTab` in `TaskDetailDrawer` exposes raw CPM acronyms (FS/SS/FF/SF) in both
the type picker and the per-row display. VoC panel rated this surface 3.0/10 before the
cycle-detection work in #356 / ADR-0055. Three distinct problems were filed:
1. Acronym-only labels in the dep-type picker and predecessor/successor rows
2. "Broken cascade on dep-type change" — the dep-type PATCH path has no `onError` handler;
   a cycle 400 silently reverts the select but gives no user feedback, making it appear
   that the cascade did not run
3. Cycle violation feedback only exists for the *add-dep* path, not the *update-type* path

**#253 — Milestone create/edit/delete**
Filed when milestones could not be created from the Schedule view. Subsequent ADR-0056 shipped
`ScheduleAddMilestoneButton` (toolbar + ⌘M shortcut) with direct `createTask.mutate({ is_milestone:
true, duration: 0 })`. However two gaps remain:
- The `TaskDetailDrawer` does not yet suppress duration/effort inputs when a task is a milestone
  (the task list row `TaskListRow.tsx` already does this correctly)
- The feature has never been end-to-end verified: create → diamond renders → open drawer → edit
  name/date/predecessors → delete

**Research findings that reduce scope:**
- `+ Milestone` toolbar button and ⌘M shortcut: **already shipped** (ADR-0056)
- `is_milestone BooleanField` on `Task`: **already exists** — no `task_type` enum or migration needed
- `TaskSerializer.validate()` enforces `is_milestone=True → duration=0`: **already wired**
- `DependencyViewSet.perform_update` calls `enqueue_recalculate(DEPENDENCY_CHANGE)` via
  `transaction.on_commit()`: **cascade trigger already wired** — the "broken cascade" is the
  missing `onError` handler, not a backend gap
- Inline cycle-error rendering infrastructure (`parseCyclicDependencyError`, `formatCycleMessage`,
  `errorMessage` state + `role="alert"` banner): **already exists** in `DependenciesTab.tsx` for
  the add path — the update path just needs to reuse it

The entire remaining work is frontend-only. No migrations, no new API endpoints.

## Decision

### #249 — Dep-type label standardization

**Labels are frontend-only constants.** The backend model choices (`"Finish-to-Start"` etc.) and
API wire values (`"FS"` etc.) do not change. Display labels in `DependenciesTab.tsx` are updated
from `'FS — Finish to Start'` style to the plain-English `'Finish → Start'` style recommended
by the VoC panel. The `<option>` elements in both `DepRow` and `AddDepRow` render `dt.label`
(not `dt.value`) as the visible text.

Exact label constants:
```ts
const DEP_TYPES: { value: LinkType; label: string }[] = [
  { value: 'FS', label: 'Finish → Start' },   // default, shown first
  { value: 'SS', label: 'Start → Start' },
  { value: 'FF', label: 'Finish → Finish' },
  { value: 'SF', label: 'Start → Finish' },
]
```

The `aria-label` on each select continues to spell out the full English description for screen
readers (matches WCAG 2.1 AA).

### #249 — Dep-type PATCH error handling

`DepRow.onUpdate` currently fires `updateDep.mutate({ dep_type })` with no `onError` callback.
A cycle 400 silently reverts the controlled select value with no feedback.

Fix: add a per-row `rowError: string | null` state to `DepRow` (or pass an error setter from the
parent). On `onError`, call `parseCyclicDependencyError(err)` → `formatCycleMessage(cycle)` and
set `rowError`. Render a `<span role="alert">` below the dep row. Clear `rowError` on the next
successful mutation or on unmount.

This reuses the existing `parseCyclicDependencyError` + `formatCycleMessage` utilities already
imported in `DependenciesTab.tsx`. No new error-handling infrastructure is introduced.

The existing tab-level `errorMessage` banner (for the add-dep path) is unchanged.

### #249 — Cascade on dep-type change

The cascade **already works** — `DependencyViewSet.perform_update` triggers
`enqueue_recalculate(DEPENDENCY_CHANGE)` via `transaction.on_commit()` for every dep PATCH.
The "broken cascade" filed in #249 item 2 is explained entirely by the missing `onError`: a
cycle 400 prevents the save, no recalculate fires, and the silent revert makes it look like the
downstream dates didn't update. Once the `onError` path is wired, the cascade behavior is correct.
No backend changes needed.

### #253 — Milestone field suppression in TaskDetailDrawer

`TaskListRow.tsx` already gates duration/effort on `task.isMilestone`. The `TaskDetailDrawer`
Overview tab (or wherever duration/effort inputs live in the drawer) must add the same gate:
- `duration` input: `disabled` + tooltip `"Milestones have no duration"` when `task.isMilestone`
- `optimistic_duration` / `most_likely_duration` / `pessimistic_duration` PERT fields: hidden
  entirely when `task.isMilestone` (milestones have no PERT estimates)
- Date display: show only start date (single-point-in-time), not a start→finish range

This is a read of `task.isMilestone` from the existing task object in the drawer — no API change.

### #253 — Milestone create/edit/delete end-to-end

- **Create**: `ScheduleAddMilestoneButton` (existing) → prompts for name inline or opens a
  simplified variant of `TaskFormModal` with only name + date. UX-design determines the exact
  interaction; the ADR decision is: reuse `TaskFormModal` with a `isMilestone={true}` prop that
  hides duration/PERT fields and pre-sets `is_milestone=true` + `duration=0` on submit.
- **Edit**: task detail drawer (existing) with the milestone field-suppression from above.
- **Delete**: existing task delete action in the drawer (no change required).

### What is explicitly out of scope

- Lag field in the dep picker — stays as a plain number input; no unit label needed in 0.1
- Dep-type labels in the API response — frontend constants are sufficient; mobile is 0.3/0.4
- `dep_type` exposure in `TaskFormModal`'s predecessors editor — ADR-0052 §8 defers this; FS
  remains the only type creatable from the modal
- `task_type` enum on the Task model — `is_milestone` boolean is the correct representation per
  P6 convention and the existing serializer invariant

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Add `display_label` to API dep-type response | Helps mobile, third-party consumers | API surface change + schema drift; mobile is 0.3/0.4 and has no live consumers yet; labels belong in the UI layer |
| New `task_type` TextChoices enum on Task | Extensible for "summary", "hammock", etc. | Migration + serializer change; `is_milestone` boolean already consistent across model/serializer/frontend; future task types can be added later without breaking changes |
| Tab-level error banner for dep-type PATCH (reuse existing) | No new state | The banner sits below all rows; for a type-change error the user needs to know *which row* failed; per-row state is cleaner at 3–5 rows typical depth |
| Dedicated MilestoneFormModal (separate from TaskFormModal) | Cleaner single-purpose component | Duplicate form logic; `TaskFormModal` already accepts `defaultStatus` and `parentId` — a `isMilestone` prop is a minimal extension |

## Consequences

- **Easier**: PMs building schedules no longer need CPM textbook knowledge to edit dep types;
  cycle violations on type-change are immediately visible inline; milestone create/edit/delete
  is complete without workarounds
- **Harder**: nothing — no new complexity introduced; purely additive frontend changes
- **Risks**: none significant; `DepRow` per-row error state is isolated; `isMilestone` prop
  on `TaskFormModal` is additive

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `web` only
- Migration required: **no**
- API changes: **no**
- OSS or Enterprise: **OSS** (confirmed — `grep -r 'trueppm_enterprise' packages/` returns zero source hits)

### Key files

| File | Change |
|------|--------|
| `packages/web/src/features/schedule/DependenciesTab.tsx` | Update `DEP_TYPES` labels; fix `<option>` render to use `dt.label`; add per-row `rowError` state + `onError` to `DepRow.onUpdate` |
| `packages/web/src/features/board/TaskFormModal/index.tsx` | Add `isMilestone?: boolean` prop; hide duration/PERT fields + force `is_milestone=true, duration=0` when set |
| `packages/web/src/features/schedule/ScheduleAddMilestoneButton.tsx` | Pass `isMilestone={true}` to `TaskFormModal` (or keep direct mutation — UX-design call) |
| `packages/web/src/features/schedule/TaskDetailDrawer.tsx` (or drawer sub-component) | Suppress duration/PERT inputs when `task.isMilestone`; single-date display |

### Test coverage required (all three layers)

- **vitest**: `DEP_TYPES` constants have correct label strings; `DepRow` renders row-level error
  on cycle 400; `TaskFormModal` with `isMilestone={true}` hides duration/PERT + forces
  `is_milestone=true`
- **Playwright**: dep type change to a value that creates a cycle shows inline error next to the
  row; milestone create via toolbar + verify diamond in task list; milestone edit name via drawer;
  milestone delete via drawer

### Durable Execution

1. **Broker-down behaviour**: N/A — all changes are display-only frontend mutations; the backend
   dep PATCH already uses the existing `transaction.on_commit → enqueue_recalculate` path
   (unchanged).
2. **Drain task**: N/A — no new async work categories introduced.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: N/A for new code. Existing `scheduling/services.py::enqueue_recalculate()`
   continues to handle recalculation dispatch unchanged.
5. **API response on best-effort dispatch**: N/A — dep PATCH returns synchronous 200/400; recalc
   is fire-and-forget on `on_commit` (existing behaviour, no change).
6. **Outbox cleanup**: N/A — no new outbox rows.
7. **Idempotency**: N/A — no new Celery tasks.
8. **Dead-letter / failure handling**: N/A — no new tasks; existing `recalculate_schedule`
   retry/DLQ policy (ADR-0017/0018) covers dep-type-change recalcs unchanged.
