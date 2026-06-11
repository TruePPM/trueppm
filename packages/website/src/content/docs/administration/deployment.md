---
title: Deployment
description: Deploy TruePPM with Docker Compose or Kubernetes Helm chart.
---

:::caution[Pre-GA]
TruePPM 0.2 has shipped (as the `0.2.0-alpha.1` pre-release) and is suitable for evaluation and early-adopter deployments; the release line stays alpha through 0.3, and 0.4 is planned as the first beta. Expect API contract changes across 0.x point releases; a stable contract arrives at 1.0.
:::

## Docker Compose (recommended for evaluation)

The fastest way to get TruePPM running. A single command starts all six services.

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
| `celery-beat` | — | Periodic task runner (Beat) |
| `web` | 5173 | React frontend (Vite dev server) |

Migrations and the `create_admin` bootstrap run automatically when the `api` container starts. Retrieve the generated admin password as described in [Admin password setup](/administration/admin-password/):

```bash
docker compose exec api cat /tmp/trueppm_admin_password
```

**Good for:** local development, evaluation, small teams, demos.

## Kubernetes with Helm

The Helm chart in `packages/helm/` deploys TruePPM on Kubernetes with bundled
sub-charts for PostgreSQL and Valkey (the BSD-licensed Linux Foundation fork of
Redis; wire-compatible). The bundled datastores are intended for dev / demo / CI;
for production, disable them and point at managed services (see below).

```bash
helm lint packages/helm
helm install trueppm packages/helm -f packages/helm/values-dev.yaml
```

Separate `values-dev.yaml` and `values-prod.yaml` overlays are provided. The
chart [README](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/helm/README.md)
is the full value reference.

**Good for:** production deployment, horizontal scaling, enterprise environments.

### Secure by default

A default install needs no extra security flags. The chart:

- **Generates** the PostgreSQL and Valkey passwords on first install and stores
  them in a chart-owned **connection Secret** (`<release>-trueppm-connection`,
  annotated `helm.sh/resource-policy: keep`). Re-renders read the existing
  password back rather than churning it, and the Secret survives `helm uninstall`
  so a reinstall does not orphan the database PVC.
- **Injects** `DATABASE_URL` / `REDIS_URL` via `secretKeyRef` — they are never
  rendered into a Deployment manifest in plaintext.
- Enables **cache authentication** by default (`valkey.auth.enabled: true`).
- Runs API and worker pods with a **restricted security context**
  (`readOnlyRootFilesystem`, dropped capabilities, `RuntimeDefault` seccomp,
  `runAsNonRoot`) and `automountServiceAccountToken: false`, with default
  resource requests/limits.
- Offers an **opt-in NetworkPolicy** (`networkPolicy.enabled: true`) that limits
  datastore ingress to the API and worker pods (requires a NetworkPolicy-enforcing
  CNI).

Retrieve the generated database password:

```bash
kubectl get secret <release>-trueppm-connection \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

See [Security](/administration/security/#helm-secure-by-default) for the full
operator reference.

### Managed (external) datastores

For production, disable the bundled subcharts and point at managed services.
When `postgresql.enabled` / `valkey.enabled` are `false`, `env.DATABASE_URL` and
`env.REDIS_URL` become **required** — the chart fails the render with a clear
message if either is missing. Managed Redis services (AWS ElastiCache, GCP
Memorystore, Azure Cache, etc.) work via the `redis://` scheme.

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set env.DATABASE_URL="postgres://user:pass@your-db:5432/trueppm" \
  --set env.REDIS_URL="redis://:pass@your-cache:6379"
```

Prefer injecting `DATABASE_URL` / `REDIS_URL` via an external Secret rather than
`--set` so they don't land in shell history. `SECRET_KEY` and `ALLOWED_HOSTS`
must always be supplied via a Kubernetes Secret referenced through `env`.

:::note
The Helm chart is functional with dev and prod values overlays and was hardened
for secure-by-default installs; further updates landed in 0.2 (available since the `0.2.0-alpha.1` pre-release).
Large-scale production hardening (HA Postgres, dedicated Valkey, autoscaling
policies) is on the pre-1.0 roadmap.
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

All services share the same Valkey instance. Celery-originated broadcasts (e.g., `cpm_complete`) reach WebSocket clients connected to any API container, making horizontal scaling of the API safe.

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
