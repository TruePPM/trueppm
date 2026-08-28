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

Run these steps in order — they start from a machine with nothing running.

1. **Start the stack and seed the demo.** From your TruePPM checkout (if you have not installed yet, start with [Installation](/getting-started/installation/)):

   ```bash
   make up
   docker compose exec api python manage.py load_sample_project --with-personas
   ```

   The command prints the sample's persona logins (`atlas-alex`, `atlas-priya`, …) and their shared password when it finishes. On a local Docker stack (`DEBUG=True`) that password is `demo`; anywhere else it is `$TRUEPPM_DEMO_PASSWORD` if you set it, otherwise a random token printed once — copy it before you clear the terminal.

2. **Sign in as the resource manager.** Open `http://localhost:5173` and sign in as **`sarah`** — Sarah Lee, seeded with the **Scheduler** role.

3. **Open capacity preflight.** In the left navigation rail, under **Deliver**, click **Sprints** (`/projects/:id/sprints`). The **capacity preflight** panel is in the top half of the metrics row's right column. It surfaces an over-allocated member before the sprint is activated — that's your core test, *catch the conflict before it's locked in*, at project scope.

4. **Look at an assignment.** Open **People → Resources** (`/projects/:id/resources`) for the roster, then open any assigned task from the board or schedule and read its assignment in the drawer. Units and work hours are fractional, not a binary 100% / 0% — the demo seeds a 0.8 DevOps engineer and a 0.5 resource manager, so the roster is not everyone-at-100%.

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

## Where to go next

- [Installation](/getting-started/installation/) — stand up an instance, or send this to whoever will
- [Quickstart](/getting-started/quickstart/) — the shortest path from install to a populated project
- [API reference](/api/reference/) — the Resources and Task-Resources endpoints
- [Resources](/features/resources/) — roster, capacity profiles, and allocation
- [RBAC model](/administration/rbac/) — the Admin role or above is needed to manage resources
