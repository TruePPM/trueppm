"""Service layer for project-scoped async operations.

Sprint close uses the transactional outbox pattern: ``enqueue_sprint_close``
writes a ``SprintCloseRequest`` row inside the same DB transaction as the
sprint state transition and attempts immediate Celery dispatch on commit. If
the broker is unavailable the row stays PENDING and the
``drain_sprint_close_requests`` Beat task picks it up within 30 seconds.

See ADR-0037 for the full design.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sprint close — outbox enqueue
# ---------------------------------------------------------------------------


def enqueue_sprint_close(
    sprint_id: str | uuid.UUID,
    *,
    carry_over_to: str = "backlog",
    requested_by: Any | None = None,
) -> Any:
    """Insert a SprintCloseRequest outbox row and best-effort dispatch.

    Safe to call from inside an HTTP request transaction — Celery dispatch is
    deferred via ``transaction.on_commit`` so a rolled-back request never
    fires the worker. If immediate dispatch fails (broker down) the row
    remains PENDING and the drain Beat task processes it within 30 seconds.

    Args:
        sprint_id: UUID of the sprint to close.
        carry_over_to: Either ``"backlog"`` (default), ``"none"``, or a
            sprint UUID string. The drain task interprets this when
            reassigning incomplete tasks.
        requested_by: User instance who initiated the close (nullable).

    Returns:
        The created ``SprintCloseRequest`` instance.
    """
    from trueppm_api.apps.projects.models import SprintCloseRequest

    req = SprintCloseRequest.objects.create(
        sprint_id=sprint_id,
        carry_over_to=carry_over_to,
        requested_by=requested_by,
    )

    def _dispatch() -> None:
        from trueppm_api.apps.projects.tasks import close_sprint

        try:
            close_sprint.delay(str(req.id))
        except Exception:
            logger.warning(
                "enqueue_sprint_close: could not immediately dispatch sprint=%s "
                "— drain task will pick it up within 30 s",
                sprint_id,
            )

    transaction.on_commit(_dispatch)
    return req


# ---------------------------------------------------------------------------
# Capacity check — non-blocking warnings on activate
# ---------------------------------------------------------------------------


def _working_days(start: date, finish: date, working_days_mask: int = 31) -> int:
    """Count working days in [start, finish] inclusive using a weekday bitmask.

    Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64. Default 31 = Mon–Fri.
    """
    total = 0
    cur = start
    while cur <= finish:
        # Python: Monday=0 → bit 1; map weekday() to bitmask.
        bit = 1 << cur.weekday()
        if working_days_mask & bit:
            total += 1
        cur += timedelta(days=1)
    return total


def capacity_check(sprint: Any) -> list[dict[str, Any]]:
    """Compute non-blocking over-allocation warnings for a sprint (ADR-0037 Q2).

    For each resource assigned to a task in the sprint, sum the committed
    work hours (units * working_days * hours_per_day) and compare to the
    resource's available hours. Returns one warning entry per over-allocated
    member.

    Hours-per-day is read from the project's calendar (or 8.0 default).
    Working days span the sprint window honoring the calendar's
    ``working_days`` bitmask.

    Returns:
        List of dicts shaped like::

            {
              "type": "over_capacity",
              "member_id": str,
              "member_name": str,
              "committed_hours": float,
              "available_hours": float,
              "suggested_commitment_points": int,
            }
    """
    from trueppm_api.apps.resources.models import TaskResource

    project = sprint.project
    cal = project.calendar
    hours_per_day = float(cal.hours_per_day) if cal else 8.0
    wd_mask = cal.working_days if cal else 31
    working_days = _working_days(sprint.start_date, sprint.finish_date, wd_mask)
    if working_days <= 0:
        return []

    assignments = (
        TaskResource.objects.filter(task__sprint_id=sprint.pk, task__is_deleted=False)
        .select_related("resource")
        .values_list("resource_id", "resource__name", "resource__max_units", "units")
    )
    by_resource: dict[Any, dict[str, Any]] = {}
    for resource_id, resource_name, max_units, units in assignments:
        entry = by_resource.setdefault(
            resource_id,
            {
                "name": resource_name,
                "max_units": max_units or Decimal("1.0"),
                "committed": Decimal("0"),
            },
        )
        entry["committed"] += units or Decimal("0")

    warnings: list[dict[str, Any]] = []
    sprint_total_points = sprint.committed_points or 0
    for resource_id, data in by_resource.items():
        committed_hours = float(data["committed"]) * working_days * hours_per_day
        available_hours = float(data["max_units"]) * working_days * hours_per_day
        if committed_hours > available_hours:
            ratio = available_hours / committed_hours if committed_hours else 0
            suggested = round(sprint_total_points * ratio) if sprint_total_points else 0
            warnings.append(
                {
                    "type": "over_capacity",
                    "member_id": str(resource_id),
                    "member_name": data["name"],
                    "committed_hours": round(committed_hours, 2),
                    "available_hours": round(available_hours, 2),
                    "suggested_commitment_points": suggested,
                }
            )
    return warnings


# ---------------------------------------------------------------------------
# Burndown — real-time UPSERT helper
# ---------------------------------------------------------------------------


def upsert_burndown_for_sprint(sprint: Any, snapshot_date: date | None = None) -> None:
    """Compute and UPSERT today's burn snapshot for a sprint.

    Called inline from the task_status_changed signal; safe under
    concurrency thanks to the unique ``(sprint, snapshot_date)`` constraint.
    Idempotent — a second call on the same day overwrites with the latest
    figures.

    Args:
        sprint: Sprint instance (must be ACTIVE for the signal path).
        snapshot_date: Date to write; defaults to today (UTC).
    """
    from django.db import IntegrityError

    from trueppm_api.apps.projects.models import (
        SprintBurnSnapshot,
        Task,
        TaskStatus,
    )

    if snapshot_date is None:
        snapshot_date = timezone.localdate()

    tasks = list(
        Task.objects.filter(sprint_id=sprint.pk, is_deleted=False).values_list(
            "status", "story_points"
        )
    )
    completed_points = sum(p or 0 for s, p in tasks if s == TaskStatus.COMPLETE)
    completed_count = sum(1 for s, _p in tasks if s == TaskStatus.COMPLETE)
    remaining_points = sum(p or 0 for s, p in tasks if s != TaskStatus.COMPLETE)
    remaining_count = sum(1 for s, _p in tasks if s != TaskStatus.COMPLETE)

    committed = sprint.committed_points or 0
    committed_count_initial = sprint.committed_task_count or 0
    # Scope change: positive when the sprint has gained more total points than
    # it started with (mid-sprint additions), negative when work was removed.
    current_total_points = remaining_points + completed_points
    current_total_count = remaining_count + completed_count
    scope_change_points = current_total_points - committed
    scope_change_count = current_total_count - committed_count_initial

    defaults = {
        "remaining_points": remaining_points,
        "remaining_task_count": remaining_count,
        "completed_points": completed_points,
        "completed_task_count": completed_count,
        "scope_change_points": scope_change_points,
        "scope_change_task_count": scope_change_count,
    }
    try:
        SprintBurnSnapshot.objects.update_or_create(
            sprint_id=sprint.pk,
            snapshot_date=snapshot_date,
            defaults=defaults,
        )
    except IntegrityError:
        # Concurrent insert lost the race — retry the update path explicitly.
        SprintBurnSnapshot.objects.filter(sprint_id=sprint.pk, snapshot_date=snapshot_date).update(
            **defaults
        )


# ---------------------------------------------------------------------------
# Velocity — rolling stats over closed sprints
# ---------------------------------------------------------------------------


def velocity_summary(project_id: str | uuid.UUID) -> dict[str, Any]:
    """Return rolling velocity stats and forecast range for a project.

    Uses the last 8 closed sprints (per ADR-0037). For each metric (points,
    tasks) returns rolling avg, stdev, and a forecast range of avg ± 1 stdev
    rounded to int. Returns null fields when there are fewer than two closed
    sprints (stdev undefined).
    """
    import statistics

    from trueppm_api.apps.projects.models import Sprint, SprintState

    closed = list(
        Sprint.objects.filter(
            project_id=project_id,
            state=SprintState.COMPLETED,
            is_deleted=False,
        ).order_by("-closed_at")[:8]
    )

    points: list[int] = [s.completed_points for s in closed if s.completed_points is not None]
    counts: list[int] = [
        s.completed_task_count for s in closed if s.completed_task_count is not None
    ]

    def _stats(values: list[int]) -> tuple[float | None, float | None, int | None, int | None]:
        if not values:
            return None, None, None, None
        avg = sum(values) / len(values)
        if len(values) < 2:
            return round(avg, 2), None, None, None
        sd = statistics.stdev(values)
        low = max(0, round(avg - sd))
        high = round(avg + sd)
        return round(avg, 2), round(sd, 2), low, high

    avg_p, sd_p, low_p, high_p = _stats(points)
    avg_t, sd_t, _low_t, _high_t = _stats(counts)

    return {
        "sprints": [
            {
                "id": str(s.pk),
                "name": s.name,
                "start_date": s.start_date.isoformat(),
                "finish_date": s.finish_date.isoformat(),
                "committed_points": s.committed_points,
                "completed_points": s.completed_points,
                "committed_task_count": s.committed_task_count,
                "completed_task_count": s.completed_task_count,
            }
            for s in reversed(closed)
        ],
        "rolling_avg_points": avg_p,
        "rolling_stdev_points": sd_p,
        "forecast_range_low": low_p,
        "forecast_range_high": high_p,
        "rolling_avg_tasks": avg_t,
        "rolling_stdev_tasks": sd_t,
    }


# ---------------------------------------------------------------------------
# Carry-over executor (used by drain task)
# ---------------------------------------------------------------------------


_CARRY_OVER_INCOMPLETE_STATUSES = ("BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW")


def apply_carry_over(sprint: Any, carry_over_to: str) -> None:
    """Reassign incomplete tasks per the carry-over policy.

    Called from inside ``close_sprint`` after ``completed_*`` is snapshotted
    and the sprint state has been advanced. ``completed_*`` reflects only
    tasks that completed within the sprint window — the carry-over move is
    pure FK reassignment.
    """
    from trueppm_api.apps.projects.models import Task, TaskStatus

    if carry_over_to == "none":
        return

    incomplete = Task.objects.filter(
        sprint_id=sprint.pk,
        status__in=_CARRY_OVER_INCOMPLETE_STATUSES,
        is_deleted=False,
    )
    if carry_over_to == "backlog":
        incomplete.update(sprint=None, status=TaskStatus.BACKLOG)
        return

    # Otherwise treat as a UUID string referencing another sprint in the
    # same project. Caller is expected to have validated this upstream.
    incomplete.update(sprint_id=carry_over_to)


def snapshot_completed_metrics(sprint: Any) -> None:
    """Compute and store completed_points / completed_task_count from current task state.

    Called inside the close transaction before ``apply_carry_over``. Velocity
    is the count of tasks that completed within the sprint window; subsequent
    carry-over reassignment never inflates these values.
    """
    from trueppm_api.apps.projects.models import Task, TaskStatus

    completed_qs = Task.objects.filter(
        sprint_id=sprint.pk, status=TaskStatus.COMPLETE, is_deleted=False
    )
    completed_points = sum(
        p for p in completed_qs.values_list("story_points", flat=True) if p is not None
    )
    completed_count = completed_qs.count()
    sprint.completed_points = completed_points
    sprint.completed_task_count = completed_count


def snapshot_committed_metrics(sprint: Any) -> None:
    """Compute and store committed_points / committed_task_count on activation.

    Called inside the activate transaction. Snapshots the current sprint
    backlog as the commitment baseline; subsequent scope changes are tracked
    via ``SprintBurnSnapshot.scope_change_*``.
    """
    from trueppm_api.apps.projects.models import Task

    committed_qs = Task.objects.filter(sprint_id=sprint.pk, is_deleted=False)
    committed_points = sum(
        p for p in committed_qs.values_list("story_points", flat=True) if p is not None
    )
    committed_count = committed_qs.count()
    sprint.committed_points = committed_points
    sprint.committed_task_count = committed_count


def all_active_sprint_ids(project_id: str | uuid.UUID) -> Iterable[Any]:
    """Yield sprint IDs currently in ACTIVE state for a project."""
    from trueppm_api.apps.projects.models import Sprint, SprintState

    return Sprint.objects.filter(
        project_id=project_id, state=SprintState.ACTIVE, is_deleted=False
    ).values_list("pk", flat=True)
