# Contributing to trueppm-scheduler

The scheduler is a pure Python library with no Django dependency.
It ships independently as `trueppm-scheduler` on PyPI and is also consumed
by the TruePPM Django API as a service-layer dependency.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (recommended) or `pip`

```bash
# Install with dev dependencies using uv
cd packages/scheduler
uv sync --extra dev

# Or with pip
pip install -e ".[dev]"
```

## Running the tests

```bash
cd packages/scheduler
pytest                          # all tests, short output
pytest -v                       # verbose
pytest tests/test_engine.py -x  # stop on first failure
```

`tests/test_wasm_conformance.py` checks the Python engine against the shared
Python↔WASM fixtures in `packages/wasm-scheduler/fixtures`. That tree is only in
the TruePPM monorepo, not in the sdist, so when you run the suite from an
unpacked sdist the module is skipped and every other test runs. Inside a
monorepo checkout a missing fixture still fails the run: the module recognizes
the checkout's layout, and `TRUEPPM_MONOREPO=1` (set by CI and
`make test-scheduler`) enforces the same thing independently.

### The independent CPM oracle

The conformance fixtures above prove the Python and Rust engines **agree**. They
do not prove either is **right**: every `fixtures/expected/*.json` snapshot is
Python's own output, so a rule both engines get wrong passes — one snapshot,
`milestone_tasks.json`, did (#4079). `tests/oracle/reference_cpm.py` closes that
gap. It is a deliberately slow, day-by-day reference CPM pass written from the
documented conventions (the [Conventions](README.md#conventions) list), and it
imports nothing from `trueppm_scheduler`. Do not make it faster or share code
with the engine; its value is that it is independent and easy to read.

`tests/test_cpm_oracle.py` holds both engines to it over Hypothesis-generated
networks — all four link types, leads and lags, random working-day masks and
calendar exceptions, milestones — plus the named milestone properties: inserting
a zero-duration milestone into an FS link moves nothing and the milestone sits on
the predecessor's finish; a start milestone at the project start delays nothing;
`EF - ES + 1 == duration` for every task with work; a dangling FS milestone is
time-neutral.

What is compared:

| Field | Compared |
|-------|----------|
| `early_start`, `early_finish` (task with work) | Exactly, always |
| `late_start`, `late_finish`, `total_float`, `free_float`, `is_critical` (task with work) | Exactly, unless a milestone lies downstream of the task or decides the project finish. Those depend on which edge of its day the milestone is shown on, a display rule the reference does not model. On a network with no milestones they are always compared. |
| Milestone early date | By working-time position: the shown day folded with `milestone_at_day_end`, never by shown day alone (#4178, #4207) |
| Milestone late dates and floats, `scheduled_start`, `critical_path`, `driving_edges` | Not compared |
| Monte Carlo | Not compared. Only the Python engine runs it; the Rust engine is deterministic CPM only |

Not generated yet: progress and actuals, the data date, `planned_start`,
per-task calendars, and summary tasks. Two link shapes where both engines
disagree with the reference are excluded until they are triaged; see
`_known_divergent` in the test file.

The Rust engine is checked two ways. Locally, when `cargo` is on `PATH`, the
Rust properties build the crate's `oracle_runner` example and feed it the same
generated networks; without a toolchain they skip. In CI, `wasm:test` runs
`packages/wasm-scheduler/tests/oracle_conformance.rs` against
`packages/wasm-scheduler/fixtures/oracle/corpus.json`, a seeded corpus generated
**by the reference**, and `scheduler:test` fails if that corpus no longer matches
the reference. After changing the reference, regenerate it with:

```bash
REGEN_ORACLE_CORPUS=1 pytest tests/test_cpm_oracle.py -k corpus
```

The corpus and the fixture format are not yet published for other
implementations to test against. That is tracked in #4165 (publish the
conformance corpus) and #4164 (a JSON Schema for the project document).

### Performance benchmarks

The bench suite asserts hard time budgets. Run it before submitting a MR
that touches the engine:

```bash
pytest tests/test_bench.py -v
```

Expected output:

```
PASSED tests/test_bench.py::test_schedule_performance[100-tasks]
PASSED tests/test_bench.py::test_schedule_performance[500-tasks]
```

If either test fails, profile before investigating — a warm-up run is included
to exclude import-time costs, so a failure indicates a genuine algorithmic
regression.

## Linting and type checking

```bash
ruff check src tests    # lint
ruff format src tests   # format
mypy src                # strict type check
```

CI runs all three on every MR. Fixes must address root causes — do not use
`# type: ignore` or `# noqa` to silence errors.

## Interactive notebooks

The `notebooks/` directory contains Jupyter notebooks that serve as
executable documentation:

| Notebook | Topic |
|----------|-------|
| `01-cpm-quickstart.ipynb` | Project definition, CPM, float table, cycle detection |
| `02-monte-carlo.ipynb` | PERT estimates, Monte Carlo, P50/P80/P95 |
| `03-calendar-aware.ipynb` | Custom working weeks, holiday exceptions, lag |
| `04-incremental-scheduling.ipynb` | Incremental CPM, fallback behaviour, bench targets |

Run them locally:

```bash
pip install -e ".[dev]" jupyter matplotlib
jupyter notebook notebooks/
```

The `scheduler:notebooks` CI job executes all notebooks with `jupyter nbconvert
--execute` to catch regressions. A notebook cell that raises an exception fails
the job.

## Adding a new notebook

1. Create `notebooks/0N-topic.ipynb` with a markdown header cell explaining
   the topic and install instructions.
2. Keep each cell self-contained — cells are run top-to-bottom by CI.
3. Avoid dependencies outside `trueppm-scheduler` and `matplotlib`
   (already installed in the CI image). Use a `try/import` guard for
   optional visualisation libraries.
4. Add a row to the table in `packages/website/src/content/docs/features/scheduler.md`.

## Project structure

```
packages/scheduler/
├── src/
│   └── trueppm_scheduler/
│       ├── __init__.py     # Public API exports
│       ├── models.py       # Data classes: Task, Dependency, Project, Calendar
│       ├── engine.py       # schedule(), monte_carlo(), CPM algorithms
│       └── cli.py          # CLI entry point (trueppm-scheduler command)
├── tests/
│   ├── test_engine.py      # Unit tests for schedule() and monte_carlo()
│   ├── test_bench.py       # Performance regression guard
│   └── conftest.py         # Shared fixtures
├── notebooks/              # Executable documentation (see above)
├── pyproject.toml
└── CONTRIBUTING.md         # This file
```

## Design constraints

1. **Zero Django dependency.** The scheduler must import and run in any Python
   environment without Django installed. Never import from `django` or
   `trueppm_api` inside `src/trueppm_scheduler/`.

2. **Pure data in, pure data out.** `schedule()` and `monte_carlo()` accept
   `Project` dataclasses and return `ScheduleResult` / `MonteCarloResult`
   dataclasses. No side effects, no I/O.

3. **Deterministic at a given seed.** Monte Carlo results are reproducible when
   `seed` is provided. Do not introduce sources of non-determinism outside the
   PERT sampler.

4. **Incremental results must match full recompute.** Any change to the
   incremental path must pass `tests/test_incremental_equivalence.py`, which
   asserts result equality across 1000 random scenarios.

## Commit and MR conventions

See the [Contributing guide](https://docs.trueppm.com/contributing/guide/) for
branch naming, commit format, and changelog fragments. The short version:

```bash
git checkout -b feat/scheduler-<topic>      # or fix/, docs/, perf/
# make changes
git commit -m "feat(scheduler): <description>"
# create changelog fragment: changelog.d/<issue>.<type>.md
```

### Release notes for library consumers

The `changelog.d/` fragment above feeds the **suite-wide** root `CHANGELOG.md`.
A change that is visible to PyPI consumers of `trueppm-scheduler` (public API,
engine behavior, CLI, validation, security) must **also** get an entry under
`## [Unreleased]` in this package's own [`CHANGELOG.md`](./CHANGELOG.md) — that
file is force-included into the wheel, so it is the changelog people see on
PyPI. Add a bullet under the matching `### Added / Changed / Fixed / Security`
heading; pure-internal refactors with no consumer-visible effect don't need one.

At release time `scripts/release.sh` rotates `[Unreleased]` into a dated
`## [<version>]` section automatically (and `scheduler:publish` refuses to
publish a tag whose version has no section), so the only manual step is writing
the bullet during the cycle.

All scheduler MRs require a green `scheduler:lint`, `scheduler:type-check`,
`scheduler:test`, and `scheduler:bench` pipeline.
