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
│   ├── mobile/          # React Native + Expo offline-first mobile app
│   ├── mcp/             # trueppm-mcp — read-only MCP server (Apache 2.0)
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
| Web UI | React + TypeScript + Vite | 19 / 5.x / 8 |
| Schedule view | Custom canvas renderer (packages/web/src/features/schedule/engine/) | — |
| E2E tests | Playwright | latest |
| Scheduler | Python (networkx + numpy) | — |
| WASM scheduler | Rust (petgraph) + wasm-pack — gates: `wasm:lint` (clippy `-D warnings`), `wasm:conformance`, `wasm:test`, `wasm:license-check` (cargo-deny `deny.toml`) | 1.85 |
| Auth | django-allauth + simplejwt | — |
| Deploy | Helm 3 on Kubernetes | — |

### Key Design Principles
1. **API-First**: Every feature is a REST or WebSocket endpoint first. Web and mobile are API consumers with no privileged access. If it's not in the API, it doesn't exist. **Boundary (ADR-0599):** this governs *authoritative* state — the real value of any persisted fact, including every scheduled date and forecast, is computed server-side and reached over the API. Three narrow paths run outside the API on purpose: the interactive Gantt drag/keyboard **preview** (recomputes locally for 60fps, never persisted, server reconciles on commit), **offline on-device recompute** (no network → no API; the Rust/WASM engine is kept in CI conformance with the Python engine, future work #1777), and the **engine-as-library** (`trueppm-scheduler`). The invariant that keeps them safe: the server always has the last word — client compute is preview or offline stand-in, never source of truth. Do not read the slogan as forbidding these.
2. **Mobile-First**: Design from mobile constraints upward. Offline works. Touch is primary. Bandwidth is limited.
3. **Apache 2.0 boundary is sacred**: The community edition NEVER imports from `trueppm-enterprise`. The dependency is one-way: enterprise → core. Verify with `make enterprise-boundary-check` (also `boundary:imports` in CI, and part of `make pre-push`). A plain `grep -r "trueppm_enterprise" packages/` is **not** the check — the tree legitimately carries prose that names the package in extension-point docstrings and ADR pointers; the gate matches import syntax and quoted module paths and ignores comments (#2603).

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
- Shared types: `packages/web/src/api/types.ts` is **hand-maintained**, not generated (#2609). The `generate:types` script exists but emits a different (paths/components) shape that breaks the build — do not run it blindly. When the API schema changes, update the affected interfaces by hand and check them against `docs/api/openapi.json`. There is no drift gate (#2633); see the file's own header

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
- **`packages/web/e2e/` is linted and type-checked — a dropped `await` on a Playwright call now fails `web:lint`.** The Playwright tree used to match no eslint config and no tsconfig at all, so ~230 specs were checked by nothing. It is now covered by an `e2e/**/*.ts` block in `packages/web/eslint.config.js` (against `tsconfig.e2e.json`, the same project the typecheck gate uses). The rule that matters most is **`@typescript-eslint/no-floating-promises`**: almost every Playwright call returns a promise, so `route.fulfill(...)` without `await` is not a type error — it is a race that surfaces later as an unreproducible flake. If lint reports it, add the `await` and make the enclosing handler `async`; do not silence it. Three rules are deliberately **off** for this tree only (`no-unsafe-assignment` / `-member-access` / `-argument`) because the `any` they see comes from `Request.postDataJSON()` and `JSON.parse()` on a payload the spec itself built — the config comments explain the trade-off.
- **Static-analysis parity — CodeQL "Code Quality" mirror-scans `main` post-hoc; keep the local gates ahead of it.** GitHub's `security-and-quality` CodeQL suite runs on the GitHub mirror only (it is **not** part of the GitLab pre-merge gate), so its maintainability findings surface *after* merge on `main`. Two rules keep it green at the source; do not remove them: (1) **TS dead initializers** — `let x = init` where `init` is overwritten before any read — are caught by core **`no-useless-assignment`** in `packages/web/eslint.config.js` (`no-unused-vars` misses them because the var *is* read later); (2) Python has **no clean local analog** — ruff/pyflakes' `F841` is function-local and both it and `RUF059` honor the `_`-prefixed/`dummy-variable` throwaway convention that CodeQL ignores, and neither flags unused *module-level* names. So for the Python classes (unused module globals, `_`-prefixed unused test locals, imports used only inside `cast("Name", …)` string annotations) **CodeQL stays the authority — remediate reactively**: delete genuinely dead code, add `__all__` to intentional re-export shims, move type-only imports under `if TYPE_CHECKING:`, and dismiss verified false positives in the Code Quality UI. **Most CodeQL "unused" hits on this codebase are false positives** (cross-module use, `choices=` constants, `cast("…")` forward-refs under `from __future__ import annotations`, and idempotency guards read via an `if _flag: return` at the top of the function) — always grep the whole tree and confirm a symbol is truly unreferenced before deleting it (#2067).
- **`# codeql[rule-id]` / `// codeql[rule-id]` comments suppress nothing — they are greppable human notes.** Roughly thirty of them sit in the tree, and the findings they annotate are all still listed as open on `/security/quality`. GitHub code scanning does not honor inline CodeQL suppression comments, and our CodeQL runs under **default setup** (analysis key `dynamic/github-code-scanning/codeql`; there is no `.github/workflows/codeql.yml`), so there is no `query-filters` config lever either. Keep writing the comments if they help the next reader — but **the only mechanism that actually clears a false positive is Dismiss in the Code Quality UI**, and a dismissal has to be redone if a re-scan reopens the alert. Do not "fix" real code to appease a rule you have already verified is wrong. If a rule becomes a recurring tax, the escalation is migrating to CodeQL **advanced setup** with a `codeql-config.yml` `query-filters` block that excludes it (#2475).
- **`astro build` exits 0 with a page's entire body missing — never treat a green `website:build` as proof the docs rendered.** Starlight's content loader catches a per-page render error, logs `[ERROR] Failed to parse Markdown file …`, drops that page's **whole body**, emits the `index.html` anyway, and the build still succeeds. Three pages shipped as bare navigation chrome (99 characters of body, one `<h2>` instead of eleven) for 19 days on green pipelines (#2797). The trigger was Playwright version drift: `rehype-mermaid` renders ```` ```mermaid ```` fences to inline SVG at build time by driving a headless browser (ADR-0198), the CI image bakes browsers into a **version-stamped path**, and an npm package only ever looks in the path matching **its own** revision — so any mismatch is a hard `Executable doesn't exist`, not a soft degrade. An unrelated astro upgrade regenerated `packages/website/package-lock.json` and floated a `^1.58.2` caret to 1.61.1 under a `v1.58.2-noble` image. Two consequences: (1) **the Playwright version is pinned in four places with no automatic relationship** — `PLAYWRIGHT_BASE_TAG` in `.gitlab-ci.yml`, the `ARG PLAYWRIGHT_BASE` default in `.gitlab/ci-images/integration.Dockerfile`, `@playwright/test` in `packages/web/package.json`, and `playwright` in `packages/website/package.json` — all **exact pins, no carets**, bumped together and regenerated with `npm install --package-lock-only`; `scripts/check-playwright-pins.sh` (job `web:playwright-pins`, also in `make pre-push`) enforces it. (2) **A local `npm run build` does not reproduce this** — a stale `node_modules` still holds the old version and renders fine, because only CI's `npm ci` honors the drifted lockfile; and Astro's content cache means even a deliberate local repro needs `rm -rf .astro node_modules/.astro` or the fences are never re-rendered. `scripts/check-mermaid-rendered.sh` is what makes the failure loud: it asserts every fence reaches `dist/` as a rendered `<svg>` and that the build log carries no `[ERROR]` lines, and it runs in both `website:build` and `pages`.
- **A catch-all `**/api/v1/**` mock does NOT cover the page — mock every endpoint a data-driven page reads, with its real response shape.** Specs use a catch-all `200 {count:0,next,previous,results:[]}` route as a 401-guard safety net (an unmocked request would 401 and trip the session-expired modal). But that net returns a *list* shape for **every** unmocked endpoint, including object-shaped ones (`/programs/:id/rollup/`, `/projects/:id/overview/`, …). A component that does `Object.entries(rollup.kpis)` on that truthy-but-malformed `{count:0,…}` throws, and the **root error boundary replaces the entire app** — which surfaces downstream as a *flaky detached-element / timeout* on some unrelated click, not an obvious "missing mock". When a spec navigates to a page, list the endpoints that page's hooks read and mock each with its real shape; never lean on the catch-all for an object endpoint. Before interacting with chrome on a data-driven route, gate on a "page rendered" signal (a heading/content node that only appears after those reads resolve), not just the control's own `toBeVisible()`. This was the `context-create.spec.ts` flake (#1190): the spec mocked `/programs/:id/` but not `/programs/:id/rollup/`, so `ProgramOverviewPage` crashed intermittently and tore the context-bar button out mid-click.
- **If a spec asserts DOM state AFTER a write, the read endpoint it refetches must echo that write — use `setupTaskStore`, never the stateless default list mock.** `useUpdateTask` patches the cache optimistically in `onMutate` and then **invalidates `['tasks', projectId]` in `onSuccess`**; `setupApiMocks`' `**/api/v1/tasks/**` route is stateless and re-serves the original `opts.tasks`. So the refetch the app's own success handler fires **erases the committed value**, which therefore exists only in the few tens of milliseconds between the optimistic render and the refetch landing (`useScheduleTasks`' 2 s `refetchInterval` closes the same window again). Under CI contention Playwright's poll misses it, and the spec fails nondeterministically on a loaded runner only — green on the branch, red on main. This was `schedule-owner-token.spec.ts` (#2752): 3/15 failures at `--repeat-each=15 --workers=10`, 0/15 at `--workers=2`, 75/75 once the list mock became stateful. **Raising the timeout or `retries` fixes nothing** — after the refetch the state is gone permanently, so a 5 s and a 60 s `toBeVisible` fail identically; it is a window-of-existence problem, not a duration problem. Reproduce this class with `--repeat-each=N --workers=<2–3× cores>`; a default local run will not show it. `setupTaskStore` (`packages/web/e2e/fixtures/task-store.ts`) is the fixture — a live row array the PATCH handler mutates and the GETs serve; pass `applyPatch` when a write field is write-only and reads back under another name (`owners` → `assignments`).
- **Grep `packages/web/e2e/` BEFORE you commit any UI surface change** — the `web:e2e` job is the single most common CI failure because Playwright specs assert on text, menu items, sections, ARIA roles, and keyboard bindings that live in a separate tree from the source. Vitest specs are co-located with components and obvious to update; E2E specs are not. The pattern that fails CI: you modify a menu / cheatsheet / shortcut and update the vitest spec, but never look at `packages/web/e2e/`. Before every commit that touches a user-visible surface, run:
  - `grep -rn "<old text or label>" packages/web/e2e/` — every UI string assertion that needs to move
  - `grep -rn "<menu name / dialog name / aria-label>" packages/web/e2e/` — assertions that locate by role + accessible name
  - `grep -rn "press.*'<old key>'\|press('<old key>')" packages/web/e2e/` — keyboard rebinds
  - For added/removed list items, section counts, menu options: search for the count or sibling-section names in spec assertions (e.g. "all five sections" → fails when you add a sixth)

  Update every matching spec in the **same commit** as the source change and run the affected specs locally: `cd packages/web && npx playwright test e2e/<spec>.spec.ts`. This rule is in addition to the "new or modified specs" rule above — that one targets specs you authored; this one targets specs you indirectly broke.
- **Use `scripts/wt new <issue>` for any new-issue work** when another branch is in flight (uncommitted changes, unpushed commits, or any parallel agent session). The script creates a per-issue git worktree at `../trueppm-wt/<branch-leaf>/` with symlinked `packages/api/.venv` and `packages/web/node_modules` and an `.envrc` that exports `COMPOSE_PROJECT_NAME=trueppm` so `make pre-push` finds the shared Docker stack. This is the default workflow for multi-issue and multi-agent work because it prevents the branch-flip problem (one agent's `git checkout` swapping the working tree under another agent). For single-focus sessions on a clean main, `git checkout -b` is still fine — the pre-push collision gate (below) backstops it, so a raw-git branch that unknowingly duplicates an in-flight issue is caught at push time before it can open a second MR. WIP cap is 10 active worktrees; clean up with `scripts/wt remove <issue>`. Full reference: `docs/getting-started/parallel-worktrees.md`.
  - **Parallel agents may self-serve `wt new`/`wt remove` — the workflow is safe by construction, not by coordination.** Three structural guards make a parallel `wt prune` (or another session's churn) unable to reap your worktree out from under you: (1) `wt new` creates branches with `--no-track` so a fresh, unpushed worktree is never confused with a merged-and-deleted branch (the old false-prune bug); (2) each worktree carries a `.wt-owner` marker and `wt prune` honors a **freshness grace window** (`TRUEPPM_WT_GRACE_MIN`, default 30 min) — younger worktrees are skipped unless `--force`; (3) each worktree's `.envrc` exports a unique `TRUEPPM_TEST_DB=test_trueppm_wt_<slug>`, so parallel `pytest` runs get isolated Postgres test DBs and **no external flock mutex is needed** (honored by `packages/api/src/trueppm_api/settings/dev.py`; source `.envrc` before running pytest so it takes effect). **(4) `git stash` is NOT worktree-scoped — use `scripts/wt stash`.** `refs/stash` lives in the git *common* dir, so every worktree shares one stack: A pushes, B pushes, A pops, and A gets **B's** work — and because `pop` drops what it applies cleanly, B's uncommitted work is gone from the stash and sitting in A's tree, with nothing in either session's output naming it. (A *conflicting* apply keeps the entry; that is the lucky branch of the same bug.) There is no `pre-stash` hook, so nothing can catch it where it happens. `wt stash` / `stash pop|list|apply|drop|show` keep entries under `refs/wt-stash/<worktree>` and never touch `refs/stash`; `wt doctor` warns when `refs/stash` is non-empty while several worktrees are active. Untracked files are not captured (`git stash create` cannot), and `wt stash` says so rather than letting you assume otherwise. For a one-file detour, `cp` aside and back is still simplest (#3110). The `status::wip` GitLab label is a **checked** claim signal, not decoration: `wt new`/`wt claim` set it and refuse an already-claimed issue. Because that in-`wt` guard is bypassed entirely by a plain `git checkout -b feat/<issue>-…`, the **`pre-push-collision-check`** gate (`scripts/check-issue-collision.sh`, wired into `make pre-push` so it runs before the code gates on every push regardless of how the branch was created) re-enforces the claim at the one universal chokepoint: it **blocks the push** when the branch's issue number already has an **open MR from another branch** (the strong, authoritative duplicate signal — override with `TRUEPPM_ALLOW_DUP_MR=1` for legitimate stacked / multi-MR-per-issue work) and **warns** when the issue carries `status::wip` claimed by another worktree that has not opened an MR yet. This is the guard that would have caught the #1985 duplicate (!1352/!1353): the second session's `git checkout -b` bypassed the `wt` lock, and nothing re-checked before it opened a second MR. `wt list` shows issue · age · pushed? per worktree so you can see whose is whose.
- Workflow for every change:
  1. **Parallel work in progress**: `scripts/wt new <issue>` (creates branch + worktree off latest `origin/main` automatically), then `cd ../trueppm-wt/<branch-leaf> && source .envrc`
  2. **Single-focus work on clean main**: `git checkout main && git pull origin main && git checkout -b <prefix>/<short-description>`
  3. Make changes, commit, push branch
  4. Open the MR targeting `main` — the user runs `/mr`, or an agent runs `glab mr create` directly in the `/mr` skill's format (the `/mr`, `/fix-mr`, and `/release` skills are `disable-model-invocation`, so an agent reproduces their behavior rather than invoking them). Then wait for a **green pipeline** and merge.
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
Everything a PM, PO, Scrum Master, or team member needs to run a program successfully: scheduling engine, CPM, Monte Carlo, schedule view, offline sync, real-time collaboration, 5-role RBAC, REST/WS API, time tracking, baselines, Helm chart, MS Project import/export, **program entity** (grouping of related projects for one PM/team), **program backlog** (intake pool for a program), agile/hybrid workflows (sprints, boards, velocity, retros), **basic single sign-on** (self-service OIDC/OAuth login against the self-hoster's own identity provider), **basic high availability** (redundant API/worker tiers, in-cluster HA PostgreSQL and Valkey, logical backup, WAL archiving through the datastore operator).

### Enterprise (trueppm-enterprise) — Proprietary
Everything an organization needs to govern multiple programs: portfolio dashboard and health scores, demand intake, prioritization workspace, **cross-program** resource leveling, resource heat map (cross-portfolio), schedule forensics (narrative), org identity governance (SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO), immutable audit trail, custom roles, approval workflows, integration hub (org-wide, admin-configured, bidirectional Jira/GitLab/ServiceNow connectors), AI scheduling, scenario modeling, portfolio Monte Carlo, multi-tenancy, advanced HA and disaster recovery (cross-region replication, geo failover, active-active, SLA-grade failover targets, managed backup verification).

> **Integration carve-out (ADR-0097):** the *bidirectional, org-wide* Integration Hub is Enterprise. A **user-scoped, one-way, read-only** external task source — a contributor connecting their *own* account (e.g. personal Jira) to mirror their assigned items into "My Work", with no writeback — is **OSS**, registered against the OSS `EXTERNAL_TASK_SOURCES` extension point. The line: org connector + OAuth app + webhook ingest + conflict resolution → Enterprise; personal read-only pull → OSS.

> **Auth carve-out (basic SSO is OSS):** **self-service OIDC/OAuth2 single sign-on** — an admin points TruePPM at their *own* identity provider (Keycloak, Authentik, Authelia, Zitadel, Google, GitHub, GitLab) and users log in through it — is **OSS**. Self-hosters run their own IdP and expect login federation as table stakes; gating it is the "SSO tax" that kills adoption before a prospect feels value. The Enterprise line is **org identity *governance***: SAML 2.0 federation, SCIM provisioning/deprovisioning, LDAP/AD directory sync, enforced org-wide SSO (disable local accounts), and group→role mapping with an auth-event audit trail. The split: **log in via your own IdP → OSS; provision, deprovision, and govern accounts from a directory → Enterprise.**

> **HA carve-out (basic HA is OSS, ruled 2026-09-04, epic #3408):** **single-cluster high availability** — redundant API and worker tiers (HPA, PDB, topology spread), an in-cluster HA PostgreSQL (operator-managed, streaming replication, automatic failover) and a replicated Valkey with Sentinel, logical backup, and WAL archiving to a bucket through the datastore operator — is **OSS**. The chart may *stand up* redundant datastores, not merely *talk to* them: a self-hoster with no managed database must still be able to make the system of record survive a pod loss, and gating that is the same tax as gating SSO. It also matches the precedent (GitLab CE ships Patroni and PgBouncer; Geo is paid). The Enterprise line is **advanced HA and disaster recovery**: cross-region or multi-cluster replication, geo failover and DR runbooks, active-active with leader-elected singletons, SLA-grade failover targets with evidence, managed backup automation with scheduled restore verification and retention evidence, and multi-tenant HA. The split: **survive a pod or node loss inside one cluster → OSS; survive the loss of the cluster or the region, or prove it to an auditor → Enterprise.** WAL archiving is *not* the line — it is a configuration knob on an Apache 2.0 operator, and disabling a checkbox in a third-party CRD we render is the SSO-tax pattern this carve-out exists to prevent. Until the datastore issues in #3408 ship, the docs must keep saying that the chart has no PITR and no in-cluster HA *today*, in future tense for 0.5.

### The boundary: adoption vs. governance
TruePPM's go-to-market is adoption-first (GitLab model). A PM and their team must be fully functional in OSS — if they cannot succeed without Enterprise, the adoption flywheel never starts and Enterprise never sells.

- **OSS** = everything one PM/team/program needs to get work done
- **Enterprise** = governance, compliance, and portfolio coordination that organizations add *on top of* an already-running practice

The classification test: "Would a PM or program manager need this to run their program?" → OSS. "Is this cross-program coordination, org-level policy, or compliance evidence?" → Enterprise.

**`Program` is an OSS entity.** A program is a set of related projects managed by one PM or program manager. Portfolio (multiple programs under PMO governance) is Enterprise.

### OSS / Enterprise boundary rules
- The OSS core must remain fully functional without the enterprise repo — no hard dependencies on enterprise hooks, signals, or settings
- Extension points (settings includes, URL patterns, signal hooks) must remain stable — enterprise code registers against them; changing their shape is a breaking change for enterprise customers
- **Dispatch every extension signal with `dispatch_extension_signal()`** (`trueppm_api.core.extension_signals`), never a bare `Signal.send()`. `send()` propagates a receiver's exception to the sender, so a bug in enterprise code breaks the OSS write path that fired it — the exact inverse of the one-way dependency. Enforced by `make extension-signals-check` and the `api:extension-signals` CI job (#2606). The single exception is a **fail-closed veto**, where a receiver raising is the mechanism rather than a fault (`agent_action_prune_requested`, the legal-hold check on agent-action pruning): keep `send()` and write a `FAIL-CLOSED` comment above the call saying why, which the gate honors
- Verify with: `make enterprise-boundary-check` — zero imports of `trueppm_enterprise` in OSS code. Enforced in CI by `boundary:imports` on every MR and on main. Naming the package in prose is fine; importing it is not

### Issues are part of the boundary
- An issue describing enterprise functionality (cross-program/portfolio coordination, org identity governance — SAML/SCIM/LDAP directory sync, enforced org-wide SSO — audit trail, approval workflows, multi-tenancy, cross-region HA/DR, AI scheduling) must be filed in `trueppm-enterprise` from the start — not in the OSS tracker. **Basic OIDC/OAuth login is OSS** (see the Auth carve-out above) — do not bounce it to enterprise
- Cross-project coordination **within a single program** belongs in OSS — only cross-program and portfolio-level governance belongs in `trueppm-enterprise`
- **The `enterprise` and `portfolio` labels are not valid on any *open* OSS issue — use `enterprise-extension-point` for OSS-side extension-point work.** `boundary:check` fails the pipeline on those two labels unconditionally: it matches the label alone and reads nothing else — not the title, not the body, not the milestone. So there is no way to hold one on an open issue, including a triage issue filed *to ask* whether something is enterprise. That is the trap: labeling the question with its own subject reds `main`, and the red lands on whoever pushes next, in a job log they have no reason to read. OSS-side extension-point work that enterprise registers against (slot registration per ADR-0029, edition-based routing per ADR-0030) carries **`enterprise-extension-point`**, which the gate does not match — see #2064, #2219, #1175. This line previously claimed the opposite, that `enterprise`/`portfolio` were "reserved" for exactly that work; following it as written is what kept `main` red for 6.5 hours on 2026-08-18 (#2977)
- Before opening an OSS issue with cross-program, portfolio, SAML/SCIM/LDAP identity-governance, audit-trail, approval-workflow, or cross-region HA/DR scope, run the `enterprise-check` skill (basic OIDC/OAuth login and single-cluster HA do not need this gate — they are OSS)
- Enforced by CI: `boundary:check` runs on main pushes and on schedule; it fails the pipeline if any open OSS issue carries the `enterprise` or `portfolio` label. See `scripts/check-issue-boundary.sh`

## Migration discipline

Django migrations are cheap to create and cheap to throw away while we are pre-1.0
alpha. The goal is **not** to minimize migration count day-to-day — fighting the
count leads to hand-edited migrations, which are far more dangerous than many clean
ones. The goal is that each migration stays clean and the overall history stays
short enough to be signal. Six rules:

1. **Batch model edits, then run `makemigrations` once per feature.** The biggest
   source of sprawl is re-running `makemigrations` while iterating on a model in a
   single branch (add field → migrate → rename → migrate → add index → migrate =
   three migrations for one change). Finish the model design first, then generate
   one migration. If a branch still ends up with several WIP migrations, squash them
   to one before the MR: `python manage.py squashmigrations <app> <start> <end>`.
2. **Prefer `Meta.indexes` / `Meta.constraints` over `RunSQL`.** Anything declared
   in model `Meta` is regenerated automatically by `makemigrations` and therefore
   survives a squash; raw `RunSQL` lives outside model state and is silently dropped
   when migrations are regenerated. Reach for raw SQL only for what the ORM genuinely
   cannot express (PostgreSQL extensions, ltree GiST indexes, `CREATE INDEX
   CONCURRENTLY`) — and see the non-regenerable-ops list below.
3. **Never import a migration module in a test.** `importlib.import_module(
   "...migrations.0019_backfill_...")` couples the suite to migration *file names*,
   which a squash deletes (this broke five test files in #1286). Assert the *outcome*
   on the model/serializer instead; if a data backfill needs a unit test, test the
   underlying function it calls, not the migration wrapper.
4. **Keep the `api:migration-check` CI gate (`makemigrations --check --dry-run`).**
   It proves the committed migrations fully describe the models — catching a
   hand-edited migration that diverged, a forgotten regenerate after a model change,
   and an unfaithful squash.
5. **Regenerate with the full recipe.** `makemigrations` output is not ruff-clean
   (import order + long `help_text` / `choices` lines). Always follow with
   `ruff check --fix <migrations> && ruff format <migrations>`. `E501` is ignored for
   `*/migrations/*.py` in `pyproject.toml` because a generated long string literal
   cannot be wrapped without hand-editing generated code, which defeats clean
   regeneration.
6. **Squash to a fresh baseline at each minor-version release with `replaces=`.**
   Migrations *should* accumulate between releases — that is their job. At each
   `0.x → 0.(x+1)` boundary, collapse each app's history with Django's
   `squashmigrations`, which generates a `0001_squashed_…` migration carrying a
   `replaces=` list, and put "squash migrations" on the release checklist next to
   changelog assembly. This is the **non-destructive** approach adopted in #1286: the
   original migrations stay on disk and remain applyable, so fresh installs use the
   collapsed migration while existing local/dev/deployed databases upgrade as a
   **no-op** — no drop, no recreate, no data-migration step. Do **not** hand-write a
   regenerated `0001_initial` to replace the history; that path cannot reproduce the
   non-regenerable operations below and would force every existing database to be
   dropped.
7. **Repair the data before you add a constraint to a populated table.**
   `AddConstraint` builds and *validates* its index against every existing row, and
   migrations run on container start — so one violating row is an upgrade
   crash-loop, not a failed deploy you can roll back at leisure (#3068). Precede it
   with a `RunPython` repair, as `projects.0121` and `projects.0148` do. Where
   existing rows provably cannot violate the constraint, say why in a
   `# safe-constraint: <reason>` comment on the operation. `make pre-push` and the
   `api:migration-constraint-safety` CI job enforce one or the other, and recognize
   four shapes without a comment: the model is created in the same migration (empty
   table), the migration declares `replaces=`, the same migration runs
   `AlterUniqueTogether` for that model (a `unique_together` conversion is already
   enforced), or a `RunPython` precedes the constraint.

   Be honest about what that buys: an opt-out comment is a rubber stamp, exactly like
   `--update-baseline` on the docs gate, and it cannot stop a wrong answer. What it
   removes is the **silence** — before it, `api:migration-check` went green on the
   #3068 migration and that green read as evidence about the migration when it was
   evidence about something else entirely. `makemigrations --check` never opens a
   database, so the class had no gate at all.

**Why `replaces=` and not a regenerated `0001_initial`.** `makemigrations` cannot
reproduce operations that live outside model state, so a hand-regenerated initial
migration would silently lose them — which is exactly why the squash keeps the
originals via `replaces=` instead of starting from scratch. The operations that
cannot be regenerated, and therefore depend on the originals being retained:
- `CREATE EXTENSION ltree` and `CREATE EXTENSION pg_trgm` — `RunSQL`, must run
  *before* any `CreateModel` that uses an ltree field or `gin_trgm_ops`;
- `CREATE EXTENSION btree_gist` — `RunSQL`, must run *before* the
  `(project, wbs_path)` `ExclusionConstraint` on `projects_task`, which needs GiST
  support for `=` on the UUID `project` column (`wbs_path`'s own ltree GiST opclass
  already has it);
- the GiST index on `projects_task.wbs_path` — `RunSQL` (powers ltree subtree /
  ancestor queries);
- the composite `(project_id, history_date)` index on `projects_historicaltask` —
  a raw `CREATE INDEX` operation.

Trigram **GIN** indexes are declared in model `Meta` and regenerate automatically;
only the raw `RunSQL` and extension operations rely on the originals being kept.

**A `replaces=` squash does not reset databases.** Because the original migrations
remain applyable, a database whose tables already exist simply records the squashed
migration as applied (Django sees its `replaces=` set is fully applied) and carries
on — there is no `DROP DATABASE`, no recreate, and no data loss. The earlier
destructive delete-and-regenerate approach, which *would* have required every
operator and developer to drop their local DB, was evaluated and **rejected** in
#1286 in favor of `replaces=`.

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
3. Verify new admin-visible behavior (settings, env vars, Helm values, management commands) is reflected in `packages/website/src/content/docs/administration/`
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
- **When `0.X` moves into `## Shipped` (#2824).** `0.X` is promoted when the release **line reaches the maturity that version promises** — for 0.4, the first `beta` tag. **Alpha prereleases on the way to that milestone do not promote it.** This edit is not cosmetic and not a bookkeeping step that follows a tag: it is the *trigger* for `scripts/release.sh` to run `scripts/remove-ships-in-callouts.sh --apply`, which **deletes every `Ships in 0.X` / `Coming in 0.X` callout in the docs tree** — 131 blocks across 78 pages for 0.4, measured 2026-08-30. Promote early and the next release cut silently publishes unshipped features as available, and `check-version-status.sh` *passes*, because it polices the reverse direction (a stale banner on a shipped version). Nothing else in the pipeline sees it. The 0.1/0.2/0.3 precedent teaches the wrong habit here: each tagged `X.Y.0-alpha.1` when its feature set was already complete, so promoting at the alpha was correct all three times. `scripts/check-early-promotion.sh` now refuses an **alpha** cut against an already-promoted version whose callouts are still live (override: `--allow-early-promotion` / `RELEASE_ALLOW_EARLY_PROMOTION=1`, for a version whose promised maturity genuinely is alpha). Beta/rc/stable cuts are deliberately **not** gated — at a legitimate first-beta cut the roadmap *is* promoted and the callouts *are* still present, so gating that state would demand the override on the one cut that matters and turn it into muscle memory.
- **Exceptions**: ADRs under `docs/adr/` are design-decision artifacts — forward-tense statements like "0.X will ship Y" are correct, do not rewrite them. The roadmap page itself is exempt; it is the source.
- **Before publishing**: when you touch a file that mentions a version, grep `packages/website/src/content/docs/` for the same version string and verify every occurrence aligns with the roadmap's Shipped / Underway / Planned classification. The bug class this prevents is the 2026-05-28 "0.2 shipped" regression (issue #807) — banners and feature pages drifted into past-tense for a version that hadn't tagged because no single source of truth bound them together.

This rule applies to every doc edit — there is no "fast path" carve-out. A wrong tense on a version banner is a user-facing accuracy bug, not a stylistic preference.

**A version-anchored phrase is not the only way to mislead — declare the version instead.** The tense rule above only reaches text that names a version. A page can describe an entirely unreleased feature in plain present tense ("Click **Share** to generate a public link"), never mention a version, and read to a self-hoster on the latest release as a description of their install. `scripts/check-version-status.sh` is structurally blind to that, which is how four pages sailed past it on a green pipeline (#2608). So:

- When a page documents behavior that is **not in the latest tag**, set `documentedFor: "0.X"` in its front matter and add a `:::note[Ships in 0.X]` callout saying what the current release does instead. The gate pairs the two against the roadmap and fails if either is missing or if they disagree.
- **When 0.X ships, delete the callout.** The gate then fails in the other direction — a "Ships in 0.4" banner on a page whose `documentedFor` has moved into "## Shipped" is the same misinformation reversed, and it is the failure mode a release actually produces.
- Scope the callout honestly: if only part of the page is unreleased, say which part (see `administration/security.md`, which lists its three unshipped items, and `administration/program-settings.md`, which nests a narrower callout inside a section-level one).
- The key does **not** catch a page that documents an unreleased feature and declares nothing. It converts "did the author choose the right tense", which nothing can check, into "the author named a version once, and the banner is guaranteed to match it".

**Declaring nothing is no longer silent — the declaration-coverage ratchet (#2846).** That last bullet was the residual hole, and it recurred: #807, then #2608 (four pages, 2026-07-30), then #2846 on `features/board.md` and `features/interface.md` seventeen days later. Each time the pages got fixed and the detector did not. So every page under `features/`, `administration/`, `getting-started/`, and — since #2893 — `overview/` must now **either** declare `documentedFor`, **or** have its exact contents hash-recorded in `packages/website/docs-declaration-baseline.txt`. The one exemption is `overview/roadmap.md`: it is the source of truth rather than a page derived from one, it describes Underway and Planned versions in every section by design, and a hash entry would only mean re-baselining on every roadmap edit. Everything else in `overview/` is in — that tree was excluded on "it explains design, not features" reasoning, which was wrong: it holds the gate's own oracle, and pages beside it make concrete product claims a self-hoster reads as a description of their install. Editing a non-declaring page breaks its hash and fails `docs:version-accuracy` until you do one of two things:

- the edit documents behavior **not in the latest tag** → add `documentedFor: "0.X"` plus a `:::note[Ships in 0.X]` callout, which also removes the page from the baseline for good; or
- the edit documents only shipped behavior → `bash scripts/check-version-status.sh --update-baseline`, whose one-line diff is you saying so on the record.

Be honest about what this is: it cannot stop a wrong answer — `--update-baseline` is one command and a rubber stamp gets today's outcome. What it removes is the **silence**; before it, adding four paragraphs of unreleased behavior to `board.md` produced no signal anywhere in the pipeline. The seeded baseline is a **grandfathered snapshot, not a review** — nobody has verified those pages, and it must not be cited as if somebody had. It arms on the next edit to each of them.

**The nav has to say it too — a declaration a reader meets only after clicking is half a signal (#2908).** `documentedFor` + the `Ships in 0.X` callout both live *on the page*. Getting Started is the top of the adoption funnel and six of its eight pages declare 0.4, so an evaluator clicking "Evaluation guide" from a sidebar that says nothing lands on a banner telling them the page is not for their install. Every `getting-started/` page declaring an unshipped version therefore carries `badge: { text: "0.X", variant: "caution" }` on its `packages/website/astro.config.mjs` sidebar entry, and `scripts/check-version-status.sh` pairs the two.

- The pairing runs **both** ways, like the callout check: a missing badge fails, and so does a badge whose version has shipped or whose page declares nothing. **When 0.X ships, the badge comes off with the callout** — the gate reds until it does.
- Scoped to `getting-started/` on purpose. Sixty more pages under `features/` and `administration/` declare 0.4, and badging all 66 is a navigation-density call, not a correctness one. The reverse check runs over every entry regardless, so widening `BADGE_DIRS` can only add work — it can never un-catch a stale badge. The deferral is tracked in #3032, not left implied by the variable's value.

**Do not advertise an API surface a client cannot reach.** Five `program_*` WebSocket events sat in the published taxonomy for months while no `group_add` in the codebase could join a program's channel group — an integrator building against them gets a `4003` and cannot debug their way out. `scripts/check-ws-event-reachability.sh` (CI job `docs:ws-event-reachability`) classifies each event by the **type of the id its `broadcast_board_event()` call site fans out on**, not by its name, and requires an unreachable one to carry a `not deliverable` marker on every taxonomy bullet and table row. It **inverts** when `routing.py` grows the route that makes the event deliverable (#836, 0.8) — the markers then become the reversed claim and must come off. It also asserts every event named in the taxonomy table exists in `FROZEN_WS_EVENT_TYPES`.

### Mandatory skills for docs work
- **`docs-writer`** for any change touching `packages/website/src/content/docs/features/`, `packages/website/src/content/docs/getting-started/`, `packages/website/src/content/docs/architecture/`, or `packages/website/src/content/docs/administration/` — the **published, gated** tree. `docs/` holds ADRs, specs and design records; it is not a second copy of the product docs, and `docs:tree-split` fails if it becomes one (#2928)
- **`api-docs`** for any endpoint, serializer field, or permission rule change

### Mandatory design-stage gates

These run **after `/architect` and before implementation** — not in the pre-MR gate
batch. By pre-MR time the code exists, and both gates produce design changes that would
arrive too late to act on. Each is scoped; outside its scope record `n/a` and do not run
it, or the gate becomes the habitual ceremony the fast-path table exists to strip out.

- **`ai-review`** — for any change that adds or alters a **server-computed value or a
  mutation**. Run paired with `enterprise-check`, whose AI boundary it extends. Not for
  styling, copy, dependency bumps, CI config, or docs-only changes.
- **`threat-model`** — for any feature that **crosses a trust boundary**: a new
  authentication path, a changed authorization boundary, external data ingress, a
  sync-protocol change, or a new OSS↔Enterprise extension point.

Record both in the MR's `## Gates` section under their exact skill names — the ledger
parser matches on them (`.claude/skills/mr/SKILL.md`). `accessibility` is deliberately
**not** a ledger gate: it is a reference rule set, and WCAG findings against a UI diff
are recorded under `ux-review`, which checks WCAG 2.1 AA by definition.

## Available Skills

Run `/skills`, or read the skill roster the harness injects into context — every skill in
`.claude/skills/` is listed there with its own `description:` frontmatter, which is the
single source of truth for when to reach for it. A hand-maintained copy of that roster in
this file can only drift out of date, so there isn't one.

Two skills are **not** in the injected roster, because they are `disable-model-invocation`
and can only be started by the user typing them. Their contract has to live here:

- `/mr` — Open a GitLab MR for the current branch (pre-flight checks, structured description, creates via glab). **User-invoked only** — an agent can't call it through the Skill tool; it reproduces the skill's `glab mr create` format directly instead. `.claude/skills/mr/SKILL.md` is the canonical format for both paths.
- `/fix-mr` — Watch and fix a failing MR pipeline until green. **User-invoked only** — an agent runs the equivalent `glab pipeline` / log-reading loop directly.

The same applies to `/release` and `/mass_merge`.
