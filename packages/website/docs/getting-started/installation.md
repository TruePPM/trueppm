---
id: installation
title: Installation
sidebar_position: 1
---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Docker + Docker Compose | 24+ |
| Git | any recent |
| Python | 3.12+ (for local scheduler development only) |

You do not need Python installed locally to run the API — Docker handles it.

## Clone the repository

```bash
git clone git@gitlab.com:trueppm/trueppm.git
cd trueppm
```

## Start the stack

```bash
docker compose up -d
```

This starts four services:

| Service | Port | Purpose |
|---------|------|---------|
| `db` | 5432 | PostgreSQL 16 |
| `redis` | 6379 | Celery broker + Django Channels layer |
| `api` | 8000 | Django ASGI (uvicorn) |
| `celery` | — | CPM auto-scheduling worker |

Wait for all services to be healthy (usually 15–20 seconds), then apply migrations:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```

## Verify

```bash
curl http://localhost:8000/api/v1/projects/
# → {"count":0,"results":[]}
```

The OpenAPI schema is at `http://localhost:8000/api/schema/` (YAML) and `http://localhost:8000/api/schema/swagger-ui/` (interactive).

## Scheduler package only

If you only need the scheduling engine (no API, no Docker):

```bash
pip install trueppm-scheduler
```

```python
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency

calendar = Calendar(id="cal-1", name="Standard")
project = Project(id="p-1", name="My Project", start_date="2026-01-01", calendar=calendar)
task_a = Task(id="t-1", name="Design", duration=5, project_id="p-1")
task_b = Task(id="t-2", name="Build", duration=10, project_id="p-1")
dep = Dependency(id="d-1", predecessor_id="t-1", successor_id="t-2", dep_type="FS")

result = schedule(project, [task_a, task_b], [dep], calendar)
print(result.tasks["t-2"].early_finish)  # 2026-01-20
```

## Environment variables

For local development, `docker-compose.yml` sets sensible defaults. For production, set at minimum:

| Variable | Description |
|----------|-------------|
| `SECRET_KEY` | Django secret key — use a long random string |
| `DATABASE_URL` | `postgres://user:password@host:5432/dbname` |
| `REDIS_URL` | `redis://host:6379` |
| `DJANGO_SETTINGS_MODULE` | `trueppm_api.settings.prod` |
| `ALLOWED_HOSTS` | Comma-separated list of allowed hostnames |
