---
title: Schedule Toolbar
description: Reference for the Schedule view toolbar — filter groups, summary chip, column controls, and zoom.
documentedFor: "0.4"
---

The Schedule view's toolbar gives you the at-a-glance project status (rightmost summary chip), the day-to-day filtering controls (toggle groups), and the three primary authoring actions (`+ Task`, `+ Milestone`, `+ Phase`).

## Toolbar layout

```
[ + Task ] [ + Milestone ]   ( + Phase · Group · Ungroup — off by default )   [ Build mode pill ]
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

- **Grid** (default) — the full task-list table (WBS, Task, Links, Dur, Start, Finish, %,
  Owner) sits to the left of the bars, with a draggable splitter between them.
- **Timeline** — the outline narrows to **WBS + Task**, and Links, Duration, Start,
  Finish, % and Owner give their width to the bar track. Links is absent there on
  purpose: the canvas already draws the dependency arrows. Nothing about the plan's shape is hidden:
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

## Building phases

Ships in 0.4 (Schedule/Gantt only — a phase-authoring action never appears on the board, sprints, or My Work).

A **phase** is a WBS summary row — a non-subtask task with at least one structural child. It isn't a new task type: any summary task with a "real" (non-subtask) child under it is automatically a phase, the same way a task with subtasks is automatically a summary.

There are two ways to end up with one, and they suit opposite ways of working. **Top-down**, you create the phase first and then fill it — that is `+ Phase`, or indenting a row under the one above it with `⌥→`. **Bottom-up**, you type the work first, look at it, and *then* see the phases in it — that is **Group**, which puts a phase around rows that already exist.

### The three structure controls are off by default

`+ Phase`, **Group** and **Ungroup** live together in the toolbar behind one setting, and that setting starts **off**. The keyboard shortcuts below work regardless. To show the buttons, open **Display → Outline → Phase, Group and Ungroup buttons**.

They are in the toolbar rather than on a row because they are the only structure actions with no per-row equivalent: Group acts on a *selection*, and Ungroup acts on a container's whole contents. Everything else — indent, outdent, move, delete — is on the row menu where the row is.

All three are absent entirely for the **Viewer** role, and present-but-disabled for an editor who has switched to Read.

### Selecting the rows to wrap

- **⇧↑ / ⇧↓** — extend the selection one row at a time from where it started.
- **⌘A / Ctrl + A** — every sibling of the focused row; press it again for the whole visible tree.
- **Shift + click** — extend the selection to the row you click.

### Group — `⌥⌘G` / `Alt + Ctrl + G`

Puts a phase *around* the selected rows and drops straight into naming it. The phase's dates, status and estimate roll up from the work inside, so there is nothing else to fill in — which is why the name comes last.

Two rules decide what actually gets wrapped, and TruePPM tells you when they applied:

- A row whose own ancestor is also selected is **left where it is** — it is already inside the phase you selected, and wrapping both would either duplicate or flatten the subtree.
- The phase is created on the parent shared by **most** of the remaining rows; rows under a different parent are left where they are.

Either way the outcome strip above the outline says how many rows became a phase and how many stayed put, with the reason. Nothing is silently dropped.

The whole group is **one** change: `⌘Z` reverses it in a single step, not four.

### Ungroup — `⌥⇧⌘G` / `Alt + Shift + Ctrl + G`

Dissolves the focused phase and lifts its rows one level, **keeping their links, owners and estimates**. Only the wrapper goes. Dependency links that pointed at the wrapper itself go with it, and the outcome strip says how many.

This is deliberately a different key from outdent (`⌥←`): outdenting *one* row moves that row and leaves the phase standing; dissolving a phase removes it and moves everything it held. `⌘Z` puts the phase back.

### `+ Phase` — `⌥⌘P` / `Alt + Ctrl + P`

Creates a phase **with its first task already in it**, at your currently-focused insertion point (same phase-nesting inference as `+ Task` / `+ Milestone`), and opens the phase's name for editing. A button never leaves an empty phase behind.

A **phase-in-waiting** — a summary row with no structural child yet — is still a legitimate state; you can reach one by other routes, and the row shows a dashed "⊕ Add first task to this phase" hint in place of the assignee display until it gains a child.

Once a row is a phase, its rollup behavior matches every other WBS summary task (dates and percent complete roll up from children) with a few phase-specific locks: it can't take a direct assignee, a direct time log, or (once #1755 lands) a sprint assignment — dependency and baseline rollups still apply normally.

## Task-list columns

The task list shows eight columns by default in **Grid**. All except Task can be hidden via the **Columns** popover — which offers exactly the columns the current layout draws, so in **Timeline** (WBS + Task) it offers WBS alone rather than six checkboxes that would change nothing. A column you hide in Grid stays hidden in Timeline; switching layout never brings one back.

| Column | Width | Content |
|---|---|---|
| WBS | 48 px | Dot-path numbering (`1.1.2`). Long paths truncate with a hover tooltip. |
| Task | flex | Name + chevron for summary expand/collapse + WBS indent. |
| Links | 104 px | The row's dependency flags — see below. Each is a control. |
| Dur | 52 px | Duration in working days (`5d`). |
| Start | 74 px | Computed early start (read-only — change Planned Start to override). |
| Finish | 74 px | Computed early finish (read-only). |
| % | 44 px | Percent complete. |
| Owner | 72 px | Up to three 24 px assignee avatars overlapping; "+N" overflow chip. |

Column widths are persisted per-browser under `trueppm.schedule.columnWidths.v5`.

### The Links column

:::note[Ships in 0.4]
On 0.3 a row's dependencies show as `←2` / `→1` **count** chips beside the task name, and
only while the row is selected with **Focus chain** on. There is no Links column, and the
only way to add a link is the row's right-click menu. The description below is the 0.4
behavior.
:::

The Links cell states the *shape* of a row's dependencies rather than only how many there
are, because a count cannot tell a chain from an overlap:

| Flag | Means |
|---|---|
| `←FS` | One predecessor, finish-to-start. |
| `←FS×2` | Two predecessors that **agree** — a chain. |
| `←FS·SS` | Two predecessors of **different** types — an overlap. |
| `←Mixed×4` | Four predecessors spanning three or more types. Hover for the breakdown. |
| `→…` | The same three forms for successors — what this row governs. |

Hovering a flag (or reading the cell with a screen reader) gives the full detail: how many
links, of which types, the lead/lag on each, and whether the chain is on the critical
path — `2 predecessors: Finish-to-Start, Start-to-Start +2d — on the critical path`. A
critical flag is also tinted and outlined, but the words are what carries it: color alone
would leave the fact unavailable to screen readers and to anyone with a red deficiency.

Each flag is a **control**, and each opens its own direction — clicking `←FS×2` opens the
predecessor picker, clicking `→FS` the successor picker — the same pickers the row's
right-click menu opens. Seeing what a row is linked to and changing it therefore happen in
the same place. A row with **no** links reads as a muted `—`, and that dash is itself the
"add a link" control.

If your project role does not allow editing tasks, the cell shows the identical flags as
plain text with nothing to click.

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
