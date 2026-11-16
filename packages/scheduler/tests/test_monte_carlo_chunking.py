"""Monte Carlo's forward pass runs over row chunks and is exact under any chunk size (#3824).

The chunk size is a memory knob, never a modeling one: every seeded output —
P50/P80/P95, their day-edge readings, the full distribution and the sensitivity
tornado — must be byte-identical whether the pass runs over every run at once or
one run at a time. These tests pin that by forcing a one-run chunk and comparing
against a pass with a chunk larger than any project here.

The one-run side also replays the sampled-duration matrix a row block at a time
instead of holding it (:class:`_SampledDurations`), so the same comparisons pin the
replay to the whole matrix.
"""

from __future__ import annotations

from datetime import date, timedelta
from itertools import pairwise

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from tests.test_contract_fuzz import _per_task_calendar_projects, _plausible_projects
from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
)
from trueppm_scheduler.engine.montecarlo import run as mc_run
from trueppm_scheduler.engine.montecarlo.sampling import (
    _sample_duration_matrix,
    _SampledDurations,
)


def _both_ways(
    monkeypatch: pytest.MonkeyPatch, project: Project, runs: int, seed: int
) -> tuple[object, object]:
    """``(one-run chunks + replayed durations, one chunk + held matrix)`` results."""
    outcomes: list[object] = []
    for cells in (1, 10**12):
        monkeypatch.setattr(mc_run, "_MC_FORWARD_CHUNK_CELLS", cells)
        monkeypatch.setattr(mc_run, "_MC_SAMPLED_MATRIX_CELLS", cells)
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


def _mixed_sampling_project() -> Project:
    """Every sampling path: PERT, degenerate PERT, deterministic, completed, velocity."""
    tasks = [
        Task(
            id=f"p{i}",
            name=f"p{i}",
            duration=timedelta(days=2),
            optimistic_duration=timedelta(days=1),
            most_likely_duration=timedelta(days=3),
            pessimistic_duration=timedelta(days=8 + i),
        )
        for i in range(6)
    ]
    tasks += [
        # Degenerate triple: a constant column that draws nothing.
        Task(
            id="deg",
            name="deg",
            duration=timedelta(days=2),
            optimistic_duration=timedelta(days=4),
            most_likely_duration=timedelta(days=4),
            pessimistic_duration=timedelta(days=4),
        ),
        Task(id="det", name="det", duration=timedelta(days=3)),
        # Completed: draws (the stream moves) but collapses to a constant.
        Task(
            id="done",
            name="done",
            duration=timedelta(days=2),
            optimistic_duration=timedelta(days=1),
            most_likely_duration=timedelta(days=2),
            pessimistic_duration=timedelta(days=9),
            percent_complete=100.0,
            actual_start=date(2026, 1, 5),
            actual_finish=date(2026, 1, 6),
        ),
        # Floored at duration in every run: varying draws, constant column.
        Task(
            id="floored",
            name="floored",
            duration=timedelta(days=9),
            optimistic_duration=timedelta(days=1),
            most_likely_duration=timedelta(days=2),
            pessimistic_duration=timedelta(days=3),
        ),
    ]
    tasks += [
        Task(
            id=f"s{i}",
            name=f"s{i}",
            duration=timedelta(days=5),
            delivery_mode=DeliveryMode.SCRUM,
            story_points=8.0 + 3 * i,
        )
        for i in range(3)
    ]
    order = [t.id for t in tasks]
    deps = [Dependency(predecessor_id=a, successor_id=b) for a, b in pairwise(order)]
    return Project(
        id="mixed",
        name="mixed",
        start_date=date(2026, 1, 5),
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(),
        velocity_samples=[6, 9, 12, 15],
        sprint_length_days=10,
    )


def test_replayed_durations_match_the_whole_matrix() -> None:
    """Row blocks of the replay concatenate to the whole matrix, bit for bit (#3824).

    Uneven block sizes (one run, a few, the rest) make each column's draws stop and
    resume mid-stream. The main generator must also end where the full sampler leaves
    it, or every draw taken after sampling (the velocity capacity seeds) would move.
    """
    project = _mixed_sampling_project()
    order = [t.id for t in project.tasks]
    task_map = {t.id: t for t in project.tasks}
    runs = 97
    whole_rng = np.random.default_rng(11)
    whole = _sample_duration_matrix(project, order, task_map, runs, whole_rng)

    rng = np.random.default_rng(11)
    durations = _SampledDurations(project, order, task_map, runs, rng, replay=True, keep_rows=40)
    assert durations.replayed
    assert rng.bit_generator.state == whole_rng.bit_generator.state
    blocks = [durations.rows(lo, hi) for lo, hi in ((0, 1), (1, 5), (5, 50), (50, runs))]
    np.testing.assert_array_equal(np.vstack(blocks), whole)
    for col in range(len(order)):
        assert durations.column_any(col) == bool(whole[:, col].any())
    leading = durations.leading_column(40)
    for col in range(len(order)):
        np.testing.assert_array_equal(leading(col), whole[:40, col])


def test_replayed_rows_must_come_in_order() -> None:
    project = _mixed_sampling_project()
    order = [t.id for t in project.tasks]
    durations = _SampledDurations(
        project,
        order,
        {t.id: t for t in project.tasks},
        10,
        np.random.default_rng(1),
        replay=True,
        keep_rows=10,
    )
    with pytest.raises(AssertionError, match="out of order"):
        durations.rows(3, 10)


def test_replay_preserves_velocity_write_back_and_tornado(monkeypatch: pytest.MonkeyPatch) -> None:
    """The forward pass's velocity write-back reaches the tornado in both modes (ADR-1412)."""
    chunked, whole = _both_ways(monkeypatch, _mixed_sampling_project(), runs=300, seed=3824)
    assert chunked == whole
    assert isinstance(whole, dict)
    ranked = {entry["task_id"] for entry in whole["sensitivity"]}
    assert ranked & {"s0", "s1", "s2"}, "velocity tasks dropped out of the tornado"
    assert not ranked & {"deg", "det", "done", "floored"}


def test_replay_write_back_straddles_the_kept_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replayed 1,024-row blocks over 2,600 runs keep exactly the tornado's leading rows.

    The tornado reads the first ``MC_SENSITIVITY_SUBSAMPLE`` (2,000) runs, so one block
    (1,024-2,048) straddles that edge and is copied aside only up to it, and the last
    block (2,048-2,600) starts past it and is not copied at all. One-run blocks never
    straddle and 300 runs never pass the edge, so the test above reaches neither branch.
    A velocity project's chunk is a whole number of capacity draw blocks (1,024 runs
    here), so that is the smallest block size this project can be chunked at.
    """
    project = _mixed_sampling_project()
    blocks: list[tuple[int, int]] = []
    keep_written = _SampledDurations.keep_written

    def spy(self: _SampledDurations, lo: int, block: np.ndarray) -> None:
        if self.replayed:
            blocks.append((lo, lo + block.shape[0]))
        keep_written(self, lo, block)

    monkeypatch.setattr(_SampledDurations, "keep_written", spy)
    outcomes = []
    for chunk_cells, matrix_cells in ((1024 * len(project.tasks), 1), (10**12, 10**12)):
        monkeypatch.setattr(mc_run, "_MC_FORWARD_CHUNK_CELLS", chunk_cells)
        monkeypatch.setattr(mc_run, "_MC_SAMPLED_MATRIX_CELLS", matrix_cells)
        outcomes.append(monte_carlo(project, runs=2600, seed=3824).to_dict())
    assert blocks == [(0, 1024), (1024, 2048), (2048, 2600)]
    replayed, whole = outcomes
    assert replayed == whole
    ranked = {entry["task_id"] for entry in whole["sensitivity"]}
    assert ranked & {"s0", "s1", "s2"}, "velocity tasks dropped out of the tornado"
