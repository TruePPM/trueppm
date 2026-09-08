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
  - Windowed by the task's SPAN (ADR-0752's ``scheduled_start``..``early_finish``),
    not by ``early_start``..``early_finish`` (#2623). Since ADR-0132,
    ``early_start`` is the *remaining-work* window for an in-progress task —
    it shrinks toward ``early_finish`` as ``percent_complete`` rises. Windowing
    load on it made reporting progress look like shedding allocation: a person's
    real-world commitment to a task does not shrink because they finished part
    of it. ``scheduled_finish`` is identically ``early_finish`` in every task
    state (ADR-0752 §2) and is not a separate column, so only the start side
    needs to change. ``scheduled_start`` falls back to ``early_start`` via
    ``Coalesce`` for rows a CPM run has not yet populated it on (additive
    migration, no data backfill) — where the two windows coincide anyway for
    not-started and complete tasks.
"""

from __future__ import annotations

import dataclasses
import datetime
from collections import defaultdict
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

from django.db.models import DateField, Prefetch
from django.db.models.functions import Coalesce

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


# ---------------------------------------------------------------------------
# Peak concurrent allocation — the calendar-aware overallocation verdict for
# write-time callers that compare units against Resource.max_units (#3534)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Allocation:
    """One commitment of a resource: ``units`` held across an inclusive day span.

    ``start`` / ``end`` are ``None`` for a task that carries no CPM span yet —
    see :func:`peak_concurrent_units` for how an undated commitment is folded in.
    """

    units: Decimal
    start: datetime.date | None
    end: datetime.date | None


def _first_working_day_in(
    working_days_mask: int,
    exception_ranges: list[tuple[datetime.date, datetime.date]],
    start: datetime.date,
    end: datetime.date,
) -> datetime.date | None:
    """First working day inside the inclusive ``[start, end]`` span, or ``None``.

    Bounded by ``_MAX_FLOOR_SCAN_DAYS`` so a degenerate calendar (empty weekday
    bitmask, or exceptions blanketing the span) cannot spin across a multi-year
    span — the same guard ``first_working_day`` applies.
    """
    d = start
    for _ in range(_MAX_FLOOR_SCAN_DAYS):
        if d > end:
            return None
        if _is_working_day(working_days_mask, exception_ranges, d):
            return d
        d += datetime.timedelta(days=1)
    return None


def peak_concurrent_units(
    allocations: Sequence[Allocation],
    working_days_mask: int,
    exception_ranges: list[tuple[datetime.date, datetime.date]],
) -> tuple[Decimal, datetime.date | None]:
    """Return ``(peak units held on any single working day, that day)``.

    This is the overallocation question a project-lifetime ``Sum(units)`` cannot
    answer: three 0.8-unit tasks that never share a calendar day are a peak of
    0.8, not 2.4 (#3534). It is the same verdict the daily engine above reaches
    in hours, kept in units here because write-time callers compare it directly
    against a units capacity and never need a calendar's ``hours_per_day``. Since
    #3574 that capacity is the caller's project-effective figure (the roster's
    ``units_override`` when set, else ``Resource.max_units``), not the raw default.

    Undated commitments — a task with no ``scheduled_start``/``early_start``
    span, which the daily engine simply drops — are folded in as a **baseline
    present on every day** rather than dropped. An unscheduled task has no window
    that could prove it does not overlap, so counting it as concurrent keeps the
    warning conservative on a project whose CPM has never run, which is exactly
    when the first assignments are made.

    Only working days are considered, under the *resource's* calendar: two tasks
    that touch only across a weekend are not a real conflict, and the heat map
    already refuses to color one. ``(baseline, None)`` comes back when nothing is
    dated — there is no busiest day to name, only a floor.

    Args:
        allocations: Every commitment the resource holds in the scope being
            checked. Units are summed as-is; the caller decides what counts.
        working_days_mask: ``Calendar.working_days`` bitmask for the resource.
        exception_ranges: Pre-fetched ``(start, end)`` non-working ranges.

    Returns:
        ``(peak, day)`` where ``day`` is ``None`` if the peak is the undated
        baseline rather than a dated overlap.
    """
    baseline = Decimal("0")
    # (units, span_start, span_end) — narrowed to non-null dates so the sweep below
    # needs no per-element None handling.
    dated: list[tuple[Decimal, datetime.date, datetime.date]] = []
    for alloc in allocations:
        if alloc.start is None or alloc.end is None or alloc.end < alloc.start:
            baseline += alloc.units
        else:
            dated.append((alloc.units, alloc.start, alloc.end))

    if not dated:
        return baseline, None

    # The peak of a sum of boxcars is always attained on the first working day of
    # some allocation's span: if day D is a working-day maximum, let S be the
    # allocations covering D and s the latest start among them. Every member of S
    # spans [s, D], so the first working day at or after s is <= D, lies inside
    # every member of S, and therefore carries at least as much load as D. That
    # makes one candidate per allocation sufficient — no day-by-day walk of the
    # union span, which could be years wide with no window to clamp it to.
    candidates: list[datetime.date] = []
    for _units, span_start, span_end in dated:
        day = _first_working_day_in(working_days_mask, exception_ranges, span_start, span_end)
        if day is not None:
            candidates.append(day)
    if not candidates:
        # Degenerate calendar: no span contains a working day at all. Falling back
        # to raw span starts keeps a genuine overlap detectable rather than
        # silently reporting the undated baseline as the peak.
        candidates = [span_start for _units, span_start, _span_end in dated]

    # Sweep the candidate days in order, opening and closing spans as they are
    # reached. O(n log n) rather than re-scanning every span per candidate: one
    # resource can legitimately carry thousands of assignments in a project, and
    # this runs inside a write request.
    by_start = sorted(dated, key=lambda row: row[1])
    by_end = sorted(dated, key=lambda row: row[2])
    opened = closed = 0
    running = Decimal("0")

    peak = baseline
    peak_day: datetime.date | None = None
    for day in sorted(set(candidates)):
        while opened < len(by_start) and by_start[opened][1] <= day:
            running += by_start[opened][0]
            opened += 1
        while closed < len(by_end) and by_end[closed][2] < day:
            running -= by_end[closed][0]
            closed += 1
        total = baseline + running
        if total > peak:
            peak, peak_day = total, day
    return peak, peak_day


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
          # Capacity ON THIS PROJECT: the roster's units_override when one is set,
          # else Resource.max_units. Decimal as string for stable serialization.
          "max_units": str,
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
        project.tasks.filter(is_deleted=False, early_start__isnull=False)
        .annotate(_span_start=Coalesce("scheduled_start", "early_start", output_field=DateField()))
        .filter(_span_start__lte=window_end, early_finish__gte=window_start)
        .exclude(pk__in=assigned_task_ids)
        .count()
    )

    # Build the public response — strip internal _mask/_exc_ranges/_days fields.
    # Per-day capacity = hours_per_day × max_units (web rule 92), where max_units is
    # already the project-effective figure the engine resolved (#3574). The server now
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
                # by (hours_per_day × max_units) to compute the % bar fill — and
                # max_units is override-resolved, so that bar and the server's own
                # load_pct cannot disagree (#3574).
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
    is hours_per_day × max_units × working_days_in_that_week (calendar-aware), and
    ``max_units`` is the project-effective capacity — the roster's
    ``units_override`` when one is set, else ``Resource.max_units`` (#3574).
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

    resources_out = [
        {
            "id": row["resource_id"],
            "name": row["resource_name"],
            "initials": _initials(row["resource_name"]),
            "job_role": row["job_role"],
            "color": _resource_color(row["resource_id"]),
            "calendar_differs_from_project": row["calendar_differs_from_project"],
            "util": _weekly_util_for_resource(row, week_dates),
        }
        for row in daily
    ]

    # Client-side re-sort: server provides canonical order but supports group_by
    # as a sort hint so the client can resort without a round-trip.
    if group_by == "role":
        applied = "role"
        resources_out.sort(key=lambda r: (r["job_role"].lower(), r["name"].lower()))
    else:
        # "project" grouping needs cross-project data this endpoint does not have — it is
        # scoped to one project, so grouping its rows by project is a single group by
        # construction. The cross-portfolio heat map is Enterprise. So "project" falls
        # back to alphabetical, identically to "none".
        #
        # ``group_by`` in the response names the grouping that was ACTUALLY applied,
        # which is the whole point (#2907): the parameter is validated and accepted, so
        # without this a caller asking for "project" gets a 200 and reads an
        # alphabetical payload as project-grouped, with nothing anywhere to contradict
        # them. The 400 that would have told them is the one thing we cannot send —
        # "project" is a documented enum value in the published schema, and removing an
        # enum value is a Breaking change under the API stability contract. Echoing what
        # was applied is additive, so it closes the silence without breaking the
        # contract; the value is deprecated in the schema for removal after its window.
        applied = "none"
        resources_out.sort(key=lambda r: r["name"].lower())

    return {"weeks": week_labels, "resources": resources_out, "group_by": applied}


def _sum_week_hours(days: dict[str, Any], wstart: datetime.date, wend: datetime.date) -> float:
    """Sum a resource's daily load hours across an inclusive ``[wstart, wend]`` week."""
    total = 0.0
    d = wstart
    while d <= wend:
        iso = d.isoformat()
        if iso in days:
            total += days[iso]["hours"]
        d += datetime.timedelta(days=1)
    return total


def _weekly_util_for_resource(
    row: dict[str, Any], week_dates: list[tuple[datetime.date, datetime.date]]
) -> list[int]:
    """Integer percent utilization per ISO week for one daily-engine resource row.

    Util percent = (weekly_hours / weekly_capacity) × 100, where weekly_capacity is
    hours_per_day × max_units × working_days_in_that_week (calendar-aware).
    ``row["max_units"]`` is the project-effective capacity resolved by the engine.
    """
    hrs = row["hours_per_day"]
    max_units = float(row["max_units"])
    mask = row["_mask"]
    exc_ranges = row["_exc_ranges"]

    util_by_week: list[int] = []
    for wstart, wend in week_dates:
        weekly_hours = _sum_week_hours(row["_days"], wstart, wend)
        working_days = _count_working_days_in_range(mask, exc_ranges, wstart, wend)
        weekly_capacity = hrs * max_units * working_days
        util_pct = round(100 * weekly_hours / weekly_capacity) if weekly_capacity > 0 else 0
        util_by_week.append(util_pct)
    return util_by_week


def _compute_utilization_internal(
    project: Any,
    window_start: datetime.date,
    window_end: datetime.date,
) -> list[dict[str, Any]]:
    """Internal variant of compute_utilization that returns raw resource rows.

    Rows include the private ``_mask``, ``_exc_ranges``, and ``_days`` fields
    needed by ``aggregate_utilization_weekly``.  Not part of the public API.

    Deactivated resources are excluded (#3572) — see the ``Prefetch`` below. This is
    the ONE point at which the daily engine assembles its resource set, so every
    caller inherits it: :func:`compute_utilization` (heat map),
    :func:`aggregate_utilization_weekly` (weekly buckets, and through it
    ``resources/summary``), :func:`compute_team_utilization` (Overview KPI numerator),
    and the over-allocation digest.
    """
    from trueppm_api.apps.resources.capacity import project_effective_units
    from trueppm_api.apps.resources.models import TaskResource

    project_cal = project.calendar
    proj_mask, proj_exceptions, proj_cal_id = _resolve_project_calendar(project_cal)

    # One query for the whole roster. ``ProjectResource.units_override`` is a
    # PER-PROJECT capacity statement, and this engine is the choke point every
    # per-project capacity read funnels through — the daily load bands, the weekly
    # heat map, ``resources/summary``, the Overview KPI and the weekly digest all
    # read the rows it returns. Resolving the override anywhere else would let two
    # adjacent surfaces report different numbers for the same person (#3574).
    roster_units = project_effective_units(project.pk)

    # Window by the task's SPAN (scheduled_start..early_finish), not its
    # remaining-work window (early_start..early_finish) — see the module
    # docstring and ADR-0752 / #2623. scheduled_finish has no column of its
    # own; it is always early_finish, so only the start side is swapped.
    # scheduled_start falls back to early_start for rows a CPM run has not
    # (re)populated it on yet, which is also correct: the two windows are
    # identical for not-started and complete tasks.
    tasks = (
        project.tasks.filter(is_deleted=False, early_start__isnull=False)
        .annotate(_span_start=Coalesce("scheduled_start", "early_start", output_field=DateField()))
        .filter(_span_start__lte=window_end, early_finish__gte=window_start)
        .prefetch_related(
            # The deactivation filter lives HERE and only here: narrowing the first
            # prefetch level is what keeps a deactivated person's retained assignment
            # rows (kept on purpose, for audit) from drawing load on the heat map and
            # from carrying capacity into the Overview denominator. The chained
            # lookup below extends this same prefetch — it must stay second, or
            # Django rejects the pair as one lookup with two querysets.
            # ``select_related("resource")`` so the chained lookup below reuses the
            # already-cached resource and prefetches only the calendar level.
            Prefetch(
                "assignments", queryset=TaskResource.objects.active().select_related("resource")
            ),
            "assignments__resource__calendar__exceptions",
        )
    )

    resource_rows: dict[str, dict[str, Any]] = {}

    for task in tasks:
        assignments = list(task.assignments.all())
        if not assignments:
            continue

        task_start = max(task._span_start, window_start)
        task_end = min(task.early_finish, window_end)

        for assignment in assignments:
            _accumulate_assignment(
                resource_rows,
                assignment,
                task,
                task_start,
                task_end,
                project_cal,
                proj_mask,
                proj_exceptions,
                proj_cal_id,
                roster_units,
            )

    return sorted(resource_rows.values(), key=lambda r: r["resource_name"])


def _resolve_project_calendar(
    project_cal: Any,
) -> tuple[int, list[tuple[datetime.date, datetime.date]], Any]:
    """Resolve ``(mask, exception_ranges, calendar_id)`` for the project calendar.

    Falls back to the Mon–Fri default (no calendar configured).
    """
    if project_cal is not None:
        return project_cal.working_days, _exception_ranges(project_cal.exceptions), project_cal.pk
    return _DEFAULT_WORKING_DAYS, [], None


def _resolve_resource_calendar(
    resource: Any,
    project_cal: Any,
    proj_mask: int,
    proj_exceptions: list[tuple[datetime.date, datetime.date]],
    proj_cal_id: Any,
) -> tuple[int, float, list[tuple[datetime.date, datetime.date]], bool]:
    """Resolve ``(mask, hours_per_day, exception_ranges, calendar_differs)`` for a resource.

    "Resource calendar wins": a resource with its own calendar governs its working
    days and hours; otherwise it inherits the project calendar (and never differs).
    """
    res_cal = resource.calendar
    if res_cal is not None:
        return (
            res_cal.working_days,
            float(res_cal.hours_per_day),
            _exception_ranges(res_cal.exceptions),
            res_cal.pk != proj_cal_id,
        )
    hrs = float(project_cal.hours_per_day) if project_cal else _DEFAULT_HOURS_PER_DAY
    return proj_mask, hrs, proj_exceptions, False


def resolve_working_calendar(
    resource: Any, project: Any
) -> tuple[int, list[tuple[datetime.date, datetime.date]]]:
    """Return ``(working-days bitmask, non-working ranges)`` for *resource* on *project*.

    The same "resource calendar wins" resolution the daily engine applies,
    published for callers that need only the working-day question and not a load
    figure — :func:`peak_concurrent_units` takes exactly this pair. ``project`` may
    be ``None``, in which case the Mon-Fri default stands in, matching the engine.
    """
    project_cal = getattr(project, "calendar", None)
    proj_mask, proj_exceptions, proj_cal_id = _resolve_project_calendar(project_cal)
    mask, _hours, exception_ranges, _differs = _resolve_resource_calendar(
        resource, project_cal, proj_mask, proj_exceptions, proj_cal_id
    )
    return mask, exception_ranges


def _init_resource_row(
    rid: str,
    resource: Any,
    hrs: float,
    cal_differs: bool,
    mask: int,
    exc_ranges: list[tuple[datetime.date, datetime.date]],
    effective_units: Decimal | None = None,
) -> dict[str, Any]:
    """Build a fresh accumulator row for a resource (including internal `_` fields).

    ``effective_units`` is the resource's capacity **on this project** — the roster's
    ``units_override`` when one is set, else ``Resource.max_units``. It is ``None``
    for a resource carrying assignments without a roster row, whose capacity is the
    resource default by definition.
    """
    return {
        "resource_id": rid,
        "resource_name": resource.name,
        "job_role": resource.job_role or "",
        # The row's single capacity figure, already override-resolved. Every
        # consumer (load_pct, load_band, overallocated, the weekly heat map, the
        # Overview KPI, the client's % bar) divides by this one value, which is what
        # keeps them from disagreeing (#3574).
        "max_units": str(effective_units if effective_units is not None else resource.max_units),
        "hours_per_day": hrs,
        "calendar_id": str(resource.calendar_id) if resource.calendar_id else None,
        "calendar_differs_from_project": cal_differs,
        # Internal fields used by aggregate_utilization_weekly
        "_mask": mask,
        "_exc_ranges": exc_ranges,
        "_days": defaultdict(lambda: {"hours": 0.0, "tasks": []}),
    }


def _accumulate_days(
    days: dict[str, Any],
    task_start: datetime.date,
    task_end: datetime.date,
    mask: int,
    exc_ranges: list[tuple[datetime.date, datetime.date]],
    daily_hours: float,
    task_pk: str,
) -> None:
    """Add ``daily_hours`` (and the task id) to every working day in the task window."""
    d = task_start
    while d <= task_end:
        if _is_working_day(mask, exc_ranges, d):
            key = d.isoformat()
            days[key]["hours"] = round(days[key]["hours"] + daily_hours, 4)
            days[key]["tasks"].append(task_pk)
        d += datetime.timedelta(days=1)


def _accumulate_assignment(
    resource_rows: dict[str, dict[str, Any]],
    assignment: Any,
    task: Any,
    task_start: datetime.date,
    task_end: datetime.date,
    project_cal: Any,
    proj_mask: int,
    proj_exceptions: list[tuple[datetime.date, datetime.date]],
    proj_cal_id: Any,
    roster_units: dict[str, Decimal] | None = None,
) -> None:
    """Fold one TaskResource assignment's daily load into ``resource_rows``."""
    resource = assignment.resource
    rid = str(resource.pk)
    mask, hrs, exc_ranges, cal_differs = _resolve_resource_calendar(
        resource, project_cal, proj_mask, proj_exceptions, proj_cal_id
    )
    if rid not in resource_rows:
        resource_rows[rid] = _init_resource_row(
            rid,
            resource,
            hrs,
            cal_differs,
            mask,
            exc_ranges,
            (roster_units or {}).get(rid),
        )

    daily_hours = hrs * float(assignment.units)
    _accumulate_days(
        resource_rows[rid]["_days"],
        task_start,
        task_end,
        mask,
        exc_ranges,
        daily_hours,
        str(task.pk),
    )


# ---------------------------------------------------------------------------
# Project-level team utilization (single scalar for the Overview KPI, #2428)
# ---------------------------------------------------------------------------

# Machine-readable codes for "the team-utilization ratio is undefined". The web
# package maps each to a plain-language sentence (rule 119); the vocabulary is
# owned here, so a client never guesses at the cause of a blank card.
#
# Deliberately NOT a reason: a computable 0%. Nobody being allocated this week is
# a real, meaningful answer — and telling those two states apart is the whole
# point of the card (#2428). Only a genuinely undefined ratio gets a reason.
TEAM_UTILIZATION_NO_ROSTER = "no_roster"
TEAM_UTILIZATION_NO_CAPACITY = "no_capacity"


def _window_load_hours(row: dict[str, Any]) -> float:
    """Total assigned hours in one engine row. ``_days`` is already window-clamped."""
    return sum(float(day["hours"]) for day in row["_days"].values())


def compute_team_utilization(
    project: Any,  # trueppm_api.apps.projects.models.Project
    window_start: datetime.date,
    window_end: datetime.date,
) -> dict[str, Any]:
    """Collapse the per-resource daily engine into one project-level utilization percent.

    Returns ``{"pct": float | None, "reason": str | None}``. Exactly one of the two
    is populated: a computable ratio carries ``reason=None``, and an undefined one
    carries ``pct=None`` plus a code from the ``TEAM_UTILIZATION_*`` vocabulary
    above.

    ``pct = 100 × Σ assigned hours ÷ Σ capacity hours`` over the window, where
    capacity is the same calendar-aware ``hours_per_day × units × working_days``
    product the daily engine and the weekly heatmap use — so the Overview KPI, the
    heatmap, and a headless/MCP client cannot disagree about how loaded a team is.

    The measured population is the project roster **union** the resources carrying
    assignments in the window. The union matters: ``TaskResource`` does not require
    a matching ``ProjectResource`` row, so counting only the roster would put an
    off-roster assignee's hours in the numerator with no capacity in the
    denominator and report a phantom overallocation. Counting only assignees would
    instead hide idle capacity and peg a barely-booked team at 100%.

    Per-project ``units_override`` wins over ``Resource.max_units`` for anyone on
    the roster — that override exists precisely to say "this person is only half
    on this project", and ignoring it would understate their utilization. Since
    #3574 that resolution happens once, inside the daily engine, so this card and
    every other per-project capacity read share one answer.
    """
    rows_by_id = {
        row["resource_id"]: row
        for row in _compute_utilization_internal(project, window_start, window_end)
    }

    project_cal = project.calendar
    proj_mask, proj_exceptions, proj_cal_id = _resolve_project_calendar(project_cal)

    roster = {
        str(pr.resource_id): pr
        # ``.active()`` (#3572): a deactivated person contributes no load (the engine
        # above dropped their assignments) but WOULD still contribute capacity here,
        # so leaving them in the denominator understates team load at exactly the
        # moment an off-boarding makes the remaining team busier.
        for pr in project.resource_pool.active().prefetch_related("resource__calendar__exceptions")
    }

    measured = set(roster) | set(rows_by_id)
    if not measured:
        return {"pct": None, "reason": TEAM_UTILIZATION_NO_ROSTER}

    load_total = 0.0
    capacity_total = 0.0
    for rid in measured:
        row = rows_by_id.get(rid)
        roster_entry = roster.get(rid)

        if row is not None:
            # The engine row already resolved this resource's calendar AND its
            # effective per-project capacity; reuse both rather than re-deriving
            # them, so numerator and denominator cannot drift and this card cannot
            # disagree with the heat map it links to (#3574).
            mask, hrs, exc_ranges = row["_mask"], row["hours_per_day"], row["_exc_ranges"]
            units = float(row["max_units"])
            load_total += _window_load_hours(row)
        else:
            # On the roster but carrying no assignments in the window — pure idle
            # capacity, which still belongs in the denominator. No engine row exists
            # to carry the resolved capacity, so resolve it from the roster entry.
            resource = roster_entry.resource  # type: ignore[union-attr]
            mask, hrs, exc_ranges, _ = _resolve_resource_calendar(
                resource, project_cal, proj_mask, proj_exceptions, proj_cal_id
            )
            units = float(roster_entry.effective_max_units)  # type: ignore[union-attr]

        working_days = _count_working_days_in_range(mask, exc_ranges, window_start, window_end)
        capacity_total += hrs * units * working_days

    # No working capacity in the window at all (every calendar closed, or every
    # roster member at 0 units). The ratio is undefined rather than zero, so this
    # is a reason and not a 0% reading.
    if capacity_total <= 0:
        return {"pct": None, "reason": TEAM_UTILIZATION_NO_CAPACITY}

    return {"pct": round(100.0 * load_total / capacity_total, 1), "reason": None}
