"""The velocity sprint-horizon clamp is reported, not hidden (#2469).

A run whose bootstrap has not burned down by the horizon is clamped to it, which
makes its duration a lower bound. ``MonteCarloResult.velocity_saturated_runs``
counts such runs so a caller can mark P80/P95 as lower bounds.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from trueppm_scheduler import DeliveryMode, MonteCarloResult, Project, Task, monte_carlo
from trueppm_scheduler.engine import _sample_velocity_durations


def _scrum_project(samples: list[float], points: float, **task_kw: object) -> Project:
    return Project(
        id="v",
        name="v",
        start_date=date(2026, 1, 5),
        tasks=[
            Task(
                id="story",
                name="story",
                duration=timedelta(days=1),
                delivery_mode=DeliveryMode.SCRUM,
                story_points=points,
                **task_kw,  # type: ignore[arg-type]
            )
        ],
        velocity_samples=samples,
        sprint_length_days=10,
    )


# One 100-point sprint in a hundred: a 100-point story needs one hit, and the horizon
# is ceil(100 / 1) * 4 + 10 = 410 sprints, so ~0.99**410 = 1.6% of runs never hit.
_LUMPY = [100.0] + [0.0] * 99


def test_high_variance_velocity_reports_truncated_tail() -> None:
    result = monte_carlo(_scrum_project(_LUMPY, 100.0), runs=2_000, seed=2469)
    assert result.velocity_tail_truncated
    assert 5 <= result.velocity_saturated_runs <= 80
    assert result.to_dict()["velocity_saturated_runs"] == result.velocity_saturated_runs
    # The clamped runs sit exactly at the horizon: 410 sprints x 10 days.
    assert result.p95 <= max(result.distribution)


def test_steady_velocity_reports_no_truncation() -> None:
    result = monte_carlo(_scrum_project([8.0, 10.0, 12.0], 40.0), runs=2_000, seed=2469)
    assert not result.velocity_tail_truncated
    assert result.velocity_saturated_runs == 0


def test_no_velocity_path_reports_zero() -> None:
    project = Project(
        id="w",
        name="w",
        start_date=date(2026, 1, 5),
        tasks=[Task(id="a", name="a", duration=timedelta(days=4))],
    )
    result = monte_carlo(project, runs=50, seed=1)
    assert result.velocity_saturated_runs == 0
    assert result.to_dict()["velocity_saturated_runs"] == 0


def test_completed_velocity_task_does_not_count() -> None:
    project = _scrum_project(
        _LUMPY,
        100.0,
        percent_complete=100.0,
        actual_start=date(2026, 1, 5),
        actual_finish=date(2026, 1, 9),
    )
    assert monte_carlo(project, runs=2_000, seed=2469).velocity_saturated_runs == 0


def test_sampler_marks_exactly_the_clamped_runs() -> None:
    saturated = np.zeros(2_000, dtype=bool)
    out = _sample_velocity_durations(100.0, _LUMPY, 1, 2_000, np.random.default_rng(7), saturated)
    assert out is not None
    horizon = 410
    # Every flagged run is at the horizon, and the flag does not move the draw.
    assert saturated.any()
    assert (out[saturated] == horizon).all()
    again = _sample_velocity_durations(100.0, _LUMPY, 1, 2_000, np.random.default_rng(7))
    assert again is not None
    assert np.array_equal(out, again)


def test_result_constructor_defaults_saturation_to_zero() -> None:
    r = MonteCarloResult("p", 1, date(2026, 1, 5), date(2026, 1, 5), date(2026, 1, 5))
    assert r.velocity_saturated_runs == 0
    assert not r.velocity_tail_truncated
