"""A floor-held milestone with no predecessor links from its earliest equivalent midnight.

#5094.

A start-of-day floor (an SNET, a data date, a recorded actual start) on a Monday
is the same working-time point as Saturday 00:00 and Sunday 00:00: they differ
only in the calendar days a lag out of the milestone counts from. A floor that
holds a milestone *with* a predecessor already linked from the earliest of those
midnights (#4690, #4883). One with no predecessor linked from the floor itself,
so a non-binding predecessor changed the successors, and pinning a milestone on
its shown late start moved the project finish: the late start is read from an
instant like Saturday 00:00 (the start of Monday), and the pin put it on Monday
00:00, a calendar day or a working day on a wider successor calendar later.

The independent witness is the slip oracle: hold every start-of-day milestone on
its shown late start (``planned_start``) and ``project_finish`` must not move. It
fails on the pre-fix engine for the 12 sweep cases in the issue and for 54 of the
start-of-day milestones the seeded zero-lag fuzz below reaches.
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
    SchedulerError,
    ScheduleResult,
    Task,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine.calendar_math import _next_working_day

_CALS = {
    "fourday": Calendar(working_days=0b0001111),
    "mondays": Calendar(working_days=0b0000001),
    "seven": Calendar(working_days=0b1111111),
}
_START = date(2026, 3, 2)


def _task(result: ScheduleResult, task_id: str) -> Task:
    return next(t for t in result.tasks if t.id == task_id)


def _join(
    t0_link: DependencyType = DependencyType.FS,
    t1_link: DependencyType = DependencyType.SS,
    join_calendar: str | None = "fourday",
    t0_complete: bool = True,
    t1_lag: int = 1,
    pin: date | None = None,
) -> Project:
    """The issue's shape: ``t0 -FS-> join``, ``t1 -SS+1d-> join``, ``join`` on a narrower week."""
    t0 = Task("t0", "t0", timedelta(days=35))
    if t0_complete:
        t0.percent_complete = 100.0
    return Project(
        "p",
        "p",
        _START,
        [
            t0,
            Task("t1", "t1", timedelta(0), planned_start=pin),
            Task("t2", "t2", timedelta(0)),
            Task("join", "join", timedelta(0), calendar_id=join_calendar),
        ],
        [
            Dependency("t0", "join", t0_link),
            Dependency("t1", "join", t1_link, timedelta(days=t1_lag)),
        ],
        Calendar(),
        calendars=dict(_CALS),
    )


def test_pinning_the_reported_milestone_on_its_late_start_keeps_the_finish() -> None:
    base = schedule(_join())
    t1 = _task(base, "t1")
    assert base.project_finish == date(2026, 4, 20)
    assert t1.late_start == date(2026, 4, 20)
    pinned = schedule(_join(pin=t1.late_start))
    assert _task(pinned, "t1").early_start == date(2026, 4, 20)
    # Linked from Sat 04-18 00:00, SS+1d puts join at Sun 04-19 00:00, shown at the
    # start of Monday. Before the fix it linked from Monday and join moved to Tuesday.
    assert pinned.project_finish == date(2026, 4, 20)
    # One working day past the late start does move it.
    later = schedule(_join(pin=_next_working_day(date(2026, 4, 21), Calendar())))
    assert later.project_finish > base.project_finish
    # Monte Carlo places the instant the same way.
    mc = monte_carlo(_join(pin=t1.late_start), runs=16, seed=1)
    assert mc.p50 == mc.p95 == pinned.project_finish


@pytest.mark.parametrize("t1_lag", [-1, 0, 1])
@pytest.mark.parametrize("t0_complete", [True, False])
@pytest.mark.parametrize("join_calendar", [None, *_CALS])
@pytest.mark.parametrize("t1_link", list(DependencyType))
@pytest.mark.parametrize("t0_link", list(DependencyType))
def test_slip_oracle_over_the_issue_sweep(
    t0_link: DependencyType,
    t1_link: DependencyType,
    join_calendar: str | None,
    t0_complete: bool,
    t1_lag: int,
) -> None:
    """The issue's 384 cases; 12 (t1 SS+1d, join on fourday or mondays) failed before."""
    args = (t0_link, t1_link, join_calendar, t0_complete, t1_lag)
    try:
        base = schedule(_join(*args))
    except SchedulerError:
        return
    pin = _task(base, "t1").late_start
    assert schedule(_join(*args, pin=pin)).project_finish == base.project_finish


def test_zero_lag_counterexample_on_a_wider_successor_calendar() -> None:
    """The #5094 comment's fuzz example: no lag at all, the pin a working day late.

    ``t0`` is a milestone on Monday-to-Thursday; its late instant is Fri 05-01
    00:00 (the close of Thursday), shown at the start of Monday 05-04. ``t2`` works
    Monday to Friday and reads that instant as the start of Friday, so linking
    from Monday 00:00 started it a working day late.
    """

    def build(pin: date | None = None) -> Project:
        return Project(
            "p",
            "p",
            _START,
            [
                Task("t0", "t0", timedelta(0), calendar_id="fourday", planned_start=pin),
                Task("t1", "t1", timedelta(days=12), calendar_id="mondays"),
                Task("t2", "t2", timedelta(days=12)),
            ],
            [
                Dependency("t0", "t1", DependencyType.FF),
                Dependency("t0", "t2", DependencyType.FS),
            ],
            Calendar(),
            calendars=dict(_CALS),
        )

    base = schedule(build())
    late = _task(base, "t0").late_start
    assert late == date(2026, 5, 4)
    assert base.project_finish == date(2026, 5, 18)
    assert schedule(build(late)).project_finish == date(2026, 5, 18)


@pytest.mark.parametrize(
    ("floor_kw", "project_kw"),
    [
        pytest.param({"planned_start": date(2026, 3, 16)}, {}, id="snet"),
        pytest.param({"actual_start": date(2026, 3, 16)}, {}, id="actual-start"),
        pytest.param({}, {"status_date": date(2026, 3, 16)}, id="data-date"),
    ],
)
@pytest.mark.parametrize("lag", [1, 2, 3])
def test_a_non_binding_predecessor_does_not_move_a_floored_milestones_successors(
    floor_kw: dict[str, object], project_kw: dict[str, object], lag: int
) -> None:
    """``M`` held on Mon 03-16 by a floor, ``M -FS+lag-> B``, with and without ``P -FS-> M``.

    ``P`` finished well before the floor, so it does not hold ``M``. Before the fix
    adding it moved ``B`` a working day or two earlier: with a predecessor the floor
    linked from Saturday 00:00 (#4883), without one from Monday.
    """

    def build(with_pred: bool) -> Project:
        tasks = [
            # Completed, so a data date does not carry it up to the floor.
            Task("P", "P", timedelta(days=2), percent_complete=100.0),
            Task("M", "M", timedelta(0), **floor_kw),  # type: ignore[arg-type]
            Task("B", "B", timedelta(days=1)),
        ]
        deps = [Dependency("M", "B", DependencyType.FS, timedelta(days=lag))]
        if with_pred:
            deps.append(Dependency("P", "M", DependencyType.FS))
        return Project("p", "p", _START, tasks, deps, Calendar(), **project_kw)  # type: ignore[arg-type]

    alone = schedule(build(False))
    linked = schedule(build(True))
    assert _task(alone, "M").early_start == _task(linked, "M").early_start == date(2026, 3, 16)
    assert _task(alone, "B").early_start == _task(linked, "B").early_start
    assert alone.project_finish == linked.project_finish


def _fuzz_network(rng: random.Random, pin: tuple[str, date] | None = None) -> Project:
    n = rng.randint(2, 6)
    tasks = []
    for i in range(n):
        duration = rng.choice([0, 0, rng.randint(1, 15)])
        task = Task(f"t{i}", f"t{i}", timedelta(days=duration))
        task.calendar_id = rng.choice([None, *_CALS])
        if rng.random() < 0.15:
            task.percent_complete = 100.0
        tasks.append(task)
    deps = [
        Dependency(f"t{a}", f"t{b}", rng.choice(list(DependencyType)))
        for b in range(1, n)
        for a in range(b)
        if rng.random() < 0.4
    ]
    if pin is not None:
        next(t for t in tasks if t.id == pin[0]).planned_start = pin[1]
    return Project("p", "p", _START, tasks, deps, Calendar(), calendars=dict(_CALS))


def test_slip_oracle_on_zero_lag_networks_with_per_task_calendars() -> None:
    """Seeded fuzz in the comment's shape: zero-lag links of every type, mixed calendars.

    Every open start-of-day milestone is held on its shown late start and the finish
    must not move. Each network is rebuilt from the same seed for the pinned run.
    """
    checked = 0
    for seed in range(1500):
        try:
            base = schedule(_fuzz_network(random.Random(seed)))
        except SchedulerError:
            continue
        source = {t.id: t for t in _fuzz_network(random.Random(seed)).tasks}
        for out in base.tasks:
            src = source[out.id]
            if src.duration.days or src.percent_complete >= 100 or out.milestone_at_day_end:
                continue
            assert out.late_start is not None
            try:
                pinned = schedule(_fuzz_network(random.Random(seed), (out.id, out.late_start)))
            except SchedulerError:
                continue
            checked += 1
            assert pinned.project_finish == base.project_finish, (seed, out.id, out.late_start)
    assert checked > 2000


def test_the_project_start_floor_is_not_given_an_earlier_link() -> None:
    """A milestone pinned on the project start's own day links from it, as before (#4635).

    The project start only bounds where a milestone is shown, and every successor
    carries it itself; an earlier link would measure lags from before the plan opened.
    """
    project = Project(
        "p",
        "p",
        _START,
        [
            Task("M", "M", timedelta(0), planned_start=_START),
            Task("B", "B", timedelta(days=1)),
        ],
        [Dependency("M", "B", DependencyType.FS, timedelta(days=1))],
        Calendar(),
    )
    assert _task(schedule(project), "B").early_start == date(2026, 3, 3)
