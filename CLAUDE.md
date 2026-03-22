# TruePPM — Project Intelligence

## About
TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform.
- **Company**: TruePPM, Inc. | trueppm.com
- **License**: Community edition is Apache 2.0. Enterprise features are proprietary.
- **Repos**: `trueppm/trueppm-suite` (OSS), `trueppm/trueppm-enterprise` (proprietary)

## Architecture

### Monorepo Structure
```
trueppm-suite/
├── packages/
│   ├── scheduler/       # trueppm-scheduler (Python, pip package, Apache 2.0)
│   ├── api/             # Django 5.1 REST + Channels backend
│   ├── web/             # React 19 + TypeScript + Vite frontend
│   ├── helm/            # Helm 3 chart for Kubernetes deployment
│   └── website/         # Docusaurus documentation site
├── docs/                # ADRs (source of record; mirrored into website)
├── .claude/             # Claude Code skills and commands
└── CLAUDE.md            # This file
```

### Tech Stack (do not deviate without explicit approval)
| Layer | Technology | Version |
|-------|-----------|---------|
| API | Django + DRF | 5.1+ / 3.15+ |
| Real-time | Django Channels | 4.x |
| Queue | Celery + Redis | 5.4+ / 7+ |
| Database | PostgreSQL | 16+ |
| Cache | Redis | 7+ |
| Web UI | React + TypeScript + Vite | 19 / 5.x / 6 |
| Gantt | SVAR React Gantt (MIT) | latest |
| Scheduler | Python (networkx + numpy) | — |
| Auth | django-allauth + simplejwt | — |
| Deploy | Helm 3 on Kubernetes | — |

### Key Design Principles
1. **API-First**: Every feature is a REST or WebSocket endpoint first. Web and mobile are API consumers with no privileged access. If it's not in the API, it doesn't exist.
2. **Mobile-First**: Design from mobile constraints upward. Offline works. Touch is primary. Bandwidth is limited.
3. **Apache 2.0 boundary is sacred**: The community edition NEVER imports from `trueppm-enterprise`. The dependency is one-way: enterprise → core. Run `grep -r "trueppm_enterprise" packages/` to verify — it must return zero results in OSS code.

## Code Conventions

### Python (scheduler, packages/api)
- Python 3.12+
- Formatter: ruff format
- Linter: ruff check
- Type checker: mypy --strict
- Tests: pytest with pytest-django for API, plain pytest for scheduler
- Imports: isort compatible (ruff handles this)
- Docstrings: Google style
- All models use UUID primary keys
- All synced models include `server_version = models.BigIntegerField()`
- Django apps: one app per domain (projects, resources, scheduling, sync, auth)

### TypeScript (packages/web)
- Strict mode enabled
- Formatter: prettier
- Linter: eslint with typescript-eslint
- Tests: vitest
- Components: functional only, no class components
- State: Zustand for client state, TanStack Query for server state
- Styling: Tailwind CSS with Design System v1.0 tokens
- No `any` types. Use `unknown` and narrow.
- Shared types: generate from OpenAPI schema (packages/api → packages/web/src/api/types.ts)

### Git
- Branch naming: `feat/`, `fix/`, `docs/`, `chore/` prefix + short description (e.g. `feat/cpm-engine`, `fix/sync-conflict`)
- Commit format: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `perf:`, `ci:`)
- Scopes: `scheduler`, `api`, `web`, `helm`, `sync`, `docs`, `ci`
- MR template: description, testing done, screenshots if UI, issue link
- All MRs require: passing CI, no type errors, no lint errors, test coverage ≥ 80%
- MR descriptions and multi-line commit bodies use heredoc syntax — never inline `\n` literals

## Build & Run

```bash
# Development (Docker Compose)
docker compose up -d
# Web UI: http://localhost:5173
# API:    http://localhost:8000
# PostgreSQL: localhost:5432
# Redis:      localhost:6379

# Run tests
cd packages/scheduler && pytest     # scheduler
cd packages/api && pytest           # API
cd packages/web && npm test         # web (vitest)

# Lint everything
cd packages/scheduler && ruff check src/ tests/  # scheduler
cd packages/api && ruff check src/               # API
cd packages/web && npm run lint                  # web (eslint)

# Type check
cd packages/scheduler && mypy
cd packages/api && mypy src/trueppm_api
cd packages/web && npm run typecheck
```

## General Conventions

- **Never commit or push directly to `main`** — all changes go through a feature branch and MR, no exceptions (including docs, chores, and hotfixes)
- **Never merge an MR with a failing pipeline** — GitLab enforces `only_allow_merge_if_pipeline_succeeds = true`; do not attempt to work around it. Fix the root cause on the branch and let CI re-run.
- Workflow for every change:
  1. `git checkout main && git pull origin main`
  2. `git checkout -b <prefix>/<short-description>`
  3. Make changes, commit, push branch
  4. Open MR targeting `main`, wait for a **green pipeline**, then merge
- Release commits also go through branches and MRs — `scripts/release.sh` handles this automatically
- Always update `CHANGELOG.md` `[Unreleased]` section on any branch before merging. Append to the existing `### Added` / `### Changed` / `### Fixed` block — never create duplicate headings in the same release block
- **Every new or modified feature must include test cases and documentation updates in the same MR** — do not ship a feature without both
- Use **US English** in all code, comments, documentation, commit messages, MR descriptions, and UI copy (e.g. "color" not "colour", "canceled" not "cancelled")
- For complex business logic (model methods, serializer behaviour, transaction sequences, permission checks), add a docstring or inline comment explaining **why** — the intent or constraint, not what the code does
- Follow **semantic versioning** for all releases

## Two-Repo Rule

**Before writing any code, determine if it belongs in the OSS repo or the Enterprise repo.**

### OSS (trueppm-suite) — Apache 2.0
Everything in the community edition: scheduling engine, CPM, Monte Carlo, Gantt UI, offline sync, real-time collaboration, 5-role RBAC, REST/WS API, time tracking, baselines, Helm chart, MS Project import/export.

### Enterprise (trueppm-enterprise) — Proprietary
Portfolio dashboard, health scores, demand intake, prioritization workspace, cross-project dependencies, resource leveling (cross-project), CCPM, resource heat map (cross-portfolio), schedule forensics (narrative), SSO/SAML/OIDC, LDAP sync, immutable audit trail, custom roles, approval workflows, integration hub (Jira/GitLab/ServiceNow connectors), AI scheduling, scenario modeling, portfolio Monte Carlo, multi-tenancy, HA deployment.

### When in doubt
Ask: "Would an individual PM or small team need this?" If yes → OSS. "Does this require coordinating across multiple projects, teams, or an organization?" If yes → Enterprise.

### OSS / Enterprise boundary rules
- The OSS core must remain fully functional without the enterprise repo — no hard dependencies on enterprise hooks, signals, or settings
- Extension points (settings includes, URL patterns, signal hooks) must remain stable — enterprise code registers against them; changing their shape is a breaking change for enterprise customers
- Verify with: `grep -r "trueppm_enterprise" packages/` — must return zero results in OSS code

## Available Skills
Run `/skills` to see all available skills. Key ones:
- `/architect` — System design decisions with ADR output
- `/security-review` — Security audit of code or design
- `/brand` — Design system reference: colors, typography, spacing, WCAG compliance
- `/ux-design` — UI/UX design for new features
- `/ux-review` — Review existing UI for usability issues
- `/voice-of-customer` — Persona-based feedback on features
- `/api-design` — Design REST/WS API endpoints
- `/code-review` — Code review with TruePPM conventions
- `/test-strategy` — Test plan for a feature
- `/data-model` — Django model design with migration plan
- `/devops` — Kubernetes, Helm, CI/CD, infrastructure
- `/performance` — Performance audit and optimization
- `/accessibility` — WCAG compliance review
- `/docs-writer` — Documentation generation
- `/git-workflow` — Branch, commit, PR management
- `/fix-mr` — Watch and fix a failing MR pipeline until green
- `/scheduler-engine` — CPM/Monte Carlo algorithm work
