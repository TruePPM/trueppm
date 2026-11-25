"""Project-wide variance of the current plan against one baseline (ADR-1485 D3, #5129).

A pure read of stored rows: the frozen ``BaselineTask`` snapshot against the
persisted CPM output of the live tasks. Deltas are signed **working** days on the
project's composed calendar, positive when the plan is later than the baseline.
Working time is decided by the scheduler ``Calendar``; nothing here recomputes a
schedule (ADR-0599).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
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
    """Every comparable task's row, the counts of what has no counterpart, and the rollup."""

    rows: list[dict[str, Any]]
    added: int
    removed: int
    summary: dict[str, Any]


def _memoized_count(calendar: Any) -> Callable[[date, date], int]:
    """Inclusive working-day count, cached: a slipped plan repeats the same date pairs."""
    # TODO(#5009): call trueppm_scheduler's working_day_count once scheduler 0.5 is on
    # PyPI. The API still supports 0.4.0, which does not have it, so importing it
    # would break an install of the published wheel.
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
            "wbs_path",
        )
    )
    count = _memoized_count(calendar)
    summary_ids = _summary_task_ids(live)
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
    summary = {
        **_rollup(rows, summary_ids, min_days),
        "project_finish": _project_finish(snapshot.values(), live, calendar, count),
    }
    return Variance(rows=rows, added=added, removed=removed, summary=summary)


def _summary_task_ids(live: list[Task]) -> set[str]:
    """Ids of the live tasks with a live structural child (``task_is_summary``, in memory).

    A summary task's dates are rolled up from its children, so counting it beside
    them would report one slip twice.
    """
    parents = {
        str(task.wbs_path).rsplit(".", 1)[0]
        for task in live
        if task.wbs_path and "." in str(task.wbs_path)
    }
    return {str(task.pk) for task in live if task.wbs_path and str(task.wbs_path) in parents}


def _rollup(rows: list[dict[str, Any]], summary_ids: set[str], min_days: int) -> dict[str, Any]:
    """Aggregate the leaf rows into the "what moved" counts.

    Summary tasks are left out so a slip is counted once, on the task that
    actually moved. A task *moved* when its start or finish moved by at least
    ``max(min_days, 1)`` working days, so ``min_days=0`` never counts an unmoved
    task. ``top_slip`` is the leaf whose finish slipped most: ``rows`` is already
    latest-finish-slip first, so it is the first slipped leaf.
    """
    threshold = max(min_days, 1)
    moved = later = earlier = slip_total = 0
    top: dict[str, Any] | None = None
    for row in rows:
        if row["task_id"] in summary_ids:
            continue
        start = row["start_delta_working_days"] or 0
        finish = row["finish_delta_working_days"] or 0
        if max(abs(start), abs(finish)) < threshold:
            continue
        moved += 1
        if finish >= threshold:
            later += 1
            slip_total += finish
            if top is None:
                top = {
                    "task_id": row["task_id"],
                    "task_name": row["task_name"],
                    "baseline_finish": row["baseline_finish"],
                    "current_finish": row["current_finish"],
                    "finish_delta_working_days": finish,
                }
        elif finish <= -threshold:
            earlier += 1
    return {
        "tasks_moved": moved,
        "tasks_finishing_later": later,
        "tasks_finishing_earlier": earlier,
        "finish_slip_working_days_total": slip_total,
        "top_slip": top,
    }


def _latest(
    finishes: Iterable[tuple[date | None, bool | None]],
) -> tuple[date, bool | None] | None:
    """The latest finish reading; the end of a day is later than its start."""
    best: tuple[date, bool | None] | None = None
    for day, at_start in finishes:
        if day is None:
            continue
        if best is None or (day, not at_start) > (best[0], not best[1]):
            best = (day, at_start)
    return best


def _project_finish(
    snapshot: Iterable[dict[str, Any]],
    live: list[Task],
    calendar: Any,
    count: Callable[[date, date], int],
) -> dict[str, Any]:
    """The project finish (latest task finish) in the baseline and now, and the shift.

    Every snapshot row counts, including a task deleted since, because the
    baseline's finish is what was committed; every live task counts, including
    one added since. The shift is read like a task's finish delta.
    """
    base = _latest((row["finish"], row["finish_at_day_start"]) for row in snapshot)
    current = _latest((task.early_finish, task_finish_at_day_start(task)) for task in live)
    delta = (
        _finish_delta(base, (current[0], bool(current[1])), calendar, count)
        if base is not None and current is not None
        else None
    )
    return {
        "baseline_finish": base[0] if base else None,
        "current_finish": current[0] if current else None,
        "delta_working_days": delta,
    }
