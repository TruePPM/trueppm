# UX Design Handoff — Schedule Dep-Type UX + Milestone Edit Completeness

**Issues**: #249 (dependency editing UX) + #253 (milestone create/edit/delete)
**ADR reference**: [ADR-0058](../../../adr/0058-schedule-dep-ux-and-milestone-edit-completeness.md)
**Persona**: Sarah Chen (PM) — primary user of the Schedule build surface
**Job-to-be-done**: Build a complete project schedule with milestones and typed dependencies without needing to know CPM acronyms

---

## Original Design Reference

The design handoff screenshot (`Schedule — Light` mockup) shows the target state for the
task detail drawer. Key decisions that the screenshot establishes:

1. **Predecessor chips in the drawer use shorthand format**: `1.1.1 FS` and `1.1.4 SS+5` —
   this is the *compact display* format, not the edit picker. The plain-English labels
   (`"Finish → Start"`) apply only to the edit picker in `DependenciesTab`. The compact
   chip retains the `{wbs} {type}[±{lag}d]` shorthand because in context (with a WBS ID
   anchor) the acronym is unambiguous even to a non-expert.

2. **Duration PERT inline**: The design shows `42d (3pt: 38 / 42 / 50)` as one field —
   PERT estimates are a parenthetical annotation on the Duration row, not a separate
   section. The `EstimatesSection` in the drawer is additive detail; the MetaRail Duration
   row shows the synopsis.

3. **Drawer layout**: The design shows Owner + Status-badge + Start/Finish/Duration/
   Predecessors/Float as a flat vertical property list — not collapsible sections. This
   is consistent with the current `MetaRail` component (status, dates, duration, float,
   progress). The Predecessors chip row is **not yet in `MetaRail`** — it should be added
   as part of this work (see Surface 4 below).

---

## Surface 1 — Dep-type picker labels in `DependenciesTab`

### Decision

Full plain-English labels in the edit picker (`AddDepRow` + `DepRow`). The collapsed
select displays the full label because it is the primary description of the relationship.
No `(default)` suffix — position-first is sufficient.

### Label constants

```ts
const DEP_TYPES: { value: LinkType; label: string }[] = [
  { value: 'FS', label: 'Finish → Start' },   // default, first in list
  { value: 'SS', label: 'Start → Start' },
  { value: 'FF', label: 'Finish → Finish' },
  { value: 'SF', label: 'Start → Finish' },
]
```

Change in `DependenciesTab.tsx`:
- `<option key={dt.value} value={dt.value}>{dt.value}</option>` → `{dt.label}`
  in **both** `DepRow` and `AddDepRow`

### Layout — DepRow (existing 3-col grid)

```
┌─────────────────────────────────────────────────────┐
│  [Task name — truncated flex-1      ] [select    ] [14 lag] d lag [×] │
└─────────────────────────────────────────────────────┘
```

The select grows to ~100px to fit "Finish → Finish" (widest label) at `text-xs`. The
`flex-1 truncate` task name column absorbs the width change within the 540px drawer.
No layout change required — `px-1.5 py-1` on the select is unchanged. Verify at 320px
viewport that the remove `×` button is not pushed off-screen; if it is, wrap task name
at 200px `max-w-[200px]` instead of `flex-1`.

### Compact chip format (MetaRail predecessor chips — NOT DependenciesTab)

The design shows predecessor chips in the MetaRail as `1.1.1 FS` and `1.1.4 SS+5`. This
uses the **shorthand** deliberately — in a chip the WBS anchor makes the acronym readable.
Do NOT apply plain-English labels to these chips; keep `{wbs} {type}[±{lag}d]` format.
These chips are read-only display; the full edit surface is in the DependenciesTab.

### WCAG notes

- `aria-label="Dependency type"` on the select in `DepRow` is sufficient — the option text
  is the full label, so the selected value reads correctly to screen readers
- `aria-label="Link type"` in `AddDepRow` — unchanged

---

## Surface 2 — Inline cycle error on dep-type change (`DepRow`)

### Decision

**Per-row error, auto-dismiss on next interaction.**

The existing tab-level `errorMessage` banner (for the add path) is unchanged. When a
dep-type PATCH returns a cycle 400, a per-row error message appears directly below the
offending row. It auto-clears on the next `onChange` or `onBlur` on any input in that row,
or when the task changes (`useEffect` on `task.id`).

### Error copy

| Scenario | Copy |
|---|---|
| Cycle detected | `"Creates a cycle: {task A} → {task B} → {task A}"` |
| Other PATCH failure | `"Couldn't update — try again"` |

The `formatCycleMessage(cycle)` utility already formats the cycle path. Prepend `"Creates a cycle: "` to distinguish from the add-path error which reads `"Couldn't add dependency."`.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  [Task name             ] [select ↕] [14] d lag [×]  │
│  ⚠ Creates a cycle: Detail design → Engine → Detail  │  ← role="alert" text-xs text-semantic-critical
└─────────────────────────────────────────────────────┘
```

Implementation:

```tsx
// DepRow gets rowError state
const [rowError, setRowError] = useState<string | null>(null);

<div className="flex items-center gap-2 py-1.5 border-b border-neutral-border/40 last:border-b-0">
  {/* ... existing row ... */}
  <select
    onChange={(e) => {
      setRowError(null);          // clear on next change
      onUpdate({ dep_type: e.target.value as LinkType });
    }}
    onError={...}                  // see below
  />
</div>
{rowError && (
  <div
    role="alert"
    className="text-xs text-semantic-critical px-0 pb-1.5 -mt-1"
  >
    {rowError}
  </div>
)}
```

The `onUpdate` prop becomes `onUpdate: (patch, callbacks?: { onError?: (err: unknown) => void }) => void`
OR the parent passes an `onError` to `updateDep.mutate`:

```tsx
// In DependenciesTab, for DepRow:
onUpdate={(patch) =>
  updateDep.mutate(
    { id: link.id, ...patch },
    {
      onError: (err) => {
        const cycle = parseCyclicDependencyError(err);
        // communicate error back to the row — pass setter via prop or use a ref map
      },
    },
  )
}
```

Cleanest approach: pass `onUpdateError` as an additional prop to `DepRow`:

```tsx
interface DepRowProps {
  link: TaskLink;
  relatedTask: Task;
  onUpdate: (patch: { dep_type?: LinkType; lag?: number }) => void;
  onUpdateError?: (err: unknown) => void;   // new optional prop
  onDelete: () => void;
}
```

Then in `DependenciesTab`:
```tsx
<DepRow
  ...
  onUpdate={(patch) => updateDep.mutate({ id: link.id, ...patch }, { onError: onUpdateError })}
  onUpdateError={(err) => { /* DepRow manages its own rowError state internally */ }}
/>
```

Actually simpler: `DepRow` owns its own `rowError` state + calls `onUpdate` with an options object:

```tsx
function DepRow({ link, relatedTask, onUpdate, onDelete }: DepRowProps) {
  const [rowError, setRowError] = useState<string | null>(null);

  function handleTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setRowError(null);
    onUpdate(
      { dep_type: e.target.value as LinkType },
      {
        onError: (err: unknown) => {
          const cycle = parseCyclicDependencyError(err);
          setRowError(
            cycle
              ? `Creates a cycle: ${formatCycleMessage(cycle)}`
              : "Couldn't update — try again",
          );
        },
      },
    );
  }
  // ...
}
```

And `onUpdate` signature updates to:
```ts
onUpdate: (
  patch: { dep_type?: LinkType; lag?: number },
  callbacks?: { onError?: (err: unknown) => void },
) => void;
```

### WCAG notes

- `role="alert"` is sufficient — screen readers announce immediately on insertion
- No focus management needed for the error (it's inline, not modal)
- Error clears automatically — no explicit close affordance needed (not a blocking state)

---

## Surface 3 — Milestone creation flow

### Decision: Option B — extend existing inline create (no modal)

The current `handleAddMilestone` flow is correct. The only gap: outside build mode,
"New milestone" is the permanent placeholder name. Fix: after create, **always** drop into
name cell-edit mode (remove the `if (buildModeActive)` guard), so the user types the name
immediately after pressing `+ Milestone` or ⌘M.

```tsx
// In handleAddMilestone onSuccess:
focus.focusRow(data.id);
focus.enterCellEdit(data.id, 'name');  // unconditional — remove buildModeActive guard
```

**Why not a modal**: The design shows the schedule task list as an inline editing surface.
A modal for milestone creation adds a mode-switch and is inconsistent with the `+ Task`
build-mode flow (which drops focus into the inline name cell). Option B is the keyboard-
first, direct-manipulation choice.

**Date after create**: The milestone is created with `planned_start: today`. The user sets
the target date by editing the MetaRail "Date" field in the drawer (see Surface 4), or by
dragging the diamond on the Gantt (when drag CPM is implemented, issue #19). No date-entry
step in the create flow — today is the right default to avoid "unscheduled" state.

### Milestone toolbar button

`ScheduleAddMilestoneButton` is already shipped. No changes to the button itself.
Keyboard shortcut ⌘M is already wired. No new entry point needed.

### Interaction flow

```
User presses "+ Milestone" in toolbar (or ⌘M)
  → createTask.mutate({ name: 'New milestone', is_milestone: true, duration: 0, planned_start: today })
  → onSuccess:
      → task list row appears with diamond icon and "New milestone" text
      → focus moves to that row (focus.focusRow)
      → name cell enters edit mode (focus.enterCellEdit) — user types name
      → typing replaces "New milestone"; Enter commits; Escape discards (and deletes the task if still placeholder)
      → aria-live announces: "Milestone [name] inserted at [today]"
```

**Date focus after name commit (VoC amendment):** Four of six personas independently
flagged that after naming a milestone, the date is set to today but there's no obvious
path to change it without hunting through the drawer. Fix: after the name cell-edit
commits (Enter), move focus to the date cell immediately:

```tsx
// In handleAddMilestone onSuccess, after focus.enterCellEdit:
focus.focusRow(data.id);
focus.enterCellEdit(data.id, 'name', {
  onCommit: () => focus.enterCellEdit(data.id, 'planned_start'),  // chain to date
});
```

If the schedule task list doesn't have an editable date cell (the date is Gantt-drag
only in the current build), fall back to: open the task detail drawer immediately after
name commit, with the MetaRail "Date" field focused. The drawer open + MetaRail focus
approach is simpler to implement and sufficient — the user sees the date and can change
it in one step.

Implementation choice (decide at implementation time based on whether `planned_start`
has an inline cell editor): prefer cell-chain if available; otherwise drawer auto-open.
Document which path was taken in the MR description.

Empty state if ESC pressed on a "New milestone" (no edit made): the task is left as-is
with the placeholder name. The user can rename later via inline edit or the drawer.

---

## Surface 4 — `MetaRail` milestone field suppression + predecessor chips

### Decision

Two changes to `MetaRail`:

#### 4a — Predecessor chips (new row, all tasks)

Add a **Predecessors** row after Duration, matching the design screenshot. Shows up to 3
predecessor chips; overflow shows `+N more`.

```
Predecessors
[1.1.1 FS] [1.1.4 SS+5]    ← chips, read-only, open DependenciesTab on click
```

Chip format: `{task.wbs ?? task.short_id} {dep_type}[{±lag}d if non-zero]`
- `1.1.1 FS` — WBS + type, no lag
- `1.1.4 SS+5` — WBS + type + lag
- `a1b2 FS` — short_id if no WBS

Chip style: `border border-neutral-border rounded px-1.5 py-0.5 text-[11px] tppm-mono
  text-neutral-text-secondary bg-neutral-surface hover:border-brand-primary cursor-pointer`

Each chip carries a `title` attribute with the plain-English expansion for first-time
readers who don't know CPM shorthand (VoC: Sarah flagged `SS+5` reads like an error code):

```tsx
const DEP_TYPE_LABELS: Record<string, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
}

// Chip title format: "{plain-English type}{lag}" e.g. "Start → Start, +5 days lag"
function chipTitle(depType: string, lag: number): string {
  const label = DEP_TYPE_LABELS[depType] ?? depType
  if (lag === 0) return label
  return `${label}, ${lag > 0 ? '+' : ''}${lag} day${Math.abs(lag) !== 1 ? 's' : ''} lag`
}
```

On chip click: scroll the drawer to the Dependencies section and expand it (or pass an
`onOpenDependencies` callback from the parent).

Show the row only when `predecessorLinks.length > 0`. Pass `predecessorLinks` to MetaRail
(or let MetaRail read from the `links` prop already available in the drawer context).

#### 4b — Duration row for milestones

When `task.isMilestone`:

```
Duration
—  (milestone)
```

Replace `{task.duration}d` with an em-dash and the label `(milestone)` in
`text-neutral-text-secondary`. This is less jarring than "0d" and communicates the semantic.

#### 4c — Start/Finish rows for milestones

When `task.isMilestone`:
- **Start row**: Rename label to **"Date"**
- **Finish row**: **Hide** (milestones are point-in-time; showing the same date twice is confusing)

```tsx
{/* Start / Date */}
<Row label={task.isMilestone ? 'Date' : 'Start'}>
  {hasSchedule ? <span className="tppm-mono">{formatDate(task.start)}</span> : …}
</Row>

{/* Finish — suppress for milestones */}
{!task.isMilestone && (
  <Row label="Finish">…</Row>
)}
```

#### 4d — Float row for milestones

Keep unchanged — milestones have float and critical-path status. The CP tooltip
(`title="This task is on the critical path…"`) applies equally to milestone tasks.

#### 4e — Progress row for milestones

Milestones don't have intermediate progress. When `task.isMilestone`:
- Replace the progress bar + percentage text with a simple status pill:
  - NOT_STARTED: `"Not yet reached"` in `text-neutral-text-secondary`
  - COMPLETE: `"Reached"` with `text-semantic-on-track` + `✓` prefix

```tsx
{task.isMilestone ? (
  <Row label="Progress">
    {task.status === 'COMPLETE' ? (
      <span className="text-semantic-on-track text-xs">✓ Reached</span>
    ) : (
      <span className="text-neutral-text-secondary text-xs italic">Not yet reached</span>
    )}
  </Row>
) : (
  <>
    <Row label="Progress">
      <span className="tppm-mono">{task.progress}%</span>
    </Row>
    {/* progress bar */}
  </>
)}
```

### MetaRail milestone state — full ASCII wireframe

```
┌──────────────────────────────┐
│ Status                        │
│  ◉ Not started                │
│                               │
│ Date                          │  ← renamed from "Start"
│  Jul 15                       │  ← no Finish row
│                               │
│ Duration                      │
│  — (milestone)                │  ← not "0d"
│                               │
│ Predecessors                  │
│  [1.3.1 FS] [1.2.4 FS+2]    │  ← chips, hidden if none
│                               │
│ Float                         │
│  3d                           │
│                               │
│ Progress                      │
│  Not yet reached              │  ← no progress bar
└──────────────────────────────┘
```

### `EstimatesSection` — hide for milestones

Add `canRender` predicate to the estimates registration in `sections/index.ts`:

```ts
registry.register('task_detail.section', {
  id: 'estimates',
  title: 'Estimates',
  component: EstimatesSection,
  priority: 800,
  canRender: ({ task }) => !task.isMilestone,   // ← new
});
```

No PERT estimates on milestones (they have no duration to estimate). The section
disappears cleanly via the existing `canRender` filter in `TaskDetailDrawer.tsx` line 104.

### `HistorySection` and `BaselineSection` — unchanged

Both sections make sense for milestones (tracking when a milestone date changed is
valuable; baseline comparison shows milestone slip). Keep as-is.

---

## States

### DependenciesTab — empty state

When a task has no predecessors and no successors:

```
Predecessors
None                     ← existing text-neutral-text-disabled
[— Add predecessor —▾] [Finish → Start▾] [Add]

Successors
None
[— Add successor —▾] [Finish → Start▾] [Add]
```

The add rows are always visible (not collapsed behind an "Add" button). This matches the
existing implementation — no change needed.

### DependenciesTab — milestone with deps

Milestones can have predecessors and successors. The DependenciesTab renders identically
for milestones and regular tasks. No special empty state for milestones.

### DepRow — type change succeeds

Type select changes value visually; no error shown; tab-level note "Successors are
automatically rescheduled" provides confirmation that cascade happened.

### DepRow — type change fails (cycle)

```
┌─────────────────────────────────────────────────────┐
│  Engine integration     [Start → Start▾] [5] d lag [×] │
│  Creates a cycle: Engine integration → Detail design C → Engine integration │
└─────────────────────────────────────────────────────┘
```

Select reverts to previous value (controlled). Error clears on next `onChange`.

### Milestone — newly created

Row appears in task list with diamond icon (◇) and selected state. Name cell is in edit
mode — user types immediately. Gantt shows a pulsing diamond at today's date.

---

## API dependencies

These surfaces are frontend-only — no new endpoints. Existing calls:

- `PATCH /api/v1/projects/{id}/dependencies/{dep_id}/` — dep type change (existing)
- `POST /api/v1/projects/{id}/tasks/` with `{ is_milestone: true, duration: 0 }` — milestone create (existing)
- `PATCH /api/v1/projects/{id}/tasks/{task_id}/` — milestone rename (existing)
- `DELETE /api/v1/projects/{id}/tasks/{task_id}/` — milestone delete (existing)

---

## Responsive notes

All four surfaces live in the Schedule view's task detail drawer:
- **Desktop (≥ md / 768px)**: 540px right-side slide-in — existing, no change to shell
- **Mobile (< md)**: 85vh bottom sheet — existing, no change to shell

The `DepRow` 3-column layout at 320px: task name `max-w-[180px]` with truncation to
prevent overflow when "Finish → Finish" select + lag input + remove button together
exceed available width.

MetaRail: at < md, the rail collapses to a stacked block above sections. The new
Predecessors row chips wrap to new lines naturally (`flex-wrap`).

**Mobile follow-ups (0.3/0.4, not in scope here)**:
- Dep-type picker on mobile should use a bottom-sheet picker, not a native select
- Milestone create on mobile: FAB → inline name entry in bottom sheet

---

## WCAG 2.1 AA checklist

| Item | Decision |
|------|----------|
| Error messages | `role="alert"` on per-row cycle error and tab-level banner |
| Focus management on drawer open | Existing — Close button receives focus (MetaRail line 50) |
| Dep-type select `aria-label` | `"Dependency type"` (DepRow) / `"Link type"` (AddDepRow) — unchanged |
| Predecessor chips | `role="button"` with `aria-label="{task name}, {dep type} dependency"` — opens Dependencies section |
| Milestone "Date" row | Screen reader reads "Date: Jul 15" — sufficient |
| Milestone progress "Not yet reached" | Plain text in a `<Row>` — no additional ARIA needed |
| Progress bar hidden for milestones | `role="progressbar"` element is removed — no stale ARIA state |
| Estimates section `canRender` | Section disappears from DOM — no orphaned tab/section label |
| Focus ring on chips | `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1` |
| Contrast: `text-neutral-text-secondary` | Passes 4.5:1 on `bg-neutral-surface` (#FFFFFF) |
| Contrast: `text-semantic-critical` | Passes 4.5:1 on `bg-neutral-surface` |

---

## Implementation checklist (for the implementer)

- [ ] `DependenciesTab.tsx` — update `DEP_TYPES` labels; render `dt.label` in both selects
- [ ] `DependenciesTab.tsx` — `DepRow.onUpdate` signature change; add `rowError` state + `onError`
- [ ] `DependenciesTab.tsx` — `parseCyclicDependencyError` / `formatCycleMessage` already imported; reuse
- [ ] `MetaRail.tsx` — Predecessors chip row (accepts `predecessorLinks` prop; hides when empty)
- [ ] `MetaRail.tsx` — Duration: show `— (milestone)` when `task.isMilestone`
- [ ] `MetaRail.tsx` — Start label: "Date" for milestones; hide Finish row for milestones
- [ ] `MetaRail.tsx` — Progress: replace bar+% with "Not yet reached" / "✓ Reached" for milestones
- [ ] `sections/index.ts` — add `canRender: ({ task }) => !task.isMilestone` to Estimates registration
- [ ] `ScheduleView.tsx` — remove `if (buildModeActive)` guard on `focus.enterCellEdit` in `handleAddMilestone`
- [ ] Verify: `handleAddMilestone` always calls `focus.focusRow(data.id)` + `focus.enterCellEdit(data.id, 'name')` unconditionally after create
- [ ] `MetaRail.tsx` — predecessor chips: add `title={chipTitle(depType, lag)}` to each chip for plain-English tooltip (e.g. "Start → Start, +5 days lag")
- [ ] `ScheduleView.tsx` — after milestone name commit, chain to date: `enterCellEdit(id, 'planned_start')` if cell is editable; otherwise open drawer with MetaRail "Date" focused; document which path in MR description
