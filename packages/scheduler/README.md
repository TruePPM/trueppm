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

calendar = Calendar()  # Mon–Fri, 8 h/day, no holidays
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
print(build.early_finish)  # 2026-01-21 (5 + 10 working days from 2026-01-05)
```

See [the full documentation](https://docs.trueppm.com/features/scheduler) for CPM output fields, Monte Carlo usage, and CLI reference.

## License

Apache 2.0
