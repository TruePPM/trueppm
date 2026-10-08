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
from trueppm_scheduler.derive import Quantity, derive_value

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
    opens — which, since #4218, is where B is placed: an SF-only task is not floored
    at the project start (see ``test_sf_anchor_before_the_project_start_places_the_
    successor_there`` below).

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


@pytest.mark.parametrize(
    ("lag", "c_dur", "b_finish", "finish"),
    [
        # Zero lag anchors on offset k - 1 (#4145): for k = 0 that is Fri 02-27,
        # outside the index, resolved against the calendar. B finishes there and C
        # (FS, 10d) carries it to the finish: Mon 03-02..Fri 03-13.
        (0, 10, date(2026, 2, 27), date(2026, 3, 13)),
        # A positive lag anchors on the day before the start itself (#4333), Sun
        # 03-01: + 6 calendar days = Sat 03-07, snapped to Mon 03-09 — past A's own
        # Wed 03-04 finish, so the SF bound is the project finish.
        (6, 0, date(2026, 3, 9), date(2026, 3, 9)),
    ],
)
def test_monte_carlo_matches_cpm_for_sf_from_work_at_the_index_start(
    lag: int, c_dur: int, b_finish: date, finish: date
) -> None:
    """Zero-variance Monte Carlo must reproduce the CPM finish for an SF-from-work edge.

    The vectorised simulation resolves an ordinary predecessor's SF bound from a
    lag-delta array indexed by the predecessor's working-day *start* offset
    (``engine._build_lag_delta``). Under #4145 the zero-lag anchor is offset
    ``k - 1``, so ``k = 0`` — a predecessor starting on the project's first working
    day — reaches an anchor that is *outside* the working-day index and has to be
    resolved against the calendar itself; a positive lag anchors on the calendar day
    before ``k`` (#4333). A starts on the index's first day in both cases, so a
    wrong ``k = 0`` cell moves the simulated finish off CPM.
    """
    tasks = [
        Task(id="A", name="A", duration=timedelta(days=3)),
        Task(id="B", name="B", duration=timedelta(days=2)),
    ]
    deps = [Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=lag))]
    if c_dur:
        tasks.append(Task(id="C", name="C", duration=timedelta(days=c_dur)))
        deps.append(Dependency("B", "C"))
    project = Project(
        id="sf-mc",
        name="sf-mc",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=tasks,
        dependencies=deps,
    )
    result = schedule(project)
    by = {t.id: t for t in result.tasks}
    assert by["A"].early_finish == date(2026, 3, 4)  # Wed
    assert by["B"].early_finish == b_finish
    assert result.project_finish == finish

    mc = monte_carlo(project, runs=32, seed=1, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish
    assert all(d == result.project_finish for d in mc.distribution)


# ---------------------------------------------------------------------------
# #4218 — an SF anchor before the project start is not floored away
# ---------------------------------------------------------------------------


def _schedule(
    tasks: list[Task],
    deps: list[Dependency],
    status_date: date | None = None,
) -> ScheduleResult:
    return schedule(
        Project(
            id="sf-pre",
            name="sf-pre",
            start_date=PROJECT_START,
            calendar=Calendar(),
            tasks=tasks,
            dependencies=deps,
            status_date=status_date,
        )
    )


def _sf_dep(pred: str, succ: str, lag_days: int = 0) -> Dependency:
    return Dependency(pred, succ, dep_type=DependencyType.SF, lag=timedelta(days=lag_days))


def _days(n: int) -> timedelta:
    return timedelta(days=n)


def test_sf_anchor_before_the_project_start_places_the_successor_there() -> None:
    """The #4218 repro: A opens the project, B's SF anchor is the Friday before.

    A (no SNET) starts Mon 03-02, the project's first working day; the SF anchor is
    the working day before it, Fri 02-27. B (2d) must finish then, so it runs Thu
    02-26..Fri 02-27 — before the nominal project start. The project-start floor
    used to hold B on Mon 03-02 as if the link did not exist.
    """
    by = _sf(0)
    assert by["A"].early_start == PROJECT_START
    assert by["B"].early_finish == date(2026, 2, 27)  # Fri — the day before A
    assert by["B"].early_start == date(2026, 2, 26)  # Thu, before the project opens
    assert by["B"].early_start < PROJECT_START


def test_the_result_project_start_follows_the_earliest_task() -> None:
    """``ScheduleResult.project_start`` is the earliest early start, so it moves too."""
    result = _schedule(
        [Task(id="A", name="A", duration=_days(3)), Task(id="B", name="B", duration=_days(2))],
        [_sf_dep("A", "B")],
    )
    assert result.project_start == date(2026, 2, 26)


def test_sf_lag_that_lands_inside_the_project_still_pulls_the_start_before_it() -> None:
    """The bound can be after the project start while the task still starts before it.

    A positive lag counts from the day A's start instant closes, Sun 03-01 (#4333):
    + 1 calendar day = Mon 03-02, so B (5d) must finish Mon 03-02 and starts Tue
    02-24. Before #4218 B sat on Mon 03-02..Fri 03-06: it satisfied the finish
    bound, but three days late against the SF placement MS Project gives it.
    """
    by = _sf(1, b_dur=5)
    assert by["B"].early_finish == PROJECT_START
    assert by["B"].early_start == date(2026, 2, 24)


def test_floats_stay_consistent_for_a_pre_start_task() -> None:
    """Backward pass and float read the pre-start placement like any other.

    B finishes Fri 02-27 and nothing follows it, so its late finish is the project
    finish, A's Wed 03-04: B's total float is the three working days in between.
    A drives B through the link, so A's free float is 0 and A is critical. Late
    dates never fall before early dates.
    """
    by = _sf(0, a_dur=3)
    a, b = by["A"], by["B"]
    assert b.late_finish == a.early_finish == date(2026, 3, 4)
    assert b.total_float == b.free_float == _days(3)  # Mon, Tue, Wed
    assert a.free_float == _days(0)
    assert a.is_critical
    for t in (a, b):
        assert t.late_start is not None and t.early_start is not None
        assert t.late_start >= t.early_start


def test_the_data_date_still_floors_an_sf_only_task() -> None:
    """The data date is not the project start: remaining work is never forecast
    into the past, so an SF anchor behind it leaves the task late, not early.

    With the status date on the project start (the #4218 import fixture's own
    shape before it was corrected), B is held on Mon 03-02; the finish is then
    driven by B's duration, not the SF bound.
    """
    result = _schedule(
        [Task(id="A", name="A", duration=_days(3)), Task(id="B", name="B", duration=_days(2))],
        [_sf_dep("A", "B")],
        status_date=PROJECT_START,
    )
    b = {t.id: t for t in result.tasks}["B"]
    assert b.early_start == PROJECT_START
    assert b.early_finish == date(2026, 3, 3)


def test_a_data_date_before_the_project_start_floors_there_not_at_the_start() -> None:
    """Only the project-start floor is lifted: a data date before it still binds.

    B (5d) would start Tue 02-24 (see the lagged case above); a status date of
    Wed 02-25 holds it there, so it runs Wed 02-25..Tue 03-03 — still before the
    project start, never before "as of now".
    """
    result = _schedule(
        [Task(id="A", name="A", duration=_days(3)), Task(id="B", name="B", duration=_days(5))],
        [_sf_dep("A", "B", 1)],
        status_date=date(2026, 2, 25),
    )
    b = {t.id: t for t in result.tasks}["B"]
    assert b.early_start == date(2026, 2, 25)
    assert b.early_finish == date(2026, 3, 3)


def test_an_snet_on_the_sf_successor_still_wins() -> None:
    """SNET is the PM's own constraint, not the project floor: it keeps binding."""
    by = _sf(0, b_planned_start=date(2026, 3, 4))
    assert by["B"].early_start == date(2026, 3, 4)


def test_an_snet_before_the_project_start_binds_an_sf_only_task() -> None:
    """…including an SNET that is itself before the project start (Wed 02-25)."""
    by = _sf(0, b_dur=5, b_planned_start=date(2026, 2, 25))
    # SF alone would start B Mon 02-23 (5d finishing Fri 02-27); the SNET wins.
    assert by["B"].early_start == date(2026, 2, 25)


def test_a_binding_lead_on_an_sf_linked_task_may_sit_before_the_start() -> None:
    """Mixed FS + SF where the FS lead binds, before the project start (#4220).

    C (2d) would run Thu 02-26..Fri 02-27 on its SF link from A. X (3d) ends Wed
    03-04, so FS-6 lands on Fri 02-27: later than the SF placement, so the FS lead
    binds. C's project-start floor is ``min(project start, SF placement)`` = Thu
    02-26, so the lead is not floored: C runs Fri 02-27..Mon 03-02.
    """
    result = _schedule(
        [
            Task(id="A", name="A", duration=_days(3)),
            Task(id="X", name="X", duration=_days(3)),
            Task(id="C", name="C", duration=_days(2)),
        ],
        [
            _sf_dep("A", "C"),
            Dependency("X", "C", dep_type=DependencyType.FS, lag=_days(-6)),
        ],
    )
    c = {t.id: t for t in result.tasks}["C"]
    assert c.early_start == date(2026, 2, 27)
    assert c.early_finish == PROJECT_START


def test_a_lead_on_a_task_with_no_sf_link_stays_floored() -> None:
    """Without an SF link there is no SF placement, so the floor is the project
    start: the same FS-6 lead holds C on Mon 03-02, exactly as before #4218."""
    result = _schedule(
        [Task(id="X", name="X", duration=_days(3)), Task(id="C", name="C", duration=_days(2))],
        [Dependency("X", "C", dep_type=DependencyType.FS, lag=_days(-6))],
    )
    c = {t.id: t for t in result.tasks}["C"]
    assert c.early_start == PROJECT_START


def test_a_non_binding_fs_lead_leaves_the_sf_placement_alone() -> None:
    """Mixed FS + SF where the SF link binds: no floor (#4220).

    The FS lead from X lands on Mon 02-23, earlier than the SF bound (C must finish
    Fri 02-27), so C sits on Fri 02-27. Before #4220 any FS link on the task
    floored it on Mon 03-02.
    """
    result = _schedule(
        [
            Task(id="A", name="A", duration=_days(3)),
            Task(id="X", name="X", duration=_days(3)),
            Task(id="C", name="C", duration=_days(1)),
        ],
        [
            _sf_dep("A", "C"),
            Dependency("X", "C", dep_type=DependencyType.FS, lag=_days(-10)),
        ],
    )
    c = {t.id: t for t in result.tasks}["C"]
    assert c.early_start == c.early_finish == date(2026, 2, 27)


# ---------------------------------------------------------------------------
# #4220 — the floor is min(project start, SF placement): placements are monotone
# ---------------------------------------------------------------------------


def _repro_4220(*, with_ss: bool, extra: list[Dependency] | None = None) -> dict[str, Task]:
    """The #4220 repro: A ─SF─► D puts D on Fri 02-27, before the project start.

    B is SF-only from A (2d, Thu 02-26..Fri 02-27). ``with_ss`` adds B ─SS─► D,
    whose bound, Thu 02-26, is earlier than D's SF placement: it does not bind.
    """
    deps = [_sf_dep("A", "B"), _sf_dep("A", "D")]
    if with_ss:
        deps.append(Dependency("B", "D", dep_type=DependencyType.SS))
    result = _schedule(
        [
            Task(id="A", name="A", duration=_days(3)),
            Task(id="B", name="B", duration=_days(2)),
            Task(id="D", name="D", duration=_days(1)),
        ],
        deps + (extra or []),
    )
    return {t.id: t for t in result.tasks}


def test_adding_a_non_binding_ss_link_does_not_move_the_task_later() -> None:
    """The #4220 repro. Adding B ─SS─► D (bound Thu 02-26) must leave D on Fri 02-27.

    Before #4220 D stopped being "SF-only" the moment the link was added and jumped
    to the project-start floor, Mon 03-02: adding a link that constrains nothing
    moved the task a working day later. Negative control: fails on the old rule.
    """
    without, with_ss = _repro_4220(with_ss=False), _repro_4220(with_ss=True)
    assert without["B"].early_start == date(2026, 2, 26)
    assert without["D"].early_start == date(2026, 2, 27)
    assert with_ss["D"].early_start == without["D"].early_start
    assert with_ss["D"].early_finish == without["D"].early_finish


@pytest.mark.parametrize(
    ("dep_type", "lag_days"),
    [
        (DependencyType.FS, -10),
        (DependencyType.FS, -3),
        (DependencyType.SS, 0),
        (DependencyType.SS, -5),
        (DependencyType.FF, -1),
        (DependencyType.FF, -8),
    ],
)
def test_no_non_binding_link_moves_an_sf_placed_task(
    dep_type: DependencyType, lag_days: int
) -> None:
    """Monotonicity, over every non-SF type: a link that does not bind is inert.

    Each link here runs from pre-start B and proposes a bound no later than D's SF
    placement (Fri 02-27), so D must not move. A link that *does* bind moves D, and
    then the project-start floor applies — never earlier than the SF placement.
    """
    base = _repro_4220(with_ss=False)["D"]
    link = Dependency("B", "D", dep_type=dep_type, lag=_days(lag_days))
    moved = _repro_4220(with_ss=False, extra=[link])["D"]
    assert (moved.early_start, moved.early_finish) == (base.early_start, base.early_finish)


def test_adding_a_non_sf_link_never_moves_a_task_earlier_and_lags_are_monotone() -> None:
    """Sweep FS/SS/FF lags from B into D: D is never earlier than without the link,
    and for each type a shorter lag never finishes D later (#4220, #4273)."""
    base = _repro_4220(with_ss=False)["D"]
    assert base.early_start is not None
    for dep_type in (DependencyType.FS, DependencyType.SS, DependencyType.FF):
        previous: date | None = None
        for lag in range(-12, 6):
            link = Dependency("B", "D", dep_type=dep_type, lag=_days(lag))
            d = _repro_4220(with_ss=False, extra=[link])["D"]
            assert d.early_start is not None and d.early_finish is not None
            assert d.early_start >= base.early_start, (dep_type, lag)
            if previous is not None:
                assert d.early_finish >= previous, (dep_type, lag)
            previous = d.early_finish


def test_a_shorter_sf_lag_never_finishes_work_later() -> None:
    """The completeness-check counterexample to the first #4220 rule (#4273).

    T0 (1d) ─SF(lag)─► T2 (1d) and T1 (3d) ─FF-5─► T2. At lag 0 the SF link places T2
    on Fri 02-27 and the FF lead (Wed 03-04 - 5 = Fri 02-27) ties it. At lag -1 the
    SF bound moves to Thu 02-26, the FF lead is left binding — and the first #4220
    rule then floored T2 on Mon 03-02, so a shorter lag finished it later. Under
    ``min(project start, SF placement)`` T2 stays on Fri 02-27. Negative control:
    fails on b20274aa5.
    """

    def t2(lag: int) -> Task:
        result = _schedule(
            [
                Task(id="T0", name="T0", duration=_days(1)),
                Task(id="T1", name="T1", duration=_days(3)),
                Task(id="T2", name="T2", duration=_days(1)),
            ],
            [
                _sf_dep("T0", "T2", lag),
                Dependency("T1", "T2", dep_type=DependencyType.FF, lag=_days(-5)),
            ],
        )
        return {t.id: t for t in result.tasks}["T2"]

    assert t2(0).early_finish == date(2026, 2, 27)
    assert t2(-1).early_finish == date(2026, 2, 27)
    for lag in range(-6, 4):
        t_short, t_long = t2(lag - 1), t2(lag)
        assert t_short.early_finish is not None and t_long.early_finish is not None
        assert t_short.early_finish <= t_long.early_finish, lag


def test_an_upstream_sf_link_never_moves_a_downstream_task_later() -> None:
    """The completeness-check's upstream counterexample to the first #4220 rule.

    A (3d) ─SF─► T (1d) puts T on Fri 02-27; X (3d) ─FS-7─► T proposes Thu 02-26,
    which does not bind. Adding Z (3d) ─SF─► A pulls A back to Wed 02-25..Fri 02-27,
    so T's SF bound moves to Tue 02-24 and the FS lead becomes the binding one. The
    first #4220 rule then floored T on Mon 03-02 and its FS+5 successor S slid from
    Thu 03-05 to Mon 03-09. Making a predecessor earlier must never make anything
    later: T lands on the FS lead's Thu 02-26. Negative control: fails on b20274aa5.
    """

    def run(with_z: bool) -> dict[str, Task]:
        deps = [
            _sf_dep("A", "T"),
            Dependency("X", "T", dep_type=DependencyType.FS, lag=_days(-7)),
            Dependency("T", "S", dep_type=DependencyType.FS, lag=_days(5)),
        ]
        if with_z:
            deps.append(_sf_dep("Z", "A"))
        result = _schedule(
            [
                Task(id="A", name="A", duration=_days(3)),
                Task(id="X", name="X", duration=_days(3)),
                Task(id="Z", name="Z", duration=_days(3)),
                Task(id="T", name="T", duration=_days(1)),
                Task(id="S", name="S", duration=_days(1)),
            ],
            deps,
        )
        return {t.id: t for t in result.tasks}

    without, with_z = run(False), run(True)
    assert without["T"].early_start == date(2026, 2, 27)
    assert with_z["A"].early_start == date(2026, 2, 25)
    assert with_z["T"].early_start == date(2026, 2, 26)
    for tid in ("T", "S"):
        a, b = with_z[tid].early_finish, without[tid].early_finish
        assert a is not None and b is not None and a <= b, tid


def test_a_milestone_with_a_non_binding_ss_link_stays_before_the_project_start() -> None:
    """The milestone half of #4220: M's SF link proposes the end of Fri 02-27; an SS
    link from B proposes Thu 02-26's midnight, earlier, so M is still shown on Fri
    02-27 rather than floored on Mon 03-02."""
    result = _schedule(
        [
            Task(id="A", name="A", duration=_days(3)),
            Task(id="B", name="B", duration=_days(2)),
            Task(id="M", name="M", duration=_days(0)),
        ],
        [
            _sf_dep("A", "B"),
            _sf_dep("A", "M"),
            Dependency("B", "M", dep_type=DependencyType.SS),
        ],
    )
    m = {t.id: t for t in result.tasks}["M"]
    assert m.early_start == m.early_finish == date(2026, 2, 27)
    assert m.milestone_at_day_end


def _mixed_project(fs_lag_days: int, c_days: int) -> Project:
    """A ─SF─► C and X(3d) ─FS(lag)─► C, project start Mon 03-02."""
    return Project(
        id="sf-mixed-derive",
        name="sf-mixed-derive",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=[
            Task(id="A", name="A", duration=_days(3)),
            Task(id="X", name="X", duration=_days(3)),
            Task(id="C", name="C", duration=_days(c_days)),
        ],
        dependencies=[
            _sf_dep("A", "C"),
            Dependency("X", "C", dep_type=DependencyType.FS, lag=_days(fs_lag_days)),
        ],
    )


@pytest.mark.parametrize("quantity", [Quantity.EARLY_START, Quantity.EARLY_FINISH])
def test_derivation_offers_no_project_start_term_for_an_sf_linked_task(
    quantity: Quantity,
) -> None:
    """``derive_value`` matches the engine: C has an SF link, so the project start is
    not a candidate and the binding term's date is the engine's (#4220)."""
    project = _mixed_project(-10, 1)
    d = derive_value(project, "C", quantity)
    assert "project_start" not in {c.kind for c in d.contributions}
    assert d.binding is not None and d.binding.imposed_date == date(2026, 2, 27)


def test_derivation_names_a_binding_lead_on_an_sf_linked_task() -> None:
    """A binding FS lead places the SF-linked task before the start, and the
    derivation names that link, with no project-start candidate (#4220)."""
    project = _mixed_project(-6, 2)
    d = derive_value(project, "C", Quantity.EARLY_START)
    assert "project_start" not in {c.kind for c in d.contributions}
    assert d.binding is not None
    assert d.binding.kind == "predecessor_fs"
    assert d.binding.imposed_date == date(2026, 2, 27)


def test_the_data_date_still_floors_a_mixed_link_task() -> None:
    """Waiving the project start never waives the data date: D's SF link binds, but
    with the status date on Mon 03-02 D is held there like any remaining work."""
    result = _schedule(
        [
            Task(id="A", name="A", duration=_days(3)),
            Task(id="B", name="B", duration=_days(2)),
            Task(id="D", name="D", duration=_days(1)),
        ],
        [_sf_dep("A", "B"), _sf_dep("A", "D"), Dependency("B", "D", dep_type=DependencyType.SS)],
        status_date=PROJECT_START,
    )
    d = {t.id: t for t in result.tasks}["D"]
    assert d.early_start == PROJECT_START


@pytest.mark.parametrize(
    ("ss_lag", "expected"),
    [(0, date(2026, 2, 26)), (1, date(2026, 2, 27)), (5, date(2026, 3, 3))],
)
def test_monte_carlo_matches_cpm_for_a_mixed_link_task(ss_lag: int, expected: date) -> None:
    """Zero-variance Monte Carlo agrees with CPM for a mixed-link task (#4220).

    D (2d) carries an SF link (Thu 02-26..Fri 02-27) and an SS link from pre-start
    B (Thu 02-26). At lag 0 the SS bound ties the SF placement; at +1 it binds on
    Fri 02-27, still before the project start, and D stays there, since its floor
    is the SF placement; at +5 it binds past the start. C follows D by FS with a
    long lag, so D sets the project finish — and the pre-start pad must hold D.
    """
    project = Project(
        id="sf-mixed-mc",
        name="sf-mixed-mc",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=[
            Task(id="A", name="A", duration=_days(3)),
            Task(id="B", name="B", duration=_days(2)),
            Task(id="D", name="D", duration=_days(2)),
            Task(id="C", name="C", duration=_days(2)),
        ],
        dependencies=[
            _sf_dep("A", "B"),
            _sf_dep("A", "D"),
            Dependency("B", "D", dep_type=DependencyType.SS, lag=_days(ss_lag)),
            Dependency("D", "C", dep_type=DependencyType.FS, lag=_days(14)),
        ],
    )
    result = schedule(project)
    mc = monte_carlo(project, runs=16, seed=3, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish
    assert {t.id: t for t in result.tasks}["D"].early_start == expected


def test_multiple_sf_links_take_the_latest_bound() -> None:
    """Two SF predecessors: the later anchor places the task (max still applies).

    A starts Mon 03-02 (anchor Fri 02-27); P is held to Wed 03-04 (anchor Tue
    03-03). B (2d) must finish by the later, so it runs Mon 03-02..Tue 03-03.
    """
    result = _schedule(
        [
            Task(id="A", name="A", duration=_days(3)),
            Task(id="P", name="P", duration=_days(1), planned_start=date(2026, 3, 4)),
            Task(id="B", name="B", duration=_days(2)),
        ],
        [_sf_dep("A", "B"), _sf_dep("P", "B")],
    )
    b = {t.id: t for t in result.tasks}["B"]
    assert b.early_finish == date(2026, 3, 3)
    assert b.early_start == PROJECT_START


def test_an_sf_only_milestone_sits_before_the_project_start() -> None:
    """A zero-duration SF successor is the same rule as an instant: the end of Fri 02-27."""
    result = _schedule(
        [Task(id="A", name="A", duration=_days(3)), Task(id="M", name="M", duration=_days(0))],
        [_sf_dep("A", "M")],
    )
    m = {t.id: t for t in result.tasks}["M"]
    assert m.early_start == m.early_finish == date(2026, 2, 27)
    assert m.milestone_at_day_end


@pytest.mark.parametrize("status_date", [None, date(2026, 2, 20), PROJECT_START])
def test_monte_carlo_matches_cpm_before_the_project_start(status_date: date | None) -> None:
    """Zero-variance Monte Carlo agrees with CPM when SF work sits before the start.

    B (5d) is SF-only and ends Fri 02-27, starting a week before the project; D is
    SF-only from B, reaching further back; C follows B by FS with a long lag, so the
    pre-start placement is what sets the project finish. The simulation's
    working-day index opened on the project start and could not hold any of it
    until ``_mc_pre_start_pad_days`` (#4218); a floored B finished C a week late.
    """
    project = Project(
        id="sf-pre-mc",
        name="sf-pre-mc",
        start_date=PROJECT_START,
        calendar=Calendar(),
        status_date=status_date,
        tasks=[
            Task(id="A", name="A", duration=_days(1)),
            Task(id="B", name="B", duration=_days(5)),
            Task(id="C", name="C", duration=_days(2)),
            Task(id="D", name="D", duration=_days(4)),
        ],
        dependencies=[
            _sf_dep("A", "B"),
            Dependency("B", "C", dep_type=DependencyType.FS, lag=_days(14)),
            _sf_dep("B", "D"),
        ],
    )
    result = schedule(project)
    mc = monte_carlo(project, runs=16, seed=3, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish
    if status_date is None:
        by = {t.id: t for t in result.tasks}
        # B Mon 02-23..Fri 02-27; D's anchor is Fri 02-20, the working day before
        # B, so D runs Tue 02-17..Fri 02-20; C starts Fri 02-27 + 1 + 14 = Sat
        # 03-14, snapped to Mon 03-16, and finishes Tue 03-17.
        assert by["B"].early_start == date(2026, 2, 23)
        assert by["D"].early_start == date(2026, 2, 17)
        assert result.project_finish == date(2026, 3, 17)


# ---------------------------------------------------------------------------
# #4333 — a positive SF lag counts from the start instant, not a pre-snapped day
# ---------------------------------------------------------------------------


def _pair(start: date, lag: int, *, milestone: bool = False) -> Project:
    """T1 -SF(lag)-> T2(1d), both from the project start; T1 is 1d or a milestone."""
    return Project(
        id="sf-4333",
        name="sf-4333",
        start_date=start,
        calendar=Calendar(),
        tasks=[
            Task(id="11", name="T1", duration=_days(0 if milestone else 1)),
            Task(id="12", name="T2", duration=_days(1)),
        ],
        dependencies=[_sf_dep("11", "12", lag)],
    )


def test_the_4333_repro_finishes_on_tuesday_as_ms_project_does() -> None:
    """The issue's repro, checked against MPXJ's task-links-project2016 files.

    T1 starts Mon 2016-02-08. With +2d the successor finishes Tue 02-09: the lag
    counts from the day T1's start instant closes, Sun 02-07. Pre-snapping that
    anchor to Fri 02-05 put the lag on Sunday, snapped it to Monday, and finished
    T2 on Monday 02-08 — the whole lag absorbed by the weekend.
    """
    by = {t.id: t for t in schedule(_pair(date(2016, 2, 8), 2)).tasks}
    assert by["12"].early_start == by["12"].early_finish == date(2016, 2, 9)


@pytest.mark.parametrize(
    ("start", "expected"),
    [
        # Monday: the zero-lag anchor is the Friday before, the positive-lag one
        # Sunday. -2..+6 → Wed, Thu, Fri, Mon, Tue, Wed, Thu, Fri, then Sat → Mon.
        (
            date(2026, 3, 2),
            ["02-25", "02-26", "02-27", "03-02", "03-03", "03-04", "03-05", "03-06", "03-09"],
        ),
        # Wednesday and Thursday already matched MS Project and must not move:
        # their zero-lag anchor is the calendar day before the start anyway.
        (
            date(2026, 3, 4),
            ["03-02", "03-02", "03-03", "03-04", "03-05", "03-06", "03-09", "03-09", "03-09"],
        ),
        (
            date(2026, 3, 5),
            ["03-02", "03-03", "03-04", "03-05", "03-06", "03-09", "03-09", "03-09", "03-10"],
        ),
    ],
)
@pytest.mark.parametrize("milestone", [False, True])
def test_sf_finish_is_monotone_in_the_lag_on_every_start_day(
    start: date, expected: list[str], milestone: bool
) -> None:
    """A work predecessor and a start-of-day milestone predecessor agree (#4145), the
    finish never moves earlier as the lag grows, and only the Monday row changed."""
    finishes = []
    for lag, want in zip(range(-2, 7), expected, strict=True):
        by = {t.id: t for t in schedule(_pair(start, lag, milestone=milestone)).tasks}
        finish = by["12"].early_finish
        assert finish is not None
        assert finish.isoformat()[5:] == want, f"lag {lag}"
        finishes.append(finish)
    assert finishes == sorted(finishes)


def _add_working_days(day: date, n: int) -> date:
    """``day`` moved ``n`` Mon-Fri working days later (``day`` is a working day)."""
    while n > 0:
        day += _days(1)
        if day.weekday() < 5:
            n -= 1
    return day


@pytest.mark.parametrize("lag", [1, 2, 3, 5, 6, 7])
@pytest.mark.parametrize("milestone", [False, True])
@pytest.mark.parametrize("pole", [False, True])
def test_the_backward_pass_and_free_float_invert_the_new_anchor(
    lag: int, milestone: bool, pole: bool
) -> None:
    """Float is the forward rule's inverse, checked differentially (#4333).

    ``T1 -SF(lag)-> T2`` from Monday. Without a pole T2 sets the project finish and
    T1's *total* float is the slip it can take before that finish moves; with a
    long parallel pole Z the project finish is out of reach and T1's *free* float
    is the slip it can take before T2's early finish moves. Either way, an SNET
    that slips T1 by exactly its float leaves the measured date alone and one more
    working day moves it — so the inverse cannot pass on a transcribed number.
    Lags 6 and 7 land on the weekend, which legitimately gives T1 free float.
    """

    def build(slip: int | None) -> tuple[dict[str, Task], date]:
        project = _pair(PROJECT_START, lag, milestone=milestone)
        if slip is not None:
            project.tasks[0].planned_start = _add_working_days(PROJECT_START, slip)
        if pole:
            project.tasks.append(Task(id="Z", name="Z", duration=_days(30)))
        result = schedule(project)
        by = {t.id: t for t in result.tasks}
        measured = by["12"].early_finish if pole else result.project_finish
        assert measured is not None
        return by, measured

    base, measured = build(None)
    t1 = base["11"]
    slack = (t1.free_float if pole else t1.total_float).days
    if pole:
        # Sun 03-01 + 6 = Sat and + 7 = Sun, both shown Monday: two and one
        # working days of slip reach the same Monday; any other lag none.
        assert slack == {6: 2, 7: 1}.get(lag, 0)
    assert build(slack)[1] == measured, "slipping T1 by its float moved the date"
    assert build(slack + 1)[1] > measured, "T1's float is not the latest slip"


@pytest.mark.parametrize("milestone", [False, True])
def test_sf_into_a_milestone_counts_a_positive_lag_from_the_start(milestone: bool) -> None:
    """``T1 -SF+2d-> M -FS-> T3``: M is T1's start instant plus two days, Wed
    03-04 00:00 (the end of Tuesday), so T3 starts Wednesday — where a 1-day
    successor of the same link finishes Tuesday."""
    project = _pair(PROJECT_START, 2, milestone=milestone)
    project.tasks[1].duration = _days(0)
    project.tasks.append(Task(id="13", name="T3", duration=_days(1)))
    project.dependencies.append(Dependency("12", "13"))
    by = {t.id: t for t in schedule(project).tasks}
    assert by["12"].early_start == date(2026, 3, 3)
    assert by["12"].milestone_at_day_end
    assert by["13"].early_start == date(2026, 3, 4)


@pytest.mark.parametrize("milestone", [False, True])
@pytest.mark.parametrize("into_milestone", [False, True])
@pytest.mark.parametrize("lag", [1, 2, 3, 6])
def test_monte_carlo_matches_cpm_for_a_positive_sf_lag_from_a_monday(
    lag: int, milestone: bool, into_milestone: bool
) -> None:
    """Zero-variance Monte Carlo reproduces the new anchor on every path: the lag
    delta table (work), the per-run instant (milestone predecessor), and the
    vectorised milestone placement (into a milestone). A long FS tail after the
    successor makes its date the project finish."""
    project = _pair(PROJECT_START, lag, milestone=milestone)
    if into_milestone:
        project.tasks[1].duration = _days(0)
    project.tasks.append(Task(id="13", name="T3", duration=_days(10)))
    project.dependencies.append(Dependency("12", "13"))
    result = schedule(project)
    mc = monte_carlo(project, runs=16, seed=5, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish
