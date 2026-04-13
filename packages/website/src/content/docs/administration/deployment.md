---
title: Deployment
description: Deploy TruePPM with Docker Compose or Kubernetes Helm chart.
---

:::caution[Pre-Alpha]
TruePPM is not yet suitable for production deployment. These options are for evaluation and development.
:::

## Docker Compose (recommended for evaluation)

The fastest way to get TruePPM running. A single command starts all five services.

```bash
git clone git@gitlab.com:trueppm/trueppm.git
cd trueppm
docker compose up -d
```

| Service | Port | Purpose |
|---------|------|---------|
| `db` | 5432 | PostgreSQL 16 |
| `redis` | 6379 | Celery broker + Django Channels layer |
| `api` | 8000 | Django ASGI (uvicorn) |
| `celery` | — | CPM auto-scheduling worker |
| `web` | 5173 | React frontend (nginx) |

After startup:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```

**Good for:** local development, evaluation, small teams, demos.

## Kubernetes with Helm

The Helm chart in `packages/helm/` deploys TruePPM on Kubernetes with Bitnami sub-charts for PostgreSQL and Redis.

```bash
helm lint packages/helm
helm install trueppm packages/helm -f packages/helm/values-dev.yaml
```

Separate `values-dev.yaml` and `values-prod.yaml` overlays are provided.

**Good for:** production deployment, horizontal scaling, enterprise environments.

:::note
The Helm chart is in draft status — it is functional but not yet hardened for production use.
:::

## Services

TruePPM runs as a set of cooperating services:

| Service | Technology | Purpose |
|---------|-----------|---------|
| **API** | Django 5.1 (ASGI via uvicorn) | REST API, WebSocket connections, authentication |
| **Celery worker** | Celery 5.4 | Background CPM scheduling, async task processing |
| **PostgreSQL** | PostgreSQL 16 | Primary data store, ltree WBS hierarchy |
| **Redis** | Redis 7 | Celery task broker, Django Channels layer, scheduling locks |
| **Web** | React 19 (Vite build, served via nginx) | Browser-based user interface |

All services share the same Redis instance. Celery-originated broadcasts (e.g., `schedule_updated`) reach WebSocket clients connected to any API container, making horizontal scaling of the API safe.

## Backups

PostgreSQL is the only stateful service. Back up the `trueppm` database on your preferred schedule.

Redis is a broker and cache — it does not store persistent data. Losing Redis state means in-flight Celery tasks are lost (they'll be re-triggered by the next write) and WebSocket connections will drop and reconnect.

## Monitoring

### Auto-scheduling health

The Celery worker runs CPM recalculation automatically after every task or dependency write. It uses a per-project Redis lock to prevent redundant concurrent recalculations. If the lock is held, the task re-queues with a 10-second countdown.

Monitor the Celery worker logs for scheduling errors. If Redis becomes unavailable, scheduling updates will queue and retry when the connection is restored.

### WebSocket connections

WebSocket connections authenticate via JWT (`?token=<jwt>` on the connection URL). Viewers (role=0) are rejected with close code 4003. Monitor the Django Channels logs for connection errors.
