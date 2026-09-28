"""Monte Carlo percentiles carry their edge-of-day reading (#4204).

A percentile is an order statistic over the runs' working-time finish positions,
shown on a day the way ``ScheduleResult.project_finish`` is. When the finish is a
start-of-day milestone (#4079) the shown day sits past a weekend from the end of the
Friday before it with no difference in working time, so a consumer can only compare
a percentile against the CPM finish correctly if it knows which edge of the day each
one is.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Dependency,
    DependencyType,
    MonteCarloResult,
    Project,
    Task,
    monte_carlo,
    schedule,
)

MONDAY = date(2026, 8, 3)


def _project(
    lag_days: int,
    *,
    a_days: int = 5,
    a_estimates: tuple[float, float, float] | None = None,
    extra: list[Task] | None = None,
) -> Project:
    a = Task(id="A", name="A", duration=timedelta(days=a_days))
    if a_estimates:
        a = Task(
            id="A",
            name="A",
            duration=timedelta(days=a_days),
            optimistic_duration=timedelta(days=a_estimates[0]),
            most_likely_duration=timedelta(days=a_estimates[1]),
            pessimistic_duration=timedelta(days=a_estimates[2]),
        )
    m = Task(id="M", name="M", duration=timedelta(0))
    link = Dependency(
        predecessor_id="A",
        successor_id="M",
        dep_type=DependencyType.FS,
        lag=timedelta(days=lag_days),
    )
    return Project(
        id="p",
        name="p",
        start_date=MONDAY,
        tasks=[a, m, *(extra or [])],
        dependencies=[link],
    )


def _cpm_reading(project: Project) -> tuple[date, bool]:
    result = schedule(project)
    on_day = [t for t in result.tasks if t.early_finish == result.project_finish]
    at_start = all(t.duration == timedelta(0) and not t.milestone_at_day_end for t in on_day)
    return result.project_finish, at_start


def test_start_of_day_milestone_across_a_weekend_is_read_as_the_start_of_monday() -> None:
    """Known answer: A ends Friday, a 1-day lag lands M at the start of Monday."""
    mc = monte_carlo(_project(1), runs=20, seed=1)
    assert (mc.p50, mc.p80, mc.p95) == (date(2026, 8, 10),) * 3
    assert (mc.p50_at_day_start, mc.p80_at_day_start, mc.p95_at_day_start) == (True,) * 3


def test_end_of_friday_is_read_as_the_end_of_its_day() -> None:
    mc = monte_carlo(_project(0), runs=20, seed=1)
    assert (mc.p50, mc.p80, mc.p95) == (date(2026, 8, 7),) * 3
    assert (mc.p50_at_day_start, mc.p80_at_day_start, mc.p95_at_day_start) == (False,) * 3


@pytest.mark.parametrize("lag_days", [0, 1, 2, 3, 4])
def test_zero_variance_reproduces_the_cpm_finish_and_its_reading(lag_days: int) -> None:
    """A deterministic project's percentiles are the CPM finish, reading included."""
    project = _project(lag_days)
    mc = monte_carlo(project, runs=10, seed=3)
    expected = _cpm_reading(project)
    for day, at_start in (
        (mc.p50, mc.p50_at_day_start),
        (mc.p80, mc.p80_at_day_start),
        (mc.p95, mc.p95_at_day_start),
    ):
        assert (day, at_start) == expected


def test_work_ending_on_the_shown_day_makes_it_the_end_of_that_day() -> None:
    """A task ending Monday evening outranks the start-of-Monday milestone."""
    b = Task(id="B", name="B", duration=timedelta(days=6))
    mc = monte_carlo(_project(1, extra=[b]), runs=10, seed=1)
    assert mc.p80 == date(2026, 8, 10)
    assert mc.p80_at_day_start is False


@pytest.mark.parametrize(
    ("lag_days", "estimates", "p50_at_day_start"),
    [
        # A mostly samples under 5.5 days: the median run shows M at the start of Monday.
        (1, (5.0, 5.0, 6.0), True),
        (1, (5.0, 6.0, 12.0), None),
        (2, (5.0, 6.0, 12.0), None),
        (3, (5.0, 6.0, 12.0), None),
    ],
)
def test_each_uncertain_percentile_is_a_finish_cpm_can_produce(
    lag_days: int, estimates: tuple[float, float, float], p50_at_day_start: bool | None
) -> None:
    """Every percentile, reading included, is the CPM finish of some sampled duration.

    ``A`` samples within its estimate band, so each run's finish is exactly what
    :func:`schedule` gives for ``A`` at that whole-day duration: sometimes the end of
    a day, sometimes (the lag landing on a weekend) the start of a Monday. A
    percentile taken over shown days with no reading could not name which; one taken
    over working-time positions must be one of those CPM finishes.
    """
    mc = monte_carlo(_project(lag_days, a_estimates=estimates), runs=400, seed=7)
    assert mc.p50 <= mc.p80 <= mc.p95
    if p50_at_day_start is not None:
        assert mc.p50_at_day_start is p50_at_day_start
    cpm = {_cpm_reading(_project(lag_days, a_days=n)) for n in range(5, 13)}
    for reading in (
        (mc.p50, mc.p50_at_day_start),
        (mc.p80, mc.p80_at_day_start),
        (mc.p95, mc.p95_at_day_start),
    ):
        assert reading in cpm


def test_to_dict_carries_the_readings_and_defaults_are_end_of_day() -> None:
    mc = monte_carlo(_project(1), runs=5, seed=1)
    out = mc.to_dict()
    assert out["p50_at_day_start"] is True
    assert out["p80_at_day_start"] is True
    assert out["p95_at_day_start"] is True
    legacy = MonteCarloResult(
        project_id="p", runs=1, p50=MONDAY, p80=MONDAY, p95=MONDAY, distribution=[MONDAY]
    )
    assert (legacy.p50_at_day_start, legacy.p80_at_day_start, legacy.p95_at_day_start) == (
        False,
        False,
        False,
    )
