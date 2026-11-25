"""Project-wide variance of the current plan against one baseline (ADR-1485 D3, #5129).

A pure read of stored rows: the frozen ``BaselineTask`` snapshot against the
persisted CPM output of the live tasks. Deltas are signed **working** days on the
project's composed calendar, positive when the plan is later than the baseline.
Working time is decided by the scheduler ``Calendar``; nothing here recomputes a
schedule (ADR-0599).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from trueppm_api.apps.scheduling.finish_reading import (
    Finish,
    task_finish_at_day_start,
    working_time_end_day,
)

from .models import Baseline, BaselineTask, Task


@dataclass(frozen=True)
class Variance:
    """Every comparable task's row, plus the counts of what has no counterpart."""

    rows: list[dict[str, Any]]
    added: int
    removed: int


def _memoized_count(calendar: Any) -> Callable[[date, date], int]:
    """Inclusive working-day count, cached: a slipped plan repeats the same date pairs."""
    from .services import _layered_working_days

    seen: dict[tuple[date, date], int] = {}

    def count(first: date, last: date) -> int:
        key = (first, last)
        if key not in seen:
            seen[key] = _layered_working_days(calendar, first, last)
        return seen[key]

    return count


def _finish_delta(
    base: tuple[date | None, bool | None],
    current: tuple[date | None, bool],
    calendar: Any,
    count: Callable[[date, date], int],
) -> int | None:
    """Working days from the baseline finish to the current one: ``(base, current]``.

    Both are read as the *end* of a working-time day (#4178), so a milestone shown
    at the start of Monday against the end of Friday has not moved. A snapshot
    that predates the reading (``None``) is taken as unmoved on an equal day, as
    ``finish_shift_days`` does.
    """
    base_day, base_at_start = base
    current_day, current_at_start = current
    if base_day is None or current_day is None:
        return None
    if base_at_start is None and base_day == current_day:
        return 0
    prior: Finish = (base_day, bool(base_at_start))
    new: Finish = (current_day, current_at_start)
    a = working_time_end_day(prior, calendar)
    b = working_time_end_day(new, calendar)
    if b >= a:
        return count(a, b) - int(calendar.is_working_day(a))
    return -(count(b, a) - int(calendar.is_working_day(b)))


def _start_delta(
    base: date | None, current: date | None, calendar: Any, count: Callable[[date, date], int]
) -> int | None:
    """Working days from the baseline start to the current one: ``[base, current)``."""
    if base is None or current is None:
        return None
    if current >= base:
        return count(base, current) - int(calendar.is_working_day(current))
    return -(count(current, base) - int(calendar.is_working_day(base)))


def _sort_key(row: dict[str, Any]) -> tuple[bool, int, int, str, str]:
    """Latest finish slip first; rows with no finish to compare go last."""
    finish = row["finish_delta_working_days"]
    return (
        finish is None,
        -(finish or 0),
        -(row["start_delta_working_days"] or 0),
        row["task_name"],
        row["task_id"],
    )


def baseline_variance(baseline: Baseline, calendar: Any, *, min_days: int) -> Variance:
    """Compare the live tasks of ``baseline.project`` with the snapshot.

    A task is listed when the absolute start **or** finish delta is at least
    ``min_days``; ``min_days=0`` lists every task present on both sides,
    including those with no dates to compare. Two queries, whatever the size.
    """
    snapshot = {
        row["task_id"]: row
        for row in BaselineTask.objects.filter(baseline=baseline).values(
            "task_id", "start", "finish", "finish_at_day_start"
        )
    }
    live = list(
        Task.objects.filter(project_id=baseline.project_id, is_deleted=False).only(
            "id",
            "name",
            "is_milestone",
            "milestone_at_day_end",
            "scheduled_start",
            "early_start",
            "early_finish",
        )
    )
    count = _memoized_count(calendar)
    rows: list[dict[str, Any]] = []
    added = 0
    for task in live:
        base = snapshot.get(task.pk)
        if base is None:
            added += 1
            continue
        # The SPAN start (ADR-0752), matching what the capture froze (#2623).
        current_start = task.scheduled_start or task.early_start
        current_at_start = task_finish_at_day_start(task)
        finish_delta = _finish_delta(
            (base["finish"], base["finish_at_day_start"]),
            (task.early_finish, current_at_start),
            calendar,
            count,
        )
        # A milestone is one instant, so its start is read like its finish (#4197).
        if task.is_milestone:
            start_delta = _finish_delta(
                (base["start"], base["finish_at_day_start"]),
                (current_start, current_at_start),
                calendar,
                count,
            )
        else:
            start_delta = _start_delta(base["start"], current_start, calendar, count)
        if min_days and max(abs(start_delta or 0), abs(finish_delta or 0)) < min_days:
            continue
        rows.append(
            {
                "task_id": str(task.pk),
                "task_name": task.name,
                "is_milestone": task.is_milestone,
                "baseline_start": base["start"],
                "baseline_finish": base["finish"],
                "current_start": current_start,
                "current_finish": task.early_finish,
                "start_delta_working_days": start_delta,
                "finish_delta_working_days": finish_delta,
            }
        )
    rows.sort(key=_sort_key)
    live_ids = {task.pk for task in live}
    removed = sum(1 for task_id in snapshot if task_id not in live_ids)
    return Variance(rows=rows, added=added, removed=removed)
