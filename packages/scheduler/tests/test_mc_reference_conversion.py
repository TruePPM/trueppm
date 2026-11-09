"""The multi-calendar Monte Carlo path converts columns to the union ruler per calendar (#4710).

Converting an exclusive offset in calendar c to the union ruler is a fixed function
of c, so the engine tabulates it once per calendar and gathers whole column groups
in place instead of re-running a searchsorted per column. These tests pin that the
result is unchanged (values captured from the per-column implementation it replaced)
and that one extra calendar costs an index-sized table, not a runs x tasks matrix.
"""

from __future__ import annotations

import hashlib
import tracemalloc
from datetime import date, timedelta
from typing import Any

import pytest

from trueppm_scheduler import Calendar, DateRange, Dependency, Project, Task, engine, monte_carlo
from trueppm_scheduler.models import DependencyType

START = date(2026, 3, 2)  # Monday


def _mixed_project() -> Project:
    """Thirty PERT tasks over three calendars, FS/SS/FF/SF edges and a milestone."""
    cals = {
        "seven": Calendar(working_days=0b111_1111),
        "tue_sat": Calendar(
            working_days=0b101_1110 << 0,
            exceptions=(DateRange(date(2026, 4, 7), date(2026, 4, 9)),),
        ),
    }
    keys: list[str | None] = [None, "seven", "tue_sat"]
    tasks: list[Task] = []
    deps: list[Dependency] = []
    kinds = [DependencyType.FS, DependencyType.SS, DependencyType.FF, DependencyType.SF]
    for i in range(30):
        d = 2 + (i * 7) % 9
        tasks.append(
            Task(
                id=f"t{i}",
                name=f"t{i}",
                duration=timedelta(days=d),
                optimistic_duration=timedelta(days=max(1, d - 1)),
                most_likely_duration=timedelta(days=d),
                pessimistic_duration=timedelta(days=d + 1 + i % 4),
                calendar_id=keys[i % 3],
            )
        )
        if i >= 3:
            deps.append(
                Dependency(
                    f"t{i - 3}",
                    f"t{i}",
                    kinds[i % 4] if i % 5 else DependencyType.FS,
                    timedelta(days=i % 3),
                )
            )
    tasks.append(Task(id="m", name="m", duration=timedelta(0), calendar_id="seven"))
    deps.append(Dependency("t29", "m"))
    return Project(
        id="p", name="p", start_date=START, tasks=tasks, dependencies=deps, calendars=cals
    )


def _snapshot() -> dict[str, Any]:
    d = monte_carlo(_mixed_project(), runs=500, seed=4710).to_dict()
    digest = hashlib.sha256("|".join(d["distribution"]).encode()).hexdigest()
    return {
        "p50": d["p50"],
        "p80": d["p80"],
        "p95": d["p95"],
        "distribution_sha256": digest,
        "sensitivity": [(r["task_id"], repr(r["index"])) for r in d["sensitivity"]],
    }


# Captured from the per-column implementation before #4710.
EXPECTED: dict[str, Any] = {
    "p50": "2026-04-15",
    "p80": "2026-04-16",
    "p95": "2026-04-17",
    "distribution_sha256": "7bca089f044ae188beae87486e8c5bd0bff7cf8106b0d622f5a4dabb34eb4bc8",
    "sensitivity": [
        ("t14", "0.5052705683744108"),
        ("t26", "0.45283707372097154"),
        ("t5", "0.4185864624964223"),
        ("t17", "0.4072955509464638"),
        ("t29", "0.2660091273155593"),
        ("t2", "0.14612822780550674"),
        ("t4", "0.06324282783191831"),
        ("t8", "0.05504297012153995"),
        ("t27", "0.05201791870231632"),
        ("t1", "0.04889301334486165"),
        ("t22", "0.045855075059438005"),
        ("t18", "0.04556046124040446"),
        ("t16", "0.04343504529648084"),
        ("t3", "0.04115203704119258"),
        ("t15", "0.0355684250497652"),
        ("t10", "0.034884481552284616"),
        ("t7", "0.019849884046065563"),
        ("t0", "0.019694437185169777"),
        ("t11", "0.01893943889007988"),
        ("t20", "0.016114582466251814"),
    ],
}


def test_seeded_percentiles_and_tornado_unchanged() -> None:
    assert _snapshot() == EXPECTED


def test_conversion_adds_an_index_sized_table_not_a_matrix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Re-expressing the columns on the union ruler must not copy a runs x tasks matrix.

    The traced peak is reset where the reference index is built, just before the
    conversion, so what is measured is what the conversion (and the percentile
    reads after it) adds on top of the live matrices. One float64 matrix here is
    ~16 MB; the per-calendar table and bounded gather blocks are a small fraction.
    """
    runs, n = 20_000, 100
    tasks = [
        Task(
            id=f"t{i}",
            name=f"t{i}",
            duration=timedelta(days=3),
            optimistic_duration=timedelta(days=2),
            most_likely_duration=timedelta(days=3),
            pessimistic_duration=timedelta(days=6),
            calendar_id="seven" if i == 0 else None,
        )
        for i in range(n)
    ]
    project = Project(
        id="p",
        name="p",
        start_date=START,
        tasks=tasks,
        dependencies=[Dependency(f"t{i - 1}", f"t{i}") for i in range(1, n)],
        calendars={"seven": Calendar(working_days=0b111_1111)},
    )
    baseline: list[int] = []
    real = engine._build_reference_index

    def spy(*args: Any, **kwargs: Any) -> Any:
        out = real(*args, **kwargs)
        baseline.append(tracemalloc.get_traced_memory()[0])
        tracemalloc.reset_peak()
        return out

    monkeypatch.setattr(engine, "_build_reference_index", spy)
    tracemalloc.start()
    try:
        monte_carlo(project, runs=runs, seed=1)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    matrix = runs * n * 8
    assert baseline, "multi-calendar path was not taken"
    assert peak - baseline[0] < matrix // 4, (peak - baseline[0], matrix)
