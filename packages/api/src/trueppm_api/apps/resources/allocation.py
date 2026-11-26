"""Allocation conflict check: the weekly verdict for a proposed booking (#4806, ADR-@@).

One function, :func:`build_verdict`, answers both the dry run and the real save, so the
two cannot disagree. It only reads.

A booking is a share of full time held across an inclusive date window
(``ProjectResource.share_pct`` / ``share_start`` / ``share_end``). On any day, a
project's draw on a person is the **larger** of its booked share and the person's
assigned ``TaskResource.units`` there: a booking is a reservation that tasks draw
down, so adding the two would count the same work twice. ``Task.assignee`` is never
counted (``TaskResource`` is the capacity record).

This is load arithmetic, not scheduling: task spans are read from the CPM engine's own
output and nothing here dates, snaps or samples a task.
"""

from __future__ import annotations

import datetime
from collections import defaultdict
from decimal import Decimal
from typing import Any, NamedTuple, cast

from django.db.models import DateField
from django.db.models.functions import Coalesce
from django.utils import timezone

from trueppm_api.apps.projects.metric_provenance import definitions_for
from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.projects.utilization import (
    _DEFAULT_WORKING_DAYS,
    _count_working_days_in_range,
    _exception_ranges,
    _peak_candidate_days,
)
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

#: Longest booking window one check accepts.
MAX_BOOKING_WEEKS = 104
#: How far later the "move" resolution looks for a window that fits.
MOVE_SEARCH_WEEKS = 26

_ONE_WEEK = datetime.timedelta(weeks=1)
_HUNDRED = Decimal("100")
_ZERO = Decimal("0")


class _Span(NamedTuple):
    """One dated draw on the person by one project."""

    project_id: str
    booked: bool  # True: a booked share. False: an assigned task.
    pct: Decimal
    start: datetime.date
    end: datetime.date


class _Week(NamedTuple):
    week_start: datetime.date
    load: Decimal
    time_off: Decimal
    by_project: dict[str, Decimal]


class _Calendar(NamedTuple):
    mask: int
    exceptions: list[tuple[datetime.date, datetime.date]]


def _monday(day: datetime.date) -> datetime.date:
    return day - day.resolution * day.weekday()


def _pct(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.1")))


def _week_load(
    spans: list[_Span], calendar: _Calendar, week_start: datetime.date, ceiling: Decimal
) -> _Week:
    """The busiest day of one week, plus that week's time off as a percent."""
    week_end = week_start + _ONE_WEEK - week_start.resolution
    clipped = [
        s._replace(start=max(s.start, week_start), end=min(s.end, week_end))
        for s in spans
        if s.start <= week_end and s.end >= week_start
    ]
    nominal = bin(calendar.mask & 0x7F).count("1")
    time_off = _ZERO
    if nominal:
        working = _count_working_days_in_range(
            calendar.mask, calendar.exceptions, week_start, week_end
        )
        time_off = ceiling * Decimal(nominal - working) / Decimal(nominal)

    best_total = _ZERO
    best: dict[str, Decimal] = {}
    # Judged on the calendar's weekdays *ignoring* exceptions: time off is charged
    # once, as ``time_off``, and a booking inside an all-off week must still count.
    days = _peak_candidate_days([(s.pct, s.start, s.end) for s in clipped], calendar.mask, [])
    for day in sorted(set(days)):
        share: dict[str, Decimal] = defaultdict(Decimal)
        tasks: dict[str, Decimal] = defaultdict(Decimal)
        for s in clipped:
            if s.start <= day <= s.end:
                (share if s.booked else tasks)[s.project_id] += s.pct
        by_project = {pid: max(share[pid], tasks[pid]) for pid in {*share, *tasks}}
        total = sum(by_project.values(), _ZERO)
        if total > best_total:
            best_total, best = total, by_project
    return _Week(week_start, best_total + time_off, time_off, best)


def _weeks(
    spans: list[_Span],
    calendar: _Calendar,
    ceiling: Decimal,
    start: datetime.date,
    end: datetime.date,
) -> list[_Week]:
    out = []
    cursor = _monday(start)
    while cursor <= end:
        out.append(_week_load(spans, calendar, cursor, ceiling))
        cursor += _ONE_WEEK
    return out


def _other_spans(
    resource: Resource, range_start: datetime.date, range_end: datetime.date, project_id: str
) -> list[_Span]:
    """Every existing draw on the person that overlaps the range.

    This project's stored booking is left out: the proposal replaces it.
    """
    spans = [
        # The filter below excludes NULL share and window; ``cast`` narrows for mypy.
        _Span(
            str(pid),
            True,
            Decimal(cast("int", pct)),
            cast("datetime.date", start),
            cast("datetime.date", end),
        )
        for pid, pct, start, end in ProjectResource.objects.active()
        .filter(
            resource=resource,
            share_pct__isnull=False,
            share_start__lte=range_end,
            share_end__gte=range_start,
            project__is_deleted=False,
        )
        .exclude(project_id=project_id)
        .values_list("project_id", "share_pct", "share_start", "share_end")
    ]
    committed = Task.committed.filter(project__is_deleted=False).exclude(status="COMPLETE")
    rows = (
        TaskResource.objects.filter(resource=resource, task_id__in=committed.values("pk"))
        .annotate(
            _span_start=Coalesce(
                "task__scheduled_start", "task__early_start", output_field=DateField()
            )
        )
        .filter(_span_start__lte=range_end, task__early_finish__gte=range_start)
        .values_list("task__project_id", "units", "_span_start", "task__early_finish")
    )
    spans.extend(
        _Span(
            str(pid),
            False,
            units * _HUNDRED,
            cast("datetime.date", start),
            cast("datetime.date", end),
        )
        for pid, units, start, end in rows
    )
    return spans


def _contributions(
    week: _Week, project: Any, share: Decimal, visible: dict[str, str]
) -> list[dict[str, Any]]:
    """What adds up to a week's load.

    A project the caller is not a member of is never named: its draw is folded into
    one anonymous ``other_work`` line so the parts still sum to the total.
    """
    own = str(project.pk)
    lines: list[dict[str, Any]] = [
        {
            "kind": "this_change",
            "project_id": own,
            "project_name": project.name,
            "pct": _pct(week.by_project.get(own, share)),
        }
    ]
    hidden = _ZERO
    for pid, value in sorted(week.by_project.items()):
        if pid == own:
            continue
        if pid in visible:
            lines.append(
                {
                    "kind": "other_project",
                    "project_id": pid,
                    "project_name": visible[pid],
                    "pct": _pct(value),
                }
            )
        else:
            hidden += value
    for kind, value in (("other_work", hidden), ("time_off", week.time_off)):
        if value > 0:
            lines.append(
                {"kind": kind, "project_id": None, "project_name": None, "pct": _pct(value)}
            )
    return lines


def _resolution(
    available: bool,
    start: datetime.date | None,
    end: datetime.date | None,
    weeks: list[_Week],
) -> dict[str, Any]:
    return {
        "available": available,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "peak_pct": _pct(max(w.load for w in weeks)) if weeks else None,
    }


def build_verdict(
    *,
    resource: Resource,
    project: Any,
    share_pct: int,
    start: datetime.date,
    end: datetime.date,
    visible_projects: dict[str, str],
) -> dict[str, Any]:
    """Judge a proposed booking against the person's own ceiling, week by week.

    Args:
        resource: The person; load their ``calendar__exceptions`` with them.
        project: The project the booking is on.
        share_pct: Proposed share of full time, every week of the window.
        start: First day of the window (inclusive).
        end: Last day of the window (inclusive).
        visible_projects: ``{project_id: name}`` the caller may see by name.

    Returns:
        The verdict body described by ``AllocationVerdictSerializer``.
    """
    calendar_row = resource.calendar or project.calendar
    calendar = _Calendar(
        calendar_row.working_days if calendar_row else _DEFAULT_WORKING_DAYS,
        _exception_ranges(calendar_row.exceptions) if calendar_row else [],
    )
    # The ceiling is the person's own default capacity, not a project override:
    # the check spans every project they are on (see ``capacity.py``).
    ceiling = resource.max_units * _HUNDRED
    share = Decimal(share_pct)
    horizon = end + _ONE_WEEK * MOVE_SEARCH_WEEKS
    others = _other_spans(resource, _monday(start), horizon + _ONE_WEEK, str(project.pk))

    def evaluate(window_start: datetime.date, window_end: datetime.date) -> list[_Week]:
        proposal = _Span(str(project.pk), True, share, window_start, window_end)
        return _weeks([proposal, *others], calendar, ceiling, window_start, window_end)

    def over(week: _Week) -> bool:
        return _pct(week.load) > _pct(ceiling)

    weeks = evaluate(start, end)
    breaking = next((w for w in weeks if over(w)), None)
    peak = max(weeks, key=lambda w: w.load)

    resolutions: dict[str, Any] | None = None
    if breaking is not None:
        # Shorten: stop the booking the day before the first week that breaks.
        if breaking.week_start > start:
            new_end = breaking.week_start - start.resolution
            shorten = _resolution(True, start, new_end, evaluate(start, new_end))
        else:
            shorten = _resolution(False, None, None, [])
        # Move: same length, the earliest later start (whole weeks) with no breaking week.
        move = _resolution(False, None, None, [])
        for offset in range(1, MOVE_SEARCH_WEEKS + 1):
            moved_start = start + _ONE_WEEK * offset
            moved_end = end + _ONE_WEEK * offset
            moved = evaluate(moved_start, moved_end)
            if not any(over(w) for w in moved):
                move = _resolution(True, moved_start, moved_end, moved)
                break
        resolutions = {
            "shorten": shorten,
            "move": move,
            "accept": _resolution(True, start, end, weeks),
        }

    return {
        "fits": breaking is None,
        "ceiling_pct": _pct(ceiling),
        "peak_pct": _pct(peak.load),
        "first_breaking_week": None
        if breaking is None
        else {
            "week_start": breaking.week_start.isoformat(),
            "load_pct": _pct(breaking.load),
            "contributions": _contributions(breaking, project, share, visible_projects),
        },
        "weeks": [
            {"week_start": w.week_start.isoformat(), "load_pct": _pct(w.load), "over": over(w)}
            for w in weeks
        ],
        "resolutions": resolutions,
        "as_of": timezone.now().isoformat(),
        "definitions": definitions_for(["allocation.load_pct"]),
    }
