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
from datetime import date, datetime, timedelta
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


def _initials(name: str) -> str:
    """Two-letter uppercase initials from a person's display name."""
    parts = [p for p in name.split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def capacity_summary(sprint: Any) -> dict[str, Any]:
    """Compute per-person committed/available hours and aggregate totals.

    For each resource assigned to a task in the sprint, sum the committed
    work hours (``units × working_days × hours_per_day``) and compare to the
    resource's available hours. Returns every assigned member (not only
    over-allocated ones) plus an aggregate ``totals`` block — the Sprints
    capacity preflight panel (#228) renders both shapes from the same
    payload, so we shape it once here.

    Hours-per-day comes from the project calendar (8.0 default). Working
    days honour the calendar's ``working_days`` bitmask. ``pto_days`` is a
    placeholder zero until a dedicated time-off model lands.
    """
    from trueppm_api.apps.resources.models import TaskResource

    project = sprint.project
    cal = project.calendar
    hours_per_day = float(cal.hours_per_day) if cal else 8.0
    wd_mask = cal.working_days if cal else 31
    working_days = _working_days(sprint.start_date, sprint.finish_date, wd_mask)
    if working_days <= 0:
        return {
            "members": [],
            "totals": {
                "committed_hours": 0.0,
                "available_hours": 0.0,
                "ratio": 0.0,
                "buffer_hours": 0.0,
                "label": "on_track",
                "pto_days": 0,
            },
            "working_days": 0,
            "hours_per_day": hours_per_day,
        }

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

    members: list[dict[str, Any]] = []
    total_committed = 0.0
    total_available = 0.0
    for resource_id, data in by_resource.items():
        committed_hours = float(data["committed"]) * working_days * hours_per_day
        available_hours = float(data["max_units"]) * working_days * hours_per_day
        ratio = committed_hours / available_hours if available_hours > 0 else 0.0
        members.append(
            {
                "member_id": str(resource_id),
                "member_name": data["name"],
                "initials": _initials(data["name"]),
                "committed_hours": round(committed_hours, 2),
                "available_hours": round(available_hours, 2),
                "ratio": round(ratio, 4),
                "is_over": committed_hours > available_hours,
            }
        )
        total_committed += committed_hours
        total_available += available_hours

    members.sort(key=lambda m: m["member_name"])
    total_ratio = total_committed / total_available if total_available > 0 else 0.0
    if total_ratio > 1.0:
        label = "over_capacity"
    elif total_ratio >= 0.9:
        label = "at_risk"
    else:
        label = "on_track"

    return {
        "members": members,
        "totals": {
            "committed_hours": round(total_committed, 2),
            "available_hours": round(total_available, 2),
            "ratio": round(total_ratio, 4),
            "buffer_hours": round(total_available - total_committed, 2),
            "label": label,
            "pto_days": 0,
        },
        "working_days": working_days,
        "hours_per_day": hours_per_day,
    }


def capacity_check(sprint: Any) -> list[dict[str, Any]]:
    """Backwards-compatible wrapper: returns only the over-capacity warnings.

    Used by the activate endpoint (ADR-0037 Q2 amendment) which only surfaces
    over-allocated members. Full per-member data is exposed via
    ``capacity_summary`` and the ``/api/v1/sprints/<pk>/capacity/`` endpoint.
    """
    summary = capacity_summary(sprint)
    sprint_total_points = sprint.committed_points or 0
    warnings: list[dict[str, Any]] = []
    for member in summary["members"]:
        if not member["is_over"]:
            continue
        committed_hours = member["committed_hours"]
        available_hours = member["available_hours"]
        ratio = available_hours / committed_hours if committed_hours else 0
        suggested = round(sprint_total_points * ratio) if sprint_total_points else 0
        warnings.append(
            {
                "type": "over_capacity",
                "member_id": member["member_id"],
                "member_name": member["member_name"],
                "committed_hours": committed_hours,
                "available_hours": available_hours,
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
# Project burn chart — HistoricalTask replay (issue #239 / ADR-0022)
# ---------------------------------------------------------------------------


def _date_range_inclusive(start: date, end: date) -> list[date]:
    """Return every date from start to end inclusive, ascending."""
    days: list[date] = []
    cur = start
    while cur <= end:
        days.append(cur)
        cur += timedelta(days=1)
    return days


def burn_series(
    project_id: str | uuid.UUID,
    *,
    chart_type: str,
    since: date,
    until: date,
    metric: str = "tasks",
) -> dict[str, Any]:
    """Compute a daily burn series for a project from HistoricalTask snapshots.

    Replays the HistoricalTask table to reconstruct task state on each day
    in ``[since, until]``. For each task we keep its most recent state
    (status + story_points) whose ``history_date`` is on or before that
    day. From those daily snapshots we derive ``actual`` (remaining for
    burndown, completed for burnup), ``scope`` (total committed work), and
    a linear ``ideal`` curve.

    Args:
        project_id: Project UUID.
        chart_type: ``burndown`` or ``burnup``. Drives which actual curve
            is returned (remaining vs completed).
        since: Window start (inclusive).
        until: Window end (inclusive).
        metric: ``tasks`` (default; counts) or ``points`` (sums
            ``story_points`` — null points contribute zero).

    Returns:
        Dict shaped like::

            {
              "chart_type": "burndown",
              "metric": "tasks",
              "since": "...",
              "until": "...",
              "series": [{"date", "actual", "ideal", "scope"}, ...],
              "baseline_series": [{"date", "planned"}, ...] | absent,
            }

    The ``baseline_series`` key is only present when the project has an
    active baseline; ``planned`` for each date is the count (or point sum)
    of baselined tasks whose snapshot finish date is greater than that
    date — a proper "planned remaining" curve, not a linear interpolation.
    """
    from trueppm_api.apps.projects.models import (
        Baseline,
        BaselineTask,
        Task,
        TaskStatus,
    )

    HistoricalTask = Task.history.model

    if chart_type not in ("burndown", "burnup"):
        raise ValueError(f"Invalid chart_type: {chart_type}")
    if metric not in ("tasks", "points"):
        raise ValueError(f"Invalid metric: {metric}")
    if until < since:
        raise ValueError("`until` must be on or after `since`")

    days = _date_range_inclusive(since, until)
    end_of_until = datetime.combine(
        until, datetime.max.time(), tzinfo=timezone.get_current_timezone()
    )

    # Pull every history row for tasks in the project up to end_of_until,
    # ordered so that .latest-by-task wins. Newest first lets us drop
    # duplicates per task efficiently.
    history_rows = list(
        HistoricalTask.objects.filter(
            project_id=project_id,
            history_date__lte=end_of_until,
        )
        .order_by("id", "-history_date")
        .values("id", "history_date", "status", "story_points", "history_type", "is_deleted")
    )

    # Index history by task id, sorted descending by history_date so that
    # `bisect`-style lookups can find "latest state at date D" in O(log n).
    by_task: dict[Any, list[dict[str, Any]]] = {}
    for row in history_rows:
        by_task.setdefault(row["id"], []).append(row)
    # Each list is already newest-first because of the order_by above.

    def _value(row: dict[str, Any]) -> int:
        if metric == "points":
            return int(row.get("story_points") or 0)
        return 1

    series: list[dict[str, Any]] = []
    for day in days:
        end_of_day = datetime.combine(
            day, datetime.max.time(), tzinfo=timezone.get_current_timezone()
        )
        scope = 0
        completed = 0
        for rows in by_task.values():
            # First row whose history_date <= end_of_day (rows are newest-first).
            state = next((r for r in rows if r["history_date"] <= end_of_day), None)
            if state is None:
                continue
            if state["history_type"] == "-" or state.get("is_deleted"):
                continue  # task didn't exist (or was deleted) on this day
            value = _value(state)
            scope += value
            if state["status"] == TaskStatus.COMPLETE:
                completed += value
        remaining = scope - completed
        series.append(
            {
                "date": day.isoformat(),
                "scope": scope,
                "actual": remaining if chart_type == "burndown" else completed,
            }
        )

    # Linear ideal curve. Burndown anchors to the first day's scope (the
    # commitment baseline draws down to zero); burnup anchors to the final
    # day's scope (the team plans to complete *current* scope by end).
    # This asymmetry matches how PMs read each chart.
    initial_scope = series[0]["scope"] if series else 0
    final_scope = series[-1]["scope"] if series else 0
    span_days = max(len(days) - 1, 1)
    for index, point in enumerate(series):
        progress = index / span_days
        if chart_type == "burndown":
            point["ideal"] = round(initial_scope * (1 - progress), 2)
        else:
            point["ideal"] = round(final_scope * progress, 2)

    payload: dict[str, Any] = {
        "chart_type": chart_type,
        "metric": metric,
        "since": since.isoformat(),
        "until": until.isoformat(),
        "series": series,
    }

    # Baseline overlay — present only when an active baseline exists.
    active_baseline = Baseline.objects.filter(
        project_id=project_id, is_active=True, is_deleted=False
    ).first()
    if active_baseline is not None:
        baseline_tasks = list(
            BaselineTask.objects.filter(baseline=active_baseline).values("finish")
        )
        if baseline_tasks:
            total = len(baseline_tasks)
            baseline_series: list[dict[str, Any]] = []
            for day in days:
                done = sum(
                    1 for t in baseline_tasks if t["finish"] is not None and t["finish"] <= day
                )
                if chart_type == "burndown":
                    baseline_series.append({"date": day.isoformat(), "planned": total - done})
                else:
                    baseline_series.append({"date": day.isoformat(), "planned": done})
            payload["baseline_series"] = baseline_series

    return payload


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
