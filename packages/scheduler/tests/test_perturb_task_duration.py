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
from dataclasses import replace
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


# ---------------------------------------------------------------------------
# In-progress tasks: the offset applies to remaining work (#4432)
# ---------------------------------------------------------------------------


def _in_progress_chain(pert: tuple[int, int, int] | None = None) -> Project:
    """A (5d, 50% done, started before the data date) -FS-> B (3d); A is critical.

    ``elapsed = floor(5 * 0.5) = 2`` working days, so A has 3 remaining.
    """
    a = Task(
        id="A",
        name="A",
        duration=timedelta(days=5),
        percent_complete=50.0,
        actual_start=date(2027, 2, 24),
    )
    if pert is not None:
        a = replace(
            a,
            optimistic_duration=timedelta(days=pert[0]),
            most_likely_duration=timedelta(days=pert[1]),
            pessimistic_duration=timedelta(days=pert[2]),
        )
    return Project(
        id="p",
        name="P",
        start_date=date(2027, 3, 1),  # Monday
        status_date=date(2027, 3, 1),
        tasks=[a, Task(id="B", name="B", duration=timedelta(days=3))],
        dependencies=[Dependency("A", "B")],
        calendar=Calendar(),
    )


def _working_day_shift(base: date, moved: date) -> int:
    """Signed count of working days between two finishes on the default calendar."""
    cal = Calendar()
    lo, hi = min(base, moved), max(base, moved)
    days = sum(1 for i in range((hi - lo).days) if cal.is_working_day(lo + timedelta(days=i + 1)))
    return days if moved >= base else -days


def _elapsed_days(task: Task) -> int:
    return int(task.duration.days * min(task.percent_complete or 0.0, 100.0) / 100.0)


def test_a_one_day_slip_on_an_in_progress_critical_task_moves_the_finish_one_day() -> None:
    """The reported bug: ``duration`` 5 -> 6 at a held 50% grew the elapsed share
    from 2 to 3 days, so the remaining work — and the finish — did not move at all.
    A what-if answering "+1 day on the critical path costs nothing" is the failure
    ``perturb_task_duration`` exists to prevent."""
    baseline = _in_progress_chain()
    base = schedule(baseline)
    assert {t.id: t.is_critical for t in base.tasks}["A"]

    moved = schedule(perturb_task_duration(baseline, "A", 1)).project_finish
    assert _working_day_shift(base.project_finish, moved) == 1


@pytest.mark.parametrize("n", [1, 2, 3])
def test_slip_and_pull_in_are_mirror_images_on_an_in_progress_critical_task(n: int) -> None:
    """-N and +N move an unconstrained critical task's finish by equal and opposite
    working days. As shipped, -1 moved the finish -1 while +1 moved it 0."""
    baseline = _in_progress_chain()
    base = schedule(baseline).project_finish

    later = _working_day_shift(
        base, schedule(perturb_task_duration(baseline, "A", n)).project_finish
    )
    earlier = _working_day_shift(
        base, schedule(perturb_task_duration(baseline, "A", -n)).project_finish
    )
    assert later == n
    assert earlier == -n


@pytest.mark.parametrize("duration_days", [1, 3, 5, 7, 10, 13, 29])
@pytest.mark.parametrize("pct", [0.5, 10.0, 33.3, 50.0, 66.7, 99.0, 99.9])
@pytest.mark.parametrize("delta", [-5, -1, 1, 4, 17])
def test_elapsed_working_days_are_held_constant(duration_days: int, pct: float, delta: int) -> None:
    """The mechanism, swept: whatever the shift, ``floor(duration * pct)`` on the
    perturbed task equals the baseline's, and remaining work moves by exactly
    ``delta`` (floored at zero). Float rounding in the rescaled percentage must
    never truncate one elapsed day short."""
    task = Task(id="A", name="A", duration=timedelta(days=duration_days), percent_complete=pct)
    baseline = _project(task)
    target = next(t for t in perturb_task_duration(baseline, "A", delta).tasks if t.id == "A")

    elapsed = _elapsed_days(task)
    remaining = duration_days - elapsed
    new_remaining = max(0, remaining + delta)
    assert target.duration == timedelta(days=elapsed + new_remaining)
    if new_remaining == 0:
        # Every remaining day pulled in: the task is done, not in progress at 0 left.
        assert target.percent_complete == 100.0
    else:
        assert 0 < (target.percent_complete or 0.0) < 100.0
        assert _elapsed_days(target) == elapsed


def test_a_zero_delta_leaves_an_in_progress_task_unchanged() -> None:
    baseline = _in_progress_chain()
    target = next(t for t in perturb_task_duration(baseline, "A", 0).tasks if t.id == "A")

    assert target.duration == timedelta(days=5)
    assert target.percent_complete == 50.0


def test_pulling_in_all_remaining_work_completes_the_task() -> None:
    """Work already done cannot be un-done by a what-if: the duration floors at the
    elapsed days, not at zero, and a task with nothing left is complete."""
    baseline = _in_progress_chain()
    target = next(t for t in perturb_task_duration(baseline, "A", -50).tasks if t.id == "A")

    assert target.duration == timedelta(days=2)
    assert target.percent_complete == 100.0
    # Pinned to finish the working day before its remaining work would have started
    # (Friday before the Monday data date), not laid out from its actual start.
    assert target.actual_finish == date(2027, 2, 26)


# actual_start 2027-02-24 leaves 3 working days before the data date; 2027-02-26
# leaves one, fewer than either shape's elapsed days, so laying the full elapsed
# duration out from it would land past the data date.
@pytest.mark.parametrize(
    "actual_start", [date(2027, 2, 24), date(2027, 2, 26), None], ids=["early", "late", "none"]
)
@pytest.mark.parametrize("status_date", [date(2027, 3, 1), None], ids=["data-date", "no-data-date"])
@pytest.mark.parametrize(
    ("duration_days", "pct"),
    [(10, 99.0), (5, 50.0), (7, 33.3), (5, 10.0)],
    ids=["10d@99", "5d@50", "7d@33", "5d@10-zero-elapsed"],
)
@pytest.mark.parametrize("overshoot", [0, 50])
def test_an_exhausting_pull_in_moves_the_finish_earlier_by_exactly_the_remaining_days(
    actual_start: date | None,
    status_date: date | None,
    duration_days: int,
    pct: float,
    overshoot: int,
) -> None:
    """Pulling in all remaining work (or more) on a critical task moves the finish
    earlier by the remaining working days — never later. A bare 100% with no
    ``actual_finish`` was laid out at full duration from ``actual_start`` or the
    project start: a 10-day task at 99% pulled in by one day moved the finish
    +5 working days with an actual start and +8 without one."""
    a = Task(
        id="A",
        name="A",
        duration=timedelta(days=duration_days),
        percent_complete=pct,
        actual_start=actual_start,
    )
    baseline = Project(
        id="p",
        name="P",
        start_date=date(2027, 3, 1),
        status_date=status_date,
        tasks=[a, Task(id="B", name="B", duration=timedelta(days=3))],
        dependencies=[Dependency("A", "B")],
        calendar=Calendar(),
    )
    remaining = duration_days - _elapsed_days(a)
    base = schedule(baseline).project_finish
    perturbed = perturb_task_duration(baseline, "A", -remaining - overshoot)

    assert _working_day_shift(base, schedule(perturbed).project_finish) == -remaining
    # Monte Carlo agrees: the task is deterministic, so P50 moves with the CPM finish.
    b50 = monte_carlo(baseline, runs=50, seed=SEED).p50
    p50 = monte_carlo(perturbed, runs=50, seed=SEED).p50
    assert _working_day_shift(b50, p50) == -remaining


def test_in_progress_pert_bands_move_by_the_remaining_work_shift() -> None:
    """Monte Carlo subtracts the same constant elapsed count from every sampled
    PERT value, so with elapsed held the bands move with the CPM finish. Held
    ``percent_complete`` used to scale the elapsed subtraction with the shifted
    duration and shave the bands' movement too."""
    baseline = _in_progress_chain(pert=(5, 5, 11))
    perturbed = perturb_task_duration(baseline, "A", 4)
    target = next(t for t in perturbed.tasks if t.id == "A")
    assert target.optimistic_duration == timedelta(days=9)
    assert target.pessimistic_duration == timedelta(days=15)

    b = monte_carlo(baseline, runs=RUNS, seed=SEED)
    p = monte_carlo(perturbed, runs=RUNS, seed=SEED)
    for band in ("p50", "p80", "p95"):
        assert _working_day_shift(getattr(b, band), getattr(p, band)) == 4, band
