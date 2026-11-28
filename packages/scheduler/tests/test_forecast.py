"""Delivery forecasts (#5008, #5185).

The throughput reference below is the sampler and percentile derivation exactly as
the API carried it before it moved into the library; parity against it under a fixed
seed proves the move did not change a single draw or rounding. The velocity forecast
is held to ``monte_carlo()`` instead (#5185): it must return the engine's own
percentile dates for the same backlog, history, sprint length and seed.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import numpy as np
import pytest

from trueppm_scheduler import (
    Calendar,
    DeliveryForecast,
    DeliveryMode,
    Project,
    Task,
    duration_percentiles,
    forecast_throughput_delivery,
    forecast_velocity_delivery,
    monte_carlo,
    velocity_band_dates,
)
from trueppm_scheduler.forecast import sample_throughput_period_counts

TODAY = date(2026, 3, 2)


def _ref_horizon(target: float, mean: float) -> int:
    from trueppm_scheduler import MAX_VELOCITY_SPRINTS

    return min(int(np.ceil(target / mean)) * 4 + 10, MAX_VELOCITY_SPRINTS)


def _ref_bootstrap(obs: Any, target: float, n: int, rng: Any, rtol: float) -> tuple[Any, int]:
    horizon = _ref_horizon(target, float(obs.mean()))
    counts = np.empty(n, dtype=np.int64)
    saturated = 0
    chunk_rows = max(1, 2_500_000 // horizon)
    for lo in range(0, n, chunk_rows):
        rows = min(chunk_rows, n - lo)
        draws = rng.choice(obs, size=(rows, horizon), replace=True)
        reached = np.cumsum(draws, axis=1) >= target * rtol
        burned = reached.any(axis=1)
        counts[lo : lo + rows] = np.where(burned, reached.argmax(axis=1) + 1, horizon)
        saturated += int(np.count_nonzero(~burned))
    return counts.astype(np.float64), saturated


def _ref_throughput(weekly: list[int], remaining: float, runs: int, seed: int) -> dict:
    first = next(i for i, w in enumerate(weekly) if w and w > 0)
    obs = np.asarray([max(w or 0, 0) for w in weekly[first:]], dtype=float)
    counts, sat = _ref_bootstrap(obs, remaining, runs, np.random.default_rng(seed), 1.0)
    return {
        "p50_periods": int(np.ceil(float(np.percentile(counts, 50)))),
        "p80_periods": int(np.ceil(float(np.percentile(counts, 80)))),
        "p50_date": TODAY + timedelta(days=round(float(np.percentile(counts, 50)) * 7)),
        "p80_date": TODAY + timedelta(days=round(float(np.percentile(counts, 80)) * 7)),
        "p95_date": TODAY + timedelta(days=round(float(np.percentile(counts, 95)) * 7)),
        "horizon_saturated": sat > 0,
    }


def _as_dict(f: DeliveryForecast) -> dict:
    return {
        "p50_periods": f.p50_periods,
        "p80_periods": f.p80_periods,
        "p50_date": f.p50_date,
        "p80_date": f.p80_date,
        "p95_date": f.p95_date,
        "horizon_saturated": f.horizon_saturated,
    }


VELOCITY_CASES = [
    (35.0, [10.0, 10.0], 14),
    (37.0, [5.0, 15.0], 14),
    (60.0, [20.0, 0.0, 0.0, 0.0] * 2, 7),
    (113.0, [3.0, 8.0, 13.0, 21.0, 0.0, 5.0], 14),
    (0.7, [0.1], 14),
    (100.0, [100.0] + [0.0] * 99, 14),
]


def _monte_carlo_dates(
    points: float, samples: list[float], length: int, runs: int, seed: int
) -> tuple[date, date, date, int]:
    """``monte_carlo()`` on the one-story project the forecast documents it runs."""
    story = Task(
        id="story",
        name="story",
        duration=timedelta(days=1),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=points,
    )
    project = Project(
        id="p",
        name="p",
        start_date=TODAY,
        status_date=TODAY,
        tasks=[story],
        calendar=Calendar(working_days=0x7F),
        velocity_samples=samples,
        sprint_length_days=length,
    )
    result = monte_carlo(project, runs=runs, seed=seed)
    return result.p50, result.p80, result.p95, result.velocity_saturated_runs


@pytest.mark.parametrize(("points", "samples", "length"), VELOCITY_CASES)
@pytest.mark.parametrize("seed", [1, 0xC0FFEE])
def test_velocity_forecast_matches_monte_carlo(
    points: float, samples: list[float], length: int, seed: int
) -> None:
    """#5185: the forecast is ``monte_carlo()``'s velocity model, date for date."""
    got = forecast_velocity_delivery(
        points, samples, sprint_length_days=length, today=TODAY, runs=1500, seed=seed
    )
    assert got is not None
    p50, p80, p95, saturated = _monte_carlo_dates(points, samples, length, 1500, seed)
    assert (got.p50_date, got.p80_date, got.p95_date) == (p50, p80, p95)
    assert got.horizon_saturated is (saturated > 0)


def test_velocity_forecast_matches_monte_carlo_on_the_issue_repro() -> None:
    """The #5185 repro: 40 points, history [3, 9, 12, 0, 7], 14-day sprints, seed 123."""
    samples = [3.0, 9.0, 12.0, 0.0, 7.0]
    got = forecast_velocity_delivery(
        40.0, samples, sprint_length_days=14, today=TODAY, runs=5000, seed=123
    )
    assert got is not None
    p50, p80, p95, _ = _monte_carlo_dates(40.0, samples, 14, 5000, 123)
    assert (got.p50_date, got.p80_date, got.p95_date) == (p50, p80, p95)


def test_velocity_forecast_counts_fractional_sprints() -> None:
    """A backlog a steady team burns in 3.5 sprints finishes mid-sprint, not at the 4th end."""
    got = forecast_velocity_delivery(
        35.0, [10.0, 10.0], sprint_length_days=14, today=TODAY, runs=50, seed=1
    )
    assert got is not None
    # 3.5 sprints x 14 days = 49 calendar days of work: the last day worked is day 49.
    assert got.p50_date == got.p95_date == TODAY + timedelta(days=48)
    assert got.p50_periods == got.p80_periods == 4
    assert got.horizon_saturated is False


THROUGHPUT_CASES = [
    ([4, 4], 12.0),
    ([4, 0, 0, 0] * 3, 20.0),
    ([0, 0, 3, 2, 0, 3, 1], 15.0),
    ([3, 2, 3, 1, 0, 0], 40.0),
]


@pytest.mark.parametrize(("weekly", "remaining"), THROUGHPUT_CASES)
@pytest.mark.parametrize("seed", [3, 0xF10C0DE])
def test_throughput_forecast_matches_pre_move_api_implementation(
    weekly: list[int], remaining: float, seed: int
) -> None:
    got = forecast_throughput_delivery(weekly, remaining, today=TODAY, runs=800, seed=seed)
    assert got is not None
    assert _as_dict(got) == _ref_throughput(weekly, remaining, 800, seed)


def test_velocity_forecast_is_none_without_a_usable_signal() -> None:
    kw: dict[str, Any] = {"sprint_length_days": 14, "today": TODAY}
    assert forecast_velocity_delivery(35.0, [], **kw) is None
    assert forecast_velocity_delivery(35.0, [0.0, 0.0], **kw) is None
    assert forecast_velocity_delivery(0.0, [10.0], **kw) is None
    assert forecast_velocity_delivery(35.0, [10.0], sprint_length_days=0, today=TODAY) is None


def test_throughput_forecast_is_none_without_a_usable_signal() -> None:
    assert forecast_throughput_delivery([0, 0, 0], 5.0, today=TODAY) is None
    assert forecast_throughput_delivery([4], 0.0, today=TODAY) is None


def test_forecast_is_reproducible_and_monotonic() -> None:
    a = forecast_velocity_delivery(
        80.0, [8.0, 12.0, 5.0], sprint_length_days=14, today=TODAY, seed=9
    )
    b = forecast_velocity_delivery(
        80.0, [8.0, 12.0, 5.0], sprint_length_days=14, today=TODAY, seed=9
    )
    assert a == b
    assert a is not None
    assert a.p50_date <= a.p80_date <= a.p95_date
    assert a.p50_periods <= a.p80_periods


def test_saturation_is_reported_for_a_stalled_team() -> None:
    f = forecast_velocity_delivery(
        100.0, [100.0] + [0.0] * 99, sprint_length_days=14, today=TODAY, seed=1, runs=1500
    )
    assert f is not None
    assert f.horizon_saturated is True


def test_throughput_sampler_exposes_counts() -> None:
    flow = sample_throughput_period_counts([4, 4], 12.0, 25, np.random.default_rng(3))
    assert flow is not None
    assert set(flow.counts.tolist()) == {3.0}


def test_duration_percentiles() -> None:
    assert duration_percentiles([]) == {"p50": None, "p80": None, "p95": None}
    assert duration_percentiles([1, 2, 3, 4, 10]) == {"p50": 3, "p80": 5, "p95": 9}
    assert duration_percentiles([7.0]) == {"p50": 7, "p80": 7, "p95": 7}


def test_velocity_band_dates() -> None:
    finish = date(2026, 6, 1)
    p50, p80, p95, usable = velocity_band_dates(
        cpm_finish=finish, remaining=20, sprint_days=14, velocity_low=5, avg=10.0
    )
    penalty = round(20 * (14 / 5 - 14 / 10))
    assert usable is True
    assert p50 == finish
    assert p80 == finish + timedelta(days=round(penalty * 0.6))
    assert p95 == finish + timedelta(days=penalty)
    for kw in (
        {"velocity_low": None, "avg": 10.0, "remaining": 20},
        {"velocity_low": 5, "avg": 10.0, "remaining": 0},
    ):
        out = velocity_band_dates(cpm_finish=finish, sprint_days=14, **kw)  # type: ignore[arg-type]
        assert out == (finish, finish, finish, False)
    assert velocity_band_dates(
        cpm_finish=None, remaining=5, sprint_days=14, velocity_low=5, avg=10.0
    ) == (None, None, None, False)


def test_velocity_forecast_saturates_instead_of_raising_on_a_huge_backlog() -> None:
    """The engine's span refusal is saturation here, as before #5185."""
    got = forecast_velocity_delivery(
        2000.0, [0.0, 0.0, 0.0, 1.0], sprint_length_days=14, today=TODAY
    )
    assert got is not None
    assert got.horizon_saturated is True
    assert got.p95_date == TODAY + timedelta(days=10_000 * 14)


def test_five_day_week_monte_carlo_differs_from_the_forecast() -> None:
    """The forecast's sprints are calendar days; a working-day calendar finishes later."""
    kwargs: dict[str, Any] = {"points": 40.0, "samples": [10.0, 12.0, 8.0], "length": 14}
    seven = _monte_carlo_dates(runs=500, seed=1, **kwargs)
    story = Task(
        id="story",
        name="story",
        duration=timedelta(days=1),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=40.0,
    )
    five = monte_carlo(
        Project(
            id="p",
            name="p",
            start_date=TODAY,
            status_date=TODAY,
            tasks=[story],
            calendar=Calendar(working_days=0x1F),
            velocity_samples=[10.0, 12.0, 8.0],
            sprint_length_days=14,
        ),
        runs=500,
        seed=1,
    )
    assert five.p50 > seven[0]
