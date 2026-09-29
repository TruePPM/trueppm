"""Zero-duration milestones are instants, not one-day tasks (#4079).

Standard CPM (PMBOK, MS Project, Primavera P6) treats a zero-duration activity as
a point in time, so adding a milestone to a finish-to-start chain never moves
anything downstream. The engine used to give every milestone a working day, which
delayed everything behind it by one working day per milestone on the path.

The central check here is a **property**, not a snapshot: inserting a milestone
into any FS link ``A -> B`` must leave every other task's dates and float exactly
as they were. A snapshot cannot catch this class — the cross-engine conformance
corpus agreed with itself for as long as both engines carried the extra day.
"""

from __future__ import annotations

import copy
from datetime import date, timedelta

import pytest
from hypothesis import assume, example, given
from hypothesis import strategies as st

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    Project,
    Quantity,
    ScheduleResult,
    Task,
    derive_value,
    monte_carlo,
    schedule,
)

MON = date(2026, 1, 5)


def _task(tid: str, days: int) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days))


def _dep(
    pred: str, succ: str, dep_type: DependencyType = DependencyType.FS, lag: int = 0
) -> Dependency:
    return Dependency(pred, succ, dep_type=dep_type, lag=timedelta(days=lag))


def _project(
    tasks: list[Task], deps: list[Dependency], calendar: Calendar | None = None
) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=tasks,
        dependencies=deps,
        calendar=calendar or Calendar(),
    )


def _by_id(p: Project) -> dict[str, Task]:
    return {t.id: t for t in schedule(p).tasks}


# ---------------------------------------------------------------------------
# Property: inserting a milestone into an FS link changes nothing (#4079)
# ---------------------------------------------------------------------------


@st.composite
def _networks_with_an_fs_link(
    draw: st.DrawFn,
) -> tuple[list[Task], list[Dependency], tuple[str, str], int, int, Calendar]:
    """A small random DAG, one FS link in it to split, and the lag on each side of M.

    A negative lag goes on one side only: the milestone is a node with its own
    project-start and project-finish bounds, which a negative lag across it can
    reach where the direct link's combined lag does not — true of any node
    inserted into a negatively-lagged link, not a property of milestones.
    """
    n = draw(st.integers(min_value=2, max_value=7))
    durations = draw(st.lists(st.sampled_from([0, 1, 2, 3, 5]), min_size=n, max_size=n))
    tasks = [_task(f"T{i}", d) for i, d in enumerate(durations)]
    a = draw(st.integers(min_value=0, max_value=n - 2))
    b = draw(st.integers(min_value=a + 1, max_value=n - 1))
    deps: list[Dependency] = []
    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) == (a, b):
                continue
            if draw(st.booleans()) and draw(st.booleans()):
                deps.append(
                    _dep(
                        f"T{i}",
                        f"T{j}",
                        draw(st.sampled_from(list(DependencyType))),
                        draw(st.sampled_from([-2, 0, 0, 1, 3])),
                    )
                )
    lag_in = draw(st.sampled_from([-2, -1, 0, 0, 0, 1, 2, 3, 7]))
    lag_out = draw(st.sampled_from([-2, -1, 0, 0, 0, 1, 2, 3, 7]))
    if (lag_in < 0 and lag_out != 0) or (lag_out < 0 and lag_in != 0):
        lag_out = 0
    exceptions = [DateRange(date(2026, 1, 14), date(2026, 1, 15))] if draw(st.booleans()) else []
    return tasks, deps, (f"T{a}", f"T{b}"), lag_in, lag_out, Calendar(exceptions=exceptions)


@pytest.mark.fuzz
@given(_networks_with_an_fs_link())
def test_inserting_a_milestone_into_an_fs_link_moves_nothing(
    case: tuple[list[Task], list[Dependency], tuple[str, str], int, int, Calendar],
) -> None:
    """Every original task keeps its ES/EF/LS/LF and float; M sits on A's finish.

    ``A -FS(l1)-> M -FS(l2)-> B`` must schedule exactly as ``A -FS(l1+l2)-> B``:
    the milestone is a raw instant, never rounded to a working day, so calendar-day
    lags compose through it.

    Out of scope (#4223): this composition law is only checked here when A's own
    early_finish is not itself floored below the project start. A reaches there
    exactly when every one of ITS incoming links is SF (#4218's `_sf_only`; MS
    Project's one escape hatch for starting a task ahead of the project's nominal
    open) — the randomly-drawn extra edges above can make A that kind of SF-only
    node. When that happens, splitting the combined lag across an inserted
    milestone stops being lossless: `_place_milestone` floors the milestone at
    the project start (correctly — M's own only incoming link is the FS under
    test, not SF, so M does not inherit A's exemption), but a *positive* lag_out
    then measures forward from the milestone's real, floored position rather than
    from A's pre-floor instant, landing B on a later day than the direct,
    combined-lag network would. Whether that is the engine's correct behavior for
    a floored intermediate milestone (arguably yes — a downstream lag should
    count from where the checkpoint actually landed) or a composition bug the
    "raw instant" design (#4079) is supposed to rule out is an open question
    tracked in #4225, not resolved by this test. See
    test_milestone_after_an_sf_only_predecessor_is_still_floored_at_project_start
    below for a deterministic pin of the (non-controversial) M-placement half.
    """
    tasks, deps, (a, b), lag_in, lag_out, cal = case
    direct = _project(tasks, [*deps, _dep(a, b, lag=lag_in + lag_out)], cal)
    before = _by_id(direct)
    a_early_finish = before[a].early_finish
    assert a_early_finish is not None  # every scheduled task has one
    assume(a_early_finish >= MON)
    via_m = _project(
        [*tasks, _task("M", 0)],
        [*deps, _dep(a, "M", lag=lag_in), _dep("M", b, lag=lag_out)],
        cal,
    )
    after = _by_id(via_m)
    for tid, t in before.items():
        u = after[tid]
        assert (u.early_start, u.early_finish) == (t.early_start, t.early_finish), tid
        assert (u.late_start, u.late_finish) == (t.late_start, t.late_finish), tid
        assert u.total_float == t.total_float, tid
    if lag_in == 0 and durations_of(tasks, a) > 0:
        # With no lag between work and M, M is shown on that work's finish day.
        assert after["M"].early_start == after["M"].early_finish == before[a].early_finish


def durations_of(tasks: list[Task], tid: str) -> int:
    return next(t.duration.days for t in tasks if t.id == tid)


def test_milestone_after_an_sf_only_predecessor_is_still_floored_at_project_start() -> None:
    """A zero-lag FS milestone does not inherit its predecessor's SF-only exemption (#4223).

    ``T0 -SF(-2cd)-> T2`` makes T2 SF-only (#4218), so T2 is scheduled before the
    project start (2025-12-31, a Wednesday, vs. the Monday 2026-01-05 project
    start). Chaining a zero-lag milestone off T2 (``T2 -FS(0)-> M``) does not carry
    T2's exemption forward: M's own only incoming link is FS, not SF, so
    ``_place_milestone`` floors M at the project start — identically to how an
    ordinary FS successor in the same position is floored (T3 below, linked
    directly to T2 with the combined lag, lands on the same day M does).

    This is the deterministic pin for a `scheduler:fuzz-deep` finding that turned
    out to be a test-precondition gap, not an engine bug: the general "inserting a
    milestone into an FS link moves nothing" property above still holds for every
    original task; only its extra "M sits exactly on A's finish" assertion was
    too strong for an A pulled before the project start by an unrelated SF edge.
    """
    tasks = [_task("T0", 0), _task("T1", 0), _task("T2", 1), _task("T3", 0)]
    sf_pred = _dep("T0", "T2", DependencyType.SF, lag=-2)

    direct = _by_id(_project(tasks, [sf_pred, _dep("T2", "T3", lag=-2)]))
    assert direct["T2"].early_finish == date(2025, 12, 31)  # SF-only: before project start
    assert direct["T3"].early_start == MON  # ordinary FS successor: floored at project start

    via_m = _by_id(
        _project(
            [*tasks, _task("M", 0)],
            [sf_pred, _dep("T2", "M", lag=0), _dep("M", "T3", lag=-2)],
            None,
        )
    )
    assert via_m["M"].early_start == via_m["M"].early_finish == MON  # floored, not T2's finish
    assert via_m["T3"].early_start == direct["T3"].early_start  # composition still holds


# ---------------------------------------------------------------------------
# Known answers for every dependency type into and out of a milestone
# ---------------------------------------------------------------------------


class TestMilestoneLinkTypes:
    """``A`` is Mon 01-05 .. Fri 01-09; each case adds one milestone link."""

    def test_ss_into_a_milestone_is_the_start_of_the_predecessor(self) -> None:
        by_id = _by_id(
            _project([_task("A", 5), _task("M", 0)], [_dep("A", "M", DependencyType.SS)])
        )
        assert by_id["M"].early_start == MON

    def test_ff_into_a_milestone_is_the_end_of_the_predecessor(self) -> None:
        by_id = _by_id(
            _project([_task("A", 5), _task("M", 0)], [_dep("A", "M", DependencyType.FF)])
        )
        assert by_id["M"].early_start == date(2026, 1, 9)

    def test_ss_out_of_an_end_of_day_milestone_behaves_like_fs(self) -> None:
        by_id = _by_id(
            _project(
                [_task("A", 5), _task("M", 0), _task("B", 2)],
                [_dep("A", "M"), _dep("M", "B", DependencyType.SS)],
            )
        )
        assert by_id["M"].early_start == date(2026, 1, 9)
        assert by_id["B"].early_start == date(2026, 1, 12)

    def test_ff_out_of_a_milestone_finishes_the_successor_on_its_day(self) -> None:
        by_id = _by_id(
            _project(
                [_task("A", 5), _task("M", 0), _task("B", 2)],
                [_dep("A", "M"), _dep("M", "B", DependencyType.FF)],
            )
        )
        assert (by_id["B"].early_start, by_id["B"].early_finish) == (
            date(2026, 1, 8),
            date(2026, 1, 9),
        )

    def test_fs_lag_out_of_a_start_milestone_counts_from_its_day(self) -> None:
        """A project-start milestone +2 calendar days: Mon 01-05 -> Wed 01-07."""
        by_id = _by_id(_project([_task("M", 0), _task("A", 1)], [_dep("M", "A", lag=2)]))
        assert by_id["A"].early_start == date(2026, 1, 7)

    def test_milestone_chain_stays_on_the_driving_finish(self) -> None:
        """Consecutive milestones after work all sit on the same instant."""
        by_id = _by_id(
            _project(
                [_task("A", 5), _task("M1", 0), _task("M2", 0), _task("B", 1)],
                [_dep("A", "M1"), _dep("M1", "M2"), _dep("M2", "B")],
            )
        )
        assert by_id["M1"].early_start == by_id["M2"].early_start == date(2026, 1, 9)
        assert by_id["B"].early_start == date(2026, 1, 12)
        assert all(t.total_float == timedelta(0) for t in by_id.values())

    def test_snet_milestone_is_not_shown_before_its_floor(self) -> None:
        """An FS-driven end-of-Friday instant ties with an SNET of Monday; Monday wins."""
        m = Task(id="M", name="M", duration=timedelta(0), planned_start=date(2026, 1, 12))
        by_id = _by_id(
            _project([_task("A", 5), m, _task("B", 1)], [_dep("A", "M"), _dep("M", "B")])
        )
        assert by_id["M"].early_start == date(2026, 1, 12)
        assert by_id["B"].early_start == date(2026, 1, 12)

    def test_milestone_with_float_reports_it(self) -> None:
        """A side-branch milestone carries the branch's float, measured in working days."""
        by_id = _by_id(
            _project(
                [_task("A", 5), _task("S", 1), _task("M", 0), _task("B", 3)],
                [_dep("A", "B"), _dep("S", "M"), _dep("M", "B")],
            )
        )
        # S Mon 01-05; M end of Mon; B starts Mon 01-12 -> M may slip to end of Fri.
        assert by_id["M"].early_start == MON
        assert by_id["M"].late_start == date(2026, 1, 9)
        assert by_id["M"].total_float == timedelta(days=4)
        assert by_id["S"].total_float == timedelta(days=4)


class TestMilestoneAtDayEnd:
    """``milestone_at_day_end`` tells a renderer which edge of the shown day (#4079).

    ``early_start`` alone is ambiguous for a milestone: Friday may mean "end of
    Friday" (after work) or "start of Friday" (a floor). The Gantt used to draw
    every diamond at the start of its day, so a work-driven milestone overlapped
    its predecessor's last day and the FS arrow pointed backward.
    """

    def test_fs_after_work_is_end_of_day(self) -> None:
        by_id = _by_id(_project([_task("A", 5), _task("M", 0)], [_dep("A", "M")]))
        assert by_id["M"].early_start == date(2026, 1, 9)
        assert by_id["M"].milestone_at_day_end is True

    def test_project_start_milestone_is_start_of_day(self) -> None:
        by_id = _by_id(_project([_task("M", 0), _task("A", 1)], [_dep("M", "A")]))
        assert by_id["M"].early_start == MON
        assert by_id["M"].milestone_at_day_end is False

    def test_ss_from_work_is_start_of_day(self) -> None:
        by_id = _by_id(
            _project([_task("A", 5), _task("M", 0)], [_dep("A", "M", DependencyType.SS)])
        )
        assert by_id["M"].milestone_at_day_end is False

    def test_snet_floor_that_wins_is_start_of_day(self) -> None:
        m = Task(id="M", name="M", duration=timedelta(0), planned_start=date(2026, 1, 12))
        by_id = _by_id(_project([_task("A", 5), m], [_dep("A", "M")]))
        assert by_id["M"].early_start == date(2026, 1, 12)
        assert by_id["M"].milestone_at_day_end is False

    def test_chained_milestones_inherit_end_of_day(self) -> None:
        by_id = _by_id(
            _project(
                [_task("A", 5), _task("M1", 0), _task("M2", 0)],
                [_dep("A", "M1"), _dep("M1", "M2")],
            )
        )
        assert by_id["M1"].milestone_at_day_end is True
        assert by_id["M2"].milestone_at_day_end is True

    def test_work_and_pinned_milestones_are_never_flagged(self) -> None:
        done = Task(
            id="M",
            name="M",
            duration=timedelta(0),
            actual_start=date(2026, 1, 9),
            actual_finish=date(2026, 1, 9),
            percent_complete=100.0,
        )
        by_id = _by_id(_project([_task("A", 5), done, _task("B", 1)], [_dep("A", "M")]))
        assert not any(t.milestone_at_day_end for t in by_id.values())

    def test_a_stale_input_value_is_overwritten(self) -> None:
        stale = Task(id="M", name="M", duration=timedelta(0), milestone_at_day_end=True)
        by_id = _by_id(_project([stale, _task("A", 1)], [_dep("M", "A")]))
        assert by_id["M"].milestone_at_day_end is False

    def test_round_trips_through_to_dict(self) -> None:
        m = _by_id(_project([_task("A", 5), _task("M", 0)], [_dep("A", "M")]))["M"]
        assert m.to_dict()["milestone_at_day_end"] is True
        assert Task.from_dict(m.to_dict()).milestone_at_day_end is True


# ---------------------------------------------------------------------------
# Monte Carlo and the derivation graph follow the same convention
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("tasks", "deps", "finish"),
    [
        (
            [_task("A", 5), _task("M", 0), _task("B", 5)],
            [_dep("A", "M"), _dep("M", "B")],
            date(2026, 1, 16),
        ),
        ([_task("M0", 0), _task("A", 5)], [_dep("M0", "A")], date(2026, 1, 9)),
        ([_task("A", 5), _task("M", 0)], [_dep("A", "M")], date(2026, 1, 9)),
        ([_task("M", 0), _task("A", 1)], [_dep("M", "A", lag=2)], date(2026, 1, 7)),
    ],
)
def test_monte_carlo_p50_equals_cpm_on_milestone_chains(
    tasks: list[Task], deps: list[Dependency], finish: date
) -> None:
    """Deterministic durations: every percentile is the CPM finish, with no extra day."""
    p = _project(tasks, deps)
    assert schedule(p).project_finish == finish
    mc = monte_carlo(p, runs=16, seed=7)
    assert mc.p50 == mc.p80 == mc.p95 == finish


def test_monte_carlo_agrees_with_cpm_through_a_completed_milestone_reached_by_lag() -> None:
    """#4205 regression: a completed milestone predecessor, read fresh.

    ``_completed_edge_constraints`` reads a completed milestone's own display
    reading off a scratch ``_forward_pass`` run and used to inherit it onto a
    successor unconditionally — even across a nonzero lag, proposing a midnight
    the predecessor never occupied. This is the completed-predecessor sibling of
    the live-predecessor case :func:`test_monte_carlo_p50_equals_cpm_on_milestone_chains`
    already covers; that one never exercises this function, because a live
    predecessor's edge is read by :func:`_mc_milestone_bounds` instead — only a
    *completed* one is fixed at simulation time via ``completed_edge``.

    ``M``'s own instant lands on Sunday 2026-01-11 (the #4173 non-working snap
    gives it ``start_display=True``); ``T1``'s raw instant (``M``'s instant + the
    2-day lag) lands on Tue 2026-01-13, whose previous day (Mon 2026-01-12) *is*
    a working day — so the ``after_non_working`` override in
    ``_mc_milestone_bounds`` cannot mask a wrong inherited reading here, unlike
    most inputs of this shape.
    """
    t0 = _task("T0", 5)
    m = Task(id="M", name="M", duration=timedelta(0), percent_complete=100.0)
    t1 = _task("T1", 0)
    p = _project(
        [t0, m, t1],
        [_dep("T0", "M", lag=1), _dep("M", "T1", lag=2)],
    )
    result = schedule(p)
    mc = monte_carlo(p, runs=48, seed=1, max_runs=None, max_tasks=None)
    assert mc.p50 == mc.p80 == mc.p95 == result.project_finish


@pytest.mark.parametrize(
    "quantity",
    [Quantity.EARLY_START, Quantity.EARLY_FINISH, Quantity.LATE_START, Quantity.LATE_FINISH],
)
@pytest.mark.parametrize("tid", ["A", "M", "B"])
def test_derivation_cites_a_real_constraint_around_a_milestone(
    quantity: Quantity, tid: str
) -> None:
    """ADR-0218 faithfulness: the binding term's date is the engine's own value.

    Before the derivation replayed the milestone rule, ``M``'s early start was
    attributed to no constraint at all — the FS term imposed Monday while the
    engine reports Friday.
    """
    p = _project(
        [_task("A", 5), _task("M", 0), _task("B", 5)],
        [_dep("A", "M"), _dep("M", "B", DependencyType.SS)],
    )
    d = derive_value(p, tid, quantity)
    assert d.binding is not None
    assert d.binding.imposed_date is not None
    assert d.binding.imposed_date.isoformat() == d.value
    if tid == "M" and quantity in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        assert d.binding.source_task_id == "A"
    if tid == "A" and quantity is Quantity.LATE_FINISH:
        assert d.binding.source_task_id == "M"


def test_free_float_derivation_matches_the_engine_for_a_milestone() -> None:
    p = _project(
        [_task("A", 5), _task("S", 1), _task("M", 0), _task("B", 3)],
        [_dep("A", "B"), _dep("S", "M"), _dep("M", "B")],
    )
    by_id = _by_id(p)
    for tid in ("S", "M"):
        d = derive_value(p, tid, Quantity.FREE_FLOAT)
        assert d.value == by_id[tid].free_float.days


# ---------------------------------------------------------------------------
# Every late date is seeded from the project's finish instant (#4157)
# ---------------------------------------------------------------------------


def test_an_unlinked_terminal_milestone_seeds_ordinary_work_from_its_instant() -> None:
    """A Saturday SNET milestone ends the project at Saturday's midnight.

    The engine seeds T0's late finish from that instant — Friday — while the
    result's ``project_finish`` is the Monday the milestone is *shown* on. The
    derivation used to replay the milestone rule only when T0 or a neighbor was a
    milestone, so it cited a non-binding Monday and blamed a pullback that never
    ran.
    """
    m = _task("M", 0)
    m.planned_start = date(2026, 1, 17)  # a Saturday
    p = _project([_task("T0", 2), m], [])
    assert schedule(p).project_finish == date(2026, 1, 19)

    lf = derive_value(p, "T0", Quantity.LATE_FINISH)
    assert lf.value == "2026-01-16"
    assert [(c.kind, c.imposed_date, c.is_binding) for c in lf.contributions] == [
        ("project_finish", date(2026, 1, 16), True)
    ]
    ls = derive_value(p, "T0", Quantity.LATE_START)
    assert ls.value == "2026-01-15"
    assert [(c.kind, c.imposed_date, c.is_binding) for c in ls.contributions] == [
        ("project_finish", date(2026, 1, 16), False),
        ("duration_from_late_finish", date(2026, 1, 15), True),
    ]


@st.composite
def _networks_with_floored_milestones(draw: st.DrawFn) -> Project:
    """A small random DAG where some tasks carry an SNET floor, weekends included.

    An SNET on a zero-duration task that no link reaches is what lets a milestone
    end the project at an instant other than the end of the latest finish day,
    which is the seed every late date in the network is derived from.
    """
    n = draw(st.integers(min_value=1, max_value=6))
    tasks: list[Task] = []
    for i in range(n):
        t = _task(f"T{i}", draw(st.sampled_from([0, 0, 1, 2, 3, 5])))
        if draw(st.booleans()):
            t.planned_start = MON + timedelta(days=draw(st.integers(min_value=0, max_value=20)))
        tasks.append(t)
    deps: list[Dependency] = []
    for i in range(n):
        for j in range(i + 1, n):
            if draw(st.booleans()) and draw(st.booleans()):
                deps.append(
                    _dep(
                        f"T{i}",
                        f"T{j}",
                        draw(st.sampled_from(list(DependencyType))),
                        draw(st.sampled_from([0, 0, 1, 3])),
                    )
                )
    return _project(tasks, deps)


@pytest.mark.fuzz
@given(_networks_with_floored_milestones())
def test_every_date_derivation_cites_the_engines_own_value(p: Project) -> None:
    """ADR-0218 faithfulness over random networks with terminal SNET milestones.

    For every task and every date quantity, the derivation reports the engine's
    value and exactly one term binds, at that value. Float values agree too.

    A matching date is not enough: #4157 reported the right late finish through
    the wrong term, because a pullback reached the same day the misplaced seed
    missed. So the seed is checked on its own: every ordinary task on the one
    calendar cites the same ``project_finish`` date, and a task with no
    successor is bound by it.
    """
    result = schedule(p)
    has_succ = {d.predecessor_id for d in p.dependencies}
    seeds: set[date | None] = set()
    for t in result.tasks:
        if t.duration.days > 0:
            lf = derive_value(p, t.id, Quantity.LATE_FINISH, result)
            seed = next(c for c in lf.contributions if c.kind == "project_finish")
            seeds.add(seed.imposed_date)
            if t.id not in has_succ:
                assert lf.binding is seed, t.id
        assert len(seeds) <= 1, seeds
    for t in result.tasks:
        for q in (
            Quantity.EARLY_START,
            Quantity.EARLY_FINISH,
            Quantity.LATE_START,
            Quantity.LATE_FINISH,
        ):
            d = derive_value(p, t.id, q, result)
            assert d.value == getattr(t, q.value).isoformat(), (t.id, q)
            binding = [c for c in d.contributions if c.is_binding]
            assert binding == [d.binding], (t.id, q)
            assert d.binding is not None and d.binding.imposed_date is not None
            assert d.binding.imposed_date.isoformat() == d.value, (t.id, q)
        for q in (Quantity.TOTAL_FLOAT, Quantity.FREE_FLOAT):
            assert derive_value(p, t.id, q, result).value == getattr(t, q.value).days


# ---------------------------------------------------------------------------
# A terminal milestone that reads as start of day keeps its predecessor's float (#4174)
# ---------------------------------------------------------------------------


class TestTerminalMilestoneLateSeed:
    """``A(4d) -FS+2d-> M``: M sits at Sunday midnight, shown as the start of Monday.

    Slipping A one working day moves M to Monday midnight, which is still shown as
    the start of Monday, so the project finish does not move and A has one day of
    total float. The engine used to seed M's late instant at the raw finish instant
    (Sunday), so it gave A zero float and put it on the critical path.

    ``A -FS+1d-> M`` is a different case. M sits at Saturday midnight, shown as the
    end of Friday. A one-day slip moves M to Sunday midnight, which #4173 shows as
    the start of Monday. That is a real move of the shown finish, so A's zero float
    is correct there, which matches MS Project.
    """

    def _project(self, lag: int, a_start: date | None = None) -> Project:
        a = _task("A", 4)
        a.planned_start = a_start
        return _project([a, _task("M", 0)], [_dep("A", "M", lag=lag)])

    def test_start_of_day_terminal_milestone_leaves_its_predecessor_float(self) -> None:
        result = schedule(self._project(lag=2))
        by_id = {t.id: t for t in result.tasks}
        assert result.project_finish == date(2026, 1, 12)
        assert by_id["M"].milestone_at_day_end is False
        assert by_id["A"].total_float == timedelta(days=1)
        assert by_id["A"].late_finish == date(2026, 1, 9)
        assert not by_id["A"].is_critical
        assert result.critical_path == ["M"]
        # M itself has no float and is not shown past the finish.
        assert by_id["M"].total_float == timedelta(0)
        assert by_id["M"].late_start == by_id["M"].early_start == date(2026, 1, 12)

    def test_slipping_the_predecessor_by_its_float_leaves_the_finish(self) -> None:
        """One day moves M from Sunday to Monday midnight, both shown as Monday; two
        days move the finish."""
        assert schedule(self._project(lag=2, a_start=date(2026, 1, 6))).project_finish == (
            date(2026, 1, 12)
        )
        assert schedule(self._project(lag=2, a_start=date(2026, 1, 7))).project_finish == (
            date(2026, 1, 14)
        )

    def test_end_of_day_terminal_milestone_keeps_its_predecessor_critical(self) -> None:
        """FS+1 is not a bug. A one-day slip moves the shown finish from Friday to
        Monday, so A has no float. This guards against re-widening the seed."""
        result = schedule(self._project(lag=1))
        by_id = {t.id: t for t in result.tasks}
        assert result.project_finish == date(2026, 1, 9)
        assert by_id["M"].milestone_at_day_end is True
        assert by_id["A"].total_float == timedelta(0)
        assert by_id["A"].is_critical
        assert result.critical_path == ["A", "M"]
        slipped = schedule(self._project(lag=1, a_start=date(2026, 1, 6)))
        assert slipped.project_finish == date(2026, 1, 12)

    def test_derivation_cites_the_seed_the_engine_used(self) -> None:
        for lag, a_late_finish in ((2, "2026-01-09"), (1, "2026-01-08")):
            p = self._project(lag=lag)
            result = schedule(p)
            for q in (Quantity.LATE_START, Quantity.LATE_FINISH, Quantity.TOTAL_FLOAT):
                d = derive_value(p, "M", q, result)
                assert d.binding is not None
            lf = derive_value(p, "A", Quantity.LATE_FINISH, result)
            assert lf.value == a_late_finish
            assert lf.binding is not None and lf.binding.source_task_id == "M"


# ---------------------------------------------------------------------------
# Free float before a start-of-day milestone counts by its shown position (#4180)
# ---------------------------------------------------------------------------


class TestFreeFloatBeforeStartOfDayMilestone:
    """``A(4d) -FS+2d-> M``: M sits at Sunday midnight, shown as the start of Monday.

    A one-day slip of A moves M to Monday midnight: the same working position, the
    same shown day and reading. So A has one day of free float and A→M does not
    drive M. Free float used to compare the raw instants, which reported zero and a
    driving edge.

    ``A -FS+1d-> M`` stays zero: Saturday midnight is shown as the end of Friday, and
    the one-day slip lands on Sunday midnight, shown as the start of Monday (#4173).
    """

    def _project(self, lag: int, *, tail: bool = False, a_start: date | None = None) -> Project:
        a = _task("A", 4)
        a.planned_start = a_start
        tasks = [a, _task("M", 0)]
        deps = [_dep("A", "M", lag=lag)]
        if tail:
            tasks.append(_task("B", 1))
            deps.append(_dep("M", "B"))
        return _project(tasks, deps)

    @staticmethod
    def _edges(result: ScheduleResult) -> set[tuple[str, str]]:
        return {(e.predecessor_id, e.successor_id) for e in result.driving_edges}

    @pytest.mark.parametrize("tail", [False, True])
    def test_start_of_day_milestone_leaves_its_predecessor_free_float(self, tail: bool) -> None:
        p = self._project(lag=2, tail=tail)
        result = schedule(p)
        by_id = {t.id: t for t in result.tasks}
        assert by_id["M"].early_start == date(2026, 1, 12)
        assert by_id["M"].milestone_at_day_end is False
        assert by_id["A"].free_float == timedelta(days=1)
        assert ("A", "M") not in self._edges(result)
        assert derive_value(p, "A", Quantity.FREE_FLOAT, result).value == 1
        # The slip the float promises leaves M where it was; one more day moves it.
        slipped = _by_id(self._project(lag=2, tail=tail, a_start=date(2026, 1, 6)))["M"]
        assert (slipped.early_start, slipped.milestone_at_day_end) == (date(2026, 1, 12), False)
        slipped2 = _by_id(self._project(lag=2, tail=tail, a_start=date(2026, 1, 7)))["M"]
        assert slipped2.early_start == date(2026, 1, 14)

    @pytest.mark.parametrize("tail", [False, True])
    def test_end_of_day_milestone_keeps_its_predecessor_driving(self, tail: bool) -> None:
        """FS+1 is not a bug: the slip moves M's shown day from Friday to Monday."""
        p = self._project(lag=1, tail=tail)
        result = schedule(p)
        by_id = {t.id: t for t in result.tasks}
        assert (by_id["M"].early_start, by_id["M"].milestone_at_day_end) == (
            date(2026, 1, 9),
            True,
        )
        assert by_id["A"].free_float == timedelta(0)
        assert ("A", "M") in self._edges(result)
        assert derive_value(p, "A", Quantity.FREE_FLOAT, result).value == 0
        slipped = _by_id(self._project(lag=1, tail=tail, a_start=date(2026, 1, 6)))["M"]
        assert slipped.early_start == date(2026, 1, 12)

    def test_successor_lag_caps_the_free_instant(self) -> None:
        """A live successor link out of M caps how far its free instant may move.

        ``A(4d) -FS+2d-> M -FS+1d-> B``: taken alone, M's start-of-day reading
        would admit Monday midnight, same as the plain ``tail=True`` case above
        (whose ``M -FS-> B`` carries no lag). But M's own ``FS+1d`` link to B
        carries a *calendar-day* lag downstream: proposing Monday midnight for M
        would propose Tuesday midnight to B, a day later than B's actual early
        instant. So the cap pulls M's free instant back to the raw Sunday
        midnight, and A keeps zero free float, not one day. ``W`` is unrelated
        work that gives A total float to spend, so a bug that drops the cap is
        not masked by A already being critical.
        """
        p = _project(
            [_task("A", 4), _task("M", 0), _task("B", 1), _task("W", 15)],
            [_dep("A", "M", lag=2), _dep("M", "B", lag=1)],
        )
        result = schedule(p)
        by_id = {t.id: t for t in result.tasks}
        assert by_id["A"].total_float > timedelta(0)
        assert by_id["A"].free_float == timedelta(0)
        assert ("A", "M") in self._edges(result)
        assert derive_value(p, "A", Quantity.FREE_FLOAT, result).value == 0


def _advance_working_days(d: date, n: int, cal: Calendar) -> date:
    while n > 0:
        d += timedelta(days=1)
        if cal.is_working_day(d):
            n -= 1
    return d


@st.composite
def _fs_ss_networks_with_milestones(draw: st.DrawFn) -> Project:
    """A small random FS/SS DAG with milestones and non-negative calendar-day lags."""
    n = draw(st.integers(min_value=2, max_value=6))
    tasks = [_task(f"T{i}", draw(st.sampled_from([0, 0, 1, 2, 3, 5]))) for i in range(n)]
    deps: list[Dependency] = []
    for i in range(n):
        for j in range(i + 1, n):
            if draw(st.booleans()):
                deps.append(
                    _dep(
                        f"T{i}",
                        f"T{j}",
                        draw(st.sampled_from([DependencyType.FS, DependencyType.SS])),
                        draw(st.sampled_from([0, 0, 1, 2, 3])),
                    )
                )
    return _project(tasks, deps)


@pytest.mark.fuzz
@given(_fs_ss_networks_with_milestones())
def test_total_float_is_the_slip_the_finish_absorbs(p: Project) -> None:
    """Definitional total float (#4174): slipping a live work task by its total
    float must not move the project's finish, and one more working day must.

    The two sides use different measures. "Does not move" compares the shown
    ``project_finish``, because a milestone moving from Saturday to Sunday midnight
    is shown on a different day (#4173) and so counts as a slip. "Must move" also
    accepts a change in the finish instant's working position, because a
    start-of-day milestone and a work task ending the same day are shown on the
    same date even though the instant has moved.
    """
    from trueppm_scheduler.engine import _milestone_instants, _next_working_day

    def position(q: Project) -> date:
        return _next_working_day(_milestone_instants(q)[2], q.calendar)

    result = schedule(p)
    base_position = position(p)
    for t in result.tasks:
        if t.duration.days == 0:
            continue
        assert t.early_start is not None
        tf = t.total_float.days
        for slip, moves in ((tf, False), (tf + 1, True)):
            shifted = copy.deepcopy(p)
            pinned = next(x for x in shifted.tasks if x.id == t.id)
            pinned.planned_start = _advance_working_days(t.early_start, slip, p.calendar)
            finish_moved = schedule(shifted).project_finish != result.project_finish
            moved = finish_moved or (moves and position(shifted) != base_position)
            assert moved is moves, (t.id, tf, slip)


class TestStartOfDayMilestoneTyingTheFinishInstant:
    """``W(5d)`` and ``X(2d) -SS+3d-> M`` from Monday 2026-01-05 (#4183).

    W ends the project at Saturday midnight, shown as the end of Friday. M sits at
    Thursday midnight, read as start of day because an SS link from work places
    it. Slipping X two working days lands M on Saturday midnight: the finish
    instant does not move, but M is shown as the start of Monday, so
    ``project_finish`` does. X has one day of float, not two, and so does M.
    An FS link from work into the same milestone reads as end of day, so it keeps
    the uncapped instant.
    """

    def _project(self, x_start: date | None = None, *, fs_pred: bool = False) -> Project:
        x = _task("X", 2)
        x.planned_start = x_start
        tasks = [_task("W", 5), x, _task("M", 0)]
        deps = [_dep("X", "M", DependencyType.SS, lag=3)]
        if fs_pred:
            tasks.append(_task("Y", 2))
            deps.append(_dep("Y", "M"))
        return _project(tasks, deps)

    def test_float_stops_where_the_start_of_day_reading_moves_the_finish(self) -> None:
        result = schedule(self._project())
        by_id = {t.id: t for t in result.tasks}
        assert result.project_finish == date(2026, 1, 9)
        assert by_id["M"].milestone_at_day_end is False
        assert by_id["X"].total_float == timedelta(days=1)
        assert by_id["X"].late_start == date(2026, 1, 6)
        assert by_id["M"].total_float == timedelta(days=1)
        assert by_id["M"].late_start == date(2026, 1, 9)

    def test_slipping_x_by_its_float_leaves_the_finish(self) -> None:
        assert schedule(self._project(date(2026, 1, 6))).project_finish == date(2026, 1, 9)
        assert schedule(self._project(date(2026, 1, 7))).project_finish == date(2026, 1, 12)

    def test_an_end_of_day_predecessor_keeps_the_uncapped_instant(self) -> None:
        """``Y(2d) -FS-> M`` can finish Friday: M at Saturday midnight, placed by
        FS from work, is shown Friday. Capping M's shared late instant instead of
        the SS link would have given Y one day less."""
        p = self._project(fs_pred=True)
        by_id = {t.id: t for t in schedule(p).tasks}
        assert by_id["Y"].total_float == timedelta(days=3)
        assert by_id["X"].total_float == timedelta(days=1)
        shifted = copy.deepcopy(p)
        next(t for t in shifted.tasks if t.id == "Y").planned_start = date(2026, 1, 8)
        assert schedule(shifted).project_finish == date(2026, 1, 9)

    def test_derivation_cites_the_engines_values(self) -> None:
        p = self._project()
        result = schedule(p)
        for tid in ("X", "M"):
            for q in (Quantity.LATE_START, Quantity.TOTAL_FLOAT):
                d = derive_value(p, tid, q, result)
                engine = getattr(next(t for t in result.tasks if t.id == tid), q.value)
                expected = engine.days if isinstance(engine, timedelta) else engine.isoformat()
                assert d.value == expected, (tid, q)


class TestFreeFloatStopsBeforeAReadingTie:
    """``A(3d) -FS-> M -FS-> B(1d)`` from Monday 2026-01-05, plus ``X(2d)`` (#4183).

    ``A`` places ``M`` at Thursday midnight, read as the end of Wednesday. ``X
    -SS+1d-> M`` proposes Tuesday midnight. Slipping ``X`` two working days lands
    that start-of-day proposal on Thursday midnight too, and the tie resolves to the
    start-of-day reading: ``M``'s instant stays, but it is now shown on Thursday.
    Inverting the link against the raw instant gave ``X`` two days of free float;
    it has one. ``X -SS+1d-> M0 -FS-> M`` is the same tie one hop later: ``M0``
    reads as start of day and hands that reading to ``M`` over a zero-lag link.
    """

    def _project(self, x_start: date | None = None, *, via_m0: bool = False) -> Project:
        x = _task("X", 2)
        x.planned_start = x_start
        tasks = [_task("A", 3), x, _task("M", 0), _task("B", 1)]
        deps = [_dep("A", "M"), _dep("M", "B")]
        if via_m0:
            tasks.append(_task("M0", 0))
            deps += [_dep("X", "M0", DependencyType.SS, lag=1), _dep("M0", "M")]
        else:
            deps.append(_dep("X", "M", DependencyType.SS, lag=1))
        return _project(tasks, deps)

    def test_free_float_stops_before_the_tie(self) -> None:
        result = schedule(self._project())
        by_id = {t.id: t for t in result.tasks}
        assert by_id["M"].milestone_at_day_end is True
        assert by_id["M"].early_start == date(2026, 1, 7)
        assert by_id["X"].free_float == timedelta(days=1)
        assert by_id["X"].total_float == timedelta(days=2)
        edges = {(e.predecessor_id, e.successor_id) for e in result.driving_edges}
        assert ("X", "M") not in edges

    def test_slipping_x_by_its_free_float_leaves_m(self) -> None:
        slipped = schedule(self._project(date(2026, 1, 6)))
        one = {t.id: t for t in slipped.tasks}
        assert (one["M"].early_start, one["M"].milestone_at_day_end) == (date(2026, 1, 7), True)
        # One day before the tie X has no free float left, but A still sets M's
        # instant: X -> M is not a driving edge.
        assert one["X"].free_float == timedelta(0)
        edges = {(e.predecessor_id, e.successor_id) for e in slipped.driving_edges}
        assert ("X", "M") not in edges
        assert ("A", "M") in edges
        two = {t.id: t for t in schedule(self._project(date(2026, 1, 7))).tasks}
        assert (two["M"].early_start, two["M"].milestone_at_day_end) == (date(2026, 1, 8), False)

    def test_a_milestone_carrying_its_reading_over_stops_before_the_tie(self) -> None:
        by_id = {t.id: t for t in schedule(self._project(via_m0=True)).tasks}
        assert by_id["M0"].milestone_at_day_end is False
        assert by_id["M0"].free_float == timedelta(days=1)
        assert by_id["M0"].total_float == timedelta(days=2)

    def test_an_fs_link_from_work_keeps_the_raw_instant(self) -> None:
        """An FS link from work reads the instant as end of day, so a tie with it
        changes nothing: ``A`` keeps zero free float, and ``M`` stays driven."""
        result = schedule(self._project())
        by_id = {t.id: t for t in result.tasks}
        assert by_id["A"].free_float == timedelta(0)
        assert ("A", "M") in {(e.predecessor_id, e.successor_id) for e in result.driving_edges}

    @pytest.mark.parametrize("via_m0", [False, True])
    def test_derivation_cites_the_engines_free_float(self, via_m0: bool) -> None:
        p = self._project(via_m0=via_m0)
        result = schedule(p)
        for t in result.tasks:
            d = derive_value(p, t.id, Quantity.FREE_FLOAT, result)
            assert d.value == t.free_float.days, t.id


def _early_position(t: Task) -> tuple[date | None, date | None, bool]:
    """What a slip must leave alone for it to be free: a task's early days, plus a
    milestone's reading (the end of Friday and the start of Monday differ)."""
    return t.early_start, t.early_finish, t.milestone_at_day_end


@pytest.mark.fuzz
@given(_fs_ss_networks_with_milestones())
# The #4180 repro, pinned because the derandomized gate profile does not reach it.
@example(_project([_task("A", 4), _task("M", 0)], [_dep("A", "M", lag=2)]))
@example(
    _project(
        [_task("A", 4), _task("M", 0), _task("B", 1)],
        [_dep("A", "M", lag=2), _dep("M", "B")],
    )
)
def test_free_float_is_the_slip_every_successor_absorbs(p: Project) -> None:
    """Definitional free float (#4180, #4183): slipping a live work task by its free
    float moves no successor's early position, and one more working day moves one.

    Free float is capped at total float, so the "moves" side only holds when a link
    sets it — when free float is below total float. A milestone successor's position
    is its shown day plus its reading, not the raw instant: Sunday and Monday
    midnight are both the start of Monday, while Saturday midnight is the end of
    Friday (#4173). A reading tie at an end-of-day milestone (#4183) is folded into
    the same free-instant computation (``engine._free_start_ref`` layered on
    ``engine._milestone_free_instants``), so this needs no exemption for it: the
    open-issue placeholder this test carried before the two branches were combined
    is resolved, and both directions hold unconditionally.
    """
    result = schedule(p)
    has_successor = {d.predecessor_id for d in p.dependencies}
    for t in result.tasks:
        if t.duration.days == 0 or t.id not in has_successor:
            continue
        assert t.early_start is not None
        ff, tf = t.free_float.days, t.total_float.days
        cases = [(ff, False)] + ([(ff + 1, True)] if ff < tf else [])
        for slip, moves in cases:
            shifted = copy.deepcopy(p)
            pinned = next(x for x in shifted.tasks if x.id == t.id)
            pinned.planned_start = _advance_working_days(t.early_start, slip, p.calendar)
            after = _by_id(shifted)
            moved = any(
                _early_position(after[x.id]) != _early_position(x)
                for x in result.tasks
                if x.id != t.id
            )
            assert moved is moves, (t.id, ff, tf, slip)


# ---------------------------------------------------------------------------
# A lag landing just after non-working time is shown at the next start (#4173)
# ---------------------------------------------------------------------------

_JAN_9_FRI = date(2026, 1, 9)
_JAN_12_MON = date(2026, 1, 12)
_JAN_13_TUE = date(2026, 1, 13)


def _ss_fs_join(b_days: int) -> Project:
    """``A(3d) -SS+6d-> M`` and ``B -FS+3d-> M`` from Monday 2026-01-05.

    With ``B = 3d`` both links land on Sunday midnight; with ``B = 4d`` the FS link
    lands on Monday midnight, the same working-time position one calendar day later.
    """
    b = Task(
        id="B",
        name="B",
        duration=timedelta(days=b_days),
        optimistic_duration=timedelta(days=3),
        most_likely_duration=timedelta(days=4),
        pessimistic_duration=timedelta(days=4),
    )
    return _project(
        [_task("A", 3), b, _task("M", 0)],
        [_dep("A", "M", DependencyType.SS, lag=6), _dep("B", "M", lag=3)],
    )


class TestLagAfterNonWorkingTime:
    """An FS/SS instant just after a weekend or holiday reads as a day start (#4173).

    The pre-fix engine showed a milestone driven by FS-from-work at the end of the
    working day before its instant, whatever lay between. Monday midnight after a
    weekend was therefore shown on *Friday* while Sunday midnight — the same
    working-time position, proposed by an SS link — was shown on Monday, so a
    longer predecessor moved ``project_finish`` a working day earlier and Monte
    Carlo reported P50 before it. MS Project snaps an elapsed lag that lands on
    non-working time to the next working start; so does the engine now.
    """

    @pytest.mark.parametrize("b_days", [3, 4])
    def test_a_longer_predecessor_never_shows_the_milestone_earlier(self, b_days: int) -> None:
        result = schedule(_ss_fs_join(b_days))
        m = next(t for t in result.tasks if t.id == "M")
        assert result.project_finish == _JAN_12_MON
        assert m.early_start == m.early_finish == _JAN_12_MON
        assert m.milestone_at_day_end is False

    def test_monte_carlo_never_precedes_the_cpm_finish(self) -> None:
        p = _ss_fs_join(3)
        mc = monte_carlo(p, runs=2000, seed=1)
        assert mc.p50 == mc.p80 == mc.p95 == schedule(p).project_finish == _JAN_12_MON

    def test_fs_lag_onto_a_weekend_day_shows_monday(self) -> None:
        # B(4d) finishes Thursday; FS+2 lands on Sunday midnight (Saturday's end).
        by_id = _by_id(_project([_task("B", 4), _task("M", 0)], [_dep("B", "M", lag=2)]))
        assert by_id["M"].early_start == _JAN_12_MON
        assert by_id["M"].milestone_at_day_end is False

    def test_fs_lag_ending_a_working_day_stays_end_of_day(self) -> None:
        # FS+1 from a Thursday finish is the end of Friday, a working day: unchanged.
        by_id = _by_id(_project([_task("B", 4), _task("M", 0)], [_dep("B", "M", lag=1)]))
        assert by_id["M"].early_start == _JAN_9_FRI
        assert by_id["M"].milestone_at_day_end is True

    def test_fs_lag_onto_a_holiday_shows_the_next_working_start(self) -> None:
        # A(2d) Mon-Tue; FS+1 is Wednesday's end, and Wednesday is a holiday.
        wed = date(2026, 1, 7)
        cal = Calendar(exceptions=[DateRange(wed, wed)])
        by_id = _by_id(_project([_task("A", 2), _task("M", 0)], [_dep("A", "M", lag=1)], cal))
        assert by_id["M"].early_start == date(2026, 1, 8)
        assert by_id["M"].milestone_at_day_end is False

    def test_ss_lag_out_of_a_snapped_milestone_counts_from_its_start(self) -> None:
        # M sits at Monday's start, so SS+1 out of it is Tuesday's start — not the
        # end of Monday, which the end-of-day reading it replaced would have shown.
        p = _ss_fs_join(4)
        p.tasks.append(_task("M2", 0))
        p.dependencies.append(_dep("M", "M2", DependencyType.SS, lag=1))
        by_id = _by_id(p)
        assert by_id["M2"].early_start == _JAN_13_TUE
        assert by_id["M2"].milestone_at_day_end is False

    @pytest.mark.parametrize(
        ("snet", "shown", "at_day_end"),
        [(None, _JAN_9_FRI, True), (date(2026, 1, 6), _JAN_12_MON, False)],
    )
    def test_the_reading_follows_the_midnight_not_only_the_working_position(
        self, snet: date | None, shown: date, at_day_end: bool
    ) -> None:
        """``A(4d) -FS+1-> M``: Saturday midnight is Friday's end, Sunday's is Monday's start.

        The two midnights share a working-time position, and still show different
        days — deliberately, and in the permitted direction: the later midnight
        never shows earlier. MS Project does the same (Friday 17:00 vs Saturday
        17:00 snapped to Monday 08:00). A reading decided by working position alone
        cannot be made monotone once a milestone's reading is carried through a
        calendar-day lag into another milestone; see the chain case below.
        """
        a = _task("A", 4)
        a.planned_start = snet
        by_id = _by_id(_project([a, _task("M", 0)], [_dep("A", "M", lag=1)]))
        assert by_id["M"].early_start == shown
        assert by_id["M"].milestone_at_day_end is at_day_end

    @pytest.mark.parametrize("b_days", [4, 5])
    def test_a_reading_carried_into_another_milestone_stays_monotone(self, b_days: int) -> None:
        """``A -SS+6-> M1 <-FS+3- B`` then ``M1 -SS+5-> M2``; B from 4 to 5 days.

        M1 moves from Monday midnight (start of Monday) to Tuesday midnight (end of
        Monday), so M2's proposal moves from Saturday to Sunday midnight — one
        working-time position — with the reading it inherits. Upgrading only the
        readings that share a position with a start-of-day proposal (the other fix
        #4173 considered) shows M2 on Friday 01-16 at B = 5 and Monday 01-19 at
        B = 4; reading a midnight after non-working time as a start keeps Monday.
        """
        p = _project(
            [_task("A", 3), _task("B", b_days), _task("M1", 0), _task("M2", 0)],
            [
                _dep("A", "M1", DependencyType.SS, lag=6),
                _dep("B", "M1", lag=3),
                _dep("M1", "M2", DependencyType.SS, lag=5),
            ],
        )
        assert schedule(p).project_finish == date(2026, 1, 19)

    def test_zero_lag_after_a_non_working_actual_finish_is_the_next_start(self) -> None:
        """A recorded finish on Saturday puts ``A -FS-> M`` at Sunday midnight.

        The same rule as a lag: the working day before that midnight is not a
        working day, so M is the start of Monday — not the end of the Friday
        before A actually finished, which is where the pre-#4173 engine put it.
        """
        done = Task(
            id="A",
            name="A",
            duration=timedelta(days=3),
            actual_start=date(2026, 1, 7),
            actual_finish=date(2026, 1, 10),  # a Saturday
            percent_complete=100.0,
        )
        by_id = _by_id(_project([done, _task("M", 0)], [_dep("A", "M")]))
        assert by_id["M"].early_start == _JAN_12_MON
        assert by_id["M"].milestone_at_day_end is False

    def test_derivation_cites_the_fs_link_at_the_shown_day(self) -> None:
        d = derive_value(_ss_fs_join(4), "M", Quantity.EARLY_START)
        assert d.value == _JAN_12_MON.isoformat()
        assert d.binding is not None
        assert d.binding.source_task_id == "B"
        assert d.binding.imposed_date == _JAN_12_MON


@st.composite
def _fs_ss_networks_with_a_bump(
    draw: st.DrawFn,
) -> tuple[list[tuple[str, int]], list[tuple[str, str, DependencyType, int]], int, Calendar]:
    """An FS/SS-only DAG heavy in milestones, and the index of one task to lengthen.

    The last task is always a milestone joined by one SS and one FS link from two
    different earlier tasks: that join is the #4173 shape (two proposals whose
    midnights straddle a weekend), which a uniform edge draw reaches too rarely
    for the 200-example gate profile to find. Every other pair is linked at random.
    """
    n = draw(st.integers(min_value=3, max_value=6))
    tasks = [(f"T{i}", draw(st.sampled_from([0, 0, 0, 1, 2, 3, 4]))) for i in range(n - 1)]
    tasks.append((f"T{n - 1}", 0))
    ss_src, fs_src = draw(
        st.lists(st.integers(min_value=0, max_value=n - 2), min_size=2, max_size=2, unique=True)
    )
    lag = st.integers(min_value=0, max_value=9)
    links = [
        (f"T{ss_src}", f"T{n - 1}", DependencyType.SS, draw(lag)),
        (f"T{fs_src}", f"T{n - 1}", DependencyType.FS, draw(lag)),
    ]
    joined = {ss_src, fs_src}
    links += [
        (
            f"T{i}",
            f"T{j}",
            draw(st.sampled_from([DependencyType.FS, DependencyType.SS])),
            draw(lag),
        )
        for i in range(n)
        for j in range(i + 1, n)
        if not (j == n - 1 and i in joined) and draw(st.booleans())
    ]
    holidays = draw(
        st.lists(st.integers(min_value=0, max_value=20), max_size=2, unique=True).map(
            lambda offs: [DateRange(MON + timedelta(days=o), MON + timedelta(days=o)) for o in offs]
        )
    )
    return (
        tasks,
        links,
        draw(st.integers(min_value=0, max_value=n - 1)),
        Calendar(exceptions=holidays),
    )


@pytest.mark.fuzz
@given(_fs_ss_networks_with_a_bump())
def test_lengthening_any_task_never_moves_the_finish_earlier(
    case: tuple[list[tuple[str, int]], list[tuple[str, str, DependencyType, int]], int, Calendar],
) -> None:
    """On an FS/SS network, +1 day on any single duration never decreases the finish.

    This is the property ``monte_carlo()``'s "never before the CPM finish" contract
    rests on: every percentile is drawn from durations at or above the planned
    ones, so it is only a lower bound if the finish is monotone in duration. Zero-
    duration tasks and calendar-day lags are drawn heavily because that is where
    #4173 broke it — two readings of one working-time position shown on different
    days — and lengthening a milestone to one day is in scope too.
    """
    tasks, links, bump, cal = case

    def finish(extra: int) -> date:
        return schedule(
            _project(
                [_task(tid, d + (extra if i == bump else 0)) for i, (tid, d) in enumerate(tasks)],
                [_dep(u, v, t, lag) for u, v, t, lag in links],
                cal,
            )
        ).project_finish

    assert finish(1) >= finish(0)
