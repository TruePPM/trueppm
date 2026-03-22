# Quickstart

This guide creates a project with two tasks and a dependency, triggers a CPM schedule calculation, and reads the result back. It assumes you have completed [Installation](installation.md) and the stack is running.

## 1. Authenticate

The API uses JWT. Obtain a token with the superuser you created during installation:

```bash
curl -s -X POST http://localhost:8000/api/token/ \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "yourpassword"}' \
  | jq .access
```

Export it for subsequent requests:

```bash
export TOKEN="<paste access token here>"
```

## 2. Create a calendar

```bash
curl -s -X POST http://localhost:8000/api/v1/calendars/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Standard 5-day week"}' \
  | jq '{id, name}'
```

Note the `id` — you will reference it when creating the project.

## 3. Create a project

```bash
curl -s -X POST http://localhost:8000/api/v1/projects/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My First Project",
    "start_date": "2026-04-01",
    "calendar": "<calendar-id>"
  }' | jq '{id, name, start_date}'
```

## 4. Add tasks

```bash
# Task A: Design (5 days)
curl -s -X POST http://localhost:8000/api/v1/tasks/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project": "<project-id>", "name": "Design", "duration": 5}' \
  | jq '{id, name, duration}'

# Task B: Build (10 days)
curl -s -X POST http://localhost:8000/api/v1/tasks/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project": "<project-id>", "name": "Build", "duration": 10}' \
  | jq '{id, name, duration}'
```

## 5. Add a dependency

Connect Design → Build with a Finish-to-Start dependency:

```bash
curl -s -X POST http://localhost:8000/api/v1/dependencies/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "predecessor": "<design-task-id>",
    "successor": "<build-task-id>",
    "dep_type": "FS",
    "lag": 0
  }' | jq .
```

## 6. Read the schedule

CPM recalculation runs automatically in the background via Celery after each write. Wait a moment, then read the schedule results:

```bash
curl -s http://localhost:8000/api/v1/tasks/?project=<project-id> \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.results[] | {name, early_start, early_finish, late_start, late_finish, total_float, is_critical}'
```

You should see both tasks with populated CPM fields. With a FS dependency and no lag:

- **Design**: early_start = 2026-04-01, early_finish = 2026-04-07, total_float = 0, is_critical = true
- **Build**: early_start = 2026-04-08, early_finish = 2026-04-21, total_float = 0, is_critical = true

Both tasks are on the critical path because there is only one path through the network.

## 7. Add a project member

Add another user to the project with the Member role:

```bash
curl -s -X POST http://localhost:8000/api/v1/projects/<project-id>/members/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user": "<user-id>", "role": 1}' \
  | jq '{id, role}'
```

Role values: Owner=4, Admin=3, Scheduler=2, Member=1, Viewer=0.

## Next steps

- [CPM Scheduler](../features/scheduler.md) — understand the scheduling engine
- [RBAC](../features/rbac.md) — the 5-role permission model in detail
- [Offline Sync](../features/offline-sync.md) — WatermelonDB delta protocol
- [API Reference](../api/index.md) — full endpoint documentation
