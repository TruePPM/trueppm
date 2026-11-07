---
title: "FastAPI Integration"
description: "Use trueppm-scheduler inside a FastAPI application."
---

Because `trueppm-scheduler` is a pure Python library with no I/O, it integrates
trivially into any async framework. The key rule: **run `schedule()` in a thread
pool** so the synchronous CPM computation does not block the event loop.

## Install

```bash
pip install trueppm-scheduler fastapi uvicorn
```

## 1. Minimal schedule endpoint

```python
# main.py
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from functools import partial
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field
from trueppm_scheduler import (
    MAX_DURATION_DAYS, MAX_LAG_DAYS,
    Calendar, Dependency, DependencyType,
    Project as SchedulerProject, Task as SchedulerTask,
    ScheduleResult, schedule,
)

app = FastAPI(title="Scheduler API")
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cpm")

# Bounds for an endpoint that takes untrusted input. The engine has no task or
# run cap of its own (see "Limits for embedders" in the package README), so a
# public endpoint must set its own. Tune these to your workload.
MAX_TASKS = 500
MAX_DEPS_PER_REQUEST = 2_000
MAX_RUNS = 5_000
REQUEST_TIMEOUT_SECONDS = 10.0


# ---- Request / Response models ----

class TaskIn(BaseModel):
    id: str
    name: str
    duration_days: int = Field(ge=0, le=MAX_DURATION_DAYS)


class DependencyIn(BaseModel):
    predecessor_id: str
    successor_id: str
    dep_type: Literal["FS", "FF", "SS", "SF"] = "FS"
    lag_days: int = Field(default=0, ge=-MAX_LAG_DAYS, le=MAX_LAG_DAYS)


class ScheduleRequest(BaseModel):
    project_id: str
    start_date: date
    tasks: list[TaskIn] = Field(min_length=1, max_length=MAX_TASKS)
    dependencies: list[DependencyIn] = Field(default=[], max_length=MAX_DEPS_PER_REQUEST)


class TaskOut(BaseModel):
    id: str
    name: str
    early_start: date
    early_finish: date
    is_critical: bool
    total_float_days: int


class ScheduleResponse(BaseModel):
    project_finish: date
    tasks: list[TaskOut]


# ---- Translation ----

def _to_scheduler_project(req: ScheduleRequest) -> SchedulerProject:
    return SchedulerProject(
        id=req.project_id,
        name=req.project_id,
        start_date=req.start_date,
        tasks=[
            SchedulerTask(id=t.id, name=t.name, duration=timedelta(days=t.duration_days))
            for t in req.tasks
        ],
        dependencies=[
            Dependency(
                predecessor_id=d.predecessor_id,
                successor_id=d.successor_id,
                dep_type=DependencyType(d.dep_type),
                lag=timedelta(days=d.lag_days),
            )
            for d in req.dependencies
        ],
        calendar=Calendar(),
    )


def _run_schedule(req: ScheduleRequest) -> ScheduleResponse:
    """Synchronous; intended to be called from a thread pool."""
    result: ScheduleResult = schedule(_to_scheduler_project(req))
    return ScheduleResponse(
        project_finish=result.project_finish,
        tasks=[
            TaskOut(
                id=t.id,
                name=t.name,
                early_start=t.early_start,
                early_finish=t.early_finish,
                is_critical=t.is_critical,
                total_float_days=t.total_float.days,
            )
            for t in result.tasks
        ],
    )


# ---- Endpoint ----

async def _run_offthread(fn):
    """Run a CPU-bound call off the event loop, with a wall-clock timeout."""
    loop = asyncio.get_running_loop()
    return await asyncio.wait_for(
        loop.run_in_executor(_executor, fn), timeout=REQUEST_TIMEOUT_SECONDS
    )


@app.post("/schedule", response_model=ScheduleResponse)
async def schedule_project(req: ScheduleRequest) -> ScheduleResponse:
    """Compute CPM schedule for the given project.

    Runs in a thread pool to avoid blocking the event loop.
    """
    return await _run_offthread(partial(_run_schedule, req))
```

:::caution[This request model schedules from scratch]
It carries no progress, actuals, status date, or calendars, so every task is
scheduled as not started. To honor recorded progress, add `percent_complete`,
`actual_start`, `actual_finish`, `planned_start` and a `status_date` to the
request and pass them through, as the [Django guide](/embedding/django/) does.
:::

Run with:

```bash
uvicorn main:app --reload
```

## 2. Schedule request model

Map your request payload to a scheduler `Project` and call `schedule()`:

```python
class ScheduleRequest(BaseModel):
    project_id: str
    start_date: date
    tasks: list[TaskIn] = Field(min_length=1, max_length=MAX_TASKS)
    dependencies: list[DependencyIn] = Field(default=[], max_length=MAX_DEPS_PER_REQUEST)


def _run_schedule(req: ScheduleRequest) -> ScheduleResponse:
    result = schedule(_to_scheduler_project(req))
    # ... rest unchanged
```

## 3. Monte Carlo

Monte Carlo is the expensive call, and the library applies no task or run cap by default (only an absolute
ceiling of 100,000,000 runs, far above what a request should allow). Pass
`max_tasks` and `max_runs` whenever the caller is untrusted. If clients can supply
their own calendars, also pass a smaller `max_index_cells` (and
`max_lag_delta_cells`); the defaults are sized for a batch job, not a request
handler.

```python
from trueppm_scheduler import monte_carlo, MonteCarloResult


class MCRequest(ScheduleRequest):
    # Clients choose how many runs, but never more than the server allows.
    runs: int = Field(default=1_000, ge=1, le=MAX_RUNS)


class MCResponse(BaseModel):
    p50: date
    p80: date
    p95: date
    runs: int


@app.post("/monte-carlo", response_model=MCResponse)
async def run_monte_carlo(req: MCRequest) -> MCResponse:
    def _run() -> MCResponse:
        mc: MonteCarloResult = monte_carlo(
            _to_scheduler_project(req),
            runs=req.runs,
            seed=42,
            # The engine enforces these even if the request model is loosened
            # later. Exceeding either raises SimulationCapExceeded.
            max_runs=MAX_RUNS,
            max_tasks=MAX_TASKS,
        )
        return MCResponse(p50=mc.p50, p80=mc.p80, p95=mc.p95, runs=mc.runs)

    return await _run_offthread(_run)
```

:::caution[A timeout does not stop the computation]
`asyncio.wait_for` abandons the wait, but the worker thread keeps running to
completion, still holding a pool slot. The request caps are what bound that cost.
For a genuinely public endpoint, run the call in a worker process or queue
(Celery, ARQ, a process pool) where a stuck job can be killed.
:::

## 4. Error handling

Every error the scheduler raises on bad input derives from `SchedulerError`:
`CyclicDependencyError` for a cycle, `InvalidScheduleInput` for an out-of-range or
malformed value (for example an unknown `dep_type`), and `SimulationCapExceeded`
for a request over your caps. Catch the base class once, so none of them surfaces
as a 500. Register a handler for it and for the timeout:

```python
from fastapi.responses import JSONResponse
from trueppm_scheduler import CyclicDependencyError, SchedulerError


@app.exception_handler(SchedulerError)
async def scheduler_error_handler(request, exc: SchedulerError) -> JSONResponse:
    if isinstance(exc, CyclicDependencyError):
        detail = {"error": "cyclic_dependency", "cycle": list(exc.cycle)}
    else:
        detail = {"error": type(exc).__name__, "message": str(exc)}
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(TimeoutError)
async def timeout_handler(request, exc: TimeoutError) -> JSONResponse:
    return JSONResponse(
        status_code=504, content={"detail": {"error": "schedule_timeout"}}
    )
```

## See also

- [Django Integration](/embedding/django/) — ORM translation and Celery dispatch
- [Standalone Usage](/embedding/standalone/) — no web framework
- [CPM Scheduler reference](/features/scheduler/) — full API reference
