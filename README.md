# TruePPM

[![Dev release](https://img.shields.io/gitlab/v/release/trueppm%2Ftrueppm?sort=semver&include_prereleases&label=dev)](https://gitlab.com/trueppm/trueppm/-/releases)
[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![Pipeline status](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![Coverage](https://gitlab.com/trueppm/trueppm/badges/main/coverage.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Waterfall, agile, and hybrid programs — one platform, one data model.**

Most tools make you pick a side. Jira speaks agile and turns into a mess the moment someone wants a Gantt. MS Project speaks waterfall and ignores how the team actually works in two-week sprints. So the project manager keeps a schedule, the team keeps a board, and somebody spends every Monday reconciling the two by hand.

TruePPM removes that reconciliation. A Scrum Master and a project manager look at the **same underlying data** and each sees the view that fits their job. The team closes a sprint; the master schedule reforecasts on its own. No copy-paste, no status meeting, no second tool.

It's open source, self-hosted, and built scheduling-first: Critical Path Method (CPM) is the engine, and the agile board and sprints are a layer on top of it — not a parallel system bolted on the side.

> ### Status: 0.2-alpha — pre-GA, not yet production-ready
> The engine and API are solid; the UI works but is still maturing. 0.2 is out as the `0.2.0-alpha.1` pre-release. The line stays alpha through 0.3, and **0.4 will be the first beta**. Expect breaking API changes before then. **If you're running real teams, wait for the first beta** — we're still learning what needs to change from early feedback, and we'd rather not lock you in before we do. Kicking the tires, self-hosting a trial, or using the scheduler library? Dive in now.

## Is this for you?

TruePPM is built around eight roles. Find yourself below — each links to a guide written in your language, with a short "try it yourself" walkthrough.

| If you're a… | TruePPM gives you… | Guide |
|---|---|---|
| **Project manager** | Real CPM scheduling, a critical path that updates itself, and Monte Carlo dates you can defend to a client | [Project managers](https://docs.trueppm.com/guides/project-managers/) |
| **Scrum Master** | A first-class sprint (goal, burndown, velocity) — not a board with date columns — and a Gantt you never have to open | [Scrum Masters](https://docs.trueppm.com/guides/scrum-masters/) |
| **Product owner** | A prioritized backlog with epic/story hierarchy and release forecasts from real velocity, not wishful dates | [Product owners](https://docs.trueppm.com/guides/product-owners/) |
| **Team member** | A simple "my work" list and a board — move a card, everything else updates itself. No PM overhead | [Team members](https://docs.trueppm.com/guides/team-members/) |
| **Resource manager** | Per-project assignment with fractional allocation and over-allocation warnings (cross-project lands in 0.5) | [Resource managers](https://docs.trueppm.com/guides/resource-managers/) |
| **Agile coach** | A tool teams adopt *voluntarily*: the sprint stays team-owned, retros flow into the backlog, no surveillance | [Agile coaches](https://docs.trueppm.com/guides/agile-coaches/) |
| **PMO director** | Program-level rollup, RBAC, and an operational audit log today; portfolio governance in the enterprise edition | [PMO directors](https://docs.trueppm.com/guides/pmo-directors/) |
| **Executive sponsor** | Confidence-weighted forecasts (P50/P80/P95) instead of a single optimistic date | [Executives](https://docs.trueppm.com/guides/executives/) |

Not sure it's a fit? The [evaluation guide](https://docs.trueppm.com/getting-started/evaluation-guide/) walks every capability — which demo, which login, which screen, what to expect — in about 30 minutes.

## Why TruePPM?

**Real scheduling, not just task lists.** TruePPM runs CPM on every change — forward pass, backward pass, float, critical-path identification. You always know which tasks drive your deadline and where you have slack.

**Monte Carlo risk analysis built in.** Add three-point estimates (optimistic / most likely / pessimistic) to any task and run a probabilistic simulation. You get P50, P80, and P95 dates instead of one optimistic number. P80 is the date you commit to stakeholders.

**Agile-native, schedule-aware.** Full sprint lifecycle (plan → activate → close), board with WIP limits, velocity, burndown, retrospective-to-backlog. The Scrum Master gets a native agile surface and never opens the Gantt. Sprint velocity feeds non-destructive duration suggestions back to the schedule; automatic sprint→schedule reforecast ships in 0.3.

**The hybrid bridge is the whole point.** The same task is both a WBS node and a sprint story. A team member marks a story done, the schedule recalculates on the spot, and the PM's Gantt updates in real time. No status meetings, no reconciliation spreadsheets.

**Open source, self-hosted, no lock-in.** The community edition is Apache 2.0. Run it on your own infrastructure; your data stays yours. The scheduling engine ships as a standalone Python package — use it on its own if you just need the math.

**API-first.** Every feature is a REST or WebSocket endpoint. The web UI is an API consumer with no privileged access, same as any integration you'd build. The OpenAPI schema is the contract.

## Try it in five minutes

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
docker compose up -d
```

Migrations and admin bootstrap run automatically on first startup (~20 seconds). Then seed a populated demo with the eight persona logins:

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

Sign in at **http://localhost:5173** (password: `demo`) as the role you want to explore:

| Username | Role | Open this first |
|---|---|---|
| `maya` | Scrum Master | Sprints workspace — burndown, capacity, retro |
| `raj` | Project Manager | Schedule view — critical path lit up |
| `diana` | PMO Director | Multi-team sprints lens across projects |
| `sarah` | Resource Manager | Capacity preflight with an over-allocated member |
| `carlos` | Executive | Overview with forecast confidence intervals |
| `tom` | Team Member | Board with the WIP-overload chip and his cards |

Need the admin password? `docker compose exec api cat /tmp/trueppm_admin_password`.

| Service    | URL                                          |
|------------|----------------------------------------------|
| Web UI     | http://localhost:5173                        |
| API        | http://localhost:8000                        |
| Swagger UI | http://localhost:8000/api/schema/swagger-ui/ |

Prefer to read before you click? Start with [The Story](https://docs.trueppm.com/the-story/) — the end-to-end hybrid workflow in plain narrative.

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

**Added in 0.2:** a settings & administration platform, the Program entity (OSS) with program backlog, MS Project XML import/export UI, recurring tasks, board + schedule depth, durable-execution hardening, and Slack/email notifications.

**Coming in 0.3** (the agile-team release): a first-class sprint container, velocity-with-range, sprint→schedule reforecast, and git PR→card auto-move. CSV/Excel and MS Project `.mpp` import are sequenced for 0.6. See the [roadmap](https://docs.trueppm.com/overview/roadmap/) for the full release-by-release plan.

## Other ways to run it

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

If you just need the math, the CPM + Monte Carlo engine ships as a standalone Apache 2.0 package — no API, no database:

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

## Documentation

Full documentation at **[docs.trueppm.com](https://docs.trueppm.com)** (published via GitLab Pages on every release tag).

- **[Installation](https://docs.trueppm.com/getting-started/installation/)** — Docker Compose, Helm/Kubernetes, single-server, or scheduler library
- **[Quickstart](https://docs.trueppm.com/getting-started/quickstart/)** — from clone to a populated workspace in five minutes
- **[Evaluation guide](https://docs.trueppm.com/getting-started/evaluation-guide/)** — verify every capability in ~30 minutes: which demo, which login, which screen, what to expect
- **[Sample projects](https://docs.trueppm.com/getting-started/sample-projects/)** — load a populated demo program in one click, or import/export any program as JSON
- **[Role guides](https://docs.trueppm.com/guides/project-managers/)** — for project managers, Scrum Masters, product owners, team members, resource managers, agile coaches, PMO directors, and executives
- **[Administration](https://docs.trueppm.com/administration/deployment/)** — deployment, configuration, RBAC, security
- **[Features](https://docs.trueppm.com/features/scheduler/)** — deep dives into CPM, Schedule (Gantt), sprints, real-time, offline sync, and more
- **[API reference](https://docs.trueppm.com/api/reference/)** — full endpoint listing with examples

## Published artifacts

| Artifact | Registry |
|----------|----------|
| `trueppm-scheduler` | [PyPI](https://pypi.org/project/trueppm-scheduler/) |
| `ghcr.io/trueppm/api` | [GHCR](https://ghcr.io/trueppm/api) |
| `ghcr.io/trueppm/web` | [GHCR](https://ghcr.io/trueppm/web) |
| Helm chart | `oci://ghcr.io/trueppm/charts/trueppm` |

## Repository layout

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

## Open-core model

**Community edition** (this repo) is Apache 2.0 — the scheduling engine (CPM + Monte Carlo, standalone on PyPI), Schedule (Gantt), Board / Kanban, Sprints (full lifecycle + velocity + burndown + retro), Programs, MS Project import/export, offline sync, real-time collaboration, 5-role RBAC, REST/WS API, and the Helm chart. Everything one PM or program team needs to run their work. Basic single sign-on (OIDC/OAuth against your own IdP) is part of the open core too, and lands in 0.4.

**Enterprise edition** (separate repo, proprietary) adds what an *organization* needs to govern a portfolio across many programs: portfolio analytics, org identity governance (SAML/SCIM/LDAP directory sync, enforced org-wide SSO), an immutable audit trail, cross-program resource leveling, AI scheduling, and Jira/GitLab/ServiceNow connectors.

The community edition is fully functional on its own — it never imports from the enterprise repo. The dependency is strictly one-way.

## Contributing

TruePPM welcomes contributions.

1. Branch from `main`: `git checkout -b feat/<short-description>`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, etc.)
3. Add a changelog fragment in `changelog.d/` (e.g. `my-change.added.md`) — CI checks for this
4. All MRs require a green pipeline before merge

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, test-layer expectations, and DCO sign-off requirement.

## Roadmap

Public milestones: [gitlab.com/trueppm/trueppm/-/milestones](https://gitlab.com/trueppm/trueppm/-/milestones). Targets, not commitments. The full release-by-release rationale lives in the [roadmap doc](https://docs.trueppm.com/overview/roadmap/).

From 0.3 onward each release **lands one primary persona** while the hybrid agile/waterfall bridge deepens underneath. The sequence expands by org scope; everything is OSS, with portfolio governance reserved for the enterprise edition after 1.0.

- **0.3 — the agile team**: real sprint container, velocity-with-range, sprint sovereignty (audited scope changes, team-owned velocity), sprint→schedule reforecast, git PR→card auto-move, sample-data launch demo
- **0.4 — mobile & the field PM**: native React Native editor (Android-first), iOS PWA fallback, basic client-ready PDF, ongoing one-way Jira sync, read-only MCP server (team-scoped), offline hardening
- **0.5 — plan & people**: partial resource allocation + pre-commit conflict warning, timesheets, baselines, deep CPM-aware bridge, durable-execution default backend
- **0.6 — open & portable**: multi-format import with preview, MCP write surface, public REST API depth, read-only shareable roadmap
- **0.7 — the product owner**: editable product roadmap surface with release-target lanes, release planning, backlog↔schedule reconciliation
- **0.8 — present & relate**: reporting (PDF, what-if, baseline variance, auto-narrative), program web view, single-program health digest, cost reports
- **0.9 — GA candidate**: first-run onboarding, intuitiveness pass, GA hardening (API v1 freeze, WCAG 2.1 AA, perf/scale, i18n), extension SDK
- **1.0** — first stable GA: Team Cohesion (Brooks' Law) as a first-class scheduling input, iPhone/iPad parity, workflow-engine maturity

## Maintainer

**Kelly Hair** — [GitLab](https://gitlab.com/kellyhair) · [LinkedIn](https://www.linkedin.com/in/kellyhair) · [kelly@trueppm.com](mailto:kelly@trueppm.com)

## Security

Report vulnerabilities privately via [SECURITY.md](SECURITY.md) — do not open public issues for security bugs.

## License

Apache 2.0 — see [LICENSE](LICENSE).
