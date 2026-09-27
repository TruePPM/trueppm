"""Monte Carlo reads a live task's non-working ``actual_start`` verbatim (#4175).

``schedule()`` keeps a recorded ``actual_start`` verbatim even on a weekend
(ADR-0132 §2); ``monte_carlo()``'s working-day index cannot hold that date and
snapped it to the next working day. For a task with remaining work the snap is
invisible at the finish (#3963), but two readers see the raw date:

* a **live zero-duration milestone**, whose instant *is* the actual (Sunday 00:00),
* an **SS successor**, which measures its lag from the predecessor's start.

A calendar-day lag from Monday instead of Sunday re-lands across a weekend, so a
fully deterministic project finished 2-3 working days after its CPM finish — past
the "at most one working day" bound ``monte_carlo()``'s docstring stated. Found by
the 2026-09-27 scheduler pre-release audit; a residual of #2833 / #2461 / #3963.

Every known-answer case below fails on the pre-#4175 engine with the MC date shown
in its docstring, and the property test mismatched on 34 of 3,000 generated
projects there (0 after).
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
    schedule,
)

# 2026-03-02 is a Monday; 03-07/03-08 and 03-14/03-15 are weekends.
START = date(2026, 3, 2)
WEEKDAYS = 0b0011111
SIX_DAY = 0b0111111


def _project(tasks: list[Task], deps: list[Dependency], **kw: object) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=WEEKDAYS),
        **kw,  # type: ignore[arg-type]
    )


def _assert_mc_matches_cpm(project: Project) -> date:
    """The deterministic-equality contract: every percentile equals the CPM finish."""
    cpm = schedule(project).project_finish
    mc = monte_carlo(project, runs=8, seed=3)
    assert mc.p50 == mc.p80 == mc.p95 == cpm, (
        f"CPM finish {cpm} vs MC p50/p80/p95 {mc.p50}/{mc.p80}/{mc.p95}"
    )
    return cpm


def _ms(tid: str, **kw: object) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(0), **kw)  # type: ignore[arg-type]


def _work(tid: str, days: int, **kw: object) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days), **kw)  # type: ignore[arg-type]


def _dep(p: str, s: str, kind: DependencyType, lag: int = 0) -> Dependency:
    return Dependency(p, s, kind, timedelta(days=lag))


# ---------------------------------------------------------------------------
# Known answers
# ---------------------------------------------------------------------------


def test_weekend_milestone_actual_then_fs_lag_chain_matches_cpm() -> None:
    """The issue's shape: a Sunday milestone actual, then an FS+3 chain.

    M sits on Sun 03-08 00:00, so FS+3 starts A on Wed 03-11; 8 days end Fri 03-20,
    and FS+3 from the day after puts B on Tue 03-24. Measured from the snapped
    Monday, A started Thu and B landed on Fri 03-27 — three working days late.
    """
    project = _project(
        [_ms("M", actual_start=date(2026, 3, 8)), _work("A", 8), _work("B", 1)],
        [_dep("M", "A", DependencyType.FS, 3), _dep("A", "B", DependencyType.FS, 3)],
    )
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 24)


def test_ss_lag_from_work_started_on_a_weekend_matches_cpm() -> None:
    """SS+3 from work whose recorded start is Sat 03-14 measures from Saturday.

    Sat + 3 = Tue 03-17, and X's six days end Tue 03-24. From the snapped Monday
    the successor started Thu and MC reported Thu 03-26.
    """
    project = _project(
        [
            _work("W", 7, percent_complete=10.0, actual_start=date(2026, 3, 14)),
            _work("X", 6),
        ],
        [_dep("W", "X", DependencyType.SS, 3)],
    )
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 24)


def test_ss_lag_from_weekend_started_work_into_a_milestone_matches_cpm() -> None:
    """The milestone branch reads the verbatim start too (MC was Wed 04-01)."""
    project = _project(
        [
            _work("W", 7, percent_complete=10.0, actual_start=date(2026, 3, 14)),
            _ms("M"),
            _work("X", 12),
        ],
        [_dep("W", "M", DependencyType.SS, 1), _dep("M", "X", DependencyType.FS)],
    )
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 31)


def test_milestone_on_its_weekend_actual_can_be_the_finish() -> None:
    """A milestone held on Sun 03-15 by its actual finishes the project on Sunday.

    ``schedule()`` shows a floor-held milestone on the floor's own day. The
    working-day index cannot hold Sunday, so MC reported Mon 03-16.
    """
    project = _project([_work("A", 2), _ms("M", actual_start=date(2026, 3, 15))], [])
    assert _assert_mc_matches_cpm(project) == date(2026, 3, 15)


def test_ss_from_weekend_start_pushed_later_by_a_predecessor_reads_the_pushed_start() -> None:
    """The verbatim actual only anchors SS successors in the runs where it binds.

    P finishes Tue 03-17, so W starts Wed 03-18 despite its Sat 03-14 actual, and
    the SS+1 successor measures from Wednesday, not from Saturday.
    """
    project = _project(
        [
            _work("P", 12),
            _work("W", 4, percent_complete=25.0, actual_start=date(2026, 3, 14)),
            _work("X", 3),
        ],
        [_dep("P", "W", DependencyType.FS), _dep("W", "X", DependencyType.SS, 1)],
    )
    _assert_mc_matches_cpm(project)
    assert schedule(project).tasks[1].early_start == date(2026, 3, 18)


def test_uncertain_milestone_only_sometimes_on_its_weekend_actual_rounds_later() -> None:
    """Where only some runs show the milestone on its Sunday, MC rounds forward.

    A's sampled duration sometimes pushes M past its Sun 03-08 floor. The runs
    where it does not are reported on the next working day rather than Sunday —
    the one rounding left, and in the permitted direction: never before CPM.
    """
    project = _project(
        [
            _work(
                "A",
                3,
                optimistic_duration=timedelta(days=3),
                most_likely_duration=timedelta(days=4),
                pessimistic_duration=timedelta(days=10),
            ),
            _ms("M", actual_start=date(2026, 3, 8)),
        ],
        [_dep("A", "M", DependencyType.FS)],
    )
    cpm = schedule(project).project_finish
    assert cpm == date(2026, 3, 8)
    mc = monte_carlo(project, runs=400, seed=7)
    assert cpm <= mc.p50 <= mc.p80 <= mc.p95


# ---------------------------------------------------------------------------
# Property: deterministic projects with progress simulate to the CPM finish
# ---------------------------------------------------------------------------


def _generate(seed: int, *, mixed_calendars: bool) -> Project:
    """A random deterministic project with live actuals on any weekday.

    Unlike the #2461/#3963 generators in ``test_redteam_20260727.py``, this one
    carves nothing out: zero-duration milestones, every dependency type, and an
    ``actual_start`` on *in-progress* work and milestones drawn over weekends.
    """
    rng = random.Random(seed)
    n = rng.randint(2, 7)
    tasks: list[Task] = []
    for i in range(n):
        t = _work(f"T{i}", rng.randint(0, 8))
        if mixed_calendars and rng.random() < 0.3:
            t.calendar_id = "six"
        roll = rng.random()
        if roll < 0.25:
            t.percent_complete = 100.0
            finish = START + timedelta(days=rng.randint(0, 15))
            t.actual_finish = finish
            if rng.random() < 0.5:
                t.actual_start = finish - timedelta(days=rng.randint(0, 5))
        elif roll < 0.8:
            t.percent_complete = float(rng.choice([0, 10, 25, 50, 75]))
            t.actual_start = START + timedelta(days=rng.randint(0, 15))
        if rng.random() < 0.2:
            t.planned_start = START + timedelta(days=rng.randint(0, 20))
        tasks.append(t)

    deps: list[Dependency] = []
    seen: set[tuple[int, int]] = set()
    for _ in range(rng.randint(1, 2 * n)):
        i, j = rng.randrange(n), rng.randrange(n)
        if i >= j or (i, j) in seen:
            continue
        seen.add((i, j))
        deps.append(_dep(f"T{i}", f"T{j}", rng.choice(list(DependencyType)), rng.randint(-2, 4)))
    status = START + timedelta(days=rng.randint(0, 10)) if rng.random() < 0.3 else None
    extra: dict[str, object] = {"status_date": status}
    if mixed_calendars:
        extra["calendars"] = {"six": Calendar(working_days=SIX_DAY)}
    return _project(tasks, deps, **extra)


@pytest.mark.parametrize("seed", range(150))
def test_deterministic_projects_with_live_actuals_simulate_to_the_cpm_finish(seed: int) -> None:
    """MC P50 (and P80/P95) equals ``schedule().project_finish`` with live actuals."""
    _assert_mc_matches_cpm(_generate(seed, mixed_calendars=False))


@pytest.mark.parametrize("seed", range(100))
def test_mixed_calendar_projects_with_live_actuals_simulate_to_the_cpm_finish(seed: int) -> None:
    """The same contract across per-task calendars, where "non-working" is per task."""
    _assert_mc_matches_cpm(_generate(seed, mixed_calendars=True))
