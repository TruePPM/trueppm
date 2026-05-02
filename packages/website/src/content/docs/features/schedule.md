---
title: "Schedule view"
description: "Canvas-rendered Schedule (Gantt-style) with critical path, baselines, milestones, and the unscheduled gutter."
---

The **Schedule view** is TruePPM's project-timeline surface — what the rest of the industry calls a *Gantt chart*. The product's canonical name is **Schedule** (per [ADR-0030](/architecture/decisions/) and the wave/1 rename in #204) because the view does more than the historical Gantt: critical path, baselines, milestones, the unscheduled gutter, and live CPM re-forecast off sprint velocity all live in the same canvas.

:::note[A note on "Gantt"]
*Gantt chart* is the well-known industry term and is what most evaluators search for. We use **Schedule** in product copy and route names; the underlying paradigm is still a Gantt. The two words refer to the same thing in this docs site.
:::

## Where this lives in the story

Step 2 ([Schedule the skeleton — CPM, milestones, baseline](/the-story/#2-schedule-the-skeleton--cpm-milestones-baseline)) and Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/) — Raj's home; the view that auto-re-forecasts when the team moves a card on the board.

## Where to find it in the app

- Route: `/projects/:projectId/schedule`
- Tab: **Schedule** (visible by default for HYBRID and WATERFALL projects per [methodology preset](/features/methodology-preset/))

## Layout

Split-pane: a virtualised task list on the left (Task / Dur / Start / Finish / % columns; resizable; persisted via `localStorage`), and the canvas timeline on the right. Scroll is synchronised in both directions.

## Canvas renderer

TruePPM ships its own canvas Schedule renderer in `packages/web/src/features/schedule/engine/`. It replaced an earlier SVAR React Gantt integration to remove third-party constraints on drag UX, accessibility (ARIA grid overlay), and dark-mode rendering. Three layered canvases (background, bars, interaction) are dirty-rect repainted; row virtualisation is mandatory from the first commit. See [ADR-0040](/architecture/decisions/) for the full rationale.

## Bar types

| Bar type | Token | Meaning |
|----------|-------|---------|
| Normal | `barNormal` | Standard task, not on the critical path |
| Critical | `barCritical` (`semantic-critical`) | Task is on the critical path (total float = 0) |
| Complete | `barComplete` (`semantic-on-track`) | Task marked as 100% complete |
| Summary | `barSummary` 8px tall | WBS parent / summary row |
| Milestone | Diamond | Zero-duration event (`is_milestone=true`) |
| Baseline ghost | `ghost-fill`/`ghost-border` 6px | Original planned dates rendered below the live bar |

Bar labels use `COLOR.text` (`#1A1917` light / palette swap in dark mode). The canvas font is set once at engine init to the Tailwind `font-sans` stack so labels match the task list typography.

## Dependency types

All four standard dependency types render as cubic-Bézier arrows on the timeline:

| Type | Name | Meaning |
|------|------|---------|
| FS | Finish-to-Start | Successor starts after predecessor finishes |
| SS | Start-to-Start | Successor starts after predecessor starts |
| FF | Finish-to-Finish | Successor finishes after predecessor finishes |
| SF | Start-to-Finish | Successor finishes after predecessor starts |

Critical-path arrows use `COLOR.arrowCritical` (semantic-critical); non-critical use `COLOR.arrowNormal`.

## Zoom

Toolbar zoom levels: Day · Week · Month (default) · Quarter. Zoom preserves the viewport-centre date — the visible range shifts symmetrically around the user's current view midpoint.

## Interaction

- **Drag-to-reschedule** with a 4-pixel hover threshold and FSM (`IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED`)
- **Snap-to-day** is applied inside the renderer before emitting `drag-task-move`; hold Shift to suspend snap
- **Pointer events** throughout (no mouse/touch branching); pinch-to-zoom via two simultaneous active pointers
- **Keyboard reschedule** as a WCAG 2.1.1 alternative (left/right arrows nudge dates; Enter confirms; Esc cancels) — see issue #34

## Accessibility

The canvas is `aria-hidden="true"`; a transparent DOM overlay (`GanttAriaOverlay`) provides the WCAG 2.1 grid structure (`role="grid"` → `role="row"` → `role="gridcell"`). Roving tabindex; `engine.scrollToDate()` is called before `.focus()` so virtualised rows scroll into view before keyboard focus lands.

## Schedule deep-link

The [Advancing-to-Milestone card](/features/sprints/) on the Sprints view links into this Schedule view scrolled to a specific milestone task via the URL hash (`#task-<uuid>`). That's how the Sprints workspace bridges back to the Schedule without forcing the user to find the milestone manually.

## Related ADRs

- [ADR-0030](/architecture/decisions/) — Schedule rename (Gantt → Schedule), tab order
- [ADR-0040](/architecture/decisions/) — Wave/3 Schedule: bar render, task drawer, unscheduled gutter, canvas rationale
- [ADR-0027](/architecture/decisions/) — Incremental CPM recompute (subgraph delta strategy)

## If you are…

- **Raj (PM)** — this is your home. The critical path lights up automatically; baselines overlay as ghosts; the milestone diamonds are your contractual signal.
- **Maya (Scrum Master)** — you don't open this. The deep-link from the Sprints workspace's milestone card is the rare case you'd land here.
- **Tom (engineer)** — you don't open this either. The Schedule auto-re-forecasts off your board moves.
