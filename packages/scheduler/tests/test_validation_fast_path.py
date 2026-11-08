"""The exact-type validation fast paths must not change what is accepted or said (#4711).

Each case is an input the fast path must NOT wave through — a subclass of the
expected type, or a value only the full check catches — pinned to the exact message
the full check has always produced.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    schedule,
)


class _TD(timedelta):
    """A timedelta subclass: valid for isinstance, not for the exact-type fast path."""


def _project(**task_kw: object) -> Project:
    t = Task(id="a", name="A", duration=timedelta(days=2))
    for k, v in task_kw.items():
        setattr(t, k, v)
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),
        tasks=[t, Task(id="b", name="B", duration=timedelta(days=1))],
        dependencies=[Dependency("a", "b", DependencyType.FS, timedelta(0))],
        calendar=Calendar(working_days=31, hours_per_day=8.0, timezone="UTC"),
    )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        (
            "planned_start",
            datetime(2026, 1, 6, 9),
            "Task 'a' planned_start must be a date, not datetime.",
        ),
        (
            "actual_start",
            datetime(2026, 1, 6, 9),
            "Task 'a' actual_start must be a date, not datetime.",
        ),
        (
            "early_start",
            datetime(2026, 1, 6, 9),
            "Task 'a' early_start must be a date or None (got datetime: ",
        ),
        ("is_critical", 1, "Task 'a' is_critical must be a bool (got 1)."),
        ("total_float", None, "Task 'a' total_float must be a timedelta (got NoneType: None)."),
        ("name", 5, "Task 'a' name must be a string, got int: 5."),
        ("calendar_id", 7, "Task 'a' calendar_id must be a string or None, not int."),
    ],
)
def test_fast_path_misses_keep_the_full_check_message(
    field: str, value: object, message: str
) -> None:
    with pytest.raises(InvalidScheduleInput) as exc:
        schedule(_project(**{field: value}))
    assert str(exc.value).startswith(message), str(exc.value)


def test_timedelta_subclass_with_whole_days_still_schedules() -> None:
    """A subclass misses the fast path but passes the full check, as before."""
    result = schedule(_project(duration=_TD(days=2)))
    assert result.tasks[0].id == "a"


def test_bool_is_not_accepted_as_a_date_or_timedelta_slot() -> None:
    with pytest.raises(InvalidScheduleInput, match="duration must be a timedelta"):
        schedule(_project(duration=True))


def test_first_error_wins_for_a_multi_error_task() -> None:
    """duration is reported before a later bad field, as the full checks ordered them."""
    with pytest.raises(InvalidScheduleInput, match="Task 'a' duration must be a timedelta"):
        schedule(_project(duration="x", is_critical=3))


def test_sub_day_lag_and_dependency_label_unchanged() -> None:
    p = _project()
    p.dependencies[0].lag = timedelta(hours=3)
    with pytest.raises(InvalidScheduleInput) as exc:
        schedule(p)
    assert str(exc.value).startswith("Dependency 'a' → 'b' lag must be a whole number of days")
