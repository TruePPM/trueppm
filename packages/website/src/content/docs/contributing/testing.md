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
| **WASM scheduler** | Rust (`wasm:test`) + `wasm:conformance` | `packages/wasm-scheduler/` | The Rust/petgraph CPM engine, kept in conformance with the Python library so browser/offline recompute matches server recompute. Both engines assert against one shared oracle — the `fixtures/expected/` snapshots — from their own side: Rust in `wasm:test`, Python in `wasm:conformance`. |

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
| **Test doubles** — `packages/web/src/features/schedule/engine/GanttEngineStub.ts` | A hand-written stand-in for the canvas engine, used only by component tests. Vitest already leaves it out of its own map; Sonar now agrees. |
| **Repository tooling** — `scripts/**`, `packages/*/scripts/**`, `packages/api/perf/**`, `packages/website/**` | CI gate scripts, seed builders, release helpers, the capacity benchmark harness and the docs-site configuration. None of it ships in an image, wheel or bundle, and no test runner instruments it: `pytest --cov` is scoped to each package's `src/`, and vitest to the module graph under `packages/web/src`. The shell gates *are* tested (`scripts/tests/*.test.sh`) — bash simply produces no coverage report to import. Counting these trees as 0%-covered product code was the same measurement error as counting the test suites. |

What is **not** excluded, on purpose: the custom canvas Gantt renderer
(`packages/web/src/features/schedule/engine/`). It is real product logic — CPM
coordinate math, hit-testing, dependency routing — and its pure helpers are unit
tested rather than hidden from the number. Visual-regression checks guard the
pixels; unit tests guard the logic.

## Beyond coverage — does an assertion actually catch a bug?

Coverage answers "did a test *execute* this line?" It does not answer "would a
test *fail* if this line were wrong?" A suite can run every line and still assert
almost nothing. Three techniques close that gap, strongest signal on the
scheduler because it is the core IP:

- **Property-based testing** (Hypothesis) generates thousands of inputs and checks
  invariants that must always hold — a schedule never starts a task before its
  predecessor finishes, float is never negative — rather than a handful of
  hand-picked examples. Runs as a deterministic gate on every scheduler MR and,
  under a large stochastic budget, nightly via `scheduler:fuzz-deep`.
- **Contract fuzzing** (Schemathesis) drives every documented API operation with
  generated inputs and flags any unhandled 500 or response that violates the
  declared OpenAPI schema. Runs nightly via `api:fuzz`.
- **Mutation testing** (mutmut) is the direct test of assertion strength: it
  deliberately corrupts the source — flips a `<` to `<=`, a `+` to `-`, a `True` to
  `False` — and reruns the suite. If no test fails, that *mutant* **survived**: the
  line is executed but not actually checked. A surviving mutant points at exactly
  the assertion the suite is missing.

### Running mutation testing

Mutation testing runs against the `trueppm-scheduler` package. It is scoped (via
`[tool.mutmut]` in `packages/scheduler/pyproject.toml`) to the pure-logic
modules — `models.py`, `derive.py`, `cli.py` — where a weak assertion is most
dangerous; the CPM/Monte-Carlo `engine.py` is the tracked next expansion.

```bash
cd packages/scheduler
pip install -e ".[dev]"          # mutmut is in the dev extra
mutmut run                        # corrupt + rerun; writes results into mutants/
mutmut results                    # list surviving mutants
mutmut show <mutant-name>         # see the exact corruption that survived
```

Each survivor is a triage item: write the assertion that would kill it, then rerun.
`mutmut export-cicd-stats` writes `mutants/mutmut-cicd-stats.json`, and
`scripts/check_mutation_score.py` turns that into a single **mutation score** —
the fraction of mutants the suite killed, excluding mutants on lines no test covers
(that is a coverage gap, which the coverage gate already owns, not an
assertion-strength gap).

In CI this runs as **`scheduler:mutation`**. The nightly run is **gating**:
`MUTATION_MIN` is `0.92`, set from the observed nightly baseline of 93.0–93.1%
under mutmut 3.7 (the suite scores 96.8% under the pinned mutmut 3.8.0), and a
nightly that scores below it goes red and stays red until the survivor is
killed. Unlike the fuzz jobs it does *not* carry job-level `allow_failure`,
because a mutation score crossing a fixed floor is one deterministic number
rather than an open-ended stochastic finding. Ratchet the floor down as the
score improves; never up to quiet a red.

It also runs on two merge request shapes, not only on the nightly schedule.
An MR that changes the measuring instrument (`packages/scheduler/pyproject.toml`
or `scripts/check_mutation_score.py`) **gates**, the same as the nightly — the
new pin or floor is measured before it merges. An MR that changes the measured
code itself (`models.py`, `derive.py`, `cli.py`) also runs the full suite, but
**informationally**: that rule carries a per-rule `allow_failure: true`, so the
score is reported and attributed to the diff that moved it without blocking an
ordinary scheduler change on a full mutation re-triage. This closed the gap
that let two 2026-09-25 merge requests each drop the nightly score by a few
points with nothing catching it pre-merge (#4147). An MR that does not touch
any of these five files does not run this job at all and still waits for the
nightly.

`check_mutation_score.py` exits `0` when the score meets the floor, `1` when it is
measured and below, and **`2` when it could not be measured at all** — a missing,
unparseable or empty stats file. That last state used to exit `0`, and it hid
thirteen consecutive nightlies that measured nothing (a test read a repo file that
was not listed in `[tool.mutmut] also_copy`, so mutmut's stats pass died inside its
sandbox and every mutant came back `not checked`). If you add a test under
`packages/scheduler/` that reads a file from the package root, add that file to
`also_copy`.

mutmut itself is pinned to an exact version in the scheduler's `dev` extra, unlike
its neighbors, because a minor mutmut release changes *what* gets measured. 3.8.0
began mutating `@dataclass` methods, which grew the mutant set by 459 overnight and
broke the run with no change on our side. Bump the pin in its own merge request:
changing `packages/scheduler/pyproject.toml` runs `scheduler:mutation` on that
merge request, so you see the new score before it merges. Two consequences of
mutmut's sandbox are worth knowing when you write a test: mutated methods gain
sibling attributes such as `xǁTaskǁto_dict__mutmut_orig` on their class, so a test
that walks `vars(cls)` must skip them, and the stats pass stops at the first failing
test — one such failure means no mutant runs at all.

### Mutation testing on the API

The API side has its own beachhead, scoped the same way for the same reason:
a narrow, pure-ish computation module where a weak assertion is most
dangerous. `[tool.mutmut]` in `packages/api/pyproject.toml` covers
`apps/projects/utilization.py` — the calendar-aware resource-utilization
engine — chosen over the 5-role RBAC permission matrix because capacity and
utilization computations in this exact shape have already shipped wrong on
green suites twice: capacity reading the zero load of a bare `Task.assignee`
instead of `TaskResource.units`, and progress on an in-progress task reading
as *lost* allocation because `early_start` is the remaining-work date, not
the commitment date.

```bash
cd packages/api
pip install -e ".[dev]"          # mutmut is in the dev extra
mutmut run --max-children=1       # serial — see the note on the DB below
mutmut results                    # list surviving mutants
mutmut show <mutant-name>         # see the exact corruption that survived
```

`--max-children=1` is not optional the way it is for the scheduler. The
scheduler's mutmut config mutates pure, DB-free code, so its workers can run
in parallel. The API's tests are pytest-django tests against a real
PostgreSQL, and `[tool.mutmut] pytest_add_cli_args` adds `--reuse-db` so each
mutant reuses the one test database the stats pass created rather than
re-migrating per mutant. Parallel mutant workers sharing that one reused
database by name would have no isolation across OS processes — pytest-django
only isolates tests *within* one process — so a parallel run can manufacture
false survivors that are really cross-process DB contention. Serial execution
trades worker parallelism for a score that means what it says.

The stats-collection pass and every per-mutant run are both scoped (via
`pytest_add_cli_args_test_selection`) to the specific test files that exercise
the beachhead module — not pytest's default `testpaths`, which would pull in
the ~3,500-test API suite before mutating a single line. If you add a function
to a mutation-tested module, check it is actually covered by one of the listed
test selectors before trusting its mutants' `no_tests` count: a function
tested only by a *different* file reads as fully uncovered under mutmut even
though the repo's own coverage gate sees it fine — this is what the module's
`compute_team_utilization` did on the first local baseline run, until
`tests/apps/projects/test_overview.py::TestTeamUtilization` was added to the
selector alongside `test_utilization.py`.

In CI this runs as **`api:mutation`**, report-only (`allow_failure: true`,
no `MUTATION_MIN` floor): unlike the scheduler's job, there is not yet a
multi-night baseline record to set one from. [Issue
#4268](https://gitlab.com/trueppm/trueppm/-/issues/4268) tracks setting a
floor once that baseline window exists — see `scheduler:mutation`'s own
comments in `.gitlab-ci.yml` for the method (observed low end of the nightly
record, minus one point of jitter headroom, ratcheted down only).

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
