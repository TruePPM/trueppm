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
    MonteCarloResult,
    Project,
    ScheduleResult,
    SimulationCapExceeded,
    Task,
    find_cycle,
    monte_carlo,
    schedule,
)

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
