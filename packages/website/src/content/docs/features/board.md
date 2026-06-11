---
title: Board (Kanban)
description: Kanban board with a backlog rail, phase swimlanes, and configurable working columns for tracking task execution within a project or sprint.
---

The **Board** tab is the primary execution surface in TruePPM. It presents the project's tasks as cards in a Kanban layout and stays in sync with the Schedule view via WebSocket — moving a card here updates the task's status everywhere.

## Board layout

The board has two zones:

- **Backlog** — `BACKLOG` cards live in a dedicated surface *beside* the working columns, not as a column of their own. Backlog is intake — undated, unrefined, not-yet-committed work — so it stays phase-agnostic and visible while you work the active board. Three layout variants are available from the toolbar's segmented control: **Rail** (left-side band, the default), **Drawer**, and **Queue**.
- **Working columns** — the committed-work columns, rendered as **phase swimlanes** (one lane per phase in the WBS). Columns are configurable per project — labels, visibility, WIP limits, and accent colors — and default to:

| Column | Status value | Meaning | Default WIP limit |
|--------|-------------|---------|-------------------|
| To Do | `NOT_STARTED` | Committed; work has not begun | — |
| In Progress | `IN_PROGRESS` | Work is active | 5 |
| Review | `REVIEW` | Work complete; awaiting review / sign-off | 3 |
| Done | `COMPLETE` | Done | — |

Dragging a card from the backlog into a working column commits it (status changes to the column's status). Dragging a To Do card back to the backlog opens a confirmation dialog — demoting committed work is a deliberate decision. Cards that are In Progress or beyond cannot be demoted to the backlog.

The legacy `ON_HOLD` status is kept for data compatibility with pre-0.1 projects but does not appear as a column; on the board it is treated like Backlog for drag guards.

## Board cards

Each card shows:

- **Task name** and WBS short ID
- **Assignee avatars** (up to three, with +N overflow)
- **Readiness chip** — `idea` / `estimated` / `ready` / `baselined`
- **Risk badge** — count of linked active risks, colored by max severity
- **Blocked indicator** — shown when any predecessor is not yet `COMPLETE`
- **Sprint chip** — when the task is committed to a sprint
- **Progress ring** — % complete, fills as work progresses
- **CPI badge** — cost performance index when cost data is available (board batch 4)

## Moving cards

Drag a card to a new column to change its status. The status change is optimistic: the card moves immediately, and the API call fires in the background. If the API call fails, the card snaps back with a toast.

**Keyboard alternative**: every card's `···` overflow menu includes a **Move to…** item with a submenu. Arrow keys navigate the submenu; Enter commits. An `aria-live` region announces the move.

## Toolbar

The board toolbar (top of the board) groups its controls into four clusters:

- **Primary chips** — **Group**, **Sort**, and **Density** popovers (card density, plus a separate backlog-card density)
- **Quiet toggles** — **My tasks** (only tasks assigned to you), **At-risk**, and **Cost**
- **Layout segmented control** — **Rail · Drawer · Queue** backlog layout variants
- **More⋯ overflow** — collapse/expand all lanes, **WIP** limit chips, column **Tints**, **EVM** mode, and the **Columns** configuration panel

## Readiness states

Readiness is computed server-side from the task's data, resolved in this order (highest specificity first):

| State | Condition |
|-------|-----------|
| `baselined` | Task is in the active baseline (always wins) |
| `idea` | No assignee **and** still in `BACKLOG` (unrefined, uncommitted) |
| `ready` | Has an assignee + at least one predecessor link |
| `estimated` | Has an assignee without predecessors, **or** was promoted out of `BACKLOG` without an assignee (committed but unowned) |

`idea` only applies while the task is in the backlog: once a card moves to any working column, a commitment decision has been made, so it reads as `estimated` even with no assignee.

The readiness chip drives the card's left accent bar color (overridden by `isCritical` → red).

## WIP overload

When a column exceeds its configured WIP limit, the column header turns amber and a warning badge appears. See [WIP Overload](/features/wip-overload/) for details.

## Sprint integration

When a sprint is active, committed tasks appear in the **To Do → In Progress → Review → Done** columns as normal. Sprint-committed tasks are never shown in the Unscheduled gutter on the Schedule view, regardless of whether they have a planned start date.

### Sprint view

:::note[0.3]
The board sprint-view switcher lands in 0.3.
:::

By default the board shows every committed task in the project. A **scope switcher** in the toolbar (next to the saved-views dropdown) will let you focus the phase columns on a single sprint:

- **Project** — the default; all committed tasks.
- **A sprint** — only tasks committed to the selected sprint. The dropdown lists **active**, **planned**, and **completed** sprints (viewing a closed sprint's board is a legitimate retrospective read).

The selection persists in a `?sprint=` URL parameter, so a sprint-scoped board is a shareable link. The **backlog rail is unaffected** — it stays the intake source you drag from. While viewing an **active** or **planned** sprint, dragging a card from the backlog (or another phase) into a phase column **assigns it to that sprint** — for an active sprint it enters the team's [scope-injection review](/features/sprints/) as a pending item. A completed-sprint view is read-only for assignment.

## Mobile

On viewports below 768px the board switches to a horizontal snap-scroll layout: one column visible at a time (85vw width, `scroll-snap-align: start`). A dot-strip indicator below the board shows which column is visible. The mobile FAB creates a task in the first visible column.

## Permissions

| Action | Minimum role |
|--------|-------------|
| View the board | Viewer |
| Move cards, update status | Member |
| Create tasks from the board | Member |
