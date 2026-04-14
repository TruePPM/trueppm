---
title: "CPM Scheduler"
description: "Forward/backward pass, calendar-aware lag, Monte Carlo simulation, and auto-scheduling."
---

The scheduling engine lives in `packages/scheduler` and ships independently as `trueppm-scheduler` on PyPI. It has no Django dependency.

```bash
pip install trueppm-scheduler
```

## Interactive notebooks

| Notebook | Contents |
|----------|----------|
| [`01-cpm-quickstart.ipynb`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/01-cpm-quickstart.ipynb) | Project definition, CPM run, per-task float table, custom calendar, SS dependency, cycle detection, JSON round-trip |
| [`02-monte-carlo.ipynb`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/02-monte-carlo.ipynb) | PERT three-point estimates, Monte Carlo run, P50/P80/P95 output, matplotlib histogram, scenario comparison |
| [`03-calendar-aware.ipynb`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/03-calendar-aware.ipynb) | Mon–Sat weeks, public holiday exceptions, multi-week shutdown blocks, calendar-aware lag, JSON round-trip |
| [`04-incremental-scheduling.ipynb`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/04-incremental-scheduling.ipynb) | Incremental CPM, equivalence verification, fallback behaviour, local bench |

```bash
# Run locally (from repo root)
pip install -e "packages/scheduler[dev]" matplotlib
jupyter notebook packages/scheduler/notebooks/
```

## Critical Path Method

`schedule()` performs a forward pass, backward pass, float calculation, and critical-path identification on a directed acyclic graph of tasks and dependencies.

### Dependency types

| Code | Name | Constraint |
|------|------|-----------|
| `FS` | Finish-to-Start | Successor starts after predecessor finishes (+ lag) |
| `SS` | Start-to-Start | Successor starts after predecessor starts (+ lag) |
| `FF` | Finish-to-Finish | Successor finishes after predecessor finishes (+ lag) |
| `SF` | Start-to-Finish | Successor finishes after predecessor starts (+ lag) |

Lag is in **calendar working days**. Negative lag (lead) is supported.

### Output fields

| Field | Type | Description |
|-------|------|-------------|
| `early_start` | `date` | Earliest date the task can start |
| `early_finish` | `date` | Earliest date the task can finish |
| `late_start` | `date` | Latest start without delaying the project |
| `late_finish` | `date` | Latest finish without delaying the project |
| `total_float` | `timedelta` | Working days of slack before the task delays the project end |
| `is_critical` | `bool` | `True` when `total_float == timedelta(0)` |

### Calendar arithmetic

Working-day arithmetic skips weekends and any dates listed in `Calendar.exceptions` (`DateRange` entries). Applied to all lag calculations and task duration expansions.

### Cycle detection

`schedule()` raises `CyclicDependencyError` if the graph contains a cycle. The `.cycle` attribute contains the list of task IDs forming the cycle.

### Usage

```python
from datetime import date, timedelta
from trueppm_scheduler import (
    Calendar, DateRange, Dependency, DependencyType,
    Project, Task, schedule, CyclicDependencyError,
)

# Calendar: Mon–Fri, Good Friday excluded
cal = Calendar(
    exceptions=[
        DateRange(start=date(2026, 4, 3), end=date(2026, 4, 3)),
    ]
)

tasks = [
    Task(id="design", name="Design", duration=timedelta(days=5)),
    Task(id="build",  name="Build",  duration=timedelta(days=10)),
    Task(id="test",   name="Test",   duration=timedelta(days=7)),
    Task(id="deploy", name="Deploy", duration=timedelta(days=2)),
]

dependencies = [
    Dependency(predecessor_id="design", successor_id="build"),
    Dependency(predecessor_id="design", successor_id="test"),
    Dependency(predecessor_id="build",  successor_id="deploy"),
    Dependency(predecessor_id="test",   successor_id="deploy"),
]

project = Project(
    id="release-v1",
    name="Release v1.0",
    start_date=date(2026, 4, 1),
    tasks=tasks,
    dependencies=dependencies,
    calendar=cal,
)

try:
    result = schedule(project)
except CyclicDependencyError as e:
    print("Cycle:", e.cycle)

print(f"Finish: {result.project_finish}")
print(f"Critical path: {' → '.join(result.critical_path)}")

for t in result.tasks:
    print(t.name, t.early_finish, "float:", t.total_float.days, "critical:", t.is_critical)
```

Non-FS dependencies use the `dep_type` and optional `lag` arguments:

```python
Dependency(
    predecessor_id="code",
    successor_id="test",
    dep_type=DependencyType.SS,
    lag=timedelta(days=2),
)
```

### JSON round-trip

```python
json_str = project.to_json(indent=2)
project_rt = Project.from_json(json_str)
result_rt = schedule(project_rt)
```

### CLI

```bash
trueppm-scheduler schedule --input project.json
trueppm-scheduler schedule --input project.json --json
```

## Monte Carlo Simulation

`monte_carlo()` runs probabilistic simulation using PERT-Beta distributions (method-of-moments parameterisation). Vectorised with numpy; 10,000 runs on a 200-task chain completes in under 5 seconds.

### Three-point estimates

Add `optimistic_duration`, `most_likely_duration`, and `pessimistic_duration` to any task you want sampled stochastically. Tasks without these fields use their deterministic `duration` on every run.

| Field | Meaning |
|-------|---------|
| `optimistic_duration` | Best-case (`timedelta`) |
| `most_likely_duration` | Expected case — should match `duration` (`timedelta`) |
| `pessimistic_duration` | Worst-case (`timedelta`) |

### Output

| Field | Description |
|-------|-------------|
| `runs` | Number of simulations executed |
| `p50` | Completion date in 50% of simulations |
| `p80` | Completion date in 80% of simulations (recommended stakeholder commitment date) |
| `p95` | Completion date in 95% of simulations (contractual deadline buffer) |
| `distribution` | Full sorted list of completion dates (one per run) |

### Usage

```python
from datetime import date, timedelta
from trueppm_scheduler import Calendar, Dependency, Project, Task, monte_carlo, schedule

def days(n: int) -> timedelta:
    return timedelta(days=n)

tasks = [
    Task(
        id="design", name="Design",
        duration=days(5),
        optimistic_duration=days(3),
        most_likely_duration=days(5),
        pessimistic_duration=days(10),
    ),
    Task(
        id="build", name="Build",
        duration=days(15),
        optimistic_duration=days(10),
        most_likely_duration=days(15),
        pessimistic_duration=days(25),
    ),
    # No PERT estimates — deterministic every run
    Task(id="deploy", name="Deploy", duration=days(2)),
]

project = Project(
    id="release-mc",
    name="Release v1.0 (Monte Carlo)",
    start_date=date(2026, 4, 1),
    tasks=tasks,
    dependencies=[
        Dependency(predecessor_id="design", successor_id="build"),
        Dependency(predecessor_id="build",  successor_id="deploy"),
    ],
    calendar=Calendar(),
)

# CPM deterministic baseline
cpm = schedule(project)
print(f"CPM finish (P50 proxy): {cpm.project_finish}")

# Monte Carlo
mc = monte_carlo(project, runs=10_000, seed=42)
print(f"P50: {mc.p50}")
print(f"P80: {mc.p80}  ← recommended commitment date")
print(f"P95: {mc.p95}")

slip = (mc.p80 - cpm.project_finish).days
print(f"P80 vs CPM: +{slip} calendar days ({slip/7:.1f} weeks of schedule risk)")
```

:::tip P80 is the commitment date

The CPM deterministic finish is typically close to P50 — meaning there is only a **50% chance** the project finishes on the date shown in a traditional Gantt chart. Commit to the P80 date to reflect realistic schedule risk.

:::

### CLI

```bash
# Summary output
trueppm-scheduler monte-carlo --input project.json

# JSON output with full weekly distribution (for frontend histograms)
trueppm-scheduler monte-carlo --input project.json --json --distribution
```

## Auto-scheduling in the API

The `recalculate_schedule` Celery task fires automatically via `transaction.on_commit()` after every Task or Dependency write:

1. Acquires a per-project Redis lock (`SET NX`) — prevents redundant concurrent recalculations
2. Fetches all live (non-deleted) tasks and dependencies for the project
3. Calls `trueppm-scheduler`'s `schedule()` function
4. Writes CPM output fields back to Task rows
5. Broadcasts a `schedule_updated` WebSocket event to all connected clients

If the lock is already held, the task re-queues itself with a 10-second countdown.
