# TruePPM

[![Dev release](https://img.shields.io/gitlab/v/release/trueppm%2Ftrueppm?sort=semver&include_prereleases&label=dev)](https://gitlab.com/trueppm/trueppm/-/releases)
[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![Pipeline status](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![Coverage](https://gitlab.com/trueppm/trueppm/badges/main/coverage.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Waterfall, agile, and hybrid programs — one platform, one data model.**

Most project management tools force a choice: Jira speaks Agile and translates poorly to a Gantt; MS Project speaks Waterfall and ignores the team's actual cadence. TruePPM is built so a Scrum Master and a Project Manager look at the same underlying data and each sees the view they need.

TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform — built scheduling-first, with a fully native agile surface layered on top. CPM is the engine, not a bolt-on. Agile boards and sprints are an overlay on the schedule, not a parallel system.

> **Status: 0.2-alpha — pre-GA. Not ready for production use.**
> The core engine and API are solid; the UI is functional but still maturing. 0.2 has shipped as the `0.2.0-alpha.1` pre-release; releases stay alpha through 0.3, and 0.4 will be the first beta. Expect breaking API changes between alpha and beta. **Hold off on deploying for real teams until the first beta release** — we don't know yet what needs to change based on early feedback, and locking in users before we do will make that harder.

## Why TruePPM?

**Real scheduling, not just task lists.** TruePPM runs Critical Path Method (CPM) calculations on every change — forward pass, backward pass, float, and critical-path identification. You always know which tasks drive your deadline and where you have slack.

**Monte Carlo risk analysis built in.** Add three-point estimates (optimistic / most likely / pessimistic) to any task and run a probabilistic simulation. Get P50, P80, and P95 completion dates instead of a single optimistic number. That P80 date is the one you should commit to stakeholders.

**Agile-native, schedule-aware.** Full sprint lifecycle (plan → activate → close), board with WIP limits, velocity tracking, burndown charts, retrospective-to-backlog automation. The Scrum Master gets a native agile surface and never opens the Gantt. Sprint velocity feeds non-destructive duration suggestions back to the schedule; automatic sprint→schedule reforecast ships in 0.3.

**Hybrid bridge built in.** The same task is both a WBS node and a sprint story. When a team member marks a story done, the schedule recalculates on the spot and the PM's Gantt updates in real time — and automatic sprint→schedule reforecast lands in 0.3. No status meetings, no reconciliation spreadsheets.

**Open source, self-hosted, no vendor lock-in.** The community edition is Apache 2.0. Run it on your own infrastructure. Your data stays yours. The scheduling engine ships as a standalone Python package — use it without the API if you just need the math.

**API-first architecture.** Every feature is a REST or WebSocket endpoint. The web UI is an API consumer with no privileged access, same as any integration you build. The OpenAPI schema is the contract.

**Built for collaboration.** Real-time WebSocket pushes, 5-role RBAC (Owner / Admin / Scheduler / Member / Viewer), and an offline-first sync protocol designed for mobile clients.

## What's in 0.2

| Component | Status | Notes |
|-----------|--------|-------|
| **Scheduling engine** | ✅ Stable | CPM (all 4 dependency types, calendar-aware lag, cycle detection) + Monte Carlo. Standalone PyPI package. |
| **REST API** | ✅ Stable | Full CRUD for projects, tasks, dependencies, resources, calendars, members, sprints. Auto-scheduling via Celery. OpenAPI 3.0 schema. |
| **RBAC** | ✅ Stable | 5-role per-project permissions on every endpoint, WebSocket, and UI surface. Members management UI. |
| **Real-time** | ✅ Stable | WebSocket broadcasts for every mutation, deferred to transaction commit. |
| **Offline sync** | ✅ Stable | WatermelonDB-compatible delta protocol with soft-delete tombstones. |
| **Schedule (Gantt)** | ✅ Wired | Split-pane view, 6 bar types, 4 dependency types, zoom levels, build mode (keyboard-first task entry). |
| **Board / Kanban** | ✅ Wired | Phase-grid + rail/drawer/queue layouts, calm toolbar, drag-to-promote, WIP control. |
| **Sprints** | ✅ Wired | Plan/activate/close workflow, burndown, velocity, capacity preflight, multi-team lens, retrospective. |
| **Monte Carlo UI** | ✅ Wired | P50/P80/P95 distribution, live rerun, freshness indicator, burn-up and burn-down charts. |
| **Helm chart** | ✅ Functional | Kubernetes deployment with bundled first-party PostgreSQL and Valkey subcharts (official images; Valkey is the BSD-licensed Redis fork). Published to GHCR OCI registry. |

**Added in 0.2:** a settings & administration platform, the Program entity (OSS) with program backlog, MS Project XML import/export UI, recurring tasks, board + schedule depth, durable-execution hardening, and Slack/email notifications. **Coming in 0.3** (the agile-team release): a first-class sprint container, velocity-with-range, sprint→schedule reforecast, and git PR→card auto-move. CSV/Excel and MS Project `.mpp` import are sequenced for 0.6.

## Published Artifacts

| Artifact | Registry |
|----------|----------|
| `trueppm-scheduler` | [PyPI](https://pypi.org/project/trueppm-scheduler/) |
| `ghcr.io/trueppm/api` | [GHCR](https://ghcr.io/trueppm/api) |
| `ghcr.io/trueppm/web` | [GHCR](https://ghcr.io/trueppm/web) |
| Helm chart | `oci://ghcr.io/trueppm/charts/trueppm` |

## Documentation

Full documentation at **[docs.trueppm.com](https://docs.trueppm.com)** (published via GitLab Pages on every release tag).

- **[Installation](https://docs.trueppm.com/getting-started/installation/)** — Docker Compose, Helm/Kubernetes, single-server, or scheduler library
- **[Sample projects](https://docs.trueppm.com/getting-started/sample-projects/)** — load a populated demo program in one click, or import/export any program as JSON
- **[Upgrading](https://docs.trueppm.com/getting-started/upgrade/)** — rolling upgrades and rollback for each deployment path
- **[Guides](https://docs.trueppm.com/guides/project-managers/)** — role-specific guides for project managers, team members, resource managers, and executives
- **[Administration](https://docs.trueppm.com/administration/deployment/)** — deployment, configuration, RBAC, security
- **[Features](https://docs.trueppm.com/features/scheduler/)** — deep dives into CPM, Schedule (Gantt), sprints, real-time, offline sync, and more
- **[API Reference](https://docs.trueppm.com/api/reference/)** — full endpoint listing with examples
- **[Release Process](https://docs.trueppm.com/contributing/release/)** — how to cut a release (maintainers)

## Repository Layout

```
trueppm-suite/
├── packages/
│   ├── scheduler/   # CPM + Monte Carlo engine (pip: trueppm-scheduler)
│   ├── api/         # Django 5.2 REST + Channels backend
│   ├── web/         # React 19 + TypeScript frontend
│   ├── helm/        # Helm 3 chart for Kubernetes deployment
│   └── website/     # Astro Starlight documentation site
├── docs/            # Architecture Decision Records (source of record)
├── docker-compose.yml       # development stack
└── docker-compose.prod.yml  # production stack (GHCR images + TLS)
```

## Quickstart

### Full stack (Docker Compose)

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
docker compose up -d
```

Migrations and admin bootstrap run automatically on first startup (~20 seconds). Retrieve the generated admin password:

```bash
docker compose exec api cat /tmp/trueppm_admin_password
```

| Service    | URL                                          |
|------------|----------------------------------------------|
| Web UI     | http://localhost:5173                        |
| API        | http://localhost:8000                        |
| Swagger UI | http://localhost:8000/api/schema/swagger-ui/ |

Seed a populated demo project:

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
# Demo logins (password: demo):
#   maya  — Scrum Master    raj    — Project Manager
#   diana — PMO Director    sarah  — Resource Manager
#   carlos — Exec Sponsor   tom    — Senior Engineer
```

### Production (single server)

```bash
cp .env.example .env   # fill in DOMAIN, SECRET_KEY, DB_PASSWORD, REDIS_PASSWORD
chmod +x init-prod.sh
./init-prod.sh         # obtains TLS cert, starts production stack
```

### Helm / Kubernetes

```bash
helm install trueppm oci://ghcr.io/trueppm/charts/trueppm \
  --version 0.2.0 \
  --namespace trueppm --create-namespace \
  -f my-values.yaml
```

See the [full installation guide](https://docs.trueppm.com/getting-started/installation/) for prerequisites and values configuration.

### Scheduling engine only

```bash
pip install trueppm-scheduler
```

```python
from datetime import date, timedelta
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency, DependencyType

calendar = Calendar()  # Mon–Fri, no holidays (whole-day scheduling)
task_a = Task(id="t-1", name="Design", duration=timedelta(days=5))
task_b = Task(id="t-2", name="Build",  duration=timedelta(days=10))
dep = Dependency(predecessor_id="t-1", successor_id="t-2", dep_type=DependencyType.FS)

project = Project(
    id="p-1",
    name="My Project",
    start_date=date(2026, 1, 5),
    tasks=[task_a, task_b],
    dependencies=[dep],
    calendar=calendar,
)

result = schedule(project)
build = next(t for t in result.tasks if t.id == "t-2")
print(build.early_finish)  # 2026-01-23 (15 working days from 2026-01-05, across two weekends)
```

## Development

```bash
make setup    # install git hooks via pre-commit
make doctor   # verify prerequisites
make up       # start dev stack
make test     # run all tests (pytest + vitest)
make lint     # ruff + eslint
make pre-push # full CI gate (lint, typecheck, migrations, schema)
```

See `CLAUDE.md` for coding conventions, two-repo rules, and the complete developer guide.

## Open-Core Model

**Community edition** (this repo) is Apache 2.0 — scheduling engine (CPM + Monte Carlo, standalone on PyPI), Schedule (Gantt), Board / Kanban, Sprints (full lifecycle + velocity + burndown + retro), Programs, MS Project import/export, offline sync, real-time collaboration, 5-role RBAC, REST/WS API, Helm chart. Everything an individual PM or program team needs.

**Enterprise edition** (separate repo, proprietary) adds features for organizations managing a portfolio across multiple programs: portfolio analytics, SSO/SAML/OIDC, immutable audit trail, cross-program resource leveling, AI scheduling, Jira/GitLab/ServiceNow connectors.

The community edition is fully functional on its own — it never imports from the enterprise repo. The dependency is strictly one-way.

## Maintainer

**Kelly Hair** — [GitLab](https://gitlab.com/kellyhair) · [LinkedIn](https://www.linkedin.com/in/kellyhair) · [kelly@trueppm.com](mailto:kelly@trueppm.com)

## Contributing

TruePPM welcomes contributions.

1. Branch from `main`: `git checkout -b feat/<short-description>`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, etc.)
3. Add a changelog fragment in `changelog.d/` (e.g. `my-change.added.md`) — CI checks for this
4. All MRs require a green pipeline before merge

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, test layer expectations, and DCO sign-off requirement.

## Security

Report vulnerabilities privately via [SECURITY.md](SECURITY.md) — do not open public issues for security bugs.

## Roadmap

Public milestones: [gitlab.com/trueppm/trueppm/-/milestones](https://gitlab.com/trueppm/trueppm/-/milestones). Targets, not commitments. The full release-by-release rationale lives in the [Roadmap doc](https://docs.trueppm.com/overview/roadmap/).

From 0.3 onward each release **lands one primary persona** while the hybrid agile/waterfall bridge deepens underneath. The sequence expands by org scope; everything is OSS, with portfolio governance reserved for the enterprise edition after 1.0.

- **0.3 — the agile team**: real sprint container, velocity-with-range, sprint sovereignty (audited scope changes, team-owned velocity), sprint→schedule reforecast, git PR→card auto-move, sample-data launch demo
- **0.4 — mobile & the field PM**: native React Native editor (Android-first), iOS PWA fallback, basic client-ready PDF, ongoing one-way Jira sync, read-only MCP server (team-scoped), offline hardening
- **0.5 — plan & people**: partial resource allocation + pre-commit conflict warning, timesheets, baselines, deep CPM-aware bridge, durable-execution default backend
- **0.6 — open & portable**: multi-format import with preview, MCP write surface, public REST API depth, read-only shareable roadmap
- **0.7 — the product owner**: editable product roadmap surface with release-target lanes, release planning, backlog↔schedule reconciliation
- **0.8 — present & relate**: reporting (PDF, what-if, baseline variance, auto-narrative), program web view, single-program health digest, cost reports
- **0.9 — GA candidate**: first-run onboarding, intuitiveness pass, GA hardening (API v1 freeze, WCAG 2.1 AA, perf/scale, i18n), extension SDK
- **1.0** — first stable GA: Team Cohesion (Brooks' Law) as a first-class scheduling input, iPhone/iPad parity, workflow-engine maturity

## License

Apache 2.0 — see [LICENSE](LICENSE).
