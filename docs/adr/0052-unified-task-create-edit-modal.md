# ADR-0052: Unified Task Create/Edit Modal

## Status

Accepted (2026-05-05)

## Context

Issue #305 — second batch of the card/task dialogs redesign (#303 epic). Replaces
two existing creation surfaces (`AddTaskModal.tsx` on the board, `AddTaskForm.tsx`
inline on the Schedule view) with a single unified modal that supports both
**create** and **edit** modes. Edit mode adds a Delete action (role-gated) and a
"Last edited by {user} {time}" indicator.

**P3M layer**: Programs and Projects (single-task scope). **Repo**: OSS.

### Forces

- **Two existing create entry points diverge.** `AddTaskModal` (board phase
  headers) is a hand-rolled inline-`fixed` modal collecting only `name` +
  `duration`. `AddTaskForm` (Schedule view "+ Task" inline strip) collects the
  same. Neither matches the design handoff's field set; neither supports edit.
- **Edit-via-modal vs. rule 89.** ADR-0044 rule 89 — "Modal for edit … violates
  rule 89; loses list context" — was written for *risk row click → modal* and
  was rejected in favor of the drawer-with-edit pattern. The wording is cited
  defensively in this ADR; rule 89 is **not** applied to issue #305 (carveout
  documented below).
- **No global modal/portal pattern.** Every existing modal is mounted inline as
  a `fixed`-positioned element; `createPortal` is used only for context menus.
  Adding a global modal provider for one new surface is a disproportionate
  refactor.
- **No form library.** `react-hook-form` / `formik` returned zero hits across
  the codebase. Hand-rolled controlled state per field is the consistent
  pattern; the new modal must mirror it.
- **Mobile (`< md`, 768px) cannot host a 560 / 760-wide modal.** Sarah's hard
  NO ("web-only / no real native mobile app") is triggered by a desktop-only
  edit surface.
- **Bottom-sheet duplication is now load-bearing.** `RiskDrawer` (`< md` bottom
  sheet) and `BoardCardPopover/CardPopoverShell` (#304, just merged) duplicate
  the same `inset-x-0 bottom-0 z-50 max-h-[85vh] rounded-t-xl` pattern. This
  modal is the third surface — extraction is justified per the framework's
  "fewer moving parts" criterion.
- **Permission inference must happen client-side.** The Task API exposes no
  `permissions: { can_delete }` field. The frontend infers from
  `useCurrentUserRole` + `task.assignee` per the `IsProjectMemberWriteOrOwn`
  matrix in `apps/access/permissions.py`.
- **Variation A vs B is a `ux-design` decision.** Both must compile to the same
  shell. The architecture must not encode A's single-column or B's two-pane as
  load-bearing.

### Rule 89 carveout (documented for future readers)

**ADR-0044 rule 89 banned modals for the risk-row edit flow.** The cited reason
was loss of list context: clicking a risk row to edit it would replace the list
with a modal, hiding it. The drawer pattern was preferred because it slides in
beside the list and preserves spatial context.

**Issue #305 invokes the modal differently.** Entry points:
1. `+ Task` button on the board phase header (an explicit creation action).
2. `+ Task` button on the Schedule view toolbar (an explicit creation action).
3. Mobile FAB (an explicit creation action).
4. The `BoardCardPopover` "Edit" footer action (#304) — invoked from a popover
   that has already obscured the surrounding board context.
5. The `BoardCard` ··· overflow menu's "Edit" item (an explicit per-task action
   that does not require list context to be intelligible).

In none of these is the modal a *replacement* for a list view the user was
just inhabiting. The popover-as-launcher (4) has already broken list context;
the explicit creation entry points (1–3, 5) treat the modal as the surface,
not a substitute for one.

The drawer remains the canonical surface for **read** + **deep multi-section
inspection** (registry-backed via ADR-0050). The modal is the canonical surface
for **focused single-task field editing** — a narrower workflow that benefits
from a dedicated form rather than a tab inside a multi-section drawer.

This carveout is scoped to the task domain. Rule 89 stays in force for the risk
register (where it originated) and any future "row click → edit" interaction in
list-shaped surfaces.

## Decision

### 1. One component, two modes

A single `TaskFormModal` component renders both create and edit modes. The
`mode` is inferred from props: `taskId: string | null`. When `null`, the form
renders empty (create); otherwise it prefills from the task identified by
`taskId`.

### 2. Component structure

```
features/board/  (or shared — see §3 mount strategy below)
  TaskFormModal/
    index.tsx                  // public export — accepts mode-discriminating props
    TaskFormModalShell.tsx     // desktop modal vs mobile bottom-sheet shell
    TaskFormBody.tsx           // field rendering — variation A or B (one-line swap)
    TaskFormBodyA.tsx          // single-column 560×720
    TaskFormBodyB.tsx          // two-pane 760-wide  ← NOT shipped this batch
    TaskFormFooter.tsx         // ⌘+S submit · Cancel · (edit) Delete · last-edited
    PredecessorsEditor.tsx     // predecessor add/remove inline
    AssigneesEditor.tsx        // per-assignee unit % editor
    DeleteConfirmDialog.tsx    // role-gated destructive confirm
    TaskFormModal.test.tsx
```

`TaskFormBodyB.tsx` is **not** implemented in this batch — `ux-design` picks A or
B; the unselected variant is not stubbed (YAGNI).

### 3. Mount strategy

Inline `fixed`-positioned, mirroring `AddTaskModal`'s existing pattern. **No
portal, no global ModalProvider** — both would be premature for a single new
surface. Owner state lives in the calling component (`BoardView`,
`ScheduleView`, `BoardCardPopover` consumers via `BoardView`).

### 4. State management

Hand-rolled controlled state per field. One `useState` per field; one
top-level `useReducer` for the form-state object **only if** the field count
crosses ~12 — measured via the count below:

| Field | Mode | Source | Notes |
|---|---|---|---|
| `name` | C+E | input | required |
| `description` | C+E | textarea | optional, multi-line |
| `status` | C+E | select | `STATUS_OPTIONS` (rule 106 — five canonical) |
| `readiness` | C+E | select (or auto from #179 logic) | optional override |
| `planned_start` | C+E | date input | nullable; SNET semantics |
| `duration` | C+E | number input | required, integer working days |
| `progress` | E only | range slider | 0–100; editing existing tasks only |
| `sprint` | C+E | select | `useSprints(projectId)`; nullable; only renders when `project.agile_features` is true (ADR-0037) |
| `assignees` | C+E | inline editor | per-assignee unit %; **separate** write path via `/task-resources/` (§7) |
| `predecessors` | C+E | inline editor | add/remove via `/dependencies/` (§8) |

Field count = 10 — within the `useState`-per-field threshold. No reducer.

### 5. Mobile responsive shell — extract `<BottomSheet>`

Three surfaces now duplicate the bottom-sheet shell:
- `features/risk/RiskDrawer.tsx` (mobile branch lines 143–171)
- `features/board/BoardCardPopover/CardPopoverShell.tsx` (mobile branch ~lines 96–117)
- this modal

Extract a shared component:

```
src/components/ui/BottomSheet.tsx
```

Props: `{ isOpen, onClose, ariaLabel, children, maxHeight?, hasDragHandle? }`.
Owns the scrim, transition, drag handle, focus trap, and Esc handler. Used by
the new modal's mobile branch and by `CardPopoverShell` (refactor it in this
MR — single touchpoint, ~20 LOC saved). `RiskDrawer` migration is **deferred**
— its mobile/desktop split has different ergonomics (flex sibling on desktop,
not a centered modal) and conflating the two is the failure mode the
extraction was supposed to avoid.

### 6. Desktop shell

Centered fixed-position container with backdrop. Width determined by ux-design
pick (560px for A, 760px for B). Height `auto` with `max-h-[90vh]` + internal
scroll for long forms. `role="dialog" aria-modal="true" aria-labelledby` to the
title id (e.g. `task-form-title`). Backdrop `bg-black/40`, `motion-safe:animate-in
motion-safe:fade-in motion-safe:duration-150` (no shadows per rule 1).

### 7. Per-assignee unit editor — separate write path (ADR-0028)

Assignments do **not** flow through `TaskSerializer`. The `assignees` editor in
the form maintains a local working copy and emits three operations on save:
- **Created rows** → `POST /api/v1/task-resources/` with `{ task, resource, units }`.
- **Modified rows** (units changed) → `PATCH /api/v1/task-resources/{id}/` with `{ units }`.
- **Removed rows** → `DELETE /api/v1/task-resources/{id}/`.

These run **after** the task POST/PATCH succeeds (so `taskId` is known on
create). On task creation, the order is:
1. `POST /tasks/` → returns `{ id }`.
2. For each new assignee: `POST /task-resources/` with that `id`.

Failures in step 2 surface as a non-blocking warning toast — the task exists,
the assignment didn't. The user can re-open the modal and fix.

The 201 `warnings: []` array (ADR-0028) — overallocation, skill mismatch — is
collected and shown as an amber inline banner above the modal footer
(non-blocking).

### 8. Predecessors editor — new mutation hooks

`useTaskDependencies(taskId)` is read-only today. Add to `hooks/useTaskMutations.ts`:

```ts
export function useAddDependency(): UseMutationResult<...> {
  // POST /api/v1/dependencies/ with { predecessor, successor, dep_type, lag }
  // On success: invalidate ['task-dependencies', successorId] and
  //             ['task-dependencies', predecessorId]
}

export function useRemoveDependency(): UseMutationResult<...> {
  // DELETE /api/v1/dependencies/{id}/
  // On success: same invalidations.
}
```

The editor renders the existing predecessor list from `useTaskDependencies`,
with an inline picker for adding (search by task name within the project) and
an `×` per row to remove. Default `dep_type='FS'` and `lag=0` for new edges
(ADR-0035 / typical case); type and lag are not exposed in the modal — those
edits live in the drawer's dedicated dependency section. **No client-side cycle
detection** — the API doesn't validate cycles either; downstream CPM
recalculation handles them. A follow-up issue should add cycle detection at
the serializer; out of scope here.

### 9. "Last edited" footer

Read from `useTaskHistory(projectId, taskId)` (existing hook, used today by
the drawer's History tab). The latest record is `pages[0].results[0]`.

```tsx
const lastEdit = historyPages.pages[0]?.results[0];
const label = lastEdit
  ? lastEdit.history_user
    ? `Edited by ${lastEdit.history_user} ${formatRelative(lastEdit.history_date)}`
    : `Edited ${formatRelative(lastEdit.history_date)}`
  : null;
```

Renders in the modal footer-left in edit mode only. `history_user` is null for
roles below `ADMIN` per ADR-0011 — fall back to attribution-less copy. Records
with empty diffs (CPM-only mutations) are already filtered server-side.

### 10. Delete flow + permission gate

Use existing `useDeleteTask(projectId)`. Visibility gate:

```tsx
const role = useCurrentUserRole().role ?? 0;
const canDelete =
  role >= ROLES.PROJECT_MANAGER       // PM+: any task
  || (role >= ROLES.MEMBER && task.assignee === currentUser?.id); // member: own only
```

**Resource Manager (role=2) cannot delete tasks per the API matrix** — the
viewset's `IsProjectMemberWriteOrOwn` rejects them. The frontend matches.

The Delete button opens a `<DeleteConfirmDialog>` — separate small modal
mounted on top of the form modal. Confirm calls `deleteTask.mutate(taskId)`,
closes both modals, fires `onDeleted` callback so the caller can clear popover
selection.

### 11. ⌘+S submit + dirty Esc check

```tsx
useEffect(() => {
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (formIsValid) submit();
    } else if (e.key === 'Escape') {
      if (isDirty) {
        if (window.confirm('Discard unsaved changes?')) onClose();
      } else {
        onClose();
      }
    }
  }
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [formIsValid, isDirty, ...]);
```

`window.confirm` is the lightweight choice — a custom confirm modal is
overkill for a "did you mean to discard" check. It's keyboard-accessible by
default and matches existing browser semantics.

### 12. Migration plan

Both legacy create entry points migrate in this MR:

| Old surface | New | Action |
|---|---|---|
| `AddTaskModal.tsx` | `TaskFormModal` (mode=create, parentId=phaseId) | Replace inline render in `BoardView` (lines 1573–1578); delete `AddTaskModal.tsx` + its test |
| `AddTaskForm.tsx` (Schedule view inline strip) | `TaskFormModal` (mode=create) | Replace `setShowAddForm` toggle with `setCreateOpen` modal trigger; delete `AddTaskForm.tsx` + its test |
| Popover "Edit" → drawer in edit mode (#304 placeholder) | `TaskFormModal` (mode=edit, taskId) | One-line swap in `BoardView`'s `onEdit` handler — set `editTaskId` instead of `selectedTaskId` |
| `BoardCard` ··· menu "Edit" item | `TaskFormModal` (mode=edit, taskId) | Same `setEditTaskId(task.id)` |

The `selectedTaskId` (drawer) state in `BoardView` from #304 stays — drawer is
still the multi-section read surface. New `editTaskId` state drives the modal.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Two specialized components** (`TaskCreateModal` + `TaskEditModal`) | Each component simpler in isolation | 80% duplicate code; design handoff treats them as one form with mode-conditional fields |
| **One component, mode prop** (chosen) | Matches design handoff; reduces duplication; allows shared shell + footer | Slight conditional complexity inside the form body |
| **Edit-via-drawer, create-only modal** | Strict rule 89 compliance | Discards half the design handoff; user would need a follow-up; popover Edit already lands somewhere reasonable so the gain is small |
| **Adopt `react-hook-form`** | Better dev ergonomics for complex forms | New dep; no existing usage; hand-rolled is consistent with rest of codebase; ~10 fields doesn't earn the dep cost |
| **Global `ModalProvider`** | Cleaner caller code | Premature — only one new modal in flight; refactor when 3+ providers want it |
| **Portal-mount the modal** | Escapes parent overflow | `AddTaskModal` already inline-mounts without issue; portal adds complexity |
| **Reuse `<BottomSheet>` as the desktop shell too** | One shell for both viewports | Desktop UX is meaningfully different (centered + backdrop vs slide-up); coupling them invites regressions |
| **Skip `<BottomSheet>` extraction (duplicate again)** | Faster to ship | Three surfaces is the threshold; deferring drives drift across the three implementations |
| **Cycle-detect dependencies client-side** | Surface the issue early | Duplicates server work the API should own; out of scope — file follow-up |

## Consequences

### Becomes easier
- One canonical surface for task creation across board, schedule, and (eventually) any new caller.
- The popover (#304) "Edit" gets a real target — one-line swap.
- `<BottomSheet>` extraction reduces the next mobile-sheet surface (#311, #312) to a one-line shell.
- "Last edited" surface in edit mode satisfies Marcus's audit-trail concern at the per-task level without new endpoints.
- Per-assignee unit % editor satisfies David's hero ask without changing API.

### Becomes harder
- Two existing components delete in this MR — any in-flight branch that touches `AddTaskModal.tsx` or `AddTaskForm.tsx` will conflict. Coordinate before merge.
- Hand-rolled form state at 10 fields is the upper edge — adding 3+ more fields should trigger reducer adoption (or a form-library RFC).
- Rule 89 carveout documented; future contributors will read this ADR before writing similar modals. Worth the discipline.

### Risks
- **Stale form state on rapid open/close.** The form un-mounts on close; opening for a new task re-mounts. Verify in the test that prefill is correct after switching tasks without unmount (e.g. popover open on task A → "Edit" → save → popover open on task B → "Edit" should show task B's data, not stale task A's).
- **Assignment failure after task create.** If the task POST succeeds and a TaskResource POST fails, the user sees a partial success. Mitigation: warning toast + the task already exists in the board (visible feedback) + the user can re-open and fix.
- **Cycle-creating predecessor.** API silently accepts; CPM may then misbehave. Mitigation in scope: trust the API for now. Mitigation out of scope: file API-side cycle validation as follow-up.
- **`<BottomSheet>` extraction breaks `CardPopoverShell`.** Mitigation: refactor `CardPopoverShell` in the same MR; vitest unit tests for `BoardCardPopover` (13 cases, just merged) catch any regression.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-task scope)
- **Affected packages**: `web` only
- **Migration required**: no
- **API changes**: no — every endpoint already exists
  (`POST/PATCH/DELETE /tasks/`, `POST/DELETE /dependencies/`,
  `POST/PATCH/DELETE /task-resources/`, `GET /tasks/{id}/history/`)
- **OSS or Enterprise**: OSS (`grep -r "trueppm_enterprise" packages/` returns zero)

### Files touched
- **New**: `packages/web/src/features/board/TaskFormModal/*` (8 files including
  test); `packages/web/src/components/ui/BottomSheet.tsx` (+ test).
- **Modified**:
  - `packages/web/src/hooks/useTaskMutations.ts` — add
    `useAddDependency`, `useRemoveDependency`.
  - `packages/web/src/features/board/BoardView.tsx` — replace
    `<AddTaskModal>` render with `<TaskFormModal mode="create">`; add
    `editTaskId` state; mount `<TaskFormModal mode="edit">`; swap popover
    `onEdit` handler.
  - `packages/web/src/features/schedule/ScheduleView.tsx` — replace
    `<AddTaskForm>` strip with `<TaskFormModal mode="create">` trigger from
    the toolbar's "+ Task" button.
  - `packages/web/src/features/board/BoardCardPopover/CardPopoverShell.tsx` —
    refactor mobile branch to use shared `<BottomSheet>`.
  - `packages/web/src/features/board/BoardCard.tsx` — wire the existing ···
    menu's missing "Edit" item to the new `editTaskId` state (verify it
    exists; add if missing — small touch).
- **Deleted**: `AddTaskModal.tsx` + test; `AddTaskForm.tsx` + test.
- `changelog.d/305.changed.md` (changed type, since this redesigns existing
  behavior).

### Test layers (per CLAUDE.md `feedback_test_coverage`)

- **vitest unit**: form renders create-empty / edit-prefilled; ⌘+S submits;
  Esc-with-dirty confirms; assignees inline editor; sprint chip; per-assignee
  unit total indicator; delete role-gating matrix (PM, member-own, member-other,
  scheduler, viewer); "Last edited" footer with and without history_user.
- **Hook**: `useAddDependency` and `useRemoveDependency` mutations.
- **Component**: `<BottomSheet>` (open/close, scrim tap, focus trap, drag
  handle visible).
- **Playwright e2e**: open create from board phase header → save →
  card appears; open edit from popover → modify name → save → card updates;
  delete from edit mode → confirm → card removed (PM role); delete button is
  hidden for non-owner member; mobile viewport renders bottom-sheet shell.

### Durable Execution

1. Broker-down behaviour: **N/A** — frontend feature; all writes go through
   existing PATCH/POST/DELETE endpoints whose `transaction.on_commit`
   dispatches (CPM recalc, task_status_changed signal) are unaffected.
2. Drain task: **N/A** — no new async work.
3. Orphan window: **N/A** — no outbox row.
4. Service layer: **N/A** — no new dispatch path; `enqueue_recalculate` is
   already invoked by `TaskViewSet.perform_update` and
   `DependencyViewSet.perform_create`/`perform_update`/`perform_destroy`.
5. API response on best-effort dispatch: synchronous — the modal awaits each
   mutation and surfaces inline error UI on failure. No 202 path.
6. Outbox cleanup: **N/A**.
7. Idempotency: a second submit (user clicks Save twice rapidly) issues two
   PATCHes with the same payload; `Task.save()` is idempotent for unchanged
   fields. The button `disabled={mutation.isPending}` prevents the second
   click in practice.
8. Dead-letter / failure handling: **N/A** at the modal layer. Mutation
   failures surface as inline error UI; the user retries or cancels.
