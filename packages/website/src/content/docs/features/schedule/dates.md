---
title: "Schedule dates"
description: "Committed, computed and actual dates on the Schedule: what each one means, when the server changes a date, and scheduling before the project start."
documentedFor: "0.4"
---

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

### What committing a start actually does

A committed start is a **start-no-earlier-than (SNET)** constraint. On each
forward pass the engine takes the later of the two:

```text
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
- Committing a start is not the same as setting a deadline. There is no
  finish-side constraint yet — `planned_finish` is reserved and the engine does not
  read it. The constraint set TruePPM intends to adopt is recorded in
  [ADR-1049](/architecture/decisions/) (proposed); see
  [Scheduling before the project start](#scheduling-before-the-project-start)
  for the related project-boundary behavior.

### Committing a start that has already arrived

Committing a start on a **To Do** task sets more than the date when that date is
today or earlier. A task whose committed start has arrived *is* underway, so
TruePPM also moves it to **In progress**. If the date is in the past, the task's
**actual start** is recorded as that day too.

Every control that can trigger it says so before you click — the drawer's *Set
committed start*, and the unscheduled gutter's quick actions and **Promote to
schedule**. Each gains a clause naming the status change, and the confirmation
after the write repeats what actually happened. A future date changes nothing but
the date, and the controls read as they always have.

"Already arrived" is judged against **the server's date**, not your browser's. On
a team spread across time zones the two can disagree by a day, and it is the
server that decides.

To commit a past start *without* moving the task out of To Do, set the status back
to **To Do** after committing — the promote only fires on the write that sets the
date.

### Why a task in progress with no committed start is flagged

A task that has reached **In progress**, **Review**, or **Complete** without a
committed start carries an amber **no committed start** chip on its Schedule
row, and the same advisory inside the [task detail
drawer](/features/schedule/editing/#task-detail-drawer).

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

## Scheduling before the project start

The project start date is the floor for the schedule: the critical-path engine never plans a task to begin before it. But the floor is elastic in the *earlier* direction. When you place a task on a date before the project start — by typing a date, creating the task, importing from MS Project, or writing through the API — TruePPM keeps the floor honest by **pulling the project start back to fit the task**, in the same change. The task lands where you put it, and the project boundary follows; nothing is silently clamped or discarded.

Only the earlier direction is automatic. Moving the project start *later* (past tasks that already begin before the new date) stays a deliberate Project Settings edit. Pulling the start earlier to fit a task needs only the permission to edit that task — the project boundary is treated as a derived artifact of its tasks — so it isn't gated behind project administration, and collaborators see the new start update in real time.

Because this lives at the API layer, every write path behaves the same way, including integrations and imports that set task dates directly.

## When the server changes your date

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
ghosts on every downstream task the move would shift, with a red frame and a
**CP** badge on any task the move puts onto the critical path. This works in
both directions: pulling a bar **earlier** shows the successors it pulls in with
it, and the milestone readout reports a date that moves closer just as it
reports one that slips. Work that has actually started stays where it started,
and a task with a committed **start no earlier than** date is never pulled back
through it.

A corner label reads *"Preview — server confirms on drop"*, because this is a
browser-side estimate on a plain Monday–Friday week: it does not know the
project's holiday exceptions or a custom calendar, so near a shutdown week it
can be several days out, and the CPM pass on drop is what decides. At most ten
ghosts are drawn at once; beyond that a **+N more affected** count tells you the
blast radius is larger than what is on screen. Press **Esc** to back out with
nothing changed.

**A bar whose dates come from recorded actuals will not move.** Once a task is
complete *and* carries a recorded actual start or finish, the scheduling engine
takes it out of network logic entirely — its actuals are the truth, and the
planned start is never consulted for it again. You can still grab such a bar,
and the drag says so while you hold it: *"Recorded actuals set this task's
dates — the drop won't move it."* Completion alone does not do this. A task
marked 100% with no recorded actuals is still scheduled by the network and
drags normally; it is the actuals, not the checkbox, that pin the dates. To
move a pinned task, change its actual dates in the task drawer's **Actual
dates** section — see [Recording and correcting actual
dates](#recording-and-correcting-actual-dates).

**The keyboard path draws the same line.** Pressing `r` (or `Shift`+`Enter`) on
a pinned task does not start a reschedule, and says why — the same sentence the
drag shows, announced to a screen reader. A task complete with no recorded
actuals starts a keyboard reschedule normally, exactly as it drags normally.

## Recording and correcting actual dates

Actual dates are the record of what happened, as opposed to the plan. TruePPM
stamps them for you on the transitions where the date is unambiguous, and gives
you one place to correct them when it got the date wrong — which it will, because
people update the board on Monday for work they finished on Friday.

### What TruePPM records automatically

| Transition | What is recorded |
|---|---|
| → **In progress** | **Actual start** = today, if none is on record yet |
| → **In review** | **Actual finish** = today, if none is on record yet |
| → **Complete** | **Actual finish** = today, if none is on record yet |
| **In review** ⇄ **Complete** | Nothing changes — the recorded finish is kept |
| Reopened out of In review or Complete | **Actual finish** is cleared |

Two things about this table are deliberate and worth stating plainly, because both
look like omissions.

**Nothing ever invents an actual start.** A card taken straight to done without
ever passing through In progress has no start date to record, and stamping today
would collapse its bar to a single day. TruePPM leaves the field empty instead and
lets the scheduling engine derive the historical span backward from the finish. A
task with a finish and no start is a correct, complete record — not a gap to fill.

**In review records a finish; Complete does not overwrite it.** "In review" means
the work is done and awaiting sign-off, so the finish date is known at that moment.
Sign-off can come days later, and the date that matters is when the work finished,
not when somebody got round to approving it.

That second rule is the one that changes what a contributor's completion is worth.
Marking a task 100% moves it to In review, and before 0.4 that path recorded no
actual dates at all — so the highest-volume way work gets completed produced no
record of when it happened.

### Correcting a date yourself

Open the task drawer and expand **Actual dates** on the Details tab. Both fields
are ordinary date pickers; each change saves immediately and re-runs the schedule,
because an actual date moves where the task sits on the timeline.

Three rules apply, and TruePPM will tell you which one you hit:

- **Actual start cannot be later than actual finish.** Editing either field is
  checked against whatever the other one currently holds.
- **Neither date can be in the future.** The ceiling is the project's data date
  when that is set ahead of today, otherwise today.
- **Actual finish can only be set on a task that is in review or complete.** On a
  task still in progress the field is present but inert, and says so. This is not
  bureaucracy: the scheduling engine reads a recorded finish as "this task is
  done" and pins the task's dates to it, so a finish on a running task would show
  the work as complete on the timeline while the board still shows it in flight.
  Moving the task and setting the date in the same edit is fine — it is only a
  bare finish date on a running task that is refused.

If you can view a project but not edit it, the section shows the recorded dates as
plain text.

There is **no dialog on any completion path**. Marking a task complete inline,
dragging a card to Done, and bulk-completing a selection all behave exactly as they
did — none of them stops to ask you for dates. The drawer is the correction path,
and it is somewhere you go on purpose.
