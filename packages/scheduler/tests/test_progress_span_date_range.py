"""A progress-derived span near the ends of the date range is refused, never a crash (#5190).

A started task with no recorded ``actual_start`` has its ``scheduled_start`` walked
back from its placement by the elapsed share of its duration. On a project starting
at ``date.min`` that walk used to underflow into a bare ``OverflowError``, which
escapes every ``except SchedulerError`` caller (the API's recompute task). The Rust
twin of the refusal is ``validate.rs::rejects_progress_derived_span_near_date_min``;
the shared fixture is ``fixtures/invalid/zero_remaining_at_min_date.json``.
"""

from __future__ import annotations

import contextlib
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    SchedulerError,
    Task,
    monte_carlo,
    schedule,
)


def _started(task_id: str = "a", *, zero_remaining: bool) -> Task:
    return Task(
        id=task_id,
        name=task_id,
        duration=timedelta(days=4),
        percent_complete=50.0,
        zero_remaining=zero_remaining,
    )


def _project(start: date, tasks: list[Task], deps: list[Dependency] | None = None) -> Project:
    return Project(id="p", name="p", start_date=start, tasks=tasks, dependencies=deps or [])


def test_zero_remaining_task_at_date_min_is_refused() -> None:
    """The reported repro: 4 days, 50%, zero_remaining, start 0001-01-01."""
    project = _project(date.min, [_started(zero_remaining=True)])
    with pytest.raises(InvalidScheduleInput, match="minimum representable date"):
        schedule(project)
    # Both public entry points share the validator, so Monte Carlo refuses it too.
    with pytest.raises(InvalidScheduleInput, match="minimum representable date"):
        monte_carlo(project, runs=10, max_runs=None, max_tasks=None)


def _shapes(start: date) -> list[Project]:
    succ = Task(id="b", name="b", duration=timedelta(days=3), percent_complete=40.0)
    pred = Task(id="a", name="a", duration=timedelta(days=0))
    return [
        _project(start, [_started(zero_remaining=True)]),
        _project(start, [_started(zero_remaining=False)]),
        # An SF link places its successor BEFORE the project start (#4218), so the
        # backward walk starts further down the range than start_date.
        _project(
            start,
            [pred, succ],
            [Dependency(predecessor_id="a", successor_id="b", dep_type=DependencyType.SF)],
        ),
    ]


_EDGE_STARTS = [date.min + timedelta(days=k) for k in (0, 1, 2, 3, 4, 5, 7, 10, 30)] + [
    date.max - timedelta(days=k) for k in (0, 1, 7, 36_600, 36_700)
]


@pytest.mark.parametrize("start", _EDGE_STARTS, ids=str)
def test_date_range_edges_raise_only_scheduler_error(start: date) -> None:
    """Sweep both ends of the range: either a schedule or a SchedulerError, nothing else.

    The date.max end is covered by the existing far-future guard; it is swept here
    so a progress-derived span cannot reopen the class at that end either.
    """
    for project in _shapes(start):
        with contextlib.suppress(SchedulerError):
            schedule(project)


def test_unstarted_work_at_date_min_still_schedules() -> None:
    """The guard is scoped to progress-derived spans; plain work at date.min is unchanged."""
    result = schedule(_project(date.min, [Task(id="a", name="a", duration=timedelta(days=4))]))
    assert result.project_start == date.min


def test_progress_on_an_ordinary_start_still_schedules() -> None:
    """A realistically dated project with the same task is untouched by the guard."""
    result = schedule(_project(date(2026, 1, 5), [_started(zero_remaining=True)]))
    assert result.project_start == date(2026, 1, 5)
