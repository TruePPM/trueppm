---
title: "Django Integration"
description: "Use trueppm-scheduler inside a Django + Celery application."
---

`trueppm-scheduler` has no Django dependency and is consumed as a plain Python
library. The integration pattern is: **service layer builds data classes → calls
`schedule()` → writes results back to the database**.

## Install

```bash
pip install trueppm-scheduler
```

## 1. Translate Django models to scheduler data classes

The scheduler never touches the ORM. Write a translation function in your
`scheduling/services.py`:

```python
# scheduling/services.py
from datetime import date
from trueppm_scheduler import (
    Calendar, DateRange, Dependency, DependencyType,
    Project as SchedulerProject, Task as SchedulerTask,
    ScheduleResult, schedule,
)
from .models import Project, Task  # your Django models


def build_scheduler_project(django_project: Project) -> SchedulerProject:
    """Serialise a Django Project to the pure-Python scheduler representation."""
    cal = django_project.calendar

    scheduler_cal = Calendar(
        working_days=cal.working_days,
        hours_per_day=cal.hours_per_day,
        timezone=cal.timezone,
        exceptions=[
            DateRange(start=exc.start_date, end=exc.end_date)
            for exc in cal.exceptions.all()
        ],
    )

    tasks = [
        SchedulerTask(
            id=str(t.pk),
            name=t.name,
            duration=t.duration,
            optimistic_duration=t.optimistic_duration,
            most_likely_duration=t.most_likely_duration,
            pessimistic_duration=t.pessimistic_duration,
        )
        for t in django_project.tasks.all()
    ]

    deps = []
    for d in django_project.dependencies.select_related("predecessor", "successor"):
        deps.append(Dependency(
            predecessor_id=str(d.predecessor_id),
            successor_id=str(d.successor_id),
            dep_type=DependencyType(d.dep_type),
            lag=d.lag,
        ))

    return SchedulerProject(
        id=str(django_project.pk),
        name=django_project.name,
        start_date=django_project.start_date,
        tasks=tasks,
        dependencies=deps,
        calendar=scheduler_cal,
    )


def apply_schedule_result(django_project: Project, result: ScheduleResult) -> None:
    """Write CPM results back to the database in bulk."""
    from django.db import transaction

    task_map = {str(t.id): t for t in django_project.tasks.all()}

    updates = []
    for sched_task in result.tasks:
        db_task = task_map.get(sched_task.id)
        if db_task is None:
            continue
        db_task.early_start  = sched_task.early_start
        db_task.early_finish = sched_task.early_finish
        db_task.late_start   = sched_task.late_start
        db_task.late_finish  = sched_task.late_finish
        db_task.total_float  = sched_task.total_float
        db_task.is_critical  = sched_task.is_critical
        updates.append(db_task)

    with transaction.atomic():
        Task.objects.bulk_update(
            updates,
            ["early_start", "early_finish", "late_start", "late_finish",
             "total_float", "is_critical"],
        )
        django_project.project_finish = result.project_finish
        django_project.save(update_fields=["project_finish"])
```

## 2. Call the scheduler from a Celery task

Always dispatch scheduling work asynchronously. Use the transactional outbox
pattern so that the Celery task is never dispatched before its triggering DB
change is committed:

```python
# scheduling/tasks.py
from celery import shared_task
from django.db import transaction
from .services import apply_schedule_result, build_scheduler_project
from .models import Project
from trueppm_scheduler import schedule


@shared_task(bind=True, max_retries=3, default_retry_delay=5)
def recalculate_schedule(self, project_id: str,
                          changed_task_ids: list[str] | None = None) -> None:
    """Recompute CPM for the given project.

    changed_task_ids: when provided, the scheduler performs an incremental pass
    over the affected subgraph only (Wave 3 / issue #8). Falls back to a full
    recompute when None or when the change set exceeds 25% of tasks.
    """
    try:
        project = Project.objects.select_related("calendar").get(pk=project_id)
    except Project.DoesNotExist:
        return  # project deleted between dispatch and execution — ignore

    scheduler_project = build_scheduler_project(project)
    result = schedule(scheduler_project, changed_task_ids=changed_task_ids)
    apply_schedule_result(project, result)


# In your view or signal handler — dispatch on commit:
def enqueue_recalculate(project_id: str,
                         changed_task_ids: list[str] | None = None) -> None:
    """Dispatch a schedule recalculation after the current transaction commits."""
    transaction.on_commit(
        lambda: recalculate_schedule.delay(
            str(project_id), changed_task_ids=changed_task_ids
        )
    )
```

:::caution[Never call `.delay()` directly]
Always use `enqueue_recalculate()` (or equivalent `transaction.on_commit()`
wrapper). Calling `.delay()` inside a transaction means the task may execute
before the database change is visible, resulting in a stale CPM result.
:::

## 3. Trigger on task update

Wire `enqueue_recalculate` to your task update view:

```python
# tasks/views.py
from rest_framework.viewsets import ModelViewSet
from scheduling.services import enqueue_recalculate


class TaskViewSet(ModelViewSet):
    def perform_update(self, serializer):
        instance = serializer.save()
        # Only fields that affect the CPM graph need a recalculation.
        cpm_fields = {"duration", "early_start", "dependencies"}
        if cpm_fields & set(serializer.validated_data):
            enqueue_recalculate(
                project_id=instance.project_id,
                changed_task_ids=[str(instance.pk)],
            )
```

## 4. Calendar from the database

See [03-calendar-aware.ipynb](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/03-calendar-aware.ipynb)
for a runnable example of building a `Calendar` object from database records.

## See also

- [FastAPI Integration](/integration/fastapi/) — lighter wrapper for microservices
- [Standalone Usage](/integration/standalone/) — no web framework
- [CPM Scheduler reference](/features/scheduler/) — full API reference
