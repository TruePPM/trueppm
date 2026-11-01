"""Velocity sampler float-accumulation tolerance (#4699)."""

from __future__ import annotations

import numpy as np
import pytest

from trueppm_scheduler.engine import _sample_velocity_durations

# Pairs where k*v summed k times falls an ulp short of round(k*v, 10), plus clean ones.
_CASES = [(0.1, 10), (0.1, 3), (0.3, 7), (0.7, 3), (1.1, 9), (0.2, 15), (2.5, 4), (5.0, 3)]


@pytest.mark.parametrize(("v", "k"), _CASES)
def test_constant_velocity_needs_exactly_k_sprints(v: float, k: int) -> None:
    points = round(v * k, 10)
    out = _sample_velocity_durations(points, [v], 1, 20, np.random.default_rng(1))
    assert out is not None
    assert set(out.tolist()) == {float(k)}


def test_multi_sample_path_counts_exactly_k() -> None:
    # Every draw is 0.1 regardless of which observation is picked.
    out = _sample_velocity_durations(1.0, [0.1, 0.1, 0.1], 1, 50, np.random.default_rng(2))
    assert out is not None
    assert set(out.tolist()) == {10.0}


def test_genuinely_short_target_still_needs_extra_sprint() -> None:
    out = _sample_velocity_durations(1.001, [0.1], 1, 5, np.random.default_rng(3))
    assert out is not None
    assert set(out.tolist()) == {11.0}


def test_end_to_end_ten_tenth_point_sprints_finish_in_100_working_days() -> None:
    """Issue repro: P50 == P95 == the 100-working-day date, not 110 (2026-07-31)."""
    from datetime import date, timedelta

    from trueppm_scheduler import Calendar, DeliveryMode, Project, Task, monte_carlo

    task = Task(
        id="S",
        name="S",
        duration=timedelta(days=1),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=1.0,
    )
    proj = Project(
        id="p",
        name="P",
        start_date=date(2026, 3, 2),
        tasks=[task],
        dependencies=[],
        calendar=Calendar(),
        velocity_samples=[0.1],
        sprint_length_days=10,
    )
    r = monte_carlo(proj, runs=50, seed=1)
    assert r.p50 == r.p95 == date(2026, 7, 17)
