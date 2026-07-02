# trueppm-scheduler

[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![CI](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**Project-schedule math as a library — critical path and delivery-risk forecasting, without a 500 MB desktop app or a SaaS subscription.**

Answer the two questions every plan has to answer:

- **"What's the earliest this can finish, and which tasks can't slip?"** — a full forward/backward critical-path pass computes early/late dates, total and free float, and flags the tasks on the critical path.
- **"How confident are we in that date?"** — Monte Carlo simulation turns three-point estimates into a P50/P80/P95 forecast, so you can commit to a date you'll actually hit instead of the best-case one.

It's pure Python with just `networkx` and `numpy` underneath — no Django, no web server, no GUI. Drop it into a backend, a data pipeline, a Jupyter notebook, or a CLI and get the same engine that powers the [TruePPM](https://trueppm.com) platform.

### Why reach for this

- **Real scheduling semantics, not a toy.** All four dependency types (finish-to-start, start-to-start, finish-to-finish, start-to-finish) with calendar-aware lag — most lightweight schedulers only do finish-to-start and count raw calendar days, which silently overruns any plan with a weekend in it.
- **Working-time aware.** A built-in working-day calendar skips weekends and honors holiday exceptions, so durations resolve to real delivery dates.
- **Risk forecasting built in.** PERT-Beta Monte Carlo, numpy-vectorized at ~10k runs/sec — the difference between "due March 3" and "70% likely by March 3, 95% by March 14."
- **Fails loud on bad input.** Cycle detection that names the offending task IDs, plus up-front validation of durations, lag, and project span — no silent wrong answers, no spinning on a degenerate graph.
- **Embeds anywhere.** Two dependencies, no framework. Serialize a plan to JSON, schedule it, and read back structured results.

## Features

- Forward/backward CPM pass with all four dependency types (FS, SS, FF, SF), total/free float, and critical-path flagging
- Calendar-aware working-day arithmetic (weekend skip + holiday exceptions)
- Monte Carlo schedule-risk simulation via PERT-Beta distributions (numpy-vectorized, ~10k runs/sec) → P50/P80/P95 completion dates
- JSON round-tripping for plans (`Project.from_json()` / `Project.to_json()`)
- CLI: `trueppm-scheduler schedule` / `trueppm-scheduler monte-carlo`

## Install

```bash
pip install trueppm-scheduler
```

Requires Python 3.11+.

## Quick start

```python
from datetime import date, timedelta
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency, DependencyType

calendar = Calendar()  # Mon–Fri, no holidays (whole-day scheduling)
task_a = Task(id="t-1", name="Design", duration=timedelta(days=5))
task_b = Task(id="t-2", name="Build",  duration=timedelta(days=10))
dep = Dependency(predecessor_id="t-1", successor_id="t-2", dep_type=DependencyType.FS)

project = Project(
    id="p-1",
    name="My Project",
    start_date=date(2026, 1, 5),
    tasks=[task_a, task_b],
    dependencies=[dep],
    calendar=calendar,
)

result = schedule(project)
build = next(t for t in result.tasks if t.id == "t-2")
print(build.early_finish)  # 2026-01-23 (15 working days from 2026-01-05, across two weekends)
```

> **Scheduling granularity.** The engine schedules in whole working-day units.
> `Calendar.hours_per_day` and `Calendar.timezone` round-trip through
> serialization for API parity but are **not** consumed by the CPM or Monte Carlo
> passes — they do not change any computed date. Sub-day scheduling is a future
> change.

### Per-task calendars

By default every task is scheduled on the single `Project.calendar`. A task can
instead opt into its own working week — useful when one schedule spans teams or
projects that keep different calendars:

```python
seven_day = Calendar(working_days=0b111_1111)  # every day is a working day
support = Task(id="t-3", name="Hotfix", duration=timedelta(days=3), calendar_id="ops")

project = Project(
    id="p-1",
    name="My Project",
    start_date=date(2026, 1, 5),
    tasks=[task_a, support],
    calendar=Calendar(),                 # pass-level default (Mon–Fri)
    calendars={"ops": seven_day},        # registry tasks opt into by id
)
```

Conventions:

- **Duration** arithmetic uses the task's *own* calendar (`calendar_id` → entry in
  `Project.calendars`). A `calendar_id` of `None`, or one with no matching entry,
  falls back to the pass-level `Project.calendar` — never an error.
- **Lag** on a dependency edge is counted on the **successor's** calendar: the
  constraint lands where the wait is actually consumed.
- It is fully backward compatible — a project with no `calendars` registry
  schedules byte-for-byte as before.
- Per-task calendars are honored by the CPM `schedule()` pass (early/late dates,
  float, criticality). `monte_carlo()` samples on the pass-level `Project.calendar`
  only.

See [the full documentation](https://docs.trueppm.com/features/scheduler) for CPM output fields, Monte Carlo usage, and CLI reference.

## Errors and input limits

Every exception the engine raises subclasses `ValueError`, so one
`except ValueError` catches them all — but each is individually catchable:

| Exception | Raised when |
|-----------|-------------|
| `CyclicDependencyError` | The dependency graph contains a cycle. `.cycle` lists the task IDs forming it. |
| `SimulationCapExceeded` | `monte_carlo(runs=…)` exceeds `max_runs`, or the project has more tasks than `max_tasks`. |
| `InvalidScheduleInput` | The input is structurally valid but out of range (see limits below). |

The engine walks the working calendar one day at a time, so it validates input
up front rather than spinning on a degenerate project:

- **Calendar** — `working_days` must set at least one weekday bit (Mon–Sun); a
  calendar whose `exceptions` blanket the entire search window is rejected too.
- **Duration** — each task duration must be between `0` and `MAX_DURATION_DAYS`
  (`36_525`, ~100 years). Negative durations are rejected.
- **Lag** — each dependency lag must be within `±MAX_LAG_DAYS` (`36_525`).
- **Project span** — the cumulative span (every task's worst-case duration plus
  the magnitude of every lag) must stay under `MAX_PROJECT_SPAN_DAYS`
  (`366_000`, ~1000 years), regardless of task count.
- **Monte Carlo** — `runs` must be `>= 1`.

`Project.from_json()` also rejects the non-standard JSON literals `NaN`,
`Infinity`, and `-Infinity`.

```python
from trueppm_scheduler import schedule, InvalidScheduleInput

try:
    result = schedule(project)
except InvalidScheduleInput as e:
    print("Bad input:", e)  # "Task 't-1' duration exceeds the maximum of 36525 days (got …)."
```

## API stability and versioning

**The public API is the `__all__` surface of the top-level `trueppm_scheduler`
package** — the names you can import directly from `trueppm_scheduler`
(`schedule`, `monte_carlo`, `Project`, `Task`, `Dependency`, `DependencyType`,
`Calendar`, `ScheduleResult`, `MonteCarloResult`, the exception types, etc.).
Everything else — the `trueppm_scheduler.engine` internals, any underscore-
prefixed helper, and module layout — is **unstable** and may move or change
without notice.

This package is **`Development Status :: 3 - Alpha`**: the public API may change
before 1.0. **Pin an exact version** rather than a range:

```
trueppm-scheduler==0.2.0a1
```

Alpha releases are pre-releases — `pip install trueppm-scheduler` skips them
unless you pass `--pre`. Breaking changes are recorded in
[`CHANGELOG.md`](./CHANGELOG.md), which also ships inside the wheel.

### Monte Carlo determinism

Monte Carlo simulation is **deterministic for a fixed seed**: the same `seed`
always yields the same P50/P80/P95 forecast for the same input. This is a
supported, tested property you can rely on for reproducible reports and
regression baselines — not an implementation detail.

## Security

Found a vulnerability in the scheduling engine? Please report it privately —
do **not** open a public issue. Email **security@trueppm.com** or open a
confidential GitLab issue. Full policy, response SLAs, and safe-harbor terms are
in [`SECURITY.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/SECURITY.md)
at the monorepo root.

## License

Apache 2.0
