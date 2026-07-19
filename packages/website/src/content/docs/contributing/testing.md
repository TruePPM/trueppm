---
title: Testing & quality
description: How TruePPM is tested — the test layers and what each covers, how code coverage is measured across the monorepo, the CI gates that enforce it, and exactly what is (and is not) excluded from the coverage denominator.
---

TruePPM treats tests as part of the change, not a follow-up: every feature or fix
ships its tests and docs in the same merge request, and CI blocks a merge that
regresses a test suite, a type check, or coverage on the changed lines. This page
describes what we test, how we measure it, and — in the interest of an honest
number — what we deliberately exclude from coverage and why.

## Test layers

The scheduling engine is the core of the product, so correctness is tested at the
math level and kept in conformance across its two implementations; the rest of the
stack is tested with a conventional pyramid.

| Layer | Tool | Location | Covers |
| --- | --- | --- | --- |
| **API** | pytest + pytest-django | `packages/api/tests/` | Endpoints, serializers, permission gates (the 5-role RBAC model), object-level access, and edge/error cases against a real PostgreSQL. |
| **Web units** | vitest | `packages/web/src/**/*.test.{ts,tsx}` | Hooks, utility functions, client-side logic, Zustand stores, and component behavior in jsdom. |
| **Web E2E** | Playwright | `packages/web/e2e/**/*.spec.ts` | Golden-path plus one error/empty state for every user-visible flow or API-backed component, against the built app with mocked API/WS. |
| **Scheduler** | pytest | `packages/scheduler/tests/` | Mathematical correctness of the CPM passes, Monte Carlo sampling, float calculations, and calendar-aware lag — the standalone `trueppm-scheduler` library. |
| **WASM scheduler** | Rust + `wasm:conformance` | `packages/wasm-scheduler/` | The Rust/petgraph CPM engine, kept in conformance with the Python library so browser/offline recompute matches server recompute. |

Every feature that touches a layer must add tests at that layer — a new endpoint
needs pytest coverage of permissions/happy-path/errors, a new hook needs a vitest
unit test, and a new user-visible flow needs a Playwright spec, all in the same MR.

### Running the suites

```bash
make test        # pytest + vitest across all packages
make lint        # ruff + eslint (incl. ruff format --check)
make typecheck   # mypy --strict + tsc
make pre-push    # the fast CI gates locally: lint, typecheck, migration-check, schema drift

# Or per package:
cd packages/scheduler && pytest
cd packages/api && pytest
cd packages/web && npm test                          # vitest
cd packages/web && npx playwright test e2e/<spec>     # a single E2E spec
```

## How coverage is measured

Two systems report coverage, and they measure different things:

- **CI per-package gates** enforce a floor on each package as its tests run
  (pytest `--cov-fail-under`, the web coverage floor), and **diff-coverage** gates
  require new/changed lines in a merge request to be covered. These are the gates
  that block a merge.
- **SonarCloud** runs a nightly, full-surface analysis. It does not run tests — it
  *imports* the coverage reports the CI jobs produce and measures them against the
  **entire analyzed codebase**, unioning the web unit (vitest) and E2E (Playwright)
  reports so a file exercised only in E2E is not counted as uncovered.

Because Sonar's denominator is the whole codebase while a per-package tool's
denominator is that package's own source, the two numbers are not directly
comparable — Sonar's full-surface figure is the more conservative one, and the one
we track as the honest measure of coverage.

The nightly Sonar scan is informational (`allow_failure`, never a merge gate); the
per-package floors and diff-coverage are the gates that actually block merges.

## What is excluded from coverage — and why

Coverage measures *product code*. A few categories of files are legitimately not
the subject of coverage, and counting them would distort the number rather than
inform it. These are excluded from the **coverage denominator** in
`sonar-project.properties` (they remain in issue and duplication analysis — only
their coverage is not counted):

| Excluded | Why |
| --- | --- |
| **Test files** — `**/tests/**`, `**/*.test.ts(x)`, `**/conftest.py`, `packages/web/e2e/**` | Test code is the instrument that measures coverage, not the code being measured. The underlying tools already ignore it: `pytest --cov=<package>` never counts `tests/`, and vitest excludes `*.test.*`. Counting a test suite as "0%-covered product code" is a measurement error, not a coverage gap. |
| **Generated code** — `packages/web/src/api/types.ts` | Generated from the OpenAPI schema by `openapi-typescript`. There is no hand-written logic to test. |
| **Django migrations** — `**/migrations/**` | Auto-generated schema operations. Where a data migration carries real logic, that logic lives in a separately-tested function that the migration calls — the migration module itself is never imported by a test. |

What is **not** excluded, on purpose: the custom canvas Gantt renderer
(`packages/web/src/features/schedule/engine/`). It is real product logic — CPM
coordinate math, hit-testing, dependency routing — and its pure helpers are unit
tested rather than hidden from the number. Visual-regression checks guard the
pixels; unit tests guard the logic.

## CI gates

The quality gates that run on every merge request:

- **`lint`** — ruff (Python) and eslint (TypeScript), including `ruff format --check`
  and the design-system token checks.
- **`typecheck`** — `mypy --strict` and `tsc --noEmit`.
- **Per-package coverage floors** — pytest `--cov-fail-under=80` for the scheduler,
  MCP, and API packages; a web coverage floor enforced when the vitest shards are
  stitched.
- **Diff-coverage** — new and changed lines in the MR must be covered
  (`api:diff-coverage`, `web:diff-coverage`), and a check fails the pipeline if a
  file added in the MR is absent from the coverage report entirely.
- **`migration-check`** — `makemigrations --check` proves the committed migrations
  fully describe the models.
- **Schema drift** — the committed OpenAPI schema matches the current code.

Run the fast subset locally before pushing with `make pre-push`; it mirrors the
gates that most commonly fail, in seconds rather than minutes.
