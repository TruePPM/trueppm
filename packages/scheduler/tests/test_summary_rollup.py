"""``roll_up_summary`` derives a summary row from its scheduled leaves (#5010)."""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import (
    Dependency,
    Project,
    Task,
    collect_leaves,
    expand_summary_dependencies,
    roll_up_summary,
    schedule,
)

_D = timedelta(days=1)


def _leaf(task_id: str, **fields: object) -> Task:
    task = Task(id=task_id, name=task_id, duration=_D)
    for key, value in fields.items():
        setattr(task, key, value)
    return task


def test_rolls_up_extremes_tightest_float_and_any_critical() -> None:
    a = _leaf(
        "a",
        early_start=date(2026, 3, 2),
        early_finish=date(2026, 3, 4),
        late_start=date(2026, 3, 5),
        late_finish=date(2026, 3, 9),
        scheduled_start=date(2026, 2, 27),
        total_float=3 * _D,
        free_float=2 * _D,
    )
    b = _leaf(
        "b",
        early_start=date(2026, 3, 3),
        early_finish=date(2026, 3, 10),
        late_start=date(2026, 3, 3),
        late_finish=date(2026, 3, 10),
        scheduled_start=date(2026, 3, 3),
        total_float=timedelta(0),
        is_critical=True,
    )

    rolled = roll_up_summary("s", [a, b], name="Phase 1")

    assert rolled is not None
    assert (rolled.id, rolled.name, rolled.duration) == ("s", "Phase 1", timedelta(0))
    assert rolled.early_start == date(2026, 3, 2)
    assert rolled.early_finish == date(2026, 3, 10)
    assert rolled.late_start == date(2026, 3, 3)
    assert rolled.late_finish == date(2026, 3, 10)
    assert rolled.scheduled_start == date(2026, 2, 27)
    assert rolled.total_float == timedelta(0)
    assert rolled.free_float == timedelta(0)
    assert rolled.is_critical is True


def test_missing_late_and_scheduled_dates_fall_back_to_the_early_dates() -> None:
    leaf = _leaf("a", early_start=date(2026, 3, 2), early_finish=date(2026, 3, 4))
    rolled = roll_up_summary("s", iter([leaf]))
    assert rolled is not None
    assert rolled.name == "s"
    assert rolled.late_start == rolled.scheduled_start == date(2026, 3, 2)
    assert rolled.late_finish == date(2026, 3, 4)
    assert rolled.is_critical is False


def test_no_leaf_with_both_early_dates_rolls_up_to_none() -> None:
    assert roll_up_summary("s", []) is None
    assert roll_up_summary("s", [_leaf("a", early_start=date(2026, 3, 2))]) is None


def test_rolls_up_a_real_schedule_result() -> None:
    tasks = [
        Task(id="s", name="s", duration=timedelta(0)),
        Task(id="a", name="a", duration=2 * _D),
        Task(id="b", name="b", duration=3 * _D),
        Task(id="c", name="c", duration=_D),
    ]
    children = {"s": ["a", "b"]}
    leaves, deps = expand_summary_dependencies(tasks, [Dependency("a", "c")], children)
    project = Project(
        id="p", name="p", start_date=date(2026, 3, 2), tasks=leaves, dependencies=deps
    )
    result = schedule(project)
    by_id = {t.id: t for t in result.tasks}

    rolled = roll_up_summary("s", [by_id[i] for i in collect_leaves("s", children)])

    assert rolled is not None
    assert rolled.early_start == date(2026, 3, 2)
    assert rolled.early_finish == max(by_id["a"].early_finish, by_id["b"].early_finish)
    assert rolled.total_float == min(by_id["a"].total_float, by_id["b"].total_float)
    assert rolled.is_critical == (by_id["a"].is_critical or by_id["b"].is_critical)
