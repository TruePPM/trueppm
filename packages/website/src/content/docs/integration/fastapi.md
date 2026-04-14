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

from fastapi import FastAPI
from pydantic import BaseModel
from trueppm_scheduler import (
    Calendar, Dependency, DependencyType,
    Project as SchedulerProject, Task as SchedulerTask,
    ScheduleResult, schedule,
)

app = FastAPI(title="Scheduler API")
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cpm")


# ---- Request / Response models ----

class TaskIn(BaseModel):
    id: str
    name: str
    duration_days: int


class DependencyIn(BaseModel):
    predecessor_id: str
    successor_id: str
    dep_type: str = "FS"
    lag_days: int = 0


class ScheduleRequest(BaseModel):
    project_id: str
    start_date: date
    tasks: list[TaskIn]
    dependencies: list[DependencyIn] = []


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

@app.post("/schedule", response_model=ScheduleResponse)
async def schedule_project(req: ScheduleRequest) -> ScheduleResponse:
    """Compute CPM schedule for the given project.

    Runs in a thread pool to avoid blocking the event loop.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, partial(_run_schedule, req))
```

Run with:

```bash
uvicorn main:app --reload
```

## 2. Incremental scheduling

Pass `changed_task_ids` when only a subset of tasks changed:

```python
class ScheduleRequest(BaseModel):
    project_id: str
    start_date: date
    tasks: list[TaskIn]
    dependencies: list[DependencyIn] = []
    changed_task_ids: list[str] | None = None  # None → full recompute


def _run_schedule(req: ScheduleRequest) -> ScheduleResponse:
    result = schedule(
        _to_scheduler_project(req),
        changed_task_ids=req.changed_task_ids,
    )
    # ... rest unchanged
```

## 3. Monte Carlo

```python
from trueppm_scheduler import monte_carlo, MonteCarloResult


class MCResponse(BaseModel):
    p50: date
    p80: date
    p95: date
    runs: int


@app.post("/monte-carlo", response_model=MCResponse)
async def run_monte_carlo(req: ScheduleRequest) -> MCResponse:
    def _run() -> MCResponse:
        mc: MonteCarloResult = monte_carlo(
            _to_scheduler_project(req), runs=10_000, seed=42
        )
        return MCResponse(p50=mc.p50, p80=mc.p80, p95=mc.p95, runs=mc.runs)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, _run)
```

## 4. Error handling

`schedule()` raises `CyclicDependencyError` when the task graph contains a cycle.
Map it to a 422 response:

```python
from fastapi import HTTPException
from trueppm_scheduler import CyclicDependencyError


@app.post("/schedule", response_model=ScheduleResponse)
async def schedule_project(req: ScheduleRequest) -> ScheduleResponse:
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_executor, partial(_run_schedule, req))
    except CyclicDependencyError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "cyclic_dependency", "cycle": list(exc.cycle)},
        ) from exc
```

## See also

- [Django Integration](/integration/django/) — ORM translation and Celery dispatch
- [Standalone Usage](/integration/standalone/) — no web framework
- [CPM Scheduler reference](/features/scheduler/) — full API reference
