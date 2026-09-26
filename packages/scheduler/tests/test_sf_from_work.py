"""Start-to-Finish from ordinary work: the MS Project / Primavera P6 reading (#4145).

An SF link anchors on the last working day *before* its predecessor's start day, not
on the start day itself — MSP and P6 finish the successor at the *start* of that day.
Before #4145 the ordinary-work branch of ``engine._edge_anchor`` anchored on the start
day, so it scheduled one working day later than both its own milestone branch (which
#4079 had already put on the MSP/P6 reading) and the source plan an MS Project import
came from.

Every date here is computed by hand from the MSP/P6 definition and pinned absolutely.
That matters because the cross-engine conformance corpus
(``packages/wasm-scheduler/fixtures/``) proves only that the Python and Rust engines
*agree* — a rule ported faithfully to both is invisible to it. These cases are the
independent oracle; the inverses are additionally checked differentially, by moving the
predecessor and observing what the successor does, so they cannot pass on a transcribed
number that happens to match the code.

Kept in its own file to stay clear of the large, churning ``test_engine.py``, next to
``test_negative_lag.py`` which follows the same convention.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    ScheduleResult,
    Task,
    monte_carlo,
    schedule,
)

# Monday. The default calendar is Mon-Fri, so the working day before it is Fri 02-27.
PROJECT_START = date(2026, 3, 2)


def _sf(
    lag_days: int,
    a_planned_start: date | None = None,
    *,
    a_dur: int = 3,
    b_dur: int = 2,
    b_planned_start: date | None = None,
    z_dur: int = 0,
) -> dict[str, Task]:
    """A(a_dur) ─SF(lag)─► B(b_dur), project anchored Monday 2026-03-02.

    ``a_planned_start`` is an SNET that lifts A off the project-start floor. Without
    it A sits on the first working day and its SF anchor falls *before* the project
    opens, where the bound is dominated by B's own duration and nothing is tested.

    ``b_planned_start`` holds B's finish out beyond the bound, which is what gives A
    slack on the link: when the SF bound *is* B's finish the relationship free float
    is zero by definition and there is no slip to measure.

    ``z_dur`` adds an unconnected long pole, pushing the project finish out so A's
    *total* float exceeds its link slack. ``free_float`` is clamped at ``total_float``,
    so without the pole it reports the clamp rather than the relationship slack the
    inverse actually computed.
    """
    tasks = [
        Task(id="A", name="A", duration=timedelta(days=a_dur), planned_start=a_planned_start),
        Task(id="B", name="B", duration=timedelta(days=b_dur), planned_start=b_planned_start),
    ]
    if z_dur:
        tasks.append(Task(id="Z", name="Z", duration=timedelta(days=z_dur)))
    project = Project(
        id="sf",
        name="sf",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=tasks,
        dependencies=[
            Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=lag_days))
        ],
    )
    return {t.id: t for t in schedule(project).tasks}


# ---------------------------------------------------------------------------
# Forward pass — the three reference cases the issue asks for
# ---------------------------------------------------------------------------


def test_sf_lag_zero_finishes_the_working_day_before_the_predecessor_start() -> None:
    """Lag 0: B's last working day is the day before A's start day.

    A is pinned to Mon 03-09. MSP/P6 put B's finish at the *start* of that day, so
    B's last working day is Fri 03-06 — the previous working day, the weekend being
    skipped. B is 2 days, so it starts Thu 03-05. The pre-#4145 anchor (A's start day
    itself) finished B on Mon 03-09 and started it Fri 03-06.
    """
    by = _sf(0, date(2026, 3, 9))
    assert by["A"].early_start == date(2026, 3, 9)  # Mon
    assert by["B"].early_finish == date(2026, 3, 6)  # Fri — the day BEFORE A's start
    assert by["B"].early_start == date(2026, 3, 5)  # Thu
    # Stated as the rule rather than as a date, so a future calendar change to this
    # fixture cannot quietly turn the case into a different one.
    assert by["B"].early_finish < by["A"].early_start


def test_sf_positive_lag_counts_from_the_day_before_the_start() -> None:
    """Positive lag is measured from the anchor, one working day earlier than the start.

    A is pinned to Tue 03-10, so the anchor is Mon 03-09. + 2 calendar days = Wed
    03-11, already a working day, so there is no snap and B must finish exactly then;
    B is 2 days, so it starts Tue 03-10. The pre-#4145 anchor (Tue 03-10) gave Thu
    03-12 — one working day later, the bug this issue fixes.
    """
    by = _sf(2, date(2026, 3, 10))
    assert by["A"].early_start == date(2026, 3, 10)  # Tue
    assert by["B"].early_finish == date(2026, 3, 11)  # Wed
    assert by["B"].early_start == date(2026, 3, 10)  # Tue


def test_sf_lag_across_a_weekend_snaps_forward() -> None:
    """A lag that lands on a non-working day snaps FORWARD, on the successor's calendar.

    Anchor Mon 03-09 + 5 calendar days = Sat 03-14, which is not a working day and
    resolves to Mon 03-16 (never back to Fri 03-13 — the bound is a lower bound on
    the finish). B is 2 days, so it starts Fri 03-13.
    """
    by = _sf(5, date(2026, 3, 10))
    assert by["B"].early_finish == date(2026, 3, 16)  # Mon, forward-snapped from Sat
    assert by["B"].early_start == date(2026, 3, 13)  # Fri


@pytest.mark.parametrize("lag_days", [0, 1, 2, 5, 7])
def test_sf_from_work_matches_sf_from_a_milestone_at_the_same_instant(lag_days: int) -> None:
    """The consistency #4145 restores: one instant, one answer.

    A task starting on day D and a zero-duration milestone standing at the midnight
    that opens day D are at the same point in time, so an SF link out of either must
    impose the same bound. The milestone branch has read it the MSP/P6 way since
    #4079; the work branch did not, and the two disagreed by one working day — the
    internal contradiction that is the ground for this change.
    """
    snet = date(2026, 3, 9)
    project = Project(
        id="sf-equiv",
        name="sf-equiv",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=[
            # Both are held at the START of Mon 03-09 by the same SNET: A as work,
            # M as an instant.
            Task(id="A", name="A", duration=timedelta(days=3), planned_start=snet),
            Task(id="B", name="B", duration=timedelta(days=2)),
            Task(id="M", name="M", duration=timedelta(0), planned_start=snet),
            Task(id="C", name="C", duration=timedelta(days=2)),
        ],
        dependencies=[
            Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=lag_days)),
            Dependency("M", "C", dep_type=DependencyType.SF, lag=timedelta(days=lag_days)),
        ],
    )
    by = {t.id: t for t in schedule(project).tasks}
    assert by["A"].early_start == by["M"].early_start == snet
    assert by["B"].early_finish == by["C"].early_finish
    assert by["B"].early_start == by["C"].early_start
    assert by["B"].late_finish == by["C"].late_finish
    assert by["B"].free_float == by["C"].free_float


# ---------------------------------------------------------------------------
# The inverses — checked differentially against the forward pass
# ---------------------------------------------------------------------------


def _slip(by: dict[str, Task], working_days: int, cal: Calendar) -> date:
    """A's early start moved ``working_days`` working days later."""
    d = by["A"].early_start
    assert d is not None
    for _ in range(working_days):
        d += timedelta(days=1)
        while not cal.is_working_day(d):
            d += timedelta(days=1)
    return d


@pytest.mark.parametrize("lag_days", [0, 2, 5])
def test_sf_free_float_is_exactly_the_slip_that_leaves_the_successor_unmoved(
    lag_days: int,
) -> None:
    """``_sf_latest_start`` inverts the forward anchor exactly, not approximately.

    Free float on a link is by definition the slip the predecessor can absorb without
    moving the successor's early dates. So re-pin A that many working days later and
    B must not move; re-pin it one working day beyond and B must move. This is an
    independent check on the inverse: it never names the bound, it observes the
    forward pass obeying it. The pre-#4145 inverse was one working day short of the
    forward anchor and fails the second half.
    """
    cal = Calendar()
    # B is pinned to Mon 03-16 so its finish (Tue 03-17) sits beyond the bound and A
    # has real slack on the link. With B unpinned the bound IS B's finish and the
    # relationship free float is zero, leaving no slip to measure. Z is the long pole
    # that keeps free_float off its total_float clamp.
    pinned = {"b_planned_start": date(2026, 3, 16), "z_dur": 25}
    base = _sf(lag_days, date(2026, 3, 10), **pinned)  # type: ignore[arg-type]
    slack = base["A"].free_float.days
    assert slack >= 1, "the case must leave A some slack or it proves nothing"
    assert base["A"].total_float > base["A"].free_float, "the clamp must be out of the way"

    unmoved = _sf(lag_days, _slip(base, slack, cal), **pinned)  # type: ignore[arg-type]
    assert unmoved["B"].early_finish == base["B"].early_finish
    assert unmoved["B"].early_start == base["B"].early_start

    moved = _sf(lag_days, _slip(base, slack + 1, cal), **pinned)  # type: ignore[arg-type]
    assert moved["B"].early_finish is not None and base["B"].early_finish is not None
    assert moved["B"].early_finish > base["B"].early_finish


def test_sf_backward_pass_late_start_is_the_latest_start_that_holds_the_finish() -> None:
    """The backward inverse: A may start as late as its late_start and no later.

    A long parallel pole (Z) pushes the project finish out so A's late start is set by
    the SF link rather than by the project-finish seed. Re-pinning A to that late start
    must leave the project finish where it is; one working day later must push it out.
    The project finish is the oracle because that is what a late date *promises*: the
    latest this task can start without delaying the project.
    """
    cal = Calendar()

    def build(a_snet: date) -> ScheduleResult:
        project = Project(
            id="sf-bwd",
            name="sf-bwd",
            start_date=PROJECT_START,
            calendar=cal,
            tasks=[
                Task(id="A", name="A", duration=timedelta(days=2), planned_start=a_snet),
                Task(id="B", name="B", duration=timedelta(days=2)),
                Task(id="Z", name="Z", duration=timedelta(days=20)),
            ],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=5))],
        )
        return schedule(project)

    base = build(date(2026, 3, 10))
    a = {t.id: t for t in base.tasks}["A"]
    late_start = a.late_start
    assert late_start is not None and a.early_start is not None
    assert late_start > a.early_start, "the SF link must leave A some float"

    assert build(late_start).project_finish == base.project_finish

    one_day_on = late_start + timedelta(days=1)
    while not cal.is_working_day(one_day_on):
        one_day_on += timedelta(days=1)
    assert build(one_day_on).project_finish > base.project_finish


# ---------------------------------------------------------------------------
# Monte Carlo agrees with CPM on the same rule
# ---------------------------------------------------------------------------


def test_monte_carlo_matches_cpm_for_sf_from_work_at_the_index_start() -> None:
    """Zero-variance Monte Carlo must reproduce the CPM finish for an SF-from-work edge.

    The vectorised simulation resolves an ordinary predecessor's SF bound from a
    lag-delta array indexed by the predecessor's working-day *start* offset
    (``engine._build_lag_delta``). Under #4145 the anchor is offset ``k - 1``, so
    ``k = 0`` — a predecessor starting on the project's first working day — reaches an
    anchor that is *outside* the working-day index and has to be resolved against the
    calendar itself. Here A starts on the index's first day and the lag is large
    enough that the bound lands inside the index, so a wrong ``k = 0`` cell moves the
    simulated finish off CPM: anchor Fri 02-27 + 6 calendar days = Thu 03-05, one
    working day past A's own finish.
    """
    project = Project(
        id="sf-mc",
        name="sf-mc",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=3)),
            Task(id="B", name="B", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=6))],
    )
    result = schedule(project)
    by = {t.id: t for t in result.tasks}
    assert by["A"].early_finish == date(2026, 3, 4)  # Wed
    assert by["B"].early_finish == date(2026, 3, 5)  # Thu — the SF bound, not A's finish
    assert result.project_finish == date(2026, 3, 5)

    mc = monte_carlo(project, runs=32, seed=1, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish
    assert all(d == result.project_finish for d in mc.distribution)
