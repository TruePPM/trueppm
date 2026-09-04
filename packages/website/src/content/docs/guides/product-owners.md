---
title: For Product Owners
description: How TruePPM helps Product Owners manage the backlog, forecast releases with velocity, and protect sprint scope — without losing sight of the program schedule.
---

You own the backlog and the release forecast. You make prioritization calls, protect the team's sprint capacity, and answer the executive question: "When does this feature ship?" TruePPM connects your backlog directly to the program schedule so those answers are data-driven, not guesswork.

## Your backlog in TruePPM

The backlog lives in the Sprints workspace as the pool of unprioritized work waiting to enter a sprint. Stories are tasks with story points and (optionally) a parent work package in the WBS. Prioritization is order-based — drag to reorder; the team pulls from the top.

### Backlog and WBS: the hybrid view

Work packages and stories are the same underlying task row — see
[The data model, in 90 seconds](/overview/data-model/) for the mechanics. In
practice: your epics are the PM's work packages, your stories are their leaf
children with story points rolling up automatically, and your sprint
commitment feeds the PM's Gantt the moment a story's status changes. You
don't have to manually maintain two systems.

:::tip[Feature/Epic hierarchy]
Full epic task type with dedicated backlog and board hierarchy shipped in 0.3: epics have a dedicated view with child story hierarchy, and they remain WBS work packages under the hood, so an epic is still the same row the PM sees as a summary task.
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

**Sprint closures update the forecast.** When you close a sprint, TruePPM records a fresh P50/P80 delivery forecast against the bound milestone (added in 0.3); the committed date is never auto-moved. The gap between the forecast and the committed milestone date is visible to both of you — the conversation about whether to slip the date or cut scope happens with actual numbers.

→ Read the full hybrid walkthrough in [The Story](/the-story/)

## Evaluate it yourself (~10 minutes)

Run these steps in order — they start from a machine with nothing running.

1. **Start the stack and seed the demo.** From your TruePPM checkout (if you have not installed yet, start with [Installation](/getting-started/installation/)):

   ```bash
   make up
   docker compose exec api python manage.py load_sample_project --with-personas
   ```

   The command prints the sample's persona logins (`atlas-alex`, `atlas-priya`, …) and their shared password when it finishes. On a local Docker stack (`DEBUG=True`) that password is `demo`; anywhere else it is `$TRUEPPM_DEMO_PASSWORD` if you set it, otherwise a random token printed once — copy it before you clear the terminal.

2. **Sign in.** Open `http://localhost:5173` and sign in as **`atlas-jordan`** — Jordan Blake, the Product Owner persona, seeded with the **Admin** role and owning Platform Core's sprints and release forecast. That surface shows the backlog and board the way you work them.

3. **Open the backlog.** In the left navigation rail, under **Deliver**, click **Backlog** (`/projects/:id/product-backlog`). It's ordered by priority — drag to reorder. The order is your statement of what matters; the team pulls from the top.

4. **Open the burn-up chart.** Go to **Deliver → Sprints** (`/projects/:id/sprints`). The total-scope line steps up where scope was added mid-sprint, so "what we committed to" and "what crept in" are visibly different.

5. **Read the release forecast.** Velocity (completed points per sprint) drives a *remaining ÷ velocity* forecast — the answer to "when does this ship?" in your language, not a CPM planned date.

6. **Check scope protection.** On the same Sprints page, the **capacity preflight** panel sits in the top half of the metrics row's right column. It's the evidence you point to when someone wants to inject scope into a sprint that's already full.

This is your one-question filter — *does it tell me when the feature ships, in my language?* — answered with a velocity forecast, not a planned date.

→ The [evaluation guide](/getting-started/evaluation-guide/) adds the **Aurora** and **Helios** samples (added in 0.3), where a scope injection is accepted in one program and rejected in another.

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

## Shipped in 0.3

- **Epic task type** — dedicated epic view with child story hierarchy, epic-level burn chart, release-scoped backlog, plus create / edit / delete of epics directly on the product backlog: clicking an epic opens a detail drawer to edit its name and description, and deleting an epic moves its stories to Ungrouped rather than removing them
- **Unified sprint planning** — interactive sprint planning session with capacity vs. commitment sidebar

**Further out:** a **read-only MCP server** lands in 0.4 — point an AI assistant at your instance to query the backlog, forecast, and sprint status (computed server-side, self-hosted). PO write workflows via assistant (backlog refinement, story sizing suggestions) follow in 0.6.

## Where to go next

- [Installation](/getting-started/installation/) — stand up an instance, or send this to whoever will
- [Evaluation guide](/getting-started/evaluation-guide/) — the Aurora and Helios samples, where a scope injection is accepted in one program and rejected in another
- [Sprints workspace](/features/sprints/) — the full sprint lifecycle reference
- [Burn charts](/features/burn-charts/) — the release forecasting charts
- [Product backlog](/features/product-backlog/) — epics, ordering, and the dual backlog

To see the same data from the schedule side, sign in as `atlas-sam` (Sam Okafor, Project Scheduler, Scheduler role) and open **Plan → Schedule** — your stories are child tasks of his work packages, in one hierarchy.
