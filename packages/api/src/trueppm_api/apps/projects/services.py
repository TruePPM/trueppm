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
        Task,
        TaskStatus,
    )

    if snapshot_date is None:
        snapshot_date = timezone.localdate()

    tasks = list(
        Task.objects.filter(sprint_id=sprint.pk, is_deleted=False).values_list(
            "status", "story_points", "remaining_points"
        )
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
        # Iterate to call .save() so VersionedModel bumps server_version on each
        # task — queryset.update() bypasses the model and mobile sync misses it.
        for task in incomplete:
            task.sprint = None
            task.status = TaskStatus.BACKLOG
            task.save(update_fields=["sprint", "status"])
        return

    # Otherwise treat as a UUID string referencing another sprint in the same
    # project. Caller is expected to have validated this upstream.
    for task in incomplete:
        task.sprint_id = carry_over_to
        task.save(update_fields=["sprint"])


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
    from trueppm_api.apps.projects.models import Sprint, SprintState, Task, TaskStatus

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
            live = list(
                Task.objects.filter(
                    sprint_id=sprint.pk, status=TaskStatus.COMPLETE, is_deleted=False
                ).values_list("story_points", flat=True)
            )
            completed_points += sum(p for p in live if p is not None)
            completed_tasks += len(live)

            # Scope-change detection: compare current backlog points to the
            # activation-time snapshot. Diverges when the PM adds or removes
            # tasks from the sprint after activation.
            if sprint.committed_points is not None:
                current_points = sum(
                    p
                    for p in Task.objects.filter(sprint_id=sprint.pk, is_deleted=False).values_list(
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
