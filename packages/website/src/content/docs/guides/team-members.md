---
title: For Team Members
description: How TruePPM helps team members see their assignments, track progress, and stay in sync without overhead.
---

You want to see what's assigned to you, log progress, and get back to real work. TruePPM is designed to minimize the overhead of project management tools.

## What you get today

### Clear task visibility

See your task assignments with durations, dependencies, and scheduled dates. The API provides full access to project data scoped to your role — you see everything in your project without navigating a complex hierarchy.

### Real-time updates

When a scheduler changes the plan — re-sequences tasks, adjusts durations, adds dependencies — you see the update immediately. WebSocket push, no manual refresh, no stale data.

### Role-based access

As a **Member** (role 1), you can:
- View all project data (tasks, dependencies, resources, calendars)
- Log time against tasks
- Pull delta sync for offline/mobile access
- Connect to the real-time WebSocket

You can't accidentally modify the schedule or break dependencies. That requires the **Scheduler** role or above.

### API-first

If you live in the terminal or want to integrate TruePPM with other tools, the REST API is the primary interface. The [OpenAPI schema](http://localhost:8000/api/schema/swagger-ui/) documents every endpoint, and JWT auth means you can script anything.

```bash
# Get your tasks
curl -s "http://localhost:8000/api/v1/tasks/?project=$PROJECT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.results[] | {name, early_start, early_finish, is_critical}'
```

## What's coming

| Feature | Status |
|---------|--------|
| Time logging in the web UI | Planned |
| Personal task dashboard | Planned |
| Notification preferences | Planned |
| Board/Kanban view | In progress |
| Jira / GitLab connectors | Enterprise roadmap |

:::note[About integrations]
Jira and GitLab connectors are planned for the enterprise edition. The community edition API is fully documented, so building a custom integration is straightforward using the [API reference](/api/reference/).
:::

## Getting started

1. Get your credentials from your project admin
2. Authenticate via `POST /api/token/` (see [Quickstart](/getting-started/quickstart/))
3. Explore the [API reference](/api/reference/) for available endpoints
4. Check the [real-time docs](/features/real-time/) if you want to subscribe to WebSocket events
