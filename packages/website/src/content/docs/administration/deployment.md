---
title: Deployment
description: Deploy TruePPM with Docker Compose or Kubernetes Helm chart.
---

:::caution[Pre-GA]
TruePPM 0.1 has shipped and is suitable for evaluation and early-adopter deployments; 0.2 is in alpha (target Jun 8, 2026). Expect API contract changes across 0.x point releases; a stable contract arrives at 1.0.
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
The Helm chart shipped in 0.1 with dev and prod values overlays and is updated in 0.2. It is functional and used internally; large-scale production hardening (HA Postgres, dedicated Valkey, autoscaling policies) is on the pre-1.0 roadmap.
:::

## Services

TruePPM runs as a set of cooperating services:

| Service | Technology | Purpose |
|---------|-----------|---------|
| **API** | Django 5.2 (ASGI via uvicorn) | REST API, WebSocket connections, authentication |
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

### Celery Beat liveness

In a single-pod deployment there is exactly one Celery Beat process driving every
periodic drain. If it dies silently, async work stops accumulating signal. TruePPM
exposes a heartbeat endpoint (`GET /api/v1/health/beat/`) so monitoring can detect a
dead Beat. See [Beat Liveness & Durability](/administration/durability/) for how to wire
it into Prometheus or Kubernetes.

### Outbox & record retention

The outbox and audit tables (schedule requests, imports, webhook deliveries, object
history, task runs) are bounded by nightly purges. See
[Outbox & Record Retention](/administration/retention/) for the tunable retention
windows and how to disable a purge safely.

### WebSocket connections

WebSocket connections authenticate via JWT (`?token=<jwt>` on the connection URL). Viewers (role=0) are rejected with close code 4003. Monitor the Django Channels logs for connection errors.
