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

In-progress work with **no** recorded start (progress entered as a percentage only,
which several write paths produce) is measured from its derived span start,
``scheduled_start`` (ADR-0752): the full duration backed off from its forecast
finish. That start is not history — it moves with the remaining work — so the link
keeps its late-date bound, and the successor follows the task's span rather than
the data date plus the lag.
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
    engine,
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


def _started(pct: float = 20.0, actual: date | None = START) -> Task:
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
            (7, 9, 15),
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

    The data date starts at 03-03, already past the recorded start, so the old
    anchor (the data-date-floored ``early_start``) differs from the recorded one in
    every case, and each lag is long enough that the bound is still ahead of at
    least one later data date — the loop must compare something, or the case
    proves nothing (asserted). Lags at or below the gap between the actual and the
    data date cannot discriminate (the data date holds ``B`` under either anchor),
    so they are covered by known answers instead. Covers SS and SF, a started task
    with and without progress, a verbatim non-working ``actual_start`` and a
    successor on a different calendar.
    """
    base = _b(
        _project(_started(pct, actual), dep_type, lag, date(2026, 3, 3), succ_calendar=succ_cal)
    )
    compared = 0
    for day in range(4, 20):
        status = date(2026, 3, day)
        if status >= base[0]:
            break
        moved = _b(_project(_started(pct, actual), dep_type, lag, status, succ_calendar=succ_cal))
        assert moved == base, f"data date {status} moved B from {base} to {moved}"
        compared += 1
    assert compared > 0, f"no data date before B's start {base[0]}: the case is vacuous"


@pytest.mark.parametrize("dep_type", [DependencyType.SS, DependencyType.SF])
@pytest.mark.parametrize("lag", [-2, 0])
def test_lead_or_zero_lag_from_a_started_task_known_answers(
    dep_type: DependencyType, lag: int
) -> None:
    """A lead or zero lag from a started task's 03-02 start is behind any later data date.

    The bound (03-02 + lag for SS; the working day before 03-02, or its eve with a
    positive lag, for SF) lies before the 03-04 data date, which therefore holds
    ``B`` — under either anchor, which is why these lags sit outside the property.
    """
    es, _ = _b(_project(_started(), dep_type, lag, date(2026, 3, 4)))
    assert es == date(2026, 3, 4)


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
@pytest.mark.parametrize("actual", [START, date(2026, 3, 1), None])
@pytest.mark.parametrize("status", [date(2026, 3, 3), date(2026, 3, 5)])
def test_monte_carlo_matches_schedule_on_a_zero_variance_project(
    dep_type: DependencyType, lag: int, actual: date | None, status: date
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


# ---------------------------------------------------------------------------
# In progress with no recorded actual_start: the derived span start
# ---------------------------------------------------------------------------


def _ab(project: Project) -> tuple[Task, Task]:
    res = {t.id: t for t in schedule(project).tasks}
    return res["A"], res["B"]


def test_auditor_repro_no_actual_start_ss_follows_the_span_start() -> None:
    """``A`` (20d, 20%, no actual) ``-SS+6d-> B``.

    A's span starts 02-26 at a 03-04 data date and 03-03 at a 03-09 one; B is
    03-04 and 03-09 (the span plus six days, which the data date equals here).
    Before the fix B was the data date plus the lag: 03-10 and 03-16.
    """
    for status, span, b_start in (
        (date(2026, 3, 4), date(2026, 2, 26), date(2026, 3, 4)),
        (date(2026, 3, 9), date(2026, 3, 3), date(2026, 3, 9)),
    ):
        a, b = _ab(_project(_started(actual=None), DependencyType.SS, 6, status))
        assert a.scheduled_start == span
        assert b.early_start == b_start


@pytest.mark.parametrize(("pct", "lag"), [(20.0, 9), (20.0, 14), (60.0, 20), (60.0, 24)])
def test_no_actual_start_ss_successor_is_measured_from_scheduled_start(
    pct: float, lag: int
) -> None:
    """Property: B starts at ``next_wd(A.scheduled_start + lag)`` or the data date.

    Never at the data date plus the lag. Asserted over a range of data dates, and
    at least one of them must leave the link ahead of the data date, or the case
    would prove nothing (the data date holds B under either anchor).
    """
    weekdays = Calendar(working_days=WEEKDAYS)
    ahead = 0
    for day in range(3, 14):
        status = date(2026, 3, day)
        a, b = _ab(_project(_started(pct, actual=None), DependencyType.SS, lag, status))
        assert a.scheduled_start is not None and a.early_start is not None
        assert a.scheduled_start < a.early_start  # progress, so the span is earlier
        bound = engine._next_working_day(a.scheduled_start + timedelta(days=lag), weekdays)
        floor = engine._next_working_day(status, weekdays)
        assert b.early_start == max(bound, floor), status
        ahead += bound > floor
    assert ahead > 0


def test_no_actual_start_sf_successor_is_measured_from_scheduled_start() -> None:
    """``A`` (20d, 20%, no actual) ``-SF+12d-> B`` at a 03-04 data date.

    A's span starts 02-26, so B finishes on 02-25 + 12 = Mon 03-09. Measured from
    the remaining window (03-04) it was 03-03 + 12 = Sun 03-15, snapped to 03-16.
    """
    a, b = _ab(_project(_started(actual=None), DependencyType.SF, 12, date(2026, 3, 4)))
    assert a.scheduled_start == date(2026, 2, 26)
    assert b.early_finish == date(2026, 3, 9)


def test_no_actual_start_link_keeps_its_late_date_bound() -> None:
    """A derived span start is not history: slipping A's remaining work slips B.

    ``A`` (20d, 50%, no actual) ``-SS+16d-> B`` (30d) at a 03-09 data date: A's
    span starts 02-23, B starts 03-11 and drives the finish. A day's slip of A's
    remaining work moves its span, and so B, a day — so A is critical through the
    link, its free float is zero, and the link drives B. (A recorded start would
    bound nothing; see ``test_ss_link_out_of_a_started_task_imposes_no_late_bound_on_it``.)
    """
    a = _started(50.0, actual=None)
    b = Task(id="B", name="B", duration=timedelta(days=30))
    project = Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[a, b],
        dependencies=[Dependency("A", "B", DependencyType.SS, timedelta(days=16))],
        calendar=Calendar(working_days=WEEKDAYS),
        status_date=date(2026, 3, 9),
    )
    res = schedule(project)
    by = {t.id: t for t in res.tasks}
    assert by["A"].scheduled_start == date(2026, 2, 23)
    assert by["B"].early_start == date(2026, 3, 11)
    assert by["A"].is_critical and by["B"].is_critical
    assert by["A"].total_float == by["A"].free_float == timedelta(0)
    assert {(e.predecessor_id, e.successor_id) for e in res.driving_edges} == {("A", "B")}


def test_no_actual_start_with_no_elapsed_work_is_unchanged() -> None:
    """5% of 10 days rounds to no elapsed day: the span start is the early start."""
    pred = Task(id="A", name="A", duration=timedelta(days=10), percent_complete=5.0)
    a, b = _ab(_project(pred, DependencyType.SS, 3, date(2026, 3, 4)))
    assert a.scheduled_start == a.early_start == date(2026, 3, 4)
    assert b.early_start == date(2026, 3, 9)
