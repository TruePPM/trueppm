"""Celery tasks for the scheduling app."""

from __future__ import annotations

import logging
from datetime import timedelta

import redis as redis_lib
from celery.exceptions import SoftTimeLimitExceeded
from django.db import OperationalError

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# Exceptions that are transient and should trigger Celery's built-in retry.
_RETRIABLE = (ConnectionError, redis_lib.ConnectionError, OperationalError)


@idempotent_task(
    lock_key_template="schedule_lock:{0}",
    lock_ttl=300,
    on_contention="queue",
    queue_countdown=10,
    max_queue_attempts=5,
    autoretry_for=_RETRIABLE,
    retry_backoff=30,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    soft_time_limit=480,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
)
def recalculate_schedule(self: object, project_id: str) -> None:
    """Run CPM on a project and persist the results.

    Idempotency is enforced by the ``@idempotent_task`` decorator which
    acquires a Redis SET NX lock keyed by project_id and auto-extends it
    for long-running schedules. On lock contention the task is re-queued
    with a 10-second countdown (up to 5 attempts).

    After writing CPM results back to the database this task broadcasts a
    cpm_complete event to the project's WebSocket group.

    Args:
        project_id: UUID string of the project to reschedule.
    """
    # Broadcast that CPM is now running so the frontend can show the badge.
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    broadcast_board_event(project_id=project_id, event_type="cpm_queued", payload={})

    try:
        _run_schedule(project_id)
    except SoftTimeLimitExceeded:
        logger.error(
            "recalculate_schedule: soft time limit exceeded for project %s",
            project_id,
        )
        broadcast_board_event(
            project_id=project_id,
            event_type="cpm_error",
            payload={"error": "timeout"},
        )
        _dead_letter_current(self, project_id, SoftTimeLimitExceeded("CPM computation timed out"))


def _dead_letter_current(task: object, project_id: str, exc: BaseException) -> None:
    """Write a FailedTask record for the current task invocation."""
    from trueppm_api.apps.scheduling.deadletter import record_failed_task

    request = task.request  # type: ignore[attr-defined]
    record_failed_task(
        task_name=getattr(task, "name", "unknown"),
        task_id=request.id or "unknown",
        args=[project_id],
        kwargs={},
        exception=exc,
    )


def _run_schedule(project_id: str) -> None:
    """Load tasks/dependencies, run CPM, bulk_update results, broadcast completion."""
    from trueppm_scheduler.engine import CyclicDependencyError, schedule
    from trueppm_scheduler.models import Calendar as SchedCalendar
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject
    from trueppm_scheduler.models import Task as SchedTask

    from trueppm_api.apps.projects.models import Dependency, Project, Task

    try:
        db_project = (
            Project.objects.select_related("calendar")
            .prefetch_related("tasks", "tasks__predecessors")
            .get(pk=project_id)
        )
    except Project.DoesNotExist:
        logger.warning("recalculate_schedule: project %s not found, skipping", project_id)
        return

    db_tasks = list(db_project.tasks.all())
    if not db_tasks:
        logger.info("recalculate_schedule: project %s has no tasks, skipping", project_id)
        return

    # Build a trueppm_scheduler.Calendar from the project's calendar (or default).
    cal = db_project.calendar
    sched_calendar = SchedCalendar(
        working_days=cal.working_days if cal else 31,
        hours_per_day=cal.hours_per_day if cal else 8.0,
        timezone=cal.timezone if cal else "UTC",
    )

    # Convert Django Task objects to scheduler dataclasses.
    sched_tasks = [
        SchedTask(
            id=str(t.id),
            name=t.name,
            duration=timedelta(days=t.duration),
            planned_start=t.planned_start,
            percent_complete=t.percent_complete,
            optimistic_duration=timedelta(days=t.optimistic_duration)
            if t.optimistic_duration is not None
            else None,
            most_likely_duration=timedelta(days=t.most_likely_duration)
            if t.most_likely_duration is not None
            else None,
            pessimistic_duration=timedelta(days=t.pessimistic_duration)
            if t.pessimistic_duration is not None
            else None,
        )
        for t in db_tasks
    ]

    # Convert Django Dependency objects to scheduler dataclasses.
    db_deps = list(
        Dependency.objects.filter(predecessor__project_id=project_id).select_related(
            "predecessor", "successor"
        )
    )
    sched_deps = [
        SchedDependency(
            predecessor_id=str(d.predecessor_id),
            successor_id=str(d.successor_id),
            dep_type=DependencyType(d.dep_type),
            lag=timedelta(days=d.lag),
        )
        for d in db_deps
    ]

    sched_project = SchedProject(
        id=project_id,
        name=db_project.name,
        start_date=db_project.start_date,
        tasks=sched_tasks,
        dependencies=sched_deps,
        calendar=sched_calendar,
    )

    try:
        result = schedule(sched_project)
    except CyclicDependencyError as exc:
        logger.warning(
            "recalculate_schedule: cyclic dependency in project %s: %s",
            project_id,
            exc.cycle,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        broadcast_board_event(
            project_id=project_id,
            event_type="cpm_error",
            payload={"error": "cyclic_dependency", "cycle": exc.cycle},
        )
        return
    except Exception:
        logger.exception("recalculate_schedule: CPM failed for project %s", project_id)
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        broadcast_board_event(
            project_id=project_id,
            event_type="cpm_error",
            payload={"error": "internal_error", "cycle": []},
        )
        return

    # Build a map from task id string to computed CPM values.
    result_map = {t.id: t for t in result.tasks}

    # Write CPM output back to Task rows via bulk_update (not save()).
    #
    # INTENTIONAL DESIGN: bulk_update bypasses VersionedModel.save(), so
    # server_version is NOT incremented for CPM field writes. This is correct:
    # CPM fields (early_start, is_critical, etc.) are read-only computed values
    # that the mobile client derives locally from the same scheduler. Bumping
    # server_version here would flood every connected mobile client with sync
    # deltas on every schedule recalc — including ones triggered by their own
    # edits. Do NOT change this to save() without understanding that consequence.
    tasks_to_update: list[Task] = []
    for db_task in db_tasks:
        sched = result_map.get(str(db_task.id))
        if sched is None:
            continue
        db_task.early_start = sched.early_start
        db_task.early_finish = sched.early_finish
        db_task.late_start = sched.late_start
        db_task.late_finish = sched.late_finish
        db_task.total_float = sched.total_float.days if sched.total_float else None
        db_task.free_float = sched.free_float.days if sched.free_float else None
        db_task.is_critical = sched.is_critical
        tasks_to_update.append(db_task)

    Task.objects.bulk_update(
        tasks_to_update,
        [
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
        ],
    )

    logger.info(
        "recalculate_schedule: updated %d tasks for project %s (finish=%s)",
        len(tasks_to_update),
        project_id,
        result.project_finish,
    )

    # Broadcast CPM completion event to connected WebSocket clients.
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    cpm_payload = {
        "project_finish": result.project_finish.isoformat(),
        "critical_path": result.critical_path,
    }
    broadcast_board_event(
        project_id=project_id,
        event_type="cpm_complete",
        payload=cpm_payload,
    )

    # Dispatch schedule.recalculated webhook to external subscribers.
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    dispatch_webhooks(
        project_id=project_id,
        event_type="schedule.recalculated",
        payload={"project": project_id, **cpm_payload},
    )
