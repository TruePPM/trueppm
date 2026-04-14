---
title: "Standalone Usage"
description: "Use trueppm-scheduler without any web framework."
---

`trueppm-scheduler` is a self-contained Python library. No web framework,
no database, no broker required.

## Install

```bash
pip install trueppm-scheduler
```

## Minimal example

```python
from datetime import date, timedelta
from trueppm_scheduler import (
    Calendar, Dependency, DependencyType,
    Project, Task, schedule,
)

tasks = [
    Task(id="a", name="Design",  duration=timedelta(days=5)),
    Task(id="b", name="Build",   duration=timedelta(days=10)),
    Task(id="c", name="Deploy",  duration=timedelta(days=2)),
]

project = Project(
    id="my-project",
    name="My Project",
    start_date=date(2026, 5, 4),
    tasks=tasks,
    dependencies=[
        Dependency(predecessor_id="a", successor_id="b"),
        Dependency(predecessor_id="b", successor_id="c"),
    ],
    calendar=Calendar(),
)

result = schedule(project)
print(f"Finish: {result.project_finish}")
print(f"Critical path: {' → '.join(result.critical_path)}")
```

## JSON input / output

Projects serialise to and from JSON for file-based workflows:

```python
import json

# Write
json_str = project.to_json(indent=2)
with open("project.json", "w") as f:
    f.write(json_str)

# Read and schedule
with open("project.json") as f:
    loaded = Project.from_json(f.read())

result = schedule(loaded)
print(result.project_finish)
```

## CLI

The `trueppm-scheduler` command provides a minimal CLI:

```bash
# Schedule from a JSON file
trueppm-scheduler schedule --input project.json

# JSON output
trueppm-scheduler schedule --input project.json --json

# Monte Carlo
trueppm-scheduler monte-carlo --input project.json --runs 10000 --json
```

Use `--help` on any subcommand for full options:

```bash
trueppm-scheduler schedule --help
```

## Monte Carlo

```python
from trueppm_scheduler import monte_carlo

mc = monte_carlo(project, runs=10_000, seed=42)
print(f"P50: {mc.p50}")
print(f"P80: {mc.p80}  ← recommended commitment date")
print(f"P95: {mc.p95}  ← contractual deadline buffer")
```

See [02-monte-carlo.ipynb](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/02-monte-carlo.ipynb)
for a full walkthrough with matplotlib visualisation.

## Incremental scheduling

When only a few tasks changed, pass their IDs to avoid a full recompute:

```python
result = schedule(project, changed_task_ids=["a", "b"])
```

Falls back to full recompute when `changed_task_ids` is `None` or exceeds 25%
of tasks. Results are always equivalent to a full recompute.

## Error handling

```python
from trueppm_scheduler import CyclicDependencyError

try:
    result = schedule(project)
except CyclicDependencyError as exc:
    print(f"Dependency cycle: {' → '.join(exc.cycle)}")
```

## Supported Python versions

| Python | Supported |
|--------|-----------|
| 3.12   | Yes       |
| 3.11   | Yes       |
| 3.13   | Yes       |
| < 3.11 | No        |

## See also

- [Django Integration](/integration/django/) — ORM translation and Celery dispatch
- [FastAPI Integration](/integration/fastapi/) — async thread-pool pattern
- [CPM Scheduler reference](/features/scheduler/) — full API reference
- [Interactive notebooks](https://gitlab.com/trueppm/trueppm/-/tree/main/packages/scheduler/notebooks/) — runnable examples
