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
