---
title: For Project Managers
description: How TruePPM helps project managers build reliable schedules, track the critical path, and give stakeholders realistic delivery dates.
---

You manage schedules, track progress, and need to give stakeholders delivery dates they can trust. TruePPM gives you real scheduling math — not just bars on a timeline.

## What you get today

### Automatic CPM scheduling

Every time you add a task, change a duration, or modify a dependency, TruePPM recalculates the entire schedule automatically. No manual recalculation, no "update project" button. You always see:

- **Critical path** — which tasks drive your deadline
- **Float** — how much each task can slip before it affects the end date
- **Early/late dates** — the window each task can occupy

All four standard dependency types are supported:

| Type | Meaning |
|------|---------|
| Finish-to-Start (FS) | Successor starts after predecessor finishes |
| Start-to-Start (SS) | Successor starts after predecessor starts |
| Finish-to-Finish (FF) | Successor finishes after predecessor finishes |
| Start-to-Finish (SF) | Successor finishes after predecessor starts |

Lag (positive or negative) is in calendar working days — weekends and holidays are skipped automatically.

### Monte Carlo risk analysis

Your CPM finish date is typically P50 — there's only a **50% chance** you'll hit it. That's the number most tools show as "the date."

TruePPM lets you add three-point estimates (optimistic, most likely, pessimistic) to any task and run a Monte Carlo simulation:

| Percentile | What it means |
|-----------|--------------|
| **P50** | 50% chance of finishing by this date. Where your CPM date usually lands. |
| **P80** | 80% chance. **Commit to this date with stakeholders.** |
| **P95** | 95% chance. Use this for contractual deadlines. |

10,000 simulation runs on a 200-task schedule completes in under 5 seconds.

### Calendar-aware scheduling

Define working calendars with weekend rules and holiday exceptions. All duration calculations and lag values use working days — you don't have to mentally convert between calendar days and work days.

### Real-time updates

When a scheduler or admin changes the plan, you see it immediately. WebSocket push means no manual refresh — the Schedule view (Gantt-style) updates in real time across all connected browsers.

### Offline and mobile ready

The sync protocol is designed for unreliable connectivity. Sync when you have signal, work offline when you don't. The protocol uses server-versioned deltas with soft-delete tombstones — you never lose data.

## What's coming

| Feature | Status |
|---------|--------|
| Gantt drag-to-reschedule | Planned — requires WASM CPM on client |
| Time tracking | Planned |
| Baselines and baseline comparison | Planned |
| MS Project import/export | Planned |
| Burn charts | Planned |
| Risk register | Planned |
| Board/Kanban view | In progress |

## Getting started

1. Ask your admin to [set up a TruePPM instance](/getting-started/installation/)
2. Walk through the [Quickstart](/getting-started/quickstart/) to create your first project
3. Read the [Scheduler deep dive](/features/scheduler/) for CPM and Monte Carlo details
4. Explore the [Schedule view](/features/schedule/) — the project timeline (Gantt-style) with critical path, baselines, and milestones
