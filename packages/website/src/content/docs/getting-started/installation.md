---
title: Installation
description: Four ways to run TruePPM — Docker Compose, Helm/Kubernetes, single-server, or the scheduler library standalone.
---

:::caution[0.3 shipped (alpha) · pre-GA]
TruePPM 0.3 has shipped — the engine, API, real-time backend, web UI, and the 0.3 agile-team feature set are functional. It ships as the `0.3.0-alpha.1` pre-release; the release line stays alpha through 0.3, and 0.4 is planned as the first beta. The product is pre-GA: expect API contract changes across 0.x point releases; a stable contract arrives at 1.0. Install for evaluation and early-adopter deployments.
:::

TruePPM ships as pre-built Docker images on the GitLab Container Registry (`registry.gitlab.com/trueppm/trueppm/{api,web}`) and a Python package on PyPI. GHCR mirrors are planned as part of the 0.4 supply-chain work. Pick the path that fits your environment:

| Path | Best for |
|------|----------|
| [Docker Compose](#docker-compose) | Evaluation, development, contributors |
| [Helm / Kubernetes](#helm--kubernetes) | Production, horizontal scaling |
| [Single server](#single-server-with-docker-compose) | Production without Kubernetes |
| [Scheduler library](#scheduler-library-only) | Embedding the CPM engine in your own app |

---

## Docker Compose

The fastest way to run TruePPM locally. All six services start from a single command.

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Docker + Docker Compose | 24+ |
| Git | any recent |

### Steps

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
docker compose up -d
```

Wait for all services to be healthy (usually 15–20 seconds), then open the web UI at **http://localhost:5173**.

**Services started:**

| Service | Port | Purpose |
|---------|------|---------|
| `db` | 5432 | PostgreSQL 16 |
| `valkey` | 6379 | Celery broker + Django Channels layer (BSD-licensed Redis fork; wire-compatible) |
| `api` | 8000 | Django ASGI (uvicorn) |
| `celery` | — | CPM auto-scheduling worker |
| `celery-beat` | — | Periodic task runner |
| `web` | 5173 | React frontend |

Migrations run automatically on first startup. The `create_admin` management command generates a secure random password and writes it to `/tmp/trueppm_admin_password`:

```bash
docker compose exec api cat /tmp/trueppm_admin_password
docker compose exec api rm  /tmp/trueppm_admin_password   # delete after retrieval
```

### Load demo data (optional)

The quickest way to see TruePPM with realistic data is the in-app **Load demo data**
button on the **Programs** page. It imports the **Atlas Platform Launch** sample — a
hybrid program with a live sprint-to-milestone bridge, anchor-relative dates, and
replayed history, so the demo always reads as current rather than aging into a
fixed-date snapshot. If more than one sample is bundled, the button opens a picker.

:::note[Added in 0.3]
The in-app sample picker was added in 0.3, available since the `0.3.0-alpha.1`
pre-release. See the [sample projects guide](/getting-started/sample-projects/) and the
[roadmap](/overview/roadmap/).
:::

Prefer the command line, or want the six persona logins used in the
[per-persona walkthrough](/getting-started/quickstart/)? Seed the "Platform Migration"
demo instead:

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

Creates a "Platform Migration" project with eight closed sprints, an active sprint, baselines, resources, a retro, and six persona logins. The persona password is `demo` only when the API runs with `DEBUG=True`; on a production install (`DEBUG=False`) the command prints a one-time random password at the end of its output unless you set `TRUEPPM_DEMO_PASSWORD` — see [`seed_demo_project`](/administration/management-commands/#seed_demo_project). The bundled samples can also be loaded from the CLI with `load_sample_project --sample atlas-platform-launch` (see [management commands](/administration/management-commands/)).

### Verify

```bash
curl http://localhost:8000/api/v1/health/
# → {"status": "ok"}
```

The OpenAPI schema is at `http://localhost:8000/api/schema/swagger-ui/`.

---

## Helm / Kubernetes

Use the Helm chart to deploy TruePPM on any Kubernetes cluster (kind, k3s, EKS, GKE, AKS, or bare-metal).

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Helm | 3.14+ |
| kubectl | any compatible with your cluster |
| A running Kubernetes cluster | 1.27+ |

### Get the chart

Public OCI publication of the chart (GHCR) is planned; today the release pipeline pushes to GHCR only when optional GHCR credentials are configured. Until the public registry is live, install from the chart source in the repository:

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
helm dependency update packages/helm
```

### Prepare your values file

Download the production values template and fill in your settings:

```bash
curl -sL https://gitlab.com/trueppm/trueppm/-/raw/main/packages/helm/values-prod.yaml \
  -o my-values.yaml
```

At minimum, set:

```yaml
# my-values.yaml
env:
  SECRET_KEY: "<50+ character random string>"
  ALLOWED_HOSTS: "trueppm.example.com"

# Recommended for production: disable the bundled datastores and point at managed
# services. When they are disabled, env.DATABASE_URL and env.REDIS_URL are
# REQUIRED — the chart fails the render with a clear message if either is missing.
postgresql:
  enabled: false
valkey:
  enabled: false
# env:
#   DATABASE_URL: "postgres://trueppm:<password>@<host>:5432/trueppm"
#   REDIS_URL: "redis://:<password>@<host>:6379"
```

:::tip[Secure by default]
With the bundled datastores **enabled** (dev / demo), leave
`postgresql.auth.password` and `valkey.auth.password` empty — the chart generates
strong random passwords on first install and stores them in a chart-owned
connection Secret. You never set a database password by hand, and `DATABASE_URL`
/ `REDIS_URL` are injected via `secretKeyRef` (never rendered in plaintext). See
[Deployment](/administration/deployment/#secure-by-default).
:::

### Install

```bash
helm install trueppm packages/helm \
  --namespace trueppm \
  --create-namespace \
  -f my-values.yaml
```

Once the chart is published to a public OCI registry, the same install will work
with `helm install trueppm oci://ghcr.io/trueppm/charts/trueppm --version <version>`.

For real secrets, prefer injecting `SECRET_KEY` / `DATABASE_URL` / `REDIS_URL`
via an external Kubernetes Secret over putting them in `my-values.yaml` or
`--set`.

:::note[Bring your own Ingress]
The chart does not ship an Ingress template — it exposes the API as a ClusterIP
Service. Put your own Ingress controller or LoadBalancer in front of the
`<release>-api` Service to terminate TLS and route external traffic.
:::

### Post-install

Migrations run automatically in an init container. Retrieve the generated admin password from the pod:

```bash
kubectl exec -n trueppm deployment/trueppm-api -- \
  cat /run/trueppm/admin_password
```

When using the bundled PostgreSQL, retrieve the generated database password from
the chart-owned connection Secret:

```bash
kubectl get secret trueppm-trueppm-connection -n trueppm \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

### Verify

```bash
kubectl get pods -n trueppm
# All pods should be Running / Completed
```

---

## Single-server with Docker Compose

For production on a single Linux server without Kubernetes. Uses the pre-built release images, managed by systemd.

### Prerequisites

- A Linux server (Ubuntu 22.04+ or Debian 12+)
- Docker 24+ and Docker Compose plugin
- A domain name pointing to the server's public IP
- Ports 80 and 443 open

### Steps

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
cp .env.example .env
```

Edit `.env` and fill in all required values:

```bash
# Required minimums — see .env.example for full list
DOMAIN=trueppm.example.com
TLS_MODE=letsencrypt
CERTBOT_EMAIL=ops@example.com
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
DB_PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")
REDIS_PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")
APP_VERSION=0.2.0
```

Run the one-time setup (obtains a TLS certificate and starts the stack):

```bash
chmod +x init-prod.sh
./init-prod.sh
```

Retrieve the admin password:

```bash
docker compose -f docker-compose.prod.yml exec api \
  cat /run/trueppm/admin_password
```

### systemd auto-start

Create `/etc/systemd/system/trueppm.service`:

```ini
[Unit]
Description=TruePPM
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/trueppm
EnvironmentFile=/opt/trueppm/.env
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now trueppm
```

---

## Scheduler library only

If you only need the CPM scheduling engine in your own Python application:

```bash
pip install trueppm-scheduler
```

```python
from datetime import date, timedelta
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency, DependencyType

calendar = Calendar()  # Mon–Fri working days
project = Project(
    id="p-1", name="My Project", start_date=date(2026, 1, 5),
    tasks=[
        Task(id="t-1", name="Design", duration=timedelta(days=5)),
        Task(id="t-2", name="Build",  duration=timedelta(days=10)),
    ],
    dependencies=[
        Dependency(predecessor_id="t-1", successor_id="t-2", dep_type=DependencyType.FS),
    ],
    calendar=calendar,
)
result = schedule(project)
print(result.tasks[1].early_finish)   # 2026-01-23
```

See the [Scheduler integration guide](/integration/standalone/) for full API reference.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SECRET_KEY` | Yes | Django secret key — 50+ character random string |
| `DATABASE_URL` | Yes | `postgres://user:password@host:5432/dbname` |
| `REDIS_URL` | Yes | `redis://:password@host:6379` (Valkey accepts the `redis://` scheme) |
| `DJANGO_SETTINGS_MODULE` | Yes (prod) | `trueppm_api.settings.prod` |
| `ALLOWED_HOSTS` | Yes | Comma-separated list of allowed hostnames |
| `DOMAIN` | Single-server | Public hostname, used by nginx and certbot |
| `TLS_MODE` | Single-server | `letsencrypt` \| `selfsigned` \| `none` |

For all configuration options, see [Configuration](/administration/configuration/).
