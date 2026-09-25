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

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
    schedule,
)


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
    "task_count,budget_s,expected_finish",
    [
        # A 1-day-per-task FS chain occupies the first ``task_count`` working days
        # (Mon-Fri) starting from the project-start floor. ``start_date`` 2026-01-04
        # is a Sunday, so the floor is Mon 2026-01-05 (working day #1). The finish
        # is therefore working day #task_count from Mon 2026-01-05:
        #   100 → Fri 2026-05-22, 500 → Fri 2027-12-03 (both the 5th weekday of
        #   their week, since 100 and 500 are ≡ 0 mod 5).
        (100, 1.0, date(2026, 5, 22)),
        (500, 2.0, date(2027, 12, 3)),
    ],
    ids=["100-tasks", "500-tasks"],
)
def test_schedule_performance(task_count: int, budget_s: float, expected_finish: date) -> None:
    """schedule() must complete within budget_s AND land on the exact finish date.

    The exact-finish assertion turns the bench into a correctness guard too: a
    fast-but-wrong scheduler (e.g. one that skips a working-day advance) would keep
    ``scheduler:bench`` green on the old ``result is not None`` + task-count checks
    alone (#1511). The nth-working-day finish is the computable oracle.
    """
    project = _make_fs_chain(task_count)

    # Warm-up: first call may include import-time costs.
    schedule(project)

    # Timed run.
    t0 = time.perf_counter()
    result = schedule(project)
    elapsed = time.perf_counter() - t0

    assert len(result.tasks) == task_count
    assert result.project_finish == expected_finish
    assert elapsed < budget_s, (
        f"schedule() on {task_count}-task chain took {elapsed:.3f}s — budget is {budget_s}s. "
        "This indicates a performance regression. Profile with cProfile before investigating."
    )


def _make_mixed_topology(n: int, start: date = date(2026, 1, 5)) -> Project:
    """Build an n-task mixed-topology project with ~2n dependencies.

    A pure FS chain (test above) exercises the deepest single forward path but a
    thin graph. A real schedule fans out: every task also links to its
    grandparent with a rotating dependency type, roughly doubling the edge count
    and mixing FS/SS/FF constraint propagation. All edges point from a lower to a
    higher index, so the graph stays acyclic no matter how the links interleave.
    """
    tasks = [Task(id=f"t{i}", name=f"Task {i}", duration=timedelta(days=1)) for i in range(n)]
    rotating = [DependencyType.FS, DependencyType.SS, DependencyType.FF]
    deps = [
        Dependency(
            predecessor_id=f"t{i - 1}",
            successor_id=f"t{i}",
            dep_type=DependencyType.FS,
            lag=timedelta(0),
        )
        for i in range(1, n)
    ]
    deps += [
        Dependency(
            predecessor_id=f"t{i - 2}",
            successor_id=f"t{i}",
            dep_type=rotating[i % 3],
            lag=timedelta(0),
        )
        for i in range(2, n)
    ]
    return Project(
        id="bench-mixed",
        name="Bench Mixed",
        start_date=start,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=31, hours_per_day=8.0, timezone="UTC"),
    )


def test_schedule_large_mixed_topology_performance() -> None:
    """schedule() on 5,000 tasks / ~10,000 mixed-type deps must stay near-linear.

    This is a throughput tripwire, not a tight SLA (#1862): a healthy run is well
    under 200 ms, so the 5 s budget is a comfortable ~25x headroom on CI while
    still failing loudly on a super-linear regression (an accidental O(n²) graph
    walk on 5,000 tasks is ~25M ops and would blow past 5 s immediately).
    """
    project = _make_mixed_topology(5_000)
    assert len(project.dependencies) >= 9_990  # ~2n edges

    schedule(project)  # warm-up (import/JIT-style first-call costs)

    t0 = time.perf_counter()
    result = schedule(project)
    elapsed = time.perf_counter() - t0

    assert len(result.tasks) == 5_000
    assert elapsed < 5.0, (
        f"schedule() on a 5,000-task / ~10,000-dep mixed graph took {elapsed:.3f}s — "
        "budget is 5.0s. This indicates a super-linear regression; profile with cProfile."
    )


def _make_pert_chain(n: int, start: date = date(2026, 1, 5)) -> Project:
    """An n-task FS chain where every task carries a three-point PERT estimate.

    Every task samples from a PERT-Beta each run, so the Monte Carlo simulation
    does real per-run work on all n tasks rather than short-circuiting on
    deterministic durations.
    """
    tasks = [
        Task(
            id=f"t{i}",
            name=f"Task {i}",
            duration=timedelta(days=3),
            optimistic_duration=timedelta(days=2),
            most_likely_duration=timedelta(days=3),
            pessimistic_duration=timedelta(days=6),
        )
        for i in range(n)
    ]
    deps = [
        Dependency(
            predecessor_id=f"t{i - 1}",
            successor_id=f"t{i}",
            dep_type=DependencyType.FS,
            lag=timedelta(0),
        )
        for i in range(1, n)
    ]
    return Project(
        id="bench-mc",
        name="Bench MC",
        start_date=start,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=31, hours_per_day=8.0, timezone="UTC"),
    )


def test_monte_carlo_large_run_performance() -> None:
    """monte_carlo() on 1,000 PERT tasks x 10,000 runs must stay well-bounded.

    10M task-samples is the stress case the vectorized sampler is built for; a
    healthy run is under ~1 s, so the 8 s budget is a generous tripwire (#1862).
    A regression that de-vectorizes the sampler (a Python per-run loop) would push
    this into tens of seconds and trip the budget. The percentile ordering assert
    doubles the bench as a correctness guard — a broken sampler that returns fast
    garbage would violate P50 <= P80 <= P95.
    """
    project = _make_pert_chain(1_000)

    t0 = time.perf_counter()
    result = monte_carlo(project, runs=10_000, seed=1862)
    elapsed = time.perf_counter() - t0

    assert result.p50 <= result.p80 <= result.p95
    assert elapsed < 8.0, (
        f"monte_carlo() on 1,000 tasks x 10,000 runs took {elapsed:.3f}s — budget is 8.0s. "
        "This indicates a Monte Carlo throughput regression; profile with cProfile."
    )


def _make_distinct_lag_project(n_tasks: int, n_lags: int, task_days: int) -> Project:
    """A serial chain of ``n_tasks`` with ``n_lags`` distinct FS lag values.

    The lag-delta table holds one array per distinct ``(dep_type, lag)`` key and
    each array is ``index_size`` (the whole working-day span) cells long, so the
    table scales with distinct lags x span and NOT with ``runs`` (#4129).
    """
    tasks = [
        Task(id=f"t{i}", name=f"Task {i}", duration=timedelta(days=task_days))
        for i in range(n_tasks)
    ]
    deps = [
        Dependency(
            predecessor_id=f"t{i - 1}",
            successor_id=f"t{i}",
            dep_type=DependencyType.FS,
            lag=timedelta(days=1 + (i % n_lags)),
        )
        for i in range(1, n_tasks)
    ]
    return Project(
        id="bench-lag",
        name="Bench Lag Project",
        start_date=date(2026, 1, 5),
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=31, hours_per_day=8.0, timezone="UTC"),
    )


def test_monte_carlo_lag_delta_table_peak_memory() -> None:
    """The lag-delta table is int32 and its footprint is asserted, not just its time (#4129).

    150 distinct FS lags over a 1,000 x 8-day chain is 150 x index_size cells. Measured
    with ``tracemalloc`` (numpy allocations are traced; portable where RSS is not):
    float64 storage peaked at ~112 MB, int32 at ~63 MB. The 85 MB bound sits between
    the two, so reverting to float64 fails it while allocator noise does not.
    """
    import tracemalloc

    project = _make_distinct_lag_project(1_000, 150, 8)

    tracemalloc.start()
    try:
        result = monte_carlo(project, runs=50, seed=4129)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert result.p50 <= result.p80 <= result.p95
    assert peak < 85_000_000, (
        f"peak {peak / 1e6:.1f} MB — the lag-delta table is no longer int32 "
        "(float64 storage peaks at ~112 MB on this shape)."
    )


def test_monte_carlo_max_lag_delta_cells_rejects_before_allocating() -> None:
    """A request-scoped ``max_lag_delta_cells`` rejects an over-cap table (#4129)."""
    import tracemalloc

    from trueppm_scheduler import InvalidScheduleInput

    project = _make_distinct_lag_project(400, 60, 5)

    tracemalloc.start()
    try:
        with pytest.raises(InvalidScheduleInput, match="lag-delta table would exceed 10,000"):
            monte_carlo(project, runs=10, seed=1, max_lag_delta_cells=10_000)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 5_000_000
