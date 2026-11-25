"""``monte_carlo(return_samples=True)`` — the per-run matrices (#4166)."""

from __future__ import annotations

import pickle
from datetime import date, timedelta

import numpy as np
import pytest
from hypothesis import given

from tests.test_contract_fuzz import _plausible_projects
from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    SchedulerError,
    SimulationCapExceeded,
    Task,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine.montecarlo import run as mc_run


def _days(n: int) -> timedelta:
    return timedelta(days=n)


def _pert(task_id: str, base: int, **kwargs: object) -> Task:
    return Task(
        id=task_id,
        name=task_id,
        duration=_days(base),
        optimistic_duration=_days(base),
        most_likely_duration=_days(base + 2),
        pessimistic_duration=_days(base + 8),
        **kwargs,  # type: ignore[arg-type]
    )


def _project(**kwargs: object) -> Project:
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),
        tasks=[
            _pert("A", 3),
            _pert("B", 4, calendar_id="six"),
            Task(id="M", name="M", duration=_days(0)),
        ],
        dependencies=[
            Dependency(predecessor_id="A", successor_id="B", dep_type=DependencyType.FS),
            Dependency(predecessor_id="B", successor_id="M", dep_type=DependencyType.FS),
        ],
        calendars={"six": Calendar(working_days=0b0111111)},
        **kwargs,  # type: ignore[arg-type]
    )


def test_default_returns_no_samples() -> None:
    assert monte_carlo(_project(), runs=10, seed=1).samples is None


def test_shapes_dtypes_order_and_unchanged_result() -> None:
    plain = monte_carlo(_project(), runs=200, seed=7)
    result = monte_carlo(_project(), runs=200, seed=7, return_samples=True)
    assert result == plain
    assert result.to_dict() == plain.to_dict()
    samples = result.samples
    assert samples is not None
    assert samples.task_ids == ("A", "B", "M")
    assert samples.durations.shape == samples.early_finish.shape == (200, 3)
    assert samples.durations.dtype == np.float32
    assert samples.early_finish.dtype == np.int32
    # The project finishes on the latest task finish of each run.
    per_run = sorted(date.fromordinal(int(x)) for x in samples.early_finish.max(axis=1))
    assert per_run == result.distribution
    assert samples.durations[:, 0].min() >= 3
    assert pickle.loads(pickle.dumps(result)).samples.task_ids == samples.task_ids
    assert len(repr(samples)) < 80


@pytest.mark.parametrize("chunk_cells", [8_000_000, 9])
def test_chunked_and_replayed_runs_give_the_same_samples(
    monkeypatch: pytest.MonkeyPatch, chunk_cells: int
) -> None:
    whole = monte_carlo(_project(), runs=50, seed=3, return_samples=True).samples
    monkeypatch.setattr(mc_run, "_MC_FORWARD_CHUNK_CELLS", chunk_cells)
    monkeypatch.setattr(mc_run, "_MC_SAMPLED_MATRIX_CELLS", 0)
    chunked = monte_carlo(_project(), runs=50, seed=3, return_samples=True).samples
    assert whole is not None and chunked is not None
    np.testing.assert_array_equal(whole.durations, chunked.durations)
    np.testing.assert_array_equal(whole.early_finish, chunked.early_finish)


def test_velocity_task_reports_its_realized_days() -> None:
    project = Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),
        tasks=[
            Task(
                id="S",
                name="S",
                duration=_days(1),
                delivery_mode=DeliveryMode.SCRUM,
                story_points=40,
            )
        ],
        velocity_samples=[8, 10, 12],
        sprint_length_days=10,
    )
    samples = monte_carlo(project, runs=50, seed=1, return_samples=True).samples
    assert samples is not None
    assert samples.durations.min() > 1


def test_durations_are_total_not_remaining_for_in_progress_work() -> None:
    # The documented rule: elapsed work is not subtracted from the returned durations.
    project = Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),
        tasks=[
            Task(
                id="T",
                name="T",
                duration=_days(10),
                percent_complete=50,
                actual_start=date(2026, 1, 5),
            )
        ],
    )
    samples = monte_carlo(project, runs=20, seed=1, return_samples=True).samples
    assert samples is not None
    np.testing.assert_array_equal(samples.durations[:, 0], np.full(20, 10.0))


def _assert_matches_cpm(project: Project) -> None:
    """Every task's sampled early finish is the one ``schedule()`` computes."""
    expected = {t.id: t.early_finish for t in schedule(project).tasks}
    samples = monte_carlo(project, runs=3, seed=0, return_samples=True).samples
    assert samples is not None
    for col, task_id in enumerate(samples.task_ids):
        got = {date.fromordinal(int(x)) for x in samples.early_finish[:, col]}
        assert got == {expected[task_id]}, task_id


@pytest.mark.parametrize(
    "task",
    [
        Task(id="T", name="T", duration=timedelta(0), actual_start=date(2026, 1, 10)),
        Task(
            id="T",
            name="T",
            duration=timedelta(days=2),
            percent_complete=100,
            actual_start=date(2026, 1, 10),
            actual_finish=date(2026, 1, 11),
        ),
        Task(id="T", name="T", duration=timedelta(0)),
    ],
    ids=["weekend-milestone-actual", "completed-on-a-weekend", "project-start-milestone"],
)
def test_early_finish_matches_cpm_on_non_working_and_pre_index_dates(task: Task) -> None:
    _assert_matches_cpm(
        Project(
            id="p",
            name="P",
            start_date=date(2026, 1, 5),
            tasks=[task, Task(id="U", name="U", duration=timedelta(days=1))],
        )
    )


@pytest.mark.fuzz
@given(project=_plausible_projects() | _plausible_projects(per_task_calendars=True))
def test_early_finish_matches_cpm_on_deterministic_projects(project: Project) -> None:
    # Strip every source of uncertainty, so each run is exactly the CPM pass.
    for t in project.tasks:
        t.optimistic_duration = t.most_likely_duration = t.pessimistic_duration = None
        t.story_points = None
    project.velocity_samples = None
    try:
        schedule(project)
    except SchedulerError:
        return
    _assert_matches_cpm(project)


def test_size_cap_refuses_only_the_samples_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mc_run, "_MC_MAX_RETURNED_SAMPLE_CELLS", 29)
    assert monte_carlo(_project(), runs=10, seed=1).samples is None
    with pytest.raises(SimulationCapExceeded, match="return_samples"):
        monte_carlo(_project(), runs=10, seed=1, return_samples=True)


def test_existing_caps_apply() -> None:
    with pytest.raises(SimulationCapExceeded):
        monte_carlo(_project(), runs=10, max_tasks=2, return_samples=True)


def test_non_bool_is_rejected() -> None:
    with pytest.raises(InvalidScheduleInput, match="return_samples"):
        monte_carlo(_project(), runs=10, return_samples=1)  # type: ignore[arg-type]
