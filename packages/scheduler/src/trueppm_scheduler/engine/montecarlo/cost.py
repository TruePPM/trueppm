"""Cost percentiles priced from the same Monte Carlo runs as the dates (#4809).

Each run's cost is ``actual_to_date`` plus every open task's **remaining** working
days in that run x ``hours_per_day`` x each assignee's ``units`` x their hourly
``rate``. The remaining days are read from the very matrix the forward pass
scheduled the run from, after it ran, so cost and date percentiles describe one set
of simulated schedules, not two draws. Pricing consumes no randomness and writes
nothing the forward pass reads, so a run with a cost model returns exactly the dates
it would without one.

A velocity task (ADR-1412) is the exception: its span runs to the sprint its last
point was claimed in, which includes days spent waiting for a team capacity other
stories hold. It is priced by the capacity it claimed instead (each sprint's claimed
points over that sprint's velocity x ``sprint_length_days``,
``_VelocityCapacity.work``), so three parallel stories bill one sprint each, not one,
two and three. Who pays for the wait does not hang on a topological tie-break only
when every sprint has the same velocity: when velocity varies, which sprints a story
claims, and so its days and cost, depends on the order stories are served, though
the total claimed days in each run do not.
That is claimed work only: it ignores the deterministic floor the dates take
(#3765), and a run that saturates the drawn capacity prices just what it claimed,
the same truncated tail its dates report.

Rates have no history here: the caller passes one current rate per resource, so a
rate change re-prices the remaining work and, in ``actual_to_date``, past work too.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

import numpy as np

from trueppm_scheduler.engine.calendar_math import _is_complete
from trueppm_scheduler.engine.errors import InvalidScheduleInput
from trueppm_scheduler.models import Project, Task

if TYPE_CHECKING:
    from trueppm_scheduler.engine.montecarlo.capacity import _VelocityCapacity

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

    def validate(self, project: Project) -> None:
        """Check the model against ``project`` the way ``monte_carlo(cost=...)`` does.

        Lets a caller tell a refused cost model from a refused schedule before it
        simulates, so it can drop the cost and still run the dates once.

        Raises:
            InvalidScheduleInput: An assignment names a task not in ``project``, or
                an amount, rate or units value is not a finite number ``>= 0``.
        """
        _finite_non_negative(self.actual_to_date, "cost.actual_to_date")
        _finite_non_negative(self.hours_per_day, "cost.hours_per_day")
        ids = {t.id for t in project.tasks}
        for a in self.assignments:
            if not isinstance(a, CostAssignment):
                raise InvalidScheduleInput(f"cost.assignments holds a non-CostAssignment: {a!r}")
            if a.task_id not in ids:
                raise InvalidScheduleInput(f"cost assignment names an unknown task {a.task_id!r}")
            _finite_non_negative(a.units, f"units of {a.resource_id!r} on {a.task_id!r}")
            if a.rate is not None:
                _finite_non_negative(a.rate, f"rate of {a.resource_id!r}")


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
    cost.validate(project)
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
        runs: int,
    ) -> None:
        col = {tid: i for i, tid in enumerate(topo_order)}
        self.col = col
        day_rate = np.zeros(len(topo_order), dtype=np.float64)
        for a in cost.assignments:
            # Completed work is in actual_to_date; pricing it again would count it twice.
            if a.rate is not None and not _is_complete(task_map[a.task_id]):
                day_rate[col[a.task_id]] += a.units * cost.hours_per_day * a.rate
        self.cols = np.flatnonzero(day_rate)
        self.day_rate = day_rate[self.cols]
        # An in-progress task samples its total, so its history comes off.
        elapsed = np.zeros(len(topo_order), dtype=np.float64)
        for tid, days in elapsed_days.items():
            elapsed[col[tid]] = days
        self.elapsed = elapsed[self.cols]
        self.actual = float(cost.actual_to_date)
        self.costs = np.full(runs, self.actual, dtype=np.float64)
        self.runs = runs
        # (position in ``cols``, that task's claimed-work days per run), set by track.
        self.claimed: list[tuple[int, np.ndarray]] = []

    def track(self, velocity: _VelocityCapacity) -> _VelocityCapacity:
        """Have the forward pass record each priced velocity task's claimed work.

        The days start as NaN, so a run in which a task claims nothing (it never
        reaches :func:`_consume_capacity`) falls back to its matrix days.
        """
        at = {int(c): i for i, c in enumerate(self.cols)}
        work: dict[str, np.ndarray] = {}
        for tid in velocity.points:
            if self.col[tid] in at:
                work[tid] = np.full(self.runs, np.nan, dtype=np.float64)
                self.claimed.append((at[self.col[tid]], work[tid]))
                # Claimed points are remaining work already (#5012): no elapsed off.
                self.elapsed[at[self.col[tid]]] = 0.0
        return replace(velocity, work=work)

    def add(self, lo: int, block: np.ndarray) -> None:
        """Price runs ``[lo, lo + len(block))`` from their (post-forward) durations."""
        if self.cols.size == 0:
            return
        days = block[:, self.cols] - self.elapsed
        for i, work in self.claimed:
            claimed = work[lo : lo + len(block)]
            days[:, i] = np.where(np.isnan(claimed), days[:, i], claimed)
        remaining = np.maximum(days, 0.0)
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
    runs: int,
    velocity: _VelocityCapacity | None,
) -> tuple[_CostCollector | None, _VelocityCapacity | None]:
    """A collector when the model can be priced (``None`` when absent or unrated).

    Also returns the shared capacity to run the forward pass with: when priced, one
    that records each velocity task's claimed work, which the collector reads.
    """
    if cost is None or _missing_rate_count(cost):
        return None, velocity
    pricer = _CostCollector(cost, topo_order, task_map, elapsed_days, runs)
    return pricer, None if velocity is None else pricer.track(velocity)


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
