---
title: Schedule Toolbar
description: Reference for the Schedule view toolbar — filter groups, summary chip, column controls, and zoom.
---

The Schedule view's toolbar gives you the at-a-glance project status (rightmost summary chip), the day-to-day filtering controls (toggle groups), and the two primary authoring actions (`+ Task`, `+ Milestone`).

## Toolbar layout

```
[ + Task ] [ + Milestone ] [ Build mode pill ]
[ CP only · Focus chain ]   [ Critical path · Milestones ]
                                 ...
[ {N} tasks · {C} critical · CPM ✓ ]   [ Today ]   [ Day · Week · Month · Quarter ]
```

## Filter groups

Filters are split into two clusters so they don't read as a "pick one of four" radio. All four can be on at once.

**View filters** — change which rows appear in the task list:
- **CP only** — collapse to the critical path only (and the summary tasks above them, so the WBS hierarchy stays intact).
- **Focus chain** — when a task is selected, dim every task that isn't a predecessor or successor of it.

**Render filters** — change which bars draw on the Gantt timeline:
- **Critical path** — show only critical-path bars + summaries (other tasks render their list row but their bars are hidden).
- **Milestones** — show only milestone diamonds + summaries.

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

## Task-list columns

The task list shows seven columns by default. All except Task can be hidden via the **Columns** popover.

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

## Zoom levels

The zoom control (rightmost, above the summary chip) cycles through: **Day · Week · Month · Quarter · Year**. Zoom preserves the center date — the visible range shifts symmetrically around your current viewport midpoint.

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

- [Schedule build mode](./schedule-build-mode) — keyboard-first plan authoring (opt-in flag)
- [Schedule view](./schedule) — overview of the full Schedule feature
