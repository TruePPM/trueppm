"""Tests for the CPM engine and Monte Carlo simulation."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    CyclicDependencyError,
    DateRange,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    MonteCarloResult,
    Project,
    ScheduleResult,
    SimulationCapExceeded,
    Task,
    find_cycle,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine import MAX_EXPANDED_EDGES

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_project(
    tasks: list[Task],
    dependencies: list[Dependency] | None = None,
    start: date = date(2026, 3, 2),  # Monday
    calendar: Calendar | None = None,
) -> Project:
    return Project(
        id="test",
        name="Test Project",
        start_date=start,
        tasks=tasks,
        dependencies=dependencies or [],
        calendar=calendar or Calendar(),
    )


def task(tid: str, name: str, days: int, **kwargs: object) -> Task:
    return Task(id=tid, name=name, duration=timedelta(days=days), **kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# schedule() — basic CPM
# ---------------------------------------------------------------------------


class TestScheduleBasic:
    def test_single_task(self) -> None:
        """A single 5-day task starting Monday finishes Friday."""
        p = make_project([task("A", "A", 5)])
        r = schedule(p)
        assert r.project_start == date(2026, 3, 2)  # Monday
        assert r.project_finish == date(2026, 3, 6)  # Friday
        t = r.tasks[0]
        assert t.early_start == date(2026, 3, 2)
        assert t.early_finish == date(2026, 3, 6)
        assert t.late_start == date(2026, 3, 2)
        assert t.late_finish == date(2026, 3, 6)
        assert t.total_float == timedelta(0)
        assert t.is_critical is True

    def test_linear_fs_chain(self) -> None:
        """A → B → C in FS order: schedule is sequential with no float on any task."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3), task("C", "C", 2)],
            dependencies=[
                Dependency("A", "B"),
                Dependency("B", "C"),
            ],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}

        # A: Mon 2-Mar → Fri 6-Mar
        assert by_id["A"].early_start == date(2026, 3, 2)
        assert by_id["A"].early_finish == date(2026, 3, 6)

        # B starts the next working day after A finishes (Mon 9-Mar)
        assert by_id["B"].early_start == date(2026, 3, 9)
        assert by_id["B"].early_finish == date(2026, 3, 11)

        # C starts Mon 16-Mar (B finishes Wed 11-Mar → next working day Mon 16 is wrong;
        # actually Thu 12-Mar is the next working day after Wed)
        assert by_id["C"].early_start == date(2026, 3, 12)  # Thursday
        assert by_id["C"].early_finish == date(2026, 3, 13)  # Friday

        assert r.project_finish == date(2026, 3, 13)
        assert r.critical_path == ["A", "B", "C"]
        for t in r.tasks:
            assert t.is_critical is True
            assert t.total_float == timedelta(0)

    def test_parallel_paths_critical_path_is_longer(self) -> None:
        """
        A(5) → C(2)
        B(3) → C(2)
        A is longer, so A→C is critical; B has float.
        """
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3), task("C", "C", 2)],
            dependencies=[
                Dependency("A", "C"),
                Dependency("B", "C"),
            ],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}

        assert by_id["A"].is_critical is True
        assert by_id["C"].is_critical is True
        # B finishes before A, so B has float
        assert by_id["B"].is_critical is False
        assert by_id["B"].total_float > timedelta(0)

        # C cannot start until both A and B finish; A is the constraint
        assert by_id["C"].early_start == date(2026, 3, 9)  # day after A finishes

    def test_no_tasks_raises(self) -> None:
        with pytest.raises(ValueError, match="at least one task"):
            schedule(make_project([]))

    def test_original_project_not_mutated(self) -> None:
        """schedule() must not mutate the input project."""
        t = task("A", "A", 5)
        p = make_project([t])
        original_es = t.early_start
        schedule(p)
        assert t.early_start == original_es

    def test_returns_schedule_result(self) -> None:
        r = schedule(make_project([task("A", "A", 3)]))
        assert isinstance(r, ScheduleResult)
        assert r.project_id == "test"

    def test_result_serialisable(self) -> None:
        r = schedule(make_project([task("A", "A", 3)]))
        d = r.to_dict()
        assert d["project_id"] == "test"
        assert len(d["tasks"]) == 1


# ---------------------------------------------------------------------------
# schedule() — calendar-aware arithmetic
# ---------------------------------------------------------------------------


class TestScheduleCalendar:
    def test_task_spanning_weekend(self) -> None:
        """A 7-day task starting Monday spans two weekends and finishes the following Tuesday."""
        p = make_project([task("A", "A", 7)])
        r = schedule(p)
        # Mon 2-Mar + 7 working days = Tue 10-Mar (Mon 2,3,4,5,6 = 5, Mon 9, Tue 10 = 7)
        assert r.project_finish == date(2026, 3, 10)

    def test_start_date_on_weekend_snaps_to_monday(self) -> None:
        """Project start on Saturday 2026-03-07 snaps to Monday 2026-03-09."""
        p = make_project([task("A", "A", 1)], start=date(2026, 3, 7))
        r = schedule(p)
        assert r.project_start == date(2026, 3, 9)
        assert r.project_finish == date(2026, 3, 9)

    def test_holiday_exception_skipped(self) -> None:
        """A 2-day task starting Monday with Tuesday as a holiday finishes Wednesday."""
        cal = Calendar(exceptions=[DateRange(date(2026, 3, 3), date(2026, 3, 3))])
        p = make_project([task("A", "A", 2)], calendar=cal)
        r = schedule(p)
        # Mon 2-Mar (day 1), Tue 3-Mar skipped (holiday), Wed 4-Mar (day 2) = finish Wed
        assert r.project_finish == date(2026, 3, 4)


# ---------------------------------------------------------------------------
# schedule() — dependency types
# ---------------------------------------------------------------------------


class TestScheduleDependencyTypes:
    def test_fs_with_lag(self) -> None:
        """FS with lag=2 days: successor starts 2 calendar days after predecessor finishes."""
        p = make_project(
            tasks=[task("A", "A", 3), task("B", "B", 2)],
            dependencies=[Dependency("A", "B", lag=timedelta(days=2))],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        # A: Mon 2-Mar → Wed 4-Mar. With lag=2: Thu 5-Mar + 2 = Mon 9-Mar.
        # Next working day from 2026-03-04 + timedelta(1) + timedelta(2) = Mon 9-Mar
        assert by_id["B"].early_start == date(2026, 3, 9)

    def test_ss_dependency(self) -> None:
        """SS: B starts same day as A (both start Mon 2-Mar)."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3)],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.SS)],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        assert by_id["B"].early_start == date(2026, 3, 2)
        assert by_id["B"].early_finish == date(2026, 3, 4)

    def test_ff_dependency(self) -> None:
        """FF: B finishes same day as A."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 2)],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.FF)],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        # A finishes Fri 6-Mar; B must also finish Fri 6-Mar
        assert by_id["B"].early_finish == date(2026, 3, 6)
        # B is 2 days, so starts Thu 5-Mar
        assert by_id["B"].early_start == date(2026, 3, 5)

    def test_sf_dependency(self) -> None:
        """SF: B finishes after A starts (rare but must be handled)."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3)],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=4))],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        # A starts Mon 2-Mar + lag 4 calendar days = Fri 6-Mar → B must finish >= Fri 6-Mar
        assert by_id["B"].early_finish >= date(2026, 3, 6)


# ---------------------------------------------------------------------------
# schedule() — float and critical path
# ---------------------------------------------------------------------------


class TestScheduleFloat:
    def test_total_float_on_non_critical_task(self) -> None:
        """
        A(5) ─FS─► C(2)   total project = 5+2 = 7 working days
        B(1) ─FS─► C(2)   B has 4 days of total float
        """
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 1), task("C", "C", 2)],
            dependencies=[Dependency("A", "C"), Dependency("B", "C")],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        assert by_id["B"].total_float == timedelta(days=4)
        assert by_id["B"].is_critical is False

    def test_critical_path_identified(self) -> None:
        """Critical path contains only tasks with zero float."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 1), task("C", "C", 2)],
            dependencies=[Dependency("A", "C"), Dependency("B", "C")],
        )
        r = schedule(p)
        assert set(r.critical_path) == {"A", "C"}


class TestFreeFloatAllDependencyTypes:
    """free_float reflects SS/FF/SF links, not only FS (#825).

    Each case gives the predecessor more total float than its slack to the
    successor through the non-FS link, so a correct free_float is strictly
    *less* than total_float — the previous FS-only implementation reported them
    equal because the non-FS successor never tightened free float.
    """

    def test_free_float_ss_link(self) -> None:
        # A ─SS─► B (B held to Fri by SNET); E is a long parallel pole so A is
        # not critical. A can slip 4 working days (Mon→Fri) before its SS link
        # starts pushing B's start.
        p = make_project(
            tasks=[
                task("A", "A", 2),
                task("B", "B", 2, planned_start=date(2026, 3, 6)),
                task("E", "E", 10),
            ],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.SS)],
        )
        by_id = {t.id: t for t in schedule(p).tasks}
        assert by_id["A"].free_float == timedelta(days=4)
        assert by_id["A"].total_float > by_id["A"].free_float

    def test_free_float_ff_link(self) -> None:
        # A ─FF─► B: free float is A's working-day slack to B's finish (#825 AC).
        # A finishes Tue 3-Mar; B finishes Tue 10-Mar → 5 working days of slack.
        p = make_project(
            tasks=[
                task("A", "A", 2),
                task("B", "B", 2, planned_start=date(2026, 3, 9)),
                task("E", "E", 12),
            ],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.FF)],
        )
        by_id = {t.id: t for t in schedule(p).tasks}
        assert by_id["A"].free_float == timedelta(days=5)
        assert by_id["A"].total_float > by_id["A"].free_float

    def test_free_float_sf_link(self) -> None:
        # A ─SF(lag=4)─► B: B must finish no earlier than A starts + 4 cal days
        # (Fri 6-Mar). B finishes Wed 11-Mar → 3 working days of slack for A.
        p = make_project(
            tasks=[
                task("A", "A", 1),
                task("B", "B", 3, planned_start=date(2026, 3, 9)),
                task("E", "E", 12),
            ],
            dependencies=[
                Dependency("A", "B", dep_type=DependencyType.SF, lag=timedelta(days=4)),
            ],
        )
        by_id = {t.id: t for t in schedule(p).tasks}
        assert by_id["A"].free_float == timedelta(days=3)
        assert by_id["A"].total_float > by_id["A"].free_float

    def test_free_float_never_exceeds_total_float(self) -> None:
        # Invariant across a mixed-dependency network.
        p = make_project(
            tasks=[task("A", "A", 3), task("B", "B", 2), task("C", "C", 4), task("D", "D", 1)],
            dependencies=[
                Dependency("A", "B", dep_type=DependencyType.FS),
                Dependency("A", "C", dep_type=DependencyType.SS, lag=timedelta(days=1)),
                Dependency("B", "D", dep_type=DependencyType.FF),
                Dependency("C", "D", dep_type=DependencyType.FS),
            ],
        )
        for t in schedule(p).tasks:
            assert t.free_float <= t.total_float


# ---------------------------------------------------------------------------
# schedule() — cycle detection
# ---------------------------------------------------------------------------


class TestSchedulePlannedStart:
    """planned_start is a SNET (start no earlier than) constraint.

    The forward pass applies it as a floor:
        early_start = max(CPM-computed early_start, planned_start)
    """

    def test_planned_start_later_than_cpm_raises_early_start(self) -> None:
        """planned_start after CPM date delays the task."""
        p = make_project(
            tasks=[task("A", "A", 3, planned_start=date(2026, 3, 9))]  # 1 week after project start
        )
        r = schedule(p)
        t = next(t for t in r.tasks if t.id == "A")
        # CPM would place early_start on 2026-03-02 (project start),
        # but planned_start pushes it to 2026-03-09.
        assert t.early_start == date(2026, 3, 9)
        assert t.early_finish == date(2026, 3, 11)  # 3 working days from Mon 9

    def test_planned_start_before_cpm_has_no_effect(self) -> None:
        """planned_start before CPM-computed date is ignored (it's already satisfied)."""
        p = make_project(
            tasks=[task("A", "A", 3, planned_start=date(2026, 2, 23))]  # week before project start
        )
        r = schedule(p)
        t = next(t for t in r.tasks if t.id == "A")
        # planned_start is satisfied by CPM; early_start stays at project start.
        assert t.early_start == date(2026, 3, 2)

    def test_planned_start_on_weekend_snaps_to_next_working_day(self) -> None:
        """planned_start on a weekend is advanced to the next working day."""
        p = make_project(
            tasks=[task("A", "A", 2, planned_start=date(2026, 3, 7))]  # Saturday
        )
        r = schedule(p)
        t = next(t for t in r.tasks if t.id == "A")
        assert t.early_start == date(2026, 3, 9)  # Monday

    def test_planned_start_cascades_to_successors(self) -> None:
        """Delaying task A via planned_start pushes dependent task B forward."""
        p = make_project(
            tasks=[
                task("A", "A", 3, planned_start=date(2026, 3, 9)),  # pushed 1 week
                task("B", "B", 2),
            ],
            dependencies=[Dependency("A", "B")],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        # A starts 2026-03-09, finishes 2026-03-11 (3 days)
        # B cannot start until day after A finishes → 2026-03-12
        assert by_id["A"].early_start == date(2026, 3, 9)
        assert by_id["B"].early_start == date(2026, 3, 12)

    def test_none_planned_start_is_ignored(self) -> None:
        """Tasks with no planned_start use CPM dates unchanged."""
        p = make_project(tasks=[task("A", "A", 5)])
        r = schedule(p)
        assert r.tasks[0].early_start == date(2026, 3, 2)


class TestScheduleZeroDurationMilestone:
    """Zero-duration tasks are CPM milestones: a single point in time.

    The API layer flags milestones via Task.is_milestone, but the scheduler
    library operates purely on duration; the API normalises is_milestone=True
    to duration=timedelta(days=0) at the boundary. These tests cover the
    contract the API depends on.
    """

    def test_zero_duration_task_finish_equals_start(self) -> None:
        """A zero-duration task finishes the same day it starts."""
        p = make_project(tasks=[task("M", "Milestone", 0)])
        r = schedule(p)
        m = r.tasks[0]
        assert m.early_start == m.early_finish == date(2026, 3, 2)
        assert m.late_start == m.late_finish == date(2026, 3, 2)

    def test_zero_duration_with_predecessor_and_successor(self) -> None:
        """A milestone in the middle of a chain stays a single point.

        Reproduces the failure mode reported on MR !221: a milestone with both
        a predecessor and a successor must not stretch across a date range.
        """
        p = make_project(
            tasks=[
                task("A", "A", 3),  # finishes 2026-03-04
                task("M", "Milestone", 0),
                task("B", "B", 2),
            ],
            dependencies=[
                Dependency("A", "M"),
                Dependency("M", "B"),
            ],
        )
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}
        m = by_id["M"]
        # Predecessor finish 2026-03-04 → successor's ES is 2026-03-05.
        # Milestone sits at the gate between A and B as a single point.
        assert m.early_start == m.early_finish == date(2026, 3, 5)
        assert m.late_start == m.late_finish == date(2026, 3, 5)
        # B starts the day after the milestone (FS dependency, EF inclusive).
        assert by_id["B"].early_start == date(2026, 3, 6)


class TestScheduleCycleDetection:
    def test_direct_cycle_raises(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 3), task("B", "B", 3)],
            dependencies=[Dependency("A", "B"), Dependency("B", "A")],
        )
        with pytest.raises(CyclicDependencyError) as exc_info:
            schedule(p)
        assert "A" in exc_info.value.cycle
        assert "B" in exc_info.value.cycle

    def test_self_loop_raises(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 3)],
            dependencies=[Dependency("A", "A")],
        )
        with pytest.raises(CyclicDependencyError):
            schedule(p)

    def test_three_node_cycle_raises(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 1), task("B", "B", 1), task("C", "C", 1)],
            dependencies=[Dependency("A", "B"), Dependency("B", "C"), Dependency("C", "A")],
        )
        with pytest.raises(CyclicDependencyError):
            schedule(p)

    def test_unknown_task_id_raises(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 3)],
            dependencies=[Dependency("A", "MISSING")],
        )
        with pytest.raises(ValueError, match="unknown task"):
            schedule(p)


# ---------------------------------------------------------------------------
# find_cycle() — public helper used by the API to validate dep creates
# before they hit the DB. Documented in ADR-0055.
# ---------------------------------------------------------------------------


class TestFindCycle:
    def test_no_cycle_returns_none(self) -> None:
        assert find_cycle([("A", "B"), ("B", "C"), ("C", "D")]) is None

    def test_empty_edges_returns_none(self) -> None:
        assert find_cycle([]) is None

    def test_self_loop_returned(self) -> None:
        result = find_cycle([("A", "A")])
        assert result == ["A", "A"]

    def test_two_cycle_returned_in_order(self) -> None:
        result = find_cycle([("A", "B"), ("B", "A")])
        assert result is not None
        # Cycle wraps back to start; networkx may begin at any node but the
        # path must close on its first node.
        assert result[0] == result[-1]
        assert set(result) == {"A", "B"}
        assert len(result) == 3

    def test_three_cycle_returned(self) -> None:
        result = find_cycle([("A", "B"), ("B", "C"), ("C", "A")])
        assert result is not None
        assert result[0] == result[-1]
        assert set(result) == {"A", "B", "C"}
        assert len(result) == 4

    def test_diamond_dag_no_false_positive(self) -> None:
        # A → B → D and A → C → D — classic diamond, acyclic.
        edges = [("A", "B"), ("A", "C"), ("B", "D"), ("C", "D")]
        assert find_cycle(edges) is None

    def test_long_chain_no_false_positive(self) -> None:
        edges = [("A", "B"), ("B", "C"), ("C", "D"), ("D", "E")]
        assert find_cycle(edges) is None

    def test_cycle_through_summary_expansion(self) -> None:
        # Eng is a summary task containing leaf Validate.
        # Edge: Validate → Eng creates a logical cycle (Eng waits for Validate
        # which is one of Eng's leaves). Without expansion this would look
        # acyclic at the edge level.
        edges = [("Validate", "Eng")]
        children_map = {"Eng": ["Validate", "Implement"]}
        result = find_cycle(edges, children_map=children_map)
        assert result is not None
        # After expansion the cycle is Validate → Validate (a self-loop on
        # the leaf), which find_cycle returns as ['Validate', 'Validate'].
        assert result[0] == result[-1]
        assert "Validate" in result

    def test_summary_to_summary_cycle(self) -> None:
        # Eng (containing E1) → Procurement (containing P1, P2)
        # Procurement → Eng would close a cycle through the leaves.
        edges = [("Eng", "Procurement"), ("Procurement", "Eng")]
        children_map = {"Eng": ["E1"], "Procurement": ["P1", "P2"]}
        result = find_cycle(edges, children_map=children_map)
        assert result is not None
        assert result[0] == result[-1]

    def test_summary_expansion_no_false_positive_on_dag(self) -> None:
        # Eng (E1) → Procurement (P1) is a normal edge between two summaries,
        # acyclic at the leaf level (E1 → P1).
        edges = [("Eng", "Procurement")]
        children_map = {"Eng": ["E1"], "Procurement": ["P1"]}
        assert find_cycle(edges, children_map=children_map) is None


class TestExpansionCap:
    """The summary→summary cross product is bounded by MAX_EXPANDED_EDGES (#357)."""

    def test_wide_summary_to_summary_edge_is_rejected_fast(self) -> None:
        # A single 1,000-leaf → 1,000-leaf summary edge would fan out to 1,000,000
        # leaf tuples. Before the cap this allocated the full cross product (or
        # timed out); now the cost is checked from leaf counts and the call rejects
        # the graph without materialising a single tuple.
        import time

        pred_leaves = [f"P{i}" for i in range(1_000)]
        succ_leaves = [f"S{i}" for i in range(1_000)]
        children_map = {"PSum": pred_leaves, "SSum": succ_leaves}
        edges = [("PSum", "SSum")]

        start = time.perf_counter()
        with pytest.raises(InvalidScheduleInput, match="exceed"):
            find_cycle(edges, children_map=children_map)
        elapsed = time.perf_counter() - start
        # Enumerating 1M tuples takes seconds and allocates ~1M entries; the leaf-
        # count guard returns in well under the budget. Generous ceiling to stay
        # robust on slow CI while still proving the cross product is never built.
        assert elapsed < 1.0

    def test_just_under_cap_still_expands_and_detects(self) -> None:
        # 100 * 100 = 10,000 tuples is far below the cap, so expansion still runs
        # and a real logical cycle is detected. Pred and Succ summaries share leaf
        # "X", so PSum → SSum closes a self-loop on X after expansion.
        shared = "X"
        pred_leaves = [f"P{i}" for i in range(99)] + [shared]
        succ_leaves = [shared] + [f"S{i}" for i in range(99)]
        children_map = {"PSum": pred_leaves, "SSum": succ_leaves}
        result = find_cycle([("PSum", "SSum"), ("SSum", "PSum")], children_map=children_map)
        assert result is not None
        assert result[0] == result[-1]

    def test_cap_sums_across_multiple_edges(self) -> None:
        # No single edge exceeds the cap, but their combined fan-out does. The
        # guard sums per-edge products, so the aggregate blowup is still caught.
        per_summary = MAX_EXPANDED_EDGES // 2 + 10  # two such leaf→summary edges overflow
        children_map = {"Big": [f"L{i}" for i in range(per_summary)]}
        edges = [("Big", "T1"), ("Big", "T2")]
        with pytest.raises(InvalidScheduleInput, match="exceed"):
            find_cycle(edges, children_map=children_map)


# ---------------------------------------------------------------------------
# monte_carlo()
# ---------------------------------------------------------------------------


class TestMonteCarlo:
    def _simple_mc_project(self) -> Project:
        return make_project(
            tasks=[
                Task(
                    id="A",
                    name="A",
                    duration=timedelta(days=5),
                    optimistic_duration=timedelta(days=3),
                    most_likely_duration=timedelta(days=5),
                    pessimistic_duration=timedelta(days=10),
                ),
                Task(
                    id="B",
                    name="B",
                    duration=timedelta(days=3),
                    optimistic_duration=timedelta(days=2),
                    most_likely_duration=timedelta(days=3),
                    pessimistic_duration=timedelta(days=7),
                ),
            ],
            dependencies=[Dependency("A", "B")],
        )

    def test_returns_monte_carlo_result(self) -> None:
        r = monte_carlo(self._simple_mc_project(), runs=100, seed=42)
        assert isinstance(r, MonteCarloResult)
        assert r.runs == 100
        assert r.project_id == "test"

    def test_p50_le_p80_le_p95(self) -> None:
        """Percentile ordering must always hold."""
        r = monte_carlo(self._simple_mc_project(), runs=1_000, seed=0)
        assert r.p50 <= r.p80 <= r.p95

    def test_reproducible_with_seed(self) -> None:
        p = self._simple_mc_project()
        r1 = monte_carlo(p, runs=500, seed=99)
        r2 = monte_carlo(p, runs=500, seed=99)
        assert r1.p50 == r2.p50
        assert r1.p80 == r2.p80

    def _parallel_pert_tasks(self) -> list[Task]:
        """Build several independent (parallel-root) PERT tasks.

        With no dependencies between them, the topological-sort tie-break — i.e.
        the order the seeded RNG is consumed in — is the only thing that decides
        which sampled duration lands on which task. Distinct estimate shapes make
        any reordering visible in P50/P80/P95.
        """
        return [
            task(
                "A",
                "A",
                5,
                optimistic_duration=timedelta(days=3),
                most_likely_duration=timedelta(days=5),
                pessimistic_duration=timedelta(days=12),
            ),
            task(
                "B",
                "B",
                4,
                optimistic_duration=timedelta(days=2),
                most_likely_duration=timedelta(days=4),
                pessimistic_duration=timedelta(days=20),
            ),
            task(
                "C",
                "C",
                6,
                optimistic_duration=timedelta(days=4),
                most_likely_duration=timedelta(days=6),
                pessimistic_duration=timedelta(days=9),
            ),
            task(
                "D",
                "D",
                3,
                optimistic_duration=timedelta(days=1),
                most_likely_duration=timedelta(days=3),
                pessimistic_duration=timedelta(days=15),
            ),
        ]

    def test_seeded_percentiles_identical_across_runs(self) -> None:
        """Two seeded runs of the same project yield identical P50/P80/P95 (#774).

        Guards the seeded-reproducibility contract on all three percentiles, not
        just P50/P80 (the pre-existing test_reproducible_with_seed checked two).
        """
        p = make_project(self._parallel_pert_tasks())
        r1 = monte_carlo(p, runs=800, seed=7)
        r2 = monte_carlo(p, runs=800, seed=7)
        assert (r1.p50, r1.p80, r1.p95) == (r2.p50, r2.p80, r2.p95)

    def test_seeded_percentiles_independent_of_task_order(self) -> None:
        """Seeded P50/P80/P95 must not depend on task insertion order (#774).

        The RNG is consumed in lexicographical_topological_sort order keyed on the
        stable task id, so durations are bound to task ids — not to column
        position. Shuffling the task (and dependency) insertion order must leave
        the seeded percentiles unchanged. With a plain nx.topological_sort the
        tie-break could follow insertion order and silently shift the result.
        """
        tasks = self._parallel_pert_tasks()
        forward = make_project(list(tasks))
        reversed_order = make_project(list(reversed(tasks)))
        r_forward = monte_carlo(forward, runs=800, seed=7)
        r_reversed = monte_carlo(reversed_order, runs=800, seed=7)
        assert (r_forward.p50, r_forward.p80, r_forward.p95) == (
            r_reversed.p50,
            r_reversed.p80,
            r_reversed.p95,
        )

    def test_distribution_length_matches_runs(self) -> None:
        r = monte_carlo(self._simple_mc_project(), runs=200, seed=1)
        assert len(r.distribution) == 200

    def test_distribution_is_sorted(self) -> None:
        r = monte_carlo(self._simple_mc_project(), runs=200, seed=2)
        assert r.distribution == sorted(r.distribution)

    def test_deterministic_fallback_when_no_estimates(self) -> None:
        """Without PERT estimates, all runs produce the same result as CPM."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3)],
            dependencies=[Dependency("A", "B")],
        )
        r = monte_carlo(p, runs=100, seed=0)
        # All runs identical → P50 = P80 = P95
        assert r.p50 == r.p80 == r.p95

    def test_performance_10k_runs_200_tasks(self) -> None:
        """10 000 runs on a 200-task chain must complete in under 5 seconds."""
        import time

        tasks = [task(str(i), f"Task {i}", 3) for i in range(200)]
        deps = [Dependency(str(i), str(i + 1)) for i in range(199)]
        for t in tasks:
            t.optimistic_duration = timedelta(days=2)
            t.most_likely_duration = timedelta(days=3)
            t.pessimistic_duration = timedelta(days=5)
        p = make_project(tasks, deps)

        start = time.perf_counter()
        # Pass max_runs=None to bypass the OSS cap for this performance test.
        monte_carlo(p, runs=10_000, seed=0, max_runs=None)
        elapsed = time.perf_counter() - start
        assert elapsed < 5.0, f"Monte Carlo too slow: {elapsed:.2f}s"

    def test_cap_exceeded_by_runs(self) -> None:
        """Requesting more runs than max_runs raises SimulationCapExceeded."""
        with pytest.raises(SimulationCapExceeded, match="max_runs=1000"):
            monte_carlo(self._simple_mc_project(), runs=1_001, max_runs=1_000)

    def test_cap_exceeded_by_task_count(self) -> None:
        """Projects with more tasks than max_tasks raises SimulationCapExceeded."""
        tasks = [task(str(i), f"Task {i}", 1) for i in range(3)]
        p = make_project(tasks, [])
        with pytest.raises(SimulationCapExceeded, match="max_tasks=2"):
            monte_carlo(p, runs=10, max_tasks=2)

    def test_cap_disabled_when_none(self) -> None:
        """max_runs=None and max_tasks=None disables all caps."""
        tasks = [task(str(i), f"Task {i}", 1) for i in range(3)]
        p = make_project(tasks, [])
        # Should not raise even though runs > default cap and tasks > default cap.
        result = monte_carlo(p, runs=2_000, seed=0, max_runs=None, max_tasks=None)
        assert result.runs == 2_000

    def test_cap_exceeded_message_is_tier_neutral(self) -> None:
        """As a standalone Apache-2.0 library, the cap message must not reference
        any TruePPM tier — only the configurable ``max_runs`` knob."""
        with pytest.raises(SimulationCapExceeded) as exc_info:
            monte_carlo(self._simple_mc_project(), runs=1_001, max_runs=1_000)
        msg = str(exc_info.value)
        # Actionable: names the parameter the caller can raise.
        assert "max_runs" in msg
        # No tier/commercial wording leaks into the public package surface.
        for forbidden in ("tier", "OSS", "Team", "Enterprise", "Upgrade"):
            assert forbidden not in msg, f"tier wording leaked: {forbidden!r}"

    def test_no_tasks_raises(self) -> None:
        with pytest.raises(ValueError, match="at least one task"):
            monte_carlo(make_project([]), runs=10)

    def test_result_serialisable(self) -> None:
        r = monte_carlo(self._simple_mc_project(), runs=50, seed=0)
        d = r.to_dict()
        assert "p50" in d
        assert "p80" in d
        assert "p95" in d
        assert len(d["distribution"]) == 50

    def test_cyclic_dependency_raises(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 3), task("B", "B", 3)],
            dependencies=[Dependency("A", "B"), Dependency("B", "A")],
        )
        with pytest.raises(CyclicDependencyError):
            monte_carlo(p, runs=10)

    def test_deterministic_fallback_date_matches_cpm(self) -> None:
        """Without PERT estimates, MC P50/P80/P95 must equal CPM project_finish exactly."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3)],
            dependencies=[Dependency("A", "B")],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish

    def test_mc_lag_units_consistent_with_cpm(self) -> None:
        """MC with degenerate PERT and FS lag=7 calendar days matches CPM finish exactly."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3)],
            dependencies=[Dependency("A", "B", lag=timedelta(days=7))],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish

    def test_mc_fs_weekend_lag_matches_cpm(self) -> None:
        """A 1-calendar-day FS lag off a Friday finish snaps Sat→Mon in CPM, adding
        zero working days; MC must agree per run instead of adding a fixed
        reference-based working-day offset (#824). A: Mon→Fri 6-Mar; B starts
        Mon 9-Mar in both engines."""
        p = make_project(
            tasks=[task("A", "A", 5), task("B", "B", 3)],
            dependencies=[Dependency("A", "B", lag=timedelta(days=1))],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish

    def test_mc_ss_weekend_lag_matches_cpm(self) -> None:
        """SS lag=3 off a Friday start (X→A lands A on Fri 6-Mar) snaps to Mon in
        CPM; MC must convert the lag against A's actual Friday start, not the
        project-start reference (#824). The X→A FS chain (rather than a
        planned_start pin) is what lands A on a Friday."""
        p = make_project(
            tasks=[task("X", "X", 4), task("A", "A", 1), task("B", "B", 5)],
            dependencies=[
                Dependency("X", "A", dep_type=DependencyType.FS),
                Dependency("A", "B", dep_type=DependencyType.SS, lag=timedelta(days=3)),
            ],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish

    def test_mc_sf_lag_matches_cpm(self) -> None:
        """SF lag must finish a working day in step with CPM, not one day early.

        SF means the successor's *finish* clears the predecessor's *start* + lag.
        T0 starts Mon 2-Mar; +5 calendar days snaps Sat→Mon 9-Mar, so T1 must
        finish Mon 9-Mar and drives the project finish. Before #824 MC dropped the
        inclusive→exclusive +1 the FF branch already had and finished T1 on Fri
        6-Mar — one working day early. MC must now equal CPM exactly.
        """
        p = make_project(
            tasks=[task("T0", "T0", 2), task("T1", "T1", 2)],
            dependencies=[
                Dependency("T0", "T1", dep_type=DependencyType.SF, lag=timedelta(days=5)),
            ],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish

    def test_mc_sf_lag_free_matches_cpm(self) -> None:
        """A lag-free SF carries the same +1 — observable here through a downstream task.

        SF with lag 0 forces T1.finish >= P.start. P is pushed to Mon 9-Mar by the
        A→P FS chain, so T1 finishes Mon 9-Mar; its FS successor Z then starts Tue
        10-Mar, which drives the project finish. With the pre-#824 off-by-one T1
        finished Fri 6-Mar and Z started Mon 9-Mar — a full working day early. The
        predecessor alone never exposes this (P.finish >= P.start = T1.finish), so
        the downstream Z is what makes the lag-free SF correction visible.
        """
        p = make_project(
            tasks=[
                task("A", "A", 5),
                task("P", "P", 1),
                task("T1", "T1", 2),
                task("Z", "Z", 1),
            ],
            dependencies=[
                Dependency("A", "P", dep_type=DependencyType.FS),
                Dependency("P", "T1", dep_type=DependencyType.SF),
                Dependency("T1", "Z", dep_type=DependencyType.FS),
            ],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish

    def test_mc_ff_lag_matches_cpm(self) -> None:
        """FF lag parity guard — FF was already correct; lock it against regression.

        FF means the successor's finish clears the predecessor's finish + lag. T0
        finishes Tue 3-Mar; +5 calendar days snaps to Mon 9-Mar, so T1 finishes
        Mon 9-Mar and drives the project finish. MC must equal CPM.
        """
        p = make_project(
            tasks=[task("T0", "T0", 2), task("T1", "T1", 2)],
            dependencies=[
                Dependency("T0", "T1", dep_type=DependencyType.FF, lag=timedelta(days=5)),
            ],
        )
        cpm_result = schedule(p)
        mc_result = monte_carlo(p, runs=100, seed=0)
        assert mc_result.p50 == mc_result.p80 == mc_result.p95 == cpm_result.project_finish


# ---------------------------------------------------------------------------
# schedule() — parallel roots
# ---------------------------------------------------------------------------


class TestScheduleParallelRoots:
    def test_project_start_is_min_across_parallel_roots(self) -> None:
        """project_start = min(early_start) — not topo_order[0] — when roots are parallel."""
        # R1 has planned_start pinned to Mar 9; R2 floats to project start (Mar 2).
        # Whichever root topo_sort picks first, project_start must be Mar 2.
        p = make_project(
            tasks=[
                task("R1", "R1", 3, planned_start=date(2026, 3, 9)),
                task("R2", "R2", 3),
            ],
        )
        r = schedule(p)
        assert r.project_start == date(2026, 3, 2)


class TestScheduleResultOwnsItsSequences:
    """ScheduleResult defensively copies its list containers on construction (#826)."""

    def test_mutating_input_lists_does_not_affect_result(self) -> None:
        tasks = [Task(id="t-1", name="A", duration=timedelta(days=1))]
        cp = ["t-1"]
        result = ScheduleResult(
            project_id="p-1",
            project_start=date(2026, 1, 1),
            project_finish=date(2026, 1, 1),
            tasks=tasks,
            critical_path=cp,
        )
        tasks.append(Task(id="t-2", name="B", duration=timedelta(days=1)))
        cp.append("t-2")
        assert len(result.tasks) == 1
        assert result.critical_path == ["t-1"]


# ---------------------------------------------------------------------------
# monte_carlo() — zero-duration milestone parity with schedule() (#1066)
# ---------------------------------------------------------------------------


class TestMonteCarloMilestoneParity:
    """MC must agree with CPM on zero-duration milestones.

    The MC forward pass models finish as an exclusive working-day offset
    (EF = ES + duration), which collapsed a milestone's EF onto its ES: FS
    successors started a working day early, lag conversion anchored on the day
    *before* the milestone, and a terminal milestone's completion converted one
    day early. The effective-duration floor (a task occupies at least its start
    day, mirroring _finish_from_start) restores parity (#1066).
    """

    def _assert_parity(self, p: Project) -> None:
        cpm = schedule(p)
        mc = monte_carlo(p, runs=50, seed=0)
        assert mc.p50 == mc.p80 == mc.p95 == cpm.project_finish

    def test_milestone_mid_chain(self) -> None:
        """A(3d) → M(0d) → B(2d): MC finish must equal CPM's 2026-03-09."""
        p = make_project(
            tasks=[task("A", "A", 3), task("M", "M", 0), task("B", "B", 2)],
            dependencies=[Dependency("A", "M"), Dependency("M", "B")],
        )
        self._assert_parity(p)

    def test_terminal_milestone(self) -> None:
        """A terminal milestone's completion date converted one day early pre-fix."""
        p = make_project(
            tasks=[task("A", "A", 3), task("M", "M", 0)],
            dependencies=[Dependency("A", "M")],
        )
        self._assert_parity(p)

    def test_milestone_at_project_start(self) -> None:
        p = make_project(
            tasks=[task("M", "M", 0), task("B", "B", 2)],
            dependencies=[Dependency("M", "B")],
        )
        self._assert_parity(p)

    def test_fs_lag_out_of_a_milestone_anchors_on_the_milestone_day(self) -> None:
        """Pre-fix the lag delta indexed wd_index[k-1] — the day *before* the
        milestone — so divergence could be in either direction."""
        p = make_project(
            tasks=[task("A", "A", 3), task("M", "M", 0), task("B", "B", 2)],
            dependencies=[
                Dependency("A", "M"),
                Dependency("M", "B", lag=timedelta(days=1)),
            ],
        )
        self._assert_parity(p)

    def test_ff_out_of_a_milestone(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 3), task("M", "M", 0), task("B", "B", 4)],
            dependencies=[
                Dependency("A", "M"),
                Dependency("M", "B", dep_type=DependencyType.FF, lag=timedelta(days=2)),
            ],
        )
        self._assert_parity(p)

    def test_milestone_with_ef_constraint(self) -> None:
        """A milestone pushed by an FF predecessor sits wholly on the constraint day."""
        p = make_project(
            tasks=[task("A", "A", 4), task("M", "M", 0), task("B", "B", 1)],
            dependencies=[
                Dependency("A", "M", dep_type=DependencyType.FF),
                Dependency("M", "B"),
            ],
        )
        self._assert_parity(p)

    def test_randomized_parity_fuzz_with_milestones(self) -> None:
        """Bounded differential fuzz: deterministic-duration MC == CPM, with
        zero-duration tasks, every dependency type, ±lags, and calendar
        exceptions in the mix. Seeded → reproducible. The 24/400 pre-fix
        failures were all zero-duration cases (#1066)."""
        import random

        rnd = random.Random(20260610)
        dep_types = list(DependencyType)
        for _ in range(60):
            n = rnd.randint(2, 8)
            tasks = [task(f"T{i}", f"T{i}", rnd.choice([0, 1, 1, 2, 3, 5, 8])) for i in range(n)]
            deps = []
            for i in range(n):
                for j in range(i + 1, n):
                    if rnd.random() < 0.35:
                        deps.append(
                            Dependency(
                                f"T{i}",
                                f"T{j}",
                                dep_type=rnd.choice(dep_types),
                                lag=timedelta(days=rnd.choice([-3, -1, 0, 0, 0, 1, 2, 5])),
                            )
                        )
            cal = Calendar(
                exceptions=[DateRange(date(2026, 3, 11), date(2026, 3, 12))]
                if rnd.random() < 0.5
                else []
            )
            p = make_project(tasks, deps, calendar=cal)
            cpm = schedule(p)
            mc = monte_carlo(p, runs=8, seed=0)
            dep_repr = [
                (d.predecessor_id, d.successor_id, d.dep_type.value, d.lag.days) for d in deps
            ]
            assert mc.p50 == mc.p95 == cpm.project_finish, (
                f"MC/CPM divergence: CPM={cpm.project_finish} MC={mc.p50} "
                f"deps={dep_repr} durations={[t.duration.days for t in tasks]}"
            )


# ---------------------------------------------------------------------------
# monte_carlo() — planned_start (SNET) parity with schedule() (#1068)
# ---------------------------------------------------------------------------


class TestMonteCarloPlannedStart:
    """MC honors planned_start as the same SNET floor the deterministic pass applies.

    Pre-fix the MC forward pass floored every task at project start, so the P50
    of a project with a pinned task could predate the deterministic early
    finish by months (#1068).
    """

    def test_pinned_task_matches_cpm(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 2, planned_start=date(2026, 6, 1))],
        )
        cpm = schedule(p)
        mc = monte_carlo(p, runs=50, seed=0)
        assert mc.p50 == mc.p95 == cpm.project_finish == date(2026, 6, 2)

    def test_pin_cascades_through_chain(self) -> None:
        p = make_project(
            tasks=[
                task("A", "A", 3, planned_start=date(2026, 3, 16)),
                task("B", "B", 2),
            ],
            dependencies=[Dependency("A", "B")],
        )
        cpm = schedule(p)
        mc = monte_carlo(p, runs=50, seed=0)
        assert mc.p50 == mc.p95 == cpm.project_finish

    def test_pin_before_project_start_is_ignored(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 3, planned_start=date(2026, 2, 2))],
        )
        cpm = schedule(p)
        mc = monte_carlo(p, runs=50, seed=0)
        assert mc.p50 == mc.p95 == cpm.project_finish == date(2026, 3, 4)

    def test_weekend_pin_snaps_to_next_working_day(self) -> None:
        p = make_project(
            tasks=[task("A", "A", 2, planned_start=date(2026, 3, 7))],  # Saturday
        )
        cpm = schedule(p)
        mc = monte_carlo(p, runs=50, seed=0)
        assert mc.p50 == mc.p95 == cpm.project_finish == date(2026, 3, 10)

    def test_pin_beyond_span_cap_rejected(self) -> None:
        """A pin in year 9999 must not drive a multi-million-entry index build."""
        from trueppm_scheduler import InvalidScheduleInput

        p = make_project(
            tasks=[task("A", "A", 1, planned_start=date(9999, 1, 1))],
        )
        with pytest.raises(InvalidScheduleInput, match="planned_start"):
            monte_carlo(p, runs=10, seed=0)
        with pytest.raises(InvalidScheduleInput, match="planned_start"):
            schedule(p)


# ---------------------------------------------------------------------------
# Progress-aware forecasting (ADR-0132)
# ---------------------------------------------------------------------------


class TestProgressAware:
    """schedule() and monte_carlo() honor completion, remaining work, and the
    data date — they no longer forecast a project as if starting from scratch."""

    def test_completed_task_pins_successor_to_actual_finish(self) -> None:
        """A completed predecessor anchors its FS successor to its *actual*
        finish, not its planned schedule."""
        # A planned 5d (would finish 6-Mar) but actually ran long, finishing
        # 20-Mar. B must start after the actual finish, not the planned one.
        p = make_project(
            tasks=[
                task(
                    "A",
                    "A",
                    5,
                    actual_start=date(2026, 3, 2),
                    actual_finish=date(2026, 3, 20),  # Friday
                    percent_complete=100.0,
                ),
                task("B", "B", 3),
            ],
            dependencies=[Dependency("A", "B")],
            start=date(2026, 3, 2),
        )
        p.status_date = date(2026, 3, 23)  # Monday
        r = schedule(p)
        by_id = {t.id: t for t in r.tasks}

        # A is pinned to its actuals (not re-scheduled to 2-Mar..6-Mar).
        assert by_id["A"].early_start == date(2026, 3, 2)
        assert by_id["A"].early_finish == date(2026, 3, 20)
        assert by_id["A"].total_float == timedelta(0)  # done => no slack
        # B starts the working day after A's actual finish.
        assert by_id["B"].early_start == date(2026, 3, 23)  # Monday
        assert by_id["B"].early_finish == date(2026, 3, 25)  # Wed
        assert r.project_finish == date(2026, 3, 25)

    def test_in_progress_task_uses_remaining_duration_from_data_date(self) -> None:
        """A 10d task that is 60% done has 4 working days left, laid forward from
        the data date — not 10 days from project start."""
        p = make_project(
            tasks=[
                task(
                    "A",
                    "A",
                    10,
                    actual_start=date(2026, 3, 2),
                    percent_complete=60.0,
                ),
            ],
            start=date(2026, 3, 2),
        )
        p.status_date = date(2026, 3, 16)  # Monday, two weeks in
        r = schedule(p)
        t = r.tasks[0]
        # 4 remaining days from 16-Mar: Mon16, Tue17, Wed18, Thu19.
        assert t.early_start == date(2026, 3, 16)
        assert t.early_finish == date(2026, 3, 19)
        assert r.project_finish == date(2026, 3, 19)

    def test_status_date_floors_not_started_work(self) -> None:
        """Not-started work cannot be scheduled before the data date."""
        p = make_project([task("A", "A", 5)], start=date(2026, 3, 2))
        p.status_date = date(2026, 3, 16)  # Monday
        r = schedule(p)
        t = r.tasks[0]
        assert t.early_start == date(2026, 3, 16)
        assert t.early_finish == date(2026, 3, 20)  # Fri

    def test_no_progress_and_no_status_date_is_unchanged(self) -> None:
        """With percent_complete=0, no actuals, and no status date, the schedule
        is byte-identical to a pure planning pass (backward compatible)."""
        p = make_project([task("A", "A", 5, percent_complete=0.0)], start=date(2026, 3, 2))
        r = schedule(p)
        t = r.tasks[0]
        assert t.early_start == date(2026, 3, 2)
        assert t.early_finish == date(2026, 3, 6)

    def test_monte_carlo_matches_cpm_finish_with_completed_phase(self) -> None:
        """A deterministic project with a completed phase simulates to exactly the
        progress-aware CPM finish — proving MC pins completed work instead of
        re-rolling it from project start (which would finish far too early)."""
        p = make_project(
            tasks=[
                task(
                    "A",
                    "A",
                    5,
                    actual_start=date(2026, 3, 2),
                    actual_finish=date(2026, 3, 20),
                    percent_complete=100.0,
                ),
                task("B", "B", 3),
            ],
            dependencies=[Dependency("A", "B")],
            start=date(2026, 3, 2),
        )
        p.status_date = date(2026, 3, 23)
        cpm_finish = schedule(p).project_finish
        mc = monte_carlo(p, runs=200, seed=0)
        # Deterministic network => every run identical, equal to the CPM finish.
        assert mc.p50 == mc.p80 == mc.p95 == cpm_finish == date(2026, 3, 25)

    def test_monte_carlo_matches_cpm_finish_with_in_progress_task(self) -> None:
        """In-progress remaining work flows through Monte Carlo the same way it
        flows through CPM (deterministic network => MC == CPM)."""
        p = make_project(
            tasks=[
                task("A", "A", 10, actual_start=date(2026, 3, 2), percent_complete=60.0),
                task("B", "B", 3),
            ],
            dependencies=[Dependency("A", "B")],
            start=date(2026, 3, 2),
        )
        p.status_date = date(2026, 3, 16)
        cpm_finish = schedule(p).project_finish
        mc = monte_carlo(p, runs=200, seed=0)
        assert mc.p50 == mc.p80 == mc.p95 == cpm_finish

    def test_far_future_status_date_is_rejected(self) -> None:
        """A data date beyond the span cap is rejected on both engines before any
        working-day index is built — guarding the MC index against a
        multi-million-entry allocation (#1186 DoS guard)."""
        p = make_project([task("A", "A", 5)], start=date(2026, 3, 2))
        p.status_date = date(9999, 12, 31)
        with pytest.raises(InvalidScheduleInput, match="status_date"):
            schedule(p)
        with pytest.raises(InvalidScheduleInput, match="status_date"):
            monte_carlo(p, runs=10, seed=0)

    def test_status_date_round_trips_through_serialization(self) -> None:
        """Project.status_date and Task actuals survive to_dict/from_dict."""
        p = make_project(
            tasks=[
                task(
                    "A",
                    "A",
                    5,
                    actual_start=date(2026, 3, 2),
                    actual_finish=date(2026, 3, 6),
                    percent_complete=100.0,
                ),
            ],
            start=date(2026, 3, 2),
        )
        p.status_date = date(2026, 3, 16)
        restored = Project.from_dict(p.to_dict())
        assert restored.status_date == date(2026, 3, 16)
        assert restored.tasks[0].actual_start == date(2026, 3, 2)
        assert restored.tasks[0].actual_finish == date(2026, 3, 6)
