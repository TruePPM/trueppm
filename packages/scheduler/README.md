# trueppm-scheduler

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
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency

calendar = Calendar(id="cal-1", name="Standard")
project = Project(id="p-1", name="My Project", start_date="2026-01-01", calendar=calendar)
task_a = Task(id="t-1", name="Design", duration=5, project_id="p-1")
task_b = Task(id="t-2", name="Build", duration=10, project_id="p-1")
dep = Dependency(id="d-1", predecessor_id="t-1", successor_id="t-2", dep_type="FS")

result = schedule(project, [task_a, task_b], [dep], calendar)
print(result.tasks["t-2"].early_finish)  # 2026-01-20
```

See [the full documentation](https://docs.trueppm.com/features/scheduler) for CPM output fields, Monte Carlo usage, and CLI reference.

## License

Apache 2.0
