"""pytest-benchmark suite for ``schedule()`` and ``monte_carlo()`` (#4230).

Opt-in: the filename is ``bench_*.py``, which the default ``test_*.py`` collection
pattern does not match, so a bare ``pytest`` (and ``scheduler:test``) never runs it.
Name the file to run it::

    pytest tests/benchmarks/bench_engine.py --benchmark-only
    pytest tests/benchmarks/bench_engine.py --benchmark-json=bench.json

Two network shapes at 100 / 500 / 1,000 / 2,000 / 5,000 tasks:

* ``chain``: the worst-case single FS spine, the same shape as ``tests/test_bench.py``
  (every task has a three-point estimate so Monte Carlo samples all of them).
* ``mixed``: a branching network with FS/SS/FF dependencies, lags, three-point
  estimates on a fifth of the tasks, and per-task calendars (the ADR-0120 path, #2838).

This suite records timings; it asserts no time budget. ``test_bench.py`` remains the
hard circuit breaker. Each case does assert a structural result so a fast-but-wrong
engine cannot post a good number.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

pytest.importorskip("pytest_benchmark")

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
    schedule,
)

pytestmark = pytest.mark.perf_suite

SIZES = [100, 500, 1_000, 2_000, 5_000]
SHAPES = ["chain", "mixed"]
MC_RUNS = 1_000
_START = date(2026, 1, 5)


def _chain(n: int) -> Project:
    """An n-task FS chain with a PERT estimate on every task."""
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
        Dependency(predecessor_id=f"t{i - 1}", successor_id=f"t{i}", dep_type=DependencyType.FS)
        for i in range(1, n)
    ]
    return Project(
        id="bench-chain",
        name="Bench chain",
        start_date=_START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(),
    )


def _mixed(n: int) -> Project:
    """A branching network: ~2 predecessors per task within a 30-task window.

    Dependency types rotate FS/SS/FF with 0-3 day lags, a fifth of the tasks carry
    three-point estimates, and tasks alternate between the project calendar and two
    per-task calendars (a four-day week and a Mon-Sat week), so ``schedule()`` takes
    the per-task-calendar path. Seeded, so every run builds the identical network.
    """
    rng = random.Random(4230)
    types = [DependencyType.FS, DependencyType.SS, DependencyType.FF]
    cal_ids = [None, "four-day", "six-day"]
    tasks: list[Task] = []
    deps: list[Dependency] = []
    for i in range(n):
        extra: dict[str, object] = {}
        if i % 5 == 0:
            extra.update(
                optimistic_duration=timedelta(days=1),
                most_likely_duration=timedelta(days=3),
                pessimistic_duration=timedelta(days=6),
            )
        tasks.append(
            Task(
                id=f"t{i}",
                name=f"Task {i}",
                duration=timedelta(days=rng.randint(1, 10)),
                calendar_id=cal_ids[i % 3],
                **extra,  # type: ignore[arg-type]
            )
        )
        if i:
            for p in sorted({rng.randrange(max(0, i - 30), i) for _ in range(2)}):
                deps.append(
                    Dependency(
                        predecessor_id=f"t{p}",
                        successor_id=f"t{i}",
                        dep_type=types[(i + p) % 3],
                        lag=timedelta(days=rng.randint(0, 3)),
                    )
                )
    return Project(
        id="bench-mixed",
        name="Bench mixed",
        start_date=_START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(),
        calendars={
            "four-day": Calendar(working_days=0b0001111),
            "six-day": Calendar(working_days=0b0111111),
        },
    )


_BUILDERS = {"chain": _chain, "mixed": _mixed}


@pytest.mark.parametrize("n", SIZES)
@pytest.mark.parametrize("shape", SHAPES)
def test_bench_schedule(benchmark: pytest.FixtureRequest, shape: str, n: int) -> None:
    """Time ``schedule()`` on an n-task project of the given shape."""
    project = _BUILDERS[shape](n)
    result = benchmark.pedantic(schedule, args=(project,), rounds=5, iterations=1, warmup_rounds=1)  # type: ignore[attr-defined]
    assert len(result.tasks) == n


@pytest.mark.parametrize("n", SIZES)
@pytest.mark.parametrize("shape", SHAPES)
def test_bench_monte_carlo(benchmark: pytest.FixtureRequest, shape: str, n: int) -> None:
    """Time ``monte_carlo(runs=1000)`` on an n-task project of the given shape."""
    project = _BUILDERS[shape](n)
    result = benchmark.pedantic(  # type: ignore[attr-defined]
        monte_carlo,
        args=(project,),
        kwargs={"runs": MC_RUNS, "seed": 4230},
        rounds=3,
        iterations=1,
        warmup_rounds=1,
    )
    assert result.runs == MC_RUNS
    assert result.p50 <= result.p80 <= result.p95
