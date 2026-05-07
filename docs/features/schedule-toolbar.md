# Schedule view — toolbar reference

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
- **`CPM …`** (italic): a recompute is in flight. The two `··` placeholders preserve chip width so the toolbar doesn't reflow during recompute.

The chip also acts as a `role="status"` announcement for screen readers — every state change is read aloud as `"Project status: 14 tasks, 4 critical, CPM healthy"`.

## Adding a milestone

Two paths:
- **Click `+ Milestone`** in the toolbar (peer to `+ Task`).
- **Press ⌘M (macOS) / Ctrl + M (Windows / Linux)** when the Schedule view has focus.

Both insert a new milestone at today's date with an empty name field. The milestone's `parent_id` is inferred from your currently-focused row — if you have a phase summary selected (or any task inside it), the new milestone lands under that phase. Otherwise it lands at the project root.

The diamond pulses on the timeline for 1.5 s after insert so you can see where it landed (the pulse is suppressed under `prefers-reduced-motion`). A polite live-region announcement reads `"Milestone {name} inserted at {date}"`.

The button is disabled with a "Read-only access" tooltip if your project role is **Viewer** (role 0) — only Members and above can create milestones.

## Task-list columns

The task list now shows seven columns by default. All except Task can be hidden via the **Columns** popover.

| Column | Width | Content |
|---|---|---|
| WBS | 48 px | Dot-path numbering (`1.1.2`). Long paths truncate mid-string with a hover tooltip showing the full path. |
| Task | flex | Name + chevron for summary expand/collapse + WBS indent. |
| Dur | 52 px | Duration in working days (`5d`). |
| Start | 74 px | Computed early start (read-only — change Planned Start to override). |
| Finish | 74 px | Computed early finish (read-only). |
| % | 44 px | Percent complete. |
| Owner | 72 px | Up to three 24 px assignee avatars overlapping; "+N" overflow chip when more. Empty cell on summary tasks (assignees roll up implicitly). |

Column widths are persisted per-browser under `trueppm.schedule.columnWidths.v5`.

## See also

- [Schedule build mode](schedule-build-mode.md) — keyboard-first editing surface (opt-in, `schedule_build_mode_v1` flag)
- [ADR-0056 — Schedule render parity & milestone toolbar](../adr/0056-schedule-render-parity-and-milestone-toolbar.md)
