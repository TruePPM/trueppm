---
title: Installation
description: Run TruePPM locally with Docker Compose in a few minutes. For Helm/Kubernetes, single-server production with systemd, and image/chart signature verification, see Deployment.
---

:::caution[0.3 shipped (alpha) · pre-GA]
TruePPM 0.3 has shipped — the engine, API, real-time backend, web UI, and the 0.3 agile-team feature set are functional. It ships as the `0.3.0-alpha.1` pre-release; the release line stays alpha through 0.3, and 0.4 is planned as the first beta. 0.4 will not arrive as a beta directly — it will tag one or more `0.4.0-alpha.N` pre-releases first, and the beta milestone begins at `0.4.0-beta.1` ([how the 0.4 line is numbered](/overview/roadmap/#how-the-04-line-is-numbered)). The product is pre-GA: expect API contract changes across 0.x point releases; a stable contract arrives at 1.0. Install for evaluation and early-adopter deployments.
:::

:::tip[Already have a login?]
This page is about standing up a new instance. If your team already runs one,
you don't need Docker, Helm, or anything below — get your URL and credentials
from your project admin and go straight to
[For Team Members: already have a login?](/guides/team-members/#already-have-a-login).
:::

TruePPM ships as pre-built Docker images and a Python package on PyPI. Through 0.3 (alpha) the images live on the internal GitLab Container Registry; starting with the 0.4 beta they will also publish to the **GitHub Container Registry (GHCR)** as a public pull path — `ghcr.io/trueppm/{api,web}` for the images and `oci://ghcr.io/trueppm/charts` for the chart — with every published artifact Trivy-scanned, CycloneDX SBOM-attested, and Cosign-signed (keyless). See [Deployment](/administration/deployment/#verifying-image-and-chart-signatures) for how to verify a signed artifact once 0.4 ships.

Docker Compose is the fastest path to a running instance — every service starts from one command, and it is the right path for evaluation, development, and contributors. Pick a different path if you're deploying for production:

| Path | Best for |
|------|----------|
| Docker Compose (below) | Evaluation, development, contributors |
| [Helm / Kubernetes](/administration/deployment/#kubernetes-with-helm) | Production, horizontal scaling |
| [Single server with systemd](/administration/deployment/#single-server-with-systemd) | Production without Kubernetes |
| [Scheduler library](#scheduler-library-only) | Embedding the CPM engine in your own app |

Before you put a real program on it, read the **[tested scale envelope](/administration/sizing/#tested-envelope)** — the scale ceilings measured against the 0.4 beta build, which dimensions are still untested, and the issue behind each ceiling. The short version: plan on the Schedule view staying comfortable up to roughly **1,000 tasks**.

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

For a production deployment — Kubernetes with Helm, a single server with systemd, or verifying image/chart signatures — see [Deployment](/administration/deployment/).

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

The single-server path (systemd) adds a couple more — see
[Single server with systemd](/administration/deployment/#single-server-with-systemd).
For all configuration options, see [Configuration](/administration/configuration/).
