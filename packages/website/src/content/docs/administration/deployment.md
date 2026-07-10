---
title: Deployment
description: Deploy TruePPM with Docker Compose or Kubernetes Helm chart.
---

:::caution[Pre-GA]
TruePPM 0.3 has shipped (as the `0.3.0-alpha.1` pre-release) and is suitable for evaluation and early-adopter deployments; the release line stays alpha through 0.3, and 0.4 is planned as the first beta. Expect API contract changes across 0.x point releases; a stable contract arrives at 1.0.
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

### Public read-only demo (`docker-compose.demo.yml`)

`docker-compose.demo.yml` is a **separate, hardened** stack for a public hosted
demo (the mechanism behind `try.trueppm.dev`, which goes live at the 0.4 tag) —
not the dev stack above. It seeds the sample **without** persona logins, so the
instance has **zero user accounts and no authenticated write path**; the only way
in is the product's own anonymous, tokenized, read-only
[schedule share link](/administration/sharing-and-access/).

That no-accounts invariant is what makes the stack's baked demo `SECRET_KEY` safe,
so the demo's reverse proxy (`nginx/demo.conf.template`) treats the API surface as
an **explicit allowlist**, not a blanket proxy. Only these routes reach the API
container from the public internet:

| Public route | Why it is open |
|---|---|
| `GET /api/v1/share/{schedule,board}/<token>/` | The anonymous, read-only, throttled share-link projections — the demo's only data plane. |
| `GET /api/v1/health/` | Liveness probe for an upstream load balancer / ingress. |
| `/static/` | Django-collected static assets (admin CSS, etc.). |
| `/admin/` | Django admin — additionally restricted to loopback; reach it via an SSH tunnel. |

Every **other** `/api/` route — `auth/token` and the rest of the auth surface,
every project viewset, the Admin-only share-link *management* endpoints, workspace
SSO, and the OpenAPI schema/docs — returns **404**, as does the live-collaboration
WebSocket (`/ws/`), which the read-only share pages never open. The authenticated
API is simply *not there* from the public internet.

This posture is a deliberate decision, not an accident of configuration: a CI gate
(`scripts/check-demo-nginx-allowlist.sh`) fails the pipeline if the demo template
ever regresses to proxying anything beyond this allowlist. Production
(`nginx/app-http.conf.template`) intentionally proxies **all** of `/api/` — correct
there, because production is authenticated and has real accounts.

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

For preliminary hardware sizing guidance at 50 / 100 / 200 users, see [Deployment Sizing](/administration/sizing/).

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
- Enables a **default-on NetworkPolicy** (`networkPolicy.enabled: true`) that
  limits datastore ingress to the API and worker pods and applies default-deny
  egress to the bundled datastore pods. This **requires a NetworkPolicy-enforcing
  CNI** (Calico, Cilium, Antrea, Weave, …); on a cluster whose CNI does not enforce
  policy the objects are accepted but silently unenforced.

Retrieve the generated database password:

```bash
kubectl get secret <release>-trueppm-connection \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

See [Security](/administration/security/#helm-secure-by-default) for the full
operator reference.

### Ingress and edge TLS

The chart ships a chart-managed `Ingress` template, **off by default** because the
correct ingress class, hostnames, and certificate source are cluster-specific.
Enable it and supply your host(s) and a TLS Secret to expose the API over HTTPS at
the edge. The API `Service` stays `ClusterIP`; the `Ingress` is the sole
externally-facing object and the TLS termination point.

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=trueppm.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.tls[0].secretName=trueppm-tls \
  --set ingress.tls[0].hosts[0]=trueppm.example.com
```

With cert-manager, add the issuer under `ingress.annotations`
(`cert-manager.io/cluster-issuer: <issuer>`) and cert-manager provisions the
named TLS Secret automatically. Leaving `ingress.tls` empty renders an HTTP-only
Ingress — acceptable only for a dev/demo cluster, never production. `settings.prod`
already trusts `X-Forwarded-Proto` (`SECURE_PROXY_SSL_HEADER`), so the app sets
secure cookies and HSTS correctly behind edge TLS; the `/api/v1/health/` and
`/api/v1/edition/` probe paths stay exempt from the optional HTTP→HTTPS redirect.

### Bundled datastores are dev/demo only

The bundled PostgreSQL and Valkey pods speak **plaintext** on the pod network — the
chart-built `DATABASE_URL` carries no `sslmode`. This is safe **only** because the
default-on NetworkPolicy isolates those pods so that just the API and worker can
reach them. To keep that posture coherent, the chart automatically sets
`TRUEPPM_ALLOW_UNENCRYPTED_DB=true` **only** when the bundled database is in use
**and** the NetworkPolicy is enabled — so a default `helm install` boots without
crash-looping the app's DB-encryption guard, and without any operator ever being
told to "disable the security check."

For production, use managed datastores with TLS instead (below). When
`postgresql.enabled=false`, the chart injects **no** auto flag, so your
`env.DATABASE_URL` **must** include `sslmode=require` — the app refuses to boot on
a plaintext external database.

### Managed (external) datastores

For production, disable the bundled subcharts and point at managed services.
When `postgresql.enabled` / `valkey.enabled` are `false`, `env.DATABASE_URL` and
`env.REDIS_URL` become **required** — the chart fails the render with a clear
message if either is missing. Managed Redis services (AWS ElastiCache, GCP
Memorystore, Azure Cache, etc.) work via the `redis://` scheme.

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set env.DATABASE_URL="postgres://user:pass@your-db:5432/trueppm?sslmode=require" \
  --set env.REDIS_URL="redis://:pass@your-cache:6379"
```

The `sslmode=require` parameter is **mandatory** on an external `DATABASE_URL`:
`settings.prod` refuses to boot without it (database connections would otherwise
fall back to whatever the server negotiates, which may be plaintext). If — and only
if — TLS is already enforced between the app and database at the network layer
(a service-mesh sidecar or a private encrypted link), set
`env.TRUEPPM_ALLOW_UNENCRYPTED_DB=true` to acknowledge that and downgrade the guard
to a warning.

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

TruePPM ships tested backup and restore scripts (`scripts/backup.sh` / `scripts/restore.sh`) and an opt-in Helm backup CronJob. See [Backup & Restore](/administration/backup-restore/) for the full runbook: manual backups on Compose and Helm, restoring onto a fresh stack, what is and isn't captured, and the restore-drill cadence.

## Database migrations & rollback

Schema migrations run automatically on container start (`manage.py migrate`). The
migration graph is linear and every schema change is reversible **except two
intentional one-way data migrations** — reverting past them is a no-op, not a
restore:

- `notifications.0004_clean_unknown_matrix_keys` — strips invalid keys from
  notification-preference matrices. The dropped keys carried no meaning, so there
  is nothing to restore on reverse.
- `projects.0019_backfill_wbs_paths` — backfills WBS `ltree` paths. The
  pre-backfill state was empty paths; reverse accepts that data loss.

To roll back across either of these, restore the PostgreSQL backup taken before
the upgrade rather than relying on `migrate <app> <prior>`. All other migrations
reverse cleanly.

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

WebSocket connections authenticate with a short-lived, single-use ticket (`?ticket=<ticket>` on the connection URL), minted via `POST /api/v1/ws/ticket/` — no JWT ever appears in the URL or access logs. The legacy `?token=<jwt>` handshake is disabled by default and opt-in only via `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` (deprecated, removed next release). Viewers (role=0) are rejected with close code 4003. Monitor the Django Channels logs for connection errors.
