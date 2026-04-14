"""CPM performance benchmark — regression guard for scheduler throughput.

Run by the ``scheduler:bench`` CI job, which stores timing as an artifact
and fails if the 500-task chain exceeds 2 s. The 2 s budget is deliberately
conservative (typical run is < 50 ms); the goal is catching catastrophic
regressions (O(n²) graph walk, missing index, accidental full recompute).

Per the Wave 2 scope decision: the bench CI job tracks timing across commits
and alerts on > 20% regression. The 2 s hard limit in this test is the
circuit-breaker for outright failures; the CI artifact-based comparison is
the per-commit regression signal.
"""

from __future__ import annotations

import time
from datetime import date, timedelta

import pytest

from trueppm_scheduler import Calendar, Dependency, DependencyType, Project, Task, schedule


def _make_fs_chain(n: int, start: date = date(2026, 1, 4)) -> Project:
    """Build an n-task FS chain — worst-case for forward-pass traversal."""
    tasks = [Task(id=f"t{i}", name=f"Task {i}", duration=timedelta(days=1)) for i in range(n)]
    deps = [
        Dependency(
            predecessor_id=f"t{i}",
            successor_id=f"t{i + 1}",
            dep_type=DependencyType.FS,
            lag=timedelta(0),
        )
        for i in range(n - 1)
    ]
    return Project(
        id="bench",
        name="Bench Project",
        start_date=start,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=31, hours_per_day=8.0, timezone="UTC"),
    )


@pytest.mark.parametrize(
    "task_count,budget_s",
    [
        (100, 1.0),
        (500, 2.0),
    ],
    ids=["100-tasks", "500-tasks"],
)
def test_schedule_performance(task_count: int, budget_s: float) -> None:
    """schedule() must complete within budget_s for the given task_count."""
    project = _make_fs_chain(task_count)

    # Warm-up: first call may include import-time costs.
    schedule(project)

    # Timed run.
    t0 = time.perf_counter()
    result = schedule(project)
    elapsed = time.perf_counter() - t0

    assert result is not None
    assert len(result.tasks) == task_count
    assert elapsed < budget_s, (
        f"schedule() on {task_count}-task chain took {elapsed:.3f}s — budget is {budget_s}s. "
        "This indicates a performance regression. Profile with cProfile before investigating."
    )
