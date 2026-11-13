"""``Project``, ``ScheduleResult`` and ``MonteCarloResult`` print as one bounded line (#4547).

The dataclass default repr is O(tasks): 26 KB for a 50-task project, megabytes at the
50k-task envelope, which is what a stray ``print()`` or a REPL echo emitted. These three
containers now summarize (counts, dates, a handful of ids, ``…``); ``to_dict()`` stays
the full-fidelity form, and the small value types keep the dataclass default, which
still round-trips through ``eval``.
"""

from __future__ import annotations

import dataclasses
import datetime
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine.results import DrivingEdge, MonteCarloResult, Percentile

_BOUND = 500  # characters; a one-line summary, however large the project


def _project(n: int) -> Project:
    tasks = [Task(id=f"task-{i}", name=f"Task {i}", duration=timedelta(days=2)) for i in range(n)]
    deps = [Dependency(f"task-{i}", f"task-{i + 1}", DependencyType.FS) for i in range(n - 1)]
    return Project(
        id="big", name="Big project", start_date=date(2026, 3, 2), tasks=tasks, dependencies=deps
    )


@pytest.mark.parametrize("n", [1, 5, 50, 500])
def test_project_repr_is_bounded_regardless_of_task_count(n: int) -> None:
    text = repr(_project(n))
    assert len(text) < _BOUND
    assert "\n" not in text


def test_project_repr_summarizes_counts_dates_and_leading_ids() -> None:
    text = repr(_project(500))
    assert "id='big'" in text
    assert "start_date=2026-03-02" in text
    assert "tasks=<500: 'task-0', 'task-1', 'task-2', …>" in text
    assert "dependencies=<499: 'task-0->task-1'" in text.replace('"', "'")
    assert "task-499" not in text


def test_project_repr_shows_every_id_when_there_are_few() -> None:
    text = repr(_project(2))
    assert "tasks=<2: 'task-0', 'task-1'>" in text
    assert "…" not in text.split("dependencies=")[0]


def test_project_repr_caps_a_hostile_id() -> None:
    p = Project(id="x" * 10_000, name="n" * 10_000, start_date=date(2026, 3, 2))
    assert len(repr(p)) < _BOUND


def test_project_repr_does_not_raise_on_a_malformed_direct_object() -> None:
    # The validators exist to refuse this; a repr in their failure message must not crash.
    p = Project(id="p", name="p", start_date="2026-03-02", tasks=None, dependencies=7)  # type: ignore[arg-type]
    assert "tasks=None" in repr(p)


def test_project_to_dict_stays_full_fidelity() -> None:
    p = _project(50)
    assert len(p.to_dict()["tasks"]) == 50
    assert Project.from_dict(p.to_dict()).to_dict() == p.to_dict()


def test_schedule_result_repr_is_bounded_and_carries_the_finish_date() -> None:
    result = schedule(_project(500))
    text = repr(result)
    assert len(text) < _BOUND
    assert f"project_finish={result.project_finish.isoformat()}" in text
    assert "tasks=<500:" in text
    assert "critical_path=<500:" in text
    assert "…" in text
    assert len(result.to_dict()["tasks"]) == 500


def test_schedule_result_repr_lists_driving_edges_as_a_count() -> None:
    result = schedule(_project(5))
    assert f"driving_edges=<{len(result.driving_edges)}:" in repr(result)


def test_monte_carlo_result_repr_is_bounded_in_run_count() -> None:
    mc = monte_carlo(_project(20), runs=2_000, seed=1, max_tasks=None)
    text = repr(mc)
    assert len(text) < _BOUND
    assert "runs=2000" in text
    assert "distribution=<2000 dates:" in text
    assert "percentiles={50:" in text
    assert mc.p95.isoformat() in text
    assert len(mc.to_dict()["distribution"]) == 2_000


def test_monte_carlo_result_repr_with_nothing_to_show() -> None:
    d = date(2026, 3, 2)
    text = repr(MonteCarloResult("p", 0, d, d, d))
    assert "distribution=<0 dates: none>" in text
    assert "sensitivity=<0>" in text


def test_monte_carlo_result_repr_orders_extra_levels() -> None:
    d1, d2, d3, d4 = (date(2026, 3, 2) + timedelta(days=i) for i in range(4))
    mc = MonteCarloResult(
        "p",
        1,
        percentiles={
            95: Percentile(d3),
            50: Percentile(d1),
            80: Percentile(d2),
            99: Percentile(d4),
        },
    )
    levels = (
        f"50: {d1.isoformat()}, 80: {d2.isoformat()}, 95: {d3.isoformat()}, 99: {d4.isoformat()}"
    )
    assert f"percentiles={{{levels}}}" in repr(mc)


@pytest.mark.parametrize(
    "value",
    [
        Task(id="A", name="A", duration=timedelta(days=3)),
        Dependency("A", "B", DependencyType.SS, lag=timedelta(days=1)),
        Calendar(),
        Percentile(date(2026, 3, 2), True),
        DrivingEdge("A", "B", "FS"),
    ],
)
def test_small_value_types_keep_the_dataclass_default_repr(value: object) -> None:
    """Only the three containers summarize; a small value type still shows every field."""
    default = dataclasses_repr(value)
    assert repr(value) == default


def dataclasses_repr(value: object) -> str:
    """What ``@dataclass`` would generate: ``Cls(field=repr, ...)`` over every init field."""
    names = [f.name for f in dataclasses.fields(value) if f.repr]  # type: ignore[arg-type]
    body = ", ".join(f"{n}={getattr(value, n)!r}" for n in names)
    return f"{type(value).__qualname__}({body})"


def test_task_repr_still_round_trips_through_eval() -> None:
    task = Task(id="A", name="A", duration=timedelta(days=3))
    assert eval(repr(task), {"Task": Task, "datetime": datetime}) == task
