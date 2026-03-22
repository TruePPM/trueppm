# CPM Scheduler

The scheduling engine lives in `packages/scheduler` and ships independently as `trueppm-scheduler` on PyPI. It has no Django dependency.

## Critical Path Method (CPM)

The `schedule()` function performs a forward pass, backward pass, float calculation, and critical-path identification on a directed acyclic graph of tasks and dependencies.

### Dependency types

| Code | Name | Constraint |
|------|------|-----------|
| `FS` | Finish-to-Start | Successor starts after predecessor finishes (+ lag) |
| `SS` | Start-to-Start | Successor starts after predecessor starts (+ lag) |
| `FF` | Finish-to-Finish | Successor finishes after predecessor finishes (+ lag) |
| `SF` | Start-to-Finish | Successor finishes after predecessor starts (+ lag) |

Lag is expressed in **calendar working days** and is applied in the forward pass. Negative lag (lead) is supported.

### Output fields per task

| Field | Description |
|-------|-------------|
| `early_start` | Earliest date the task can start |
| `early_finish` | Earliest date the task can finish |
| `late_start` | Latest date the task can start without delaying the project |
| `late_finish` | Latest date the task can finish without delaying the project |
| `total_float` | Working days of slack before the task delays the project end |
| `is_critical` | True when total_float == 0 |

### Calendar arithmetic

Working-day arithmetic skips weekends and any dates listed in the project's `CalendarException` set. The calendar is applied to all lag calculations and task duration expansions.

### Cycle detection

If the dependency graph contains a cycle, `schedule()` raises `CyclicDependencyError`. The `.cycle` attribute on the exception contains the list of task IDs forming the cycle.

### Usage

```python
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency
from trueppm_scheduler.exceptions import CyclicDependencyError

calendar = Calendar(id="cal-1", name="Standard", working_days={0,1,2,3,4})
project = Project(id="p-1", name="Bridge", start_date="2026-04-01", calendar=calendar)

tasks = [
    Task(id="t-1", name="Design", duration=10, project_id="p-1"),
    Task(id="t-2", name="Procure", duration=15, project_id="p-1"),
    Task(id="t-3", name="Build", duration=30, project_id="p-1"),
]
dependencies = [
    Dependency(id="d-1", predecessor_id="t-1", successor_id="t-3", dep_type="FS"),
    Dependency(id="d-2", predecessor_id="t-2", successor_id="t-3", dep_type="FS"),
]

try:
    result = schedule(project, tasks, dependencies, calendar)
except CyclicDependencyError as e:
    print("Cycle:", e.cycle)

for task_id, task_result in result.tasks.items():
    print(task_result.name, task_result.early_finish, "critical:", task_result.is_critical)
```

### CLI

```bash
trueppm-scheduler schedule --input project.json
trueppm-scheduler schedule --input project.json --json  # machine-readable output
```

## Monte Carlo Simulation

`monte_carlo()` runs probabilistic simulation using PERT-Beta distributions to estimate project completion probability.

### PERT-Beta parameterisation

Each task provides three duration estimates:

| Estimate | Field | Meaning |
|----------|-------|---------|
| Optimistic | `duration_optimistic` | Best-case duration |
| Most likely | `duration` | Expected duration (used for CPM) |
| Pessimistic | `duration_pessimistic` | Worst-case duration |

The PERT-Beta mean and variance are derived from these three values using the method-of-moments parameterisation. The simulation draws from this distribution for each task on each trial.

### Performance

Vectorised with numpy. 10,000 runs on a 200-task chain completes in under 5 seconds on a single CPU core.

### Output

| Field | Description |
|-------|-------------|
| `p50` | Date by which the project completes in 50% of simulations |
| `p80` | Date by which the project completes in 80% of simulations |
| `p95` | Date by which the project completes in 95% of simulations |
| `distribution` | Full sorted list of completion dates (with `--distribution` flag) |

### Usage

```python
from trueppm_scheduler import monte_carlo

mc_result = monte_carlo(project, tasks, dependencies, calendar, iterations=10_000)
print(mc_result.p50, mc_result.p80, mc_result.p95)
```

### CLI

```bash
trueppm-scheduler monte-carlo --input project.json
trueppm-scheduler monte-carlo --input project.json --distribution  # full distribution
trueppm-scheduler monte-carlo --input project.json --json          # machine-readable
```

## Auto-scheduling in the API

The `recalculate_schedule` Celery task fires automatically via `transaction.on_commit()` after every Task or Dependency write. It:

1. Acquires a per-project Redis lock (`SET NX`) to prevent redundant concurrent recalculations
2. Fetches all live (non-deleted) tasks and dependencies for the project
3. Calls `trueppm-scheduler`'s `schedule()` function
4. Writes CPM output fields back to the Task rows
5. Broadcasts a `schedule_updated` WebSocket event to all connected project clients

If the lock is already held (another recalculation is in progress), the task re-queues itself with a 10-second countdown.
