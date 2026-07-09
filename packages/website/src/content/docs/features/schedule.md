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

Split-pane: a virtualized task list on the left (seven columns — WBS, Task, Dur, Start, Finish, %, Owner — all but Task hideable and resizable, persisted via `localStorage`), and the canvas timeline on the right. Scroll is synchronized in both directions.

:::tip[Build the plan from the keyboard]
To lay out the WBS quickly — type a task, `Tab` to indent, `Space` to complete, `F2` to edit — turn on [Schedule build mode](/features/schedule-build-mode/), a keyboard-first construction surface for the task list. It builds the schedule; sprint planning still lives on the [Board](/features/board/).
:::

## Task detail drawer

Clicking a task row opens a right-side drawer (a bottom sheet on mobile). The
header shows the WBS number, a readiness chip, a **CP** marker when the task is
on the critical path, and the task name as an inline-editable field. Below it,
the drawer groups everything about the task into four tabs:

- **Details** — a schedule strip (Start, Finish, Duration, Float, with a
  critical-path banner when float is zero), status and progress, assignees, the
  description, dependencies, and the secondary planning sections (sprint,
  estimates, recurrence).
- **Subtasks** — the checklist breakdown, with a done/total count on the tab.
- **Activity** — comments, the activity timeline, field history, and baseline.
- **Files** — attachments and external links.

Most fields autosave the moment you change them — picking a status, nudging
progress, ticking a subtask, posting a comment, or attaching a file all take
effect immediately. The one exception is the free-text **Description**: it edits
locally and a save bar appears while you have unsaved changes, so a half-typed
note is never committed by accident. That edit still flushes automatically when
you blur the field, switch tabs, or close the drawer, and a notice warns you if
someone else changed the description while you were typing.

The Description supports lightweight **Markdown** — `**bold**`, bullet and
numbered lists, and `` `inline code` `` — so acceptance criteria, checklists,
and governance notes stay scannable. When the field is unfocused it renders the
formatted result; click it to edit the raw Markdown, and blur to return to the
rendered view. Viewers see the rendered description read-only.

The tabs are extension points: each section registers against the
`task_detail.section` slot with a priority and a tab, so TruePPM Enterprise can
add its own sections without the community edition knowing about them.

## Canvas renderer

TruePPM ships its own canvas Schedule renderer in `packages/web/src/features/schedule/engine/`. It replaced an earlier SVAR React Gantt integration to remove third-party constraints on drag UX, accessibility (ARIA grid overlay), and dark-mode rendering. Three layered canvases (background, bars, interaction) are dirty-rect repainted; row virtualization is mandatory from the first commit. See [ADR-0040](/architecture/decisions/) for the full rationale.

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

Finish-to-Start dependencies render as collision-avoiding Manhattan-routed arrows; the other three (SS, FF, SF) render as cubic-Bézier curves:

| Type | Name | Meaning |
|------|------|---------|
| FS | Finish-to-Start | Successor starts after predecessor finishes |
| SS | Start-to-Start | Successor starts after predecessor starts |
| FF | Finish-to-Finish | Successor finishes after predecessor finishes |
| SF | Start-to-Finish | Successor finishes after predecessor starts |

All dependency arrows are drawn in charcoal (`COLOR.arrowNormal`) — critical-path state is conveyed by the bar color, not the arrow. Arrows route orthogonally and divert around intervening task bars and milestone diamonds, so a line never visually pierces another row's object on its way to the successor.

## Creating a dependency

**Drag-to-link (mouse / trackpad).** Hover a task bar to reveal its link handle, then drag from it to another bar to draw a **Finish-to-Start** dependency — the bar you start on becomes the predecessor, the bar you drop on the successor. A dashed guide line follows the cursor while you hunt; it snaps solid with a target ring over a valid successor, and shows a *not-allowed* cursor over an invalid drop (such as a link back to the same task). Release to create the link: the dependency arrow appears immediately, so the drawn arrow is its own confirmation. A drop that would form a cycle is refused with an error. Drag-to-link is pointer-fine only — on touch, and for keyboard users, use the picker below; the two are equivalent.

The **picker** — a search-and-pick dialog for the same result, and the way to create the other three dependency types — opens from two places:

- **Right-click a task row** in the task list and choose **Add predecessor…** or **Add successor…**.
- **Open the task detail drawer**, expand the **Dependencies** section, and use the same **Add predecessor** / **Add successor** controls — or, for a task in another project, the **Search another project in this program…** link underneath them.

For a standalone project, the picker searches only that project's tasks. For a project that belongs to a program, it gains a **This project / Program** toggle: Program scope searches every sibling project in the program and groups the results by project, so you can gate a task against work owned by another team. A cross-project link you create may land as **pending** rather than immediately active — see [Program schedule](/features/program-schedule/) for how the counterpart team accepts it and how the link is drawn once accepted.

## Zoom

You can zoom smoothly from hour-level detail all the way out to a multi-year overview — there are no fixed steps to click through. As you zoom, the two-row date header automatically changes the unit it emphasizes (day → week → month → quarter → year) so the timeline always stays readable.

Three ways to zoom:

- **Toolbar stepper** — the **−**, current-level, and **+** controls, plus a **Fit to project** button that frames the whole project in the viewport.
- **Wheel / pinch** — hold **Ctrl/Cmd** and scroll the mouse wheel, or pinch on a trackpad, while pointing at the timeline. The zoom centers on the cursor: the date under your pointer stays put while everything else scales around it.
- **Keyboard** — `⌘/Ctrl` + `=` zooms in, `-` zooms out, and `0` fits the project to the viewport.

## Interaction

- **Drag-to-reschedule** with a 4-pixel hover threshold and FSM (`IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED`)
- **Drag-to-pan** — hold **Space** and drag, or drag with the **middle mouse button**, to pan the timeline in any direction. The cursor shows a grab/grabbing hand while you pan, and task-bar dragging is paused so a pan never moves a task by accident. The hint is documented in the schedule legend.
- **Snap-to-day** is applied inside the renderer before emitting `drag-task-move`; hold Shift to suspend snap
- **Pointer events** throughout (no mouse/touch branching); pinch-to-zoom via two simultaneous active pointers
- **Keyboard reschedule** as a WCAG 2.1.1 alternative (left/right arrows nudge dates; Enter confirms; Esc cancels) — see issue #34

## Scheduling before the project start

The project start date is the floor for the schedule: the critical-path engine never plans a task to begin before it. But the floor is elastic in the *earlier* direction. When you place a task on a date before the project start — by typing a date, creating the task, importing from MS Project, or writing through the API — TruePPM keeps the floor honest by **pulling the project start back to fit the task**, in the same change. The task lands where you put it, and the project boundary follows; nothing is silently clamped or discarded.

Only the earlier direction is automatic. Moving the project start *later* (past tasks that already begin before the new date) stays a deliberate Project Settings edit. Pulling the start earlier to fit a task needs only the permission to edit that task — the project boundary is treated as a derived artifact of its tasks — so it isn't gated behind project administration, and collaborators see the new start update in real time.

Because this lives at the API layer, every write path behaves the same way, including integrations and imports that set task dates directly.

## Promote a backlog idea onto the schedule

The **Unscheduled gutter** beneath the timeline now includes a **Backlog** section listing tasks that have been captured but not yet scheduled. Backlog cards are visually distinct — a dashed edge and a readiness label — so it's clear that placing one on the timeline does more than move it.

To pull a backlog item into your plan, **drag its card from the gutter up onto the timeline**. Dropping it adds the idea to the sprint at the drop date — a confirmation reads "Added '{name}' to the sprint, starting {date}" — and CPM cascades the rest of the plan automatically, so any successors re-forecast in the same motion. The drop dialog speaks in sprint terms ("Add to a sprint", a **Target date**) rather than CPM vocabulary, so you don't need to know about early start or float to commit an idea.

If you'd rather not drag — or you're working from the keyboard — every backlog card has an **Add to a sprint** action (both in the gutter and on the [Board](/features/board/)). It opens a target-date picker and does exactly the same thing: add the idea to the sprint at the chosen date.

## Live re-forecast

When a teammate edits a dependency or reschedules a task, the recalculation propagates to everyone over WebSocket — the Gantt bars slide into their new positions in real time as CPM finishes, with no manual refresh. See [Real-time collaboration](/features/real-time/) for the underlying broadcast model.

When a confirmed reschedule moves a task's planned start, the people it affects also get a targeted inbox notification — not just a silent bar shift. The task's **assignee** is told their committed date moved (with the old and new dates, deep-linked to the task), and if the task is in an **active sprint**, the rest of the sprint team is notified that a sprint task was rescheduled. You are never notified about your own edit.

## Forecast & sensitivity

Below the timeline, a collapsible **Forecast & sensitivity** bar surfaces the Monte Carlo result inline. Collapsed, it shows a one-line summary (P50 · P80 · P95 · the top driver). Expanded, it has two columns:

- **Finish-date forecast** — the simulated finish-date histogram with the P50–P80 band and the P50/P80/P95 commit dates.
- **What's holding the date** — a sensitivity ranking of the tasks whose duration moves the project finish most, shown as labeled percent bars (critical-path tasks in red). This is a real duration-sensitivity tornado from the simulation, not a guess based on estimate spread — a high-variance task with plenty of float ranks low, while a task on the binding path ranks high. See the [scheduler reference](/features/scheduler/#sensitivity-whats-holding-the-date) for the underlying metric.

Run a simulation from the Monte Carlo row to populate it; the expand/collapse choice is remembered per user.

## Export to PDF

:::note[Coming in 0.4]
Schedule PDF export ships in 0.4.
:::

To export the schedule as a PDF, open the **Project actions** (⋯) overflow menu — the same menu that holds **Export to MS Project (.xml)** — and choose **Export schedule as PDF**. The result is a landscape Gantt of the entire project timeline: a boardroom-clean artifact for a deck, a client, or a stakeholder with no portal access. A short schedule prints on one sheet; a longer one bands across several (see below).

The PDF is **not a screenshot**. It is a light-themed static re-projection of the live (dark) canvas — redrawn for paper — so the lines stay crisp and the colors read on a printed page. It carries:

- **The full project timeline** — task bars, milestone diamonds, and dependency arrows. Hard (mandatory) links draw as solid critical-colored connectors above soft (discretionary) links, and parallel arrows stagger into separate channels so a dense dependency web stays readable.
- **A KPI strip** — the schedule window, the critical path, the P80 forecast, overall progress, and the milestone count.
- **A "Critical path chain" box** — the activities that drive the finish date, listed in order, so a reader sees *what* is holding the date without reading every bar.
- **A footer** — a content-fingerprint checksum (two identical schedules export the same stamp, so you can tell at a glance whether a printout is current) and a Community-edition watermark line.

**Wide and edge-case schedules.** A timeline too wide to stay legible on one sheet **bands across multiple sheets at week boundaries** — every sheet repeats the activity (label) column so the rows line up when you lay the sheets side by side, and each carries a **"Sheet n of N"** caption. Long activity names ellipsize rather than wrap (the full name stays intact behind the ellipsis), while the mono WBS code is never clipped. An **empty schedule** still prints a dated cover — masthead and KPI strip with `—`/`0` cells and a "No activities to plot" panel — rather than a blank page.

The document is rasterized **entirely in your browser** (html-to-image + jsPDF) — nothing is uploaded, and the export is private to the person who runs it. The action is **desktop-only**: it is hidden below the 768px breakpoint, mirroring the [board PDF export](/features/board/#export-to-pdf). An options dialog (paper-size picker, page setup) and a keyboard shortcut are coming next.

## Accessibility

The canvas is `aria-hidden="true"`; a transparent DOM overlay (`ScheduleAriaOverlay`) provides the WCAG 2.1 grid structure (`role="grid"` → `role="row"` → `role="gridcell"`). Roving tabindex; `engine.scrollToDate()` is called before `.focus()` so virtualized rows scroll into view before keyboard focus lands. In the grid, `↑`/`↓` move between tasks and `Home`/`End` jump to the first and last task (each row is a single cell, so there is no horizontal cell navigation); `Enter` on a reschedulable task starts the keyboard reschedule described above (`←`/`→` nudge, `Enter` confirms, `Esc` cancels), and `Space` selects a task without rescheduling.

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
