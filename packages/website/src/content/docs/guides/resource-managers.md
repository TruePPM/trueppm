---
title: For Resource Managers
description: How TruePPM helps resource managers track allocations, assign people to tasks, and plan capacity.
---

You allocate people across projects and need to spot conflicts before they become problems. TruePPM gives you per-task resource assignment within projects today, with cross-project visibility on the enterprise roadmap.

## What you get today

### Resource assignments

Assign resources to tasks with the REST API. Each assignment links a resource to a task within a project:

```bash
# Assign a resource to a task
curl -s -X POST http://localhost:8000/api/v1/task-resources/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": "<task-id>", "resource": "<resource-id>"}'
```

### Project-scoped visibility

See who's assigned to what within each project. Resources and task-resource assignments have full CRUD endpoints, so you can build allocation reports from the API.

### Real-time awareness

When a scheduler changes the plan — re-sequences tasks or adjusts durations — the schedule recalculates automatically and connected clients receive a WebSocket notification. You see allocation changes as they happen.

## Current limitations

TruePPM's resource management is intentionally basic in 0.1:

- **No partial allocation percentages yet** — assignment is binary (assigned or not)
- **No cross-project view** — resource assignments are per-project; no single dashboard showing a person's load across all projects
- **No conflict detection** — if someone is assigned to overlapping tasks across projects, there's no automatic warning

These are important for resource managers and are prioritized on the roadmap.

## What's coming

| Feature | Status | Edition |
|---------|--------|---------|
| Resource allocation percentages | Planned | Community |
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
4. Review the [RBAC model](/administration/rbac/) — Admin role (3) or above is needed to manage resources
