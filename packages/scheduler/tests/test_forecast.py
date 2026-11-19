"""Bootstrap delivery forecasts (#5008).

The reference functions below are the sampler and percentile derivation exactly as
the API carried them before they moved into the library; parity against them under
a fixed seed proves the move did not change a single draw or rounding.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import numpy as np
import pytest

from trueppm_scheduler import (
    DeliveryForecast,
    duration_percentiles,
    forecast_throughput_delivery,
    forecast_velocity_delivery,
    velocity_band_dates,
)
from trueppm_scheduler.forecast import (
    sample_throughput_period_counts,
    sample_velocity_period_counts,
)

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


def _ref_velocity(points: float, samples: list[float], runs: int, seed: int, length: int) -> dict:
    obs = np.asarray([s for s in samples if s is not None and s >= 0], dtype=float)
    counts, sat = _ref_bootstrap(obs, points, runs, np.random.default_rng(seed), 1.0 - 1e-12)
    return {
        "p50_periods": int(np.ceil(float(np.percentile(counts, 50)))),
        "p80_periods": int(np.ceil(float(np.percentile(counts, 80)))),
        "p50_date": TODAY + timedelta(days=round(float(np.percentile(counts, 50)) * length)),
        "p80_date": TODAY + timedelta(days=round(float(np.percentile(counts, 80)) * length)),
        "p95_date": TODAY + timedelta(days=round(float(np.percentile(counts, 95)) * length)),
        "horizon_saturated": sat > 0,
    }


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


@pytest.mark.parametrize(("points", "samples", "length"), VELOCITY_CASES)
@pytest.mark.parametrize("seed", [1, 0xC0FFEE])
def test_velocity_forecast_matches_pre_move_api_implementation(
    points: float, samples: list[float], length: int, seed: int
) -> None:
    got = forecast_velocity_delivery(
        points, samples, sprint_length_days=length, today=TODAY, runs=1500, seed=seed
    )
    assert got is not None
    assert _as_dict(got) == _ref_velocity(points, samples, 1500, seed, length)


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


def test_samplers_expose_counts_and_saturation() -> None:
    out = sample_velocity_period_counts(35.0, [10.0, 10.0], 50, 1)
    assert out is not None
    assert set(out.counts.tolist()) == {4.0}
    assert out.saturated_runs == 0
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
