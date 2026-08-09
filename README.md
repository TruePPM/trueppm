# TruePPM

[![Dev release](https://img.shields.io/gitlab/v/release/trueppm%2Ftrueppm?sort=semver&include_prereleases&label=dev)](https://gitlab.com/trueppm/trueppm/-/releases)
[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![Pipeline status](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![Coverage](https://gitlab.com/trueppm/trueppm/badges/main/coverage.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![Quality gate status](https://sonarcloud.io/api/project_badges/measure?project=trueppm_trueppm&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=trueppm_trueppm)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **Canonical source: [gitlab.com/trueppm/trueppm](https://gitlab.com/trueppm/trueppm)** — issues and merge requests are handled there. The GitHub repository is a read-only mirror for discovery; it does not accept issues or pull requests.

**Most project tools store dates. This one computes them.**

At the center of TruePPM is a real Critical Path Method engine — all four dependency types, lead/lag on every link, cycle detection, float on every task — with Monte Carlo risk analysis on top. Not a Gantt chart that draws bars where you drag them: an engine that works out which tasks actually drive your deadline, and what date you are 80% likely to hit.

You don't have to take that on faith, and you don't have to install a platform to check. The engine is a **separate Apache-2.0 Python package**. Verify the math in sixty seconds — no signup, no Docker, no account:

```bash
pip install trueppm-scheduler
```

```python
from datetime import date, timedelta
from trueppm_scheduler import schedule, Project, Task, Dependency

result = schedule(Project(
    id="p-1", name="Verify me", start_date=date(2026, 1, 5),
    tasks=[
        Task(id="design", name="Design", duration=timedelta(days=5)),
        Task(id="build",  name="Build",  duration=timedelta(days=10)),
        Task(id="docs",   name="Docs",   duration=timedelta(days=3)),
    ],
    dependencies=[Dependency(predecessor_id="design", successor_id="build")],
))

print(result.critical_path)                                  # ['design', 'build']
print(next(t for t in result.tasks if t.id == "build").early_finish)   # 2026-01-23
print(next(t for t in result.tasks if t.id == "docs").total_float)     # 12 days, 0:00:00
```

Fifteen working days across two weekends, computed on a Mon–Fri calendar — and `docs`, off the critical path, has twelve days of slack it can absorb before the date moves. Check it against MS Project if you like. That is the point of shipping the engine on its own.

That engine is the product. Everything else — the web UI, the agile board, sprints, programs, real-time sync, offline, RBAC, the REST API — is a platform wrapped around it, built on one rule: **the board card and the Gantt bar are the same object.** Close a sprint and the master schedule reforecasts itself. There is no reconciliation step because there is nothing to reconcile.

And because every date is *computed* rather than stored, it is answerable. That's the principle we call **computed, not guessed**: an AI client can **compute** an answer from the engine instead of guessing it, **cite** the derivation behind it, be **refused** when a change would break the plan, and **reproduce** any answer later. The read-only AI-query server (MCP) landing in the 0.4 beta is its first surface — real questions against your live schedule, never a language model's guess, and nothing leaves your box.

> ### Status: 0.4-beta, in development — pre-GA, not yet production-ready
> The engine and API are solid; the UI works but is still maturing. The latest tagged release is the `0.3.0-alpha.3` pre-release; `main` and both packages now carry `0.4.0-beta.1`, and **0.4 will be the first beta** — targeted for late August 2026. So if you clone this repository you are running a pre-release of the beta, not 0.3. Expect breaking API changes before 1.0. **If you're running real teams, wait for the beta tag** — we're still learning what needs to change from early feedback, and we'd rather not lock you in before we do. Kicking the tires, self-hosting a trial, or using the scheduler library? Dive in now.

## Run the whole platform — five minutes

The engine above is the sixty-second check. This is the five-minute one: the full stack, populated with real data and six persona logins.

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

## What's actually different

Four claims, each one you can check rather than take on trust.

**1. Monte Carlo schedule risk, in the free core.** Add three-point estimates (optimistic / most likely / pessimistic) to any task and get P50, P80, and P95 dates plus a per-task sensitivity ranking — which tasks actually move the finish. Across the commercial field this is a separately licensed product bolted onto a schedule exported from somewhere else: Deltek Acumen Risk, Barbecana Full Monte, Safran Risk, Oracle Primavera Risk Analysis. TruePPM computes it in the same engine that computes the dates, and we are not aware of another open-source PPM platform that ships it at all. If you find one, [open an issue](https://gitlab.com/trueppm/trueppm/-/issues) and we'll correct this line.

**2. The engine is separable, so the claim is falsifiable.** `pip install trueppm-scheduler` gets you the CPM and Monte Carlo math with no server, no database, and no account — the same code the platform runs on, versioned in lockstep. No other PPM tool, open or commercial, lets you audit its scheduling engine in isolation. That is not a convenience feature; it is the reason you should believe the rest of this README.

**3. The board card and the Gantt bar are the same object.** Not synced, not mirrored — the same row. MS Project has no agile surface. Jira has no critical path. OpenProject has both a board and a Gantt, but they are adjacent views rather than one coupled model. In TruePPM a team member drags a card to Done, the CPM re-runs, and the project manager's finish date moves in real time. Close a sprint and measured velocity reforecasts the schedule. There is no Monday reconciliation meeting because there is nothing to reconcile.

**4. Nothing that should be free is taxed.** The community edition is Apache 2.0 with no seat count, no feature flags, and no telemetry. Single sign-on through your own identity provider ships in the OSS core at 0.4 — OpenProject gates OIDC and SAML behind its Enterprise tier, and Plane gates SSO behind its Commercial editions.<sup>[†](https://docs.trueppm.com/overview/sso-is-not-enterprise/)</sup> The enterprise edition earns its price on identity *governance* (SAML, SCIM, LDAP sync) and cross-program portfolio coordination — not on the login screen. Every competitor claim is dated and sourced on [**How TruePPM compares**](https://docs.trueppm.com/overview/how-it-compares/).

**And the rule underneath all of it: computed, not guessed.** Every date, float value, and forecast is calculated by the engine with a derivation to show for it — which is what makes the schedule safe to hand an AI. An agent can **compute** an answer from the engine (never a model's guess), **cite** the server-side derivation, be **refused** when a proposed change breaks the plan's own rules — the same refusal a human hits — and **reproduce** any answer later from the same inputs. The read-only AI-query server lands in the 0.4 beta; the guarded write path follows in 0.6. See [Computed, not guessed](https://docs.trueppm.com/overview/computed-not-guessed/).

## What it doesn't do yet

We would rather you find these here than forty minutes into an evaluation. This list is maintained, not decorative — see [**What TruePPM doesn't do yet**](https://docs.trueppm.com/overview/what-it-does-not-do/) for the full version with issue links.

| Gap | Status |
|---|---|
| **Resource leveling** | Not implemented. The engine computes the schedule; it will not resolve an over-allocation for you. Per-project allocation with over-allocation *warnings* lands in 0.5; cross-program leveling is an enterprise feature after 1.0. If you need automatic leveling today, use P6 or MS Project. |
| **Schedule constraints** | One type. `planned_start` is honored as start-no-earlier-than. There is no must-finish-on, finish-no-later-than, or deadline constraint. MS Project ships eight. |
| **Cost and earned value** | Not present. Resource costs and EV-lite (PV/EV/AC, SPI/CPI) are planned for 0.8. If your practice is cost-centric, TruePPM is not ready for you. |
| **Scale** | A project stays comfortable in the Schedule view to roughly **1,000 tasks**, bounded by the whole-project client load. Measured, not estimated — see the [tested scale envelope](https://docs.trueppm.com/administration/sizing/#tested-envelope). P6 handles two orders of magnitude more. |
| **Mobile** | No app yet. An installable PWA lands in 0.5, a native Android app in 0.6, iOS at 1.0. |
| **Maturity** | 0.3 was an alpha; 0.4 will be the first beta. TruePPM is built part-time. OpenProject has fifteen years, full-time staff, and a support contract. What we have is the [commit history](https://gitlab.com/trueppm/trueppm/-/commits/main) and a [roadmap](https://docs.trueppm.com/overview/roadmap/) that dates its targets at honest precision. Judge accordingly. |

**API-first, so none of this is a black box.** Every feature is a REST or WebSocket endpoint; the web UI is an API consumer with no privileged access. The OpenAPI schema is the contract.

## What's in the current release (0.3)

| Component | Status | Notes |
|-----------|--------|-------|
| **Scheduling engine** | ✅ Stable | Critical Path Method (all 4 dependency types, lead/lag on every link, cycle detection) plus Monte Carlo forecasting. Ships as a standalone PyPI package. |
| **REST API** | ✅ Stable | Full create/read/update/delete for projects, tasks, dependencies, resources, calendars, members, sprints. Background auto-scheduling. OpenAPI 3.0 schema. |
| **Permissions (RBAC)** | ✅ Stable | 5-role, per-project access control on every endpoint, real-time channel, and UI surface. Member-management UI. |
| **Real-time** | ✅ Stable | Live updates (WebSocket) for every change, deferred until the database transaction commits. |
| **Offline sync** | ✅ Stable | Delta-based protocol that reconciles edits made while offline — including deletions — when you reconnect (WatermelonDB-compatible). |
| **Schedule (timeline / Gantt)** | ✅ Working | Split-pane view, 6 bar types, 4 dependency types, zoom levels, keyboard-first task entry. |
| **Board (Kanban)** | ✅ Working | Phase-grid plus rail/drawer/queue layouts, calm toolbar, drag-to-promote, WIP limits. |
| **Sprints** | ✅ Working | Plan/activate/close workflow, burndown, velocity, capacity preflight, multi-team lens, retrospective. |
| **Forecast UI** | ✅ Working | P50/P80/P95 distribution, live rerun, freshness indicator, burn-up and burn-down charts. |
| **Helm chart** | ✅ Working | Kubernetes deployment with bundled first-party PostgreSQL and Valkey subcharts (official images; Valkey is the BSD-licensed Redis fork). Install from the chart source today; public OCI (GHCR) publication is planned (#939). |

**New in 0.3** (the agile-team release): a first-class sprint container — goal, capacity, burndown, and state-aware planning, not just a board with date columns; auto-computed velocity with a forecast *range*; sprint sovereignty (mid-sprint scope changes are deliberate and audited, and velocity stays a team metric rather than a management gauge); the bridge demo (promote a sprint commitment to a schedule milestone and watch velocity re-forecast the critical-path finish); an epic-and-story hierarchy with a new Product Owner role; and the v2 interface refresh — a unified app-shell bar with a ⌘K command palette, methodology-adaptive view tabs, and role-based landing pages.

**Next up — 0.4, the first beta.** The headliner is a **read-only AI-query server** built on the Model Context Protocol (MCP): point Claude Desktop, Cursor, or any MCP client at your own instance and ask the live schedule real questions — critical path, "slip this task three days, when do we ship?", sprint status — every answer computed by the engine, never guessed by a model, never leaving your box. Because a beta is judged in its first five minutes, 0.4 is also where TruePPM becomes trivially evaluable: a hosted read-only demo, a one-command trial path, and read-only share links you can hand a stakeholder — the evaluation story that stands in for a mobile app until the installable PWA lands in 0.5 and the native Android app in 0.6. The beta will also bring single sign-on through your own identity provider, a client-ready PDF export, coexistence-first one-way Jira sync (run TruePPM *alongside* Jira — no switch decision required), OpenTelemetry observability, a published rate-limiting and API-stability contract, and spreadsheet (CSV/Excel) import — a three-step wizard that gets the plan you already keep in a spreadsheet onto a CPM engine. The installable PWA and first-run onboarding follow in 0.5, and the one-time Jira migration import in 0.6. See the [roadmap](https://docs.trueppm.com/overview/roadmap/) for the full plan.

## Other ways to run it

### Production (single server)

```bash
cp .env.example .env   # fill in DOMAIN, SECRET_KEY, DB_PASSWORD, REDIS_PASSWORD
chmod +x init-prod.sh
./init-prod.sh         # obtains TLS cert, starts production stack
```

### Helm / Kubernetes

Install from the chart source today (public OCI publication to GHCR is planned — #939):

```bash
git clone https://gitlab.com/trueppm/trueppm.git && cd trueppm
helm dependency update packages/helm
helm install trueppm packages/helm \
  --namespace trueppm --create-namespace \
  -f my-values.yaml
```

Once the chart is published to a public OCI registry, the same install will work with
`helm install trueppm oci://ghcr.io/trueppm/charts/trueppm --version <version>`.

See the [full installation guide](https://docs.trueppm.com/getting-started/installation/) for prerequisites and values configuration.

### Scheduling engine only

If you just need the math — CPM, float, and Monte Carlo with no API and no database — the engine is its own Apache 2.0 package. The sixty-second sample is [at the top of this README](#trueppm); this is the fuller surface:

```bash
pip install trueppm-scheduler
```

```python
from datetime import date, timedelta
from trueppm_scheduler import (
    schedule, monte_carlo, Calendar, Project, Task, Dependency, DependencyType,
)

calendar = Calendar()  # Mon–Fri, no holidays (whole-day scheduling)
project = Project(
    id="p-1",
    name="My Project",
    start_date=date(2026, 1, 5),
    tasks=[
        Task(id="t-1", name="Design", duration=timedelta(days=5)),
        Task(
            id="t-2", name="Build", duration=timedelta(days=10),
            optimistic_duration=timedelta(days=7),
            most_likely_duration=timedelta(days=10),
            pessimistic_duration=timedelta(days=20),
        ),
    ],
    dependencies=[
        Dependency(predecessor_id="t-1", successor_id="t-2", dep_type=DependencyType.FS),
    ],
    calendar=calendar,
)

result = schedule(project)
print(next(t for t in result.tasks if t.id == "t-2").early_finish)  # 2026-01-23

# Probabilistic finish dates from the three-point estimates above.
mc = monte_carlo(project, runs=5000, seed=42)
print(mc.p50, mc.p80, mc.p95)
```

All four dependency types (FS/SS/FF/SF), lead/lag on every link, multi-calendar composition, cycle detection with the offending path, and per-task sensitivity ranking. Full reference: [`docs.trueppm.com/features/scheduler`](https://docs.trueppm.com/features/scheduler/).

## Documentation

Full documentation at **[docs.trueppm.com](https://docs.trueppm.com)** (published via GitLab Pages on every release tag, and from `main` on every merge — so the site tracks unreleased work; pages documenting behavior that is not in the latest tag carry a "Ships in 0.X" callout).

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
- **0.4 — the self-hosting PM's beta**: read-only AI-query server (MCP — answers computed by the engine, never guessed), hosted read-only demo + one-command trial, read-only share links, single sign-on via your own identity provider, client-ready PDF, coexistence-first one-way Jira sync, OpenTelemetry observability, published rate-limiting and API-stability contract, time tracking with a weekly timesheet, in-app baseline capture, spreadsheet (CSV/Excel) import — and a large polish, accessibility, and refactoring pass that is the majority of the cycle by volume
- **0.5 — plan & people**: partial resource allocation with a pre-commit over-allocation warning, the hybrid human/AI scheduling first cut (AI agents as schedulable resources, on the same allocation model), MCP plan mode (an agent proposes a change, the engine answers with verdict and impact — nothing commits), timesheet approval and non-project time, baseline change control, installable PWA with a push-notification foundation, first-run onboarding
- **0.6 — open & portable**: native Android app (offline, on-device CPM), the one-time Jira migration import (for the team that has decided to move rather than coexist), import from the top-10 PM tools with preview, AI write surface (MCP) with the scheduling engine as referee — shipping in the same release as its receipts (every agent write attributed in the activity feed) and its containment (per-agent suspend, a global pause, rate ceilings) — plus an agent-governance starter kit in the docs, public API depth, shareable roadmap view
- **0.7 — the product owner & the platform opens up**: editable product-roadmap surface with release-target lanes, release planning, backlog↔schedule reconciliation, a mindmap view of the live plan (drag a branch, see the schedule impact before the drop), change-request approvals for agent proposals (named approver, disposition on the audit chain), and the internal plugin architecture the 0.9 extension SDK graduates
- **0.8 — present & relate**: auto-narrative ("why did the date move" — answered from the engine) with an agent-activity section, reporting suite (PDF, what-if, baseline variance), program web view, cost reports, minimal earned value (SPI/CPI, computed), Team Cohesion technical preview
- **0.9 — GA candidate**: onboarding polish, intuitiveness pass, GA hardening (frozen v1 API, WCAG 2.1 AA accessibility, performance and scale), verifiable audit & evidence export, extension SDK
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
└── docker-compose.prod.yml  # production stack (release images + TLS)
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

Release tags publish Docker images to the **GitLab Container Registry** today. GHCR
mirrors (`ghcr.io/trueppm/{api,web,charts}`) are planned as part of the 0.4 beta
supply-chain work (#939); the release pipeline pushes to GHCR only once optional
`GHCR_USER` / `GHCR_TOKEN` credentials are configured. Until then, pull from the
GitLab registry or build the Helm chart from source.

| Artifact | Where it publishes today |
|----------|--------------------------|
| `trueppm-scheduler` | [PyPI](https://pypi.org/project/trueppm-scheduler/) |
| API image | `registry.gitlab.com/trueppm/trueppm/api` (GitLab Container Registry) |
| Web image | `registry.gitlab.com/trueppm/trueppm/web` (GitLab Container Registry) |
| Helm chart | install from source (`packages/helm`) — public OCI (`oci://ghcr.io/trueppm/charts/trueppm`) planned with GHCR (#939) |

## Maintainer

**Kelly Hair** — [GitLab](https://gitlab.com/kellyhair) · [LinkedIn](https://www.linkedin.com/in/kellyhair) · [kelly@trueppm.com](mailto:kelly@trueppm.com)

## Security

Report vulnerabilities privately via [SECURITY.md](SECURITY.md) — do not open public issues for security bugs.

## License

Apache 2.0 — see [LICENSE](LICENSE).
