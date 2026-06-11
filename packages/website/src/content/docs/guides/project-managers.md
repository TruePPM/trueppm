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

All four standard dependency types are supported with calendar-aware lag:

| Type | Meaning |
|------|---------|
| Finish-to-Start (FS) | Successor starts after predecessor finishes |
| Start-to-Start (SS) | Successor starts after predecessor starts |
| Finish-to-Finish (FF) | Successor finishes after predecessor finishes |
| Start-to-Finish (SF) | Successor finishes after predecessor starts |

Lag values (positive or negative) are in calendar working days — weekends and calendar exceptions are skipped automatically.

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

Capture a baseline to freeze the planned dates at a point in time. Capturing and managing baselines is currently done through the **REST API** — there is no in-app capture button yet (a UI is on the 0.5 roadmap). Once a baseline is active, the task detail drawer shows a read-only baseline-vs-current comparison so you can see schedule variance. Multiple baselines are supported for rebaseline events. See [Baselines](/features/baselines/) for the full API workflow.

### Working calendars

Define working calendars with weekend rules and holiday exceptions. All duration calculations and lag values use working days. If your team observes a shutdown in August, add it once to the calendar — every task that spans it adjusts automatically.

## Building a schedule

TruePPM's schedule build mode is keyboard-first: type a task name, press Tab to indent (create a summary task), Enter to add a sibling, and the schedule fills in as you go. Dependencies are added by linking predecessor/successor IDs. The Gantt updates live.

→ See [Schedule Build Mode](/features/schedule-build-mode/), [Summary tasks](/features/summary-tasks/)

## Working with agile teams

This is where TruePPM is different from every other scheduling tool.

### The hybrid data model

When your team creates sprint stories, those stories are child tasks under your WBS work packages. They're not in a separate tool. They're not imported via a connector. They're in the same task hierarchy, sharing the same row in the database, visible from both the Gantt and the board.

A work package with a 10-day CPM duration might decompose into 8 stories worth 34 story points. When the sprint closes and the team delivered 28 of those points, TruePPM computes the team's velocity and offers a revised duration suggestion in the task drawer — accept it and the schedule re-forecasts. Durations are never silently rewritten; you stay in control of the plan.

### What velocity gives you today

When your team closes a sprint:

- The CPM-derived early start/finish remains your baseline commitment
- Velocity-calibration suggestions appear for the work packages whose stories under-delivered — each one a proposed duration revision you explicitly accept or dismiss
- Closing a sprint bound to a milestone records a fresh P50/P80 delivery forecast against that milestone (ships in 0.3)

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

## What's available

| Feature | Status |
|---------|--------|
| CPM scheduling (all 4 dependency types) | Shipped |
| Monte Carlo risk analysis (P50/P80/P95) | Shipped |
| Baselines (capture & compare) | Shipped — API only, no UI yet |
| Critical path highlighting | Shipped |
| Risk register | Shipped |
| Board / Kanban view | Shipped |
| Sprint burndown | Shipped |
| Schedule build mode (keyboard-first) | Shipped |
| Summary tasks + WBS rollup | Shipped |
| Hybrid velocity → CPM forecast | Shipped |
| MS Project import/export | Shipped (UI + API, 0.2) |
| Gantt drag-to-reschedule (WASM CPM) | Shipped |
| Baseline UI + structured rebaseline reasons | Roadmap (0.5) |
| Time tracking | Roadmap (0.5) |
| EVM (CPI / SPI / BCWP) | Roadmap (post-1.0) |

## Getting started

1. Ask your admin to [set up a TruePPM instance](/getting-started/installation/)
2. Walk through the [Quickstart](/getting-started/quickstart/) — seed the demo project and log in as `raj` (PM persona) to see the full hybrid view
3. Read the [Schedule view](/features/schedule/) for Gantt details
4. Read [The Story](/the-story/) for the end-to-end hybrid workflow — six narrative protagonists map to TruePPM's eight product personas
