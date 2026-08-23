---
title: "Summary Tasks and WBS Rollup"
description: "Hierarchical task grouping with duration, date, and percent-complete rollup from children."
documentedFor: "0.4"
---

Summary tasks are parent nodes in the Work Breakdown Structure (WBS). Their duration, dates, and progress are computed by the scheduler from their children — a summary is never edited directly.

Use summary tasks to group related work into phases, deliverables, or work packages.

## What rolls up

| Field | Rollup rule |
|-------|-------------|
| `start` | Earliest `start` among children |
| `finish` | Latest `finish` among children |
| `duration` | Span from `start` to `finish` (working days, per project calendar) |
| `percent_complete` | Duration-weighted average of children's `percent_complete` |
| `is_critical` | True if **any** descendant is on the critical path |

Summary tasks cannot hold resource assignments, time entries, or direct dependencies. Add those on leaf tasks; the rollup will update on the next scheduler run.

## Gantt visual

Summary bars render as an 8px-tall filled bar with filled-diamond end-caps at the start and finish dates — the same diamond geometry used for milestones, rotated 45°. The end-caps disambiguate a summary from a regular task bar at a glance.

A chevron on the summary row collapses and expands the subtree:

- `▸` — collapsed
- `▾` — expanded

Collapsing a summary only hides its descendants from the list; it does not affect the schedule or the rollup.

The row states how many tasks are in the subtree beside its name — **`4 inside`**
when the summary is open, **`4 hidden`** when it is folded. This is drawn on the
row itself, not in a tooltip: a collapsed summary is otherwise indistinguishable
from one with no children at all, and that has to survive a glance down the
outline rather than requiring a hover on every row you are unsure about. The
same words are on the chevron's accessible name, so screen-reader and sighted
users read the identical phrase.

:::note[Ships in 0.4]
The visible `4 inside` / `4 hidden` count on the row ships in 0.4. On 0.3 the
count is carried only by the chevron's tooltip and accessible name, so reading
it requires hovering the chevron, and the screen-reader announcement uses
different wording (see below).
:::

## Keyboard shortcuts (WBS view)

When a task row is focused in the WBS view:

| Shortcut | Action |
|----------|--------|
| `Alt` + `→` | Indent — make this task a child of the task above it |
| `Alt` + `←` | Outdent — move this task up one level in the hierarchy |
| `Alt` + `↑` / `Alt` + `↓` | Reorder within the current parent |
| `↑` / `↓` | Move focus to the previous / next visible task |
| `Enter` on chevron | Toggle expand / collapse of the focused summary |

Plain `Tab` and `Shift` + `Tab` are deliberately left alone on a focused row — they fall through to the browser's normal focus traversal, so a keyboard user can always Tab out of the grid.

Indent and outdent call the `useIndentTask` / `useOutdentTask` mutations. A one-line aria-live announcement ("Task indented", "Cannot outdent: task is already at root level", etc.) is emitted for screen reader users on every action.

Expanding or collapsing a summary announces `"<Name> expanded, N inside."` or
`"<Name> collapsed, N hidden."` — the same words the row and the chevron use, so
there is one vocabulary for the fact rather than one per surface. A summary with
no children states no count at all.

:::note[Ships in 0.4]
This wording ships in 0.4. On 0.3 the announcement is
`"<Name> expanded, N children visible."` / `"<Name> collapsed."`.
:::

## Drag-and-drop indent

Dragging a task row onto a summary row in the WBS view re-parents the dragged task under that summary. A drop-zone indicator highlights the target summary, and an aria-live region announces `"<Task> will become child of <Summary>"` on hover before the drop commits.

Dropping onto the empty area below a summary's children inserts at the end of that subtree. The scheduler recomputes the rollup on the next tick.

## API

```http
GET /api/v1/tasks/?project={id}
```

Returns the full hierarchy with each task's `wbs_path` (ltree) and `parent_id`. Summary rows carry a read-only `is_summary` annotation so clients can render the chevron without a second query.

See the [API reference](/api/reference/) for the complete schema.

## Source

| Path | Purpose |
|------|---------|
| `src/features/grid/OutlineMode.tsx` | Outline table with keyboard + DnD handlers |
| `src/features/schedule/engine/GanttRenderer.ts` | `drawSummaryBar` — 8px bar with diamond end-caps |
| `src/features/schedule/wbsAnnouncement.ts` | Expand / collapse aria-live formatter |
| `src/hooks/useTaskMutations.ts` | `useIndentTask`, `useOutdentTask`, `useReorderTasks` |
| `src/stores/wbsStore.ts` | Expanded / collapsed state per summary |
