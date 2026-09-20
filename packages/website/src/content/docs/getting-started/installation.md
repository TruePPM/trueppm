---
title: Installation
description: Run TruePPM locally with Docker Compose in a few minutes. For Helm/Kubernetes, single-server production with systemd, and image/chart signature verification, see Deployment.
documentedFor: "0.4"
---

This page gets you from nothing installed to a running TruePPM instance you can open in a browser, using Docker Compose. If you have never run Docker before, see [Set up a container host](/getting-started/container-host/) first — it explains what a container is and gets one running on your machine.

:::caution[0.4 shipped (beta) · pre-GA]
TruePPM 0.4 has shipped — the engine, API, real-time backend, web UI, and the first beta's feature set (read-only MCP server, basic single sign-on, time capture, in-app baselines) are functional. 0.4 is published as the `v0.4.0-beta.N` pre-release line — the newest tag is on the [Releases page](https://gitlab.com/trueppm/trueppm/-/releases); 0.4 is the first beta — the release line leaves alpha here and hardens under further `beta.N` tags before an eventual `0.4.0` stable ([how the 0.4 line is numbered](/overview/roadmap/#how-the-04-line-is-numbered)). The product is pre-GA: expect API contract changes across 0.x point releases; a stable contract arrives at 1.0. Install for evaluation and early-adopter deployments.
:::

:::tip[Already have a login?]
This page is about standing up a new instance. If your team already runs one,
you don't need Docker, Helm, or anything below — get your URL and credentials
from your project admin and go straight to
[For Team Members: already have a login?](/guides/team-members/#already-have-a-login).
:::

TruePPM ships as pre-built Docker images and a Python package on PyPI. Release images publish to the GitLab Container Registry and, since the 0.4 beta, also to the **GitHub Container Registry (GHCR)** as a public pull path — `ghcr.io/trueppm/{api,web}` for the images and `oci://ghcr.io/trueppm/charts` for the chart — with every published artifact Trivy-scanned, CycloneDX SBOM-attested, and Cosign-signed (keyless). See [Deployment](/administration/deployment/#verifying-image-and-chart-signatures) for how to verify a signed artifact.

:::note[The development Compose stack builds from source — it does not pull those images]
The `docker compose up -d` path below is the *development* stack. It builds the
API and web images from your checkout and runs `npm install` in the web
container, so the **first** start is a multi-minute build, not a pull. That is on
purpose: it is the path contributors and evaluators use against `main`.

`docker-compose.prod.yml` is the one that pulls pre-built
`ghcr.io/trueppm/{api,web}` images, at the tag named by `APP_VERSION`. GHCR tags
are the **bare version** — `0.4.0-beta.3`, no `v` — so set `APP_VERSION` to that
form and pin it for anything you intend to keep. The GitLab Container Registry
(`registry.gitlab.com/trueppm/trueppm/{api,web}`, which the Helm chart defaults
to) uses the **`v`-prefixed** form, `v0.4.0-beta.3`; the two are not
interchangeable. To avoid pulling at all, build locally with the development
stack below.

**Both paths need outbound network access** to Docker Hub (`python:3.11-slim`,
`node:22-alpine`, `nginxinc/nginx-unprivileged`, `postgres:16-alpine`,
`valkey/valkey:8-alpine`), PyPI, and the npm registry. On an air-gapped or
egress-filtered host, mirror those into an internal registry first and point the
compose files or `image.repository` / `image.webRepository` at it.
:::

:::caution[The published `api` and `web` images are `linux/amd64` only]
Every published `api` and `web` image — on GHCR and on the GitLab Container
Registry, every tag — is built for **`linux/amd64` only**. There is no
`linux/arm64` variant yet; multi-arch images are planned for 0.5 (#3407). This
affects any host or node that pulls them: Apple Silicon Macs, AWS Graviton and
other ARM cloud instances, and Raspberry Pi.

On an ARM machine the failure is easy to misread. Docker prints a platform
mismatch warning, or the container exits at start with `exec format error`; on
Kubernetes the pod goes into `CrashLoopBackOff` and the pod events do not name
the architecture.

- **Development Compose stack (`docker compose up -d`):** not affected. It builds
  the images from your checkout for your machine's own architecture.
- **`docker-compose.prod.yml` on Apple Silicon:** run the amd64 images under
  emulation. Set `platform: linux/amd64` on the services that use a
  TruePPM image (`api-init`, `api`, `celery`, `celery-beat`, and `web-build`), or
  pass `--platform linux/amd64` to `docker run` / `docker pull`. Docker Desktop emulates amd64 with QEMU, or with Rosetta if you
  enable **Settings → General → Use Rosetta for x86_64/amd64 emulation on Apple
  Silicon**. Emulation is noticeably slower than native — fine for an evaluation,
  not for a production or load-testing host.
- **Kubernetes:** emulation is not a practical option. Schedule the TruePPM pods
  onto `amd64` nodes with the chart's `nodeSelector` (`kubernetes.io/arch: amd64`),
  or wait for the multi-arch images.
:::

Docker Compose is the fastest path to a running instance — every service starts from one command, and it is the right path for evaluation, development, and contributors. Pick a different path if you're deploying for production:

| Path | Best for |
|------|----------|
| Docker Compose (below) | Evaluation, development, contributors |
| [Helm / Kubernetes](/administration/deployment/#kubernetes-with-helm) | Production, horizontal scaling |
| [Single server with systemd](/administration/deployment/#single-server-with-systemd) | Production without Kubernetes |
| [Scheduler library](#scheduler-library-only) | Embedding the CPM (Critical Path Method — the algorithm that computes task dates and the critical path) engine in your own app |

Before you put a real program on it, read **[Deployment Sizing](/administration/sizing/#at-a-glance)** — a one-screen summary of how large a project and team TruePPM handles, and a checklist to hand your IT team, with the measured envelope behind it. The short version: plan on the Schedule view staying comfortable up to roughly **2,000 tasks** per project (about **1,000** on 0.4.0-beta.1, which does not turn off PostgreSQL's JIT compiler — the sizing page explains how to), and on a program's total task count, not just one project's, for schedule recalculation.

---

## Docker Compose

The fastest way to run TruePPM locally. All six services start from a single command.

### Prerequisites

| Requirement | Minimum |
|------|----------------|
| Docker + Docker Compose | 24+ |
| Git | any recent |
| CPU available to Docker | 4 cores |
| Memory available to Docker | 8 GB |
| Free disk | ~10 GB for images, layers, and the build cache |
| CPU architecture | `amd64` for the published images; the development stack builds natively on any architecture (see the note above) |

New to containers, or don't have Docker installed yet? See
[Set up a container host](/getting-started/container-host/) first — it explains
what Docker and Docker Compose actually are and walks through installing Docker
Desktop, Rancher Desktop, or Podman.

The CPU and memory figures match the smallest tier in
[Sizing](/administration/sizing/#sizing-tiers) — a single node at ~4 vCPU / 8 GB.
On Docker Desktop these are set under **Settings → Resources**; the defaults are
often lower, and an under-resourced engine shows up as an OOM-killed `celery`
container rather than as an obvious error.

### Steps

1. **Download the code.** This creates a new `trueppm` folder in your current directory.

   ```bash
   git clone https://gitlab.com/trueppm/trueppm.git
   ```

2. **Move into that folder.**

   ```bash
   cd trueppm
   ```

3. **Build and start all six services with one command.**

   ```bash
   docker compose up -d
   ```

   **The first run builds.** This stack compiles the API and web images from your
   checkout and installs npm dependencies, so budget **several minutes** on a cold
   Docker cache — not seconds. Subsequent starts, with the images and
   `web_node_modules` volume already present, come up in about 15–20 seconds.

4. **Watch it finish rather than guessing.**

   ```bash
   docker compose logs -f web    # wait for Vite's "ready in ..." line
   docker compose ps             # db, valkey, api should read "(healthy)"
   ```

5. **Open the web UI** at **http://localhost:5173**. You should see TruePPM's sign-in page.

**Services started:**

| Service | Port | Purpose |
|---------|------|---------|
| `db` | 5432 | PostgreSQL 16 |
| `valkey` | 6379 | Celery broker + Django Channels layer (BSD-licensed Redis fork; wire-compatible) |
| `api` | 8000 | Django ASGI (uvicorn) |
| `celery` | — | Runs the CPM (Critical Path Method) schedule recalculation in the background |
| `celery-beat` | — | Periodic task runner |
| `web` | 5173 | React frontend |

**Migrations run automatically on first startup.** A migration is a script that creates or updates TruePPM's database tables to match the current version of the code — you never run one by hand on Compose; the `api` container does it for you before it starts serving requests. The `create_admin` management command generates a secure random password and writes it to `/tmp/trueppm_admin_password`:

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

Prefer the command line, or want the persona logins used in the
[per-persona walkthrough](/getting-started/quickstart/)? Load the bundled sample
from the CLI instead:

```bash
docker compose exec api python manage.py load_sample_project --with-personas
```

Loads the **Atlas Platform Launch** sample — a three-project hybrid program with closed sprints, an active sprint, baselines, resources, a retro, a risk register, and its persona logins. The persona password is `demo` only when the API runs with `DEBUG=True`; on a production install (`DEBUG=False`) the command prints a one-time random password at the end of its output unless you set `TRUEPPM_DEMO_PASSWORD` — see [`load_sample_project`](/administration/management-commands/#load_sample_project). Pass `--sample <key>` to load a different one (see [sample projects](/getting-started/sample-projects/)).

---

## Verify your install

TruePPM is six services, and five of them can be broken while the sixth makes the
site look fine. Check each one deliberately the first time you stand an instance
up, and again after any upgrade. If a check fails, take the symptom to
[Troubleshooting](/administration/troubleshooting/).

Set your base URL once:

```bash
BASE=http://localhost:8000          # Compose
# BASE=https://trueppm.example.com  # Helm / production
```

### 1. PostgreSQL — accepting connections

PostgreSQL is TruePPM's database. This checks that it is up and taking connections — not yet whether TruePPM can actually read or write data (check 3 covers that).

On Compose:

```bash
docker compose exec db pg_isready -U trueppm
```

Expect: `/var/run/postgresql:5432 - accepting connections`

On Helm / Kubernetes:

```bash
kubectl exec -n <ns> <release>-postgresql-0 -- pg_isready -U trueppm
```

Expect the same output.

Managed database instead? Skip the pod and trust check 3 — `/readyz` reports the
database as `ok` only after a real `SELECT 1` succeeds.

### 2. Valkey — answering PING

Valkey is TruePPM's in-memory cache and message broker — an open-source, Redis-compatible project that TruePPM uses in place of Redis itself. This check confirms it responds at all.

On Compose (dev):

```bash
docker compose exec valkey valkey-cli ping
```

On Compose (prod):

```bash
docker compose -f docker-compose.prod.yml exec valkey sh -c 'valkey-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'
```

On Helm / Kubernetes:

```bash
kubectl exec -n <ns> <release>-valkey-primary-0 -- sh -c 'valkey-cli -a "$VALKEY_PASSWORD" ping'
```

Expect `PONG` from any of the three. An unauthenticated `ping` against a
password-protected Valkey returns `NOAUTH`, not an error about the server
being down.

### 3. API — alive, and actually ready

Two endpoints, two different questions. Check both.

```bash
curl -s "$BASE/api/v1/health/"
# → {"status": "ok"}                      the Django process is running

curl -s "$BASE/api/v1/readyz"
# → {"status":"ok","checks":{"database":"ok","cache":"ok","migrations":"ok"},
#    "migration_state":"in_sync"}
```

`/api/v1/health/` checks **nothing** — it returns `200` while the process is up,
even if both datastores are unreachable. `/api/v1/readyz` (note: **no trailing
slash**) is the one that proves the install works: it runs a bounded `SELECT 1`, a
write-then-read round-trip against Valkey, and a migration-state comparison, and
returns `503` with the failing key named if any of them is wrong.

`/api/v1/readyz` shipped in 0.4. On `v0.3.0-alpha.3` only `/api/v1/health/` exists.

### 4. Celery worker — consuming the queue

Celery is the background worker that runs the schedule recalculation (CPM — Critical Path Method, the algorithm that computes task dates and the critical path) after every edit. This check confirms a worker is listening.

On Compose:

```bash
docker compose exec celery celery -A trueppm_api.celery inspect ping
```

On Helm / Kubernetes:

```bash
kubectl exec -n <ns> deploy/<release>-trueppm-celery-worker -c celery-worker -- celery -A trueppm_api.celery inspect ping
```

Expect `{'celery@<host>': {'ok': 'pong'}}` from either. An empty reply means no
worker is connected to the broker — the queue will grow and nothing will drain it.

### 5. Celery Beat — dispatching periodic work

Beat is a pinned singleton and its death is silent: the worker stays healthy and
idle while nothing is dispatched. It has its own endpoint, which needs a staff
token:

```bash
TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/token/" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<admin password>"}' | sed 's/.*"access":"\([^"]*\)".*/\1/')

curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/health/beat/"
# → 200   (503 means the heartbeat is stale — default threshold 120 s)
```

The same token opens the other two operator endpoints:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/health/dead-letter/"
# Prometheus text. Any nonzero gauge is work that failed permanently.

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/health/system/"
# The full operator view — the same data as Settings → Workspace → System health.
```

See [Beat Liveness](/administration/beat-liveness/) and [Dead-letter
Alerting](/administration/dead-letter-alerting/).

### 6. Web tier — serving the app

```bash
curl -sI "$BASE/" | head -3
# → HTTP/1.1 200 OK and content-type: text/html
```

On Compose the SPA is at **http://localhost:5173** (dev) or behind `nginx` (prod);
on Helm it is the `-web` Deployment behind the ingress. A `200` here with a blank
page in the browser is a different problem — see [The browser shows a blank
page](/administration/troubleshooting/#the-browser-shows-a-blank-page).

Finally, confirm Django's own static files are served, because the symptom
otherwise only shows up the first time someone opens `/admin/`:

```bash
curl -sI "$BASE/static/admin/css/base.css" | head -3
# → 200 and content-type: text/css
```

### All six at a glance

```bash
docker compose ps
# Every service "Up"; db, valkey, api read "(healthy)".

kubectl get pods -n <ns> -l app.kubernetes.io/instance=<release> -o wide
# Every pod READY 1/1 and Running. The NODE column matters once you run replicas.
```

The OpenAPI schema is at `$BASE/api/schema/swagger-ui/`.

For a production deployment — Kubernetes with Helm, a single server with systemd, or verifying image/chart signatures — see [Deployment](/administration/deployment/). For what survives a pod or node loss, see [Durability & Redundancy](/administration/durability/).

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

See the [Scheduler integration guide](/embedding/standalone/) for full API reference.

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
