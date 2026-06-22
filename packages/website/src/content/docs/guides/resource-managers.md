---
title: For Resource Managers
description: How TruePPM helps resource managers track allocations, assign people to tasks, and plan capacity.
---

You allocate people across projects and need to spot conflicts before they become problems. TruePPM gives you per-task resource assignment within projects today, with cross-project visibility on the enterprise roadmap.

## What you get today

### See capacity before the sprint starts

The clearest thing to try is **capacity preflight**. When a sprint is activated, TruePPM checks the committed story points against the team's available hours and flags anyone who is over-allocated — *before* the sprint starts, not on day 8 when it's too late. It's the project-scoped version of the conflict warning you're really after.

### Fractional allocation and work hours

Assignments carry **fractional units and work hours**, so a person can be 60% on a task rather than simply on or off. When someone's daily load within a project crosses 100%, TruePPM flags the over-allocation automatically.

### Assign people in the app — or script it

In the web app you assign people to tasks from the task drawer. If you'd rather build allocation reports the way you build spreadsheets, every resource and task-resource has a full REST endpoint:

```bash
# Assign a resource to a task
curl -s -X POST http://localhost:8000/api/v1/task-resources/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": "<task-id>", "resource": "<resource-id>"}'
```

### Real-time awareness

When a scheduler changes the plan — re-sequences tasks or adjusts durations — the schedule recalculates automatically and connected clients get a WebSocket update. You see allocation changes as they happen.

## Evaluate it yourself (~10 minutes)

Seed the demo (`seed_demo_project --with-personas`) and sign in as **`sarah`** — the resource-manager persona (password `demo`).

1. **Open the sprint's capacity preflight.** It surfaces an over-allocated member before the sprint is activated. That's your core test — *catch the conflict before it's locked in* — at project scope.
2. **Look at an assignment.** Units and work hours are fractional, not a binary 100% / 0%.

Be clear-eyed about the gap. Your top two criteria — one view of a person across *all* their projects, and a pre-commit warning that fires across projects — land in **0.5**. Today the conflict check is per-project. A pre-0.5 evaluation should expect that; it's sequenced on the roadmap, not an oversight.

## Current limitations

TruePPM's resource management is single-project in scope today:

- **No cross-project view yet** — resource assignments are per-project; there is no single dashboard showing a person's load across all their projects
- **No cross-project conflict detection yet** — overlapping assignments across projects aren't flagged (planned for 0.5)

The cross-project pieces are the heart of your job, and they are prioritized on the roadmap for 0.5.

## What's coming

| Feature | Status | Edition |
|---------|--------|---------|
| Resource allocation percentages | Shipped (0.2) | Community |
| Resource view (per-project) | Planned | Community |
| Cross-project resource view (within a program) | Planned | Community |
| Cross-program resource leveling | Planned | Enterprise |
| Resource heat map (cross-portfolio) | Planned | Enterprise |
| Capacity forecasting (portfolio scope) | Planned | Enterprise |
| Conflict detection and alerts | Planned | Community |

:::note[Community vs. Enterprise]
Within a program (one or more related projects), resource management will be fully featured in the community edition — including conflict detection within the program. Cross-program and portfolio-level features (leveling across programs, org-wide heat maps, portfolio capacity forecasting) are planned for the enterprise edition.
:::

## Getting started

1. Ask your admin to [set up a TruePPM instance](/getting-started/installation/)
2. Walk through the [Quickstart](/getting-started/quickstart/) to understand the API
3. Explore the [API reference](/api/reference/) — see the Resources and Task-Resources endpoints
4. Review the [RBAC model](/administration/rbac/) — Admin role (300) or above is needed to manage resources
