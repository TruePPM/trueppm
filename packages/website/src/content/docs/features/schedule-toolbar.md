---
title: Schedule Toolbar
description: Reference for the Schedule view toolbar — filter groups, summary chip, column controls, and zoom.
documentedFor: "0.4"
---

The Schedule view's toolbar gives you the at-a-glance project status (rightmost summary chip), the day-to-day filtering controls (toggle groups), and the three primary authoring actions (`+ Task`, `+ Milestone`, `+ Phase`).

## Toolbar layout

```
[ + Task ] [ + Milestone ] [ + Phase ] [ Build mode pill ]
[ CP only · Focus chain ]   [ Critical path · Milestones ]
                                 ...
[ {N} tasks · {C} critical · CPM ✓ ]   [ Grid | Timeline ]   [ Today ]   [ − {level} + ] [ Fit ]
```

## Layout: Grid and Timeline

:::note[Ships in 0.4]
On 0.3, **Timeline** hides the task list entirely and the canvas spans the full width,
painting each task's name beside its bar — or, with **Task names → Aligned left**, into a
gutter the canvas draws at its own left edge. The description below is the 0.4 behavior:
the outline stays on screen in both layouts, and the **Aligned left** placement is removed
because the outline provides that column for real.
:::

A `Grid | Timeline` toggle controls how much of the schedule the view devotes to the
table versus the bars. **Both layouts render the same rows** — the same order, the same
nesting, the same collapsed phases, the same fold carets, mode gutters, drag grips and
insert points. What changes is only how many columns the outline gives you:

- **Grid** (default) — the full task-list table (WBS, Task, Dur, Start, Finish, %, Owner)
  sits to the left of the bars, with a draggable splitter between them.
- **Timeline** — the outline narrows to **WBS + Task**, and Duration, Start, Finish, %
  and Owner give their width to the bar track. Nothing about the plan's shape is hidden:
  a phase is still a phase, a collapsed phase is still collapsed, and collapsing one here
  keeps it collapsed when you switch back.

Because the outline is present in both layouts, a task's name is always in a real,
row-aligned column two cells to the left of its bar. On-bar names are therefore optional
in both (see **Task names** below), and a milestone's name is never repeated in the track.

Drag the splitter to trade outline width for bar-track width. It stops before the bar
track gets too narrow to read, so the timeline cannot be pushed off the edge of the window.

The choice is a per-user view preference saved in your browser, so the Schedule reopens in
the layout you last used.

## Filter groups

Filters are split into two clusters so they don't read as a "pick one of four" radio. All four can be on at once.

**View filters** — change which rows appear in the task list:
- **CP only** — collapse to the critical path only (and the summary tasks above them, so the WBS hierarchy stays intact).
- **Focus chain** — when a task is selected, dim every task that isn't a predecessor or successor of it.

**Render filters** — change which bars draw on the Gantt timeline:
- **Critical path** — show only critical-path bars + summaries (other tasks render their list row but their bars are hidden).
- **Milestones** — show only milestone diamonds + summaries.

**Chart** — control what the timeline paints (presentation, not a data filter):
- **Dependency lines** — show or hide all dependency arrows.
- **Task names** — place on-bar names **Next to bar** or **Hidden**. This placement is remembered **independently for Grid and Timeline** — the sub-label names the view it applies to (*Task names (Grid)* / *Task names (Timeline)*) — and both default to **Hidden**, because the outline already shows every name in both layouts. Choose **Next to bar** where a name riding along with its bar as you scroll is worth the extra ink; the label caps with an ellipsis to the room it has, and flips to the left of the bar when the bar runs long. (0.3 offered a third placement, **Aligned left**, which drew a name column onto the canvas for the layout that hid the outline. 0.4 removes it, and an existing preference for it becomes **Hidden**.)
- **Progress %** — show or hide the on-bar completion pills.

Chart choices are saved per-user in your browser. Unlike the view/render filters (which are encoded in the URL so a filtered view is shareable), Chart choices are personal presentation preferences and stay local. Hiding a Chart element lights the Display trigger's badge so nothing disappears silently (a hidden on-bar task name is the one exception, on either layout — the name is still right there in the outline, so the badge stays quiet), and a PDF export opens matching what you see — hide the dependency lines and the export's arrow toggle starts off to match.

## Summary chip

Rightmost in the toolbar (above the Today + Zoom controls). Format: `{N} tasks · {C} critical · CPM ✓`.

- **`✓`** (green): CPM ran successfully against the current data.
- **`⚠`** (amber): the scheduling engine reported an error — usually a cyclic dependency. Open the Schedule's status banner or check task dependencies.
- **`CPM …`** (italic): a recompute is in flight.

The chip is a `role="status"` announcement for screen readers — every state change is read aloud.

## Adding a milestone

Two paths:
- **Click `+ Milestone`** in the toolbar.
- **Press ⌘M (macOS) / Ctrl + M (Windows / Linux)** when the Schedule view has focus.

Both insert a new milestone at today's date with an empty name field. The milestone's `parent_id` is inferred from your currently-focused row — if you have a phase summary selected (or any task inside it), the new milestone lands under that phase. Otherwise it lands at the project root.

The diamond pulses on the timeline for 1.5s after insert (suppressed under `prefers-reduced-motion`). A polite live-region announcement reads `"Milestone {name} inserted at {date}"`.

The button is disabled with a "Read-only access" tooltip for **Viewer** role.

## Adding a phase

Ships in 0.4 (Schedule/Gantt only — a phase-authoring action never appears on the board, sprints, or My Work).

A **phase** is a WBS summary row — a non-subtask task with at least one structural child. It isn't a new task type: any summary task with a "real" (non-subtask) child under it is automatically a phase, the same way a task with subtasks is automatically a summary.

Two paths:
- **Click `+ Phase`** in the toolbar (the summary-bracket icon, distinct from the milestone's gold diamond).
- **Press ⌘P (macOS) / Ctrl + P (Windows / Linux)** when the Schedule view has focus.

Both insert a new summary row at your currently-focused insertion point (same phase-nesting inference as `+ Task` / `+ Milestone`) and drop it straight into inline rename. Because a freshly inserted row has no children yet, it isn't a phase yet either — it's a **phase-in-waiting**, and the row shows a dashed "⊕ Add first task to this phase" hint in place of the assignee display. Clicking the hint nests a first structural child under it; once that child exists, the row becomes a real phase and the hint retires. An empty phase-in-waiting is a legitimate state — nothing forces you to add a child immediately.

Once a row is a phase, its rollup behavior matches every other WBS summary task (dates and percent complete roll up from children) with a few phase-specific locks: it can't take a direct assignee, a direct time log, or (once #1755 lands) a sprint assignment — dependency and baseline rollups still apply normally.

The button is disabled with a "Read-only access" tooltip for **Viewer** role.

## Task-list columns

The task list shows seven columns by default in **Grid**. All except Task can be hidden via the **Columns** popover — which offers exactly the columns the current layout draws, so in **Timeline** (WBS + Task) it offers WBS alone rather than five checkboxes that would change nothing. A column you hide in Grid stays hidden in Timeline; switching layout never brings one back.

| Column | Width | Content |
|---|---|---|
| WBS | 48 px | Dot-path numbering (`1.1.2`). Long paths truncate with a hover tooltip. |
| Task | flex | Name + chevron for summary expand/collapse + WBS indent. |
| Dur | 52 px | Duration in working days (`5d`). |
| Start | 74 px | Computed early start (read-only — change Planned Start to override). |
| Finish | 74 px | Computed early finish (read-only). |
| % | 44 px | Percent complete. |
| Owner | 72 px | Up to three 24 px assignee avatars overlapping; "+N" overflow chip. |

Column widths are persisted per-browser under `trueppm.schedule.columnWidths.v5`.

## Zoom

The zoom control (rightmost, above the summary chip) is a stepper — **−**, the current level, and **+** — plus a **Fit to project** button that frames the whole project in the viewport. Zoom is continuous from hour-level detail out to a multi-year overview; the date header automatically re-emphasizes its unit (day → week → month → quarter → year) as you scale. You can also zoom with **Ctrl/Cmd** + mouse wheel or a trackpad pinch over the timeline (which zooms toward the cursor), or with `⌘/Ctrl` + `=` / `-` / `0`. See [Zoom on the Schedule view](/features/schedule/#zoom) for the full reference.

The **Today** button scrolls the timeline so today's date lands at 25% from the left edge.

## Fiscal quarters

At **Quarter** (and Year) zoom the timeline header groups and labels quarters by
your workspace fiscal year rather than the calendar. A workspace whose fiscal
year starts in April shows Q1 = Apr–Jun, labeled `Q1 FY27` — fiscal years are
named by the calendar year in which they end. The major (year) row shows the
fiscal year (`FY27`) and quarter boundaries fall on fiscal, not calendar, edges.

A **Quarters: Fiscal ▾** control appears next to the zoom buttons at quarter and
year zoom. It is a per-user view preference (remembered in your browser), not a
project or workspace setting:

- **Fiscal** (default) — follows the workspace fiscal-year start.
- **Calendar** — plain Jan–Mar = Q1, labeled `Q1 2026`.

The control is hidden when the workspace fiscal year starts in January, because
fiscal and calendar quarters are then identical. The fiscal-year start itself is
set by a workspace admin under
[Workspace → Settings → General](/administration/workspace-settings/#fiscal-year-start).

On tablet widths the toggle folds into the toolbar overflow (⋯) menu as a
**Fiscal quarters** checkbox.

## See also

- [Schedule build mode](/features/schedule-build-mode/) — keyboard-first plan authoring
- [Schedule view](/features/schedule/) — overview of the full Schedule feature
