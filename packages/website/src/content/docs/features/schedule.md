---
title: "Schedule view"
description: "Canvas-rendered Schedule (Gantt-style) with critical path, baselines, milestones, and the unscheduled gutter."
documentedFor: "0.4"
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
| **Computed start** | `scheduled_start` | The CPM pass | "Given the network (and, once work has begun, reality), when this task's work spans from" |

The Start column shows the **computed** date, because that is the one the
schedule actually runs on. A committed start does not replace it — it
constrains it.

:::note[Ships in 0.4]
`scheduled_start` and the Start-column behavior described above ship in 0.4.
Before 0.4, the Start column (and the bar) instead reads a related-but-different
engine field, `early_start`, which behaves identically for a not-yet-started
task but diverges once work is in progress — see
[The bar vs. the remaining-work window](#the-bar-vs-the-remaining-work-window)
below.
:::

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

### The bar vs. the remaining-work window

:::note[Ships in 0.4]
The span-based bar and the Duration cell's "Nd left" qualifier described in
this section ship in 0.4. Before 0.4, the bar draws from the remaining-work
window described below as the pre-fix behavior, and the Duration cell shows
no qualifier chip.
:::

Once a task is in progress, the schedule engine tracks two related but
different quantities, and the Schedule view is careful to keep them visually
separate:

- **The bar (and the Start/Finish columns)** show the task's **span** —
  where its work began (`scheduled_start`) through where it finishes
  (`early_finish`/`scheduled_finish` — the two are always the same date). The
  bar keeps its full planned length as work progresses; a **fill** grows
  inside it left-to-right as `% complete` rises, the same convention MS
  Project and most Gantt tools use.
- **`early_start`** (an engine-internal field, not shown on this view) is
  different: it names the *remaining-work window* — where the task's
  **unfinished** work would need to start, laid forward from today, to hit
  the same finish. For a task that hasn't started, or one that's finished,
  the two windows are identical. For a task in progress they diverge, and the
  divergence is informative: a 4-day task that's 83% done has roughly a day
  of remaining-work window left, even though its span — when the work
  actually began — may have started days or weeks ago.

Before this distinction existed, the bar was drawn from the remaining-work
window instead of the span. The visible effect was a bar that **shrank** as
progress was logged, rather than filling — a 4-day task at 83% rendered as a
single day, indistinguishable from someone having cut the estimate. The span
is what fixes that: the bar's length now reflects the real commitment, and
the fill is the only thing that moves as work advances.

The task detail drawer's **Duration** cell carries the same idea in numeric
form: the full estimate (`4d`) stays put, and a **"1d left"** qualifier chip
appears beside it once work is underway and the remaining window has shrunk
below the estimate — a property *of* the duration, not a second, disagreeing
date. A task that hasn't started, or one that's complete, shows no chip: there
is nothing left to qualify.

One consequence worth knowing: when a task's actual start is on record and
work has run long, its span can end up **longer** than its estimated
duration — an eleven-day span against a four-day estimate, say. That is not a
bug. It is the visible form of work taking longer than planned, and it is
exactly the situation the span exists to surface rather than hide.

## Layout

Split-pane: a virtualized task list on the left (seven columns — WBS, Task, Dur, Start, Finish, %, Owner — all but Task hideable and resizable, persisted via `localStorage`), and the canvas timeline on the right. Scroll is synchronized in both directions.

:::tip[Build the plan from the keyboard]
The task list is [Schedule build mode](/features/schedule-build-mode/) — a keyboard-first construction surface, on by default: type a task, `Alt + →` to indent, `Space` to complete, `F2` to edit. It builds the schedule; sprint planning still lives on the [Board](/features/board/).
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

## Sprint windows

:::note[Ships in 0.4]
Sprint window bands ship in 0.4. On the current release the Schedule draws no sprint band; a sprint's dates are visible only on the [Sprints](/features/sprints/) workspace.
:::

A hybrid program is **one plan**, so its sprint cadence is drawn on the same timeline as its gated bars — not on a second view, and not behind a toggle that swaps one for the other. Where a subtree is driven by a sprint, the Schedule paints a **sprint window**: a tinted, hatched band spanning that subtree's rows, running from the sprint's start date to its finish date, with the sprint name on a pill at the band's top-left corner.

The point is what you can see in one glance: the gated critical path, the sprint cadence, and the dependencies crossing between them. A predecessor in a gated phase drives a story inside a sprint window exactly as it drives anything else — **the band is paint, not a container**. It changes no dates, no dependency routing, and no bar. Nothing forks.

### Which rows a band covers

A band covers a **contiguous run of rows** that all resolve to the same sprint. If a sprint's work sits in two places in the WBS with other work between them, you get two bands — never one tall band claiming the rows in between, which are in no sprint at all.

Rows resolve exactly the way the [delivery-mode chip](/features/task-classification/) does, so the band and the chip can never disagree about what a subtree is:

- A **phase reads from its descendants**, not from its own sprint field. A phase whose branches sit in different sprints gets no band of its own; its children get theirs.
- **Milestones contribute nothing.** A gate inside a sprint-driven phase is a gate, not evidence the phase spans two sprints — so a gate never splits a band.
- A row carrying no sprint of its own — that gate, or a task nobody has pulled in yet — **inherits the band around it**, so a sprint-driven phase reads as one region instead of one with holes in it.

**Cancelled** sprints draw nothing. **Planned**, **active** and **completed** sprints all draw: past cadence explains the shape of the plan behind the today line as much as the live sprint explains the shape ahead of it.

### Reading the band

The band uses the same visual vocabulary as the delivery-mode marks it sits behind — the same violet, the same diagonal hatch as a scrum bar, at a lower density because it covers a region rather than an 18px bar. Its two **dashed** vertical rules *are* the window: work that runs past them is work that runs past the sprint. The **Sprint window** entry in the schedule legend explains the mark, alongside **Scrum**, **Kanban** and **Mixed subtree** — one legend for the whole hybrid vocabulary.

The band never relies on color alone: hue, hatch, the dashed edges and the name pill each carry the fact, so it survives a color-vision deficiency and a monochrome print. In Windows High Contrast the tint drops away entirely — a solid region would erase the grid and row separators it sits over — and the window survives as its two dashed rules and a gray hatch, which is also why they are dashed rather than solid: there, a solid rule would be indistinguishable from the today line.

Screen readers get the fact as text, and they get the *window*, not just the membership: a task inside one announces `…, in Sprint 4 (Apr 20 – May 1)`, and a task whose finish runs past the window adds `, finishes after the sprint window` — the thing a sighted user reads off the band's right-hand rule. Hovering a row surfaces the full sprint name even when the pill had to truncate it.

Bands survive zoom and pan — the window is re-derived from the live timescale on every repaint, so it narrows correctly from Month to Quarter rather than holding a stale width. They fade in briefly when they first appear; under `prefers-reduced-motion` they simply appear, with no animation scheduled at all.

### Turning them off

**Display → Chart → Sprint windows** hides the bands. This is a presentation toggle, not a view switch: hiding the window changes nothing else — the same rows, the same bars, the same links. The choice persists per browser, and the Display badge counts it so you are never left wondering where the band went. On a project with no sprint window to draw the option is not offered at all, and it never lights the badge.

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

## When the server changes your date

:::note[Ships in 0.4]
Reconciliation markers ship in 0.4. Before then, a date the scheduling engine
changes replaces your value in place with nothing marking the move.
:::

The server owns every scheduled date. When you drag a bar or pick a milestone
date, the view shows your value immediately so the plan keeps up with you — but
the authoritative date comes back from the **CPM pass**, and it can differ. The
engine applies the project's real working calendar, including holiday
exceptions the browser never receives; a span you drop next to a shutdown week
will land somewhere you did not predict.

That difference is always shown, never applied silently:

- **A date you have just authored renders in *italic*** until the server
  confirms it.
- **If the server lands on a different date**, the row keeps a `→ new date`
  marker and the value it replaced. The marker **stays until you acknowledge
  it** — you are never asked to spot the change yourself. Widen the Start or
  Finish column and the marker also shows the old date struck through.
- **A strip above the forecast bar reports "N dates changed"** and announces the
  recomputation to screen readers. **Show N changes** filters the outline down
  to just the changed rows; **Acknowledge all** clears the markers.
- **A change the server refuses** — permission, a lock, a validation error —
  is listed with the reason it gave and a **Retry**. It is never reverted
  without explanation.

The marker states the change as a fact — *"Finish moved Oct 13 → Oct 16"* — and
adds a reason only where one can be proven from the project's work week (*"Oct
13 is not a working day"*). When the move came from a holiday, a dependency
cascade, or a constraint, the strip says what changed but not why: the browser
is not told the cause, and a plausible-sounding guess would be worse than
silence. To see why a specific date moved, open the task's
[change history](/features/change-history/).

Only dates **you** authored are marked. A teammate's edit arriving over the
live channel updates the plan as it always has — see
[Real-time collaboration](/features/real-time/).

### What the preview shows while you drag

You do not have to drop a bar to find out what it costs. While a drag or a
keyboard reschedule is live, TruePPM paints **preview bars** — translucent
ghosts on every downstream task the move would push, with a red frame and a
**CP** badge on any task the move puts onto the critical path. A corner label
reads *"Preview — server confirms on drop"*, because this is a browser-side
estimate on a plain Monday–Friday week: it does not know the project's holiday
exceptions, and the CPM pass on drop is what decides. At most ten ghosts are
drawn at once; beyond that a **+N more affected** count tells you the blast
radius is larger than what is on screen. Press **Esc** to back out with nothing
changed.

**A bar whose dates come from recorded actuals will not move.** Once a task is
complete *and* carries a recorded actual start or finish, the scheduling engine
takes it out of network logic entirely — its actuals are the truth, and the
planned start is never consulted for it again. You can still grab such a bar,
and the drag says so while you hold it: *"Recorded actuals set this task's
dates — the drop won't move it."* Completion alone does not do this. A task
marked 100% with no recorded actuals is still scheduled by the network and
drags normally; it is the actuals, not the checkbox, that pin the dates. To
move a pinned task, change its actual dates on the task itself.

**The keyboard path draws the same line.** Pressing `Shift`+`Enter` or `r` on a
pinned task does not start a reschedule, and says why — the same sentence the
drag shows, announced to a screen reader. A task complete with no recorded
actuals starts a keyboard reschedule normally, exactly as it drags normally.

## Forecast & sensitivity

Below the timeline, a collapsible **Forecast & sensitivity** bar surfaces the Monte Carlo result inline. Collapsed, it shows a one-line summary (P50 · P80 · P95 · the top driver). Expanded, it has two columns:

- **Finish-date forecast** — the simulated finish-date histogram with the P50–P80 band and the P50/P80/P95 commit dates.
- **What's holding the date** — a sensitivity ranking of the tasks whose duration moves the project finish most, shown as labeled percent bars (critical-path tasks in red). This is a real duration-sensitivity tornado from the simulation, not a guess based on estimate spread — a high-variance task with plenty of float ranks low, while a task on the binding path ranks high. See the [scheduler reference](/features/scheduler/#sensitivity-whats-holding-the-date) for the underlying metric.

Run a simulation from the Monte Carlo row to populate it; the expand/collapse choice is remembered per user.

Until you do, the view shows only the deterministic CPM dates — see
[How to read these dates](#how-to-read-these-dates) for why that is a midpoint
rather than a commitment.

## Export to PDF

:::note[Ships in 0.4]
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

The canvas is `aria-hidden="true"`; a transparent DOM overlay (`ScheduleAriaOverlay`) provides the WCAG 2.1 grid structure (`role="grid"` → `role="row"` → `role="gridcell"`). Roving tabindex; `engine.scrollToDate()` is called before `.focus()` so virtualized rows scroll into view before keyboard focus lands. In the grid, `↑`/`↓` move between tasks and `Home`/`End` jump to the first and last task (each row is a single cell, so there is no horizontal cell navigation); `Shift`+`Enter` or `r` on a reschedulable task starts the keyboard reschedule described above (`←`/`→` nudge, `Enter` confirms, `Esc` cancels) — plain `Enter` opens the task drawer — and `Space` selects a task without rescheduling. Every task the pointer can drag is reachable this way: the keyboard refuses only summary tasks and tasks pinned by recorded actuals, and it announces which of the two it hit rather than ignoring the keypress.

## Schedule deep-link

The [Advancing-to-Milestone card](/features/sprints/) on the Sprints view links into this Schedule view scrolled to a specific milestone task via the URL hash (`#task-<uuid>`). That's how the Sprints workspace bridges back to the Schedule without forcing the user to find the milestone manually.

## Related ADRs

- [ADR-0030](/architecture/decisions/) — Schedule rename (Gantt → Schedule), tab order
- [ADR-0040](/architecture/decisions/) — Wave/3 Schedule: bar render, task drawer, unscheduled gutter, canvas rationale
- [ADR-0027](/architecture/decisions/) — Incremental CPM recompute (subgraph delta strategy)
- [ADR-0752](/architecture/decisions/) — Task span (`scheduled_start`) vs. the remaining-work window (`early_start`); the bar/Duration-chip treatment above
- [ADR-0803](/architecture/decisions/) — Sprint window bands on the schedule canvas — row attribution, the shared delivery-mode vocabulary, and why it is not a second view

## If you are…

- **Raj (PM)** — this is your home. The critical path lights up automatically; baselines overlay as ghosts; the milestone diamonds are your contractual signal.
- **Maya (Scrum Master)** — you don't open this day to day. When you do, the sprint windows are where your cadence is visible against Raj's gates — and the one place you can see a gate landing inside one of your sprints.
- **Tom (engineer)** — you don't open this either. The Schedule auto-re-forecasts off your board moves.
