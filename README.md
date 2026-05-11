# TruePPM

[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![Pipeline status](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Open-source project scheduling that actually computes the math.**

Most project management tools are glorified to-do lists. They let you draw bars on a timeline, but they don't calculate the critical path, don't tell you which tasks have float, and don't warn you when a dependency change pushes your delivery date. TruePPM does.

TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform for teams that need reliable schedule control — not just task tracking.

> **Status: Pre-Alpha**
> TruePPM is under active development. The scheduling engine, REST API, and real-time backend are functional and tested. The web UI renders a Gantt chart with fixture data; live API wiring is in progress. The project is not yet suitable for production use, but the core engine and API are ready for evaluation and contribution.

## Why TruePPM?

**Real scheduling, not just task lists.** TruePPM runs Critical Path Method (CPM) calculations on every change — forward pass, backward pass, float, and critical-path identification. You always know which tasks drive your deadline and where you have slack.

**Monte Carlo risk analysis built in.** Add three-point estimates (optimistic / most likely / pessimistic) to any task and run a probabilistic simulation. Get P50, P80, and P95 completion dates instead of a single optimistic number. That P80 date is the one you should commit to stakeholders.

**Open source, self-hosted, no vendor lock-in.** The community edition is Apache 2.0. Run it on your own infrastructure. Your data stays yours. The scheduling engine ships as a standalone Python package — use it without the API if you just need the math.

**API-first architecture.** Every feature is a REST or WebSocket endpoint. The web UI is an API consumer with no privileged access, same as any integration you build. The OpenAPI schema is the contract.

**Built for collaboration.** Real-time WebSocket pushes, 5-role RBAC (Owner / Admin / Scheduler / Member / Viewer), and an offline-first sync protocol designed for mobile clients.

## What's Built Today

| Component | Status | What it does |
|-----------|--------|-------------|
| **Scheduling engine** | Stable | CPM (all 4 dependency types, calendar-aware lag, cycle detection) + Monte Carlo simulation. Ships independently as `trueppm-scheduler` on PyPI. |
| **REST API** | Stable | Full CRUD for projects, tasks, dependencies, resources, calendars, members. Auto-scheduling via Celery. OpenAPI 3.1 schema. |
| **RBAC** | Stable | 5-role per-project permissions enforced on every endpoint and WebSocket connection. |
| **Real-time** | Stable | WebSocket broadcasts for every mutation, deferred to transaction commit. |
| **Offline sync** | Stable | WatermelonDB-compatible delta protocol with soft-delete tombstones. |
| **Web UI** | Early | Application shell, Gantt view (split-pane, 6 bar types, 4 dependency types, zoom levels). Currently renders fixture data — live API wiring is in progress. |
| **Helm chart** | Draft | Kubernetes deployment with Bitnami sub-charts for PostgreSQL and Valkey (BSD-licensed Redis fork; wire-compatible). |

### What's Not Built Yet

Board/Kanban view, List view, Calendar view, Resource view, login/auth flow in the UI, drag-to-reschedule on the Gantt, time tracking, baselines, MS Project import/export. See the [roadmap issues](https://gitlab.com/trueppm/trueppm/-/issues) for what's planned.

## Documentation

Full documentation at [docs.trueppm.com](https://docs.trueppm.com) (or build locally from `packages/website/`).

The docs are organized by audience:
- **Getting Started** — installation and quickstart for everyone
- **Guides** — role-specific guides for [project managers](https://docs.trueppm.com/guides/project-managers/), [team members](https://docs.trueppm.com/guides/team-members/), [resource managers](https://docs.trueppm.com/guides/resource-managers/), and [executives](https://docs.trueppm.com/guides/executives/)
- **Administration** — deployment, configuration, RBAC, and security
- **Features** — deep dives into CPM scheduling, Gantt, real-time, and offline sync
- **API Reference** — full endpoint listing with examples
- **Architecture** — system design and ADRs

## Repository Layout

```
trueppm-suite/
├── packages/
│   ├── scheduler/   # CPM + Monte Carlo engine (pip: trueppm-scheduler)
│   ├── api/         # Django 5.1 REST + Channels backend
│   ├── web/         # React 19 + TypeScript frontend
│   ├── helm/        # Helm 3 chart for Kubernetes deployment
│   └── website/     # Astro Starlight documentation site
├── docs/            # Architecture Decision Records (source of record)
└── docker-compose.yml
```

## Quickstart

### Full stack (Docker Compose)

```bash
git clone git@gitlab.com:trueppm/trueppm.git
cd trueppm
docker compose up -d
```

Wait for all services to be healthy (~20 seconds), then apply migrations:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```

| Service    | URL                                        |
|------------|--------------------------------------------|
| Web UI     | http://localhost:5173                      |
| API        | http://localhost:8000                      |
| API schema | http://localhost:8000/api/schema/          |
| Swagger UI | http://localhost:8000/api/schema/swagger-ui/ |

### Scheduling engine only

If you just want the CPM and Monte Carlo engine — no API, no Docker:

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

## Development

See the [full developer guide](https://docs.trueppm.com/getting-started/installation/) for environment variables, CI details, and the complete test matrix.

```bash
# Per-package commands:
cd packages/scheduler && pytest        # scheduler tests
cd packages/api && pytest              # API tests (testcontainers PostgreSQL)
cd packages/web && npm test            # web tests (vitest)
cd packages/website && npm run build   # docs site build
```

## Open-Core Model

**Community edition** (this repo) is Apache 2.0 — scheduling engine, CPM, Monte Carlo, Gantt UI, offline sync, real-time collaboration, 5-role RBAC, REST/WS API, Helm chart. Everything an individual PM or small team needs.

**Enterprise edition** (separate repo, proprietary) adds features for organizations managing a portfolio across multiple programs: portfolio analytics, SSO/SAML/OIDC, immutable audit trail, cross-program resource leveling, AI scheduling, Jira/GitLab/ServiceNow connectors.

The community edition is fully functional on its own — it never imports from the enterprise repo. The dependency is strictly one-way.

## Contributing

TruePPM is in its early days and contributions are welcome.

1. Branch from `main`: `git checkout -b feat/<short-description>`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, etc.)
3. Add a changelog fragment in `changelog.d/` (e.g. `my-change.added.md`) — the CI pipeline checks for this
4. All MRs require a green pipeline before merge

See `CLAUDE.md` for the full developer guide, including coding conventions, two-repo rules, and the OSS/Enterprise boundary.

## License

Apache 2.0 — see [LICENSE](LICENSE).
