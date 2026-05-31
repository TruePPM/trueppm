# trueppm-scheduler

[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![CI](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Pure-Python CPM scheduling engine for TruePPM. Ships independently on PyPI — no Django dependency.

## Features

- Forward/backward CPM pass with all four dependency types (FS, SS, FF, SF)
- Calendar-aware working-day arithmetic (weekend skip + holiday exceptions)
- Monte Carlo simulation via PERT-Beta distributions (numpy-vectorised, ~10k runs/sec)
- CLI: `trueppm-scheduler schedule` / `trueppm-scheduler monte-carlo`

## Install

```bash
pip install trueppm-scheduler
```

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

## License

Apache 2.0
