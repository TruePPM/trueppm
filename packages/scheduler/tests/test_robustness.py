"""Adversarial-input tests for the scheduler.

These cover the red-team findings (issue #749): degenerate calendars, absurd
durations/lag, non-positive run counts, malformed children_map, and non-finite
JSON literals must all be rejected eagerly and cleanly — never with a
multi-million-iteration spin, an uncaught ``OverflowError``, or a
``RecursionError``.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    DateRange,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    find_cycle,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine import (
    MAX_DURATION_DAYS,
    MAX_LAG_DAYS,
    MAX_PROJECT_SPAN_DAYS,
    _collect_leaves,
)


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


def task(tid: str, days: int, **kwargs: object) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days), **kwargs)  # type: ignore[arg-type]


class TestContract:
    def test_invalid_schedule_input_is_a_value_error(self) -> None:
        """Subclassing ValueError preserves the documented exception contract."""
        assert issubclass(InvalidScheduleInput, ValueError)


class TestDegenerateCalendar:
    def test_empty_working_day_mask_rejected_in_schedule(self) -> None:
        p = make_project([task("A", 1)], calendar=Calendar(working_days=0))
        with pytest.raises(InvalidScheduleInput, match="no working weekday"):
            schedule(p)

    def test_empty_working_day_mask_rejected_in_monte_carlo(self) -> None:
        p = make_project([task("A", 1)], calendar=Calendar(working_days=0))
        with pytest.raises(InvalidScheduleInput, match="no working weekday"):
            monte_carlo(p, runs=10)

    def test_mask_with_only_non_weekday_bits_rejected(self) -> None:
        """Bits >= 7 are ignored by is_working_day, so they count as 'no working day'."""
        p = make_project([task("A", 1)], calendar=Calendar(working_days=0b1000_0000))
        with pytest.raises(InvalidScheduleInput, match="no working weekday"):
            schedule(p)

    def test_exceptions_blanketing_every_day_rejected(self) -> None:
        """A valid mask but exceptions covering the whole search window must not spin."""
        cal = Calendar(exceptions=[DateRange(date(1900, 1, 1), date(2400, 1, 1))])
        p = make_project([task("A", 1)], calendar=cal)
        with pytest.raises(InvalidScheduleInput, match="no working day within"):
            schedule(p)


class TestDurationBounds:
    def test_duration_over_max_rejected(self) -> None:
        p = make_project([task("A", MAX_DURATION_DAYS + 1)])
        with pytest.raises(InvalidScheduleInput, match="exceeds the maximum"):
            schedule(p)

    def test_negative_duration_rejected(self) -> None:
        p = make_project([task("A", -1)])
        with pytest.raises(InvalidScheduleInput, match="must not be negative"):
            schedule(p)

    def test_pert_estimate_over_max_rejected(self) -> None:
        p = make_project([task("A", 1, pessimistic_duration=timedelta(days=MAX_DURATION_DAYS + 1))])
        with pytest.raises(InvalidScheduleInput, match="pessimistic_duration"):
            monte_carlo(p, runs=10)

    def test_duration_at_max_is_accepted(self) -> None:
        """The boundary value is valid and schedules without error."""
        p = make_project([task("A", MAX_DURATION_DAYS)])
        result = schedule(p)
        assert result.tasks[0].is_critical is True


class TestLagBounds:
    def test_lag_over_max_rejected(self) -> None:
        p = make_project(
            [task("A", 1), task("B", 1)],
            [Dependency("A", "B", DependencyType.FS, lag=timedelta(days=MAX_LAG_DAYS + 1))],
        )
        with pytest.raises(InvalidScheduleInput, match="lag exceeds"):
            schedule(p)

    def test_negative_lag_under_min_rejected(self) -> None:
        p = make_project(
            [task("A", 1), task("B", 1)],
            [Dependency("A", "B", DependencyType.FS, lag=timedelta(days=-(MAX_LAG_DAYS + 1)))],
        )
        with pytest.raises(InvalidScheduleInput, match="lag exceeds"):
            schedule(p)


class TestProjectSpan:
    def test_cumulative_span_over_max_rejected(self) -> None:
        # Each task is within the per-task cap, but together they exceed the
        # cumulative project span — the case per-field bounds alone miss.
        n = MAX_PROJECT_SPAN_DAYS // MAX_DURATION_DAYS + 2
        p = make_project([task(f"t{i}", MAX_DURATION_DAYS) for i in range(n)])
        with pytest.raises(InvalidScheduleInput, match="Total project span"):
            schedule(p)

    def test_cumulative_span_rejected_in_monte_carlo(self) -> None:
        n = MAX_PROJECT_SPAN_DAYS // MAX_DURATION_DAYS + 2
        p = make_project([task(f"t{i}", MAX_DURATION_DAYS) for i in range(n)])
        with pytest.raises(InvalidScheduleInput, match="Total project span"):
            monte_carlo(p, runs=10, max_tasks=None)

    def test_span_counts_most_likely_estimate(self) -> None:
        # Guard against the PERT bypass: zero deterministic/optimistic/pessimistic
        # durations but a huge most_likely, which Monte Carlo samples as a
        # constant when the [opt, pess] range is degenerate. The span must still
        # count it, or the eager guard would never fire on these tasks.
        n = MAX_PROJECT_SPAN_DAYS // MAX_DURATION_DAYS + 2
        tasks = [
            task(
                f"t{i}",
                0,
                optimistic_duration=timedelta(0),
                most_likely_duration=timedelta(days=MAX_DURATION_DAYS),
                pessimistic_duration=timedelta(0),
            )
            for i in range(n)
        ]
        p = make_project(tasks)
        with pytest.raises(InvalidScheduleInput, match="Total project span"):
            monte_carlo(p, runs=10, max_tasks=None)


class TestRunsGuard:
    def test_zero_runs_rejected(self) -> None:
        p = make_project([task("A", 1)])
        with pytest.raises(ValueError, match="positive integer"):
            monte_carlo(p, runs=0)

    def test_negative_runs_rejected(self) -> None:
        p = make_project([task("A", 1)])
        with pytest.raises(ValueError, match="positive integer"):
            monte_carlo(p, runs=-5)


class TestChildrenMapGuards:
    def test_collect_leaves_rejects_cycle(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="cycle"):
            _collect_leaves("A", {"A": ["B"], "B": ["A"]})

    def test_find_cycle_rejects_cyclic_children_map(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="cycle"):
            find_cycle([("A", "X")], children_map={"A": ["B"], "B": ["A"]})

    def test_deeply_nested_children_map_does_not_recurse(self) -> None:
        """Nesting far beyond Python's recursion limit resolves iteratively."""
        depth = 5_000
        cmap = {f"n{i}": [f"n{i + 1}"] for i in range(depth)}
        assert _collect_leaves("n0", cmap) == [f"n{depth}"]

    def test_diamond_children_map_is_not_a_cycle(self) -> None:
        """A leaf reachable via two parents is a diamond, not a cycle."""
        cmap = {"root": ["L", "R"], "L": ["leaf"], "R": ["leaf"]}
        # leaf appears once per path; callers dedupe edges downstream.
        assert _collect_leaves("root", cmap) == ["leaf", "leaf"]


class TestNonFiniteJson:
    def test_infinity_duration_rejected(self) -> None:
        doc = (
            '{"id":"p","name":"n","start_date":"2026-01-01",'
            '"tasks":[{"id":"a","name":"A","duration":Infinity}],'
            '"dependencies":[],"calendar":{}}'
        )
        with pytest.raises(ValueError, match="Non-finite JSON literal"):
            Project.from_json(doc)

    def test_nan_percent_complete_rejected(self) -> None:
        doc = (
            '{"id":"p","name":"n","start_date":"2026-01-01",'
            '"tasks":[{"id":"a","name":"A","duration":86400,"percent_complete":NaN}],'
            '"dependencies":[],"calendar":{}}'
        )
        with pytest.raises(ValueError, match="Non-finite JSON literal"):
            Project.from_json(doc)

    def test_from_dict_rejects_infinite_duration(self) -> None:
        """The from_dict path (no json.loads) is guarded by _parse_timedelta."""
        with pytest.raises(ValueError, match="finite"):
            Task.from_dict({"id": "a", "name": "A", "duration": float("inf")})

    def test_from_dict_rejects_nan_percent_complete(self) -> None:
        with pytest.raises(ValueError, match="finite"):
            Task.from_dict(
                {"id": "a", "name": "A", "duration": 86400, "percent_complete": float("nan")}
            )
