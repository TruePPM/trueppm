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
    Quantity,
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
    """
    tasks, deps, (a, b), lag_in, lag_out, cal = case
    direct = _project(tasks, [*deps, _dep(a, b, lag=lag_in + lag_out)], cal)
    via_m = _project(
        [*tasks, _task("M", 0)],
        [*deps, _dep(a, "M", lag=lag_in), _dep("M", b, lag=lag_out)],
        cal,
    )
    before = _by_id(direct)
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
