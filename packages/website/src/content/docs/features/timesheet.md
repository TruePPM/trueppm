---
title: Timesheet
description: Three ways to capture time — a running timer, a global quick-log popover, and a keyboard-fast weekly grid — plus how to review and submit your week.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
The weekly timesheet grid and week submission ship in 0.4. Manager approval, non-project time
categories, and the earned-value actuals feed follow in 0.5. The running timer and the quick-log
popover described below feed the same underlying time entries and ship alongside the grid in 0.4.
:::

TruePPM captures time three ways, all writing to the same underlying `TimeEntry` records: a
**running timer** you start and stop against a task, a **quick-log popover** for logging a chunk
of time you already finished, and the **weekly grid** below for reviewing and submitting a whole
week. Whichever you use, the same entry shows up in the others — stop a timer and its entry
appears in today's grid cell immediately; log time from the grid and it counts toward the same
task total the timer would show.

## The running timer

A **timer chip** appears in the TopBar's right cluster — but only while a timer is running; the
calm shell stays quiet when nothing is being tracked. Start one from a task row on
[My Work](/features/my-work/): its **Start timer** affordance begins a server-side timer scoped to
that task.

The timer is a **server singleton** — exactly one active timer per person, persisted so it
survives a reload, a navigation, or switching devices. The chip's live clock (`1:24:06`) is derived
client-side from the server's `started_at` every second; the server, not the browser tab, is the
authoritative source, so the elapsed time is never lost to a closed tab and never drifts.

**Starting a second timer while one is already running stops and logs the first one
automatically** — there is no "timer already running" error to work around. The just-logged entry
surfaces in a confirmation toast with **Undo**, naming the task the prior timer was on.

**Stopping** a timer (the chip's stop control, or starting a new one) writes a `TimeEntry` dated to
the day the timer *started* — so a timer that happens to cross midnight is attributed to the day
the work began, not the day it happened to stop.

### The stale-timer warning

A timer left running is capped, not unbounded: if you forget to stop it, it keeps ticking visibly
in the chip, but the value it eventually logs is **capped at a ceiling** (default 10 hours,
`TIMETRACKING_TIMER_MAX_MINUTES`, operator-configurable) so a timer left running over a weekend
logs the ceiling rather than thousands of minutes. Once elapsed time passes that ceiling, the chip
flips from its running (on-track) tint to a critical tint — a "check me" signal rather than a
silent overrun — while continuing to run until you stop it.

## Quick-log

**Log time**, in the TopBar's right cluster next to the timer chip, is the fast path for a chunk of
time you already worked and want to log without starting a timer for it — the "under 30 seconds"
capture the design calls Pattern C. It is always mounted (icon-only below the `md` breakpoint, icon
+ label above it) and opens a popover on desktop or a bottom sheet on mobile.

The form is the same on both surfaces:

- **Task** — search starts against your own assigned work; once you type two or more characters it
  also searches every task across your projects, so logging time on a task you're helping with but
  not assigned to is never a dead end.
- **Duration** — four preset chips (**15m / 30m / 1h / 2h**) or type your own: `2`, `2.5`, and
  `2:30` all parse to two-and-a-half hours.
- **Date** — defaults to today; no future dates (the server enforces this too).
- **Note** — optional, up to 500 characters.

Logging shows a success toast with **Undo**, matching the timer's confirmation pattern — the same
`useCreateTimeEntry` mutation backs both surfaces, so the experience of logging time is identical
whichever entry point you used.

## The weekly grid

Open the grid from **Timesheet** in the sidebar's Personal group, or go straight to
`/me/timesheet`. Where the timer and quick-log capture single entries fast, the grid is where you
fill gaps and submit at the end of the week — every project and task you logged against, laid out
Monday to Sunday.

- **Rows are your tasks, across every project.** Each row shows the task and its project; the grid spans all the projects you're a member of, so a cross-project week is one screen, not a tab per project.
- **Columns are the seven days** of the selected week (Mon … Sun). Each cell is the hours you logged on that task that day; an empty cell reads as a muted `·`.
- **Type hours however is fastest** — `2`, `2.5`, or `2:30` all mean two-and-a-half hours. `Tab` moves between cells, `Enter` saves the cell, `Esc` discards the edit. Clearing a cell removes that day's entry.
- **Totals update as you type** — a row total per task, a daily total under each day, and the week total in the header. A daily total over eight hours is flagged amber so an over-long day is obvious.
- **Weekends are shaded** and today's column is tinted, so you can orient at a glance.

Step between weeks with the `‹ … ›` stepper, and start logging against a task that isn't in the grid yet with **Add project or task**.

### Days with more than one entry

If you logged two separate sessions against the same task on the same day, that cell shows the **sum** and is read-only in the grid — a single number can't be split back into the individual entries without losing their notes and provenance. Edit those entries from [My Work](/features/my-work/), where each one is listed on its own.

## Submitting your week

**Submit week** marks the week as done. It's a signal, not a lock: your entries stay fully editable after you submit, and you can **Reopen** the week at any time. There is no approver and no manager view — submitting is just you telling yourself (and, later, an approval workflow) that the week is complete.

Manager approval, non-project time categories (PTO, admin, training), and the earned-value actuals feed are a separate, later track — they are not part of this grid.

## Your own time only

The timesheet is a personal, individual-contributor surface: it shows and submits **your** logged time on tasks you can access. It carries no cross-project rollup, no per-person visibility for managers, and no portfolio or governance scope — a contributor reviewing their own week is squarely community-edition functionality.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET`/`POST` | `/api/v1/tasks/{task_id}/time-entries/` | Your own entries on a task, plus your `total_logged_minutes`. `POST` creates one. |
| `PATCH`/`DELETE` | `/api/v1/me/time-entries/{id}/` | Author-only edit or (soft) delete of one entry. |
| `GET` | `/api/v1/me/time-entries/?from=&to=` | The weekly cross-project rollup that backs the grid: entries in range plus precomputed daily/cell/week totals and the week's submission marker. |
| `POST`/`DELETE` | `/api/v1/me/timesheets/{week_start}/submit` | Submit or un-submit a week (`week_start` is normalized to its ISO Monday). |
| `GET` | `/api/v1/me/timer/` | The caller's running timer, if any, with server-computed `elapsed_seconds` and `stale`. |
| `POST` | `/api/v1/me/timer/start` | Start a timer on a task; second-start atomically stops and logs the prior one, returned as `finalized_entry`. |
| `POST` | `/api/v1/me/timer/stop` | Stop the running timer and log it as a `TimeEntry`; `409` if none is running. |

Every read and write here is scoped to the authenticated caller — there is no cross-project rollup
of *other* people's time and no admin surface to log or edit on someone else's behalf.
