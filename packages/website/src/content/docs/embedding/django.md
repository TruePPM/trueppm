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
    Calendar, DateRange, DeliveryMode, Dependency, DependencyType,
    Project as SchedulerProject, Task as SchedulerTask,
    ScheduleResult, schedule,
)
from .models import Project, Task  # your Django models


def _to_scheduler_calendar(cal) -> Calendar:
    return Calendar(
        working_days=cal.working_days,
        # hours_per_day and timezone are reserved-but-inert: the engine schedules
        # in whole-day units only, so these two fields are carried for API/model
        # parity but do not change any computed date. Pass your real values
        # anyway (round-tripping matters if you serialize the Calendar back out).
        hours_per_day=cal.hours_per_day,
        timezone=cal.timezone,
        exceptions=[
            DateRange(start=exc.start_date, end=exc.end_date)
            for exc in cal.exceptions.all()
        ],
    )


def build_scheduler_project(django_project: Project) -> SchedulerProject:
    """Serialize a Django Project to the pure-Python scheduler representation.

    Passes every recorded input the engine reads: progress and actuals, the
    start-no-earlier-than date, the status (data) date, per-task calendars, and
    the agile inputs. Leave one out and the schedule silently ignores it.
    """
    scheduler_cal = _to_scheduler_calendar(django_project.calendar)
    db_tasks = list(django_project.tasks.all())

    # Per-task calendars: register each distinct calendar under its id. A task's
    # calendar_id must have an entry here, or the engine refuses the project with
    # InvalidScheduleInput rather than scheduling it on the project calendar.
    calendars = {
        str(t.calendar_id): _to_scheduler_calendar(t.calendar)
        for t in db_tasks
        if t.calendar_id is not None
    }

    tasks = [
        SchedulerTask(
            id=str(t.pk),
            name=t.name,
            duration=t.duration,
            optimistic_duration=t.optimistic_duration,
            most_likely_duration=t.most_likely_duration,
            pessimistic_duration=t.pessimistic_duration,
            # Progress (ADR-0132): percent_complete is 0-100. A task with an
            # actual_finish is pinned to its recorded dates, not rescheduled.
            percent_complete=t.percent_complete,
            actual_start=t.actual_start,
            actual_finish=t.actual_finish,
            # Start-no-earlier-than constraint.
            planned_start=t.planned_start,
            calendar_id=str(t.calendar_id) if t.calendar_id is not None else None,
            # Agile-aware Monte Carlo inputs (None means waterfall).
            delivery_mode=DeliveryMode(t.delivery_mode) if t.delivery_mode else None,
            story_points=t.story_points,
            # Hand back the milestone edge the previous run persisted. The engine
            # reads it only on a completed milestone; it is ignored on any other
            # task, and None is always safe.
            live_day_end_on=t.early_finish if t.milestone_at_day_end else None,
        )
        for t in db_tasks
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
        calendars=calendars or None,
        # The data date: completed work is held fixed and remaining work is
        # scheduled no earlier than this. The engine never reads the clock, so
        # resolve a null status date to today here.
        status_date=django_project.status_date or date.today(),
        velocity_samples=django_project.velocity_samples,
        sprint_length_days=django_project.sprint_length_days,
    )


_RESULT_FIELDS = [
    "early_start", "early_finish", "late_start", "late_finish",
    "total_float", "free_float", "is_critical",
    "scheduled_start", "milestone_at_day_end",
]


def apply_schedule_result(django_project: Project, result: ScheduleResult) -> None:
    """Write CPM results back to the database in bulk."""
    from django.db import transaction

    task_map = {str(t.id): t for t in django_project.tasks.all()}

    updates = []
    for sched_task in result.tasks:
        db_task = task_map.get(sched_task.id)
        if db_task is None:
            continue
        for name in _RESULT_FIELDS:
            setattr(db_task, name, getattr(sched_task, name))
        updates.append(db_task)

    with transaction.atomic():
        Task.objects.bulk_update(updates, _RESULT_FIELDS)
        django_project.project_finish = result.project_finish
        django_project.save(update_fields=["project_finish"])
```

Three of the persisted outputs are not decoration:

- `scheduled_start` is the task's whole span. For an in-progress task,
  `early_start` is only the remaining-work window, so draw bars from
  `scheduled_start`.
- `free_float` is separate from `total_float`; persist both.
- `milestone_at_day_end` says which edge of the shown day a milestone sits on.
  The end of a Friday and the start of the next Monday are the same point in
  working time, so two shown days must never be diffed as a slip. Persist it with
  `early_finish`, and `build_scheduler_project()` hands it back on the next run
  through `live_day_end_on`.

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
def recalculate_schedule(self, project_id: str) -> None:
    """Recompute CPM for the given project."""
    try:
        project = Project.objects.select_related("calendar").get(pk=project_id)
    except Project.DoesNotExist:
        return  # project deleted between dispatch and execution — ignore

    scheduler_project = build_scheduler_project(project)
    result = schedule(scheduler_project)
    apply_schedule_result(project, result)


# In your view or signal handler — dispatch on commit:
def enqueue_recalculate(project_id: str) -> None:
    """Dispatch a schedule recalculation after the current transaction commits."""
    transaction.on_commit(
        lambda: recalculate_schedule.delay(str(project_id))
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
from scheduling.tasks import enqueue_recalculate


class TaskViewSet(ModelViewSet):
    def perform_update(self, serializer):
        instance = serializer.save()
        # Only fields that affect the CPM graph need a recalculation.
        cpm_fields = {
            "duration", "dependencies", "percent_complete", "planned_start",
            "actual_start", "actual_finish", "calendar",
        }
        if cpm_fields & set(serializer.validated_data):
            enqueue_recalculate(project_id=instance.project_id)
```

## 4. Calendar from the database

See [03-calendar-aware.ipynb](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/notebooks/03-calendar-aware.ipynb)
for a runnable example of building a `Calendar` object from database records.

## See also

- [FastAPI Integration](/embedding/fastapi/) — lighter wrapper for microservices
- [Standalone Usage](/embedding/standalone/) — no web framework
- [CPM Scheduler reference](/features/scheduler/) — full API reference
