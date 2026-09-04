---
title: For Project Managers
description: How TruePPM helps project managers build reliable schedules, track the critical path, run probabilistic risk analysis, and stay in sync with agile delivery teams.
---

You manage schedules, track progress against commitments, and need to give stakeholders delivery dates they can trust. TruePPM gives you real scheduling math — not just bars on a timeline — and connects that schedule to your team's actual agile delivery without any manual reconciliation.

## Scheduling fundamentals

### Automatic CPM on every change

Every time you add a task, change a duration, or modify a dependency, TruePPM recalculates the entire schedule automatically. No "Update Project" button. No manual recalculation. You always see:

- **Critical path** — which tasks drive your deadline (highlighted in the Gantt)
- **Total float** — how many working days each task can slip before it affects the end date
- **Early/late dates** — the window each task can occupy without delaying the project

All four standard dependency types are supported, each with an optional lead/lag:

| Type | Meaning |
|------|---------|
| Finish-to-Start (FS) | Successor starts after predecessor finishes |
| Start-to-Start (SS) | Successor starts after predecessor starts |
| Finish-to-Finish (FF) | Successor finishes after predecessor finishes |
| Start-to-Finish (SF) | Successor finishes after predecessor starts |

Lag values (positive or negative) are in **calendar days**, not working days. The resulting date is then moved to the next working day, so a short lag can be swallowed by a weekend: after a Friday finish, a 1- or 2-day FS lag still starts the successor on Monday, exactly as a zero lag would. If you need a wait of a specific number of *working* days, model it as a zero-resource task — task durations are working-day counted, so weekends and calendar exceptions are skipped there.

→ See [Scheduler engine](/features/scheduler/#lag-is-in-calendar-days-durations-are-in-working-days) for the full unit table.

→ See [Schedule view](/features/schedule/), [Scheduler engine](/features/scheduler/)

### Monte Carlo risk analysis

Your CPM finish date is typically P50. There's only a **50% chance** you'll hit the date shown in a traditional Gantt. That's the number most project management tools present as "the date."

TruePPM lets you add three-point estimates (optimistic, most likely, pessimistic) to any task and run a Monte Carlo simulation:

| Percentile | What it means |
|-----------|--------------|
| **P50** | 50% chance of finishing by this date. Where your CPM date usually lands. |
| **P80** | 80% chance. **Commit this date to stakeholders.** |
| **P95** | 95% chance. Use for contractual or regulatory deadlines. |

10,000 simulation runs on a 200-task schedule completes in under 5 seconds. The P80–CPM gap is your visible schedule risk.

→ See [Scheduler engine — Monte Carlo](/features/scheduler/)

### Baselines

Capture a baseline to freeze the planned dates at a point in time. **Capture baseline** and **Baselines…** ship in the Schedule toolbar's **Project actions (···)** menu with the 0.4 beta, gated at **Admin** or above; the REST API remains available and is the way to script it. Once a baseline is active, the task detail drawer shows a read-only baseline-vs-current comparison so you can see schedule variance. Multiple baselines are supported for rebaseline events. See [Baselines](/features/baselines/) for both the in-app and API workflows.

### Working calendars

Define working calendars with weekend rules and holiday exceptions. All duration calculations and lag values use working days. If your team observes a shutdown in August, add it once to the calendar — every task that spans it adjusts automatically.

## Building a schedule

TruePPM's schedule build mode is keyboard-first: type a task name, press Alt + → to indent (create a summary task), Enter to add a sibling, and the schedule fills in as you go. Dependencies are added by linking predecessor/successor IDs. The Gantt updates live.

→ See [Schedule Build Mode](/features/schedule-build-mode/), [Summary tasks](/features/summary-tasks/)

## Working with agile teams

This is where TruePPM is different from every other scheduling tool.

### The hybrid data model

Sprint stories are child tasks under your WBS work packages — see
[The data model, in 90 seconds](/overview/data-model/) for why that's true at
the row level, not just conceptually. They're not in a separate tool and not
imported via a connector.

A work package with a 10-day CPM duration might decompose into 8 stories worth 34 story points. When the sprint closes and the team delivered 28 of those points, TruePPM computes the team's velocity and offers a revised duration suggestion in the task drawer — accept it and the schedule re-forecasts. Durations are never silently rewritten; you stay in control of the plan.

### What velocity gives you today

When your team closes a sprint:

- The CPM-derived early start/finish remains your baseline commitment
- Velocity-calibration suggestions appear for the work packages whose stories under-delivered — each one a proposed duration revision you explicitly accept or dismiss
- Closing a sprint bound to a milestone records a fresh P50/P80 delivery forecast against that milestone (added in 0.3)

Live per-bar Gantt forecasts and amber/red schedule-variance indicators driven by mid-sprint velocity are part of the deep CPM-aware bridge planned for 0.5 — they do not exist yet.

### What you don't have to do

You don't have to:
- Ask your Scrum Master for a status update
- Manually translate "we finished 34 points" into schedule days
- Hold a weekly sync to reconcile the team's view with your Gantt
- Maintain a separate resource-tracking spreadsheet

The Scrum Master runs their sprints natively. Their velocity automatically becomes your forecast input.

→ Read the complete hybrid walkthrough in [The Story](/the-story/)

## Risk and forecasting

### Risk register

Log and track project risks with probability × impact scoring (1–25 scale). Link risks to specific tasks. Risk severity and count are visible on board cards so the team doesn't lose sight of risk during execution.

→ See [Risk register](/features/risk-register/)

### Probabilistic forecasting with stakeholders

The conversation shift that Monte Carlo enables:

- **Before TruePPM:** "We're on track for October 15th." (unqualified, often wishful)
- **With TruePPM:** "P50 is October 12th. P80 is October 22nd. We should commit to October 22nd. If you need October 15th, here's what has to go right and what the risk is."

P80 is the defensible number. It's the date with a real probability attached. Stakeholders who push back on P80 are asking you to commit to a coin flip.

## Real-time and mobile

When a scheduler or admin changes the plan, all connected browsers update immediately via WebSocket. No manual refresh, no stale data. The sync protocol is designed for unreliable connectivity — work offline, sync when you have signal.

## Evaluate it yourself (~10 minutes)

The fastest way to judge TruePPM as a PM is to watch the schedule react to a change. Run these steps in order — they start from a machine with nothing running.

1. **Start the stack and seed the demo.** From your TruePPM checkout (if you have not installed yet, start with [Installation](/getting-started/installation/)):

   ```bash
   make up
   docker compose exec api python manage.py load_sample_project --with-personas
   ```

   The command prints the sample's persona logins (`atlas-alex`, `atlas-priya`, …) and their shared password when it finishes. On a local Docker stack (`DEBUG=True`) that password is `demo`; anywhere else it is `$TRUEPPM_DEMO_PASSWORD` if you set it, otherwise a random token printed once — copy it before you clear the terminal.

2. **Sign in as the PM.** Open `http://localhost:5173` and sign in as **`atlas-sam`** — Sam Okafor, Project Scheduler, seeded with the **Scheduler** role and holding the Migration Tooling CPM plan.

3. **Open the Schedule.** In the left navigation rail, under **Plan**, click **Schedule** (`/projects/:id/schedule`). The critical path is lit up and milestones are marked. This is the plan TruePPM keeps current for you — no "Update Project" button anywhere.

4. **Change something.** Drag a task bar on the timeline, or click a row and edit its duration in the drawer. Downstream tasks shift on their own, and the critical path re-highlights if it moved.

5. **Read the forecast.** Look at the **Forecast** bar docked along the bottom of the Schedule — the chips should climb P50 ≤ P80 ≤ P95. Press **Details ›** for the full distribution and the tornado of top drivers. P80 is the date to commit to a client; the gap between P80 and your CPM date is your schedule risk, measured in days.

6. **Compare against the baseline.** Atlas seeds a **Kickoff baseline** on Migration Tooling, superseded by a **Post-dry-run re-plan** — so there is a real re-baseline to read variance against. Click any completed task's row and read the **Baseline** section in the drawer to see planned-vs-actual variance. To see the baselines themselves, open the Schedule toolbar's **Project actions (···)** menu → **Baselines…**.

:::note[Capturing a baseline needs Admin]
**Capture baseline** and **Baselines…** live in the Schedule's **Project actions (···)** menu and are gated at **Admin** or above. `atlas-sam` is a Scheduler, so he reads baseline variance but cannot capture a new one — sign in as `atlas-priya` (Priya Nair, Engineering Lead, Admin) if you want to try the capture flow.
:::

One honest note against your own test — *"does this work on my phone with no signal?"* — not yet. The installable PWA lands in **0.5** (add to home screen, offline time entry and reads), and the native offline mobile editor lands in **0.6**. Today this is a desktop/web evaluation, and that's the right thing to wait for if mobile is your dealbreaker.

→ For a guided, sample-by-sample walkthrough across four programs, see the [evaluation guide](/getting-started/evaluation-guide/).

## What's available

| Feature | Status |
|---------|--------|
| CPM scheduling (all 4 dependency types) | Shipped |
| Monte Carlo risk analysis (P50/P80/P95) | Shipped |
| Baselines (capture & compare) | Shipped — API; in-app capture ships in 0.4 |
| Critical path highlighting | Shipped |
| Risk register | Shipped |
| Board / Kanban view | Shipped |
| Sprint burndown | Shipped |
| Schedule build mode (keyboard-first) | Shipped |
| Summary tasks + WBS rollup | Shipped |
| Hybrid velocity → CPM forecast | Shipped |
| MS Project import/export | Shipped (UI + API, 0.2) |
| Gantt drag-to-reschedule (live CPM preview) | Shipped — the drag preview approximates a standard Mon–Fri calendar; the server's authoritative CPM (custom calendars, holidays) reconciles exact dates on commit |
| Baseline capture + comparison UI | Roadmap (0.4) |
| Structured rebaseline reasons + change control | Roadmap (0.5) |
| Time tracking (running timer, weekly timesheet) | Roadmap (0.4) |
| Timesheet approval + non-project time | Roadmap (0.5) |
| EVM (CPI / SPI / BCWP) | Roadmap (post-1.0) |

## Where to go next

- [Installation](/getting-started/installation/) — stand up an instance, or send this to whoever will
- [Quickstart](/getting-started/quickstart/) — the shortest path from install to a populated project
- [Evaluation guide](/getting-started/evaluation-guide/) — the same walkthrough across four bundled sample programs
- [Schedule view](/features/schedule/) — Gantt details, drag behavior, and how to read the dates
- [Baselines](/features/baselines/) — capture, rebaseline, and the variance comparison
- [The Story](/the-story/) — the end-to-end hybrid workflow; six narrative protagonists map to TruePPM's eight product personas
