---
title: Installation
description: Four ways to run TruePPM — Docker Compose, Helm/Kubernetes, single-server, or the scheduler library standalone.
---

:::caution[0.1 shipped · pre-GA]
TruePPM 0.1 has shipped — the engine, API, real-time backend, and web UI are functional. The product is pre-GA: expect API contract changes across 0.x point releases. Install for evaluation and early-adopter deployments; a stable contract arrives at 1.0.
:::

TruePPM ships as pre-built Docker images on GHCR and a Python package on PyPI. Pick the path that fits your environment:

| Path | Best for |
|------|----------|
| [Docker Compose](#docker-compose) | Evaluation, development, contributors |
| [Helm / Kubernetes](#helm--kubernetes) | Production, horizontal scaling |
| [Single server](#single-server-with-docker-compose) | Production without Kubernetes |
| [Scheduler library](#scheduler-library-only) | Embedding the CPM engine in your own app |

---

## Docker Compose

The fastest way to run TruePPM locally. All five services start from a single command.

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

### Seed a demo project (optional)

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

Creates a "Platform Migration" project with eight closed sprints, an active sprint, baselines, resources, a retro, and six persona logins (all password `demo`). See [Quickstart](/getting-started/quickstart/) for a per-persona walkthrough.

### Verify

```bash
curl http://localhost:8000/api/v1/projects/
# → {"count":0,"results":[]}
```

The OpenAPI schema is at `http://localhost:8000/api/schema/swagger-ui/`.

---

## Helm / Kubernetes

Use the published Helm chart to deploy TruePPM on any Kubernetes cluster (kind, k3s, EKS, GKE, AKS, or bare-metal).

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Helm | 3.14+ |
| kubectl | any compatible with your cluster |
| A running Kubernetes cluster | 1.27+ |

### Add the chart repository

The chart is published to the GHCR OCI registry:

```bash
helm registry login ghcr.io --username <github-username> --password <PAT-with-read:packages>
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
ingress:
  enabled: true
  host: trueppm.example.com
  tls:
    enabled: true
    secretName: trueppm-tls

env:
  SECRET_KEY: "<50+ character random string>"
  ALLOWED_HOSTS: "trueppm.example.com"

# If using external PostgreSQL and Valkey (recommended for production):
postgresql:
  enabled: false
valkey:
  enabled: false
externalDatabase:
  url: "postgres://trueppm:<password>@<host>:5432/trueppm"
externalValkey:
  url: "redis://:<password>@<host>:6379"
```

### Install

```bash
helm install trueppm oci://ghcr.io/trueppm/charts/trueppm \
  --version 0.1.0 \
  --namespace trueppm \
  --create-namespace \
  -f my-values.yaml
```

### Post-install

Migrations run automatically in an init container. Retrieve the generated admin password from the pod:

```bash
kubectl exec -n trueppm deployment/trueppm-api -- \
  cat /run/trueppm/admin_password
```

### Verify

```bash
kubectl get pods -n trueppm
# All pods should be Running / Completed
```

---

## Single-server with Docker Compose

For production on a single Linux server without Kubernetes. Uses the published GHCR images, managed by systemd.

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
APP_VERSION=0.1.0
```

Run the one-time setup (obtains a TLS certificate and starts the stack):

```bash
chmod +x init-prod.sh
./init-prod.sh
```

Retrieve the admin password:

```bash
docker compose -f docker-compose.prod.yml exec api-init \
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
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency

calendar = Calendar(id="cal-1", name="Standard")
project = Project(id="p-1", name="My Project", start_date="2026-01-01", calendar=calendar)
task_a = Task(id="t-1", name="Design", duration=5, project_id="p-1")
task_b = Task(id="t-2", name="Build", duration=10, project_id="p-1")
dep = Dependency(id="d-1", predecessor_id="t-1", successor_id="t-2", dep_type="FS")

result = schedule(project, [task_a, task_b], [dep], calendar)
print(result.tasks["t-2"].early_finish)  # 2026-01-20
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
