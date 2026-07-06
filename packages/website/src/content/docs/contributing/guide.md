---
title: Contributing
description: How to contribute to TruePPM — branching, commits, testing, and the changelog.
---

TruePPM is in its early days and contributions are welcome. The project uses GitLab for issue tracking and merge requests.

## Getting set up

```bash
git clone git@gitlab.com:trueppm/trueppm.git
cd trueppm
make setup    # installs git hooks via pre-commit
make doctor   # verifies all prerequisites
```

See [Installation](/getting-started/installation/) for Docker Compose setup.

## Frontend environment variables

The web app reads build-time settings from `packages/web/.env` (gitignored) — copy
`packages/web/.env.example` and adjust. Vite only exposes variables prefixed with
`VITE_`, and a change takes effect only after restarting the dev server.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_BASE_URL` | unset (dev proxies to `localhost:8000`) | Deployed API base URL for production builds |
| `VITE_FEATURE_FLAGS` | unset | JSON build-time defaults for runtime feature flags |
| `VITE_REACT_QUERY_DEVTOOLS` | off | Set to `true` to show the React Query devtools panel in dev builds |

The React Query devtools panel is **off by default** so it never occupies screen
real estate during normal development. To debug query-cache state, set
`VITE_REACT_QUERY_DEVTOOLS=true` in `packages/web/.env` and restart Vite. It is
gated on dev builds, so it is never present in a production bundle regardless of
this value.

## Branching

Branch from `main` with a conventional prefix:

```bash
git checkout main && git pull origin main
git checkout -b feat/my-feature    # or fix/, docs/, chore/, test/, refactor/
```

Never commit or push directly to `main` — all changes go through a feature branch and merge request.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(web): add board/kanban view
fix(api): prevent duplicate membership creation
docs(scheduler): add Monte Carlo CLI examples
test(api): add permission tests for task deletion
chore(ci): upgrade Node to 22 in CI image
```

Scopes: `scheduler`, `api`, `web`, `helm`, `sync`, `docs`, `ci`.

## Changelog

Every MR that touches source code must include a changelog fragment in `changelog.d/`:

```bash
# Naming: <slug>.<type>.md
# Types: added, changed, fixed, security
echo "Add board/kanban view with drag-and-drop" > changelog.d/kanban-view.added.md
```

The CI `changelog:check` job blocks the pipeline if the fragment is missing. Fragments are assembled automatically at release time — **never edit `CHANGELOG.md` directly**.

Exempt: CI config, dependency bumps, test-only changes, docs-only changes.

## Testing

```bash
make test     # runs all packages
# Or per-package:
cd packages/scheduler && pytest
cd packages/api && pytest
cd packages/web && npm test
```

- **Scheduler:** pytest, coverage >= 80%
- **API:** pytest with testcontainers PostgreSQL, coverage >= 80%
- **Web:** vitest, coverage >= 75%

The API suite bans real outbound network sockets: a test that reaches the live
network (usually a misdirected mock) fails fast with a `SocketConnectBlockedError`
instead of hanging on a connect timeout and flaking. Only the configured database
and Redis hosts are allowed. A test that genuinely needs the network must opt out
explicitly with `@pytest.mark.enable_socket` — keeping the exception visible and
reviewable.

All MRs require a green pipeline before merge.

Run `make pre-push` before every `git push` — it mirrors the blocking CI gates (lint, typecheck, migrations-check, schema-check).

## Code style

| Package | Formatter | Linter | Type checker |
|---------|-----------|--------|-------------|
| Scheduler | ruff format | ruff check | mypy |
| API | ruff format | ruff check | mypy --strict |
| Web | prettier | eslint | tsc --noEmit |

```bash
make lint       # runs all linters
make typecheck  # runs all type checkers
```

## Merge requests

1. Push your branch and open an MR targeting `main`
2. Wait for a green pipeline
3. Include: description, testing done, screenshots (if UI), issue link
4. Don't merge with a failing pipeline — fix the root cause on the branch

## OSS / Enterprise boundary

Before writing code for a new feature, determine if it belongs in the community or enterprise repo:

- **Community (this repo):** everything a PM or program team needs to run a program (including multi-project programs)
- **Enterprise (separate repo):** cross-program/portfolio governance, compliance, and org-level policy

The community edition must never import from `trueppm_enterprise`. Verify with:

```bash
grep -r "trueppm_enterprise" packages/
# Must return zero results
```
