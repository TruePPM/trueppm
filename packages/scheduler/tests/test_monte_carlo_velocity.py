"""Velocity sampler tolerance (#4699) and the agile span guard / MC horizon (#4695)."""

from __future__ import annotations

import random
from dataclasses import replace
from datetime import date, timedelta

import networkx as nx
import numpy as np
import pytest

from trueppm_scheduler import (
    Calendar,
    DateRange,
    DeliveryMode,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    engine,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine import _sample_velocity_durations

# Pairs where k*v summed k times falls an ulp short of round(k*v, 10), plus clean ones.
_CASES = [(0.1, 10), (0.1, 3), (0.3, 7), (0.7, 3), (1.1, 9), (0.2, 15), (2.5, 4), (5.0, 3)]


@pytest.mark.parametrize(("v", "k"), _CASES)
def test_constant_velocity_needs_exactly_k_sprints(v: float, k: int) -> None:
    points = round(v * k, 10)
    out = _sample_velocity_durations(points, [v], 1, 20, np.random.default_rng(1))
    assert out is not None
    assert set(out.tolist()) == {float(k)}


def test_multi_sample_path_counts_exactly_k() -> None:
    # Every draw is 0.1 regardless of which observation is picked.
    out = _sample_velocity_durations(1.0, [0.1, 0.1, 0.1], 1, 50, np.random.default_rng(2))
    assert out is not None
    assert set(out.tolist()) == {10.0}


def test_genuinely_short_target_still_needs_extra_sprint() -> None:
    out = _sample_velocity_durations(1.001, [0.1], 1, 5, np.random.default_rng(3))
    assert out is not None
    assert set(out.tolist()) == {11.0}


def test_end_to_end_ten_tenth_point_sprints_finish_in_100_working_days() -> None:
    """Issue repro: P50 == P95 == the 100-working-day date, not 110 (2026-07-31)."""
    from datetime import date, timedelta

    from trueppm_scheduler import Calendar, DeliveryMode, Project, Task, monte_carlo

    task = Task(
        id="S",
        name="S",
        duration=timedelta(days=1),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=1.0,
    )
    proj = Project(
        id="p",
        name="P",
        start_date=date(2026, 3, 2),
        tasks=[task],
        dependencies=[],
        calendar=Calendar(),
        velocity_samples=[0.1],
        sprint_length_days=10,
    )
    r = monte_carlo(proj, runs=50, seed=1)
    assert r.p50 == r.p95 == date(2026, 7, 17)


# --- Span guard and Monte Carlo horizon for agile projects (#4695) -------------------
#
# Every scrum story carries a velocity worst case of ``(ceil(sp/mean)*4 + 10) *
# sprint_length_days`` working days. Summed serially over every task, that refused an
# all-agile project of ~1,750 stories with 15-day sprints and sized the Monte Carlo
# index centuries past its real finish. The bound is now the longest dependency
# chain of worst-case durations.

_START = date(2026, 3, 2)


def _agile_project(n: int, *, layers: int, sprint_length_days: int, seed: int = 3) -> Project:
    """``n`` scrum stories in ``layers`` layers, each linked FS to 1-2 stories above."""
    rng = random.Random(seed)
    width = n // layers
    tasks = [
        Task(
            id=f"s{i:05d}",
            name=f"s{i}",
            duration=timedelta(days=5),
            delivery_mode=DeliveryMode.SCRUM,
            story_points=float(rng.randint(1, 8)),
        )
        for i in range(n)
    ]
    deps = []
    for i in range(width, n):
        layer = i // width
        prev = range((layer - 1) * width, layer * width)
        for p in rng.sample(prev, min(len(prev), rng.randint(1, 2))):
            deps.append(Dependency(f"s{p:05d}", f"s{i:05d}"))
    return Project(
        id="p",
        name="agile",
        start_date=_START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(),
        velocity_samples=[20.0, 25.0, 30.0, 22.0, 28.0],
        sprint_length_days=sprint_length_days,
    )


def _critical_worst_case_days(project: Project) -> int:
    """Longest chain of per-task worst-case working days (the true span bound)."""
    g = engine._build_graph(project)
    weight = {
        t.id: max(t.duration.days, engine._velocity_worst_case_days(t, project))
        for t in project.tasks
    }
    best: dict[str, int] = {}
    for tid in nx.topological_sort(g):
        best[tid] = weight[tid] + max((best[p] for p in g.predecessors(tid)), default=0)
    return max(best.values())


def _horizon(project: Project) -> date:
    g = engine._build_graph(project)
    topo = list(nx.lexicographical_topological_sort(g, key=str))
    cal_of = {tid: project.calendar for tid in topo}
    return engine._mc_horizon(project, {t.id: t for t in project.tasks}, g, topo, cal_of)


def test_two_thousand_story_agile_project_schedules_and_forecasts() -> None:
    """The issue's shape: 2,000 stories, 15-day sprints. Serially it was ~400k days."""
    project = _agile_project(2000, layers=40, sprint_length_days=15)
    serial = sum(engine._velocity_worst_case_days(t, project) for t in project.tasks)
    assert serial > engine.MAX_PROJECT_SPAN_DAYS  # the old guard's charge
    deterministic = schedule(project)
    result = monte_carlo(project, runs=200, seed=0)
    assert deterministic.project_finish is not None
    assert result.p50 <= result.p80 <= result.p95
    assert result.p95 <= _horizon(project)


def test_horizon_is_within_a_constant_factor_of_the_critical_path_worst_case() -> None:
    """The index is sized to the longest chain, not to the sum over every story."""
    project = _agile_project(2000, layers=40, sprint_length_days=15)
    critical = _critical_worst_case_days(project)
    horizon_days = (_horizon(project) - _START).days
    # Mon-Fri: W working days span at most W*7/5 + a weekend of calendar days, plus one
    # snap day per link on the chain (40 layers).
    assert horizon_days <= critical * 7 // 5 + 2 * 40 + 7
    # ...and the horizon still clears the critical chain itself.
    assert horizon_days >= critical


def test_oversized_story_is_still_rejected_by_schedule_and_monte_carlo() -> None:
    project = _agile_project(200, layers=10, sprint_length_days=15)
    hostile = project.tasks[0]
    tasks = [replace(hostile, story_points=1e12), *project.tasks[1:]]
    hostile_project = replace(project, tasks=tasks)
    with pytest.raises(InvalidScheduleInput, match="Total project span"):
        schedule(hostile_project)
    with pytest.raises(InvalidScheduleInput, match="Total project span"):
        monte_carlo(hostile_project, runs=10, seed=0)


def test_total_velocity_sprints_stay_bounded_across_parallel_stories() -> None:
    """Parallel stories no longer add to the span, but the sampler's draw count still
    sums over them, so the total sprint horizon keeps the old ceiling."""
    stories = 40
    # mean 1, 2,498 points -> max_sprints = 2498*4 + 10 = 10,002 each, 400k in total.
    tasks = [
        Task(
            id=f"s{i}",
            name="s",
            duration=timedelta(days=1),
            delivery_mode=DeliveryMode.SCRUM,
            story_points=2498.0,
        )
        for i in range(stories)
    ]
    project = Project(
        id="p",
        name="p",
        start_date=_START,
        tasks=tasks,
        dependencies=[],
        velocity_samples=[1.0],
        sprint_length_days=1,
    )
    with pytest.raises(InvalidScheduleInput, match="velocity sprint"):
        monte_carlo(project, runs=10, seed=0)


def test_serial_agile_chain_is_still_bounded_by_its_sum() -> None:
    """A chain is the case the sum was right about: its span is still refused."""
    n = engine.MAX_PROJECT_SPAN_DAYS // 210 + 2
    project = _agile_project(n, layers=n, sprint_length_days=15)
    # One story per layer: a pure chain. 8 points at mean 25 -> 14 sprints -> 210 days.
    chain = replace(project, tasks=[replace(t, story_points=8.0) for t in project.tasks])
    with pytest.raises(InvalidScheduleInput, match="Total project span"):
        schedule(chain)


@pytest.mark.parametrize("seed", range(12))
def test_horizon_clears_every_run_on_mixed_inputs(seed: int) -> None:
    """Soundness: lags (incl. negative), SS/FF/SF, SNET pins, a data date, per-task
    calendars with exceptions, and completed or in-progress tasks with recorded
    actuals never push any run past the horizon."""
    rng = random.Random(seed)
    sparse = Calendar(
        working_days=0b0001011,
        exceptions=[DateRange(_START + timedelta(days=30), _START + timedelta(days=90))],
    )
    calendars = {"dense": Calendar(working_days=0b1111111), "sparse": sparse}
    n = 30
    tasks = []
    for i in range(n):
        fields: dict[str, object] = {}
        if rng.random() < 0.6:
            fields.update(delivery_mode=DeliveryMode.SCRUM, story_points=float(rng.randint(1, 40)))
        if rng.random() < 0.15:
            fields["planned_start"] = _START + timedelta(days=rng.randint(0, 120))
        if rng.random() < 0.3:
            fields["calendar_id"] = rng.choice(["dense", "sparse"])
        progress = rng.random()
        if progress < 0.15:
            # Completed: pinned verbatim to its recorded dates, some far out.
            began = _START + timedelta(days=rng.randint(0, 200))
            fields.update(
                actual_start=began,
                actual_finish=began + timedelta(days=rng.randint(0, 30)),
                percent_complete=100.0,
            )
        elif progress < 0.3:
            # In progress: a recorded start and only part of the work remaining.
            fields.update(
                actual_start=_START + timedelta(days=rng.randint(0, 20)),
                percent_complete=float(rng.randint(1, 99)),
            )
        tasks.append(
            Task(
                id=f"t{i:02d}",
                name="t",
                duration=timedelta(days=rng.randint(0, 15)),
                **fields,  # type: ignore[arg-type]
            )
        )
    deps = []
    for i in range(1, n):
        for p in rng.sample(range(i), min(i, rng.randint(0, 2))):
            deps.append(
                Dependency(
                    f"t{p:02d}",
                    f"t{i:02d}",
                    dep_type=rng.choice(list(DependencyType)),
                    lag=timedelta(days=rng.randint(-10, 20)),
                )
            )
    project = Project(
        id="p",
        name="p",
        start_date=_START,
        tasks=tasks,
        dependencies=deps,
        calendars=calendars,
        velocity_samples=[3.0, 5.0, 8.0],
        sprint_length_days=10,
        status_date=_START + timedelta(days=rng.randint(0, 20)),
    )
    # The engine's own overrun guard raises if any run lands past the index end;
    # every simulated completion must also sit inside the horizon.
    result = monte_carlo(project, runs=300, seed=seed)
    task_calendars = engine._resolve_task_calendars(project)
    g = engine._build_graph(project)
    topo = list(nx.lexicographical_topological_sort(g, key=str))
    cal_of = {
        tid: (
            project.calendar
            if task_calendars is None
            else task_calendars.get(tid, project.calendar)
        )
        for tid in topo
    }
    horizon = engine._mc_horizon(project, {t.id: t for t in tasks}, g, topo, cal_of)
    assert max(result.distribution) <= horizon
    assert schedule(project).project_finish <= horizon


@pytest.mark.parametrize("seed", range(20))
def test_nth_working_day_matches_the_day_walk(seed: int) -> None:
    """The arithmetic layout the horizon uses equals the engine's day-by-day walk."""
    rng = random.Random(seed)
    exceptions = []
    cursor = _START - timedelta(days=60)
    for _ in range(rng.randint(0, 8)):
        cursor += timedelta(days=rng.randint(1, 40))
        end = cursor + timedelta(days=rng.randint(0, 20))
        exceptions.append(DateRange(cursor, end))
        cursor = end
    cal = Calendar(working_days=rng.randint(1, 127), exceptions=exceptions)
    for _ in range(40):
        anchor = _START + timedelta(days=rng.randint(-30, 200))
        n = rng.randint(0, 120)
        assert engine._nth_working_day(anchor, n, cal, forward=True) == engine._finish_from_start(
            anchor, n, cal
        )
        assert engine._nth_working_day(anchor, n, cal, forward=False) == engine._start_from_finish(
            anchor, n, cal
        )
