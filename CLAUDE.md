# TruePPM — Project Intelligence

## About
Self-hosted open-core Project, Program, and Portfolio Management (P3M) platform. Built with Django 5.2, Django REST Framework, React 19 + TypeScript, and PostgreSQL. Scheduling-first alternative to MS Project and Planview — CPM is the engine, not a bolt-on; agile boards and sprints are an overlay on the schedule rather than the primary workflow. The scheduling engine ships as a standalone Apache 2.0 Python package on PyPI (`trueppm-scheduler`). Features: CPM (all 4 dependency types, calendar-aware lag, cycle detection), Monte Carlo risk analysis (P50/P80/P95), custom canvas Gantt renderer, Kanban boards and sprint lifecycle (plan/activate/close) layered on the schedule, real-time collaboration via WebSockets, 5-role RBAC per project (Owner/Admin/Scheduler/Member/Viewer), offline sync protocol (WatermelonDB-compatible delta with tombstones), MS Project import/export, time tracking, baselines, basic single sign-on (OIDC/OAuth login against your own IdP), and production-ready Helm 3 chart for Kubernetes. Community edition is Apache 2.0; Enterprise adds portfolio governance, org identity governance (SAML/SCIM/LDAP directory sync, enforced org-wide SSO), cross-program resource leveling, and approval workflows.

- **Company**: TruePPM, Inc. | trueppm.com
- **License**: Community edition is Apache 2.0. Enterprise features are proprietary.
- **Repos**: `trueppm/trueppm-suite` (OSS), `trueppm/trueppm-enterprise` (proprietary)

## Architecture

### Monorepo Structure
```
trueppm-suite/
├── packages/
│   ├── scheduler/       # trueppm-scheduler (Python, pip package, Apache 2.0)
│   ├── wasm-scheduler/  # Rust + petgraph CPM engine, compiled to WASM (wasm-pack)
│   ├── api/             # Django 5.2 REST + Channels backend
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
| API | Django + DRF | 5.2 LTS / 3.15+ |
| Real-time | Django Channels | 4.x |
| Queue | Celery + Valkey (Redis-compatible) | 5.4+ / 8+ |
| Database | PostgreSQL | 16+ |
| Cache | Valkey (Redis-compatible) | 8+ |
| Web UI | React + TypeScript + Vite | 19 / 5.x / 6 |
| Schedule view | Custom canvas renderer (packages/web/src/features/schedule/engine/) | — |
| E2E tests | Playwright | latest |
| Scheduler | Python (networkx + numpy) | — |
| WASM scheduler | Rust (petgraph) + wasm-pack — gates: `wasm:lint` (clippy `-D warnings`), `wasm:conformance`, `wasm:test`, `wasm:license-check` (cargo-deny `deny.toml`) | 1.85 |
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
- Unit tests: vitest (`packages/web/src/**/*.test.ts`)
- E2E tests: Playwright (`packages/web/e2e/**/*.spec.ts`) — run via `web:e2e` CI job
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
- Test coverage by layer — all three apply to any feature that touches that layer:
  - **API** (pytest): new endpoints, serializers, permission gates, edge cases
  - **Web units** (vitest): new hooks, utility functions, client-side logic
  - **E2E** (Playwright, `packages/web/e2e/`): golden path + one error/empty state for every new user-visible flow or API-backed component
- MR descriptions and multi-line commit bodies use heredoc syntax — never inline `\n` literals

## Build & Run

```bash
# First-time setup
make setup    # installs git hooks via pre-commit
make doctor   # verifies all prerequisites

# Development (Docker Compose)
make up       # docker compose up -d
# Web UI: http://localhost:5173
# API:    http://localhost:8000
# PostgreSQL: localhost:5432
# Valkey:     localhost:6379  (Redis-compatible; container is named `valkey`)

# Common tasks (Makefile wraps per-package commands)
make lint         # ruff + eslint across all packages (incl. ruff format --check)
make typecheck    # mypy + tsc across all packages
make test         # pytest + vitest across all packages
make build        # web bundle

# Pre-push gate — run before every `git push`. Mirrors the CI jobs that
# block MR pipelines (lint, typecheck, makemigrations --check, openapi
# schema drift). Catches the failures CI catches, but locally and in
# seconds rather than minutes.
make pre-push     # lint + typecheck + migrations-check + schema-check

# Or run per-package directly:
cd packages/scheduler && pytest     # scheduler
cd packages/api && pytest           # API
cd packages/web && npm test         # web (vitest)
```

## General Conventions

- **Never commit or push directly to `main`** — all changes go through a feature branch and MR, no exceptions (including docs, chores, and hotfixes)
- **Never merge an MR with a failing pipeline** — GitLab enforces `only_allow_merge_if_pipeline_succeeds = true`; do not attempt to work around it. Fix the root cause on the branch and let CI re-run.
- **Always run `make pre-push` before `git push`** — this runs the fast CI gates locally (lint with `ruff format --check`, typecheck, `makemigrations --check`, openapi schema drift). Pre-commit installs a pre-push hook that runs this automatically; if you have not run `make setup`, run `make pre-push` manually. Pushing without it leaks lint/migration/schema failures into CI and burns review cycles. Diff-coverage is deliberately **not** part of `make pre-push` (it was too slow at ~7 minutes per push); CI still enforces the coverage gate, and you can run `make coverage-diff` locally on demand if you want to check before pushing.
- **Run new or modified Playwright specs locally before pushing** — `cd packages/web && npx playwright test e2e/<spec>.spec.ts`. E2E specs cannot be type-checked into correctness: wrong locator roles (`role="switch"` vs `"checkbox"`), strict-mode text collisions, and stateless mocks all pass `tsc` silently and only surface at CI runtime. Running locally catches these in seconds. If the full suite is too slow, run only the affected spec file.
- **A catch-all `**/api/v1/**` mock does NOT cover the page — mock every endpoint a data-driven page reads, with its real response shape.** Specs use a catch-all `200 {count:0,next,previous,results:[]}` route as a 401-guard safety net (an unmocked request would 401 and trip the session-expired modal). But that net returns a *list* shape for **every** unmocked endpoint, including object-shaped ones (`/programs/:id/rollup/`, `/projects/:id/overview/`, …). A component that does `Object.entries(rollup.kpis)` on that truthy-but-malformed `{count:0,…}` throws, and the **root error boundary replaces the entire app** — which surfaces downstream as a *flaky detached-element / timeout* on some unrelated click, not an obvious "missing mock". When a spec navigates to a page, list the endpoints that page's hooks read and mock each with its real shape; never lean on the catch-all for an object endpoint. Before interacting with chrome on a data-driven route, gate on a "page rendered" signal (a heading/content node that only appears after those reads resolve), not just the control's own `toBeVisible()`. This was the `context-create.spec.ts` flake (#1190): the spec mocked `/programs/:id/` but not `/programs/:id/rollup/`, so `ProgramOverviewPage` crashed intermittently and tore the context-bar button out mid-click.
- **Grep `packages/web/e2e/` BEFORE you commit any UI surface change** — the `web:e2e` job is the single most common CI failure because Playwright specs assert on text, menu items, sections, ARIA roles, and keyboard bindings that live in a separate tree from the source. Vitest specs are co-located with components and obvious to update; E2E specs are not. The pattern that fails CI: you modify a menu / cheatsheet / shortcut and update the vitest spec, but never look at `packages/web/e2e/`. Before every commit that touches a user-visible surface, run:
  - `grep -rn "<old text or label>" packages/web/e2e/` — every UI string assertion that needs to move
  - `grep -rn "<menu name / dialog name / aria-label>" packages/web/e2e/` — assertions that locate by role + accessible name
  - `grep -rn "press.*'<old key>'\|press('<old key>')" packages/web/e2e/` — keyboard rebinds
  - For added/removed list items, section counts, menu options: search for the count or sibling-section names in spec assertions (e.g. "all five sections" → fails when you add a sixth)

  Update every matching spec in the **same commit** as the source change and run the affected specs locally: `cd packages/web && npx playwright test e2e/<spec>.spec.ts`. This rule is in addition to the "new or modified specs" rule above — that one targets specs you authored; this one targets specs you indirectly broke.
- **Use `scripts/wt new <issue>` for any new-issue work** when another branch is in flight (uncommitted changes, unpushed commits, or any parallel agent session). The script creates a per-issue git worktree at `../trueppm-wt/<branch-leaf>/` with symlinked `packages/api/.venv` and `packages/web/node_modules` and an `.envrc` that exports `COMPOSE_PROJECT_NAME=trueppm` so `make pre-push` finds the shared Docker stack. This is the default workflow for multi-issue and multi-agent work because it prevents the branch-flip problem (one agent's `git checkout` swapping the working tree under another agent). For single-focus sessions on a clean main, `git checkout -b` is still fine. WIP cap is 5 active worktrees; clean up with `scripts/wt remove <issue>`. Full reference: `docs/getting-started/parallel-worktrees.md`.
- Workflow for every change:
  1. **Parallel work in progress**: `scripts/wt new <issue>` (creates branch + worktree off latest `origin/main` automatically), then `cd ../trueppm-wt/<branch-leaf> && source .envrc`
  2. **Single-focus work on clean main**: `git checkout main && git pull origin main && git checkout -b <prefix>/<short-description>`
  3. Make changes, commit, push branch
  4. Open MR targeting `main`, wait for a **green pipeline**, then merge
  5. After merge: in the main checkout, `scripts/wt remove <issue>` if you used a worktree
- Release commits also go through branches and MRs — `scripts/release.sh` handles this automatically
- **Changelog entries use fragment files** — create `changelog.d/<slug>.<type>.md` instead of editing `CHANGELOG.md` directly. Valid types: `added`, `changed`, `fixed`, `security`. Fragments are assembled at release time by `scripts/assemble-changelog.sh`. See `changelog.d/README.md` for the naming convention. **Never edit `CHANGELOG.md` directly** — the CI `changelog:check` job looks for fragment files and will block the pipeline if none are present.
- **Every new or modified feature must include test cases and documentation updates in the same MR** — do not ship a feature without both
- Use **US English** in all code, comments, documentation, commit messages, MR descriptions, and UI copy (e.g. "color" not "colour", "canceled" not "cancelled")
- For complex business logic (model methods, serializer behaviour, transaction sequences, permission checks), add a docstring or inline comment explaining **why** — the intent or constraint, not what the code does
- **No `STUB:` or `WIP:` markers in shipped code** — these never merge. For tracked follow-up work use `TODO(#NNN)` linked to an open issue; the CI `lint:todo-grep` job fails on `STUB:`/`WIP:` and on `TODO(#NNN)` references that point at closed issues. Bare `TODO` (no issue reference) is warning-only.
- Follow **semantic versioning** for all releases

## Two-Repo Rule

**Before writing any code, determine if it belongs in the OSS repo or the Enterprise repo.**

### OSS (trueppm-suite) — Apache 2.0
Everything a PM, PO, Scrum Master, or team member needs to run a program successfully: scheduling engine, CPM, Monte Carlo, schedule view, offline sync, real-time collaboration, 5-role RBAC, REST/WS API, time tracking, baselines, Helm chart, MS Project import/export, **program entity** (grouping of related projects for one PM/team), **program backlog** (intake pool for a program), agile/hybrid workflows (sprints, boards, velocity, retros), **basic single sign-on** (self-service OIDC/OAuth login against the self-hoster's own identity provider).

### Enterprise (trueppm-enterprise) — Proprietary
Everything an organization needs to govern multiple programs: portfolio dashboard and health scores, demand intake, prioritization workspace, **cross-program** resource leveling, resource heat map (cross-portfolio), schedule forensics (narrative), org identity governance (SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO), immutable audit trail, custom roles, approval workflows, integration hub (org-wide, admin-configured, bidirectional Jira/GitLab/ServiceNow connectors), AI scheduling, scenario modeling, portfolio Monte Carlo, multi-tenancy, HA deployment.

> **Integration carve-out (ADR-0097):** the *bidirectional, org-wide* Integration Hub is Enterprise. A **user-scoped, one-way, read-only** external task source — a contributor connecting their *own* account (e.g. personal Jira) to mirror their assigned items into "My Work", with no writeback — is **OSS**, registered against the OSS `EXTERNAL_TASK_SOURCES` extension point. The line: org connector + OAuth app + webhook ingest + conflict resolution → Enterprise; personal read-only pull → OSS.

> **Auth carve-out (basic SSO is OSS):** **self-service OIDC/OAuth2 single sign-on** — an admin points TruePPM at their *own* identity provider (Keycloak, Authentik, Authelia, Zitadel, Google, GitHub, GitLab) and users log in through it — is **OSS**. Self-hosters run their own IdP and expect login federation as table stakes; gating it is the "SSO tax" that kills adoption before a prospect feels value. The Enterprise line is **org identity *governance***: SAML 2.0 federation, SCIM provisioning/deprovisioning, LDAP/AD directory sync, enforced org-wide SSO (disable local accounts), and group→role mapping with an auth-event audit trail. The split: **log in via your own IdP → OSS; provision, deprovision, and govern accounts from a directory → Enterprise.**

### The boundary: adoption vs. governance
TruePPM's go-to-market is adoption-first (GitLab model). A PM and their team must be fully functional in OSS — if they cannot succeed without Enterprise, the adoption flywheel never starts and Enterprise never sells.

- **OSS** = everything one PM/team/program needs to get work done
- **Enterprise** = governance, compliance, and portfolio coordination that organizations add *on top of* an already-running practice

The classification test: "Would a PM or program manager need this to run their program?" → OSS. "Is this cross-program coordination, org-level policy, or compliance evidence?" → Enterprise.

**`Program` is an OSS entity.** A program is a set of related projects managed by one PM or program manager. Portfolio (multiple programs under PMO governance) is Enterprise.

### OSS / Enterprise boundary rules
- The OSS core must remain fully functional without the enterprise repo — no hard dependencies on enterprise hooks, signals, or settings
- Extension points (settings includes, URL patterns, signal hooks) must remain stable — enterprise code registers against them; changing their shape is a breaking change for enterprise customers
- Verify with: `grep -r "trueppm_enterprise" packages/` — must return zero results in OSS code

### Issues are part of the boundary
- An issue describing enterprise functionality (cross-program/portfolio coordination, org identity governance — SAML/SCIM/LDAP directory sync, enforced org-wide SSO — audit trail, approval workflows, multi-tenancy, AI scheduling) must be filed in `trueppm-enterprise` from the start — not in the OSS tracker. **Basic OIDC/OAuth login is OSS** (see the Auth carve-out above) — do not bounce it to enterprise
- Cross-project coordination **within a single program** belongs in OSS — only cross-program and portfolio-level governance belongs in `trueppm-enterprise`
- The OSS `enterprise` and `portfolio` labels are reserved for **OSS-side extension-point work** that enterprise registers against (slot registration per ADR-0029, edition-based routing per ADR-0030) — not for enterprise features themselves
- Before opening an OSS issue with cross-program, portfolio, SAML/SCIM/LDAP identity-governance, audit-trail, or approval-workflow scope, run the `enterprise-check` agent (basic OIDC/OAuth login does not need this gate — it is OSS)
- Enforced by CI: `boundary:check` runs on main pushes and on schedule; it fails the pipeline if any open OSS issue carries the `enterprise` or `portfolio` label. See `scripts/check-issue-boundary.sh`

## Documentation Discipline

### Code documentation

**Complex business logic must have a docstring or inline comment explaining *why*:**
- Model methods with non-trivial invariants (e.g. `server_version` bumps, summary task rollups, WBS reparenting rules)
- Serializer `create`/`update`/`validate_*` methods that enforce permission boundaries or transactional sequencing
- Permission classes and RBAC checks (the *why* behind the role matrix decision)
- Transaction sequences using `transaction.on_commit()` / outbox dispatch
- WebSocket broadcast points (what triggers, what consumers expect)
- Scheduling engine: CPM pass direction, Monte Carlo sampling assumptions, float calculations
- Frontend: non-obvious Zustand store invariants, TanStack Query cache keys, optimistic update rollback logic

**Public API surface must have Google-style docstrings:**
- Every exported function/class in `packages/scheduler` (it's a pip package)
- Every DRF ViewSet and Serializer class in `packages/api`
- Every exported hook and utility in `packages/web/src/hooks` and `packages/web/src/lib`

**Do NOT add:**
- Comments that narrate *what* the code does when the identifiers already say it
- References to issues, tasks, or callers ("used by X", "added for #123") — these belong in commit messages
- Multi-paragraph docstrings on trivial CRUD views
- `// removed` / `# removed` tombstones

### OpenAPI schema regeneration

**Always merge `origin/main` before regenerating `docs/api/openapi.json`.**

The `api:schema-drift` CI check only verifies self-consistency (committed schema
matches current branch code). It does not protect against a branch that is behind
main silently dropping endpoints. Without a merge first, regenerating will produce
a schema that is missing any paths or schemas added to main after the branch was cut,
and the CI check will still pass — the regression only surfaces at merge time.

Correct sequence:
```bash
git merge origin/main        # bring the branch up to date first
scripts/export-openapi.sh    # regenerate from the fully-merged codebase
git add docs/api/openapi.json && git commit
```

A `pre-commit` hook (`openapi-schema`) regenerates `docs/api/openapi.json`
automatically and re-stages it whenever a commit touches `packages/api/src/`, so a
forgotten regenerate after a serializer or `@action` change can't slip past local
review and surface only at merge (#642).

**Worktree gotcha (shared venv).** `scripts/wt new` symlinks `packages/api/.venv`
back to the main checkout, and the venv's editable install resolves `trueppm_api`
from whichever tree first ran `pip install -e` — the main checkout, not the
worktree. A naive `spectacular` run from a worktree therefore regenerates *main's*
schema into the worktree. `scripts/export-openapi.sh` guards against this by forcing
`PYTHONPATH` to its own checkout's `packages/api/src`, so both the manual command
and the pre-commit hook generate from the code you're actually committing. You no
longer need to set `PYTHONPATH` by hand when running it from a worktree.

### Before marking any feature complete

1. Grep changed files for new public functions/classes missing docstrings
2. Verify new user-visible behavior is reflected in `docs/features/` or `docs/getting-started/`
3. Verify new admin-visible behavior (settings, env vars, Helm values, management commands) is reflected in `docs/administration/`
4. Verify new or modified endpoints are reflected in `docs/api/`
5. Update any screenshots in `docs/` invalidated by UI changes — stale screenshots block the MR
6. Verify all three test layers are covered: pytest (API), vitest (web units), Playwright E2E (`packages/web/e2e/`)
   - New UI flow or API-backed component → Playwright spec required in the same MR
   - New API endpoint → pytest covering permissions, happy path, and key error cases
   - New hook or utility function → vitest unit tests

### Every MR that adds user-visible behavior must include a docs diff in the same MR — not a follow-up issue.

### Version-status tense — past/present-tense version claims must reference shipped versions only

When writing or editing any file under `packages/website/src/content/docs/` (and `README.md`), a phrase that anchors behavior to a TruePPM version — "shipped in 0.X", "added in 0.X", "In 0.X the Y", "0.X introduced Z" — may use past or present tense **only if 0.X is at or below the latest shipped tag**. For unshipped versions (anything still under "Underway" or "Planned" on the roadmap page), use **future tense**: "ships in 0.X", "lands in 0.X", "planned for 0.X", "coming in 0.X".

- **Single source of truth**: `packages/website/src/content/docs/overview/roadmap.md`. Every other doc derives its tense from what that page says. If the roadmap says "Underway", every other reference must be future-tense.
- **Exceptions**: ADRs under `docs/adr/` are design-decision artifacts — forward-tense statements like "0.X will ship Y" are correct, do not rewrite them. The roadmap page itself is exempt; it is the source.
- **Before publishing**: when you touch a file that mentions a version, grep `packages/website/src/content/docs/` for the same version string and verify every occurrence aligns with the roadmap's Shipped / Underway / Planned classification. The bug class this prevents is the 2026-05-28 "0.2 shipped" regression (issue #807) — banners and feature pages drifted into past-tense for a version that hadn't tagged because no single source of truth bound them together.

This rule applies to every doc edit — there is no "fast path" carve-out. A wrong tense on a version banner is a user-facing accuracy bug, not a stylistic preference.

### Mandatory agents for docs work
- **`docs-writer`** for any change touching `docs/features/`, `docs/getting-started/`, `docs/architecture/`, or `docs/administration/`
- **`api-docs`** for any endpoint, serializer field, or permission rule change

## Available Skills
Run `/skills` to see all available skills. Key ones:
- `/architect` — System design decisions with ADR output
- `/ai-review` — AI-readiness design gate: verifies new/changed features keep values server-side (API-first/MCP-reachable), explainable, write-safe, and on the correct OSS team-AI vs Enterprise AI-governance side. Runs after `/architect`, paired with `/enterprise-check`
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
- `/mr` — Open a GitLab MR for the current branch (pre-flight checks, structured description, creates via glab)
- `/fix-mr` — Watch and fix a failing MR pipeline until green
- `/scheduler-engine` — CPM/Monte Carlo algorithm work
- `/test-scaffold` — Scaffold the three-layer test pattern (pytest / vitest / Playwright) for a new feature
- `/threat-model` — STRIDE threat model at architecture stage; pairs with `/architect` on auth, sync, or boundary-crossing features
- `/mobile-design` — UI/UX design for the React Native mobile app (offline-first, touch-primary)
- `/mobile-review` — Review React Native code against mobile-specific requirements (touch targets, offline, platform conventions)
