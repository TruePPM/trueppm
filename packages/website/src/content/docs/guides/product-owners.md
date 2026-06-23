---
title: For Product Owners
description: How TruePPM helps Product Owners manage the backlog, forecast releases with velocity, and protect sprint scope — without losing sight of the program schedule.
---

You own the backlog and the release forecast. You make prioritization calls, protect the team's sprint capacity, and answer the executive question: "When does this feature ship?" TruePPM connects your backlog directly to the program schedule so those answers are data-driven, not guesswork.

## Your backlog in TruePPM

The backlog lives in the Sprints workspace as the pool of unprioritized work waiting to enter a sprint. Stories are tasks with story points and (optionally) a parent work package in the WBS. Prioritization is order-based — drag to reorder; the team pulls from the top.

### Backlog and WBS: the hybrid view

When the PM builds a schedule, work packages become the high-level containers in the WBS (think epics or features). When you decompose those into stories, each story is a child task of its work package. This means:

- **Your epics are the PM's work packages.** They share the same row in the database.
- **Your stories are their leaf children.** Story point estimates roll up to the work package.
- **Your sprint commitment feeds the PM's Gantt automatically.** When the team delivers stories, the work package's remaining duration updates in real time.

You don't have to manually maintain two systems. Your backlog IS the schedule's leaf layer.

:::tip[Feature/Epic hierarchy]
Full epic task type with dedicated backlog and board hierarchy is on the roadmap for 0.3. Today, epics are represented as summary tasks with story children — fully functional, without the dedicated epic UI.
:::

## Release forecasting

### Velocity-based forecasting

TruePPM tracks velocity (completed story points per sprint) across all closed sprints. The velocity panel shows a rolling average with standard deviation. This feeds directly into release forecasting:

Given velocity V and remaining story points R, the forecast is **R / V sprints until done**. TruePPM computes this automatically — you see the forecast close date on the burn-up chart.

This is the answer to "when does the feature ship?" It's not a date you commit to in a planning meeting and then hope holds. It's a live forecast that updates every time a sprint closes.

### Burn-up chart

The burn-up chart shows total scope vs. completed work over time. Unlike a burndown (which shows what's left), burn-up makes scope changes visible — when new stories are added, the total scope line steps up. You can see the delta between "what we committed to" and "what we added" clearly.

→ See [Burn charts](/features/burn-charts/)

### Monte Carlo for release dates

For committed release dates, run Monte Carlo on the program schedule. This gives you P50/P80/P95 completion dates based on PERT estimates on deterministic tasks. The answer to stakeholders becomes: "P80 is October 22nd. We're 80% confident. If you need October 15th, here's what has to go right."

→ See [Scheduler engine — Monte Carlo](/features/scheduler/)

## Sprint scope protection

### What to say no to

When someone asks to add scope mid-sprint, the capacity preflight panel is your evidence. It shows the sprint's committed story points vs. available team hours. If the sprint is already at capacity, adding scope means something else moves out.

The sprint burndown chart makes scope additions visible as amber dots with step-ups in the scope line. This data is the record of what arrived mid-sprint vs. what was committed — useful for retrospectives and stakeholder conversations about why forecasts slip.

### Maintaining backlog hygiene

Before sprint planning, groom the backlog:
1. Re-prioritize by dragging stories into order
2. Verify estimates are current (velocity calibration suggestions appear after sprint close)
3. Check that stories at the top have acceptance criteria written

The team pulls from the top. The order is your statement of what matters most.

→ See [Velocity calibration](/features/velocity-calibration/)

## Working with the PM

The most important interface between the PO and the PM:

**Scope changes flow upward automatically.** When you add stories mid-sprint (scope creep), the sprint records a scope-change event and the milestone rollup surfaces a scope-change indicator. No status call needed — they see it when it happens.

**Velocity trend is visible to both of you — when the team shares velocity to the PM tier.** If velocity has been declining for three sprints, the PM receives velocity-calibration suggestions to revise estimates — applied only when accepted. You both see the same risk signal.

**Sprint closures update the forecast.** When you close a sprint, TruePPM records a fresh P50/P80 delivery forecast against the bound milestone (ships in 0.3); the committed date is never auto-moved. The gap between the forecast and the committed milestone date is visible to both of you — the conversation about whether to slip the date or cut scope happens with actual numbers.

→ Read the full hybrid walkthrough in [The Story](/the-story/)

## Evaluate it yourself (~10 minutes)

Seed the demo (`seed_demo_project --with-personas`) and sign in as **`maya`** — the Scrum Master persona (password `demo`). That surface shows the backlog and board the way you work them. (A dedicated Product Owner login arrives with the 0.3 sample projects.)

1. **Open the backlog.** It's ordered by priority — drag to reorder. The order is your statement of what matters; the team pulls from the top.
2. **Open the burn-up chart.** The total-scope line steps up where scope was added mid-sprint, so "what we committed to" and "what crept in" are visibly different.
3. **Read the release forecast.** Velocity (completed points per sprint) drives a *remaining ÷ velocity* forecast — the answer to "when does this ship?" in your language, not a CPM planned date.
4. **Check scope protection.** The capacity preflight panel is the evidence you point to when someone wants to inject scope into a sprint that's already full.

This is your one-question filter — *does it tell me when the feature ships, in my language?* — answered with a velocity forecast, not a planned date.

→ The [evaluation guide](/getting-started/evaluation-guide/) adds the **Aurora** and **Helios** samples (ship in 0.3), where a scope injection is accepted in one program and rejected in another.

## What's available now

| Feature | Status |
|---------|--------|
| Sprint backlog (prioritization by order) | Shipped |
| Velocity tracking + rolling average | Shipped |
| Burn-up and burn-down charts | Shipped |
| Capacity preflight at sprint planning | Shipped |
| Velocity calibration suggestions | Shipped |
| Monte Carlo release confidence (P50/P80/P95) | Shipped |
| Sprint scope change tracking (burn-up markers) | Shipped |
| WBS-linked stories (parent work packages) | Shipped |

## On the roadmap (0.3)

- **Epic task type** — dedicated epic view with child story hierarchy, epic-level burn chart, release-scoped backlog
- **Unified sprint planning** — interactive sprint planning session with capacity vs. commitment sidebar

**Further out:** a **read-only MCP server** lands in 0.4 — point an AI assistant at your instance to query the backlog, forecast, and sprint status (computed server-side, self-hosted). PO write workflows via assistant (backlog refinement, story sizing suggestions) follow in 0.6.

## Getting started

1. Ask your admin to [set up a TruePPM instance](/getting-started/installation/)
2. Seed the demo project and log in as `raj` (PM) to see the WBS hierarchy, then as `maya` (Scrum Master) to see the backlog and board from the delivery side
3. Read [Sprints workspace](/features/sprints/) for the full sprint lifecycle reference
4. Read [Burn charts](/features/burn-charts/) for the release forecasting charts
