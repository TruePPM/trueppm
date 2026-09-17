"""The what-if perturbation entry point: CPM and the MC bands move together (#3533).

``perturb_task_duration`` exists because a task's duration reaches the forecast
through three different inputs and the sampler picks between them by priority
(velocity → three-point PERT → deterministic). A caller shifting only the fields
it knows about moved the deterministic CPM finish while a velocity-sampled task's
P50/P80/P95 stayed exactly where they were — and the what-if endpoint reported
both, so the response disagreed with itself about whether the change happened.

The central test here is the invariant that would have caught it: for every
sampling branch, a perturbation moves the CPM finish **and** the bands, or moves
neither. It is parametrized over all three branches precisely because the shipped
bug was "two of the three branches covered".
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    InvalidScheduleInput,
    Project,
    Task,
    monte_carlo,
    perturb_task_duration,
    schedule,
)

SEED = 993_993
RUNS = 600

# A five-sprint history averaging 20 points per 10-working-day sprint — a mean
# pace of 2 points per working day, which is the factor the velocity branch's
# perturbation converts a day offset through.
VELOCITY_SAMPLES = [18.0, 22.0, 20.0, 25.0, 15.0]
SPRINT_LENGTH_DAYS = 10

TaskFactory = Callable[[], Task]


def _project(task: Task) -> Project:
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),  # Monday
        tasks=[task],
        calendar=Calendar(),
        velocity_samples=VELOCITY_SAMPLES,
        sprint_length_days=SPRINT_LENGTH_DAYS,
        status_date=date(2026, 1, 5),
    )


def _velocity_task() -> Task:
    """A scrum task whose sampled duration sits far above its deterministic one.

    Deliberately ``duration=1`` against ~20-40 sampled working days. The sampled
    column is floored at the task's deterministic duration, so a task whose
    duration sits close to its velocity draw would see its bands move on that floor
    alone even with ``story_points`` left untouched — the invariant would pass for
    the wrong reason and go on hiding the bug. Keeping the floor slack means this
    fixture can only move if the perturbation reaches the input the velocity branch
    actually reads.
    """
    return Task(
        id="A",
        name="A",
        duration=timedelta(days=1),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=40.0,
    )


def _long_velocity_task() -> Task:
    """The same shape with enough duration and committed points to absorb a pull-in.

    ``duration`` has to be long enough that a -10-day shift still leaves a positive
    deterministic duration (otherwise the CPM finish floors and stops moving), while
    staying well under the ~60 sampled working days so the floor remains slack.
    """
    return Task(
        id="A",
        name="A",
        duration=timedelta(days=30),
        delivery_mode=DeliveryMode.SCRUM,
        story_points=120.0,
    )


def _pert_task() -> Task:
    return Task(
        id="A",
        name="A",
        duration=timedelta(days=10),
        optimistic_duration=timedelta(days=8),
        most_likely_duration=timedelta(days=10),
        pessimistic_duration=timedelta(days=20),
    )


def _long_pert_task() -> Task:
    return Task(
        id="A",
        name="A",
        duration=timedelta(days=30),
        optimistic_duration=timedelta(days=28),
        most_likely_duration=timedelta(days=30),
        pessimistic_duration=timedelta(days=40),
    )


def _deterministic_task() -> Task:
    return Task(id="A", name="A", duration=timedelta(days=10))


def _long_deterministic_task() -> Task:
    return Task(id="A", name="A", duration=timedelta(days=30))


def _forecast(project: Project) -> tuple[date, date, date, date]:
    cpm = schedule(project)
    mc = monte_carlo(project, runs=RUNS, seed=SEED)
    return cpm.project_finish, mc.p50, mc.p80, mc.p95


def _deltas(baseline: Project, perturbed: Project) -> dict[str, int]:
    """Signed calendar-day shifts of the CPM finish and each band, in one mapping.

    Both forecasts share one seed, so an unmoved band is the absence of a
    perturbation rather than RNG noise happening to cancel.
    """
    b_cpm, b50, b80, b95 = _forecast(baseline)
    p_cpm, p50, p80, p95 = _forecast(perturbed)
    return {
        "cpm_finish": (p_cpm - b_cpm).days,
        "p50": (p50 - b50).days,
        "p80": (p80 - b80).days,
        "p95": (p95 - b95).days,
    }


_BRANCHES = [
    pytest.param(_velocity_task, id="velocity"),
    pytest.param(_pert_task, id="three-point-pert"),
    pytest.param(_deterministic_task, id="deterministic"),
]

_LONG_BRANCHES = [
    pytest.param(_long_velocity_task, id="velocity"),
    pytest.param(_long_pert_task, id="three-point-pert"),
    pytest.param(_long_deterministic_task, id="deterministic"),
]


# ---------------------------------------------------------------------------
# The invariant: CPM and the bands move together, or neither moves
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("make_task", _BRANCHES)
def test_a_slip_moves_the_cpm_finish_and_every_band_later(make_task: TaskFactory) -> None:
    """Whichever input the sampler reads, a +10-day slip reaches it.

    As shipped the velocity branch failed this: the CPM finish moved and the bands
    returned a zero delta, so the what-if reported "no schedule risk" about a
    change it had never applied to the sampler's input (#3533).
    """
    baseline = _project(make_task())
    perturbed = perturb_task_duration(baseline, "A", 10)

    deltas = _deltas(baseline, perturbed)
    assert deltas["cpm_finish"] > 0, deltas
    for band in ("p50", "p80", "p95"):
        assert deltas[band] > 0, f"{band} did not move with the CPM finish: {deltas}"


@pytest.mark.parametrize("make_task", _LONG_BRANCHES)
def test_a_pull_in_moves_the_cpm_finish_and_every_band_earlier(make_task: TaskFactory) -> None:
    """The negative direction moves together too.

    A what-if that only ever slipped later would hide the same disagreement on
    every ``new_duration`` that shrinks a task.
    """
    baseline = _project(make_task())
    perturbed = perturb_task_duration(baseline, "A", -10)

    deltas = _deltas(baseline, perturbed)
    assert deltas["cpm_finish"] < 0, deltas
    for band in ("p50", "p80", "p95"):
        assert deltas[band] < 0, f"{band} did not move with the CPM finish: {deltas}"


@pytest.mark.parametrize("make_task", _BRANCHES)
def test_a_zero_delta_moves_nothing(make_task: TaskFactory) -> None:
    """The other half of the invariant: no change, nothing moves."""
    baseline = _project(make_task())
    perturbed = perturb_task_duration(baseline, "A", 0)

    assert _deltas(baseline, perturbed) == {"cpm_finish": 0, "p50": 0, "p80": 0, "p95": 0}


def test_velocity_bands_move_without_the_duration_floor_doing_the_work() -> None:
    """Pin the mechanism, not just the outcome.

    Shifting ``duration`` alone drags the bands up once the sampled-column floor
    binds, which is enough to satisfy the invariant above on a task whose duration
    is close to its velocity draw. With the floor slack, the bands can only move if
    the perturbation reached ``story_points``.
    """
    baseline = _project(_velocity_task())
    perturbed = perturb_task_duration(baseline, "A", 10)
    target = next(t for t in perturbed.tasks if t.id == "A")

    # 10 working days at 2 points/day (mean 20 over a 10-day sprint) = +20 points.
    assert target.story_points == pytest.approx(60.0)
    # The floor is still nowhere near the sampled durations it would have to clamp.
    assert target.duration == timedelta(days=11)

    deltas = _deltas(baseline, perturbed)
    assert deltas["p50"] > 0, deltas
    assert deltas["p80"] > 0, deltas
    assert deltas["p95"] > 0, deltas


# ---------------------------------------------------------------------------
# Field-level behavior
# ---------------------------------------------------------------------------


def test_the_baseline_project_is_not_mutated() -> None:
    """The what-if runs both forecasts from one baseline, so an in-place edit would
    perturb the ``current`` column too and silently zero every reported delta."""
    baseline = _project(_velocity_task())
    perturb_task_duration(baseline, "A", 25)

    assert baseline.tasks[0].story_points == 40.0
    assert baseline.tasks[0].duration == timedelta(days=1)


def test_every_pert_leg_shifts_by_the_same_offset() -> None:
    """A common shift translates the sampled Beta exactly — its range and its
    normalized mean, which together set the shape parameters, are both invariant
    under it."""
    baseline = _project(_pert_task())
    target = next(t for t in perturb_task_duration(baseline, "A", 5).tasks if t.id == "A")

    assert target.duration == timedelta(days=15)
    assert target.optimistic_duration == timedelta(days=13)
    assert target.most_likely_duration == timedelta(days=15)
    assert target.pessimistic_duration == timedelta(days=25)


def test_durations_and_story_points_floor_at_zero() -> None:
    """A pull-in larger than the task never produces a negative duration or a
    negative backlog."""
    baseline = _project(_velocity_task())
    target = next(t for t in perturb_task_duration(baseline, "A", -500).tasks if t.id == "A")

    assert target.duration == timedelta(0)
    assert target.story_points == 0.0


def test_story_points_are_untouched_when_the_task_will_not_sample_from_velocity() -> None:
    """The conversion is gated on the sampler's own predicate. A waterfall task
    carrying points does not take the velocity branch, so shifting them would edit
    an input nothing reads."""
    baseline = _project(Task(id="A", name="A", duration=timedelta(days=10), story_points=40.0))
    target = next(t for t in perturb_task_duration(baseline, "A", 10).tasks if t.id == "A")

    assert target.story_points == 40.0
    assert target.duration == timedelta(days=20)


def test_a_scrum_task_without_project_velocity_signal_keeps_its_points() -> None:
    """No velocity series means the task falls through to PERT/deterministic, so the
    points are inert and there is no pace to convert a day offset through."""
    baseline = Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),
        tasks=[_velocity_task()],
        calendar=Calendar(),
    )
    target = next(t for t in perturb_task_duration(baseline, "A", 10).tasks if t.id == "A")

    assert target.story_points == 40.0
    assert target.duration == timedelta(days=11)


def test_other_tasks_pass_through_unchanged() -> None:
    baseline = Project(
        id="p",
        name="P",
        start_date=date(2026, 1, 5),
        tasks=[_deterministic_task(), Task(id="B", name="B", duration=timedelta(days=4))],
        calendar=Calendar(),
    )
    perturbed = perturb_task_duration(baseline, "A", 3)

    assert [t.id for t in perturbed.tasks] == ["A", "B"]
    assert next(t for t in perturbed.tasks if t.id == "B").duration == timedelta(days=4)


def test_an_unknown_task_id_is_refused_rather_than_silently_no_op() -> None:
    """Returning the project unperturbed would hand the caller a zero delta that
    reads as "this change has no impact" — the exact failure this entry point exists
    to make impossible."""
    baseline = _project(_deterministic_task())
    with pytest.raises(InvalidScheduleInput, match="not in project"):
        perturb_task_duration(baseline, "nope", 5)
