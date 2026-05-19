# Contributing to TruePPM

Thank you for your interest in TruePPM. This document covers everything you need to submit a contribution.

## Two-repo structure

- **[trueppm/trueppm](https://gitlab.com/trueppm/trueppm)** (this repo) — community edition, Apache 2.0. Everything a PM, PO, or Scrum Master needs to manage a program: scheduling engine, CPM, Monte Carlo, Schedule (Gantt), Board, Sprints, offline sync, real-time collaboration, 5-role RBAC.
- **trueppm/trueppm-enterprise** — proprietary. Portfolio analytics, SSO/SAML, cross-program resource leveling, AI scheduling, approval workflows. Issues for enterprise features go in that tracker, not here.

**The OSS core must never import from the enterprise repo.** Verify with:

```bash
grep -r "trueppm_enterprise" packages/  # must return zero results
```

## Before you start

For anything beyond a typo fix or one-line bug fix, open an issue first. Describe what you want to change and why. This avoids wasted effort if the change conflicts with the roadmap or the OSS/Enterprise boundary.

## Setup

```bash
# Prerequisites: Docker, Python 3.12+, Node 20+
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
make setup    # installs git hooks via pre-commit
make doctor   # verifies prerequisites
make up       # starts the full dev stack
```

## Branch and commit conventions

Branch from `main`. Branch names follow `<prefix>/<short-description>`:

| Prefix | Use for |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `chore/` | Build, CI, tooling |
| `refactor/` | Code restructuring without behaviour change |
| `test/` | Tests only |

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(api): add sprint velocity endpoint
fix(web): correct burndown chart zero-state
docs(scheduler): add Monte Carlo sampling assumptions
```

Valid scopes: `scheduler`, `api`, `web`, `helm`, `sync`, `docs`, `ci`.

## Test expectations

All MRs require **three test layers** for any feature that touches those layers:

| Layer | Runner | Location |
|-------|--------|----------|
| API unit/integration | `pytest` | `packages/api/tests/` |
| Web unit | `vitest` | `packages/web/src/**/*.test.ts` |
| End-to-end | `playwright` | `packages/web/e2e/**/*.spec.ts` |

Run tests locally before pushing:

```bash
cd packages/api && pytest -q
cd packages/web && npm test
cd packages/web && npx playwright test e2e/<spec>.spec.ts
```

Run the full pre-push gate before every push:

```bash
make pre-push   # lint + typecheck + migrations-check + schema-check
```

## Changelog

Every MR that changes behaviour must include a fragment file in `changelog.d/`:

- Name: `<issue-or-slug>.<type>.md` (e.g. `434.fixed.md`)
- Valid types: `added`, `changed`, `fixed`, `security`
- Never edit `CHANGELOG.md` directly — fragments are assembled at release time

```bash
echo "Short description of what changed." > changelog.d/my-change.added.md
```

## Merge request checklist

Before opening an MR:

- [ ] `make pre-push` passes (lint, typecheck, migrations, schema)
- [ ] New code has tests at all three layers
- [ ] Changelog fragment in `changelog.d/`
- [ ] Docs updated if user-visible behaviour changed
- [ ] No `STUB:` or `WIP:` markers in shipped code

## DCO — Developer Certificate of Origin

By submitting a contribution you certify that:

1. The contribution was created in whole or in part by you, and you have the right to submit it under the Apache 2.0 license.
2. The contribution is based upon previous work that is covered under an appropriate open-source license, and you have the right to submit that work.

Add a `Signed-off-by` line to each commit: `git commit --signoff`.

## Code of conduct

Participation is governed by the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Be kind.

## Getting help

Open an issue in the [GitLab tracker](https://gitlab.com/trueppm/trueppm/-/issues). The maintainer monitors the tracker and responds within a few business days.
