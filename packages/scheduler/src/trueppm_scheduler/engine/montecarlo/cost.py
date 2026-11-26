"""Cost percentiles priced from the same Monte Carlo runs as the dates (#4809).

Each run's cost is ``actual_to_date`` plus every open task's **remaining** working
days in that run x ``hours_per_day`` x each assignee's ``units`` x their hourly
``rate``. The remaining days are read from the very matrix the forward pass
scheduled the run from, after it ran (a velocity task's realized days are written
into it then), so cost and date percentiles describe one set of simulated
schedules, not two draws. Pricing consumes no randomness and writes nothing the
forward pass reads, so a run with a cost model returns exactly the dates it would
without one.

Rates have no history here: the caller passes one current rate per resource, so a
rate change re-prices the remaining work and, in ``actual_to_date``, past work too.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from trueppm_scheduler.engine.calendar_math import _is_complete
from trueppm_scheduler.engine.errors import InvalidScheduleInput
from trueppm_scheduler.models import Project, Task

#: The confidence levels a :class:`CostForecast` computes, matching the dates.
COST_LEVELS = (50, 80, 95)


@dataclass(frozen=True, kw_only=True)
class CostAssignment:
    """One person's assignment to one task, for pricing a simulation (#4809).

    Attributes:
        task_id: The assigned task's id; must name a task in the project.
        resource_id: The person's stable id. Distinct ids with no rate are what
            :attr:`CostForecast.missing_rate_count` counts, so one person on two
            tasks counts once.
        rate: Hourly rate in the caller's currency, or ``None`` when the person has
            no rate. ``0`` is a real zero-cost rate, not a missing one.
        units: Share of each working day the person spends on the task: ``1.0`` is
            full time, ``0.5`` half. Defaults to ``1.0``.
    """

    task_id: str
    resource_id: str
    rate: float | None
    units: float = 1.0


@dataclass(frozen=True, kw_only=True)
class CostModel:
    """What :func:`~trueppm_scheduler.monte_carlo` needs to price each run (#4809).

    Non-human resources are left out by the caller; the engine prices whatever
    assignments it is given.

    Attributes:
        assignments: Every person-to-task assignment to price. Any iterable is
            accepted and normalized to a tuple.
        actual_to_date: Cost already incurred, added to every run unchanged.
            Defaults to ``0.0``.
        hours_per_day: Working hours in a full-time working day, used to turn a
            task's remaining working days into hours. Defaults to ``8.0``. Unlike
            ``Calendar.hours_per_day``, which the scheduler does not read, this one
            is consumed.
    """

    assignments: Sequence[CostAssignment] = field(default_factory=tuple)
    actual_to_date: float = 0.0
    hours_per_day: float = 8.0

    def __post_init__(self) -> None:
        """Normalize ``assignments`` to a tuple so the model cannot change later."""
        object.__setattr__(self, "assignments", tuple(self.assignments))


@dataclass(frozen=True, kw_only=True)
class CostForecast:
    """Cost percentiles from a Monte Carlo run, on :attr:`MonteCarloResult.cost`.

    Attributes:
        computable: ``True`` when every assignee had a rate. When ``False``,
            :attr:`percentiles` is empty: an unpriced person's hours would make
            every percentile an understatement, so none is given.
        missing_rate_count: How many distinct assignees (by ``resource_id``) had
            no rate.
        actual_to_date: The incurred cost each run started from.
        percentiles: Cost at each confidence level, keyed by integer level
            (``50``, ``80``, ``95``): that share of the simulated schedules cost at
            or below it. ``numpy.percentile`` linear interpolation over every run,
            the convention the date percentiles use.
    """

    computable: bool
    missing_rate_count: int
    actual_to_date: float
    percentiles: Mapping[int, float] = field(default_factory=dict)

    @property
    def p50(self) -> float | None:
        """Cost 50% of simulated schedules came in at or below, or ``None``."""
        return self.percentiles.get(50)

    @property
    def p80(self) -> float | None:
        """Cost 80% of simulated schedules came in at or below, or ``None``."""
        return self.percentiles.get(80)

    @property
    def p95(self) -> float | None:
        """Cost 95% of simulated schedules came in at or below, or ``None``."""
        return self.percentiles.get(95)

    def to_dict(self) -> dict[str, Any]:
        """Return the forecast as a JSON-serializable dict.

        Returns:
            ``{"computable", "missing_rate_count", "actual_to_date", "p50", "p80",
            "p95"}``; each percentile is ``None`` when not computable.
        """
        return {
            "computable": self.computable,
            "missing_rate_count": self.missing_rate_count,
            "actual_to_date": self.actual_to_date,
            **{f"p{q}": self.percentiles.get(q) for q in COST_LEVELS},
        }


def _finite_non_negative(value: object, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidScheduleInput(f"{what} must be a number, got {value!r}")
    if not math.isfinite(value) or value < 0:
        raise InvalidScheduleInput(f"{what} must be finite and >= 0, got {value!r}")
    return float(value)


def _validate_cost(project: Project, cost: object) -> CostModel | None:
    """Check a ``cost=`` argument against the project; ``None`` passes through."""
    if cost is None:
        return None
    if not isinstance(cost, CostModel):
        raise InvalidScheduleInput(f"cost must be a CostModel or None, got {type(cost).__name__}")
    _finite_non_negative(cost.actual_to_date, "cost.actual_to_date")
    _finite_non_negative(cost.hours_per_day, "cost.hours_per_day")
    ids = {t.id for t in project.tasks}
    for a in cost.assignments:
        if not isinstance(a, CostAssignment):
            raise InvalidScheduleInput(f"cost.assignments holds a non-CostAssignment: {a!r}")
        if a.task_id not in ids:
            raise InvalidScheduleInput(f"cost assignment names an unknown task {a.task_id!r}")
        _finite_non_negative(a.units, f"units of {a.resource_id!r} on {a.task_id!r}")
        if a.rate is not None:
            _finite_non_negative(a.rate, f"rate of {a.resource_id!r}")
    return cost


def _missing_rate_count(cost: CostModel) -> int:
    return len({a.resource_id for a in cost.assignments if a.rate is None})


class _CostCollector:
    """Prices each row chunk of sampled durations as the forward pass releases it."""

    def __init__(
        self,
        cost: CostModel,
        topo_order: Sequence[str],
        task_map: Mapping[str, Task],
        elapsed_days: Mapping[str, float],
        velocity_ids: Sequence[str],
        runs: int,
    ) -> None:
        col = {tid: i for i, tid in enumerate(topo_order)}
        day_rate = np.zeros(len(topo_order), dtype=np.float64)
        for a in cost.assignments:
            # Completed work is in actual_to_date; pricing it again would count it twice.
            if a.rate is not None and not _is_complete(task_map[a.task_id]):
                day_rate[col[a.task_id]] += a.units * cost.hours_per_day * a.rate
        self.cols = np.flatnonzero(day_rate)
        self.day_rate = day_rate[self.cols]
        # A velocity task's realized days are already its remaining work (ADR-1412);
        # every other in-progress task samples its total, so its history comes off.
        skip = set(velocity_ids)
        elapsed = np.zeros(len(topo_order), dtype=np.float64)
        for tid, days in elapsed_days.items():
            if tid not in skip:
                elapsed[col[tid]] = days
        self.elapsed = elapsed[self.cols]
        self.actual = float(cost.actual_to_date)
        self.costs = np.full(runs, self.actual, dtype=np.float64)

    def add(self, lo: int, block: np.ndarray) -> None:
        """Price runs ``[lo, lo + len(block))`` from their (post-forward) durations."""
        if self.cols.size == 0:
            return
        remaining = np.maximum(block[:, self.cols] - self.elapsed, 0.0)
        self.costs[lo : lo + len(block)] = self.actual + remaining @ self.day_rate

    def result(self, missing: int) -> CostForecast:
        values = np.percentile(self.costs, list(COST_LEVELS)).tolist()
        return CostForecast(
            computable=True,
            missing_rate_count=missing,
            actual_to_date=self.actual,
            percentiles=dict(zip(COST_LEVELS, (float(v) for v in values), strict=True)),
        )


def _cost_collector(
    cost: CostModel | None,
    topo_order: Sequence[str],
    task_map: Mapping[str, Task],
    elapsed_days: Mapping[str, float],
    velocity_ids: Sequence[str],
    runs: int,
) -> _CostCollector | None:
    """A collector when the model can be priced; ``None`` when absent or unrated."""
    if cost is None or _missing_rate_count(cost):
        return None
    return _CostCollector(cost, topo_order, task_map, elapsed_days, velocity_ids, runs)


def _cost_result(cost: CostModel | None, collector: _CostCollector | None) -> CostForecast | None:
    if cost is None:
        return None
    missing = _missing_rate_count(cost)
    if collector is None:
        return CostForecast(
            computable=False,
            missing_rate_count=missing,
            actual_to_date=float(cost.actual_to_date),
        )
    return collector.result(missing)
