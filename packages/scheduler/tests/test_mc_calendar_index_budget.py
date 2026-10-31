"""Monte Carlo's per-calendar working-day index is bounded and deduplicated (#4692).

``monte_carlo()`` allocates one working-day index per distinct calendar, as long as
the project span. Nothing capped the calendar count, so a small hostile project with
many calendars drove the process into the gigabytes. These tests pin the three fixes:
calendars are deduplicated by content, an index costs 8 bytes per cell (not a list, a
dict and an array), and ``n_distinct_calendars x index_size`` is refused over
``max_index_cells`` before anything is allocated.
"""

from __future__ import annotations

import re
import tracemalloc
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    MAX_INDEX_CELLS,
    Calendar,
    DateRange,
    Dependency,
    Project,
    SimulationCapExceeded,
    Task,
    monte_carlo,
    schedule,
)

START = date(2026, 3, 2)  # Monday


def _project(
    n_calendars: int, *, distinct: bool = True, chain: int = 3, chain_days: int = 20
) -> Project:
    """A chained spine plus ``n_calendars`` one-day tasks, each on its own calendar.

    ``distinct`` gives every calendar a unique exception, so content-deduplication
    cannot collapse them.
    """
    tasks = [
        Task(id=f"s{i}", name=f"s{i}", duration=timedelta(days=chain_days)) for i in range(chain)
    ]
    deps = [Dependency(predecessor_id=f"s{i - 1}", successor_id=f"s{i}") for i in range(1, chain)]
    calendars: dict[str, Calendar] = {}
    for k in range(n_calendars):
        exc = (DateRange(START + timedelta(days=400 + k), START + timedelta(days=400 + k)),)
        calendars[f"c{k}"] = Calendar(working_days=127, exceptions=exc if distinct else ())
        tasks.append(
            Task(id=f"k{k}", name=f"k{k}", duration=timedelta(days=1), calendar_id=f"c{k}")
        )
    return Project(
        id="p",
        name="p",
        start_date=START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=127) if not distinct else Calendar(),
        calendars=calendars,
    )


def _index_size_of(project: Project) -> int:
    """The index length the engine sized, read from the cap message."""
    with pytest.raises(SimulationCapExceeded) as err:
        monte_carlo(project, runs=10, seed=1, max_index_cells=1)
    match = re.search(r"x a ([\d,]+)-day index", str(err.value))
    assert match is not None
    return int(match.group(1).replace(",", ""))


def _distinct_in_message(project: Project) -> int:
    with pytest.raises(SimulationCapExceeded) as err:
        monte_carlo(project, runs=10, seed=1, max_index_cells=1)
    match = re.search(r"([\d,]+) distinct calendars", str(err.value))
    assert match is not None
    return int(match.group(1).replace(",", ""))


def test_default_budget_is_exported() -> None:
    assert MAX_INDEX_CELLS == 25_000_000


def test_budget_boundary_just_under_and_just_over() -> None:
    project = _project(6)
    size = _index_size_of(project)
    distinct = _distinct_in_message(project)
    assert distinct == 7  # six registry calendars + the project calendar
    budget = distinct * size

    # Exactly at the budget runs; one cell under refuses.
    monte_carlo(project, runs=20, seed=1, max_index_cells=budget)
    with pytest.raises(SimulationCapExceeded, match="working-day indices"):
        monte_carlo(project, runs=20, seed=1, max_index_cells=budget - 1)


def test_identical_calendars_are_deduplicated_by_content() -> None:
    """K calendars with the same content cost one index, and change no result."""
    many = _project(40, distinct=False)
    assert _distinct_in_message(many) == 1
    baseline = _project(1, distinct=False)
    size = _index_size_of(many)
    # A budget that fits exactly one index passes for 40 identical calendars.
    r_many = monte_carlo(many, runs=50, seed=3, max_index_cells=size)
    r_one = monte_carlo(baseline, runs=50, seed=3, max_index_cells=size)
    assert r_many.p50 == r_one.p50
    assert r_many.p95 == r_one.p95


def test_cap_refuses_before_allocating_the_indices() -> None:
    """The refusal is sized from counts alone: the peak stays far below one index."""
    project = _project(20, chain=10, chain_days=36_000)
    tracemalloc.start()
    try:
        with pytest.raises(SimulationCapExceeded):
            monte_carlo(project, runs=10, seed=1, max_index_cells=1_000_000)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # One int64 index at the maximum span is ~2.9 MB; none may be built.
    assert peak < 2_000_000


def test_eight_calendars_at_maximum_span_stay_under_a_memory_ceiling() -> None:
    """The issue's K=8 repro peaked near 450 MB traced before the fix."""
    project = _project(8, chain=10, chain_days=36_000)
    tracemalloc.start()
    try:
        monte_carlo(project, runs=10, seed=1)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 80_000_000, f"peak {peak / 1e6:.0f} MB"


def test_schedule_memory_stays_flat_in_calendar_count() -> None:
    """The CPM path never builds the Monte Carlo indices; keep it that way."""

    def peak_for(k: int) -> int:
        project = _project(k, chain=10, chain_days=10_000)
        tracemalloc.start()
        try:
            schedule(project)
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    base, many = peak_for(0), peak_for(32)
    assert many < base + 20_000_000, f"{base / 1e6:.0f} MB -> {many / 1e6:.0f} MB"
