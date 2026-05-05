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
| `valkey` | 6379 | Celery broker + Django Channels layer ([Valkey](https://valkey.io) — BSD-licensed Redis fork, wire-compatible) |
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

The Helm chart in `packages/helm/` deploys TruePPM on Kubernetes with Bitnami sub-charts for PostgreSQL and Valkey (the BSD-licensed Linux Foundation fork of Redis; wire-compatible). Existing managed Redis services (AWS ElastiCache, GCP Memorystore, Azure Cache, etc.) work as drop-in alternatives — just point `REDIS_URL` at them.

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
| **Valkey** | Valkey 8 (Redis-compatible) | Celery task broker, Django Channels layer, scheduling locks |
| **Web** | React 19 (Vite build, served via nginx) | Browser-based user interface |

All services share the same Valkey instance. Celery-originated broadcasts (e.g., `schedule_updated`) reach WebSocket clients connected to any API container, making horizontal scaling of the API safe.

## Backups

PostgreSQL is the only stateful service. Back up the `trueppm` database on your preferred schedule.

Valkey is a broker and cache — it does not store persistent data. Losing Valkey state means in-flight Celery tasks are lost (they'll be re-triggered by the next write) and WebSocket connections will drop and reconnect.

## Monitoring

### Auto-scheduling health

The Celery worker runs CPM recalculation automatically after every task or dependency write. It uses a per-project Valkey lock to prevent redundant concurrent recalculations. If the lock is held, the task re-queues with a 10-second countdown.

Monitor the Celery worker logs for scheduling errors. If Valkey becomes unavailable, scheduling updates will queue and retry when the connection is restored.

### WebSocket connections

WebSocket connections authenticate via JWT (`?token=<jwt>` on the connection URL). Viewers (role=0) are rejected with close code 4003. Monitor the Django Channels logs for connection errors.
