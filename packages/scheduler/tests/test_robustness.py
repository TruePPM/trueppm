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

    def test_exceptions_blanketing_every_day_rejected_in_monte_carlo(self) -> None:
        """The Monte Carlo path must reject a blanket calendar too (#749 regression).

        Before the validation-layer reachability probe, monte_carlo() had no
        calendar snap ahead of its working-day-index build, so a blanket-exceptions
        calendar drove that build past the representable date range and raised an
        uncaught OverflowError — where schedule() raised a clean
        InvalidScheduleInput. The two engine entry points must reject identically.
        """
        cal = Calendar(exceptions=[DateRange(date(1900, 1, 1), date(9999, 12, 31))])
        p = make_project(
            [
                task(
                    "A",
                    2,
                    optimistic_duration=timedelta(days=1),
                    most_likely_duration=timedelta(days=2),
                    pessimistic_duration=timedelta(days=4),
                )
            ],
            calendar=cal,
        )
        with pytest.raises(InvalidScheduleInput, match="no working day within"):
            monte_carlo(p, runs=50)

    def test_working_day_at_start_then_blanket_rejected(self) -> None:
        """A single working day at the start followed by a blanket gap must not spin.

        The reachability probe only checks the project start, so this case slips
        past it: the start IS a working day, but no second working day exists for
        a multi-day task to expand into. The guarded inner walk
        (_finish_from_start / _build_working_day_index) is the backstop that keeps
        both engines from walking the date off its ceiling (OverflowError).
        """
        cal = Calendar(exceptions=[DateRange(date(2026, 3, 3), date(9999, 12, 31))])
        p = make_project([task("A", 3)], calendar=cal)
        with pytest.raises(InvalidScheduleInput, match="no working day within"):
            schedule(p)

    def test_working_day_at_start_then_blanket_rejected_in_monte_carlo(self) -> None:
        cal = Calendar(exceptions=[DateRange(date(2026, 3, 3), date(9999, 12, 31))])
        p = make_project(
            [
                task(
                    "A",
                    3,
                    optimistic_duration=timedelta(days=2),
                    most_likely_duration=timedelta(days=3),
                    pessimistic_duration=timedelta(days=5),
                )
            ],
            calendar=cal,
        )
        with pytest.raises(InvalidScheduleInput, match="no working day within"):
            monte_carlo(p, runs=50)


class TestDuplicateTaskIds:
    """Duplicate task ids must be rejected, not silently shadowed (#749).

    The engine keys task_map / the graph / every result on Task.id, so a
    duplicate id leaves the shadowed task with all-None CPM fields in the
    result — a corrupt ScheduleResult that crashes naive consumers.
    """

    def test_duplicate_id_rejected_in_schedule(self) -> None:
        p = make_project([task("A", 3), task("A", 2)])
        with pytest.raises(InvalidScheduleInput, match="Duplicate task id"):
            schedule(p)

    def test_duplicate_id_rejected_in_monte_carlo(self) -> None:
        p = make_project([task("A", 3), task("A", 2)])
        with pytest.raises(InvalidScheduleInput, match="Duplicate task id"):
            monte_carlo(p, runs=10)

    def test_unique_ids_accepted(self) -> None:
        result = schedule(make_project([task("A", 3), task("B", 2)]))
        assert {t.id for t in result.tasks} == {"A", "B"}
        # No task may carry an uncomputed (None) early_start.
        assert all(t.early_start is not None for t in result.tasks)


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
        # Guard against the PERT bypass: zero deterministic duration but huge
        # estimates, which Monte Carlo samples as a constant when the
        # [opt, pess] range is degenerate. The span must count the estimates,
        # or the eager guard would never fire on these tasks. (Estimates must
        # be ordered since #1069, so most_likely == pessimistic here; the
        # deterministic duration alone still contributes nothing to the span.)
        n = MAX_PROJECT_SPAN_DAYS // MAX_DURATION_DAYS + 2
        tasks = [
            task(
                f"t{i}",
                0,
                optimistic_duration=timedelta(0),
                most_likely_duration=timedelta(days=MAX_DURATION_DAYS),
                pessimistic_duration=timedelta(days=MAX_DURATION_DAYS),
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

    def test_from_dict_rejects_infinite_story_points(self) -> None:
        """story_points is finite-checked at parse, matching the from_json path (#1010)."""
        with pytest.raises(ValueError, match="story_points must be a finite number"):
            Task.from_dict(
                {"id": "a", "name": "A", "duration": 86400, "story_points": float("inf")}
            )

    def test_from_dict_rejects_infinite_velocity_sample(self) -> None:
        """An inf velocity sample in a project dict is rejected as InvalidScheduleInput (#1010)."""
        with pytest.raises(InvalidScheduleInput, match="velocity_samples must be finite"):
            Project.from_dict(
                {
                    "id": "p",
                    "name": "n",
                    "start_date": "2026-01-01",
                    "tasks": [{"id": "a", "name": "A", "duration": 86400}],
                    "dependencies": [],
                    "calendar": {},
                    "velocity_samples": [10.0, float("inf")],
                }
            )


class TestEnumInputMessages:
    """Bad enum-valued fields fail with a legible, actionable message (#947).

    Python's bare ``ValueError: 'XX' is not a valid DependencyType`` names neither
    the field nor the allowed set — the first-run error quality alpha adopters
    judge the library on. These lock the friendlier contract.
    """

    def test_invalid_dep_type_lists_allowed_set(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="Invalid dependency type") as exc:
            Dependency.from_dict({"predecessor_id": "a", "successor_id": "b", "dep_type": "XX"})
        msg = str(exc.value)
        for allowed in ("FS", "FF", "SS", "SF"):
            assert allowed in msg

    def test_invalid_dep_type_via_project_from_dict_is_wrapped(self) -> None:
        with pytest.raises(InvalidScheduleInput):
            Project.from_dict(
                {
                    "id": "p",
                    "name": "n",
                    "start_date": "2026-01-01",
                    "tasks": [
                        {"id": "a", "name": "A", "duration": 86400},
                        {"id": "b", "name": "B", "duration": 86400},
                    ],
                    "dependencies": [
                        {"predecessor_id": "a", "successor_id": "b", "dep_type": "ZZ"}
                    ],
                    "calendar": {},
                }
            )

    def test_invalid_delivery_mode_lists_allowed_set(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="Invalid delivery_mode") as exc:
            Task.from_dict({"id": "a", "name": "A", "duration": 86400, "delivery_mode": "sprint"})
        msg = str(exc.value)
        for allowed in ("waterfall", "scrum"):
            assert allowed in msg


class TestPertEstimateOrdering:
    """A complete three-point estimate must be ordered (#1069).

    Pre-fix, an inconsistent estimate was silently "handled" by _sample_pert's
    degenerate fallback: every run sampled the constant most_likely — possibly
    far beyond the user's own pessimistic bound — with zero spread and no error.
    """

    def test_most_likely_above_pessimistic_rejected(self) -> None:
        p = make_project(
            [
                task(
                    "A",
                    5,
                    optimistic_duration=timedelta(days=2),
                    most_likely_duration=timedelta(days=30),
                    pessimistic_duration=timedelta(days=4),
                )
            ]
        )
        with pytest.raises(InvalidScheduleInput, match="optimistic <= most_likely"):
            monte_carlo(p, runs=10)
        with pytest.raises(InvalidScheduleInput, match="optimistic <= most_likely"):
            schedule(p)

    def test_optimistic_above_pessimistic_rejected(self) -> None:
        p = make_project(
            [
                task(
                    "A",
                    5,
                    optimistic_duration=timedelta(days=10),
                    most_likely_duration=timedelta(days=10),
                    pessimistic_duration=timedelta(days=2),
                )
            ]
        )
        with pytest.raises(InvalidScheduleInput, match="optimistic <= most_likely"):
            monte_carlo(p, runs=10)

    def test_all_equal_estimates_allowed(self) -> None:
        """A degenerate-but-consistent estimate is valid (constant sample)."""
        p = make_project(
            [
                task(
                    "A",
                    5,
                    optimistic_duration=timedelta(days=5),
                    most_likely_duration=timedelta(days=5),
                    pessimistic_duration=timedelta(days=5),
                )
            ]
        )
        r = monte_carlo(p, runs=10, seed=0)
        assert r.p50 == r.p95

    def test_partial_estimates_not_validated(self) -> None:
        """Monte Carlo only samples when all three are present; a lone
        most_likely (whatever its value) falls through to deterministic."""
        p = make_project([task("A", 2, most_likely_duration=timedelta(days=99))])
        r = monte_carlo(p, runs=10, seed=0)
        assert r.p50 == r.p95 == date(2026, 3, 3)


class TestEmptyChildrenSummary:
    """A summary with an empty children list must be rejected clearly (#1070).

    Pre-fix it survived expansion as its own leaf while being removed from the
    task list, leaving a dangling edge that failed later with a generic
    "unknown task" ValueError far from the actual mistake.
    """

    def test_expand_summary_dependencies_rejects_empty_children(self) -> None:
        from trueppm_scheduler.engine import expand_summary_dependencies

        with pytest.raises(InvalidScheduleInput, match="empty children"):
            expand_summary_dependencies(
                [task("A", 2), task("B", 2)],
                [Dependency("S", "B")],
                {"S": []},
            )

    def test_find_cycle_rejects_empty_children(self) -> None:
        with pytest.raises(InvalidScheduleInput, match="empty children"):
            find_cycle([("S", "B")], children_map={"S": []})
