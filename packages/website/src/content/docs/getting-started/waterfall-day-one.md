---
title: Waterfall day one — build your own plan
description: Create a real waterfall project from scratch in the UI — WBS, milestones, dependencies, a baseline, a status date, and a PDF handoff — no curl required.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
This walkthrough uses the redesigned **Start sheet**, **in-app baseline capture**,
and the project **status date** field — all 0.4. On `0.3.0-alpha.3` the project
creation screen is an older multi-step wizard, baselines exist over the [REST
API only](/features/baselines/#capturing-and-managing-baselines-via-the-api),
and the status date has no in-app field yet
([Monte Carlo](/features/monte-carlo/#progress-aware-forecasting) uses today's
date instead). Everything else here — build mode, dependencies, Monte Carlo,
PDF export — is unchanged from 0.3.
:::

[Quickstart](/getting-started/quickstart/) gets you a **seeded** program in five
minutes. This page is the other half: building a project **from nothing**, in the
UI, the way a PM running a real waterfall plan actually would. No API calls, no
seed command — just the screens you'd use on day one with your own work.

By the end you will have a project with a phased WBS, milestones, dependencies,
a captured baseline, a status date, a Monte Carlo forecast, and a PDF you could
hand to a stakeholder.

## Before you start

You need a running TruePPM instance ([Installation](/getting-started/installation/))
and an account with at least the **Project Manager** (Admin) project role — you get
this automatically on any project you create, since creating a project makes you
its Owner.

## 1. Create the project

Open the sidebar and click **New project** (or **+ New project** from the
Projects directory). The Start sheet is one screen, no step navigation:

1. Choose **Blank** — the other two options, **Template** and **Import**, are for
   starting from a preset or an existing file; a from-scratch plan wants Blank.
2. Leave **Program** as **None — standalone project** unless you already have a
   program to attach this to (see [Programs](/features/programs/) if you do).
3. Enter a **name** and a **start date**.
4. The sheet states the project's methodology as a read-only line, derived from
   the program or workspace default. If that line does not already say
   **Waterfall**, open **Project settings → General** right after creation and
   set it there — see [Project methodology preset](/features/methodology-preset/).
5. Confirm the **working calendar** in the sheet's footer (inherited default, or
   override it now) — it governs every date the schedule computes from here on.
6. Click **Create**.

You land on the new project's **Schedule** view — empty, with a live row already
holding the cursor.

## 2. Build the WBS: phases, tasks, milestones

The Schedule view's [build mode](/features/schedule-build-mode/) is the fastest
way to lay down a plan's structure with the keyboard. It needs no setup.

1. Type a task name and press **Enter** — this creates a new row each time.
2. To make a row a **phase**, type the phases first, then **indent** the tasks
   under them with **Alt + →** (⌥ + → on macOS). An indented row's parent
   automatically becomes a phase (a summary row rolled up from its children).
3. To mark a row as a **milestone** — a zero-duration gate rather than a task
   with a duration — press **⌘ M** / **Ctrl + M** to insert one directly, or hover
   an existing row and click its **◆** control to convert it. A milestone cannot
   hold work, so convert only a row with nothing scheduled under it.
4. Set each task's **duration** inline — click the Duration cell and type a
   value (`5`, or `2w` for two working weeks).
5. Press **?** at any point to open the full build-mode shortcut cheatsheet.

A plan for a small waterfall project might look like:

```
Foundation (phase)
  Site survey — 3d
  Permits — 10d
  Excavation — 5d
  ◆ Foundation complete (milestone)
Construction (phase)
  Framing — 15d
  Rough-in (electrical/plumbing) — 12d
  ◆ Structure complete (milestone)
Finishing (phase)
  Interior finishes — 20d
  Final inspection — 2d
  ◆ Project complete (milestone)
```

## 3. Wire dependencies

Dates do not yet reflect real sequencing until tasks are linked. For each task
that depends on another:

1. Hover the task's row — hovering reveals its dependency chain (predecessors
   highlight blue, successors highlight green) so you can see what is already
   linked before adding more.
2. Right-click the row and choose **Add dependency** — this opens a task picker.
3. Pick the predecessor task. The link defaults to **Finish-to-Start**; with the
   new link focused, press **⌥ →** (Alt + →) to cycle its type — FS → SS → FF →
   SF — if your plan needs a different dependency type or you need to add lag.

Link "Foundation complete" as a milestone that only fires once excavation
finishes, link "Framing" to start after "Foundation complete," and so on down
the plan. Once every task has its real predecessors, the Schedule view computes
the **critical path** automatically — no separate "recalculate" step.

## 4. Capture a baseline

A baseline freezes today's planned dates so you can measure drift later — the
snapshot you show a stakeholder alongside "here is where we actually are."

Open the Schedule toolbar's **Project actions (···)** menu and choose **Capture
baseline**. A short confirmation explains what a baseline is; confirm it. The
snapshot is named automatically (`Baseline 1`) and becomes the active baseline.
See [Baselines](/features/baselines/) for what gets captured, and for capturing
a second baseline later without losing the first (every baseline stays in the
project's history).

## 5. Set the status date

The status date is the "as of" date your forecasts compute from — without it,
Monte Carlo and CPM both default to today, which is fine for an actively-tracked
plan but wrong for a report you want reproducible on a specific date.

Open **Project settings → General** and set **Status date (data date)**. Leave
it blank to keep defaulting to today, or pin an explicit date for a frozen
report. See [Progress-aware forecasting](/features/monte-carlo/#progress-aware-forecasting)
for how this anchors both the deterministic schedule and the Monte Carlo pass.

## 6. Run Monte Carlo and read the forecast

Three-point estimates (optimistic / most likely / pessimistic) turn the
deterministic CPM date into a probability distribution. Click a task row, open
its drawer's **Details** tab, and fill in the **Estimates** section for at least
your critical-path tasks — a task with no three-point estimate falls back to its
single duration.

Then expand the **Forecast & sensitivity** bar docked at the bottom of the
Schedule view and run a simulation from the **Monte Carlo** row. Read the P50 /
P80 / P95 chips, and press **Details ›** for the full distribution and the
sensitivity tornado — which tasks are actually driving the finish date, not
just which ones look uncertain. See [Monte Carlo](/features/monte-carlo/) for
the full mechanics.

## 7. Export a PDF

From the Schedule toolbar, choose **Export PDF** (in the toolbar by default; if
the window is narrow it moves into the **···** overflow menu — see [Schedule
Toolbar](/features/schedule-toolbar/)). The export matches what you currently
see: hide the dependency lines first if you want a cleaner handoff copy.

## What you have now

A real project — your own WBS, your own dependencies, a critical path the
engine computed rather than one you eyeballed, a captured baseline to measure
drift against, a status date your forecasts anchor to, and a PDF you could put
in front of a stakeholder today. Nothing above touched the API.

:::caution[Change history has a retention window]
Every edit above — durations, dates, dependency changes — is recorded in the
task's [change history](/features/change-history/), but those rows are purged
nightly after `HISTORY_RETENTION_DAYS` (default **90 days**). A waterfall
project commonly runs longer than that. If you need the full edit trail to
survive the life of the project — for an audit, a claim, or a post-mortem —
raise the retention window before you rely on it; see [Outbox & Record
Retention](/administration/retention/) to tune or disable the purge.
:::

## Related

- [Schedule Build Mode](/features/schedule-build-mode/) — the full keyboard reference
- [Baselines](/features/baselines/) — what a baseline captures, and how rebaselining works
- [Monte Carlo](/features/monte-carlo/) — the simulation mechanics and progress-aware forecasting
- [Schedule Toolbar](/features/schedule-toolbar/) — every toolbar control, including Export PDF
- [Change History](/features/change-history/) — what's tracked, and the retention window
- [Quickstart](/getting-started/quickstart/) — the seeded-sample path, if you want to see a finished example first
