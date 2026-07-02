"""Duration-sensitivity tornado for Monte Carlo (ADR-0140).

The sensitivity index of a task is the absolute Spearman rank correlation between
its sampled duration and the project completion offset across runs — "the tasks
that move the finish most". These tests pin the properties that make the metric
trustworthy: a critical-chain task outranks an off-critical-path task of equal
variance, deterministic/completed/milestone tasks are omitted, a fully
deterministic project yields an empty tornado, the output is bounded and
seed-deterministic, and it round-trips through ``to_dict``.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
)
from trueppm_scheduler.engine import MC_SENSITIVITY_SUBSAMPLE, _average_ranks


def _make_project(tasks: list[Task], dependencies: list[Dependency] | None = None) -> Project:
    return Project(
        id="test",
        name="Test Project",
        start_date=date(2026, 3, 2),  # Monday
        tasks=tasks,
        dependencies=dependencies or [],
        calendar=Calendar(),
    )


def _pert(tid: str, opt: int, ml: int, pess: int) -> Task:
    return Task(
        id=tid,
        name=tid,
        duration=timedelta(days=ml),
        optimistic_duration=timedelta(days=opt),
        most_likely_duration=timedelta(days=ml),
        pessimistic_duration=timedelta(days=pess),
    )


# ---------------------------------------------------------------------------
# _average_ranks — the Spearman building block
# ---------------------------------------------------------------------------


def test_average_ranks_handles_ties() -> None:
    # Ties share the mean of the ranks they span (scipy "average" convention).
    out = _average_ranks(np.array([10.0, 20.0, 20.0, 30.0]))
    assert out.tolist() == [1.0, 2.5, 2.5, 4.0]


def test_average_ranks_is_a_permutation_for_distinct_values() -> None:
    out = _average_ranks(np.array([3.0, 1.0, 2.0]))
    assert out.tolist() == [3.0, 1.0, 2.0]


# ---------------------------------------------------------------------------
# Sensitivity ordering — the property that matters
# ---------------------------------------------------------------------------


def test_critical_chain_task_outranks_off_path_task_of_equal_variance() -> None:
    """An off-critical-path task with the SAME duration spread as a critical one
    must rank far lower — it has slack, so its duration rarely moves the finish.

    Chain A → B → C is the long pole. D is parallel (no successors) and short,
    so its generous float absorbs its variance; its sensitivity should be well
    below the critical chain's.
    """
    project = _make_project(
        tasks=[
            _pert("A", 4, 8, 20),
            _pert("B", 4, 8, 20),
            _pert("C", 4, 8, 20),
            _pert("D", 4, 8, 20),  # same spread, but off the critical path
        ],
        dependencies=[
            Dependency("A", "B", DependencyType.FS),
            Dependency("B", "C", DependencyType.FS),
            # D depends only on A and has no successors → lots of float.
            Dependency("A", "D", DependencyType.FS),
        ],
    )
    result = monte_carlo(project, runs=3000, seed=7, max_runs=None)
    by_id = {s.task_id: s.index for s in result.sensitivity}

    # Every critical-chain task is present and meaningfully sensitive.
    assert {"A", "B", "C"} <= by_id.keys()
    assert by_id["C"] > 0.3
    # D is either omitted (never bound the finish) or ranks far below the chain.
    d_index = by_id.get("D", 0.0)
    assert d_index < by_id["C"]
    assert d_index < by_id["B"]


def test_higher_variance_critical_task_is_more_sensitive() -> None:
    """Among tasks all on the one chain, the one with the widest spread drives
    the finish most."""
    project = _make_project(
        tasks=[
            _pert("low", 5, 6, 7),  # tight
            _pert("high", 2, 6, 30),  # wide
        ],
        dependencies=[Dependency("low", "high", DependencyType.FS)],
    )
    result = monte_carlo(project, runs=3000, seed=11, max_runs=None)
    by_id = {s.task_id: s.index for s in result.sensitivity}
    assert by_id["high"] > by_id["low"]


# ---------------------------------------------------------------------------
# Omissions and empty cases
# ---------------------------------------------------------------------------


def test_deterministic_project_has_empty_sensitivity() -> None:
    project = _make_project(
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=5)),
            Task(id="B", name="B", duration=timedelta(days=3)),
        ],
        dependencies=[Dependency("A", "B", DependencyType.FS)],
    )
    result = monte_carlo(project, runs=500, seed=1)
    assert result.sensitivity == []


def test_zero_variance_tasks_are_omitted() -> None:
    """A deterministic-duration task on the chain alongside a PERT task is left
    out of the tornado — it cannot vary, so it cannot drive the finish."""
    project = _make_project(
        tasks=[
            Task(id="fixed", name="fixed", duration=timedelta(days=5)),  # no estimates
            _pert("variable", 2, 6, 20),
        ],
        dependencies=[Dependency("fixed", "variable", DependencyType.FS)],
    )
    result = monte_carlo(project, runs=1500, seed=3, max_runs=None)
    ids = {s.task_id for s in result.sensitivity}
    assert "fixed" not in ids
    assert "variable" in ids


def test_milestone_is_omitted() -> None:
    project = _make_project(
        tasks=[
            _pert("work", 3, 6, 15),
            Task(id="ms", name="ms", duration=timedelta(0)),  # zero-duration milestone
        ],
        dependencies=[Dependency("work", "ms", DependencyType.FS)],
    )
    result = monte_carlo(project, runs=1500, seed=5, max_runs=None)
    ids = {s.task_id for s in result.sensitivity}
    assert "ms" not in ids


# ---------------------------------------------------------------------------
# Output shape: bounded, sorted, in-range, deterministic
# ---------------------------------------------------------------------------


def _chain(n: int) -> Project:
    tasks = [_pert(f"t{i}", 2, 6, 18) for i in range(n)]
    deps = [Dependency(f"t{i}", f"t{i + 1}", DependencyType.FS) for i in range(n - 1)]
    return _make_project(tasks, deps)


def test_sensitivity_is_sorted_in_range_and_capped() -> None:
    result = monte_carlo(_chain(30), runs=1500, seed=9, sensitivity_cap=10, max_runs=None)
    indices = [s.index for s in result.sensitivity]
    assert len(indices) == 10  # capped
    assert indices == sorted(indices, reverse=True)  # descending
    assert all(0.0 <= i <= 1.0 for i in indices)  # absolute correlation in [0, 1]


def test_sensitivity_is_seed_deterministic() -> None:
    a = monte_carlo(_chain(8), runs=1500, seed=42, max_runs=None)
    b = monte_carlo(_chain(8), runs=1500, seed=42, max_runs=None)
    assert [(s.task_id, s.index) for s in a.sensitivity] == [
        (s.task_id, s.index) for s in b.sensitivity
    ]


def test_sensitivity_subsample_is_deterministic_above_the_cap() -> None:
    """The tornado is computed on a fixed subsample of runs (#1525), yet stays
    deterministic and correctly ranked when the run count exceeds that subsample.

    Percentiles use every run; only the sensitivity ranking is computed on the first
    ``MC_SENSITIVITY_SUBSAMPLE`` rows — a contiguous, RNG-free view. Two seeded runs
    above the subsample must therefore produce byte-identical tornadoes (the slice
    adds no nondeterminism), and a pure critical chain must still populate a bounded,
    in-range tornado. The 1,500-run determinism test above stays *below* the
    subsample; this one crosses it to exercise the slice itself.
    """
    runs = MC_SENSITIVITY_SUBSAMPLE + 3_000  # safely above the subsample threshold
    a = monte_carlo(_chain(8), runs=runs, seed=42, max_runs=None)
    b = monte_carlo(_chain(8), runs=runs, seed=42, max_runs=None)
    assert [(s.task_id, s.index) for s in a.sensitivity] == [
        (s.task_id, s.index) for s in b.sensitivity
    ]
    # Pure chain ⇒ every task is on the critical path, so the tornado is populated.
    assert len(a.sensitivity) > 0
    assert all(0.0 <= s.index <= 1.0 for s in a.sensitivity)


def test_to_dict_round_trips_sensitivity() -> None:
    result = monte_carlo(_chain(5), runs=1000, seed=2)
    d = result.to_dict()
    assert "sensitivity" in d
    assert isinstance(d["sensitivity"], list)
    first = d["sensitivity"][0]
    assert set(first.keys()) == {"task_id", "index"}
    assert isinstance(first["task_id"], str)
    assert isinstance(first["index"], float)


def test_sensitivity_cap_zero_returns_empty() -> None:
    result = monte_carlo(_chain(5), runs=500, seed=2, sensitivity_cap=0)
    assert result.sensitivity == []
