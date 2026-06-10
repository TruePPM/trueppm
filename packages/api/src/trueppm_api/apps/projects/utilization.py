"""Calendar-aware resource utilization computation.

Computes per-resource daily load for the resource view (issue #22).

Design decisions:
  - Uses TaskResource assignments, not Task.assignee — TaskResource carries
    units (fractional allocation) and the resource's own calendar.
  - Load per working day = resource.calendar.hours_per_day × assignment.units.
    This is the standard resource planning convention: full allocation rate
    regardless of percent_complete; the scheduler decides what's "done".
  - "Resource calendar wins": if a resource has its own calendar that differs
    from the project calendar, the resource calendar governs which days are
    working. The API response flags this as calendar_differs_from_project=true
    so the frontend can show a tooltip.
  - Sparse output: only days with load > 0 are emitted. The frontend expands
    to a dense grid.
"""

from __future__ import annotations

import datetime
from collections import defaultdict
from typing import Any

# weekday() returns 0=Mon, 1=Tue, …, 6=Sun.
# Calendar.working_days bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64.
_DOW_BITS: list[int] = [1, 2, 4, 8, 16, 32, 64]

# Sentinel calendar used when no calendar is configured: Mon–Fri, 8 h/day.
_DEFAULT_WORKING_DAYS = 31  # 0b0011111 = Mon–Fri
_DEFAULT_HOURS_PER_DAY = 8.0


def _load_band(load_pct: float) -> str:
    """Daily load band — the server-owned overallocation verdict (#989 / #986).

    Mirrors ``resourceUtils.loadColor`` (web rule 91) and the weekly heatmap's
    ``u > 100`` overallocation check exactly, so a headless/MCP client reads the
    same verdict the board renders: ``>100`` critical, ``85–100`` at-risk, else
    on-track. Hyphenated to match the web ``LoadColor`` literals verbatim.
    """
    if load_pct > 100:
        return "critical"
    if load_pct >= 85:
        return "at-risk"
    return "on-track"


def _is_working_day(
    working_days_mask: int,
    exception_ranges: list[tuple[datetime.date, datetime.date]],
    d: datetime.date,
) -> bool:
    """Return True if `d` is a working day under the given calendar parameters.

    `exception_ranges` is a pre-fetched list of (exc_start, exc_end) tuples;
    fetching it once per resource avoids repeated DB hits in the inner loop.
    """
    if not (working_days_mask & _DOW_BITS[d.weekday()]):
        return False
    return not any(exc_s <= d <= exc_e for exc_s, exc_e in exception_ranges)


def _exception_ranges(
    exceptions: Any,  # CalendarException queryset (already prefetched)
) -> list[tuple[datetime.date, datetime.date]]:
    return [(e.exc_start, e.exc_end) for e in exceptions.all()]


# Bound the scan so a degenerate calendar (no working day in its bitmask, or
# exceptions blanketing the window) can't spin to the date ceiling. Mirrors the
# scheduler engine's MAX_CALENDAR_SCAN_DAYS guard.
_MAX_FLOOR_SCAN_DAYS = 366


def first_working_day(project: Any) -> datetime.date:
    """Return the first working day on or after ``project.start_date``.

    This is the *effective* schedule floor — the CPM forward pass clamps every
    task's ``early_start`` to ``next_working_day(project.start_date)`` (see the
    scheduler engine), so a ``planned_start`` on a non-working project start date
    (e.g. a Saturday) is a ghost value the engine immediately pushes forward.
    The project-start floor guard must therefore compare against this date, not
    the literal ``start_date``, or "snap to project start" lands on a weekend and
    re-trips the guard (#884, a #868 regression).

    Uses the project's calendar (weekday bitmask + exception ranges); falls back
    to the Mon–Fri default when no calendar is configured — matching the
    scheduler's default and the API→scheduler conversion in scheduling/tasks.py.
    """
    cal = getattr(project, "calendar", None)
    mask = cal.working_days if cal is not None else _DEFAULT_WORKING_DAYS
    ranges = _exception_ranges(cal.exceptions) if cal is not None else []

    start: datetime.date = project.start_date
    d = start
    for _ in range(_MAX_FLOOR_SCAN_DAYS):
        if _is_working_day(mask, ranges, d):
            return d
        d += datetime.timedelta(days=1)
    # Degenerate calendar — no working day within a year. Fall back to the literal
    # start_date rather than raise; the floor guard is advisory, not load-bearing,
    # and a hard error here would block all task edits on a misconfigured calendar.
    return start


def compute_utilization(
    project: Any,  # trueppm_api.apps.projects.models.Project
    window_start: datetime.date,
    window_end: datetime.date,
) -> dict[str, Any]:
    """Compute per-resource daily utilization for *project* within the date window.

    Returns a plain dict matching the UtilizationResponse JSON contract:

    {
      "project_id": str,
      "window": {"start": str, "end": str},
      "resources": [
        {
          "resource_id": str,
          "resource_name": str,
          "max_units": str,          # Decimal as string for stable serialization
          "calendar_id": str | null,
          "calendar_differs_from_project": bool,
          "overallocated": bool,     # true if any day exceeds 100% load
          "days": {
            "2026-03-03": {
              "hours": 6.4,
              "tasks": ["uuid", ...],
              "load_pct": 80.0,            # hours / (hours_per_day × max_units) × 100
              "load_band": "on-track",     # on-track | at-risk | critical (web rule 91)
              "overallocated": false       # load_pct > 100
            },
            ...
          }
        }
      ],
      "unassigned_task_count": int   # tasks with CPM dates in window but no assignments
    }

    Callers must ensure the queryset passed via project.tasks already has
    prefetch_related("assignments__resource__calendar__exceptions") applied.
    The caller (ProjectViewSet.utilization) handles the prefetch.
    """
    # Delegate to the internal engine, then count unassigned tasks separately.
    rows = _compute_utilization_internal(project, window_start, window_end)

    # Count tasks in window that have no assignments (unassigned_task_count).
    assigned_task_ids: set[str] = set()
    for row in rows:
        for day_data in row["_days"].values():
            assigned_task_ids.update(day_data["tasks"])

    unassigned_count = (
        project.tasks.filter(
            is_deleted=False,
            early_start__isnull=False,
            early_start__lte=window_end,
            early_finish__gte=window_start,
        )
        .exclude(pk__in=assigned_task_ids)
        .count()
    )

    # Build the public response — strip internal _mask/_exc_ranges/_days fields.
    # Per-day capacity = hours_per_day × max_units (web rule 92). The server now
    # emits load_pct / load_band / overallocated per day so the client renders the
    # verdict rather than re-deriving it from raw hours (#989) — and a resource-
    # level ``overallocated`` flag (any day over 100%) for the overallocation
    # drawer, so it needn't re-scan every day client-side.
    resources_out = []
    for row in rows:
        max_units_f = float(row["max_units"])
        capacity = row["hours_per_day"] * max_units_f
        days_out: dict[str, Any] = {}
        resource_overallocated = False
        for key, day in row["_days"].items():
            load_pct = round(100.0 * day["hours"] / capacity, 1) if capacity > 0 else 0.0
            day_over = load_pct > 100
            resource_overallocated = resource_overallocated or day_over
            days_out[key] = {
                "hours": day["hours"],
                "tasks": day["tasks"],
                "load_pct": load_pct,
                "load_band": _load_band(load_pct),
                "overallocated": day_over,
            }
        resources_out.append(
            {
                "resource_id": row["resource_id"],
                "resource_name": row["resource_name"],
                "max_units": row["max_units"],
                # hours_per_day is the effective working hours for this resource
                # after calendar resolution. The frontend divides actual load hours
                # by (hours_per_day × max_units) to compute the % bar fill.
                "hours_per_day": row["hours_per_day"],
                "calendar_id": row["calendar_id"],
                "calendar_differs_from_project": row["calendar_differs_from_project"],
                "overallocated": resource_overallocated,
                "days": days_out,
            }
        )

    return {
        "project_id": str(project.pk),
        "window": {
            "start": window_start.isoformat(),
            "end": window_end.isoformat(),
        },
        "resources": resources_out,
        "unassigned_task_count": unassigned_count,
    }


# ---------------------------------------------------------------------------
# Helpers for weekly aggregation
# ---------------------------------------------------------------------------

# 12-colour palette for deterministic avatar colours, hashed from resource UUID.
_AVATAR_COLORS = [
    "#1C6B3A",  # brand-primary green
    "#4F46E5",  # indigo
    "#7C3AED",  # violet
    "#DB2777",  # pink
    "#D97706",  # amber
    "#0891B2",  # cyan
    "#059669",  # emerald
    "#DC2626",  # red
    "#7C2D12",  # brown
    "#1D4ED8",  # blue
    "#B45309",  # yellow-brown
    "#0F766E",  # teal
]


def _resource_color(resource_id: str) -> str:
    h = int(resource_id.replace("-", "")[:8], 16)
    return _AVATAR_COLORS[h % len(_AVATAR_COLORS)]


def _initials(name: str) -> str:
    parts = name.split()
    if len(parts) >= 2:
        return f"{parts[0][0]}{parts[-1][0]}".upper()
    return name[:2].upper() if len(name) >= 2 else name.upper()


def _count_working_days_in_range(
    working_days_mask: int,
    exception_ranges: list[tuple[datetime.date, datetime.date]],
    start: datetime.date,
    end: datetime.date,
) -> int:
    """Count working days between start and end inclusive under the given calendar."""
    count = 0
    d = start
    while d <= end:
        if _is_working_day(working_days_mask, exception_ranges, d):
            count += 1
        d += datetime.timedelta(days=1)
    return count


def aggregate_utilization_weekly(
    project: Any,
    weeks_start: datetime.date,
    num_weeks: int,
    group_by: str = "none",
) -> dict[str, Any]:
    """Aggregate per-resource daily utilization into ISO-week percent buckets.

    ``weeks_start`` must be a Monday.  Returns:

    {
      "weeks": ["2026-W18", "2026-W19", ...],
      "resources": [
        {
          "id": str,
          "name": str,
          "initials": str,
          "job_role": str,
          "color": str,
          "calendar_differs_from_project": bool,
          "util": [80, 90, 100, 110, 120, ...]   # integer percent per week
        }
      ]
    }

    Util percent = (weekly_hours / weekly_capacity) × 100, where weekly_capacity
    is hours_per_day × max_units × working_days_in_that_week (calendar-aware).
    """
    # Build ISO-week boundaries and labels
    week_dates: list[tuple[datetime.date, datetime.date]] = []
    week_labels: list[str] = []
    for i in range(num_weeks):
        wstart = weeks_start + datetime.timedelta(weeks=i)
        wend = wstart + datetime.timedelta(days=6)
        week_dates.append((wstart, wend))
        # strftime %G/%V is ISO year/week — handles year-boundary weeks correctly.
        week_labels.append(f"{wstart.strftime('%G')}-W{wstart.strftime('%V')}")

    window_end = week_dates[-1][1]

    # Reuse the daily engine — it handles calendar logic and prefetch contracts.
    daily = _compute_utilization_internal(project, weeks_start, window_end)

    resources_out = []
    for row in daily:
        hrs = row["hours_per_day"]
        max_units = float(row["max_units"])
        mask = row["_mask"]
        exc_ranges = row["_exc_ranges"]

        util_by_week: list[int] = []
        for wstart, wend in week_dates:
            # Sum load hours for this resource in this ISO week
            weekly_hours = 0.0
            d = wstart
            while d <= wend:
                iso = d.isoformat()
                if iso in row["_days"]:
                    weekly_hours += row["_days"][iso]["hours"]
                d += datetime.timedelta(days=1)

            # Capacity = hours_per_day × max_units × working_days_in_week
            working_days = _count_working_days_in_range(mask, exc_ranges, wstart, wend)
            weekly_capacity = hrs * max_units * working_days
            util_pct = round(100 * weekly_hours / weekly_capacity) if weekly_capacity > 0 else 0
            util_by_week.append(util_pct)

        resources_out.append(
            {
                "id": row["resource_id"],
                "name": row["resource_name"],
                "initials": _initials(row["resource_name"]),
                "job_role": row["job_role"],
                "color": _resource_color(row["resource_id"]),
                "calendar_differs_from_project": row["calendar_differs_from_project"],
                "util": util_by_week,
            }
        )

    # Client-side re-sort: server provides canonical order but supports group_by
    # as a sort hint so the client can resort without a round-trip.
    if group_by == "role":
        resources_out.sort(key=lambda r: (r["job_role"].lower(), r["name"].lower()))
    else:
        # "project" grouping requires cross-project data not available here (Enterprise).
        # Fall back to alphabetical for both "project" and "none".
        resources_out.sort(key=lambda r: r["name"].lower())

    return {"weeks": week_labels, "resources": resources_out}


def _compute_utilization_internal(
    project: Any,
    window_start: datetime.date,
    window_end: datetime.date,
) -> list[dict[str, Any]]:
    """Internal variant of compute_utilization that returns raw resource rows.

    Rows include the private ``_mask``, ``_exc_ranges``, and ``_days`` fields
    needed by ``aggregate_utilization_weekly``.  Not part of the public API.
    """
    project_cal = project.calendar

    if project_cal is not None:
        proj_mask = project_cal.working_days
        proj_exceptions = _exception_ranges(project_cal.exceptions)
        proj_cal_id = project_cal.pk
    else:
        proj_mask = _DEFAULT_WORKING_DAYS
        proj_exceptions = []
        proj_cal_id = None

    tasks = project.tasks.filter(
        is_deleted=False,
        early_start__isnull=False,
        early_start__lte=window_end,
        early_finish__gte=window_start,
    ).prefetch_related(
        "assignments__resource__calendar__exceptions",
    )

    resource_rows: dict[str, dict[str, Any]] = {}

    for task in tasks:
        assignments = list(task.assignments.all())
        if not assignments:
            continue

        task_start = max(task.early_start, window_start)
        task_end = min(task.early_finish, window_end)

        for assignment in assignments:
            resource = assignment.resource
            rid = str(resource.pk)

            res_cal = resource.calendar
            if res_cal is not None:
                mask = res_cal.working_days
                hrs = float(res_cal.hours_per_day)
                exc_ranges = _exception_ranges(res_cal.exceptions)
                cal_differs = res_cal.pk != proj_cal_id
            else:
                mask = proj_mask
                hrs = float(project_cal.hours_per_day) if project_cal else _DEFAULT_HOURS_PER_DAY
                exc_ranges = proj_exceptions
                cal_differs = False

            if rid not in resource_rows:
                resource_rows[rid] = {
                    "resource_id": rid,
                    "resource_name": resource.name,
                    "job_role": resource.job_role or "",
                    "max_units": str(resource.max_units),
                    "hours_per_day": hrs,
                    "calendar_id": str(resource.calendar_id) if resource.calendar_id else None,
                    "calendar_differs_from_project": cal_differs,
                    # Internal fields used by aggregate_utilization_weekly
                    "_mask": mask,
                    "_exc_ranges": exc_ranges,
                    "_days": defaultdict(lambda: {"hours": 0.0, "tasks": []}),
                }

            units = float(assignment.units)
            daily_hours = hrs * units

            d = task_start
            while d <= task_end:
                if _is_working_day(mask, exc_ranges, d):
                    key = d.isoformat()
                    resource_rows[rid]["_days"][key]["hours"] = round(
                        resource_rows[rid]["_days"][key]["hours"] + daily_hours, 4
                    )
                    resource_rows[rid]["_days"][key]["tasks"].append(str(task.pk))
                d += datetime.timedelta(days=1)

    return sorted(resource_rows.values(), key=lambda r: r["resource_name"])
