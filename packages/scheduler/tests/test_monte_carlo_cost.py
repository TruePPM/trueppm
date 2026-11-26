"""Cost percentiles priced from the Monte Carlo runs (#4809).

The oracle is hand arithmetic, not the other engine: each run costs actual to date
plus remaining working days x hours per day x units x rate, so on a deterministic
network every level is that one number, and on an uncertain one-task network each
level is the same affine map of the sampled duration's percentile.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from trueppm_scheduler import (
    CostAssignment,
    CostForecast,
    CostModel,
    DeliveryMode,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    monte_carlo,
)
from trueppm_scheduler.engine.montecarlo.cost import _CostCollector

MON = date(2026, 1, 5)


def _task(tid: str, days: int, pert: tuple[int, int, int] | None = None, **kw: object) -> Task:
    if pert is not None:
        o, m, p = pert
        kw.update(
            optimistic_duration=timedelta(days=o),
            most_likely_duration=timedelta(days=m),
            pessimistic_duration=timedelta(days=p),
        )
    return Task(id=tid, name=tid, duration=timedelta(days=days), **kw)  # type: ignore[arg-type]


def _project(*tasks: Task, deps: list[Dependency] | None = None, **kw: object) -> Project:
    return Project(
        id="p", name="p", start_date=MON, tasks=list(tasks), dependencies=deps or [], **kw
    )  # type: ignore[arg-type]


def _two_people() -> tuple[Project, CostModel]:
    project = _project(
        _task("a", 5),
        _task("b", 3),
        deps=[Dependency(predecessor_id="a", successor_id="b", dep_type=DependencyType.FS)],
    )
    model = CostModel(
        actual_to_date=1_000.0,
        assignments=[
            CostAssignment(task_id="a", resource_id="ana", rate=100.0),
            CostAssignment(task_id="b", resource_id="ben", rate=50.0, units=0.5),
        ],
    )
    return project, model


def test_hand_computed_two_people_two_rates() -> None:
    project, model = _two_people()
    result = monte_carlo(project, runs=200, seed=1, cost=model)
    # 1000 + 5 days x 8 h x 1.0 x 100 + 3 days x 8 h x 0.5 x 50 = 1000 + 4000 + 600.
    assert result.cost is not None
    assert result.cost.computable is True
    assert result.cost.missing_rate_count == 0
    assert result.cost.p50 == result.cost.p80 == result.cost.p95 == pytest.approx(5_600.0)


def test_hours_per_day_scales_remaining_work_only() -> None:
    project, model = _two_people()
    six = CostModel(
        actual_to_date=model.actual_to_date, assignments=model.assignments, hours_per_day=6.0
    )
    result = monte_carlo(project, runs=50, seed=1, cost=six)
    assert result.cost is not None
    assert result.cost.p80 == pytest.approx(1_000.0 + (5 * 6 * 100) + (3 * 6 * 0.5 * 50))


def test_dates_are_unchanged_by_a_cost_model() -> None:
    project = _project(
        _task("a", 5, (4, 5, 15)),
        _task("b", 3, (2, 3, 9)),
        deps=[Dependency(predecessor_id="a", successor_id="b", dep_type=DependencyType.FS)],
    )
    model = CostModel(assignments=[CostAssignment(task_id="a", resource_id="ana", rate=80.0)])
    plain = monte_carlo(project, runs=2_000, seed=7).to_dict()
    priced = monte_carlo(project, runs=2_000, seed=7, cost=model).to_dict()
    assert "cost" not in plain
    priced.pop("cost")
    assert priced == plain


def test_one_unrated_assignee_is_not_computable_and_dates_do_not_move() -> None:
    project, model = _two_people()
    unrated = CostModel(
        actual_to_date=model.actual_to_date,
        assignments=[
            *model.assignments,
            CostAssignment(task_id="a", resource_id="cy", rate=None),
            CostAssignment(task_id="b", resource_id="cy", rate=None),
        ],
    )
    plain = monte_carlo(project, runs=100, seed=3)
    result = monte_carlo(project, runs=100, seed=3, cost=unrated)
    assert result.cost == CostForecast(
        computable=False, missing_rate_count=1, actual_to_date=1_000.0, percentiles={}
    )
    assert result.cost.p80 is None
    assert result.percentiles == plain.percentiles
    assert result.to_dict()["cost"]["p80"] is None


def test_cost_percentiles_come_from_the_same_runs_as_the_dates() -> None:
    project = _project(_task("a", 5, (4, 5, 20)))
    model = CostModel(
        actual_to_date=250.0,
        assignments=[CostAssignment(task_id="a", resource_id="ana", rate=40.0)],
    )
    result = monte_carlo(project, runs=3_000, seed=11, cost=model, return_samples=True)
    assert result.samples is not None and result.cost is not None
    sampled = result.samples.durations[:, 0].astype(np.float64)
    for q in (50, 80, 95):
        expected = 250.0 + 8 * 40.0 * float(np.percentile(sampled, q))
        assert result.cost.percentiles[q] == pytest.approx(expected, rel=1e-6)
    assert result.cost.p50 <= result.cost.p80 <= result.cost.p95  # type: ignore[operator]
    assert result.cost.p95 > result.cost.p50  # type: ignore[operator]


def test_in_progress_task_prices_only_its_remaining_days() -> None:
    project = _project(
        _task("a", 10, percent_complete=50.0, actual_start=MON),
        status_date=MON + timedelta(days=7),
    )
    model = CostModel(assignments=[CostAssignment(task_id="a", resource_id="ana", rate=10.0)])
    result = monte_carlo(project, runs=20, seed=1, cost=model)
    assert result.cost is not None
    # floor(10 x 50 / 100) = 5 elapsed days; the remaining 5 x 8 h x 10 = 400.
    assert result.cost.p80 == pytest.approx(400.0)


def test_completed_task_is_not_priced_again() -> None:
    project = _project(
        _task(
            "done",
            4,
            percent_complete=100.0,
            actual_start=MON,
            actual_finish=MON + timedelta(days=3),
        ),
        _task("open", 2),
        status_date=MON + timedelta(days=7),
    )
    model = CostModel(
        actual_to_date=900.0,
        assignments=[
            CostAssignment(task_id="done", resource_id="ana", rate=100.0),
            CostAssignment(task_id="open", resource_id="ana", rate=100.0),
        ],
    )
    result = monte_carlo(project, runs=20, seed=1, cost=model)
    assert result.cost is not None
    assert result.cost.p80 == pytest.approx(900.0 + 2 * 8 * 100.0)


def test_zero_rate_is_a_rate_not_a_missing_one() -> None:
    project, _ = _two_people()
    model = CostModel(assignments=[CostAssignment(task_id="a", resource_id="vol", rate=0.0)])
    result = monte_carlo(project, runs=10, seed=1, cost=model)
    assert result.cost is not None and result.cost.computable
    assert result.cost.p80 == 0.0


@pytest.mark.parametrize(
    "model",
    [
        CostModel(assignments=[CostAssignment(task_id="nope", resource_id="r", rate=1.0)]),
        CostModel(assignments=[CostAssignment(task_id="a", resource_id="r", rate=-1.0)]),
        CostModel(assignments=[CostAssignment(task_id="a", resource_id="r", rate=float("nan"))]),
        CostModel(assignments=[CostAssignment(task_id="a", resource_id="r", rate=1.0, units=-1)]),
        CostModel(actual_to_date=float("inf")),
        CostModel(hours_per_day=-8.0),
    ],
)
def test_invalid_cost_model_is_refused(model: CostModel) -> None:
    project, _ = _two_people()
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=10, seed=1, cost=model)


def test_non_model_cost_is_refused() -> None:
    project, _ = _two_people()
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=10, seed=1, cost={"actual_to_date": 1})  # type: ignore[arg-type]


def test_partly_done_velocity_task_prices_its_realized_days(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A velocity task's realized days are already its remaining work (ADR-1412).

    Unlike a PERT task, its elapsed days must not come off again, so each run costs
    exactly rate x the days the run realized.
    """
    project = _project(
        _task(
            "a",
            10,
            story_points=40.0,
            delivery_mode=DeliveryMode.SCRUM,
            percent_complete=50.0,
            actual_start=MON,
        ),
        status_date=MON + timedelta(days=7),
        velocity_samples=[5.0, 10.0, 20.0],
        sprint_length_days=10,
    )
    model = CostModel(assignments=[CostAssignment(task_id="a", resource_id="ana", rate=10.0)])
    per_run: list[np.ndarray] = []
    price = _CostCollector.result

    def capture(self: _CostCollector, missing: int) -> CostForecast:
        per_run.append(self.costs.copy())
        return price(self, missing)

    monkeypatch.setattr(_CostCollector, "result", capture)
    result = monte_carlo(project, runs=500, seed=5, cost=model, return_samples=True)
    assert result.samples is not None
    realized = result.samples.durations[:, 0].astype(np.float64)
    # The velocity sampler ran: whole sprints of varying count, not the 10-day estimate.
    assert len(set(realized.tolist())) > 1
    np.testing.assert_allclose(per_run[0], 8 * 10.0 * realized)
