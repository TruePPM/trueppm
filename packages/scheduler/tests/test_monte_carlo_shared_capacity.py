"""Shared team capacity for velocity forecasting (ADR-1412; #5011, #5012, #5013)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    Dependency,
    InvalidScheduleInput,
    Project,
    Task,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine.montecarlo import run as mc_run

START = date(2026, 1, 5)  # a Monday
MON_FRI = Calendar(working_days=0b0011111)


def _story(tid: str, points: float, **kw: object) -> Task:
    return Task(
        id=tid,
        name=tid,
        duration=kw.pop("duration", timedelta(days=1)),  # type: ignore[arg-type]
        delivery_mode=DeliveryMode.SCRUM,
        story_points=points,
        **kw,  # type: ignore[arg-type]
    )


def _project(tasks: list[Task], deps: list[Dependency] = (), **kw: object) -> Project:  # type: ignore[assignment]
    kw.setdefault("velocity_samples", [20, 20, 20])
    kw.setdefault("sprint_length_days", 10)
    return Project(
        id="p",
        name="p",
        start_date=START,
        calendar=MON_FRI,
        tasks=tasks,
        dependencies=list(deps),
        **kw,  # type: ignore[arg-type]
    )


def _chain(n: int, points: float) -> Project:
    tasks = [_story(f"s{i}", points) for i in range(n)]
    deps = [Dependency(predecessor_id=f"s{i}", successor_id=f"s{i + 1}") for i in range(n - 1)]
    return _project(tasks, deps)


# --- #5011: one capacity, fractional sprints ---------------------------------------


@pytest.mark.parametrize(
    ("points", "p50"),
    [
        # 20 points at 20 a sprint is one 10-working-day sprint, not ten.
        pytest.param(2, date(2026, 1, 16), id="10x2-one-sprint"),
        # 30 points is a sprint and a half: 15 working days.
        pytest.param(3, date(2026, 1, 23), id="10x3-fifteen-days"),
    ],
)
def test_sequential_small_stories_add_up_to_the_backlog(points: int, p50: date) -> None:
    result = monte_carlo(_chain(10, points), runs=100, seed=1)
    assert result.p50 == result.p95 == p50
    assert result.velocity_saturated_runs == 0


def test_parallel_stories_compete_for_the_same_capacity() -> None:
    # Five 20-point stories at 20 a sprint need five sprints of capacity, not one.
    result = monte_carlo(_project([_story(f"s{i}", 20) for i in range(5)]), runs=100, seed=1)
    assert result.p50 == result.p95 == date(2026, 3, 13)


def test_capacity_before_a_story_is_ready_is_not_spent_on_it() -> None:
    # A 10-day waterfall phase, then two 10-point stories (one sprint between them):
    # the stories start after the phase, so the finish is 20 working days, not 10.
    design = Task(id="d", name="design", duration=timedelta(days=10))
    stories = [_story("a", 10), _story("b", 10)]
    deps = [Dependency("d", "a"), Dependency("d", "b")]
    result = monte_carlo(_project([design, *stories], deps), runs=50, seed=1)
    assert result.p50 == result.p95 == date(2026, 1, 30)


def test_the_cpm_duration_stays_a_floor() -> None:
    # One point is a twentieth of a sprint; the 3-day plan still binds (#3765).
    project = _project([_story("s", 1, duration=timedelta(days=3))])
    assert monte_carlo(project, runs=50, seed=1).p50 == schedule(project).project_finish


def test_a_bad_sprint_hits_every_story_in_the_run() -> None:
    # Correlated draws: with one shared vector the band of five parallel stories is
    # the band of their 100-point total, so P95 sits past P50.
    project = _project([_story(f"s{i}", 20) for i in range(5)], velocity_samples=[10, 20, 30])
    result = monte_carlo(project, runs=2000, seed=7)
    assert result.p95 > result.p50


def test_seeded_results_do_not_depend_on_the_chunk_size(monkeypatch: pytest.MonkeyPatch) -> None:
    project = _project(
        [_story(f"s{i}", 7 + i) for i in range(6)]
        + [Task(id="w", name="w", duration=timedelta(days=4))],
        [Dependency("s0", "s3"), Dependency("w", "s4")],
        velocity_samples=[5, 12, 20, 31],
    )
    whole = monte_carlo(project, runs=3000, seed=11)
    again = monte_carlo(project, runs=3000, seed=11)
    # A tiny cell budget forces one draw block per forward-pass chunk.
    monkeypatch.setattr(mc_run, "_VELOCITY_CHUNK_CELLS", 1)
    chunked = monte_carlo(project, runs=3000, seed=11)
    assert whole.distribution == again.distribution == chunked.distribution
    assert whole.percentiles == chunked.percentiles


# --- #5012: progress is measured in remaining points --------------------------------


def _in_progress(pct: float, status: date | None) -> Project:
    task = _story(
        "s",
        21,
        duration=timedelta(days=10),
        percent_complete=pct,
        actual_start=START if pct else None,
    )
    return _project([task], status_date=status)


def test_issue_rows_are_non_increasing_and_99_percent_is_within_a_sprint() -> None:
    p50s = []
    for pct in (0, 50, 99):
        status = START + timedelta(days=int(10 * pct / 100 * 7 / 5)) if pct else None
        result = monte_carlo(_in_progress(float(pct), status), runs=200, seed=1)
        p50s.append(result.p50)
        if pct == 99:
            # 0.21 points left: at most one sprint (two weeks) past the data date.
            assert status is not None and result.p95 <= status + timedelta(days=14)
    assert p50s == sorted(p50s, reverse=True)


def test_progress_at_a_fixed_data_date_shortens_the_forecast() -> None:
    status = date(2026, 1, 12)
    p50s = [
        monte_carlo(_in_progress(pct, status), runs=200, seed=1).p50
        for pct in (1.0, 25.0, 50.0, 75.0, 99.0)
    ]
    assert p50s == sorted(p50s, reverse=True)
    assert p50s[2] < p50s[0]  # 50% no longer forecasts what 0-ish% does


# --- #5013: no silent fallback -------------------------------------------------------


@pytest.mark.parametrize(
    ("kw", "reasons"),
    [
        (
            dict(velocity_samples=[18, 22, 15, 24, 19], sprint_length_days=None),
            ("sprint_length_days_missing",),
        ),
        (dict(velocity_samples=[0, 0, 0]), ("velocity_history_unusable",)),
        (dict(velocity_samples=[None]), ("velocity_history_unusable",)),
        (dict(velocity_samples=[18, 22, 15, 24, 19]), ()),
        (dict(velocity_samples=None), ()),
    ],
)
def test_fallback_reasons_say_why_the_history_was_not_used(
    kw: dict[str, object], reasons: tuple[str, ...]
) -> None:
    project = _project([_story("s", 21, duration=timedelta(days=10))], **kw)
    result = monte_carlo(project, runs=200, seed=1)
    assert result.velocity_fallback_reasons == reasons
    assert result.to_dict()["velocity_fallback_reasons"] == list(reasons)
    if reasons:
        assert result.p50 == result.p95 == schedule(project).project_finish


def test_no_reason_without_a_story_that_would_read_the_history() -> None:
    plain = Task(id="w", name="w", duration=timedelta(days=5))
    result = monte_carlo(_project([plain], sprint_length_days=None), runs=10, seed=1)
    assert result.velocity_fallback_reasons == ()


@pytest.mark.parametrize("bad", [0, -3])
def test_a_non_positive_sprint_length_is_refused_everywhere(bad: int) -> None:
    project = _project([_story("s", 21)], sprint_length_days=bad)
    with pytest.raises(InvalidScheduleInput, match="positive integer"):
        schedule(project)
    with pytest.raises(InvalidScheduleInput, match="positive integer"):
        monte_carlo(project, runs=10, seed=1)
    data = _project([_story("s", 21)]).to_dict()
    data["sprint_length_days"] = bad
    with pytest.raises(InvalidScheduleInput, match="positive integer"):
        Project.from_dict(data)
