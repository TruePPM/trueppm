"""Open work with no remaining work (``Task.zero_remaining``, ADR-1474, #4819).

The reference comparison lives in ``test_cpm_oracle.py``
(``*_matches_reference_with_no_remaining_work``). This module holds the relations
the reference does not check: the derivation agrees with the schedule, Monte Carlo
agrees with ``schedule()`` on a zero-variance network, and a what-if pull-in is
monotone across every link type, start reading, lag and calendar.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
from itertools import pairwise

import pytest
from hypothesis import given, settings

from tests.test_cpm_oracle import progress_projects, to_engine_project
from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Quantity,
    Task,
    derive_value,
    monte_carlo,
    perturb_task_duration,
    schedule,
)

_DATE_QUANTITIES = {
    Quantity.EARLY_START,
    Quantity.EARLY_FINISH,
    Quantity.LATE_START,
    Quantity.LATE_FINISH,
    Quantity.SCHEDULED_START,
}
_networks = progress_projects(no_remaining=True)


@pytest.mark.fuzz
@given(ref=_networks)
@settings(max_examples=150)
def test_the_derivation_explains_a_task_with_no_remaining_work(ref: object) -> None:
    """Every derived value is the schedule's, with exactly one binding term."""
    project = to_engine_project(ref)  # type: ignore[arg-type]
    result = schedule(project)
    by_id = {t.id: t for t in result.tasks}
    for t in project.tasks:
        for q in Quantity:
            d = derive_value(project, t.id, q, result=result)
            engine_value = getattr(by_id[t.id], q.value)
            if q in _DATE_QUANTITIES:
                expected = engine_value.isoformat() if engine_value is not None else None
                assert d.value == expected, (t.id, q)
            else:
                assert d.value == engine_value.days, (t.id, q)
            assert len([c for c in d.contributions if c.is_binding]) == 1, (t.id, q)


@pytest.mark.fuzz
@given(ref=_networks)
@settings(max_examples=100)
def test_monte_carlo_matches_schedule_with_no_remaining_work(ref: object) -> None:
    """With no estimate anywhere every run is the deterministic pass, so every
    percentile is ``schedule()``'s finish: Monte Carlo reads the same link starts."""
    project = to_engine_project(ref)  # type: ignore[arg-type]
    finish = schedule(project).project_finish
    mc = monte_carlo(project, runs=8, seed=7)
    assert mc.p50 == mc.p95 == finish


def test_a_flag_is_validated_as_a_bool() -> None:
    task = Task(id="a", name="a", duration=timedelta(days=2), zero_remaining=1)  # type: ignore[arg-type]
    with pytest.raises(InvalidScheduleInput, match="zero_remaining"):
        schedule(Project(id="p", name="p", start_date=date(2027, 3, 1), tasks=[task]))
    with pytest.raises(InvalidScheduleInput, match="zero_remaining"):
        Task.from_dict({"id": "a", "name": "a", "duration": 86400.0, "zero_remaining": "yes"})


def test_the_flag_round_trips_through_a_document() -> None:
    task = Task(id="a", name="a", duration=timedelta(days=2), zero_remaining=True)
    assert Task.from_dict(task.to_dict()) == task


def test_an_unset_flag_is_left_out_of_the_document() -> None:
    """As in Rust (``skip_serializing_if``): an unflagged document is unchanged by the
    key's existence, so Monte Carlo seeds and answer-stamp hashes taken over it do not
    move on upgrade."""
    task = Task(id="a", name="a", duration=timedelta(days=2))
    doc = task.to_dict()
    assert "zero_remaining" not in doc
    assert Task.from_dict(doc) == task
    assert replace(task, zero_remaining=True).to_dict()["zero_remaining"] is True


def test_a_network_whose_only_instant_is_a_flagged_task_replays_its_instants() -> None:
    """No zero-duration task, one flagged task: the milestone-replay gates in
    ``schedule()`` and ``derive_value`` must still treat it as an instant, both from
    the stash and from a full replay (a result not produced for this object)."""
    start = date(2027, 3, 1)
    project = Project(
        id="p",
        name="p",
        start_date=start,
        tasks=[
            Task("a", "a", timedelta(days=3)),
            Task("z", "z", timedelta(days=4), percent_complete=50.0, zero_remaining=True),
            Task("s", "s", timedelta(days=2)),
            Task("u", "u", timedelta(days=5)),
        ],
        dependencies=[
            Dependency("a", "z"),
            Dependency("z", "s", DependencyType.SS, lag=timedelta(days=1)),
            Dependency("z", "u", DependencyType.FF),
        ],
    )
    result = schedule(project)
    by_id = {t.id: t for t in result.tasks}
    copy = replace(project, tasks=list(project.tasks))  # forces the full replay
    for proj in (project, copy):
        for t in project.tasks:
            for q in Quantity:
                d = derive_value(proj, t.id, q, result=result)
                engine_value = getattr(by_id[t.id], q.value)
                if q in _DATE_QUANTITIES:
                    expected = engine_value.isoformat() if engine_value is not None else None
                    assert d.value == expected, (t.id, q)
                else:
                    assert d.value == engine_value.days, (t.id, q)


def test_an_unstarted_task_perturbs_exactly_as_before() -> None:
    """An unstarted task keeps its sub-day seconds and an unset percentage, so a
    network that never sets the flag perturbs byte-identically (ADR-1474)."""
    t = Task("a", "a", timedelta(days=5, hours=6))
    project = Project(id="p", name="p", start_date=date(2027, 3, 1), tasks=[t])
    out = perturb_task_duration(project, "a", -2).tasks[0]
    assert out == replace(t, duration=timedelta(days=3, hours=6))
    assert out.to_dict() == replace(t, duration=timedelta(days=3, hours=6)).to_dict()


def test_a_milestone_and_a_completed_task_ignore_the_flag() -> None:
    """Both already have no remaining work, so the flag changes nothing."""
    start = date(2027, 3, 1)
    for t in (
        Task(id="m", name="m", duration=timedelta(0)),
        Task(id="m", name="m", duration=timedelta(days=3), percent_complete=100.0),
    ):
        plain = Project(
            id="p", name="p", start_date=start, tasks=[t, Task("s", "s", timedelta(days=2))]
        )
        plain = replace(plain, dependencies=[Dependency("m", "s", DependencyType.SS)])
        flagged = replace(plain, tasks=[replace(t, zero_remaining=True), plain.tasks[1]])
        assert [x.early_start for x in schedule(flagged).tasks] == [
            x.early_start for x in schedule(plain).tasks
        ]


_MWF = Calendar(working_days=0b0010101)
_STARTS = {
    "recorded": {"percent_complete": 40.0, "actual_start": date(2027, 3, 5)},
    "recorded-weekend": {"actual_start": date(2027, 3, 6)},
    "derived": {"percent_complete": 40.0},
    "none": {},
}


def _chain(link: DependencyType, lag: int, start: str, calendar_id: str | None) -> Project:
    """``P -FS-> M -link-> S``; M is 5 days, started as ``start`` says; data date 03-08."""
    m = Task(
        id="M", name="M", duration=timedelta(days=5), calendar_id=calendar_id, **_STARTS[start]
    )  # type: ignore[arg-type]
    return Project(
        id="p",
        name="p",
        start_date=date(2027, 3, 1),
        status_date=date(2027, 3, 8),
        tasks=[Task("P", "P", timedelta(days=5)), m, Task("S", "S", timedelta(days=3))],
        dependencies=[
            Dependency("P", "M"),
            Dependency("M", "S", link, timedelta(days=lag)),
        ],
        calendars={"mwf": _MWF},
    )


@pytest.mark.parametrize("calendar_id", [None, "mwf"])
@pytest.mark.parametrize("start", list(_STARTS))
@pytest.mark.parametrize("lag", [-1, 0, 2])
@pytest.mark.parametrize("link", list(DependencyType))
def test_a_bigger_pull_in_never_finishes_later(
    link: DependencyType, lag: int, start: str, calendar_id: str | None
) -> None:
    """The #4819 relation on every link type, start reading, lag and calendar: removing
    more work from M never moves the forecast later, in ``schedule()`` or in Monte
    Carlo, and once the work is gone a larger pull-in changes nothing."""
    baseline = _chain(link, lag, start, calendar_id)
    deltas = (0, -1, -2, -3, -4, -5, -9)
    projects = [perturb_task_duration(baseline, "M", d) for d in deltas]
    finishes = [schedule(p).project_finish for p in projects]
    p50s = [monte_carlo(p, runs=4, seed=3).p50 for p in projects]
    for smaller, bigger in pairwise(finishes):
        assert bigger <= smaller
    for smaller, bigger in pairwise(p50s):
        assert bigger <= smaller
    assert p50s == finishes
    assert finishes[-1] == finishes[-2]


def _late_and_float_net(link: DependencyType, lag: int, succ_days: int, recorded: bool) -> Project:
    """``M -link+lag-> S`` beside an unlinked 15-day ``L`` that sets the finish.

    M is 5 days at 40% with no remaining work, so it is placed as an instant at the
    data date, Wednesday 2027-03-10; its span start is either recorded (``actual_start``
    Monday 03-08) or derived: 40% of 5 days is 2 elapsed working days before the
    instant, Monday 03-08 too. Standard Monday-to-Friday week, no holidays.
    """
    m = Task(
        "M",
        "M",
        timedelta(days=5),
        percent_complete=40,
        zero_remaining=True,
        actual_start=date(2027, 3, 8) if recorded else None,
    )
    return Project(
        id="p",
        name="p",
        start_date=date(2027, 3, 1),
        status_date=date(2027, 3, 10),
        tasks=[m, Task("S", "S", timedelta(days=succ_days)), Task("L", "L", timedelta(days=15))],
        dependencies=[Dependency("M", "S", link, timedelta(days=lag))],
    )


# Hand-computed (not read off the engine). The oracle compares only the position of an
# instant-like task, so these are the checks on its late dates and float (#5115).
# Common to every case: L runs 15 working days from Wed 03-10 (03-10..12 = 3, 03-15..19
# = 8, 03-22..26 = 13, 03-29..30 = 15), so the project finishes Tue 03-30, the end of
# that day, and every late date is bounded by it.
#
# SS +4, derived start. Forward: span start Mon 03-08 + 4 calendar days = Fri 03-12 = S's
# early start; S (3 days) finishes Tue 03-16. Backward: S late finish 03-30, late start
# 03-26 (26, 29, 30). The latest span start is 03-26 - 4 calendar days = Mon 03-22; the
# instant sits 2 working days after it, Wed 03-24, so M's late_finish is 03-24 and its
# total float is 03-10 -> 03-24 = 10 working days. Free float: S's early start 03-12 - 4
# = Mon 03-08 is the latest span start that leaves S where it is, i.e. the instant 03-10
# itself, so 0 (a span start of Tue 03-09 would put S on Sat 03-13, snapped to Mon 03-15).
#
# SF +7, derived start. The link holds S's finish instant (the start of the day after
# its finish date) at or after span start + 7. Forward: 03-08 + 7 = the start of Mon
# 03-15, i.e. the end of Sun 03-14, which is not a working day, so S finishes at the end
# of Mon 03-15 (starting Fri 03-12). Backward: S's late finish, the end of 03-30, is the
# instant 03-31; 03-31 - 7 = Wed 03-24 is the latest span start, and the instant 2 working
# days later is Fri 03-26: late_finish 03-26, total float 03-10 -> 03-26 = 12 working
# days. Free float: S's early finish instant 03-16 - 7 = Tue 03-09; 2 working days later
# is Thu 03-11, so 1 working day (a span start of 03-09 still lands S's finish at the end
# of 03-15).
#
# Recorded start, either link. A recorded start does not move when the instant slips
# (#4523), so the link bounds nothing: M's late date is the project finish, Tue 03-30,
# and both floats run 03-10 -> 03-30 = 14 working days.
@pytest.mark.parametrize(
    ("link", "lag", "succ_days", "recorded", "late_finish", "total_float", "free_float"),
    [
        (DependencyType.SS, 4, 3, False, date(2027, 3, 24), 10, 0),
        (DependencyType.SF, 7, 2, False, date(2027, 3, 26), 12, 1),
        (DependencyType.SS, 4, 3, True, date(2027, 3, 30), 14, 14),
        (DependencyType.SF, 7, 2, True, date(2027, 3, 30), 14, 14),
    ],
)
def test_late_dates_and_float_of_a_task_with_no_remaining_work(
    link: DependencyType,
    lag: int,
    succ_days: int,
    recorded: bool,
    late_finish: date,
    total_float: int,
    free_float: int,
) -> None:
    """An SS/SF link from a derived start bounds the instant through the span start;
    one from a recorded start bounds nothing (ADR-1474)."""
    m = next(
        t
        for t in schedule(_late_and_float_net(link, lag, succ_days, recorded)).tasks
        if t.id == "M"
    )
    assert m.early_start == m.early_finish == date(2027, 3, 10)
    assert m.late_start == m.late_finish == late_finish
    assert m.total_float == timedelta(days=total_float)
    assert m.free_float == timedelta(days=free_float)
