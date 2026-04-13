---
title: Quickstart
description: Create your first project and schedule via the API.
---

This guide creates a project with two tasks and a dependency, triggers a CPM schedule calculation, and reads the result back — all via the REST API. It assumes you have completed [Installation](/getting-started/installation/) and the stack is running.

:::tip
The web UI is in early development. For now, the API is the primary way to interact with TruePPM. The examples below use `curl` and `jq`.
:::

## 1. Authenticate

```bash
curl -s -X POST http://localhost:8000/api/token/ \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "yourpassword"}' \
  | jq .access

export TOKEN="<paste access token here>"
```

## 2. Create a calendar

```bash
CALENDAR=$(curl -s -X POST http://localhost:8000/api/v1/calendars/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Standard 5-day week"}')

CALENDAR_ID=$(echo $CALENDAR | jq -r .id)
```

## 3. Create a project

```bash
PROJECT=$(curl -s -X POST http://localhost:8000/api/v1/projects/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"My First Project\", \"start_date\": \"2026-04-01\", \"calendar\": \"$CALENDAR_ID\"}")

PROJECT_ID=$(echo $PROJECT | jq -r .id)
```

## 4. Add tasks

```bash
TASK_A=$(curl -s -X POST http://localhost:8000/api/v1/tasks/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project\": \"$PROJECT_ID\", \"name\": \"Design\", \"duration\": 5}")

TASK_B=$(curl -s -X POST http://localhost:8000/api/v1/tasks/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project\": \"$PROJECT_ID\", \"name\": \"Build\", \"duration\": 10}")

TASK_A_ID=$(echo $TASK_A | jq -r .id)
TASK_B_ID=$(echo $TASK_B | jq -r .id)
```

## 5. Add a dependency

```bash
curl -s -X POST http://localhost:8000/api/v1/dependencies/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"predecessor\": \"$TASK_A_ID\", \"successor\": \"$TASK_B_ID\", \"dep_type\": \"FS\", \"lag\": 0}"
```

## 6. Read the schedule

CPM recalculates automatically via Celery after each write. Wait a moment, then:

```bash
curl -s "http://localhost:8000/api/v1/tasks/?project=$PROJECT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.results[] | {name, early_start, early_finish, total_float, is_critical}'
```

Expected output:

```json
{"name": "Design", "early_start": "2026-04-01", "early_finish": "2026-04-07", "total_float": 0, "is_critical": true}
{"name": "Build",  "early_start": "2026-04-08", "early_finish": "2026-04-21", "total_float": 0, "is_critical": true}
```

Both tasks are critical because there is only one path through the network.

## 7. Add a project member

```bash
curl -s -X POST "http://localhost:8000/api/v1/projects/$PROJECT_ID/members/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user": "<user-id>", "role": 1}'
```

Role values: Owner=4, Admin=3, Scheduler=2, Member=1, Viewer=0.

## 8. Open the web UI

Navigate to `http://localhost:5173` in your browser. The Gantt view displays example tasks and dependencies to demonstrate the visualization. Live API wiring is in progress.

## Next steps

- [CPM Scheduler](/features/scheduler/) — deep dive into the scheduling engine and Monte Carlo
- [Gantt View](/features/gantt/) — the primary visualization
- [RBAC](/administration/rbac/) — role and permission details
- [API Reference](/api/reference/) — full endpoint listing
