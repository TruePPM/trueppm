"""Per-task completion percentiles (#4135).

The invariant properties (target never later than the project, no RNG consumed,
zero variance equals CPM per target) run over the contract fuzz and the shared
conformance corpus in ``test_contract_fuzz.py``; these pin the known answers and
the edges.
"""

from __future__ import annotations

import pickle
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    MC_TARGET_CAP,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    TargetForecast,
    Task,
    monte_carlo,
    schedule,
)

MON = date(2026, 1, 5)


def _task(
    tid: str, days: int, three_point: tuple[int, int, int] | None = None, **kw: object
) -> Task:
    if three_point is not None:
        o, m, p = three_point
        kw.update(
            optimistic_duration=timedelta(days=o),
            most_likely_duration=timedelta(days=m),
            pessimistic_duration=timedelta(days=p),
        )
    return Task(id=tid, name=tid, duration=timedelta(days=days), **kw)  # type: ignore[arg-type]


def _fs(a: str, b: str, **kw: object) -> Dependency:
    return Dependency(predecessor_id=a, successor_id=b, **kw)  # type: ignore[arg-type]


#: B's PERT triple, chosen so B overruns A's fixed 10 days in roughly a third of runs.
_B_TRIPLE = (8, 9, 14)


def _two_branch() -> Project:
    """S -> {A (fixed 10d), B (8/9/14)} -> M: A is critical exactly when B <= 10."""
    return Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[
            _task("S", 1),
            _task("A", 10),
            _task("B", 8, _B_TRIPLE),
            _task("M", 0),
        ],
        dependencies=[_fs("S", "A"), _fs("S", "B"), _fs("A", "M"), _fs("B", "M")],
    )


class TestDefaultsOff:
    def test_default_run_carries_no_new_output(self) -> None:
        r = monte_carlo(_two_branch(), runs=200, seed=1)
        assert r.targets is None
        assert "targets" not in r.to_dict()
        assert all(set(s.to_dict()) == {"task_id", "index"} for s in r.sensitivity)

    def test_options_leave_the_project_reading_byte_identical(self) -> None:
        base = monte_carlo(_two_branch(), runs=3_000, seed=5)
        both = monte_carlo(_two_branch(), runs=3_000, seed=5, targets=["A", "M"])
        assert both.percentiles == base.percentiles
        assert both.distribution == base.distribution
        assert [(s.task_id, s.index) for s in both.sensitivity] == [
            (s.task_id, s.index) for s in base.sensitivity
        ]


class TestTargets:
    def test_targets_are_returned_in_request_order_and_deduplicated(self) -> None:
        r = monte_carlo(_two_branch(), runs=500, seed=2, targets=["M", "A", "M"])
        assert r.targets is not None
        assert list(r.targets) == ["M", "A"]
        assert all(isinstance(t, TargetForecast) for t in r.targets.values())

    def test_fixed_branch_target_is_its_cpm_finish_and_the_varying_one_widens(self) -> None:
        project = _two_branch()
        cpm = {t.id: t for t in schedule(project).tasks}
        r = monte_carlo(project, runs=2_000, seed=3, targets=["A", "B", "M"])
        assert r.targets is not None
        a, b, m = r.targets["A"], r.targets["B"], r.targets["M"]
        assert a.p50 == a.p80 == a.p95 == cpm["A"].early_finish
        assert b.p50 <= b.p80 <= b.p95 and b.p95 > b.p50
        # The finish milestone is the project finish in every run.
        assert (m.p50, m.p80, m.p95) == (r.p50, r.p80, r.p95)
        assert m.distribution == r.distribution

    def test_completed_target_reports_its_recorded_finish_at_every_level(self) -> None:
        done = _task(
            "D",
            3,
            percent_complete=100,
            actual_start=MON,
            actual_finish=date(2026, 1, 10),  # a Saturday: verbatim, not snapped
        )
        project = Project(
            id="p",
            name="p",
            start_date=MON,
            status_date=date(2026, 1, 12),
            tasks=[done, _task("L", 4, (4, 5, 9))],
            dependencies=[_fs("D", "L")],
        )
        r = monte_carlo(project, runs=300, seed=4, targets=["D", "L"])
        assert r.targets is not None
        d = r.targets["D"]
        assert d.p50 == d.p80 == d.p95 == date(2026, 1, 10)
        assert set(d.distribution) == {date(2026, 1, 10)}

    def test_in_progress_target_reads_from_its_remaining_window(self) -> None:
        wip = _task("W", 10, actual_start=MON, percent_complete=50)
        project = Project(id="p", name="p", start_date=MON, status_date=MON, tasks=[wip])
        cpm = schedule(project).tasks[0]
        r = monte_carlo(project, runs=50, seed=1, targets=["W"])
        assert r.targets is not None
        assert r.targets["W"].p50 == cpm.early_finish == r.p50

    def test_six_day_calendar_target_converts_through_its_own_week(self) -> None:
        from trueppm_scheduler import Calendar

        six = Calendar(working_days=0b011_1111)  # Mon-Sat
        project = Project(
            id="p",
            name="p",
            start_date=MON,
            tasks=[_task("five", 6), _task("six", 6, calendar_id="six")],
            calendars={"six": six},
        )
        cpm = {t.id: t for t in schedule(project).tasks}
        assert cpm["six"].early_finish == date(2026, 1, 10)  # Saturday, a working day here
        r = monte_carlo(project, runs=40, seed=9, targets=["six", "five"])
        assert r.targets is not None
        assert r.targets["six"].p80 == date(2026, 1, 10)
        assert r.targets["five"].p80 == cpm["five"].early_finish == date(2026, 1, 12)

    def test_to_dict_carries_percentiles_but_not_the_distribution(self) -> None:
        r = monte_carlo(_two_branch(), runs=100, seed=1, targets=["B"])
        out = r.to_dict()["targets"]
        assert out == [
            {
                "task_id": "B",
                "p50": r.targets["B"].p50.isoformat(),  # type: ignore[index]
                "p80": r.targets["B"].p80.isoformat(),  # type: ignore[index]
                "p95": r.targets["B"].p95.isoformat(),  # type: ignore[index]
                "p50_at_day_start": False,
                "p80_at_day_start": False,
                "p95_at_day_start": False,
            }
        ]

    def test_result_round_trips_through_pickle(self) -> None:
        r = monte_carlo(_two_branch(), runs=100, seed=1, targets=["B"])
        clone = pickle.loads(pickle.dumps(r))
        assert clone.targets == r.targets


class TestVerbatimNonWorkingDay:
    """A milestone held on a weekend ``actual_start`` is read on that day (#4135)."""

    def test_open_milestone_on_a_weekend_actual_start_matches_cpm(self) -> None:
        saturday = date(2026, 8, 1)
        project = Project(
            id="p",
            name="p",
            start_date=date(2026, 3, 2),
            tasks=[Task(id="m", name="m", duration=timedelta(0), actual_start=saturday)],
            dependencies=[],
        )
        (task,) = schedule(project).tasks
        result = monte_carlo(project, runs=8, seed=3, targets=["m"])
        assert result.targets is not None
        forecast = result.targets["m"]
        assert task.early_finish == saturday
        assert (forecast.p50, forecast.p80, forecast.p95) == (saturday,) * 3
        assert set(forecast.distribution) == {saturday}
        assert forecast.percentiles[50] == result.percentiles[50]


class TestNeverLaterThanProject:
    """A target is never shown later than the project at the same level (#4135)."""

    def test_same_instant_start_of_day_reading_is_capped_at_the_project(self) -> None:
        # A start-of-day milestone and day-end work tie in working time: without the
        # cap, ``join`` P95 read the start of Mon 23rd and the project the end of
        # Fri 20th.
        day = timedelta(days=1)
        project = Project(
            id="p",
            name="p",
            start_date=date(2026, 3, 2),
            tasks=[
                Task(id="gate", name="gate", duration=timedelta(0)),
                Task(
                    id="spread",
                    name="spread",
                    duration=timedelta(0),
                    optimistic_duration=timedelta(0),
                    most_likely_duration=timedelta(0),
                    pessimistic_duration=23 * day,
                ),
                Task(id="work", name="work", duration=day),
                Task(id="join", name="join", duration=timedelta(0)),
            ],
            dependencies=[
                _fs("gate", "spread"),
                _fs("spread", "work", lag=4 * day),
                _fs("gate", "work"),
                Dependency("gate", "join", DependencyType.SS),
                _fs("spread", "join", lag=5 * day),
            ],
        )
        result = monte_carlo(project, runs=24, seed=7, targets=["join"])
        assert result.targets is not None
        for level, reading in result.targets["join"].percentiles.items():
            bound = result.percentiles[level]
            assert (reading.date, not reading.at_day_start) <= (bound.date, not bound.at_day_start)


class TestTargetValidation:
    @pytest.mark.parametrize("bad", ["A", b"A", 5, ["A", 3]])
    def test_malformed_targets_are_refused(self, bad: object) -> None:
        with pytest.raises(InvalidScheduleInput, match="targets"):
            monte_carlo(_two_branch(), runs=10, seed=1, targets=bad)  # type: ignore[arg-type]

    def test_unknown_target_is_refused(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="unknown task ids"):
            monte_carlo(_two_branch(), runs=10, seed=1, targets=["nope"])

    def test_target_count_is_capped(self) -> None:
        n = MC_TARGET_CAP + 1
        project = Project(
            id="p", name="p", start_date=MON, tasks=[_task(f"t{i}", 1) for i in range(n)]
        )
        ids = [t.id for t in project.tasks]
        with pytest.raises(InvalidScheduleInput, match="MC_TARGET_CAP"):
            monte_carlo(project, runs=10, seed=1, targets=ids)
        r = monte_carlo(project, runs=10, seed=1, targets=ids[:MC_TARGET_CAP])
        assert r.targets is not None and len(r.targets) == MC_TARGET_CAP
