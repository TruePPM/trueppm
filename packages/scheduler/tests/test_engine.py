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
        with pytest.raises(SimulationCapExceeded, match="1000 simulations"):
            monte_carlo(self._simple_mc_project(), runs=1_001, max_runs=1_000)

    def test_cap_exceeded_by_task_count(self) -> None:
        """Projects with more tasks than max_tasks raises SimulationCapExceeded."""
        tasks = [task(str(i), f"Task {i}", 1) for i in range(3)]
        p = make_project(tasks, [])
        with pytest.raises(SimulationCapExceeded, match="3 tasks"):
            monte_carlo(p, runs=10, max_tasks=2)

    def test_cap_disabled_when_none(self) -> None:
        """max_runs=None and max_tasks=None disables all caps (Team tier)."""
        tasks = [task(str(i), f"Task {i}", 1) for i in range(3)]
        p = make_project(tasks, [])
        # Should not raise even though runs > default cap and tasks > default cap.
        result = monte_carlo(p, runs=2_000, seed=0, max_runs=None, max_tasks=None)
        assert result.runs == 2_000

    def test_cap_exceeded_message_is_user_facing(self) -> None:
        """Error message is suitable for direct display in a UI or API response."""
        with pytest.raises(SimulationCapExceeded) as exc_info:
            monte_carlo(self._simple_mc_project(), runs=1_001, max_runs=1_000)
        msg = str(exc_info.value)
        assert "OSS tier" in msg
        assert "Team tier" in msg

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
