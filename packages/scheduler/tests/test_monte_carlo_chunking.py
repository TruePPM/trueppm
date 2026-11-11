"""Monte Carlo's forward pass runs over row chunks and is exact under any chunk size (#3824).

The chunk size is a memory knob, never a modeling one: every seeded output —
P50/P80/P95, their day-edge readings, the full distribution and the sensitivity
tornado — must be byte-identical whether the pass runs over every run at once or
one run at a time. These tests pin that by forcing a one-run chunk and comparing
against a pass with a chunk larger than any project here.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from tests.test_contract_fuzz import _per_task_calendar_projects, _plausible_projects
from trueppm_scheduler import Calendar, Dependency, DependencyType, Project, Task, monte_carlo
from trueppm_scheduler.engine.montecarlo import run as mc_run


def _both_ways(
    monkeypatch: pytest.MonkeyPatch, project: Project, runs: int, seed: int
) -> tuple[object, object]:
    """``(one-run chunks, one chunk)`` results of the same seeded simulation."""
    outcomes: list[object] = []
    for cells in (1, 10**12):
        monkeypatch.setattr(mc_run, "_MC_FORWARD_CHUNK_CELLS", cells)
        try:
            outcomes.append(monte_carlo(project, runs=runs, seed=seed).to_dict())
        except Exception as exc:  # the same refusal either way is also equivalence
            outcomes.append((type(exc).__name__, str(exc)))
    return outcomes[0], outcomes[1]


@pytest.mark.fuzz
@settings(deadline=None, suppress_health_check=list(HealthCheck))
@given(
    project=st.one_of(
        _plausible_projects(),
        _plausible_projects(per_task_calendars=True),
        _per_task_calendar_projects(estimates=True),
    ),
    seed=st.integers(min_value=0, max_value=2**16),
)
def test_chunked_forward_pass_is_byte_identical(
    monkeypatch: pytest.MonkeyPatch, project: Project, seed: int
) -> None:
    chunked, whole = _both_ways(monkeypatch, project, runs=23, seed=seed)
    assert chunked == whole


def test_chunked_pert_network_is_byte_identical(monkeypatch: pytest.MonkeyPatch) -> None:
    """A wide PERT network with lags across all four link types, chunked one run at a time."""
    tasks = [
        Task(
            id=f"t{i:03d}",
            name=f"T{i}",
            duration=timedelta(days=2 + i % 4),
            optimistic_duration=timedelta(days=2 + i % 4),
            most_likely_duration=timedelta(days=3 + i % 4),
            pessimistic_duration=timedelta(days=9 + i % 5),
            percent_complete=40.0 if i % 11 == 0 else None,
            actual_start=date(2026, 1, 5) if i % 11 == 0 else None,
        )
        for i in range(60)
    ]
    kinds = list(DependencyType)
    deps = [
        Dependency(
            predecessor_id=f"t{i - 1 - i % 3:03d}",
            successor_id=f"t{i:03d}",
            dep_type=kinds[i % 4],
            lag=timedelta(days=i % 3 - 1),
        )
        for i in range(3, 60)
    ]
    project = Project(
        id="chunk",
        name="chunk",
        start_date=date(2026, 1, 5),
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(),
        status_date=date(2026, 1, 12),
    )
    chunked, whole = _both_ways(monkeypatch, project, runs=500, seed=3824)
    assert chunked == whole


def test_chunk_rows_respects_budget_and_whole_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mc_run, "_MC_FORWARD_CHUNK_CELLS", 1_000)
    assert mc_run._mc_forward_chunk_rows(10_000, 100, whole=False) == 10
    assert mc_run._mc_forward_chunk_rows(5, 100, whole=False) == 5
    # A budget smaller than one row still makes progress, one run at a time.
    assert mc_run._mc_forward_chunk_rows(10_000, 5_000, whole=False) == 1
    # A cross-run decision (a milestone on a non-working actual) runs in one chunk.
    assert mc_run._mc_forward_chunk_rows(10_000, 5_000, whole=True) == 10_000


def test_non_working_actual_milestone_runs_in_one_chunk(monkeypatch: pytest.MonkeyPatch) -> None:
    """A milestone recorded on a Sunday is shown there only if EVERY run shows it there.

    That is a decision across runs, so the pass must not split them: with the guard
    removed the one-run chunks would each decide alone. Pin the guarded result to
    the single-chunk one.
    """
    project = Project(
        id="sun",
        name="sun",
        start_date=date(2026, 1, 5),
        tasks=[
            Task(
                id="a",
                name="a",
                duration=timedelta(days=3),
                optimistic_duration=timedelta(days=3),
                most_likely_duration=timedelta(days=4),
                pessimistic_duration=timedelta(days=12),
            ),
            Task(
                id="m",
                name="m",
                duration=timedelta(0),
                actual_start=date(2026, 1, 11),  # a Sunday
            ),
        ],
        dependencies=[Dependency(predecessor_id="a", successor_id="m")],
        calendar=Calendar(),
    )
    chunked, whole = _both_ways(monkeypatch, project, runs=200, seed=7)
    assert chunked == whole
