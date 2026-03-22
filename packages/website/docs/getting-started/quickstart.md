---
id: quickstart
title: Quickstart
sidebar_position: 2
---

This guide creates a project with two tasks and a dependency, triggers a CPM schedule calculation, and reads the result back. It assumes you have completed [Installation](installation.md) and the stack is running.

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

## Next steps

- [CPM Scheduler](../features/scheduler.md)
- [RBAC](../features/rbac.md)
- [Offline Sync](../features/offline-sync.md)
- [API Reference](../api/index.md)
