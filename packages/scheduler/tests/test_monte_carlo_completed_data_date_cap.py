"""Monte Carlo pins a completed no-actuals task at the data-date cap (#4539).

The deterministic pass lays a 100%-complete task with no actuals back to finish on
the data date when its SNET span would run past it. The Monte Carlo index must place
it identically: a pinned task is never re-sampled, so if the simulation read the
uncapped position it would forecast a finish days later than the schedule it is
meant to bracket.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import Dependency, Project, Task, monte_carlo, schedule

START = date(2026, 3, 2)  # a Monday
DATA_DATE = date(2026, 3, 12)  # Thursday


def _project(status_date: date | None, **b: object) -> Project:
    return Project(
        id="mc",
        name="mc",
        start_date=START,
        status_date=status_date,
        tasks=[
            Task(
                id="B",
                name="B",
                duration=timedelta(days=5),
                percent_complete=100.0,
                planned_start=date(2026, 3, 11),
                **b,  # type: ignore[arg-type]
            ),
            Task(
                id="C",
                name="C",
                duration=timedelta(days=2),
                optimistic_duration=timedelta(days=1),
                most_likely_duration=timedelta(days=2),
                pessimistic_duration=timedelta(days=6),
            ),
        ],
        dependencies=[Dependency(predecessor_id="B", successor_id="C")],
    )


def _finish(project: Project) -> date:
    return max(t.early_finish for t in schedule(project).tasks)


def test_the_simulated_finish_follows_the_capped_position() -> None:
    capped = _project(DATA_DATE)
    uncapped = _project(None)
    recorded = _project(DATA_DATE, actual_finish=DATA_DATE)

    # Without the cap B runs Wed 03-11 .. Tue 03-17 and C ends Thu 03-19.
    assert _finish(uncapped) == date(2026, 3, 19)
    # Capped, B ends on the data date and C follows: exactly where an actual_finish
    # recorded on the data date puts it.
    assert _finish(capped) == _finish(recorded) == date(2026, 3, 16)

    # C has real variance, so the forecast moves with where B is pinned. Same seed,
    # same draws: a capped B must forecast exactly like one finished on the data date,
    # and earlier than the uncapped position.
    mc = monte_carlo(capped, runs=256, seed=1)
    ref = monte_carlo(recorded, runs=256, seed=1)
    assert (mc.p50, mc.p80, mc.p95) == (ref.p50, ref.p80, ref.p95)
    assert mc.p95 < monte_carlo(uncapped, runs=256, seed=1).p95


def test_a_data_date_at_or_before_the_project_start_caps_nothing() -> None:
    sub_start = _project(date(2026, 3, 1))
    assert _finish(sub_start) == date(2026, 3, 19)
    assert monte_carlo(sub_start, runs=256, seed=1).p50 >= date(2026, 3, 19)
