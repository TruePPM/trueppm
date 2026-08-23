# Rule 243 — When a toolbar exceeds ~6 top-level affordances, group its controls into named clusters (Time / Show / Actions) and fold the display/filter controls behind a single "Display" popover — which is their home at EVERY width, never migrating into the ··· overflow

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Toolbar clustering — the Display popover is the filters' home at every width (Issue #1741)*

**When a toolbar exceeds ~6 top-level affordances, group its controls into named clusters (Time / Show / Actions) and fold the display/filter controls behind a single "Display" popover — which is their home at EVERY width, never migrating into the `···` overflow.** The Schedule (Gantt) toolbar (`features/schedule/ScheduleView.tsx`, `role="toolbar"`) was a flat ~12-control row. #1741 clustered it to ≤6 interactive affordances at lg — two primary creates (`+ Task`, `+ Milestone`), the standalone `Grid/Timeline` toggle, the **Show** cluster (a `ScheduleDisplayMenu` "Display ▾" popover holding the four view/render filters + column-visibility as `menuitemcheckbox` rows), the **Time** cluster (`role="group"` wrapping Today · Zoom · Quarter), and the **Actions** `···` (`ToolbarOverflowMenu`: Import/Export-to-MS-Project/Share) — kept single-row `flex-nowrap` (rule 113) so a missing collapse rule clips rather than wraps. `+ Phase` (#1752/#1754) and the dedicated **Export PDF** button (#2703, promoted out of the `···` overflow — see rule 110) landed after this count was fixed, so the budget is descriptive of the 2026-era toolbar's intent, not a hard ceiling re-verified per addition. The key departure from rules 111/112 (which dump *secondary* controls into the `···` overflow at sm): **filters have a permanent home in the Display popover and never move to `···`** — putting them in both places is redundant, and the popover is visible at every tier (only its trigger label collapses to icon-only below lg, rule 114). The Display trigger carries an **active-filter count badge** whose number is echoed in the trigger `aria-label` (`"Display, 2 active filters"`; the pill is `aria-hidden`, rule 6). The badge counts the four *data* filters **plus any hidden Chart element** (dependency lines off / progress pills off; task names came off this list in #2960 — see the note at the end) — so a user who turned off a chart decoration isn't left wondering where it went (#2097); **column visibility stays excluded** (hiding a table column is a layout pref, not a data filter). The popover has a permanent **Chart** section (below Columns) — a `menuitemcheckbox` for Dependency lines, a `menuitemradio` group for on-bar task-name placement (Next to bar / Hidden — see the #2960 note), and a `menuitemcheckbox` for Progress % — whose choices persist per-user in `localStorage` under `trueppm.schedule.chartDisplay.v1` (parallel to the column-widths key), **distinct from the URL-encoded data filters** (`focus/cp/crit/ms` stay shareable; chart presentation stays local). Dependency-line visibility is applied by filtering the `links` array to `[]` (so hidden arrows also drop out of hit-testing); name-placement + progress pills flow to the canvas via `engine.setChartOptions`. The **Aligned left** placement rendered task names in a fixed row-aligned left gutter drawn on the canvas in Timeline mode only (`showNameGutter`, #2096) — in Grid mode the task table already carried the names. **Neither view defaulted to a free-floating on-bar label (#2422): Grid defaulted to `hidden`, Timeline to `left`.** On-bar labels are drawn with no collision detection against dependency arrows, neighbouring bars, or each other — arrows have an ADR-0063-grade routing specification (`calculateDependencyPath`, junction rules, bridge hops) and labels have none — so an arrowhead terminates inside label text, a label renders left of its own bar and overdraws the row above, and a label collides with the assignee chip. Until the renderer measures them (#2434), the defaults keep them off the canvas: in Grid the label is redundant with the table, and in Timeline the gutter carries identity without overdrawing anything. Both remain user-selectable. The **legacy #2097 global scalar seeds Timeline only** — deliberately not Grid: that scalar was chosen when one value governed both views, so migrating it forward re-armed the redundant Grid label for every account that had ever opened the Schedule, which is why the collisions stayed reproducible long after #2107 shipped. An explicit per-view Grid choice is still honoured. The popover reuses the `ToolbarOverflowMenu` keyboard contract (rule 112: ArrowUp/Down rove focusable rows skipping section headings, Home/End, Enter/Space toggle in place with the menu staying open, Escape restores focus to the trigger, Tab/outside-pointerdown close) — non-modal, so **no focus trap** (a trap is only for modal dialogs). A cluster is a `role="group"` with an `aria-label`; hairline `w-px` dividers between clusters are `aria-hidden`. Export PDF is a primary toolbar button that disappears below `md` only as a side effect of the whole toolbar being desktop-only (rule 110's #2703 reclassification), not a PDF-specific carve-out anymore. When controls move into a popover, **every e2e/vitest assertion that located them as inline toolbar buttons must be re-anchored** to open the popover first and query `menuitemcheckbox`/`menuitem` by accessible name. Reference: `ScheduleDisplayMenu.tsx`, the toolbar block in `ScheduleView.tsx`, `SlidersIcon` in `components/Icons.tsx`.

---

## Superseded in part by #2960 — 2026-08-22

The gutter half of this record is no longer true, and following it would
reintroduce what #2960 removed. What changed and what still stands:

- **`Aligned left` and the canvas name gutter are gone.** `showNameGutter`,
  `drawTimelineNameGutter` and `NAME_GUTTER_WIDTH` are deleted, and the
  placement is out of `TIMELINE_PLACEMENTS` and out of the menu. Its premise —
  "the task table is hidden in Timeline mode" — was abolished when the Timeline
  started rendering the **same outline rows** the Grid does (web rule 321). A
  canvas-drawn name column now sits beside a real one.
- **Both views default to `hidden`.** The Grid's reason ("the task table already
  carries every name, so the on-bar label is redundant ink") became the
  Timeline's reason too. A persisted `left` falls back to `hidden`, not to
  `next` — `hidden` is the closest surviving behavior, since the names are still
  in a frozen left column, just a real one.
- **The Display badge no longer counts a hidden task name on either view.** It
  counted a hidden *Timeline* name because the canvas was the sole carrier; that
  is no longer so, and a default view would otherwise wear a spurious
  "1 active". `hiddenChartCountForView` lost its `view` parameter with it.
- **The Columns section is no longer Grid-only.** It offers exactly the columns
  the active surface draws — six on the Grid, `WBS` alone on the Timeline.
- **Unchanged and still binding:** the cluster structure, the Display popover as
  the permanent home for filters at every width, the badge's exclusion of column
  visibility, the localStorage key and its separation from the URL-encoded data
  filters, the `ToolbarOverflowMenu` keyboard contract, and the requirement to
  re-anchor e2e assertions onto the popover.

The collision problem that motivated the #2422 defaults is **not** solved — on-bar
labels still have no collision detection against arrows or neighbours (#2434).
`next` remains user-selectable and remains the thing that collides; #2960 only
capped and flipped the label so it is not clipped mid-glyph.
