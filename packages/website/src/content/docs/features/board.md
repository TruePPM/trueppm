---
title: Board (Kanban)
description: Five-column Kanban board for tracking task execution within a project or sprint.
---

The **Board** tab is the primary execution surface in TruePPM. It presents the project's tasks as cards in a five-column Kanban layout and stays in sync with the Schedule view via WebSocket — moving a card here updates the task's status everywhere.

## Column layout

| Column | Status value | Meaning |
|--------|-------------|---------|
| Backlog | `BACKLOG` | Identified but not yet committed |
| Not Started | `NOT_STARTED` | Committed; work has not begun |
| In Progress | `IN_PROGRESS` | Work is active |
| Review | `REVIEW` | Work complete; awaiting review / sign-off |
| Complete | `COMPLETE` | Done |

The legacy `ON_HOLD` status is kept for data compatibility with pre-0.1 projects but does not appear as a column; it maps to Backlog on import.

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

## Filtering

The filter bar (top of the board) supports:

- **My tasks** — show only tasks assigned to the current user
- **Sprint** — filter to a specific sprint
- **Hide subtasks** — collapse subtask cards to declutter the view

## Readiness states

Readiness is computed server-side from the task's data:

| State | Condition |
|-------|-----------|
| `idea` | No assignee |
| `estimated` | Has an assignee |
| `ready` | Has assignee + at least one predecessor link |
| `baselined` | Task is in the active baseline |

The readiness chip drives the card's left accent bar color (overridden by `isCritical` → red).

## WIP overload

When a column exceeds its configured WIP limit, the column header turns amber and a warning badge appears. See [WIP Overload](./wip-overload) for details.

## Sprint integration

When a sprint is active, committed tasks appear in the **Not Started → Review → Complete** columns as normal. Sprint-committed tasks are never shown in the Unscheduled gutter on the Schedule view, regardless of whether they have a planned start date.

## Mobile

On viewports below 768px the board switches to a horizontal snap-scroll layout: one column visible at a time (85vw width, `scroll-snap-align: start`). A dot-strip indicator below the board shows which column is visible. The mobile FAB creates a task in the currently-visible column.

## Permissions

| Action | Minimum role |
|--------|-------------|
| View the board | Viewer |
| Move cards, update status | Member |
| Create tasks from the board | Member |
