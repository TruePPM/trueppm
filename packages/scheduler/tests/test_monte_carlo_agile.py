"""Agile-aware Monte Carlo: scrum tasks sampled from velocity (#411).

Covers the four acceptance scenarios — pure waterfall (no regression), pure
scrum, mixed parent with both child types — plus the throughput-bootstrap math,
graceful fallback when no velocity signal is present, seed determinism, and
serialization round-trip of the new fields.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
)
from trueppm_scheduler.engine import _sample_velocity_durations


def _project(
    tasks: list[Task],
    *,
    dependencies: list[Dependency] | None = None,
    velocity_samples: list[float] | None = None,
    sprint_length_days: int | None = None,
) -> Project:
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 3, 2),  # Monday
        tasks=tasks,
        dependencies=dependencies or [],
        calendar=Calendar(),
        velocity_samples=velocity_samples,
        sprint_length_days=sprint_length_days,
    )


def _scrum_task(tid: str, story_points: float, *, duration_days: int = 1) -> Task:
    return Task(
        id=tid,
        name=tid,
        duration=timedelta(days=duration_days),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=story_points,
    )


# ---------------------------------------------------------------------------
# Throughput-bootstrap math (the private sampler)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("story_points", "expected_sprints"),
    [(10, 1), (20, 2), (25, 3), (5, 1)],  # single sample of 10 pts/sprint
)
def test_velocity_sampler_sprint_count_with_single_sample(
    story_points: int, expected_sprints: int
) -> None:
    rng = np.random.default_rng(0)
    out = _sample_velocity_durations(
        story_points, velocity_samples=[10.0], sprint_length_days=10, n=100, rng=rng
    )
    assert out is not None
    # One velocity sample → degenerate (no variance): every run takes the same
    # whole number of sprints times the sprint length in working days.
    assert np.all(out == expected_sprints * 10)


def test_velocity_sampler_varies_with_throughput_spread() -> None:
    rng = np.random.default_rng(1)
    out = _sample_velocity_durations(
        20, velocity_samples=[5.0, 15.0], sprint_length_days=10, n=2000, rng=rng
    )
    assert out is not None
    # Throughput varies → sprint count (hence duration) varies. Floor is 2 sprints
    # (two 15-pt draws clear 20), and slow runs need more.
    assert out.min() == 20  # 2 sprints * 10 days
    assert out.max() > 20
    assert np.unique(out).size > 1


@pytest.mark.parametrize(
    ("story_points", "samples", "sprint_len"),
    [
        (0, [10.0], 10),  # nothing to burn down
        (20, [], 10),  # no velocity history
        (20, [0.0, 0.0], 10),  # team completed nothing → no positive signal
        (20, [10.0], 0),  # no cadence
    ],
)
def test_velocity_sampler_returns_none_without_signal(
    story_points: int, samples: list[float], sprint_len: int
) -> None:
    rng = np.random.default_rng(0)
    assert (
        _sample_velocity_durations(
            story_points, velocity_samples=samples, sprint_length_days=sprint_len, n=10, rng=rng
        )
        is None
    )


# ---------------------------------------------------------------------------
# Pure scrum simulation
# ---------------------------------------------------------------------------


def test_pure_scrum_produces_a_range_from_velocity_variability() -> None:
    proj = _project(
        [_scrum_task("S", story_points=40)],
        velocity_samples=[10.0, 20.0, 30.0],  # mean 20, real spread
        sprint_length_days=10,
    )
    r = monte_carlo(proj, runs=1000, seed=7)
    assert r.p50 <= r.p80 <= r.p95
    # Velocity variability yields a genuine spread, not a single date.
    assert r.p95 > r.p50


def test_scrum_seed_is_deterministic() -> None:
    proj = _project(
        [_scrum_task("S", story_points=40)],
        velocity_samples=[10.0, 20.0, 30.0],
        sprint_length_days=10,
    )
    a = monte_carlo(proj, runs=1000, seed=42)
    b = monte_carlo(proj, runs=1000, seed=42)
    assert (a.p50, a.p80, a.p95) == (b.p50, b.p80, b.p95)


def test_single_velocity_sample_collapses_to_a_point() -> None:
    proj = _project(
        [_scrum_task("S", story_points=25)],
        velocity_samples=[10.0],  # one observation → no expressible variance
        sprint_length_days=10,
    )
    r = monte_carlo(proj, runs=500, seed=3)
    assert r.p50 == r.p80 == r.p95


# ---------------------------------------------------------------------------
# Graceful fallback — scrum task, but no velocity signal on the project
# ---------------------------------------------------------------------------


def test_scrum_task_without_project_velocity_falls_back_to_deterministic() -> None:
    # delivery_mode=SCRUM + story_points, but the project carries no velocity
    # samples → the task uses its deterministic duration every run.
    proj = _project([_scrum_task("S", story_points=40, duration_days=8)])
    r = monte_carlo(proj, runs=500, seed=1)
    assert r.p50 == r.p80 == r.p95  # degenerate: no sampling occurred


# ---------------------------------------------------------------------------
# Mixed-mode parent: one scrum child + one waterfall (PERT) child
# ---------------------------------------------------------------------------


def test_mixed_mode_combines_scrum_and_waterfall_uncertainty() -> None:
    scrum_child = _scrum_task("S", story_points=30)
    waterfall_child = Task(
        id="W",
        name="W",
        duration=timedelta(days=5),
        optimistic_duration=timedelta(days=3),
        most_likely_duration=timedelta(days=5),
        pessimistic_duration=timedelta(days=12),
    )
    milestone = Task(id="M", name="M", duration=timedelta(days=0))
    proj = _project(
        [scrum_child, waterfall_child, milestone],
        dependencies=[
            Dependency(predecessor_id="S", successor_id="M", dep_type=DependencyType.FS),
            Dependency(predecessor_id="W", successor_id="M", dep_type=DependencyType.FS),
        ],
        velocity_samples=[8.0, 12.0, 20.0],
        sprint_length_days=10,
    )
    r = monte_carlo(proj, runs=1000, seed=11)
    assert r.p50 <= r.p80 <= r.p95
    assert r.p95 > r.p50  # both child distributions feed the milestone


def test_waterfall_only_project_is_unaffected_by_new_fields() -> None:
    """No-regression: a project with no scrum tasks behaves exactly as before.

    delivery_mode defaults to None and velocity_samples to None, so the velocity
    branch is never entered — the result must be a pure PERT/deterministic sim.
    """
    pert = Task(
        id="A",
        name="A",
        duration=timedelta(days=5),
        optimistic_duration=timedelta(days=3),
        most_likely_duration=timedelta(days=5),
        pessimistic_duration=timedelta(days=12),
    )
    proj = _project([pert])
    assert proj.velocity_samples is None
    r = monte_carlo(proj, runs=1000, seed=99)
    # Same seed twice → identical (determinism preserved through the new branch).
    r2 = monte_carlo(_project([pert]), runs=1000, seed=99)
    assert (r.p50, r.p80, r.p95) == (r2.p50, r2.p80, r2.p95)
    assert r.p95 > r.p50


# ---------------------------------------------------------------------------
# Serialization round-trip of the new fields
# ---------------------------------------------------------------------------


def test_round_trip_preserves_agile_fields() -> None:
    proj = _project(
        [_scrum_task("S", story_points=21.5, duration_days=3)],
        velocity_samples=[10.0, 20.0],
        sprint_length_days=10,
    )
    restored = Project.from_dict(proj.to_dict())
    assert restored.velocity_samples == [10.0, 20.0]
    assert restored.sprint_length_days == 10
    t = restored.tasks[0]
    assert t.delivery_mode == DeliveryMode.SCRUM
    assert t.story_points == 21.5


def test_round_trip_waterfall_task_has_no_delivery_mode() -> None:
    t = Task(id="A", name="A", duration=timedelta(days=2))
    restored = Task.from_dict(t.to_dict())
    assert restored.delivery_mode is None
    assert restored.story_points is None


# ---------------------------------------------------------------------------
# Working-day index sizing for velocity-sampled durations (#1067)
# ---------------------------------------------------------------------------


def test_velocity_completion_dates_are_not_clamped_by_index_sizing() -> None:
    """A scrum task's sampled duration can dwarf its placeholder duration.

    With a single velocity sample the distribution is degenerate: every run
    takes exactly ceil(50/5) = 10 sprints x 10 working days = 100 working days.
    Pre-fix, the index was sized from the 1-day placeholder duration only
    (index_size = 32), and the completion offsets were silently clamped to its
    last entry — reporting 2026-04-14, three months early (#1067).
    """
    proj = _project(
        [_scrum_task("S", story_points=50, duration_days=1)],
        velocity_samples=[5.0],
        sprint_length_days=10,
    )
    r = monte_carlo(proj, runs=200, seed=0)
    # 100th working day from Mon 2026-03-02.
    expected = date(2026, 3, 2)
    n = 1
    while n < 100:
        expected += timedelta(days=1)
        if expected.weekday() < 5:
            n += 1
    assert r.p50 == r.p80 == r.p95 == expected


def test_oversized_story_points_rejected_eagerly() -> None:
    """Hostile story_points must hit the span guard, not allocate runs x max_sprints.

    The sampler draws a (runs, max_sprints) matrix; pre-fix the span guard never
    counted the velocity worst case, so this input reached the allocation (#1067).
    """
    from trueppm_scheduler import InvalidScheduleInput

    proj = _project(
        [_scrum_task("S", story_points=1e12, duration_days=1)],
        velocity_samples=[1.0],
        sprint_length_days=10,
    )
    with pytest.raises(InvalidScheduleInput, match="Total project span"):
        monte_carlo(proj, runs=1000, seed=0)


@pytest.mark.parametrize("bad_points", [float("inf"), float("nan")])
def test_non_finite_story_points_rejected(bad_points: float) -> None:
    """inf/NaN story_points crashed inside the sampler (int(np.ceil(...))) pre-fix (#1070)."""
    from trueppm_scheduler import InvalidScheduleInput

    proj = _project(
        [_scrum_task("S", story_points=bad_points)],
        velocity_samples=[10.0],
        sprint_length_days=10,
    )
    with pytest.raises(InvalidScheduleInput, match="story_points"):
        monte_carlo(proj, runs=10, seed=0)


@pytest.mark.parametrize("bad_sample", [float("inf"), float("nan")])
def test_non_finite_velocity_sample_rejected(bad_sample: float) -> None:
    """An inf sample passes the > 0 filter and poisons the bootstrap mean (#1070)."""
    from trueppm_scheduler import InvalidScheduleInput

    proj = _project(
        [_scrum_task("S", story_points=20)],
        velocity_samples=[10.0, bad_sample],
        sprint_length_days=10,
    )
    with pytest.raises(InvalidScheduleInput, match="velocity_samples"):
        monte_carlo(proj, runs=10, seed=0)
