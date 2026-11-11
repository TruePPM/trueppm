"""How Monte Carlo models the remaining work of an in-progress estimated task (#1495).

The model is **subtractive**, and it is a decided convention (ADR-0132): the
elapsed portion of an in-progress task is history, ``int(duration * pct / 100)``
working days of the *planned* duration exactly as :func:`schedule` counts it, and
every run's sampled total less that fixed elapsed is the work still to do. The
alternative #1495 weighed — elapsed scaled by each run's sampled total — would make
already-spent time vary run to run, and would move the derived span start that
SS/SF links from started work measure from (#4523) and the what-if arithmetic
(:func:`_shift_remaining_work`, #4820) with it.

The truncation #1495 was filed for is gone: every sampled duration is floored at
the planned duration (#3765) *before* the elapsed days come off, so a run's
remaining work is never below the deterministic remaining work, and a
99%-complete task keeps the whole spread of its estimate.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta

import pytest

from trueppm_scheduler import Dependency, Project, Task, monte_carlo, schedule
from trueppm_scheduler.engine.montecarlo.sampling import _shift_remaining_work

START = date(2026, 1, 5)  # a Monday


def _project(duration: int, pct: float, estimate: tuple[int, int, int]) -> Project:
    o, m, p = estimate
    return Project(
        id="ip",
        name="ip",
        start_date=START,
        tasks=[
            Task(
                id="a",
                name="a",
                duration=timedelta(days=duration),
                percent_complete=pct,
                actual_start=START,
                optimistic_duration=timedelta(days=o),
                most_likely_duration=timedelta(days=m),
                pessimistic_duration=timedelta(days=p),
            ),
            Task(id="b", name="b", duration=timedelta(days=3)),
        ],
        dependencies=[Dependency(predecessor_id="a", successor_id="b")],
    )


@pytest.mark.parametrize("pct", [10.0, 35.0, 60.0, 99.0])
@pytest.mark.parametrize("k", [10, 11, 14, 23])
def test_fixed_sample_equals_schedule_with_elapsed_held(pct: float, k: int) -> None:
    """The fixed-sample oracle, in the subtractive model's own terms.

    With all three points pinned to ``k`` every run samples ``k`` (never below the
    planned 10 days, #3765), so Monte Carlo must equal ``schedule()`` of the task
    with the same elapsed days and ``k`` days in total: the what-if transform
    :func:`_shift_remaining_work` builds exactly that task. (``schedule()`` with
    ``duration := k`` and the same percentage is the *proportional* model, which
    this engine does not use; the two differ whenever ``int(k * pct / 100)`` is not
    ``int(10 * pct / 100)``.)
    """
    project = _project(10, pct, (k, k, k))
    result = monte_carlo(project, runs=7, seed=1495)
    shifted = replace(
        project, tasks=[_shift_remaining_work(project.tasks[0], k - 10), project.tasks[1]]
    )
    expected = schedule(shifted).project_finish
    assert result.p50 == result.p95 == expected
    assert set(result.distribution) == {expected}


def test_high_percent_complete_keeps_the_estimate_spread() -> None:
    """The #1495 repro: 99% of a 10-day task, estimated 5/10/30, must not collapse."""
    project = _project(10, 99.0, (5, 10, 30))
    cpm_finish = schedule(project).project_finish
    result = monte_carlo(project, runs=4_000, seed=1495)
    # Never ahead of the deterministic remaining work (the #3765 floor) ...
    assert min(result.distribution) >= cpm_finish
    # ... and the estimate's right tail survives in the remaining work.
    assert len(set(result.distribution)) >= 8
    assert result.p95 > result.p50 >= cpm_finish
    # The sampled total runs to 30 days; 9 elapsed, so up to 21 days remain.
    assert (result.p95 - cpm_finish).days >= 7


def test_in_progress_mean_tracks_schedule_of_the_mean_estimate() -> None:
    """schedule()-vs-MC sanity: the MC median sits on schedule() of the median remaining work.

    A symmetric estimate 10/12/14 floored at 10 has a median total of 12; with 4 of
    10 planned days elapsed, schedule() of a 12-day task holding those 4 days is the
    reference the simulated median must land within a working day of.
    """
    project = _project(10, 40.0, (10, 12, 14))
    result = monte_carlo(project, runs=4_000, seed=1495)
    shifted = replace(project, tasks=[_shift_remaining_work(project.tasks[0], 2), project.tasks[1]])
    reference = schedule(shifted).project_finish
    assert abs((result.p50 - reference).days) <= 1


def _spread_days(estimate: tuple[int, int, int]) -> int:
    """P95 - P5 of the finish distribution, in calendar days, for a 60%-done task."""
    result = monte_carlo(_project(10, 60.0, estimate), runs=4_000, seed=1495)
    ordered = sorted(result.distribution)
    n = len(ordered)
    return (ordered[int(n * 0.95)] - ordered[int(n * 0.05)]).days


def test_spread_scales_with_the_estimate() -> None:
    """Widening the three-point estimate widens the finish spread, roughly in proportion.

    The remaining work is the sampled total less a *fixed* elapsed, so the spread of
    the finish is the spread of the estimate (not shrunk by percent complete, #1495).
    Doubling the O..P width must at least strictly grow the spread, and the ratio
    must sit near the width ratio (generous tolerance: calendar days include weekends).
    """
    narrow = _spread_days((8, 12, 16))  # width 8
    wide = _spread_days((6, 12, 20))  # width 14
    widest = _spread_days((2, 12, 30))  # width 28
    assert narrow < wide < widest
    assert 1.2 <= wide / narrow <= 2.8
    assert 1.2 <= widest / wide <= 2.8


def test_in_progress_mean_finish_tracks_schedule_of_the_mean_estimate() -> None:
    """The issue's test-plan check: the MC *mean* finish offset vs schedule() of the mean.

    Estimate 10/12/14 has mean total 12 (symmetric); with 4 of 10 planned days
    elapsed the reference is schedule() of the 12-day task holding those 4 days.
    The mean of the simulated finish offsets must sit within a working day of it.
    """
    project = _project(10, 40.0, (10, 12, 14))
    result = monte_carlo(project, runs=4_000, seed=1495)
    shifted = replace(project, tasks=[_shift_remaining_work(project.tasks[0], 2), project.tasks[1]])
    reference = schedule(shifted).project_finish
    offsets = [(d - reference).days for d in result.distribution]
    mean_offset = sum(offsets) / len(offsets)
    assert abs(mean_offset) <= 1.0, mean_offset
