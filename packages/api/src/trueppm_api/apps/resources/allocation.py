"""Allocation conflict check: the weekly verdict for a proposed booking (#4806, ADR-1500).

One function, :func:`build_verdict`, answers both the dry run and the real save, so the
two cannot disagree. It only reads.

A booking is a share of full time held across an inclusive date window
(``ProjectResource.share_pct`` / ``share_start`` / ``share_end``). On any day, a
project's draw on a person is the **larger** of its booked share and the person's
assigned ``TaskResource.units`` there: a booking is a reservation that tasks draw
down, so adding the two would count the same work twice. ``Task.assignee`` is never
counted (``TaskResource`` is the capacity record).

Only the days inside the proposed window are judged: a week the window starts or
ends in is read over its overlap with the window, never over days the booking does
not touch. And a week **breaks** only when the proposal leaves it over the ceiling
*and* higher than it is today, so a change that lowers a booking, or that lands in a
week already over for reasons it does not add to, is never refused.

Load on a project whose per-person load the caller may not read (ADR-1500 §7) is
counted in full but never displayed as a number: any figure it is part of is
``None``, and the verdict says only whether the week fits.

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

from trueppm_api.apps.projects.lifecycle import exclude_draft_projects
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
#: ``reason`` on a figure left out because it includes load the caller may not read.
WITHHELD = "withheld"

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
    hidden: bool  # The caller may not read this project's per-person load.
    proposal: bool = False


class _Week(NamedTuple):
    week_start: datetime.date
    load: Decimal
    time_off: Decimal
    by_project: dict[str, Decimal]
    proposal: Decimal  # This change's share on the peak day.
    withheld: bool  # Hidden load falls on the judged days.


class _Judged(NamedTuple):
    after: _Week  # With the proposal in place of this project's stored booking.
    before: _Week  # As things stand.


class _Calendar(NamedTuple):
    mask: int
    exceptions: list[tuple[datetime.date, datetime.date]]


def _monday(day: datetime.date) -> datetime.date:
    return day - day.resolution * day.weekday()


def _pct(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.1")))


def _week_load(
    spans: list[_Span],
    calendar: _Calendar,
    week_start: datetime.date,
    window: tuple[datetime.date, datetime.date],
    ceiling: Decimal,
) -> _Week:
    """The busiest judged day of one week, plus time off on those days as a percent.

    The judged days are the week's overlap with ``window``: a draw on a day the
    booking does not cover says nothing about whether the booking fits.
    """
    part_start = max(week_start, window[0])
    part_end = min(week_start + _ONE_WEEK - week_start.resolution, window[1])
    clipped = [
        s._replace(start=max(s.start, part_start), end=min(s.end, part_end))
        for s in spans
        if s.start <= part_end and s.end >= part_start
    ]
    nominal = _count_working_days_in_range(calendar.mask, [], part_start, part_end)
    time_off = _ZERO
    if nominal:
        working = _count_working_days_in_range(
            calendar.mask, calendar.exceptions, part_start, part_end
        )
        time_off = ceiling * Decimal(nominal - working) / Decimal(nominal)

    best_total, best_proposal = _ZERO, _ZERO
    best: dict[str, Decimal] = {}
    # Judged on the calendar's weekdays *ignoring* exceptions: time off is charged
    # once, as ``time_off``, and a booking inside an all-off week must still count.
    days = _peak_candidate_days([(s.pct, s.start, s.end) for s in clipped], calendar.mask, [])
    for day in sorted({d for d in days if part_start <= d <= part_end}):
        share: dict[str, Decimal] = defaultdict(Decimal)
        tasks: dict[str, Decimal] = defaultdict(Decimal)
        proposal = _ZERO
        for s in clipped:
            if s.start <= day <= s.end:
                (share if s.booked else tasks)[s.project_id] += s.pct
                if s.proposal:
                    proposal += s.pct
        by_project = {pid: max(share[pid], tasks[pid]) for pid in {*share, *tasks}}
        total = sum(by_project.values(), _ZERO)
        if total > best_total:
            best_total, best, best_proposal = total, by_project, proposal
    withheld = any(s.hidden and s.pct > 0 for s in clipped)
    return _Week(week_start, best_total + time_off, time_off, best, best_proposal, withheld)


def _spans(
    resource: Resource,
    range_start: datetime.date,
    range_end: datetime.date,
    project_id: str,
    visible: dict[str, str],
) -> tuple[list[_Span], list[_Span]]:
    """Every existing draw on the person that overlaps the range.

    Returns ``(others, stored)``: ``stored`` is this project's own booking, which the
    proposal replaces; ``others`` is everything else, this project's tasks included.
    Draft projects are left out, as on ``/me/people-load/`` (a half-built plan would
    put someone over on paper); archived projects count, as they do there.
    """
    bookings = exclude_draft_projects(
        ProjectResource.objects.active().filter(
            resource=resource,
            share_pct__isnull=False,
            share_start__lte=range_end,
            share_end__gte=range_start,
            project__is_deleted=False,
        )
    ).values_list("project_id", "share_pct", "share_start", "share_end")
    others: list[_Span] = []
    stored: list[_Span] = []
    for pid, pct, start, end in bookings:
        # The filter above excludes NULL share and window; ``cast`` narrows for mypy.
        span = _Span(
            str(pid),
            True,
            Decimal(cast("int", pct)),
            cast("datetime.date", start),
            cast("datetime.date", end),
            str(pid) not in visible,
        )
        (stored if str(pid) == project_id else others).append(span)
    committed = exclude_draft_projects(Task.committed.filter(project__is_deleted=False)).exclude(
        status="COMPLETE"
    )
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
    others.extend(
        _Span(
            str(pid),
            False,
            units * _HUNDRED,
            cast("datetime.date", start),
            cast("datetime.date", end),
            str(pid) not in visible,
        )
        for pid, units, start, end in rows
    )
    return others, stored


def _figure(value: Decimal, withheld: bool) -> float | None:
    return None if withheld else _pct(value)


def _contributions(week: _Week, project: Any, visible: dict[str, str]) -> list[dict[str, Any]]:
    """What adds up to a week's load.

    A project the caller may not read is never named and its draw never shown: it is
    one ``other_work`` line with a null ``pct``, and the week's ``load_pct`` is null
    too, so no visible figure is a total the hidden part could be subtracted from.
    The hidden part can still be inferred across repeated checks (ADR-1500). When
    nothing is hidden the parts sum to ``load_pct``.
    """
    own = str(project.pk)
    own_value = week.by_project.get(own, _ZERO) if own in visible else week.proposal
    lines: list[dict[str, Any]] = [
        {
            "kind": "this_change",
            "project_id": own,
            "project_name": project.name,
            "pct": _pct(own_value),
        }
    ]
    for pid, value in sorted(week.by_project.items()):
        if pid != own and pid in visible:
            lines.append(
                {
                    "kind": "other_project",
                    "project_id": pid,
                    "project_name": visible[pid],
                    "pct": _pct(value),
                }
            )
    if week.withheld:
        lines.append({"kind": "other_work", "project_id": None, "project_name": None, "pct": None})
    if week.time_off > 0:
        lines.append(
            {
                "kind": "time_off",
                "project_id": None,
                "project_name": None,
                "pct": _pct(week.time_off),
            }
        )
    return lines


def _peak(weeks: list[_Judged]) -> float | None:
    if not weeks or any(w.after.withheld for w in weeks):
        return None
    return _pct(max(w.after.load for w in weeks))


def _resolution(
    available: bool,
    start: datetime.date | None,
    end: datetime.date | None,
    weeks: list[_Judged],
) -> dict[str, Any]:
    return {
        "available": available,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "peak_pct": _peak(weeks),
        "peak_reason": WITHHELD if weeks and _peak(weeks) is None else None,
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
        visible_projects: ``{project_id: name}`` whose per-person load the caller may
            read (Scheduler or above, and the ADR-0104 ``capacity`` signal). Every
            other project's load is counted but withheld.

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
    own = str(project.pk)
    horizon = end + _ONE_WEEK * MOVE_SEARCH_WEEKS
    others, stored = _spans(resource, _monday(start), horizon + _ONE_WEEK, own, visible_projects)

    def evaluate(window_start: datetime.date, window_end: datetime.date) -> list[_Judged]:
        # The proposal is the caller's own input, so it is never hidden.
        proposal = _Span(own, True, share, window_start, window_end, False, True)
        after_spans = [proposal, *others]
        before_spans = [*stored, *others]
        window = (window_start, window_end)
        out = []
        cursor = _monday(window_start)
        while cursor <= window_end:
            out.append(
                _Judged(
                    _week_load(after_spans, calendar, cursor, window, ceiling),
                    _week_load(before_spans, calendar, cursor, window, ceiling),
                )
            )
            cursor += _ONE_WEEK
        return out

    def over(week: _Week) -> bool:
        return _pct(week.load) > _pct(ceiling)

    def breaks(judged: _Judged) -> bool:
        # Over the ceiling *because of* this change: it raises the week's peak.
        return over(judged.after) and _pct(judged.after.load) > _pct(judged.before.load)

    weeks = evaluate(start, end)
    breaking = next((w.after for w in weeks if breaks(w)), None)

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
            if not any(breaks(w) for w in moved):
                move = _resolution(True, moved_start, moved_end, moved)
                break
        resolutions = {
            "shorten": shorten,
            "move": move,
            "accept": _resolution(True, start, end, weeks),
        }

    peak = _peak(weeks)
    return {
        "fits": breaking is None,
        "ceiling_pct": _pct(ceiling),
        "peak_pct": peak,
        "peak_reason": WITHHELD if peak is None else None,
        "first_breaking_week": None
        if breaking is None
        else {
            "week_start": breaking.week_start.isoformat(),
            "load_pct": _figure(breaking.load, breaking.withheld),
            "reason": WITHHELD if breaking.withheld else None,
            "contributions": _contributions(breaking, project, visible_projects),
        },
        "weeks": [
            {
                "week_start": w.after.week_start.isoformat(),
                "load_pct": _figure(w.after.load, w.after.withheld),
                "reason": WITHHELD if w.after.withheld else None,
                "over": over(w.after),
                "breaks": breaks(w),
            }
            for w in weeks
        ],
        "resolutions": resolutions,
        "as_of": timezone.now().isoformat(),
        "definitions": definitions_for(["allocation.load_pct"]),
    }
