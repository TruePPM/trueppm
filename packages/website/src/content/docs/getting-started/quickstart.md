---
title: Quickstart
description: Get from a fresh clone to a populated workspace in five minutes.
---

The fastest path from `git clone` to a workspace you can actually click around. Two routes: the **demo seed** (recommended for evaluation) and the **API tutorial** (recommended for learning the data model).

You should already have completed [Installation](/getting-started/installation/) — the stack is up via `docker compose up -d`.

## Route A — seed the demo project (recommended)

The `seed_demo_project` management command bootstraps a coherent "Platform Migration" project with phases, work packages, baselines, resources, eight closed sprints, an active sprint mid-window, a planned sprint, a retro with a promoted action item, and board WIP overload. With `--with-personas` it also creates six demo logins.

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

That's it. Sign in at `http://localhost:5173` as any of the personas (password: `demo`):

| Username | Persona | What to look at first |
|---|---|---|
| `maya` | Scrum Master | The [Sprints workspace](/features/sprints/) — burndown, capacity, backlog, retro all populated |
| `raj` | Project Manager | The [Schedule view](/features/schedule/) — critical path lit up, milestones, baseline overlay |
| `sarah` | Resource Manager | The Capacity preflight panel surfaces an over-allocated member |
| `diana` | PMO Director | The [Multi-team Sprints lens](/features/multi-team-lens/) shows both projects |
| `carlos` | Executive | The Overview page with forecast confidence intervals |
| `tom` | Senior Engineer | The Board with the WIP overload chip and his assigned cards |

Re-running the command clears the prior demo and re-seeds, so you can refresh after pulling new features.

:::tip[The story behind the demo]
The demo project is built to walk through the eight-step [hybrid PM flow](/the-story/) end-to-end. Read the story, then sign in as each persona — the seeded data exercises every step.
:::

## Route B — build a project via the API

If you want to learn the data model rather than evaluate the UI, build a project with two tasks and a dependency, trigger CPM, and read the result back. The examples below use `curl` and `jq`.

### 1. Set up admin credentials

If you haven't already, see [Admin password setup](/administration/admin-password/). The default is to run `python manage.py create_admin` which generates a secure random password and writes it to `/tmp/trueppm_admin_password`.

### 2. Authenticate

```bash
curl -s -X POST http://localhost:8000/api/token/ \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "<your password>"}' \
  | jq .access

export TOKEN="<paste access token here>"
```

### 3. Create a calendar

```bash
CALENDAR=$(curl -s -X POST http://localhost:8000/api/v1/calendars/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Standard 5-day week"}')

CALENDAR_ID=$(echo $CALENDAR | jq -r .id)
```

### 4. Create a project

```bash
PROJECT=$(curl -s -X POST http://localhost:8000/api/v1/projects/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"My First Project\", \"start_date\": \"2026-04-01\", \"calendar\": \"$CALENDAR_ID\", \"methodology\": \"HYBRID\"}")

PROJECT_ID=$(echo $PROJECT | jq -r .id)
```

The `methodology` field controls default tab visibility — see [Project methodology preset](/features/methodology-preset/).

### 5. Add tasks

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

### 6. Add a dependency

```bash
curl -s -X POST http://localhost:8000/api/v1/dependencies/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"predecessor\": \"$TASK_A_ID\", \"successor\": \"$TASK_B_ID\", \"dep_type\": \"FS\", \"lag\": 0}"
```

### 7. Read the schedule

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

### 8. Add a project member

```bash
curl -s -X POST "http://localhost:8000/api/v1/projects/$PROJECT_ID/members/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user": "<user-id>", "role": 1}'
```

Role values: Owner=4, Admin=3, Scheduler=2, Member=1, Viewer=0.

### 9. Open the web UI

Navigate to `http://localhost:5173`. The [Schedule view](/features/schedule/) (Gantt-style) renders the timeline with critical path lit up; the Board, Sprints, and supporting views are all wired against the live API.

## Next steps

- [The Story](/the-story/) — the eight-step hybrid PM flow narrative
- [Admin password setup](/administration/admin-password/) — production password rotation
- [CPM scheduler](/features/scheduler/) — deep dive into the scheduling engine and Monte Carlo
- [Schedule view](/features/schedule/) — the project timeline (Gantt-style)
- [Sprints workspace](/features/sprints/) — burndown, capacity, velocity, backlog, retro
- [RBAC](/administration/rbac/) — role and permission details
- [API reference](/api/reference/) — full endpoint listing
