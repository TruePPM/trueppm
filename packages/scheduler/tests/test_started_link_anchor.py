"""SS/SF links out of a started task measure from its recorded start (#4523).

An in-progress task's ``early_start`` is the start of its *remaining-work* window
(ADR-0132), floored at the data date. Anchoring a start-side link (SS, SF) on it
re-applied the link's lag from the data date on every status update: with
``A -SS+10d-> B`` and ``A`` started on 03-02, a status update on 03-04 put ``B`` on
03-16 and one on 03-06, with nothing else changed, on 03-16 + 2 = 03-18. The lag
compounded without bound as the data date advanced.

The rule (ADR-0132 §2a): a live task with a recorded ``actual_start`` is measured
from that ``actual_start`` by its SS and SF successors — the start happened and does
not move. Nothing else changes: FS/FF still measure from the finish, a not-started
task's start is its ``early_start``, and a completed task is pinned at its actuals
already. Because the start is history, its remaining work cannot slip a successor
through an SS/SF link, so such a link imposes no late-date bound on it either.

The oracle is a property, not the other engine: moving only the data date (while it
stays before the link's own bound) must not move the successor.
"""

from __future__ import annotations

import itertools
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    Project,
    Task,
    monte_carlo,
    schedule,
)

# 2026-03-02 is a Monday; 03-07/03-08 and 03-14/03-15 are weekends.
START = date(2026, 3, 2)
WEEKDAYS = 0b0011111
SIX_DAY = 0b0111111


def _project(
    pred: Task,
    dep_type: DependencyType,
    lag_days: int,
    status: date | None,
    *,
    succ_calendar: str | None = None,
) -> Project:
    succ = Task(id="B", name="B", duration=timedelta(days=3), calendar_id=succ_calendar)
    calendars = {"six": Calendar(working_days=SIX_DAY)} if succ_calendar else None
    return Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[pred, succ],
        dependencies=[Dependency("A", "B", dep_type, timedelta(days=lag_days))],
        calendar=Calendar(working_days=WEEKDAYS),
        calendars=calendars,
        status_date=status,
    )


def _started(pct: float = 20.0, actual: date = START) -> Task:
    return Task(
        id="A",
        name="A",
        duration=timedelta(days=20),
        percent_complete=pct,
        actual_start=actual,
    )


def _b(project: Project) -> tuple[date, date]:
    res = schedule(project)
    b = next(t for t in res.tasks if t.id == "B")
    assert b.early_start is not None and b.early_finish is not None
    return b.early_start, b.early_finish


def test_issue_repro_ss_lag_is_not_re_added_on_each_status_update() -> None:
    """``A -SS+10d-> B``: 03-02 + 10 calendar days = Thu 03-12, at either data date."""
    first = _b(_project(_started(), DependencyType.SS, 10, date(2026, 3, 4)))
    second = _b(_project(_started(), DependencyType.SS, 10, date(2026, 3, 6)))
    assert first[0] == date(2026, 3, 12)
    assert second == first


def test_issue_repro_sf_lag_is_not_re_added_on_each_status_update() -> None:
    """``A -SF+10d-> B``: finish bound 03-01 + 10 = Wed 03-11, at either data date."""
    first = _b(_project(_started(), DependencyType.SF, 10, date(2026, 3, 4)))
    second = _b(_project(_started(), DependencyType.SF, 10, date(2026, 3, 6)))
    assert first[1] == date(2026, 3, 11)
    assert second == first


@pytest.mark.parametrize(
    ("dep_type", "lag", "pct", "actual", "succ_cal"),
    [
        (dt, lag, pct, actual, cal)
        for dt, lag, pct, actual, cal in itertools.product(
            (DependencyType.SS, DependencyType.SF),
            (0, 3, 9, 15, -2),
            (0.0, 20.0, 60.0),
            (START, date(2026, 3, 1)),  # a Monday, and a verbatim Sunday actual
            (None, "six"),
        )
    ],
)
def test_successor_is_invariant_to_the_data_date(
    dep_type: DependencyType, lag: int, pct: float, actual: date, succ_cal: str | None
) -> None:
    """Property: any two data dates before the link's bound give the same successor.

    Two status dates are taken from 03-03 up to the last one that leaves ``B``
    unfloored by the data date in the earlier run. Covers SS and SF, positive, zero
    and negative lag, a started task with and without progress, a verbatim
    non-working ``actual_start`` and a successor on a different calendar.
    """
    base = _b(
        _project(_started(pct, actual), dep_type, lag, date(2026, 3, 3), succ_calendar=succ_cal)
    )
    # Every data date that does not itself reach B's start leaves B where it is.
    for day in range(4, 20):
        status = date(2026, 3, day)
        if status >= base[0]:
            break
        moved = _b(_project(_started(pct, actual), dep_type, lag, status, succ_calendar=succ_cal))
        assert moved == base, f"data date {status} moved B from {base} to {moved}"


def test_data_date_past_the_bound_still_floors_the_successor() -> None:
    """Unfinished work is never forecast into the past: the data date still floors B."""
    es, _ = _b(_project(_started(), DependencyType.SS, 2, date(2026, 3, 10)))
    assert es == date(2026, 3, 10)


@pytest.mark.parametrize("dep_type", [DependencyType.FS, DependencyType.FF])
def test_finish_links_still_track_the_remaining_work(dep_type: DependencyType) -> None:
    """FS/FF measure from the forecast finish, which does move with the data date."""
    first = _b(_project(_started(), dep_type, 2, date(2026, 3, 4)))
    second = _b(_project(_started(), dep_type, 2, date(2026, 3, 11)))
    assert second[1] > first[1]


@pytest.mark.parametrize("dep_type", [DependencyType.SS, DependencyType.SF])
def test_not_started_predecessor_is_unchanged(dep_type: DependencyType) -> None:
    """With no actual_start the start *is* the early start, data-date floor included."""
    pred = Task(id="A", name="A", duration=timedelta(days=20))
    first = _b(_project(pred, dep_type, 4, date(2026, 3, 4)))
    pred2 = Task(id="A", name="A", duration=timedelta(days=20))
    second = _b(_project(pred2, dep_type, 4, date(2026, 3, 6)))
    assert second[0] > first[0] or second[1] > first[1]


@pytest.mark.parametrize("dep_type", [DependencyType.SS, DependencyType.SF])
def test_completed_predecessor_is_unchanged(dep_type: DependencyType) -> None:
    """A completed task was already pinned at its actuals (ADR-0136)."""
    done = Task(
        id="A",
        name="A",
        duration=timedelta(days=5),
        percent_complete=100.0,
        actual_start=START,
        actual_finish=date(2026, 3, 6),
    )
    first = _b(_project(done, dep_type, 10, date(2026, 3, 4)))
    second = _b(_project(done, dep_type, 10, date(2026, 3, 6)))
    assert first == second


def test_started_predecessor_held_past_its_actual_by_a_predecessor() -> None:
    """Out-of-sequence progress: the recorded start, not the network slot, anchors SS.

    ``P -FS-> A`` would place ``A`` after 03-06, but ``A`` already started on 03-02.
    ``A -SS+3d-> B`` measures from 03-02 (B on 03-05), not from A's floored start.
    """
    p = Task(id="P", name="P", duration=timedelta(days=5))
    a = _started()
    b = Task(id="B", name="B", duration=timedelta(days=3))
    project = Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[p, a, b],
        dependencies=[
            Dependency("P", "A"),
            Dependency("A", "B", DependencyType.SS, timedelta(days=3)),
        ],
        calendar=Calendar(working_days=WEEKDAYS),
    )
    res = {t.id: t for t in schedule(project).tasks}
    assert res["A"].early_start == date(2026, 3, 9)
    assert res["B"].early_start == date(2026, 3, 5)


def test_ss_link_out_of_a_started_task_imposes_no_late_bound_on_it() -> None:
    """A started task's remaining work cannot slip B through SS: it is not critical by it.

    ``A`` (started, 20d, 20%) -SS+2d-> ``B`` (30d) leaves ``B`` driving the finish. The
    old inversion gave ``A`` a late start of 03-04, floored to its early start, so a
    task with weeks of slack was reported critical. It now carries the float its
    remaining work actually has against the project finish.
    """
    a = _started()
    b = Task(id="B", name="B", duration=timedelta(days=30))
    project = Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[a, b],
        dependencies=[Dependency("A", "B", DependencyType.SS, timedelta(days=2))],
        calendar=Calendar(working_days=WEEKDAYS),
        status_date=date(2026, 3, 9),
    )
    res = {t.id: t for t in schedule(project).tasks}
    assert res["B"].is_critical
    assert not res["A"].is_critical
    assert res["A"].total_float is not None and res["A"].total_float > timedelta(0)
    assert res["A"].free_float == res["A"].total_float
    # The link still drives B (B sits on the data date, not on the link's 03-04).
    assert res["B"].early_start == date(2026, 3, 9)


def test_ss_link_out_of_a_started_task_is_reported_as_driving() -> None:
    """When the recorded start is what holds B, the link is B's driving edge."""
    a = _started()
    b = Task(id="B", name="B", duration=timedelta(days=3))
    project = Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[a, b],
        dependencies=[Dependency("A", "B", DependencyType.SS, timedelta(days=10))],
        calendar=Calendar(working_days=WEEKDAYS),
        status_date=date(2026, 3, 4),
    )
    res = schedule(project)
    assert {(e.predecessor_id, e.successor_id) for e in res.driving_edges} == {("A", "B")}


def test_milestone_successor_measures_from_the_recorded_start() -> None:
    """``A -SS+10d-> M``: M is the instant 03-12 at either data date."""

    def m(status: date) -> date | None:
        a = _started()
        ms = Task(id="M", name="M", duration=timedelta(0))
        project = Project(
            id="p",
            name="p",
            start_date=START,
            tasks=[a, ms],
            dependencies=[Dependency("A", "M", DependencyType.SS, timedelta(days=10))],
            calendar=Calendar(working_days=WEEKDAYS),
            status_date=status,
        )
        return next(t for t in schedule(project).tasks if t.id == "M").early_start

    assert m(date(2026, 3, 4)) == m(date(2026, 3, 6)) == date(2026, 3, 12)


@pytest.mark.parametrize("dep_type", [DependencyType.SS, DependencyType.SF])
@pytest.mark.parametrize("lag", [0, 4, 10, 25])
@pytest.mark.parametrize("actual", [START, date(2026, 3, 1)])
@pytest.mark.parametrize("status", [date(2026, 3, 3), date(2026, 3, 5)])
def test_monte_carlo_matches_schedule_on_a_zero_variance_project(
    dep_type: DependencyType, lag: int, actual: date, status: date
) -> None:
    """Zero-variance MC lands on the CPM finish (MC reads the recorded start too).

    ``B`` is long enough to drive the finish, so a Monte Carlo pass still anchoring
    on the remaining-work window would finish after ``schedule()``.
    """
    pred = _started(actual=actual)
    b = Task(id="B", name="B", duration=timedelta(days=30))
    project = Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[pred, b],
        dependencies=[Dependency("A", "B", dep_type, timedelta(days=lag))],
        calendar=Calendar(working_days=WEEKDAYS),
        status_date=status,
    )
    cpm = schedule(project).project_finish
    mc = monte_carlo(project, runs=20, seed=1)
    assert mc.p50 == mc.p95 == cpm


def test_per_task_calendar_holiday_on_the_bound() -> None:
    """The bound snaps on the successor's calendar, from the recorded start."""
    pred = _started()
    b = Task(id="B", name="B", duration=timedelta(days=3), calendar_id="hol")
    hol = Calendar(
        working_days=WEEKDAYS,
        exceptions=[DateRange(start=date(2026, 3, 12), end=date(2026, 3, 13))],
    )
    for status in (date(2026, 3, 4), date(2026, 3, 6)):
        project = Project(
            id="p",
            name="p",
            start_date=START,
            tasks=[pred, b],
            dependencies=[Dependency("A", "B", DependencyType.SS, timedelta(days=10))],
            calendar=Calendar(working_days=WEEKDAYS),
            calendars={"hol": hol},
            status_date=status,
        )
        es = next(t for t in schedule(project).tasks if t.id == "B").early_start
        assert es == date(2026, 3, 16)
