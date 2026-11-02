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
from itertools import pairwise

import pytest

from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
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


@pytest.mark.parametrize(
    "done",
    [
        {"actual_finish": date(2026, 1, 7)},
        {"percent_complete": 100.0},
        {"percent_complete": 100.0, "actual_finish": date(2026, 1, 7)},
    ],
    ids=["actual_finish", "percent_complete_100", "both"],
)
@pytest.mark.parametrize("delta", [-2, 0, 3])
def test_a_completed_task_is_refused_rather_than_a_silent_zero_impact_what_if(
    done: dict[str, object], delta: int
) -> None:
    """Completed work is pinned by its actuals, so shifting its duration moves neither
    CPM nor Monte Carlo; reporting that as "no impact" is the failure #4515 closes."""
    baseline = _project(replace(_deterministic_task(), **done))  # type: ignore[arg-type]
    with pytest.raises(InvalidScheduleInput, match="is complete"):
        perturb_task_duration(baseline, "A", delta)


def test_a_just_under_complete_task_is_still_perturbable() -> None:
    baseline = _project(replace(_deterministic_task(), percent_complete=99.0))
    perturbed = perturb_task_duration(baseline, "A", 1)
    assert next(t for t in perturbed.tasks if t.id == "A").duration > timedelta(days=0)


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
    """The mechanism, swept: while any work remains, ``floor(duration * pct)`` on the
    perturbed task equals the baseline's and remaining work moves by exactly ``delta``.
    Float rounding in the rescaled percentage must never truncate one elapsed day
    short. Once none remains the task is open at zero duration."""
    task = Task(id="A", name="A", duration=timedelta(days=duration_days), percent_complete=pct)
    baseline = _project(task)
    target = next(t for t in perturb_task_duration(baseline, "A", delta).tasks if t.id == "A")

    elapsed = _elapsed_days(task)
    remaining = duration_days - elapsed
    new_remaining = max(0, remaining + delta)
    if new_remaining == 0:
        # Zero duration is how an open task says it has nothing left. Elapsed days are
        # read off ``duration``, so they read zero here, and no recorded fact changes.
        assert target.duration == timedelta(0)
        assert target.percent_complete == pct
        assert target.actual_finish is None
    else:
        assert target.duration == timedelta(days=elapsed + new_remaining)
        assert 0 < (target.percent_complete or 0.0) < 100.0
        assert _elapsed_days(target) == elapsed


def test_a_zero_delta_leaves_an_in_progress_task_unchanged() -> None:
    baseline = _in_progress_chain()
    target = next(t for t in perturb_task_duration(baseline, "A", 0).tasks if t.id == "A")

    assert target.duration == timedelta(days=5)
    assert target.percent_complete == 50.0


def test_pulling_in_all_remaining_work_leaves_the_task_open() -> None:
    """The what-if has no evidence about history, so it records none: the task has no
    work left, and its percentage and actual start still say what they said."""
    baseline = _in_progress_chain()
    target = next(t for t in perturb_task_duration(baseline, "A", -50).tasks if t.id == "A")

    assert target.duration == timedelta(0)
    assert target.percent_complete == 50.0
    assert target.actual_start == date(2027, 2, 24)
    assert target.actual_finish is None


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
    earlier by the remaining working days — never later, wherever ``actual_start``
    falls and whatever the elapsed days."""
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


# ---------------------------------------------------------------------------
# Zero remaining work is not completion: milestones and the zero-delta identity
# ---------------------------------------------------------------------------

_STARTED = date(2027, 3, 5)
_DATA_DATE = date(2027, 3, 8)

_MILESTONE_STATES = [
    pytest.param({}, id="not-started"),
    pytest.param({"actual_start": _STARTED}, id="actual-start-only"),
    pytest.param({"percent_complete": 50.0}, id="percent-only"),
    pytest.param({"actual_start": _STARTED, "percent_complete": 50.0}, id="started-at-50"),
]


def _milestone_chain(
    duration_days: int = 0,
    status_date: date | None = _DATA_DATE,
    **fields: object,
) -> Project:
    """Open predecessor -FS-> target M -FS-> successor, with M on the critical path.

    The defaults make M a milestone: the baseline finish depends on M being open, so a
    fabricated ``actual_finish`` shows up in the finish and in the critical path.
    """
    return Project(
        id="p",
        name="P",
        start_date=date(2027, 3, 1),  # Monday
        status_date=status_date,
        tasks=[
            Task(
                id="P",
                name="P",
                duration=timedelta(days=5),
                actual_start=date(2027, 3, 1),
                percent_complete=20.0,
            ),
            Task(id="M", name="M", duration=timedelta(days=duration_days), **fields),  # type: ignore[arg-type]
            Task(id="S", name="S", duration=timedelta(days=3)),
        ],
        dependencies=[Dependency("P", "M"), Dependency("M", "S")],
        calendar=Calendar(),
    )


def _milestone_of(project: Project) -> Task:
    return next(t for t in project.tasks if t.id == "M")


@pytest.mark.parametrize("status_date", [_DATA_DATE, None], ids=["data-date", "no-data-date"])
@pytest.mark.parametrize("fields", _MILESTONE_STATES)
@pytest.mark.parametrize("delta", [0, -1, -3, -500])
def test_a_non_positive_delta_on_a_milestone_changes_nothing(
    delta: int, fields: dict[str, object], status_date: date | None
) -> None:
    """A milestone has no days a pull-in could consume, so its zero remaining work is
    not evidence of completion. As shipped, a percentage on it took the exhausting
    branch: ``actual_finish`` appeared, the finish moved two working days earlier, and
    its predecessor and the milestone itself left the critical path."""
    baseline = _milestone_chain(status_date=status_date, **fields)
    perturbed = perturb_task_duration(baseline, "M", delta)

    assert perturbed.tasks == baseline.tasks
    base = schedule(baseline)
    moved = schedule(perturbed)
    assert moved.project_finish == base.project_finish
    assert moved.critical_path == base.critical_path


@pytest.mark.parametrize("status_date", [_DATA_DATE, None], ids=["data-date", "no-data-date"])
@pytest.mark.parametrize("fields", _MILESTONE_STATES)
@pytest.mark.parametrize("delta", [1, 2, 3, 7, 1000])
def test_a_slip_on_a_started_milestone_reads_like_one_on_an_unstarted_milestone(
    delta: int, fields: dict[str, object], status_date: date | None
) -> None:
    """A slip creates work and leaves the task open: nothing is completed, its recorded
    start survives, none of the created days count as already done (a held percentage
    would floor some of them into elapsed work), and starting the milestone has no
    effect on how far the finish moves."""
    baseline = _milestone_chain(status_date=status_date, **fields)
    perturbed = perturb_task_duration(baseline, "M", delta)
    target = _milestone_of(perturbed)

    assert target.duration == timedelta(days=delta)
    assert target.actual_finish is None
    assert target.actual_start == fields.get("actual_start")
    assert (target.percent_complete or 0.0) < 100.0
    assert _elapsed_days(target) == 0

    unstarted = _milestone_chain(status_date=status_date)
    assert _working_day_shift(
        schedule(baseline).project_finish, schedule(perturbed).project_finish
    ) == _working_day_shift(
        schedule(unstarted).project_finish,
        schedule(perturb_task_duration(unstarted, "M", delta)).project_finish,
    )


@pytest.mark.parametrize("fields", _MILESTONE_STATES)
@pytest.mark.parametrize("delta", [1, 3])
def test_a_slip_on_a_critical_milestone_moves_the_finish_by_the_delta(
    delta: int, fields: dict[str, object]
) -> None:
    """The promise the function exists for still holds on a milestone."""
    baseline = _milestone_chain(**fields)
    base = schedule(baseline)
    assert "M" in base.critical_path

    moved = schedule(perturb_task_duration(baseline, "M", delta)).project_finish
    assert _working_day_shift(base.project_finish, moved) == delta


@pytest.mark.parametrize("delta", [-3, 0])
def test_monte_carlo_agrees_a_started_milestone_was_not_completed(delta: int) -> None:
    """Both passes read the same fields, so a fabricated actual would move the bands
    as well as the CPM finish."""
    baseline = _milestone_chain(actual_start=_STARTED, percent_complete=50.0)
    perturbed = perturb_task_duration(baseline, "M", delta)

    base = monte_carlo(baseline, runs=50, seed=SEED)
    moved = monte_carlo(perturbed, runs=50, seed=SEED)
    assert (moved.p50, moved.p80, moved.p95) == (base.p50, base.p80, base.p95)


def test_pert_legs_on_a_started_milestone_still_shift_without_completing_it() -> None:
    """A what-if on a milestone with an estimate still reaches the input the sampler
    reads, floored at zero, and only that input changes."""
    baseline = _milestone_chain(
        actual_start=_STARTED,
        percent_complete=50.0,
        optimistic_duration=timedelta(days=1),
        most_likely_duration=timedelta(days=2),
        pessimistic_duration=timedelta(days=4),
    )
    target = _milestone_of(perturb_task_duration(baseline, "M", -2))

    assert target.duration == timedelta(0)
    assert target.percent_complete == 50.0
    assert target.actual_finish is None
    assert target.optimistic_duration == timedelta(0)
    assert target.most_likely_duration == timedelta(0)
    assert target.pessimistic_duration == timedelta(days=2)


@pytest.mark.parametrize("status_date", [_DATA_DATE, None], ids=["data-date", "no-data-date"])
@pytest.mark.parametrize(
    ("duration_days", "fields"),
    [
        pytest.param(0, {}, id="milestone-not-started"),
        pytest.param(0, {"actual_start": _STARTED}, id="milestone-actual-start"),
        pytest.param(0, {"percent_complete": 50.0}, id="milestone-percent"),
        pytest.param(
            0, {"actual_start": _STARTED, "percent_complete": 99.0}, id="milestone-started"
        ),
        pytest.param(5, {}, id="work-not-started"),
        pytest.param(5, {"actual_start": _STARTED}, id="work-actual-start"),
        pytest.param(5, {"percent_complete": 50.0}, id="work-percent"),
        pytest.param(5, {"actual_start": _STARTED, "percent_complete": 50.0}, id="work-started"),
        pytest.param(7, {"actual_start": _STARTED, "percent_complete": 33.3}, id="work-rounding"),
        pytest.param(10, {"actual_start": _STARTED, "percent_complete": 99.9}, id="work-last-day"),
    ],
)
def test_a_zero_delta_is_an_exact_identity_for_every_task_kind(
    duration_days: int, fields: dict[str, object], status_date: date | None
) -> None:
    """Comparing the tasks themselves, rather than only the finish, catches a change
    that happens not to bind on this network."""
    baseline = _milestone_chain(duration_days, status_date, **fields)
    perturbed = perturb_task_duration(baseline, "M", 0)

    assert perturbed.tasks == baseline.tasks
    assert schedule(perturbed).to_dict() == schedule(baseline).to_dict()


def test_a_zero_delta_keeps_a_fractional_duration() -> None:
    """``schedule`` refuses a sub-day duration, so this input cannot go through the
    identity sweep above. The shift path rebuilds a duration from ``.days``, which would
    turn 2d4h into a valid 2d and hide the bad input from the later refusal."""
    fractional = timedelta(days=2, hours=4)
    baseline = _milestone_chain(actual_start=_STARTED, percent_complete=50.0)
    baseline = replace(
        baseline,
        tasks=[replace(t, duration=fractional) if t.id == "M" else t for t in baseline.tasks],
    )
    perturbed = perturb_task_duration(baseline, "M", 0)

    assert perturbed.tasks == baseline.tasks
    assert _milestone_of(perturbed).duration == fractional


def test_a_zero_delta_still_returns_a_new_project_and_task_list() -> None:
    baseline = _milestone_chain(actual_start=_STARTED, percent_complete=50.0)
    perturbed = perturb_task_duration(baseline, "M", 0)

    assert perturbed is not baseline
    assert perturbed.tasks is not baseline.tasks
    perturbed.tasks.clear()
    assert len(baseline.tasks) == 3


@pytest.mark.parametrize(
    ("project", "task_id", "delta"),
    [
        pytest.param("not a project", "M", 0, id="project-not-a-project"),
        pytest.param(_milestone_chain(), "nope", 0, id="unknown-task"),
        pytest.param(_milestone_chain(), "M", False, id="delta-false"),
        pytest.param(_milestone_chain(percent_complete=100.0), "M", 0, id="complete-percent"),
        pytest.param(
            _milestone_chain(actual_finish=date(2027, 3, 5)), "M", 0, id="complete-actual-finish"
        ),
    ],
)
def test_a_zero_delta_is_refused_wherever_any_other_delta_is(
    project: object, task_id: str, delta: int
) -> None:
    """The zero-delta return sits after the refusals. Before them it would hand back an
    unperturbed project for an unknown id or a completed task, which reads as a
    zero-impact what-if."""
    with pytest.raises(InvalidScheduleInput):
        perturb_task_duration(project, task_id, delta)  # type: ignore[arg-type]


@pytest.mark.parametrize("fields", [{}, {"actual_start": _STARTED}], ids=["unstarted", "started"])
@pytest.mark.parametrize("delta", [-5, -9])
def test_an_exhausting_pull_in_without_a_percentage_leaves_the_task_open(
    delta: int, fields: dict[str, object]
) -> None:
    """Without a percentage the duration floors at zero the same way, so the open form
    does not depend on whether progress was ever reported."""
    baseline = _milestone_chain(5, **fields)
    target = _milestone_of(perturb_task_duration(baseline, "M", delta))

    assert target.duration == timedelta(0)
    assert not target.percent_complete
    assert target.actual_finish is None
    assert target.actual_start == fields.get("actual_start")


# ---------------------------------------------------------------------------
# An exhausting pull-in behind an open predecessor stays coupled to it
# ---------------------------------------------------------------------------

_EXHAUSTING_SHAPES = [
    pytest.param(5, {"percent_complete": 10.0}, id="5d@10-zero-elapsed"),
    pytest.param(1, {"percent_complete": 50.0}, id="1d@50-zero-elapsed"),
    pytest.param(
        5, {"percent_complete": 10.0, "actual_start": _STARTED}, id="5d@10-zero-elapsed-started"
    ),
    pytest.param(5, {"percent_complete": 40.0}, id="5d@40-elapsed"),
    pytest.param(5, {"percent_complete": 40.0, "actual_start": _STARTED}, id="5d@40-started"),
    pytest.param(10, {"percent_complete": 99.0, "actual_start": _STARTED}, id="10d@99-started"),
    pytest.param(5, {"actual_start": _STARTED}, id="5d-no-percentage-started"),
]


def _remaining_days(task: Task) -> int:
    return task.duration.days - _elapsed_days(task)


def _risky_predecessor(project: Project) -> Project:
    """P gets a wide estimate, so its risk reaches the bands only through M."""
    return replace(
        project,
        tasks=[
            replace(
                t,
                optimistic_duration=timedelta(days=3),
                most_likely_duration=timedelta(days=5),
                pessimistic_duration=timedelta(days=25),
            )
            if t.id == "P"
            else t
            for t in project.tasks
        ],
    )


@pytest.mark.parametrize("status_date", [_DATA_DATE, None], ids=["data-date", "no-data-date"])
@pytest.mark.parametrize(("duration_days", "fields"), _EXHAUSTING_SHAPES)
@pytest.mark.parametrize("overshoot", [0, 7])
def test_an_exhausting_pull_in_keeps_the_task_on_its_open_predecessors_path(
    overshoot: int, duration_days: int, fields: dict[str, object], status_date: date | None
) -> None:
    """Completing the task would pin it at invented actuals and detach it from P: the
    critical path fell to S alone, and a later slip of P no longer reached S."""
    baseline = _milestone_chain(duration_days, status_date, **fields)
    remaining = _remaining_days(_milestone_of(baseline))
    base = schedule(baseline)
    perturbed = perturb_task_duration(baseline, "M", -remaining - overshoot)
    target = _milestone_of(perturbed)
    moved = schedule(perturbed)

    assert target.duration == timedelta(0)
    assert target.actual_finish is None
    assert target.actual_start == fields.get("actual_start")
    assert target.percent_complete == fields.get("percent_complete", target.percent_complete)

    assert _working_day_shift(base.project_finish, moved.project_finish) == -remaining
    assert moved.critical_path == base.critical_path
    assert "P" in moved.critical_path

    slipped = schedule(perturb_task_duration(perturbed, "P", 10)).project_finish
    assert _working_day_shift(moved.project_finish, slipped) == 10


@pytest.mark.parametrize("status_date", [_DATA_DATE, None], ids=["data-date", "no-data-date"])
@pytest.mark.parametrize(("duration_days", "fields"), _EXHAUSTING_SHAPES)
def test_monte_carlo_agrees_with_cpm_on_the_open_zero_duration_task(
    duration_days: int, fields: dict[str, object], status_date: date | None
) -> None:
    """With no estimate anywhere every percentile equals the deterministic finish, so
    the two passes read the open zero-duration task the same way."""
    baseline = _milestone_chain(duration_days, status_date, **fields)
    remaining = _remaining_days(_milestone_of(baseline))
    perturbed = perturb_task_duration(baseline, "M", -remaining)

    finish = schedule(perturbed).project_finish
    result = monte_carlo(perturbed, runs=50, seed=SEED)
    assert (result.p50, result.p80, result.p95) == (finish, finish, finish)


@pytest.mark.parametrize(("duration_days", "fields"), _EXHAUSTING_SHAPES)
def test_an_open_predecessors_risk_stays_in_the_bands(
    duration_days: int, fields: dict[str, object]
) -> None:
    """Every band moves by the days pulled in and no further. Completing the task cut
    P's estimate out of the simulation: P80 moved 4 working days on a 1-day CPM pull-in."""
    baseline = _risky_predecessor(_milestone_chain(duration_days, **fields))
    remaining = _remaining_days(_milestone_of(baseline))
    perturbed = perturb_task_duration(baseline, "M", -remaining)

    base = monte_carlo(baseline, runs=RUNS, seed=SEED)
    moved = monte_carlo(perturbed, runs=RUNS, seed=SEED)
    for band in ("p50", "p80", "p95"):
        assert _working_day_shift(getattr(base, band), getattr(moved, band)) == -remaining, band


def test_the_last_day_of_a_pull_in_moves_a_risky_tasks_bands_by_one_day() -> None:
    """Monte Carlo subtracts elapsed days off ``duration``, so that subtraction ends at
    zero duration and the estimate has to absorb them. Otherwise the step from one
    remaining day to none would add the two elapsed days back to the sampled work."""
    baseline = _milestone_chain(
        5,
        actual_start=_STARTED,
        percent_complete=40.0,
        optimistic_duration=timedelta(days=5),
        most_likely_duration=timedelta(days=5),
        pessimistic_duration=timedelta(days=11),
    )
    one_left = perturb_task_duration(baseline, "M", -2)
    none_left = perturb_task_duration(baseline, "M", -3)

    target = _milestone_of(none_left)
    assert target.optimistic_duration == timedelta(0)
    assert target.most_likely_duration == timedelta(0)
    assert target.pessimistic_duration == timedelta(days=6)

    before = monte_carlo(one_left, runs=RUNS, seed=SEED)
    after = monte_carlo(none_left, runs=RUNS, seed=SEED)
    for band in ("p50", "p80", "p95"):
        assert _working_day_shift(getattr(before, band), getattr(after, band)) == -1, band


def _velocity_chain(duration_days: int, pct: float, points: float) -> Project:
    return replace(
        _milestone_chain(
            duration_days,
            percent_complete=pct,
            delivery_mode=DeliveryMode.SCRUM,
            story_points=points,
        ),
        velocity_samples=VELOCITY_SAMPLES,
        sprint_length_days=SPRINT_LENGTH_DAYS,
    )


def test_an_exhausted_velocity_task_converts_its_elapsed_days_to_points() -> None:
    """The input only: 10d at 40% has 4 elapsed days, so a 6-day pull-in is 10 days of
    points at 2 per day. Where the bands land is a separate question."""
    perturbed = perturb_task_duration(_velocity_chain(10, 40.0, 40.0), "M", -6)
    target = _milestone_of(perturbed)

    assert target.story_points == pytest.approx(20.0)
    assert target.duration == timedelta(0)
    assert target.actual_finish is None


@pytest.mark.xfail(strict=True, reason="#4820")
@pytest.mark.parametrize(
    ("duration_days", "pct", "points"),
    [
        pytest.param(10, 40.0, 40.0, id="10d@40-steps-backward"),
        pytest.param(5, 40.0, 30.0, id="5d@40-later-than-current"),
        pytest.param(3, 34.0, 20.0, id="3d@34-later-than-current"),
    ],
)
def test_a_growing_pull_in_never_moves_a_velocity_band_later(
    duration_days: int, pct: float, points: float
) -> None:
    """The correct behavior, not the current one: from the unperturbed forecast onward,
    each bigger pull-in leaves every band where it was or earlier."""
    baseline = _velocity_chain(duration_days, pct, points)
    forecasts = [monte_carlo(baseline, runs=RUNS, seed=SEED)] + [
        monte_carlo(perturb_task_duration(baseline, "M", delta), runs=RUNS, seed=SEED)
        for delta in (-1, -2, -3, -4, -5, -6, -9)
    ]
    for smaller, bigger in pairwise(forecasts):
        assert bigger.p50 <= smaller.p50
        assert bigger.p80 <= smaller.p80
        assert bigger.p95 <= smaller.p95


def test_past_exhaustion_cpm_stops_moving_while_a_risky_tasks_bands_do_not_get_later() -> None:
    """Remaining work has a floor and an estimate's upper leg does not reach it as soon:
    the CPM finish clamps at the remaining days, and the bands may keep tightening."""
    baseline = _milestone_chain(
        5,
        actual_start=_STARTED,
        percent_complete=40.0,
        optimistic_duration=timedelta(days=5),
        most_likely_duration=timedelta(days=5),
        pessimistic_duration=timedelta(days=11),
    )
    exhausted = perturb_task_duration(baseline, "M", -3)
    further = perturb_task_duration(baseline, "M", -9)

    assert schedule(further).project_finish == schedule(exhausted).project_finish
    at_exhaustion = monte_carlo(exhausted, runs=RUNS, seed=SEED)
    past_exhaustion = monte_carlo(further, runs=RUNS, seed=SEED)
    assert past_exhaustion.p50 <= at_exhaustion.p50
    assert past_exhaustion.p80 <= at_exhaustion.p80
    assert past_exhaustion.p95 <= at_exhaustion.p95
    assert past_exhaustion.p95 < at_exhaustion.p95


@pytest.mark.parametrize(
    ("duration_days", "fields"),
    [
        pytest.param(0, {"percent_complete": 50.0, "actual_start": _STARTED}, id="milestone"),
        pytest.param(5, {"percent_complete": 10.0}, id="work-zero-elapsed"),
        pytest.param(5, {"percent_complete": 40.0, "actual_start": _STARTED}, id="work-elapsed"),
    ],
)
@pytest.mark.parametrize("amount", [1, 3, 8])
def test_a_slip_then_its_pull_in_returns_to_the_baseline_forecast(
    amount: int, duration_days: int, fields: dict[str, object]
) -> None:
    """The second shift must not read the first one's created days as work to complete:
    on a started milestone, +a then -a used to end with a fabricated ``actual_finish``."""
    baseline = _milestone_chain(duration_days, **fields)
    there_and_back = perturb_task_duration(
        perturb_task_duration(baseline, "M", amount), "M", -amount
    )

    assert _milestone_of(there_and_back).actual_finish is None
    base = schedule(baseline)
    moved = schedule(there_and_back)
    assert moved.project_finish == base.project_finish
    assert moved.critical_path == base.critical_path


def test_a_pull_in_to_nothing_then_a_slip_restores_the_remaining_work() -> None:
    """Elapsed days cannot be read back off zero duration, but they were never part of
    the forecast: what comes back is the remaining work, so the finish returns too."""
    baseline = _milestone_chain(5, actual_start=_STARTED, percent_complete=40.0)
    back = perturb_task_duration(perturb_task_duration(baseline, "M", -3), "M", 3)

    assert _milestone_of(back).duration == timedelta(days=3)
    assert schedule(back).project_finish == schedule(baseline).project_finish


# ---------------------------------------------------------------------------
# Link types other than finish-to-start
# ---------------------------------------------------------------------------


def _chain_with_link_out(
    link: DependencyType,
    lag_days: int = 0,
    duration_days: int = 5,
    status_date: date | None = _DATA_DATE,
    **fields: object,
) -> Project:
    """The same chain with the link from M to S replaced."""
    baseline = _milestone_chain(duration_days, status_date, **fields)
    return replace(
        baseline,
        dependencies=[
            Dependency("P", "M"),
            Dependency("M", "S", link, timedelta(days=lag_days)),
        ],
    )


_EXHAUSTIBLE_FIELDS = [
    pytest.param({"percent_complete": 40.0, "actual_start": _STARTED}, id="40-started"),
    pytest.param({"percent_complete": 40.0}, id="40"),
    pytest.param({"percent_complete": 10.0}, id="10-zero-elapsed"),
    pytest.param({"actual_start": _STARTED}, id="no-percentage-started"),
    pytest.param({}, id="not-started"),
]


@pytest.mark.parametrize("fields", _EXHAUSTIBLE_FIELDS)
@pytest.mark.parametrize("delta", [-1, -2, -3, -4, -5, -9])
def test_a_pull_in_across_a_finish_to_finish_link_moves_the_finish_by_the_days_consumed(
    delta: int, fields: dict[str, object]
) -> None:
    """An FF link reads the finish, which zero duration still expresses, so the shift is
    the days consumed on either side of exhaustion, and P still reaches S."""
    baseline = _chain_with_link_out(DependencyType.FF, **fields)
    remaining = _remaining_days(_milestone_of(baseline))
    base = schedule(baseline).project_finish
    perturbed = perturb_task_duration(baseline, "M", delta)
    moved = schedule(perturbed).project_finish

    assert _working_day_shift(base, moved) == -min(remaining, -delta)
    assert _milestone_of(perturbed).actual_finish is None
    slipped = schedule(perturb_task_duration(perturbed, "P", 10)).project_finish
    assert _working_day_shift(moved, slipped) == 10


@pytest.mark.parametrize("fields", _EXHAUSTIBLE_FIELDS)
def test_without_a_data_date_a_recorded_start_can_hold_an_ff_pull_in_back(
    fields: dict[str, object],
) -> None:
    """With no data date the remaining work can begin at ``actual_start``, and the task
    is still floored there at zero duration, so the finish may move less than the days
    pulled in. It never moves later, and never before the recorded start."""
    baseline = _chain_with_link_out(DependencyType.FF, status_date=None, **fields)
    finishes = [schedule(baseline).project_finish] + [
        schedule(perturb_task_duration(baseline, "M", delta)).project_finish
        for delta in (-1, -2, -3, -4, -5, -9)
    ]
    for smaller, bigger in pairwise(finishes):
        assert bigger <= smaller
    recorded_start = fields.get("actual_start")
    if isinstance(recorded_start, date):
        assert finishes[-1] >= recorded_start


@pytest.mark.xfail(strict=True, reason="#4819")
@pytest.mark.parametrize(
    ("lag_days", "status_date", "fields"),
    [
        pytest.param(0, _DATA_DATE, {"percent_complete": 40.0, "actual_start": _STARTED}, id="ss0"),
        pytest.param(0, _DATA_DATE, {"percent_complete": 40.0}, id="ss0-no-recorded-start"),
        pytest.param(2, _DATA_DATE, {"percent_complete": 40.0, "actual_start": _STARTED}, id="ss2"),
        pytest.param(0, _DATA_DATE, {"actual_start": _STARTED}, id="ss0-no-percentage"),
    ],
)
def test_a_growing_pull_in_across_a_start_to_start_link_never_finishes_later(
    lag_days: int, status_date: date | None, fields: dict[str, object]
) -> None:
    """The correct behavior, not the current one: removing more work from M cannot move
    the finish later. At zero duration the link stops reading the recorded start."""
    baseline = _chain_with_link_out(DependencyType.SS, lag_days, 5, status_date, **fields)
    finishes = [schedule(baseline).project_finish] + [
        schedule(perturb_task_duration(baseline, "M", delta)).project_finish
        for delta in (-1, -2, -3, -4, -5, -9)
    ]
    for smaller, bigger in pairwise(finishes):
        assert bigger <= smaller
