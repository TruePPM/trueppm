"""Every dependency edge's raw constraint holds in ``schedule()``'s output (#3962).

The other fuzz invariants compare outputs with each other, and the conformance
fixtures compare the two engines with each other. This one recomputes each edge's
lower bound from the documented rule, with its own calendar walk, and checks the
successor against it. It asserts nothing about duration monotonicity, which FF and
SF links legitimately break (#2833).

The engine's convention, for work that has a duration and no progress recorded:
the bound is the anchor plus ``lag`` calendar days, then the next working day on
the **successor's** calendar, where the anchor is

* FS: the day after the predecessor's early finish; bounds the successor's early start
* SS: the predecessor's early start; bounds the successor's early start
* FF: the predecessor's early finish; bounds the successor's early finish
* SF: the day before the predecessor's early start, bounding the successor's early
  finish. With no positive lag that day is first read back to the predecessor's
  last working day (#4333).

Milestones are placed at instants and progressed tasks are pinned to what was
recorded, so neither follows these formulas and neither is generated here.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    Project,
    Task,
    schedule,
)

pytestmark = pytest.mark.fuzz

_START = date(2026, 3, 2)  # Monday
_DAY = timedelta(days=1)
_WEEKS = [0b0011111, 0b1111111, 0b0001111, 0b1001111, 0b0100001]


def _is_working(day: date, calendar: Calendar) -> bool:
    if not calendar.working_days & (1 << day.weekday()):
        return False
    return not any(r.start <= day <= r.end for r in calendar.exceptions)


def _next_working(day: date, calendar: Calendar) -> date:
    while not _is_working(day, calendar):
        day += _DAY
    return day


def _previous_working(day: date, calendar: Calendar) -> date:
    while not _is_working(day, calendar):
        day -= _DAY
    return day


@st.composite
def _calendars(draw: st.DrawFn) -> Calendar:
    holidays = draw(st.lists(st.tuples(st.integers(-10, 60), st.integers(0, 4)), max_size=3))
    return Calendar(
        working_days=draw(st.sampled_from(_WEEKS)),
        exceptions=[
            DateRange(_START + timedelta(days=at), _START + timedelta(days=at + extra))
            for at, extra in holidays
        ],
    )


@st.composite
def _projects(draw: st.DrawFn) -> Project:
    """A small acyclic network over all four link types, signed lags and mixed calendars."""
    ids = [f"T{i}" for i in range(draw(st.integers(2, 7)))]
    registry = {"x": draw(_calendars()), "y": draw(_calendars())}
    tasks = [
        Task(
            id=tid,
            name=tid,
            duration=timedelta(days=draw(st.integers(1, 8))),
            calendar_id=draw(st.sampled_from([None, "x", "y"])),
            planned_start=draw(
                st.none() | st.integers(-5, 30).map(lambda n: _START + timedelta(days=n))
            ),
        )
        for tid in ids
    ]
    pairs = [(u, v) for i, u in enumerate(ids) for v in ids[i + 1 :]]
    dependencies = [
        Dependency(
            predecessor_id=u,
            successor_id=v,
            dep_type=draw(st.sampled_from(list(DependencyType))),
            lag=timedelta(days=draw(st.integers(-9, 9))),
        )
        for u, v in draw(st.lists(st.sampled_from(pairs), unique=True, min_size=1, max_size=10))
    ]
    return Project(
        id="p",
        name="edges",
        start_date=_START,
        tasks=draw(st.permutations(tasks)),
        dependencies=dependencies,
        calendar=draw(_calendars()),
        calendars=registry,
    )


@given(project=_projects())
def test_every_edge_satisfies_its_raw_constraint(project: Project) -> None:
    scheduled = {t.id: t for t in schedule(project).tasks}

    def calendar_of(tid: str) -> Calendar:
        cal_id = scheduled[tid].calendar_id
        return project.calendar if cal_id is None else project.calendars[cal_id]

    for dep in project.dependencies:
        pred = scheduled[dep.predecessor_id]
        succ = scheduled[dep.successor_id]
        assert pred.early_start and pred.early_finish
        assert succ.early_start and succ.early_finish
        if dep.dep_type is DependencyType.FS:
            anchor, bounded = pred.early_finish + _DAY, succ.early_start
        elif dep.dep_type is DependencyType.SS:
            anchor, bounded = pred.early_start, succ.early_start
        elif dep.dep_type is DependencyType.FF:
            anchor, bounded = pred.early_finish, succ.early_finish
        else:
            anchor, bounded = pred.early_start - _DAY, succ.early_finish
            if dep.lag <= timedelta(0):
                anchor = _previous_working(anchor, calendar_of(pred.id))
        bound = _next_working(anchor + dep.lag, calendar_of(succ.id))
        assert bounded >= bound, (
            f"{dep.predecessor_id}->{dep.successor_id} {dep.dep_type.value} lag "
            f"{dep.lag.days}d: {bounded} is earlier than {bound}"
        )
