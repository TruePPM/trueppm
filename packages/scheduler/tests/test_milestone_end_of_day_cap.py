"""The start-read cap for an end-of-day milestone reading (#4344).

``_start_read_cap`` bounds how late a milestone may sit and still be shown by
``project_finish``. When ``project_finish`` is a non-working day — a completed task
with a weekend ``actual_finish`` — the cap is reached by an *end-of-day* reading
too, and the latest admissible instant for it is ``D + 1`` (the midnight that
closes the last working day ``D`` on or before the finish), not ``D``. Capping at
``D`` understated every FS/SS predecessor's total float by one working day and
reported a task with one day of float as critical.

The Rust engine mirrors the same rule, so the cross-engine conformance fixture
(``milestone_end_of_day_cap_weekend_finish``) only proves the two agree. The
independent oracle here is the slip test: re-pin a task its total float later and
the finish must not move; one working day more and it must.
"""

from __future__ import annotations

import copy
from datetime import date, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Quantity,
    Task,
    derive_value,
    schedule,
)

# Monday. Default calendar is Mon-Fri.
MON = date(2026, 3, 2)
# A Sunday: the completed task Z finishes on it, so it is ``project_finish``.
SUNDAY = date(2026, 3, 22)


def _repro(a_planned_start: date | None = None) -> Project:
    """The issue's repro: ``A(2d) -FS-> M`` beside Z, done on a Sunday."""
    return Project(
        "p",
        "p",
        MON,
        [
            Task("A", "A", timedelta(days=2), planned_start=a_planned_start),
            Task("M", "M", timedelta(0)),
            Task(
                "Z",
                "Z",
                timedelta(days=3),
                actual_start=date(2026, 3, 18),
                actual_finish=SUNDAY,
            ),
        ],
        [Dependency("A", "M")],
        Calendar(),
    )


def _advance_working_days(d: date, n: int, cal: Calendar) -> date:
    while n > 0:
        d += timedelta(days=1)
        if cal.is_working_day(d):
            n -= 1
    return d


def _position(p: Project) -> date:
    """The finish instant's working-time position (day + at-day-start)."""
    from trueppm_scheduler.engine import _milestone_instants, _next_working_day

    return _next_working_day(_milestone_instants(p)[2], p.calendar)


def _assert_slip_oracle(p: Project) -> None:
    """Slipping each live work task by TF holds the finish; TF + 1 moves it.

    "Holds" compares the shown ``project_finish``; "moves" also accepts a change
    in the finish instant's working position, as in
    ``test_milestone_instant.test_total_float_is_the_slip_the_finish_absorbs``.
    """
    result = schedule(p)
    base_position = _position(p)
    for t in result.tasks:
        if t.duration.days == 0 or t.actual_start is not None:
            continue
        assert t.early_start is not None
        tf = t.total_float.days
        for slip, moves in ((tf, False), (tf + 1, True)):
            shifted = copy.deepcopy(p)
            pinned = next(x for x in shifted.tasks if x.id == t.id)
            pinned.planned_start = _advance_working_days(t.early_start, slip, p.calendar)
            finish_moved = schedule(shifted).project_finish != result.project_finish
            moved = finish_moved or (moves and _position(shifted) != base_position)
            assert moved is moves, (t.id, tf, slip)


def test_repro_float_runs_to_the_midnight_closing_friday() -> None:
    """A at 03-19..03-20 puts M at Saturday midnight, shown Friday: float 13."""
    result = schedule(_repro())
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == SUNDAY
    assert by["A"].total_float == timedelta(days=13)
    assert by["A"].late_start == date(2026, 3, 19)
    assert by["A"].late_finish == date(2026, 3, 20)
    assert by["M"].total_float == timedelta(days=13)
    assert by["M"].late_start == date(2026, 3, 20)
    assert not by["A"].is_critical
    assert not by["M"].is_critical


def test_repro_pinned_predecessor_has_one_day_of_float_not_zero() -> None:
    """Pinned to 03-18, A can still move to 03-19 without moving the finish."""
    result = schedule(_repro(date(2026, 3, 18)))
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == SUNDAY
    assert by["A"].total_float == timedelta(days=1)
    assert by["M"].total_float == timedelta(days=1)
    assert not by["A"].is_critical
    assert not by["M"].is_critical
    assert result.critical_path == []


@pytest.mark.parametrize("a_planned_start", [None, date(2026, 3, 18), date(2026, 3, 19)])
def test_repro_slip_oracle(a_planned_start: date | None) -> None:
    _assert_slip_oracle(_repro(a_planned_start))


def test_start_of_day_reading_keeps_the_last_working_day_cap() -> None:
    """An SS link from work reads the milestone as start of day: cap stays Friday.

    ``X(2d) -SS+2-> M`` with M at Friday midnight's start reading is shown on
    Friday; at Saturday midnight it would be shown Monday, past the Sunday finish.
    So the end-of-day widening must not reach the start-of-day reading.
    """
    p = Project(
        "p",
        "p",
        MON,
        [
            Task("X", "X", timedelta(days=2)),
            Task("M", "M", timedelta(0)),
            Task(
                "Z",
                "Z",
                timedelta(days=3),
                actual_start=date(2026, 3, 18),
                actual_finish=SUNDAY,
            ),
        ],
        [Dependency("X", "M", dep_type=DependencyType.SS, lag=timedelta(days=2))],
        Calendar(),
    )
    _assert_slip_oracle(p)


@st.composite
def _networks_finishing_on_a_weekend(draw: st.DrawFn) -> Project:
    """Random FS/SS networks of work and milestones beside a weekend-finished task.

    Z is complete with a Saturday or Sunday ``actual_finish``, so whenever it is
    the long pole ``project_finish`` is a non-working day — the shape #4344 needs.
    """
    n = draw(st.integers(min_value=2, max_value=6))
    tasks = [
        Task(f"T{i}", f"T{i}", timedelta(days=draw(st.sampled_from([0, 0, 1, 2, 3, 5]))))
        for i in range(n)
    ]
    deps: list[Dependency] = []
    for i in range(n):
        for j in range(i + 1, n):
            if draw(st.booleans()):
                deps.append(
                    Dependency(
                        f"T{i}",
                        f"T{j}",
                        dep_type=draw(st.sampled_from([DependencyType.FS, DependencyType.SS])),
                        lag=timedelta(days=draw(st.sampled_from([0, 0, 1, 2]))),
                    )
                )
    weeks = draw(st.integers(min_value=1, max_value=3))
    finish = MON + timedelta(days=7 * weeks + draw(st.sampled_from([5, 6])))
    tasks.append(
        Task(
            "Z",
            "Z",
            timedelta(days=3),
            actual_start=finish - timedelta(days=4),
            actual_finish=finish,
        )
    )
    return Project("p", "p", MON, tasks, deps, Calendar())


@pytest.mark.fuzz
@given(_networks_finishing_on_a_weekend())
def test_total_float_is_the_slip_the_weekend_finish_absorbs(p: Project) -> None:
    _assert_slip_oracle(p)


def _seven_day_finish(a_planned_start: date | None = None) -> Project:
    """The issue's per-task-calendar shape: a seven-day task finishing on a Sunday.

    ``S7(7d)`` on a seven-day calendar, started Monday 03-16, ends Sunday 03-22, so
    ``project_finish`` is a non-working day on the Mon-Fri milestone calendar with
    no actuals involved.
    """
    return Project(
        "p",
        "p",
        MON,
        [
            Task("A", "A", timedelta(days=2), planned_start=a_planned_start),
            Task("M", "M", timedelta(0)),
            Task(
                "S7",
                "S7",
                timedelta(days=7),
                planned_start=date(2026, 3, 16),
                calendar_id="seven",
            ),
        ],
        [Dependency("A", "M")],
        Calendar(),
        calendars={"seven": Calendar(working_days=0b1111111)},
    )


def test_seven_day_task_finishing_on_a_sunday() -> None:
    result = schedule(_seven_day_finish())
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == SUNDAY
    assert by["A"].total_float == timedelta(days=13)
    assert by["M"].total_float == timedelta(days=13)

    pinned = schedule(_seven_day_finish(date(2026, 3, 18)))
    by = {t.id: t for t in pinned.tasks}
    assert by["A"].total_float == timedelta(days=1)
    assert not by["A"].is_critical
    assert not by["M"].is_critical
    _assert_slip_oracle(_seven_day_finish(date(2026, 3, 18)))


def _mon_thu_milestone(a_planned_start: date | None = None) -> Project:
    """The milestone on its own Mon-Thu calendar, against a working-Friday finish.

    ``W(15d)`` ends the project at the end of Friday 03-20. ``D`` is computed on
    M's calendar, so it is Thursday 03-19; the end-of-day cap is Friday midnight,
    shown as the end of Thursday. Saturday midnight would read as the start of
    Monday on M's calendar and move the finish.
    """
    return Project(
        "p",
        "p",
        MON,
        [
            Task("A", "A", timedelta(days=2), planned_start=a_planned_start),
            Task("M", "M", timedelta(0), calendar_id="monthu"),
            Task("W", "W", timedelta(days=15)),
        ],
        [Dependency("A", "M")],
        Calendar(),
        calendars={"monthu": Calendar(working_days=0b0001111)},
    )


@pytest.mark.parametrize("a_planned_start", [None, date(2026, 3, 17), date(2026, 3, 18)])
def test_milestone_on_its_own_calendar_slip_oracle(a_planned_start: date | None) -> None:
    _assert_slip_oracle(_mon_thu_milestone(a_planned_start))


def test_milestone_on_its_own_calendar_float_runs_to_friday_midnight() -> None:
    result = schedule(_mon_thu_milestone())
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == date(2026, 3, 20)
    assert by["A"].total_float == timedelta(days=12)
    assert by["A"].late_finish == date(2026, 3, 19)
    assert by["M"].late_start == date(2026, 3, 19)


# --- SF links into a milestone (#4431) -------------------------------------------
#
# An SF proposal into a milestone is read like FS from work, so the finish
# reference it inverts against takes the same cap the FS/SS start reference does.
# Before #4431 only ``start_ref`` was capped, so an SF predecessor reported one
# working day of float that, used, showed the milestone past ``project_finish``.


def _sf_mixed_calendar(x_planned_start: date | None = None) -> Project:
    """The issue's repro: ``X(1d) -SF+2d-> M`` with M on a Mon-Thu calendar.

    ``W(5d)`` ends the project at the end of Friday 2027-03-05. ``M`` at Saturday
    midnight would read as the start of Monday on its calendar (Friday is not a
    working day there) and move the finish, so its latest admissible instant is
    Friday midnight, shown as the end of Thursday.
    """
    return Project(
        "p",
        "p",
        date(2027, 3, 1),
        [
            Task("W", "W", timedelta(days=5)),
            Task("X", "X", timedelta(days=1), planned_start=x_planned_start),
            Task("M", "M", timedelta(0), calendar_id="four"),
        ],
        [Dependency("X", "M", dep_type=DependencyType.SF, lag=timedelta(days=2))],
        Calendar(),
        calendars={"four": Calendar(working_days=0b0001111)},
    )


def test_sf_into_milestone_on_its_own_calendar_float_is_not_overstated() -> None:
    """X's TF is 2 (was 3): a three-day slip shows M on Monday, past the finish."""
    result = schedule(_sf_mixed_calendar())
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == date(2027, 3, 5)
    assert by["X"].total_float == timedelta(days=2)
    assert by["X"].late_start == date(2027, 3, 3)
    assert by["M"].total_float == timedelta(days=2)


def test_sf_into_milestone_sole_driver_is_critical_with_its_milestone() -> None:
    """Slipped by its two days of float, X is critical together with M."""
    result = schedule(_sf_mixed_calendar(date(2027, 3, 3)))
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == date(2027, 3, 5)
    assert by["X"].total_float == timedelta(0)
    assert by["M"].total_float == timedelta(0)
    assert by["X"].is_critical
    assert by["M"].is_critical


@pytest.mark.parametrize(
    "x_planned_start", [None, date(2027, 3, 2), date(2027, 3, 3), date(2027, 3, 4)]
)
def test_sf_into_milestone_on_its_own_calendar_slip_oracle(x_planned_start: date | None) -> None:
    _assert_slip_oracle(_sf_mixed_calendar(x_planned_start))


def _sf_weekend_finish(lag_days: int) -> Project:
    """One project calendar: ``X(1d) -SF+lag-> M`` beside W, done on a Saturday.

    The API writes a weekend ``actual_finish`` whenever a card is closed on a
    weekend, so ``project_finish`` is Saturday 2027-03-06 with no per-task
    calendars. The end-of-day cap is Saturday midnight, shown Friday.
    """
    return Project(
        "p",
        "p",
        date(2027, 3, 1),
        [
            Task(
                "W",
                "W",
                timedelta(days=5),
                actual_start=date(2027, 3, 1),
                actual_finish=date(2027, 3, 6),
            ),
            Task("X", "X", timedelta(days=1)),
            Task("M", "M", timedelta(0)),
        ],
        [Dependency("X", "M", dep_type=DependencyType.SF, lag=timedelta(days=lag_days))],
        Calendar(),
    )


def test_sf_into_milestone_weekend_finish_critical_milestone_has_critical_driver() -> None:
    """SF+5: M is critical, so its only driver X must be too (TF was reported 1)."""
    result = schedule(_sf_weekend_finish(5))
    by = {t.id: t for t in result.tasks}
    assert result.project_finish == date(2027, 3, 6)
    assert by["M"].total_float == timedelta(0)
    assert by["X"].total_float == timedelta(0)
    assert by["M"].is_critical
    assert by["X"].is_critical


@pytest.mark.parametrize("lag_days", [2, 3, 4, 5])
def test_sf_into_milestone_weekend_finish_slip_oracle(lag_days: int) -> None:
    _assert_slip_oracle(_sf_weekend_finish(lag_days))


@st.composite
def _sf_into_milestones_finishing_on_a_weekend(draw: st.DrawFn) -> Project:
    """Work tasks linked SF (with a lag) into milestones beside a weekend finish."""
    n = draw(st.integers(min_value=1, max_value=4))
    tasks: list[Task] = []
    deps: list[Dependency] = []
    for i in range(n):
        tasks.append(Task(f"X{i}", f"X{i}", timedelta(days=draw(st.sampled_from([1, 2, 3])))))
        tasks.append(Task(f"M{i}", f"M{i}", timedelta(0)))
        deps.append(
            Dependency(
                f"X{i}",
                f"M{i}",
                dep_type=DependencyType.SF,
                lag=timedelta(days=draw(st.integers(min_value=0, max_value=12))),
            )
        )
    weeks = draw(st.integers(min_value=1, max_value=2))
    finish = MON + timedelta(days=7 * weeks + draw(st.sampled_from([4, 5, 6])))
    tasks.append(
        Task(
            "Z",
            "Z",
            timedelta(days=3),
            actual_start=finish - timedelta(days=4),
            actual_finish=finish,
        )
    )
    return Project("p", "p", MON, tasks, deps, Calendar())


@pytest.mark.fuzz
@given(_sf_into_milestones_finishing_on_a_weekend())
def test_sf_into_milestone_total_float_is_the_slip_the_finish_absorbs(p: Project) -> None:
    _assert_slip_oracle(p)


@pytest.mark.parametrize(
    "project",
    [
        _sf_mixed_calendar(),
        _sf_mixed_calendar(date(2027, 3, 3)),
        _sf_weekend_finish(4),
        _sf_weekend_finish(5),
    ],
    ids=["mixed", "mixed-pinned", "weekend-sf4", "weekend-sf5"],
)
def test_sf_into_milestone_derivation_explains_the_engines_float(project: Project) -> None:
    """``derive_value`` re-inverts the same link, so it must take the same cap (#4431).

    ``derive.py`` carries its own copy of the backward pass's successor references;
    capping only the engine's left the SF term imposing the old, overstated late
    start while still being marked binding on a value it does not produce.
    """
    result = schedule(project)
    x = next(t for t in result.tasks if t.id == "X")
    derivation = derive_value(project, "X", Quantity.LATE_START, result)
    assert str(derivation.value) == x.late_start.isoformat()
    assert derivation.binding is not None
    assert derivation.binding.kind == "successor_sf"
    assert derivation.binding.imposed_date == x.late_start
    total_float = derive_value(project, "X", Quantity.TOTAL_FLOAT, result)
    assert str(total_float.value) == str(x.total_float.days)
