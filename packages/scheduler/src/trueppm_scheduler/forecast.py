"""Bootstrap delivery forecasts for velocity and throughput teams.

Given a team's per-period pace history (story points per sprint, or items per week)
and a remaining backlog, estimate when the backlog completes at P50/P80/P95, so an
embedder never re-implements engine math.

The velocity forecast is not a second sampler. :func:`forecast_velocity_delivery`
runs :func:`trueppm_scheduler.monte_carlo` on a one-story project, so it uses the
engine's shared-capacity velocity model (ADR-1412: one per-sprint velocity vector per
run, fractional sprints) and returns the same percentile dates ``monte_carlo()``
returns for the same backlog, history, sprint length and seed (#5185). The throughput
forecast has no Monte Carlo counterpart; it bootstraps weeks-to-completion here.

Seeded runs are reproducible only on the same numpy and scheduler versions.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, NamedTuple

import numpy as np

from trueppm_scheduler.engine import (
    MAX_VELOCITY_SPRINTS,
    InvalidScheduleInput,
    _velocity_mean,
    monte_carlo,
)
from trueppm_scheduler.models import Calendar, DeliveryMode, Project, Task

# Cells (runs x horizon) per bootstrap draw block: drawing whole-row blocks consumes
# the seeded stream exactly as one full ``(runs, horizon)`` matrix would, while peak
# memory stays ~20 MB at any horizon.
_BOOTSTRAP_CHUNK_CELLS = 2_500_000

# Every weekday a working day: the forecast paces sprints in calendar days.
_SEVEN_DAY_WEEK = 0x7F

__all__ = [
    "DeliveryForecast",
    "duration_percentiles",
    "forecast_throughput_delivery",
    "forecast_velocity_delivery",
    "velocity_band_dates",
]


class PeriodCounts(NamedTuple):
    """Periods-to-completion per run, and how many runs the horizon clamped."""

    counts: Any
    saturated_runs: int


@dataclass(frozen=True)
class DeliveryForecast:
    """P50/P80/P95 delivery forecast from a bootstrap of pace history.

    Attributes:
        p50_periods: Median periods (sprints or weeks) to completion, rounded up.
        p80_periods: 80th-percentile periods to completion, rounded up.
        p50_date: Projected completion date at the median.
        p80_date: Projected completion date at the 80th percentile.
        p95_date: Projected completion date at the 95th percentile.
        horizon_saturated: True when any simulated run hit the bootstrap horizon, in
            which case the upper percentiles are lower bounds.
    """

    p50_periods: int
    p80_periods: int
    p50_date: date
    p80_date: date
    p95_date: date
    horizon_saturated: bool


def bootstrap_horizon(target: float, mean: float) -> int:
    """Per-run period horizon of a bootstrap burn-down (#2645).

    About 4x the mean-pace period count plus a floor, capped at
    :data:`trueppm_scheduler.MAX_VELOCITY_SPRINTS`. A run that has not burned down by
    the horizon is clamped to it and reported as saturated.
    """
    return min(int(np.ceil(target / mean)) * 4 + 10, MAX_VELOCITY_SPRINTS)


def bootstrap_periods_to_completion(
    observations: Any, target: float, n: int, rng: Any, *, rtol: float
) -> PeriodCounts:
    """Bootstrap periods needed to burn down ``target`` from per-period ``observations``.

    For each of ``n`` runs, draw observations with replacement and count the periods
    until the running total reaches ``target * rtol``; a run that never reaches it by
    :func:`bootstrap_horizon` counts as the horizon and is reported in
    ``saturated_runs``, because its count is a lower bound rather than an estimate
    (#2469). ``observations`` must have a positive mean.
    """
    horizon = bootstrap_horizon(target, float(observations.mean()))
    counts = np.empty(n, dtype=np.int64)
    saturated = 0
    chunk_rows = max(1, _BOOTSTRAP_CHUNK_CELLS // horizon)
    for lo in range(0, n, chunk_rows):
        rows = min(chunk_rows, n - lo)
        draws = rng.choice(observations, size=(rows, horizon), replace=True)
        reached = np.cumsum(draws, axis=1) >= target * rtol
        burned_down = reached.any(axis=1)
        counts[lo : lo + rows] = np.where(burned_down, reached.argmax(axis=1) + 1, horizon)
        saturated += int(np.count_nonzero(~burned_down))
    return PeriodCounts(counts.astype(np.float64), saturated)


def sample_throughput_period_counts(
    weekly_throughput: list[int],
    remaining_count: float,
    n: int,
    rng: Any,
) -> PeriodCounts | None:
    """Bootstrap weeks-to-completion from a weekly throughput series (ADR-0130 D3).

    Zero-throughput
    weeks are real observations and are bootstrapped, except the *leading* run of zero
    weeks, which is an artifact of a fixed zero-filled calendar window rather than
    evidence of a slow team. Returns ``None`` when every week is zero or
    ``remaining_count`` is non-positive.
    """
    first_active = next((i for i, w in enumerate(weekly_throughput) if w and w > 0), None)
    if remaining_count <= 0 or first_active is None:
        return None
    observations = np.asarray(
        [max(w or 0, 0) for w in weekly_throughput[first_active:]], dtype=float
    )
    return bootstrap_periods_to_completion(observations, remaining_count, n, rng, rtol=1.0)


def _project(counts: Any, today: date, period_days: int) -> tuple[date, date, date]:
    # Pace the continuous percentile (not the rounded period count) onto the calendar
    # so the P80/P95 dates land strictly after P50.
    p50, p80, p95 = (
        today + timedelta(days=round(float(np.percentile(counts, q)) * period_days))
        for q in (50, 80, 95)
    )
    return p50, p80, p95


def forecast_velocity_delivery(
    remaining_points: float,
    velocity_samples: list[float],
    *,
    sprint_length_days: int,
    today: date,
    runs: int = 1000,
    seed: int = 0xC0FFEE,
) -> DeliveryForecast | None:
    """Forecast when a points backlog completes, from per-sprint velocity history.

    Runs :func:`trueppm_scheduler.monte_carlo` on a project holding one SCRUM story
    of ``remaining_points`` (a one-day ``duration``, the floor the engine never
    samples below), with the history as ``velocity_samples``, ``sprint_length_days``
    as the sprint length, a seven-day working week (sprints are paced in calendar
    days) and ``today`` as both the start and the data date. The dates are therefore
    ``monte_carlo()``'s own P50/P80/P95 for that project, run for run under the same
    seed (#5185): the forecast cannot drift from the engine's sampler (ADR-1412),
    including its fractional sprints, so a backlog that needs a fifth of a sprint
    finishes a fifth of the way into it.

    ``p50_periods`` / ``p80_periods`` are the sprint, counted from 1 at ``today``,
    that the P50 / P80 date falls in.

    Args:
        remaining_points: Story points still to deliver.
        velocity_samples: Completed points of each eligible closed sprint. Zero is an
            observation; exclude ineligible sprints before calling.
        sprint_length_days: Calendar days a sprint spans.
        today: Anchor date the projection counts forward from.
        runs: Number of Monte Carlo runs.
        seed: RNG seed; a fixed seed reproduces the same forecast.

    Returns:
        A :class:`DeliveryForecast`, or ``None`` when there is no usable velocity
        signal (no observations, all zero, no remaining work, or a sprint shorter
        than a day).

    A backlog so large that the engine refuses its worst-case total span does not
    raise: it returns a forecast with ``horizon_saturated`` True and every date
    clamped to ``MAX_VELOCITY_SPRINTS`` sprints past ``today``.

    Raises:
        SchedulerError: Whatever :func:`~trueppm_scheduler.monte_carlo` raises for
            other input it refuses, such as a non-finite ``remaining_points``.
    """
    if remaining_points <= 0 or sprint_length_days < 1:
        return None
    story = Task(
        id="backlog",
        name="backlog",
        duration=timedelta(days=1),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=float(remaining_points),
    )
    project = Project(
        id="velocity-forecast",
        name="velocity-forecast",
        start_date=today,
        status_date=today,
        tasks=[story],
        calendar=Calendar(working_days=_SEVEN_DAY_WEEK),
        velocity_samples=list(velocity_samples),
        sprint_length_days=sprint_length_days,
    )
    if _velocity_mean(project) is None:
        return None
    try:
        result = monte_carlo(project, runs=runs, seed=seed)
    except InvalidScheduleInput as exc:
        # The engine refuses a worst-case span past its cap before it clamps the
        # sprint horizon to MAX_VELOCITY_SPRINTS. For a backlog this large that is
        # saturation, which this function has always reported rather than raised.
        # In this fallback every percentile (P50 included) is the horizon cap, not an
        # estimate: no simulation ran, so read it as "beyond the horizon".
        if not str(exc).startswith("Total project span"):
            raise
        horizon = today + timedelta(days=MAX_VELOCITY_SPRINTS * sprint_length_days)
        return DeliveryForecast(
            p50_periods=MAX_VELOCITY_SPRINTS,
            p80_periods=MAX_VELOCITY_SPRINTS,
            p50_date=horizon,
            p80_date=horizon,
            p95_date=horizon,
            horizon_saturated=True,
        )

    def sprint_of(day: date) -> int:
        return -(-((day - today).days + 1) // sprint_length_days)

    return DeliveryForecast(
        p50_periods=sprint_of(result.p50),
        p80_periods=sprint_of(result.p80),
        p50_date=result.p50,
        p80_date=result.p80,
        p95_date=result.p95,
        horizon_saturated=result.velocity_saturated_runs > 0,
    )


def forecast_throughput_delivery(
    weekly_throughput: list[int],
    remaining_count: float,
    *,
    today: date,
    runs: int = 1000,
    seed: int = 0xF10C0DE,
) -> DeliveryForecast | None:
    """Forecast when an item backlog completes, from a weekly throughput series.

    Args:
        weekly_throughput: Completed items per week, oldest first, zero-filled across
            the window. Leading zero weeks are ignored; interior and trailing zeros
            are real stalls.
        remaining_count: Items still to deliver.
        today: Anchor date the projection counts forward from.
        runs: Number of bootstrap simulations.
        seed: RNG seed; a fixed seed reproduces the same forecast.

    Returns:
        A :class:`DeliveryForecast` whose periods are weeks, or ``None`` when there is
        no usable throughput signal.
    """
    sampled = sample_throughput_period_counts(
        weekly_throughput, remaining_count, runs, np.random.default_rng(seed)
    )
    if sampled is None:
        return None
    counts = sampled.counts
    p50_date, p80_date, p95_date = _project(counts, today, 7)
    return DeliveryForecast(
        p50_periods=int(np.ceil(float(np.percentile(counts, 50)))),
        p80_periods=int(np.ceil(float(np.percentile(counts, 80)))),
        p50_date=p50_date,
        p80_date=p80_date,
        p95_date=p95_date,
        horizon_saturated=sampled.saturated_runs > 0,
    )


def duration_percentiles(values: list[float]) -> dict[str, int | None]:
    """P50/P80/P95 of a sample in whole units, or all-``None`` for an empty sample.

    Args:
        values: Observed durations (for example cycle times in days).

    Returns:
        ``{"p50": ..., "p80": ..., "p95": ...}`` with each value rounded to an int.
    """
    if not values:
        return {"p50": None, "p80": None, "p95": None}
    arr = np.asarray(values, dtype=float)
    return {
        "p50": round(float(np.percentile(arr, 50))),
        "p80": round(float(np.percentile(arr, 80))),
        "p95": round(float(np.percentile(arr, 95))),
    }


def velocity_band_dates(
    *,
    cpm_finish: date | None,
    remaining: int,
    sprint_days: int,
    velocity_low: int | None,
    avg: float | None,
) -> tuple[date | None, date | None, date | None, bool]:
    """Coarse velocity-band P50/P80/P95 finish dates (ADR-0106 section E1.1).

    The 1-sigma slow-pace penalty re-paces the remaining committed work from the
    team's average to its slow-tail velocity:
    ``penalty = remaining * (sprint_days/velocity_low - sprint_days/avg)``. P80 takes
    0.6 of it, P95 the whole tail. Below the two-closed-sprint floor (no band) or with
    no remaining work the spread collapses to ``cpm_finish``.

    Returns:
        ``(p50, p80, p95, usable)`` where ``usable`` is True only when a real band was
        applied. Monotonic by construction: ``p50 <= p80 <= p95``.
    """
    p50 = p80 = p95 = cpm_finish
    if velocity_low and avg and cpm_finish is not None and remaining > 0:
        penalty_days = max(0, round(remaining * (sprint_days / velocity_low - sprint_days / avg)))
        p80 = cpm_finish + timedelta(days=round(penalty_days * 0.6))
        p95 = cpm_finish + timedelta(days=penalty_days)
        return p50, p80, p95, True
    return p50, p80, p95, False
