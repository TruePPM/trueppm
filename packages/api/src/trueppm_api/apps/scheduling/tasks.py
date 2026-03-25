"""Celery tasks for the scheduling app."""

from __future__ import annotations

import logging
from datetime import timedelta

import redis as redis_lib
from celery import shared_task

logger = logging.getLogger(__name__)

# Redis SET NX lock TTL — prevents two workers from scheduling the same project
# simultaneously. On lock collision the task re-queues itself with a 10-second
# countdown so the second update is never silently dropped.
_LOCK_TTL_SECONDS = 300
_REQUEUE_COUNTDOWN = 10


@shared_task(bind=True)  # type: ignore[untyped-decorator]
def recalculate_schedule(self: object, project_id: str) -> None:
    """Run CPM on a project and persist the results.

    Idempotency is enforced via a Redis SET NX lock keyed by project_id.
    If another worker holds the lock the task re-queues itself after
    _REQUEUE_COUNTDOWN seconds so that the triggering mutation is not lost.

    After writing CPM results back to the database this task broadcasts a
    cpm_complete event to the project's WebSocket group.

    Args:
        project_id: UUID string of the project to reschedule.
    """
    from django.conf import settings

    redis_client = redis_lib.from_url(settings.REDIS_URL)
    lock_key = f"schedule_lock:{project_id}"

    # Attempt to acquire an exclusive lock (SET NX with TTL).
    acquired = redis_client.set(lock_key, "1", nx=True, ex=_LOCK_TTL_SECONDS)
    if not acquired:
        logger.info(
            "recalculate_schedule: lock held for project %s, re-queuing in %ds",
            project_id,
            _REQUEUE_COUNTDOWN,
        )
        self.apply_async(args=[project_id], countdown=_REQUEUE_COUNTDOWN)  # type: ignore[attr-defined]
        return

    # Broadcast that CPM is now running so the frontend can show the badge.
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    broadcast_board_event(project_id=project_id, event_type="cpm_queued", payload={})

    try:
        _run_schedule(project_id)
    finally:
        redis_client.delete(lock_key)


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

    broadcast_board_event(
        project_id=project_id,
        event_type="cpm_complete",
        payload={
            "project_finish": result.project_finish.isoformat(),
            "critical_path": result.critical_path,
        },
    )
