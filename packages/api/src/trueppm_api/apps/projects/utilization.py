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
          "days": {
            "2026-03-03": {"hours": 6.4, "tasks": ["uuid", ...]},
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
    project_cal = project.calendar  # may be None

    if project_cal is not None:
        proj_mask = project_cal.working_days
        proj_exceptions = _exception_ranges(project_cal.exceptions)
        proj_cal_id = project_cal.pk
    else:
        proj_mask = _DEFAULT_WORKING_DAYS
        proj_exceptions = []
        proj_cal_id = None

    # Fetch tasks with CPM dates within the window
    tasks = project.tasks.filter(
        is_deleted=False,
        early_start__isnull=False,
        early_start__lte=window_end,
        early_finish__gte=window_start,
    ).prefetch_related(
        "assignments__resource__calendar__exceptions",
    )

    # resource_id → row dict with a "days" defaultdict accumulator
    resource_rows: dict[str, dict[str, Any]] = {}
    unassigned_count = 0

    for task in tasks:
        assignments = list(task.assignments.all())
        if not assignments:
            unassigned_count += 1
            continue

        # Clamp task span to the requested window
        task_start = max(task.early_start, window_start)
        task_end = min(task.early_finish, window_end)

        for assignment in assignments:
            resource = assignment.resource
            rid = str(resource.pk)

            # Resolve the calendar to use for this resource
            res_cal = resource.calendar
            if res_cal is not None:
                mask = res_cal.working_days
                hrs = float(res_cal.hours_per_day)
                exc_ranges = _exception_ranges(res_cal.exceptions)
                cal_differs = res_cal.pk != proj_cal_id
            else:
                # Resource has no calendar — inherit project calendar
                mask = proj_mask
                hrs = float(project_cal.hours_per_day) if project_cal else _DEFAULT_HOURS_PER_DAY
                exc_ranges = proj_exceptions
                cal_differs = False

            if rid not in resource_rows:
                resource_rows[rid] = {
                    "resource_id": rid,
                    "resource_name": resource.name,
                    "max_units": str(resource.max_units),
                    # hours_per_day is the effective working hours for this resource
                    # after calendar resolution. The frontend divides actual load hours
                    # by (hours_per_day × max_units) to compute the % bar fill.
                    "hours_per_day": hrs,
                    "calendar_id": str(resource.calendar_id) if resource.calendar_id else None,
                    "calendar_differs_from_project": cal_differs,
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

    # Build the final response — convert internal _days defaultdict to plain dict
    resources_out = []
    for row in sorted(resource_rows.values(), key=lambda r: r["resource_name"]):
        resources_out.append(
            {
                "resource_id": row["resource_id"],
                "resource_name": row["resource_name"],
                "max_units": row["max_units"],
                "hours_per_day": row["hours_per_day"],
                "calendar_id": row["calendar_id"],
                "calendar_differs_from_project": row["calendar_differs_from_project"],
                "days": dict(row["_days"]),
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
