# Contributing to TruePPM

Thank you for your interest in TruePPM. This document covers everything you need to submit a contribution.

## Two-repo structure

- **[trueppm/trueppm](https://gitlab.com/trueppm/trueppm)** (this repo) — community edition, Apache 2.0. Everything a PM, PO, or Scrum Master needs to manage a program: scheduling engine, CPM, Monte Carlo, Schedule (Gantt), Board, Sprints, offline sync, real-time collaboration, 5-role RBAC, basic single sign-on (OIDC/OAuth against your own IdP).
- **trueppm/trueppm-enterprise** — proprietary. Portfolio analytics, org identity governance (SAML/SCIM/LDAP directory sync, enforced org-wide SSO), cross-program resource leveling, AI scheduling, approval workflows. Issues for enterprise features go in that tracker, not here.

**The OSS core must never import from the enterprise repo.** Verify with:

```bash
make enterprise-boundary-check   # OK: no trueppm-enterprise imports in packages
```

A plain `grep -r "trueppm_enterprise" packages/` is **not** the check. The tree legitimately names the package in extension-point docstrings and ADR pointers — that grep returns 12 lines across 8 files on a clean tree. The gate matches import syntax and quoted module paths, and ignores comments (#2603). The same check runs in CI as `boundary:imports` on every merge request, and
locally as part of `make pre-push`.

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
| `refactor/` | Code restructuring without behavior change |
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

### Suppressing a check

Sometimes a gate has to be told to stand down — an axe rule on a route with
known ARIA debt, a `@pytest.mark.skip`, an eslint disable. Two kinds exist and
they are written differently:

**Permanent and reasoned** — a verified false positive, a library quirk, a
deliberate trade-off. Explain *why* in prose next to the suppression. It is a
decision, and it needs no expiry.

**Temporary, waiting on tracked work** — mark it, on or near the suppression:

```ts
// The grid holds a role="status" child, which a grid may not have.
// SUPPRESSED-UNTIL(#2618)
disableRules: ['aria-required-children'],
```

`suppressions:check` fails the pipeline once that issue closes with the
suppression still in the tree. This exists because it did not: six axe
exclusions cited a closed #2204, one of them reading "remove this last exclusion
when #2204 lands" — it had landed, and the a11y gate stayed green by hiding
failures nothing tracked (#2603). A suppression's justification expires without
a diff, so only a gate can catch it.

Use the marker only for the second kind. A bare `#NNNN` near a suppression is
not a marker — most such references are explanatory history, and treating them
as expiring debt would make the gate noise.

### Coverage and SonarCloud

SonarCloud does not run tests — it **imports** coverage reports. The report paths
are declared in `sonar-project.properties`. To refresh coverage on the SonarCloud
dashboard, generate the reports and run the scanner:

```bash
make coverage-diff              # generates api/scheduler/web coverage reports
SONAR_TOKEN=xxxxxxxx make sonar # rewrites the web LCOV for the root run, then scans
```

`make sonar` (via `scripts/sonar-scan.sh`) prefixes the web LCOV `SF:` paths with
`packages/web/` so they resolve from the repo root — without it the web report
imports as 0%.

## Changelog

Every MR that changes behavior must include a fragment file in `changelog.d/`:

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
- [ ] Docs updated if user-visible behavior changed
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
