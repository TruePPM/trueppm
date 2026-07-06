# TruePPM

[![Dev release](https://img.shields.io/gitlab/v/release/trueppm%2Ftrueppm?sort=semver&include_prereleases&label=dev)](https://gitlab.com/trueppm/trueppm/-/releases)
[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![Pipeline status](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![Coverage](https://gitlab.com/trueppm/trueppm/badges/main/coverage.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **Canonical source: [gitlab.com/trueppm/trueppm](https://gitlab.com/trueppm/trueppm)** — issues and merge requests are handled there. The GitHub repository is a read-only mirror for discovery; it does not accept issues or pull requests.

**Waterfall, agile, and hybrid programs — one platform, one data model.**

Most tools make you pick a side. Jira speaks agile and turns into a mess the moment someone wants a timeline. MS Project speaks waterfall and ignores how the team actually works in two-week sprints. So the project manager keeps a schedule, the team keeps a board, and somebody spends every Monday reconciling the two by hand.

TruePPM removes that reconciliation. A Scrum Master and a project manager look at the **same underlying data** and each sees the view that fits their job. The team closes a sprint; the master schedule re-forecasts on its own. No copy-paste, no status meeting, no second tool.

It's open source, self-hosted, and built scheduling-first: the Critical Path Method (CPM) — the math that works out which tasks actually drive your deadline — is the engine, and the agile board and sprints sit on top of it, not as a parallel system bolted on the side.

> ### Status: 0.3-alpha — pre-GA, not yet production-ready
> The engine and API are solid; the UI works but is still maturing. 0.3 is out as the `0.3.0-alpha.3` pre-release, and **0.4 will be the first beta**. Expect breaking API changes before then. **If you're running real teams, wait for the first beta** — we're still learning what needs to change from early feedback, and we'd rather not lock you in before we do. Kicking the tires, self-hosting a trial, or using the scheduler library? Dive in now.

## Try it in five minutes

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
docker compose up -d
```

Migrations and admin bootstrap run automatically on first startup (~20 seconds). Then seed a populated demo with six persona logins:

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

The command prints the shared persona password when it finishes — in the default local dev stack (Django `DEBUG` on) that's `demo`. To pick your own, set `TRUEPPM_DEMO_PASSWORD` before seeding; on a non-debug (e.g. production) instance the seed generates a random password and prints it once instead.

Sign in at **http://localhost:5173** as the role you want to explore:

| Username | Role | Open this first |
|---|---|---|
| `maya` | Scrum Master | Sprints workspace — burndown, capacity, retrospective |
| `raj` | Project Manager | Schedule view — critical path lit up |
| `diana` | PMO Director | Multi-team sprints lens across projects |
| `sarah` | Resource Manager | Capacity preflight with an over-allocated member |
| `carlos` | Executive | Overview with forecast confidence intervals |
| `tom` | Team Member | Board with the WIP-overload chip and his cards |

Need the admin account (username `admin`)? Its password is generated on first startup and written to a file — read it with `docker compose exec api cat /tmp/trueppm_admin_password`.

| Service    | URL                                          |
|------------|----------------------------------------------|
| Web UI     | http://localhost:5173                        |
| API        | http://localhost:8000                        |
| Swagger UI | http://localhost:8000/api/schema/swagger-ui/ |

Prefer to read before you click? Start with [The Story](https://docs.trueppm.com/the-story/) — the end-to-end hybrid workflow in plain narrative. A hosted public demo (no install at all) ships with the 0.4 beta.

## Is this for you?

TruePPM is built around eight roles. Find yourself below — each links to a guide written in your language, with a short "try it yourself" walkthrough.

| If you're a… | TruePPM gives you… | Guide |
|---|---|---|
| **Project manager** | Real critical-path scheduling, a critical path that updates itself, and probabilistic completion dates (Monte Carlo) you can defend to a client | [Project managers](https://docs.trueppm.com/guides/project-managers/) |
| **Scrum Master** | A first-class sprint (goal, burndown, velocity) — not a board with date columns — and a timeline you never have to open | [Scrum Masters](https://docs.trueppm.com/guides/scrum-masters/) |
| **Product owner** | A prioritized backlog with an epic-and-story hierarchy (big initiatives broken into deliverable stories) and release forecasts from real velocity, not wishful dates | [Product owners](https://docs.trueppm.com/guides/product-owners/) |
| **Team member** | A simple "my work" list and a board — move a card, everything else updates itself. No project-management overhead | [Team members](https://docs.trueppm.com/guides/team-members/) |
| **Resource manager** | Per-project assignment with partial allocation (e.g. someone at 50% on a project) and over-allocation warnings (cross-project lands in 0.5) | [Resource managers](https://docs.trueppm.com/guides/resource-managers/) |
| **Agile coach** | A tool teams adopt *voluntarily*: the sprint stays team-owned, retrospectives flow into the backlog, no surveillance | [Agile coaches](https://docs.trueppm.com/guides/agile-coaches/) |
| **PMO director** | Program-level rollup, role-based permissions, and an operational audit log today; portfolio governance in the enterprise edition | [PMO directors](https://docs.trueppm.com/guides/pmo-directors/) |
| **Executive sponsor** | Confidence-weighted forecasts — the date you're 50%, 80%, or 95% likely to hit (P50/P80/P95) — instead of a single optimistic date | [Executives](https://docs.trueppm.com/guides/executives/) |

Not sure it's a fit? The [evaluation guide](https://docs.trueppm.com/getting-started/evaluation-guide/) walks every capability — which demo, which login, which screen, what to expect — in about 30 minutes.

## Why TruePPM?

**Real scheduling, not just task lists.** TruePPM runs the Critical Path Method on every change — start and finish dates forward, the latest each task can slip backward, and the slack (*float*) on every task. You always know which tasks drive your deadline and where you have room to move.

**Probabilistic forecasts, built in.** Add three-point estimates (optimistic / most likely / pessimistic) to any task and run a Monte Carlo simulation. You get P50, P80, and P95 dates — the dates you're 50%, 80%, and 95% likely to hit — instead of one optimistic number. P80 is the date you commit to stakeholders.

**Agile-native, schedule-aware.** Full sprint lifecycle (plan → activate → close), a board with work-in-progress (WIP) limits, velocity, burndown, and retrospective-to-backlog. The Scrum Master gets a native agile surface and never opens the timeline — and sprint velocity quietly re-forecasts the schedule underneath.

**The hybrid bridge is the whole point.** The same task is both a line in the master schedule and a story on the sprint board. A team member marks a story done, the schedule recalculates on the spot, and the project manager's timeline updates in real time. No status meetings, no reconciliation spreadsheets.

**Computed, not guessed.** Every date, float value, and forecast is calculated by the scheduling engine, with the derivation to show for it. That's also the rule for everything AI-facing: the AI-query server that ships in the 0.4 beta answers from the engine — an AI client can *ask* your schedule questions, but a language model never *invents* your dates.

**Open source, self-hosted, no lock-in.** The community edition is Apache 2.0. Run it on your own infrastructure; your data stays yours. Even single sign-on through your own identity provider is open source — it lands in 0.4, not behind a paywall. And the scheduling engine ships as a standalone Python package if you just need the math.

**API-first.** Every feature is a REST or real-time (WebSocket) endpoint. The web UI is an API consumer with no privileged access, same as any integration you'd build. The OpenAPI schema is the contract.

## What's in the current release (0.3)

| Component | Status | Notes |
|-----------|--------|-------|
| **Scheduling engine** | ✅ Stable | Critical Path Method (all 4 dependency types, calendar-aware lag, cycle detection) plus Monte Carlo forecasting. Ships as a standalone PyPI package. |
| **REST API** | ✅ Stable | Full create/read/update/delete for projects, tasks, dependencies, resources, calendars, members, sprints. Background auto-scheduling. OpenAPI 3.0 schema. |
| **Permissions (RBAC)** | ✅ Stable | 5-role, per-project access control on every endpoint, real-time channel, and UI surface. Member-management UI. |
| **Real-time** | ✅ Stable | Live updates (WebSocket) for every change, deferred until the database transaction commits. |
| **Offline sync** | ✅ Stable | Delta-based protocol that reconciles edits made while offline — including deletions — when you reconnect (WatermelonDB-compatible). |
| **Schedule (timeline / Gantt)** | ✅ Working | Split-pane view, 6 bar types, 4 dependency types, zoom levels, keyboard-first task entry. |
| **Board (Kanban)** | ✅ Working | Phase-grid plus rail/drawer/queue layouts, calm toolbar, drag-to-promote, WIP limits. |
| **Sprints** | ✅ Working | Plan/activate/close workflow, burndown, velocity, capacity preflight, multi-team lens, retrospective. |
| **Forecast UI** | ✅ Working | P50/P80/P95 distribution, live rerun, freshness indicator, burn-up and burn-down charts. |
| **Helm chart** | ✅ Working | Kubernetes deployment with bundled first-party PostgreSQL and Valkey subcharts (official images; Valkey is the BSD-licensed Redis fork). Published to GHCR. |

**New in 0.3** (the agile-team release): a first-class sprint container — goal, capacity, burndown, and state-aware planning, not just a board with date columns; auto-computed velocity with a forecast *range*; sprint sovereignty (mid-sprint scope changes are deliberate and audited, and velocity stays a team metric rather than a management gauge); the bridge demo (promote a sprint commitment to a schedule milestone and watch velocity re-forecast the critical-path finish); an epic-and-story hierarchy with a new Product Owner role; and the v2 interface refresh — a unified app-shell bar with a ⌘K command palette, methodology-adaptive view tabs, and role-based landing pages.

**Next up — 0.4, the first beta.** The headliner is a **read-only AI-query server** built on the Model Context Protocol (MCP): point Claude Desktop, Cursor, or any MCP client at your own instance and ask the live schedule real questions — critical path, "slip this task three days, when do we ship?", sprint status — every answer computed by the engine, never guessed by a model, never leaving your box. Because a beta is judged in its first five minutes, 0.4 is also where TruePPM becomes trivially evaluable: a hosted read-only demo, a one-command trial path, and read-only share links you can hand a stakeholder — the evaluation story that stands in for a mobile app until the installable PWA and native Android land in 0.5. The beta will also bring single sign-on through your own identity provider, a client-ready PDF export, coexistence-first one-way Jira sync (run TruePPM *alongside* Jira — no switch decision required), OpenTelemetry observability, and a published rate-limiting and API-stability contract. The installable PWA, first-run onboarding, and spreadsheet (CSV/Excel) and one-time Jira migration imports land in 0.5. See the [roadmap](https://docs.trueppm.com/overview/roadmap/) for the full plan.

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

If you just need the math, the critical-path and Monte Carlo engine ships as a standalone Apache 2.0 package — no API, no database:

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
- **[Administration](https://docs.trueppm.com/administration/deployment/)** — deployment, configuration, permissions, security
- **[Features](https://docs.trueppm.com/features/scheduler/)** — deep dives into critical-path scheduling, the timeline (Gantt), sprints, real-time, offline sync, and more
- **[API reference](https://docs.trueppm.com/api/reference/)** — full endpoint listing with examples

## Roadmap

Public milestones: [gitlab.com/trueppm/trueppm/-/milestones](https://gitlab.com/trueppm/trueppm/-/milestones). Targets, not commitments. The full release-by-release rationale lives in the [roadmap doc](https://docs.trueppm.com/overview/roadmap/).

From 0.3 onward each release **lands one primary persona** while the hybrid agile/waterfall bridge deepens underneath. Everything below is open source; portfolio governance is reserved for the enterprise edition after 1.0.

- **0.3 — the agile team** *(shipped)*: real sprint container, velocity-with-range, sprint sovereignty (audited scope changes, team-owned velocity), sprint-to-schedule re-forecast, git PR→card auto-move, the v2 interface
- **0.4 — the self-hosting PM's beta**: read-only AI-query server (MCP — answers computed by the engine, never guessed), hosted read-only demo + one-command trial, read-only share links, single sign-on via your own identity provider, client-ready PDF, coexistence-first one-way Jira sync, OpenTelemetry observability, published rate-limiting and API-stability contract
- **0.5 — plan & people**: partial resource allocation with a pre-commit over-allocation warning, timesheets, baselines, installable PWA and native Android app, first-run onboarding, CSV/Excel and one-time Jira migration imports
- **0.6 — open & portable**: import from the top-10 PM tools with preview, AI write surface (MCP) with the scheduling engine as referee, public API depth, shareable roadmap view
- **0.7 — the product owner**: editable product-roadmap surface with release-target lanes, release planning, backlog↔schedule reconciliation
- **0.8 — present & relate**: auto-narrative ("why did the date move" — answered from the engine), reporting suite (PDF, what-if, baseline variance), program web view, cost reports, Team Cohesion technical preview
- **0.9 — GA candidate**: onboarding polish, intuitiveness pass, GA hardening (frozen v1 API, WCAG 2.1 AA accessibility, performance and scale), extension SDK
- **1.0** — first stable GA: Team Cohesion — a Brooks'-Law friction factor (the idea that adding people to a late project makes it later) — as a first-class scheduling input, iPhone/iPad parity, workflow-engine maturity

## Open-core model

TruePPM follows an *open-core* model: a free, Apache 2.0 core that is complete on its own, with proprietary add-ons for organizations that need them.

**Community edition** (this repo) is Apache 2.0 — the scheduling engine (critical-path + Monte Carlo forecasting, standalone on PyPI), the Schedule (timeline / Gantt), the Board (Kanban), Sprints (full lifecycle plus velocity, burndown, and retrospective), Programs, MS Project import/export, offline sync, real-time collaboration, 5-role access control, the REST and real-time API, and the Helm chart. Everything one project manager or program team needs to run their work. Basic single sign-on — logging in through your own identity provider using the OIDC/OAuth standards — is part of the open core too, and lands in 0.4.

**Enterprise edition** (separate repo, proprietary) adds what an *organization* needs to govern a portfolio across many programs: portfolio analytics, organization-wide identity governance (directory sync and enforced company-wide sign-on via the SAML, SCIM, and LDAP standards), an immutable audit trail, cross-program resource leveling, AI-assisted scheduling, and Jira/GitLab/ServiceNow connectors.

The community edition is fully functional on its own — it never imports from the enterprise repo. The dependency is strictly one-way.

## Contributing

TruePPM welcomes contributions.

1. Branch from `main`: `git checkout -b feat/<short-description>`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, etc.)
3. Add a changelog fragment in `changelog.d/` (e.g. `my-change.added.md`) — CI checks for this
4. All MRs require a green pipeline before merge

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, test-layer expectations, and Developer Certificate of Origin (DCO) sign-off requirement.

## Repository layout

```
trueppm-suite/
├── packages/
│   ├── scheduler/      # CPM + Monte Carlo engine (pip: trueppm-scheduler)
│   ├── wasm-scheduler/ # Rust + petgraph CPM engine compiled to WASM
│   ├── api/            # Django 5.2 REST + Channels backend
│   ├── web/            # React 19 + TypeScript frontend
│   ├── helm/           # Helm 3 chart for Kubernetes deployment
│   └── website/        # Astro Starlight documentation site
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

## Published artifacts

| Artifact | Registry |
|----------|----------|
| `trueppm-scheduler` | [PyPI](https://pypi.org/project/trueppm-scheduler/) |
| `ghcr.io/trueppm/api` | [GHCR](https://ghcr.io/trueppm/api) |
| `ghcr.io/trueppm/web` | [GHCR](https://ghcr.io/trueppm/web) |
| Helm chart | `oci://ghcr.io/trueppm/charts/trueppm` |

## Maintainer

**Kelly Hair** — [GitLab](https://gitlab.com/kellyhair) · [LinkedIn](https://www.linkedin.com/in/kellyhair) · [kelly@trueppm.com](mailto:kelly@trueppm.com)

## Security

Report vulnerabilities privately via [SECURITY.md](SECURITY.md) — do not open public issues for security bugs.

## License

Apache 2.0 — see [LICENSE](LICENSE).
