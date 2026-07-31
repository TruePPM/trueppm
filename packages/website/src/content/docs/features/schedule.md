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

## How to read these dates

Every date on this view — the bars, the Start and Finish columns, the milestone
diamonds — comes from the **CPM pass**. It is the *earliest feasible* schedule:
what happens if every task takes exactly the duration you estimated, no task
slips, and no risk fires. That makes it a single point, and an optimistic one.

This matters because a Gantt bar looks like a commitment. It isn't one. In
practice the CPM finish lands close to the **P50** of the same project's
[Monte Carlo forecast](/features/monte-carlo/) — meaning roughly even odds of
hitting it. Committing to the date on the bar is committing to a coin flip.

The [Forecast & sensitivity](#forecast--sensitivity) bar below the timeline is
where the confidence bands live. The short version:

| | What it is | What to do with it |
|---|---|---|
| The bars on this view | The deterministic CPM schedule — earliest feasible | Plan, sequence, find the critical path |
| **P50** | Half of simulated runs finished by here | Read as a midpoint, never quote it |
| **P80** | 4 in 5 runs finished by here | **The date you commit to** |
| **P95** | 19 in 20 runs finished by here | Contractual and externally-visible deadlines |

So a Finish column reading `3 Mar` next to a P80 of `14 Mar` is not a
contradiction — it is the risk premium the CPM pass cannot express. See
[Interpreting results](/features/monte-carlo/#interpreting-results) for the
full treatment, including what to do when all three percentiles come back
identical.

:::note[Computed is not the same as committed]
A separate distinction, easy to conflate: a task can carry a PM-set **committed
start** or run purely on **computed** CPM dates, and the app flags the second
case where it matters. That is about *provenance* — who put the date there.
This section is about *probability* — how likely any date is to hold. A
committed date is no more likely to be met than a computed one. The provenance
axis is covered in full below:
[Committed vs computed start dates](#committed-vs-computed-start-dates).
:::

## Committed vs computed start dates

Every task on the Schedule has a Start and a Finish, but they do not all come
from the same place. Two dates are in play, and only one of them is yours:

| | Field | Who sets it | What it means |
|---|---|---|---|
| **Committed start** | `planned_start` | You (the PM) | "This work is not to begin before this date" |
| **Computed start** | `early_start` | The CPM pass | "Given the network, the earliest this *can* begin" |

The Start column shows the **computed** date, because that is the one the
schedule actually runs on. A committed start does not replace it — it
constrains it.

### What committing a start actually does

A committed start is a **start-no-earlier-than (SNET)** constraint. On each
forward pass the engine takes the later of the two:

```
early_start = max(computed early_start, committed start, project start)
```

So it is a **floor, not a pin**. Committing 12 May does not hold the task on
12 May — it stops the task from drifting *earlier* than 12 May. A predecessor
that slips will still push the task past it, and that is correct: a constraint
that overrode the network would be a way of hiding a late plan rather than
seeing one.

Two consequences worth knowing:

- A task can be uncommitted and still anchored. A schedulable task assigned to
  a sprint inherits its **sprint start date** as a synthetic floor, so agile
  work positions inside its sprint window instead of sliding back to the
  project origin. That floor is engine input only — nothing is written to the
  task, and the task still reads as having no committed start.
- Committing a start is not the same as setting a deadline. Constraints on the
  finish side are a separate mechanism; see
  [Scheduling before the project start](#scheduling-before-the-project-start)
  for the related project-boundary behavior.

### Why a task in progress with no committed start is flagged

A task that has reached **In progress**, **Review**, or **Complete** without a
committed start carries an amber **no committed start** chip on its Schedule
row, and the same advisory inside the [task detail
drawer](#task-detail-drawer).

The flag is not about the task being late. It is about the dates being
**unfalsifiable**. Work is underway, so somebody made a real-world decision to
begin — but nothing on the task records what that decision was, so its Start
and Finish are pure CPM output that will move every time a predecessor moves.
There is no baseline to have been wrong about, and nothing to compare a slip
against. That is the specific case where "computed" stops being a harmless
default and starts costing you the ability to tell a plan from a rewrite of the
plan.

Summary tasks are excluded — their dates are rollups of their children, not a
committed start of their own.

### The two ways to clear it

The chip offers exactly two remediations, because there are exactly two honest
answers:

- **Set committed start** — accepts the CPM-computed start as the committed
  one. Use this when the task genuinely started when the schedule said it
  would; you are confirming the plan, not changing it. From here on, the date
  is a record, and later movement is visible as movement.
- **Move to To Do** — returns the task to **Not started**. Use this when the
  status was the mistake — the card was dragged early, or work was expected to
  begin and did not.

Pick by asking what actually happened in the world, not which one makes the
chip go away.

### When leaving a task uncommitted is right

Not every task needs a committed start, and committing every task is its own
failure mode — a schedule where every task carries a floor is a schedule that
can no longer compress, and the critical path stops telling you anything.
Leave a task on computed dates when its timing is genuinely derived: routine
work in the middle of a chain, tasks whose only real constraint is their
predecessor, anything not yet started.

Commit a start when there is a reason outside the network — a vendor arrives
that week, a gate is fixed, the work has begun. Those are the dates worth
defending; the rest should be free to move.

## Layout

Split-pane: a virtualized task list on the left (seven columns — WBS, Task, Dur, Start, Finish, %, Owner — all but Task hideable and resizable, persisted via `localStorage`), and the canvas timeline on the right. Scroll is synchronized in both directions.

:::tip[Build the plan from the keyboard]
To lay out the WBS quickly — type a task, `Tab` to indent, `Space` to complete, `F2` to edit — turn on [Schedule build mode](/features/schedule-build-mode/), a keyboard-first construction surface for the task list. It builds the schedule; sprint planning still lives on the [Board](/features/board/).
:::

### On a phone

Below the `md` breakpoint the split-pane canvas gives way to a dedicated
touch-native surface: a vertically-scrolling, WBS-ordered list where each row
carries the task name, its planned dates, `% complete`, and a compact timeline
strip. Every strip is drawn against one shared project window, so the rows read
top-to-bottom as a cascade you can scan for sequence and slack. The critical
path shows as a border cue plus a warning glyph (never colour alone), milestones
render as an amber diamond, and tasks with no dates collect in a collapsible
**Unscheduled** tray at the top. Tap any row to open its detail sheet; leaf
tasks you can edit get a one-tap complete. The Monte Carlo forecast card stays
pinned at the bottom. This is a read-and-navigate surface — reschedule and
drag-to-plan stay on the desktop canvas.

## Task detail drawer

Clicking a task row opens a right-side drawer (a bottom sheet on mobile). The
header shows the WBS number, a readiness chip, a **CP** marker when the task is
on the critical path, and the task name as an inline-editable field. Below it,
the drawer groups everything about the task into four tabs:

- **Details** — a schedule strip (Start, Finish, Duration, Float, with a
  critical-path banner when float is zero), status and progress, assignees, the
  description, dependencies, and the secondary planning sections (sprint,
  estimates, recurrence). **Duration is editable right here** — click it and type
  a new value (e.g. `10`, or `2w` for two working weeks) instead of dragging the
  bar; Start, Finish, and Float re-compute the moment you commit. Milestones have
  no duration, and Viewers see it read-only.
- **Subtasks** — the checklist breakdown, with a done/total count on the tab.
- **Activity** — notes, comments, an **All events** timeline (field changes plus
  system recalculations and schedule, risk, time and attachment events), and baseline.
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

### Progress-to-100 auto status

Dragging the progress slider (or the schedule grid's inline percent cell) to
**100%** is a status transition, not just a number. If the edit doesn't also
set a status explicitly, and the task isn't already past sign-off, TruePPM
auto-promotes it:

- **Project Manager and Project Admin** (Admin+): straight to **Complete**,
  which also stamps today as the actual finish date.
- **Everyone else who can edit the task** (Team Member): to **Review**,
  pending PM/PMO sign-off — the task does not show as Complete yet.

A task already in **Review**, **Complete**, or **Backlog** is left alone —
promoting a Backlog idea straight to done is an edge case that requires an
explicit status change instead.

Because the outcome depends on who is dragging the slider, a confirmation
dialog names the actual target status before the write commits — "Mark task
Complete?" or "Send task to Review?" — so the same gesture never produces a
surprising, invisible difference between two people's screens. Cancel and the
slider reverts to its last saved value with no write sent. Setting status
directly (from the **Status** dropdown, or from the Board) always takes that
explicit value and skips this auto-promotion entirely.

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

**Driving vs non-driving links.** In a dense chain, arrows carry a weight hierarchy so the sequence that actually controls dates reads as the strong line through the graph. A **driving** link — the predecessor whose relationship free float is zero, so it pins its successor's start — draws at full weight; a **non-driving** (slack) link draws thinner and at reduced contrast and recedes. Which links drive is a scheduling-engine fact, not a client guess: the CPM pass computes it and the API carries it per dependency (`is_driving`), so the two arms of a merge point read differently even though both endpoints may be off the critical path. Weight and contrast do the work — never color — so this never collides with the critical-path bars or the blue/green hover-chain interrogation, which still take precedence. Until a project has been recomputed the weighting is dormant and every link renders at full weight.

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
- **Touch (tablet)** — on the timeline canvas, **pinch with two fingers** to zoom; the point between your fingers stays put as the scale changes.
- **Keyboard** — `⌘/Ctrl` + `=` zooms in, `-` zooms out, and `0` fits the project to the viewport.

## Interaction

- **Drag-to-reschedule** with a 4-pixel hover threshold and FSM (`IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED`)
- **Drag-to-pan** — hold **Space** and drag, or drag with the **middle mouse button**, to pan the timeline in any direction. The cursor shows a grab/grabbing hand while you pan, and task-bar dragging is paused so a pan never moves a task by accident. The hint is documented in the schedule legend. On a **tablet**, drag a single finger on empty canvas to pan both axes — a finger that lands on a task bar still drags the bar.
- **Snap-to-day** is applied inside the renderer before emitting `drag-task-move`; hold Shift to suspend snap
- **Pointer events** throughout (no mouse/touch branching); pinch-to-zoom via two simultaneous active pointers
- **Keyboard reschedule** as a WCAG 2.1.1 alternative (left/right arrows nudge dates; Enter confirms; Esc cancels) — see issue #34

### Resizing a task, and why the bar sometimes doesn't move

Dragging a task bar's **right edge** changes its **duration**, and duration is counted in **working days** taken from the project's [working calendar](/features/calendars/) — not in calendar days. A task's finish date always lands on a working day, because a day the calendar excludes is not a day the task can occupy.

That has one consequence worth knowing, because it looks like a glitch the first time you meet it: **dragging the edge onto a non-working day does not make the task longer.** On a Monday–Friday calendar, a task finishing on a Friday and dragged one or two columns to the right lands on Saturday or Sunday — neither of which adds a working day, so the duration is unchanged and the bar stays where it was. TruePPM tells you so rather than leaving you to guess, with a note naming the day you dropped on and the task's actual finish.

To genuinely add a day, drag to the **next working day** — past a Friday finish on a Monday–Friday calendar, that's the following Monday. The same rule follows whatever calendar the project actually uses: on a six-day work week, Saturday *is* a working day and dragging onto it extends the task by one day.

If your project has holidays or shutdowns configured, the count on the canvas can differ from the stored duration by those days; the value the server calculates is authoritative, and it is what you see after the schedule re-forecasts.

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

Until you do, the view shows only the deterministic CPM dates — see
[How to read these dates](#how-to-read-these-dates) for why that is a midpoint
rather than a commitment.

## Export to PDF

:::note[Coming in 0.4]
Schedule PDF export ships in 0.4.
:::

To export the schedule as a PDF, open the **Project actions** (⋯) overflow menu — the same menu that holds **Export to MS Project (.xml)** — and choose **Export schedule as PDF**. The result is a landscape Gantt of the entire project timeline: a boardroom-clean artifact for a deck, a client, or a stakeholder with no portal access. A short schedule prints on one sheet; a longer one bands across several (see below).

In the export dialog you pick a **Destination**: **Download** saves the PDF file, or **Print** sends the *same* rendered pages straight to your browser/OS print dialog — no need to download the file first, open it, and print from there. Both produce byte-identical output, so a printout matches the file exactly. Because we can't tell whether you completed or canceled the system print dialog, the dialog confirms only that it *opened*; if it doesn't appear, an **Open printable PDF** link on the confirmation opens the same document so you can print it manually.

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
