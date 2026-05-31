"""Service layer for project-scoped async operations.

Sprint close uses the transactional outbox pattern: ``enqueue_sprint_close``
writes a ``SprintCloseRequest`` row inside the same DB transaction as the
sprint state transition and attempts immediate Celery dispatch on commit. If
the broker is unavailable the row stays PENDING and the
``drain_sprint_close_requests`` Beat task picks it up within 30 seconds.

See ADR-0037 for the full design.
"""

from __future__ import annotations

import calendar
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
# Program rollup config — methodology-aware defaults (ADR-0079, #527)
# ---------------------------------------------------------------------------


def rollup_config_defaults(methodology: str) -> tuple[list[str], str]:
    """Return ``(enabled_kpis, aggregation_policy)`` for a program methodology.

    Single source of truth for new-program seeding and the data migration that
    backfills existing programs. The waterfall and agile sets were chosen from
    the VoC panel — 6 of 8 personas asked for methodology-aware defaults so a
    new program would not need manual configuration on day one.

    Why a tuple rather than a dict: the two call sites (post_save signal,
    data migration) both destructure once and write to two columns.
    """
    from trueppm_api.apps.projects.models import (
        AggregationPolicy,
        Methodology,
        RollupKpi,
    )

    waterfall = [
        RollupKpi.SCHEDULE_HEALTH.value,
        RollupKpi.BASELINE_VARIANCE.value,
        RollupKpi.CRITICAL_TASKS.value,
        RollupKpi.MILESTONE_HEALTH.value,
        RollupKpi.BUDGET_UTILIZATION.value,
        RollupKpi.COST_VARIANCE.value,
    ]
    agile = [
        RollupKpi.MILESTONE_HEALTH.value,
        RollupKpi.P80_COMPLETION.value,
        RollupKpi.AT_RISK_TASKS.value,
        RollupKpi.RISK_SCORE.value,
    ]

    if methodology == Methodology.WATERFALL:
        return (waterfall, AggregationPolicy.WORST.value)
    if methodology == Methodology.AGILE:
        return (agile, AggregationPolicy.WORST.value)
    # HYBRID (and any unexpected value) → union, de-duplicated, order preserved.
    seen: set[str] = set()
    union: list[str] = []
    for kpi in waterfall + agile:
        if kpi not in seen:
            seen.add(kpi)
            union.append(kpi)
    return (union, AggregationPolicy.WORST.value)


# ---------------------------------------------------------------------------
# Sprint close — outbox enqueue
# ---------------------------------------------------------------------------


def enqueue_sprint_close(
    sprint_id: str | uuid.UUID,
    *,
    carry_over_to: str = "backlog",
    pending_disposition: str = "carry",
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
        pending_disposition: ADR-0102 §7 — ``"carry"`` (default) or ``"reject"``;
            how to dispose of tasks still pending acceptance at close.
        requested_by: User instance who initiated the close (nullable).

    Returns:
        The created ``SprintCloseRequest`` instance.
    """
    from trueppm_api.apps.projects.models import SprintCloseRequest

    req = SprintCloseRequest.objects.create(
        sprint_id=sprint_id,
        carry_over_to=carry_over_to,
        pending_disposition=pending_disposition,
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
        .values_list(
            "resource_id",
            "resource__name",
            "resource__max_units",
            "units",
            "task__early_start",
            "task__early_finish",
        )
    )
    by_resource: dict[Any, dict[str, Any]] = {}
    for resource_id, resource_name, max_units, units, task_start, task_end in assignments:
        # Compute working-day overlap between the task window and the sprint.
        # Fall back to the full sprint when CPM dates are not yet available.
        t_start = task_start or sprint.start_date
        t_end = task_end or sprint.finish_date
        overlap_start = max(t_start, sprint.start_date)
        overlap_end = min(t_end, sprint.finish_date)
        task_days = (
            _working_days(overlap_start, overlap_end, wd_mask)
            if overlap_start <= overlap_end
            else 0
        )
        entry = by_resource.setdefault(
            resource_id,
            {
                "name": resource_name,
                "max_units": max_units or Decimal("1.0"),
                "committed": Decimal("0"),
            },
        )
        entry["committed"] += (units or Decimal("0")) * Decimal(str(task_days))

    members: list[dict[str, Any]] = []
    total_committed = 0.0
    total_available = 0.0
    for resource_id, data in by_resource.items():
        # data["committed"] already encodes units × task_working_days per assignment.
        committed_hours = float(data["committed"]) * hours_per_day
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
        TaskStatus,
        committed_sprint_tasks,
    )

    if snapshot_date is None:
        snapshot_date = timezone.localdate()

    # ADR-0102 §2: exclude pending mid-sprint injections — a pending task
    # contributes ZERO to remaining/completed/scope-change points. The burndown
    # line moves only when a task is accepted into the commitment.
    tasks = list(
        committed_sprint_tasks(sprint.pk).values_list("status", "story_points", "remaining_points")
    )
    completed_points = sum(sp or 0 for s, sp, _rp in tasks if s == TaskStatus.COMPLETE)
    completed_count = sum(1 for s, _sp, _rp in tasks if s == TaskStatus.COMPLETE)
    # Use remaining_points when set (issue #366); fall back to story_points for
    # tasks that pre-date the field or haven't been re-estimated mid-sprint.
    remaining_points = sum(
        (rp if rp is not None else (sp or 0)) for s, sp, rp in tasks if s != TaskStatus.COMPLETE
    )
    remaining_count = sum(1 for s, _sp, _rp in tasks if s != TaskStatus.COMPLETE)

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

    # ADR-0065: surface team_velocity_per_day for CPM calibration. Lives behind
    # a function call rather than duplicating the rolling-window logic here so
    # the calibration service and the velocity endpoint stay in sync.
    from trueppm_api.apps.scheduling.services import compute_team_velocity_per_day

    velocity_per_day = compute_team_velocity_per_day(project_id)

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
        "team_velocity_per_day": float(velocity_per_day) if velocity_per_day else None,
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
        if metric == "points":
            # Join baseline task list with live tasks to obtain story_points.
            from trueppm_api.apps.projects.models import Task as _Task

            bt_rows = list(active_baseline.tasks.values("task_id", "finish"))
            live_sp: dict[str, int] = {
                str(tid): sp or 0
                for tid, sp in _Task.objects.filter(
                    id__in=[r["task_id"] for r in bt_rows], is_deleted=False
                ).values_list("id", "story_points")
            }
            baseline_tasks_pts = [(str(r["task_id"]), r["finish"]) for r in bt_rows]
            total_pts = sum(live_sp.get(tid, 0) for tid, _ in baseline_tasks_pts)
            if total_pts > 0:
                baseline_series: list[dict[str, Any]] = []
                for day in days:
                    done_pts = sum(
                        live_sp.get(tid, 0)
                        for tid, finish in baseline_tasks_pts
                        if finish is not None and finish <= day
                    )
                    if chart_type == "burndown":
                        baseline_series.append(
                            {"date": day.isoformat(), "planned": total_pts - done_pts}
                        )
                    else:
                        baseline_series.append({"date": day.isoformat(), "planned": done_pts})
                payload["baseline_series"] = baseline_series
        else:
            baseline_tasks = list(
                BaselineTask.objects.filter(baseline=active_baseline).values("finish")
            )
            if baseline_tasks:
                total = len(baseline_tasks)
                baseline_series = []
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


def apply_carry_over(sprint: Any, carry_over_to: str) -> list[str]:
    """Reassign incomplete tasks per the carry-over policy.

    Called from inside ``close_sprint`` after ``completed_*`` is snapshotted
    and the sprint state has been advanced. ``completed_*`` reflects only
    tasks that completed within the sprint window — the carry-over move is
    pure FK reassignment.

    Returns the IDs of the tasks that were moved, so the caller can broadcast a
    single ``tasks_bulk_mutated`` event — without it, connected clients keep
    showing the carried-over tasks under the just-closed sprint until a refetch.
    """
    from trueppm_api.apps.projects.models import Task, TaskStatus

    if carry_over_to == "none":
        return []

    incomplete = Task.objects.filter(
        sprint_id=sprint.pk,
        status__in=_CARRY_OVER_INCOMPLETE_STATUSES,
        is_deleted=False,
    )
    moved_ids: list[str] = []
    if carry_over_to == "backlog":
        # Iterate to call .save() so VersionedModel bumps server_version on each
        # task — queryset.update() bypasses the model and mobile sync misses it.
        for task in incomplete:
            task.sprint = None
            task.status = TaskStatus.BACKLOG
            task.save(update_fields=["sprint", "status"])
            moved_ids.append(str(task.pk))
        return moved_ids

    # Otherwise treat as a UUID string referencing another sprint in the same
    # project. Caller is expected to have validated this upstream.
    for task in incomplete:
        task.sprint_id = carry_over_to
        task.save(update_fields=["sprint"])
        moved_ids.append(str(task.pk))
    return moved_ids


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
    from trueppm_api.apps.projects.models import committed_sprint_tasks

    # ADR-0102 §2: exclude pending injections from the activation snapshot for
    # symmetry with the recompute-on-accept path (at activation there are no
    # pending tasks, but the filter keeps the helper correct under reuse).
    committed_qs = committed_sprint_tasks(sprint.pk)
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


# ---------------------------------------------------------------------------
# Sprint scope-injection approve-gate (ADR-0102, #881)
# ---------------------------------------------------------------------------


class ScopeAcceptForbidden(Exception):
    """Raised when an actor without the team-owned accept gate attempts a
    scope-change accept/reject (ADR-0102 §3, VoC 🔴 #1 — the Enterprise back-door).

    Carries the stable ``code`` ``scope_accept_forbidden`` so the viewset emits a
    structured 403 the frontend maps without scraping the message. Raised
    *regardless of role ordinal* when the actor is not a real ProjectMembership
    holder at role>=ADMIN on the task's project — so a high-ordinal Enterprise
    custom role (ADR-0072) that is not a project member cannot force-accept.
    """

    code = "scope_accept_forbidden"
    detail = "Sprint scope acceptance is team-owned."


def _assert_scope_gate(scope_change: Any, by: Any) -> None:
    """Enforce the team-owned accept/reject gate (ADR-0102 §3).

    The actor must be an authenticated user holding a real, non-soft-deleted
    ``ProjectMembership`` at role>=ADMIN on the task's project. This is the
    structural close of the management/PMO back-door: an org-level principal
    arrives with no project ``ProjectMembership`` row and is rejected here
    independent of any role ordinal they may hold elsewhere.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role

    if by is None or not getattr(by, "is_authenticated", False):
        raise ScopeAcceptForbidden
    project_id = scope_change.task.project_id
    role = (
        ProjectMembership.objects.filter(project_id=project_id, user=by, is_deleted=False)
        .values_list("role", flat=True)
        .first()
    )
    if role is None or role < Role.ADMIN:
        raise ScopeAcceptForbidden


def record_sprint_scope_change(
    task: Any,
    sprint: Any,
    by: Any,
    goal_impact: bool = False,
    *,
    item_name: str | None = None,
    flag_pending: bool = True,
) -> Any:
    """Record a mid-sprint scope injection (ADR-0101 §5 / ADR-0102 §4).

    The single write path for scope injection: a row is recorded whenever a task
    is linked to an ACTIVE sprint after activation — subtask spawn, direct
    assignment, drawer, or API.

    ``flag_pending`` controls the pending-acceptance gate (ADR-0102 §1):

    - **Direct link** (``flag_pending=True``, default): ``task`` IS the injected
      item now linked to ``sprint``. Sets ``status=PENDING`` on the audit row AND
      ``task.sprint_pending=True`` atomically (one transaction) so the two never
      disagree and the task is excluded from commitment/burndown until accepted.
    - **Subtask spawn** (``flag_pending=False``): the audit row is recorded
      against the already-committed parent ``task`` (display continuity for the
      drawer chip) but the parent is NOT flagged pending — flagging the parent
      would wrongly drop the whole parent from the burndown. ``item_name`` carries
      the spawned subtask's name.

    Fires the ``sprint_scope_changed`` notify-only signal. Pre-activation links
    never call this (they are baseline commitment). Returns the SprintScopeChange.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange
    from trueppm_api.apps.projects.signals import sprint_scope_changed

    with transaction.atomic():
        scope_change = SprintScopeChange.objects.create(
            task=task,
            sprint=sprint,
            subtask_name=item_name if item_name is not None else task.name,
            added_by=by if (by is not None and getattr(by, "is_authenticated", False)) else None,
            goal_impact=goal_impact,
            status=ScopeChangeStatus.PENDING,
        )
        if flag_pending:
            # Flag the task pending via .save() so VersionedModel bumps
            # server_version (mobile sync sees the new pending state) — never a
            # bulk .update().
            task.sprint_pending = True
            task.save(update_fields=["sprint_pending"])

    sprint_scope_changed.send(
        sender=SprintScopeChange,
        scope_change=scope_change,
        task=task,
    )
    return scope_change


def accept_scope_change(scope_change: Any, by: Any) -> Any:
    """Promote a pending scope injection into the sprint commitment (ADR-0102 §4).

    Team-owned gate (role>=ADMIN + project membership). Sets ``status=ACCEPTED``
    and ``task.sprint_pending=False`` in one transaction, writes
    ``history_change_reason``, and — inside ``transaction.on_commit`` — rides the
    existing scope-change recompute path (``upsert_burndown_for_sprint``) plus a
    board broadcast. Idempotent: re-accepting an already-ACCEPTED row is a no-op
    (the status field is the idempotency key; the row is locked for update).

    The ONLY writer of ACCEPTED besides the bulk variant — no auto-accept path.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange, Task
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    _assert_scope_gate(scope_change, by)

    with transaction.atomic():
        locked = (
            SprintScopeChange.objects.select_for_update()
            .select_related("task", "sprint")
            .get(pk=scope_change.pk)
        )
        if locked.status != ScopeChangeStatus.PENDING:
            return locked  # idempotent no-op on an already-decided row
        task = Task.objects.select_for_update().get(pk=locked.task_id)
        locked.status = ScopeChangeStatus.ACCEPTED
        locked.save(update_fields=["status"])
        task.sprint_pending = False
        task._change_reason = "scope accepted into sprint"  # type: ignore[attr-defined]
        task.save(update_fields=["sprint_pending"])

        sprint = locked.sprint
        project_id_str = str(task.project_id)
        sprint_id_str = str(sprint.pk)
        task_id_str = str(task.pk)

        def _on_commit(
            s: Any = sprint,
            pid: str = project_id_str,
            sid: str = sprint_id_str,
            tid: str = task_id_str,
        ) -> None:
            upsert_burndown_for_sprint(s)
            broadcast_board_event(pid, "sprint_scope_changed", {"sprint_id": sid, "task_id": tid})

        transaction.on_commit(_on_commit)
    return locked


def reject_scope_change(scope_change: Any, by: Any) -> Any:
    """Reject a pending scope injection, removing the task from the sprint (ADR-0102 §4).

    Team-owned gate (role>=ADMIN + project membership). Sets ``status=REJECTED``,
    clears ``task.sprint`` (removes from sprint) and forces ``sprint_pending=False``
    in one transaction, writes ``history_change_reason`` (ADR-0098 — so the
    timeline shows "removed from sprint" not a bare "Updated" pill), and rides the
    recompute + broadcast on commit. The REJECTED row is retained for the audit
    trail (cleared on sprint close like every other row). Idempotent.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange, Task
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    _assert_scope_gate(scope_change, by)

    with transaction.atomic():
        locked = (
            SprintScopeChange.objects.select_for_update()
            .select_related("task", "sprint")
            .get(pk=scope_change.pk)
        )
        if locked.status != ScopeChangeStatus.PENDING:
            return locked  # idempotent no-op
        task = Task.objects.select_for_update().get(pk=locked.task_id)
        sprint = locked.sprint
        locked.status = ScopeChangeStatus.REJECTED
        locked.save(update_fields=["status"])
        task.sprint = None
        task.sprint_pending = False
        task._change_reason = "scope rejected — removed from sprint"  # type: ignore[attr-defined]
        task.save(update_fields=["sprint", "sprint_pending"])

        project_id_str = str(task.project_id)
        sprint_id_str = str(sprint.pk)
        task_id_str = str(task.pk)

        def _on_commit(
            s: Any = sprint,
            pid: str = project_id_str,
            sid: str = sprint_id_str,
            tid: str = task_id_str,
        ) -> None:
            upsert_burndown_for_sprint(s)
            broadcast_board_event(pid, "sprint_scope_changed", {"sprint_id": sid, "task_id": tid})

        transaction.on_commit(_on_commit)
    return locked


def pending_scope_advisory(sprint: Any) -> dict[str, Any] | None:
    """Return the close-time pending-scope advisory, or None (ADR-0102 §7).

    A *non-blocking* advisory listing the items still pending acceptance at
    close. Closing is NEVER blocked by this — the team owns its own close
    (sprint sovereignty). Returns None when there is nothing pending.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange

    rows = list(
        SprintScopeChange.objects.filter(
            sprint_id=sprint.pk, status=ScopeChangeStatus.PENDING
        ).select_related("task")
    )
    if not rows:
        return None
    return {
        "code": "scope_pending_on_close",
        "detail": (
            f"{len(rows)} item(s) are still pending acceptance. They will be carried "
            "over to the next sprint (still pending) unless you reject them."
        ),
        "pending_count": len(rows),
        "items": [
            {"id": str(r.pk), "task": str(r.task_id), "item_name": r.item_name} for r in rows
        ],
        "default_disposition": "carry",
    }


def apply_pending_disposition(sprint: Any, disposition: str, by: Any = None) -> None:
    """Dispose of tasks still pending acceptance at sprint close (ADR-0102 §7).

    Called from inside ``close_sprint`` after carry-over. Never blocks the close.

    - ``"reject"``: reject every pending row (removes the task from the sprint,
      writes history_change_reason) via ``reject_scope_change``.
    - ``"carry"`` (default): the close carry-over already moved incomplete tasks
      to the incoming sprint; for any carried task that was still pending, re-flag
      it ``sprint_pending=True`` on its NEW sprint and record a fresh PENDING
      SprintScopeChange against that sprint, so the injection stays gated in the
      next sprint rather than being silently committed. Tasks carried to backlog
      (sprint=None) or to "none" have their pending flag cleared (no sprint to be
      pending in). The closing sprint's PENDING rows clear with all other rows on
      close.
    """
    from trueppm_api.apps.projects.models import (
        ScopeChangeStatus,
        SprintScopeChange,
        Task,
    )

    pending_rows = list(
        SprintScopeChange.objects.filter(
            sprint_id=sprint.pk, status=ScopeChangeStatus.PENDING
        ).select_related("task")
    )
    if not pending_rows:
        return

    if disposition == "reject":
        for row in pending_rows:
            # System-initiated reject at close: bypass the human gate (the close
            # itself was already gated at the viewset). reject_scope_change's gate
            # would 403 a None actor, so do the minimal reject inline.
            task = Task.objects.select_for_update().filter(pk=row.task_id).first()
            row.status = ScopeChangeStatus.REJECTED
            row.save(update_fields=["status"])
            if task is not None and task.sprint_id == sprint.pk:
                task.sprint = None
                task.sprint_pending = False
                task._change_reason = "scope rejected at sprint close"  # type: ignore[attr-defined]
                task.save(update_fields=["sprint", "sprint_pending"])
        return

    # carry (default): re-flag the carried task in its NEW sprint and record a
    # fresh PENDING row there. The original closing-sprint row clears on close.
    for row in pending_rows:
        task = Task.objects.filter(pk=row.task_id, is_deleted=False).first()
        if task is None:
            continue
        new_sprint_id = task.sprint_id
        if new_sprint_id is None or new_sprint_id == sprint.pk:
            # Carried to backlog / "none" / still on the closing sprint → no sprint
            # to be pending in; clear the flag so it does not strand True.
            if task.sprint_pending:
                task.sprint_pending = False
                task.save(update_fields=["sprint_pending"])
            continue
        from trueppm_api.apps.projects.models import Sprint

        new_sprint = Sprint.objects.filter(pk=new_sprint_id).first()
        if new_sprint is None:
            continue
        # Keep the task flagged pending in the incoming sprint and record a fresh
        # PENDING audit row against it (flag_pending re-asserts True idempotently).
        record_sprint_scope_change(
            task=task,
            sprint=new_sprint,
            by=by,
            goal_impact=row.goal_impact,
            item_name=row.item_name,
            flag_pending=True,
        )


def sprint_pending_count(sprint_id: str | uuid.UUID) -> int:
    """Return the count of tasks pending acceptance in a sprint (ADR-0102 §5).

    Used by the accept/reject endpoints to return the fresh ``pending_count``.
    The list endpoint uses an annotation instead (avoids N+1); this helper is for
    the single-sprint action responses.
    """
    from trueppm_api.apps.projects.models import Task

    return Task.objects.filter(sprint_id=sprint_id, sprint_pending=True, is_deleted=False).count()


# ---------------------------------------------------------------------------
# Sprint → milestone rollup (ADR-0074)
# ---------------------------------------------------------------------------


def compute_milestone_rollup_payload(milestone: Any) -> dict[str, Any] | None:
    """Compute the rollup payload for a milestone task from its targeting sprints.

    Returns ``None`` when the milestone has no live targeting sprints — caller
    treats this as "no rollup, manual percent_complete applies."

    Reads ``Sprint.committed_*`` / ``Sprint.completed_*`` snapshots; never
    recomputes them. ACTIVE sprints contribute live ``Task.status=COMPLETE``
    counts (because their snapshot only fires on close). PLANNED sprints
    contribute committed points to the denominator but zero to the numerator
    (no work yet). COMPLETED sprints contribute their immutable snapshots.

    Variance is the gap between the latest ACTIVE/PLANNED sprint's
    ``finish_date`` and the milestone's ``early_finish`` (positive = slip).
    COMPLETED sprints do not contribute to variance — once closed their dates
    are historic, not predictive.

    ``sprint_scope_changed`` is True when any ACTIVE sprint's current
    backlog-points sum diverges from its activation-snapshot ``committed_points``
    — surfaced so the % can be trusted even when scope has shifted mid-sprint.
    """
    from trueppm_api.apps.projects.models import (
        Sprint,
        SprintState,
        TaskStatus,
        committed_sprint_tasks,
    )

    targeting = list(
        Sprint.objects.filter(target_milestone_id=milestone.pk, is_deleted=False).only(
            "pk",
            "state",
            "finish_date",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
        )
    )
    if not targeting:
        return None

    committed_points = 0
    committed_tasks = 0
    completed_points = 0
    completed_tasks = 0
    latest_active_planned_finish: Any = None
    scope_changed = False

    for sprint in targeting:
        # CANCELLED sprints are skipped entirely — they contribute nothing
        # to the denominator OR numerator. ``sprint_count`` still includes
        # them in the count because the milestone-detail UI surfaces total
        # link count regardless of state (PMs need to see "5 sprints linked,
        # 1 cancelled" without a second query).
        if sprint.state == SprintState.CANCELLED:
            continue

        committed_points += sprint.committed_points or 0
        committed_tasks += sprint.committed_task_count or 0

        if sprint.state == SprintState.COMPLETED:
            # Closed: use the immutable snapshot.
            completed_points += sprint.completed_points or 0
            completed_tasks += sprint.completed_task_count or 0
        elif sprint.state == SprintState.ACTIVE:
            # Live: count current COMPLETE tasks; the snapshot only fires on close.
            # ADR-0102 §2: exclude pending injections so a pending task neither
            # inflates the numerator nor trips ``scope_changed`` prematurely.
            live = list(
                committed_sprint_tasks(sprint.pk)
                .filter(status=TaskStatus.COMPLETE)
                .values_list("story_points", flat=True)
            )
            completed_points += sum(p for p in live if p is not None)
            completed_tasks += len(live)

            # Scope-change detection: compare current ACCEPTED backlog points to
            # the activation-time snapshot. Diverges when the PM adds or removes
            # *accepted* tasks after activation — a pending injection is excluded
            # so it does not trip the flag before the team accepts it.
            if sprint.committed_points is not None:
                current_points = sum(
                    p
                    for p in committed_sprint_tasks(sprint.pk).values_list(
                        "story_points", flat=True
                    )
                    if p is not None
                )
                if current_points != sprint.committed_points:
                    scope_changed = True

            if sprint.finish_date is not None and (
                latest_active_planned_finish is None
                or sprint.finish_date > latest_active_planned_finish
            ):
                latest_active_planned_finish = sprint.finish_date
        elif sprint.state == SprintState.PLANNED:
            # Denominator-only contribution — no completed work yet.
            if sprint.finish_date is not None and (
                latest_active_planned_finish is None
                or sprint.finish_date > latest_active_planned_finish
            ):
                latest_active_planned_finish = sprint.finish_date

    # Rollup basis: prefer points, fall back to task count, otherwise N/A.
    percent_complete: float | None
    rollup_basis: str
    if committed_points > 0:
        percent_complete = min(100.0, round((completed_points / committed_points) * 100, 2))
        rollup_basis = "points"
    elif committed_tasks > 0:
        percent_complete = min(100.0, round((completed_tasks / committed_tasks) * 100, 2))
        rollup_basis = "tasks"
    else:
        percent_complete = None
        rollup_basis = "none"

    variance_days: int | None
    if latest_active_planned_finish is not None and milestone.early_finish is not None:
        variance_days = (latest_active_planned_finish - milestone.early_finish).days
    else:
        variance_days = None

    return {
        "percent_complete": percent_complete,
        "rollup_basis": rollup_basis,
        "variance_days": variance_days,
        "sprint_scope_changed": scope_changed,
        "sprint_count": len(targeting),
    }


def recompute_milestone_rollup(
    milestone_id: str | uuid.UUID,
    *,
    broadcast: bool = True,
) -> dict[str, Any] | None:
    """Recompute the milestone rollup and broadcast the result.

    Idempotent — every call produces the truth from current sprint/task state.
    Safe to call concurrently; broadcast deduplication is handled by the
    on_commit registry (one broadcast per milestone per transaction).

    Returns the payload (also broadcast). Returns ``None`` when the milestone
    no longer exists or is not actually a milestone — caller handles silently.
    """
    from trueppm_api.apps.projects.models import Task
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    milestone = (
        Task.objects.filter(pk=milestone_id, is_milestone=True, is_deleted=False)
        .only("pk", "project_id", "early_finish")
        .first()
    )
    if milestone is None:
        return None

    payload = compute_milestone_rollup_payload(milestone)
    if payload is None:
        # No targeting sprints — emit a clear-state event so the UI drops the
        # rollup chrome on the milestone. Distinguished from "no broadcast" by
        # the explicit rollup_basis=none sentinel.
        payload = {
            "percent_complete": None,
            "rollup_basis": "none",
            "variance_days": None,
            "sprint_scope_changed": False,
            "sprint_count": 0,
        }

    if broadcast:
        project_id_str = str(milestone.project_id)
        milestone_id_str = str(milestone.pk)
        event_payload = {"milestone_id": milestone_id_str, **payload}

        def _broadcast() -> None:
            broadcast_board_event(project_id_str, "milestone_rollup_updated", event_payload)

        transaction.on_commit(_broadcast)

    return payload


# ---------------------------------------------------------------------------
# Recurring-task occurrence generation (ADR-0090, #736)
# ---------------------------------------------------------------------------


def _occurrence_matches(rule: Any, anchor: date, d: date) -> bool:
    """Return whether date ``d`` is an occurrence of ``rule`` given its ``anchor``.

    The anchor (the template's planned_start, or the first generation date) is the
    alignment basis for the ``interval`` ("every N") multiplier. For ``interval == 1``
    the anchor is immaterial — every matching weekday/day-of-month qualifies.
    """
    from trueppm_api.apps.projects.models import TaskRecurrenceFrequency

    if d < anchor:
        return False
    interval: int = max(rule.interval, 1)
    freq = rule.frequency

    if freq in (TaskRecurrenceFrequency.DAILY, TaskRecurrenceFrequency.CUSTOM):
        # CUSTOM is a generic "every N days" cadence; DAILY with interval==1 is "every
        # day". Both align to the anchor via the day delta.
        return (d - anchor).days % interval == 0

    if freq == TaskRecurrenceFrequency.WEEKLY:
        if not (rule.weekdays & (1 << d.weekday())):  # Mon=bit0 … Sun=bit6
            return False
        # Align the week to the anchor's (Monday-based) week for interval > 1.
        anchor_monday = anchor - timedelta(days=anchor.weekday())
        d_monday = d - timedelta(days=d.weekday())
        return ((d_monday - anchor_monday).days // 7) % interval == 0

    if freq == TaskRecurrenceFrequency.MONTHLY:
        dom = rule.day_of_month or anchor.day
        # Clamp to the month length so day_of_month=31 still fires in February.
        target = min(dom, calendar.monthrange(d.year, d.month)[1])
        if d.day != target:
            return False
        months = (d.year - anchor.year) * 12 + (d.month - anchor.month)
        return months >= 0 and months % interval == 0

    return False


def _spawn_occurrence(rule: Any, template: Any, d: date, template_attachments: list[Any]) -> Any:
    """Create one task occurrence for date ``d``, honoring the inheritance toggles.

    Occurrences carry ``is_recurring=True`` (the load-bearing CPM-exclusion key,
    ADR-0090) and ``wbs_path=None`` — they are standalone calendar tasks, not WBS
    nodes, so they never enter summary rollups or the scheduling engine.

    ``template_attachments`` is the template's attachment rows, fetched once by the
    caller (constant across a rule's sweep) and copied per occurrence when
    ``inherit_attachments`` is set.
    """
    from trueppm_api.apps.projects.models import Task, TaskAttachment, TaskStatus

    occurrence = Task.objects.create(
        project_id=template.project_id,
        name=template.name,
        duration=template.duration,
        is_milestone=template.is_milestone,
        notes=template.notes,
        color=template.color,
        status=TaskStatus.NOT_STARTED,
        assignee=template.assignee if rule.inherit_assignee else None,
        is_recurring=True,
        recurrence_rule=rule,
        recurrence_occurrence_date=d,
    )
    # Copy attachment rows referencing the SAME stored file — no blob duplication.
    # Each occurrence owns its row, so soft-deleting one occurrence never orphans
    # another's attachment.
    for att in template_attachments:
        TaskAttachment.objects.create(
            task=occurrence,
            file=att.file,
            file_name=att.file_name,
            file_mime=att.file_mime,
            file_size=att.file_size,
            external_url=att.external_url,
            external_title=att.external_title,
            uploaded_by=att.uploaded_by,
        )
    # inherit_subtasks / inherit_morning_notification are persisted on the rule but
    # not materialized here — see ADR-0090 (subtasks need the #738 WBS-placement UX;
    # morning-notification delivery is net-new, trueppm-enterprise#112).
    return occurrence


def _generate_due_occurrences(
    rule: Any,
    *,
    horizon_days: int,
    now: datetime | None = None,
) -> list[Any]:
    """Materialize a recurrence rule's occurrences due within the look-ahead horizon.

    Lazy and idempotent: creates only occurrences between the rule's cursor and
    ``today + horizon_days`` that do not already exist, and never more than the rule's
    end condition (ON_DATE / AFTER_N) permits. Advances ``rule.generated_through`` so
    the next sweep resumes without rescanning. Returns the created tasks (may be
    empty). Safe to call repeatedly — the ``(recurrence_rule, recurrence_occurrence_date)``
    unique constraint plus an existence check prevent duplicates.
    """
    from trueppm_api.apps.projects.models import RecurrenceEndType, TaskAttachment

    template = rule.task
    if template is None or template.is_deleted or rule.is_deleted:
        return []

    # Fetch the template's attachments once — they are constant across this rule's
    # sweep, so we avoid re-querying them per generated occurrence.
    template_attachments = (
        list(TaskAttachment.objects.filter(task=template, is_deleted=False))
        if rule.inherit_attachments
        else []
    )

    today = (now or timezone.now()).date()
    horizon_end = today + timedelta(days=horizon_days)
    anchor = template.planned_start or today

    if rule.end_type == RecurrenceEndType.ON_DATE and rule.end_date:
        horizon_end = min(horizon_end, rule.end_date)

    remaining: int | None = None
    if rule.end_type == RecurrenceEndType.AFTER_N and rule.end_count is not None:
        already = rule.occurrences.filter(is_deleted=False).count()
        remaining = max(rule.end_count - already, 0)
        if remaining == 0:
            return []

    # Resume after the last generated date; never back-fill past occurrences.
    if rule.generated_through:
        cursor = max(rule.generated_through + timedelta(days=1), today)
    else:
        cursor = max(anchor, today)

    created: list[Any] = []
    d = cursor
    while d <= horizon_end:
        if _occurrence_matches(rule, anchor, d):
            if remaining is not None and len(created) >= remaining:
                break
            if not rule.occurrences.filter(recurrence_occurrence_date=d).exists():
                created.append(_spawn_occurrence(rule, template, d, template_attachments))
        d += timedelta(days=1)

    # Advance the cursor to the scanned horizon so the next sweep is incremental.
    # Written via .update() (not .save()) deliberately: generated_through is an
    # internal cursor, so advancing it must not bump server_version or write a history
    # row — otherwise every hourly sweep would spam the sync delta and audit trail.
    if rule.generated_through != horizon_end:
        from trueppm_api.apps.projects.models import TaskRecurrenceRule

        TaskRecurrenceRule.objects.filter(pk=rule.pk).update(generated_through=horizon_end)
        rule.generated_through = horizon_end
    return created
