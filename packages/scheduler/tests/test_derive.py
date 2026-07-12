"""Tests for the derivation graph (ADR-0218, #1058).

The load-bearing invariant is *faithfulness*: the binding contribution's
``imposed_date`` must equal the value the engine itself computed. These tests
assert that across every dependency type, lag, calendar snap, SNET floor, and the
float quantities — a derivation that disagreed with the engine would be a
fabrication (rule 120), so a divergence must fail here, not ship.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Derivation,
    Project,
    Quantity,
    Task,
    UnknownTaskError,
    derive_value,
    schedule,
)


def make_project(
    tasks: list[Task],
    dependencies: list[Dependency] | None = None,
    start: date = date(2026, 3, 2),  # Monday
    calendar: Calendar | None = None,
    **kwargs: object,
) -> Project:
    return Project(
        id="test",
        name="Test Project",
        start_date=start,
        tasks=tasks,
        dependencies=dependencies or [],
        calendar=calendar or Calendar(),
        **kwargs,  # type: ignore[arg-type]
    )


def task(tid: str, name: str, days: int, **kwargs: object) -> Task:
    return Task(id=tid, name=name, duration=timedelta(days=days), **kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Faithfulness invariant — the binding date must equal the engine's value
# ---------------------------------------------------------------------------


DATE_QUANTITIES = [
    Quantity.EARLY_START,
    Quantity.EARLY_FINISH,
    Quantity.LATE_START,
    Quantity.LATE_FINISH,
]


class TestFaithfulness:
    def _network(self) -> Project:
        # A diamond with mixed dependency types, lag, and a parallel slack path.
        return make_project(
            [
                task("A", "Design", 3),
                task("B", "Build", 5),
                task("C", "Test", 2),
                task("D", "Ship", 1),
                task("E", "Docs", 1),
            ],
            dependencies=[
                Dependency("A", "B"),  # FS
                Dependency("A", "C", dep_type=DependencyType.SS, lag=timedelta(days=1)),
                Dependency("B", "D"),  # FS
                Dependency("C", "D"),  # FS
                Dependency("A", "E"),  # FS — E is slack (short, parallel)
            ],
        )

    def test_binding_date_equals_engine_value_for_every_task(self) -> None:
        project = self._network()
        result = schedule(project)
        by_id = {t.id: t for t in result.tasks}
        for t in result.tasks:
            for q in DATE_QUANTITIES:
                d = derive_value(project, t.id, q, result=result)
                engine_value = getattr(by_id[t.id], q.value)
                assert d.value == engine_value.isoformat(), (t.id, q)
                # The binding contribution must reproduce the engine's own date.
                assert d.binding is not None, (t.id, q)
                assert d.binding.is_binding
                if d.binding.imposed_date is not None:
                    assert d.binding.imposed_date == engine_value, (t.id, q)

    def test_exactly_one_binding_contribution(self) -> None:
        project = self._network()
        result = schedule(project)
        for t in result.tasks:
            for q in Quantity:
                d = derive_value(project, t.id, q, result=result)
                binding = [c for c in d.contributions if c.is_binding]
                # total_float legitimately flags both its endpoint terms.
                if q is Quantity.TOTAL_FLOAT:
                    assert len(binding) >= 1
                else:
                    assert len(binding) == 1, (t.id, q, len(binding))

    def test_faithful_with_completed_out_of_sequence_successor(self) -> None:
        """The derivation replay must agree with the engine when a completed,
        out-of-sequence successor drops out of the backward pass and free-float
        computation (#1819) — otherwise the "why" explanation would cite a done
        task as the binding late-date/free-float constraint that the engine no
        longer applies."""
        project = make_project(
            [
                task("A", "Live predecessor", 5),
                task(
                    "B",
                    "Done out of sequence",
                    5,
                    actual_start=date(2026, 3, 2),
                    actual_finish=date(2026, 3, 6),
                    percent_complete=100.0,
                ),
                task("C", "Long parallel driver", 20),
            ],
            dependencies=[Dependency("A", "B")],
        )
        result = schedule(project)
        by_id = {t.id: t for t in result.tasks}
        for q in DATE_QUANTITIES:
            d = derive_value(project, "A", q, result=result)
            engine_value = getattr(by_id["A"], q.value)
            assert d.value == engine_value.isoformat(), q
            if d.binding is not None and d.binding.imposed_date is not None:
                assert d.binding.imposed_date == engine_value, q
        # No derivation term may reference the completed successor B.
        for q in (Quantity.LATE_FINISH, Quantity.LATE_START, Quantity.FREE_FLOAT):
            d = derive_value(project, "A", q, result=result)
            assert all(c.source_task_id != "B" for c in d.contributions), q

    def test_faithful_with_weekend_project_finish(self) -> None:
        """When project_finish lands on a weekend (a completed task's Sunday
        actual finish), the derivation's project-finish anchor must show the same
        snapped date the engine floors at (#1820)."""
        project = make_project(
            [
                task(
                    "W",
                    "Done Sunday finish",
                    5,
                    actual_start=date(2026, 3, 2),
                    actual_finish=date(2026, 3, 8),  # Sunday
                    percent_complete=100.0,
                ),
                task("M", "Live Mon-Fri task", 5),
            ],
        )
        result = schedule(project)
        m = next(t for t in result.tasks if t.id == "M")
        d = derive_value(project, "M", Quantity.LATE_FINISH, result=result)
        assert d.value == m.late_finish.isoformat()
        assert m.late_finish == date(2026, 3, 6)  # snapped to Friday
        anchor = next(c for c in d.contributions if c.kind == "project_finish")
        assert anchor.imposed_date == date(2026, 3, 6)


# ---------------------------------------------------------------------------
# Forward pass — early dates
# ---------------------------------------------------------------------------


class TestForward:
    def test_root_task_bound_by_project_start(self) -> None:
        p = make_project([task("A", "A", 3)])
        d = derive_value(p, "A", Quantity.EARLY_START)
        assert d.pass_ == "forward"
        assert d.binding is not None
        assert d.binding.kind == "project_start"
        assert d.value == date(2026, 3, 2).isoformat()

    def test_fs_successor_names_driving_predecessor(self) -> None:
        p = make_project(
            [task("A", "Design", 3), task("B", "Build", 2)],
            dependencies=[Dependency("A", "B")],
        )
        d = derive_value(p, "B", Quantity.EARLY_START)
        assert d.binding is not None
        assert d.binding.kind == "predecessor_fs"
        assert d.binding.source_task_id == "A"
        assert d.binding.source_task_name == "Design"
        assert d.binding.dep_type == "FS"
        assert d.binding.lag_days == 0

    def test_fs_lag_recorded(self) -> None:
        p = make_project(
            [task("A", "A", 3), task("B", "B", 2)],
            dependencies=[Dependency("A", "B", lag=timedelta(days=2))],
        )
        d = derive_value(p, "B", Quantity.EARLY_START)
        assert d.binding is not None
        assert d.binding.lag_days == 2

    def test_binding_predecessor_is_the_later_of_two(self) -> None:
        # A finishes later than the short B, so A binds C's start; B is a candidate.
        p = make_project(
            [task("A", "Long", 5), task("B", "Short", 1), task("C", "C", 2)],
            dependencies=[Dependency("A", "C"), Dependency("B", "C")],
        )
        d = derive_value(p, "C", Quantity.EARLY_START)
        assert d.binding is not None
        assert d.binding.source_task_id == "A"
        # Both predecessors appear as contributions; only A binds.
        pred_kinds = {c.source_task_id for c in d.contributions if c.source_task_id}
        assert pred_kinds == {"A", "B"}
        b = next(c for c in d.contributions if c.source_task_id == "B")
        assert not b.is_binding

    def test_ss_dependency_kind(self) -> None:
        p = make_project(
            [task("A", "A", 4), task("B", "B", 2)],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.SS)],
        )
        d = derive_value(p, "B", Quantity.EARLY_START)
        assert d.binding is not None
        assert d.binding.kind == "predecessor_ss"

    def test_ff_dependency_drives_early_finish(self) -> None:
        p = make_project(
            [task("A", "A", 5), task("B", "B", 2)],
            dependencies=[Dependency("A", "B", dep_type=DependencyType.FF)],
        )
        d = derive_value(p, "B", Quantity.EARLY_FINISH)
        assert d.binding is not None
        assert d.binding.kind == "predecessor_ff"
        assert d.binding.dep_type == "FF"

    def test_planned_start_snet_floor(self) -> None:
        p = make_project([task("A", "A", 2, planned_start=date(2026, 3, 16))])
        d = derive_value(p, "A", Quantity.EARLY_START)
        assert d.binding is not None
        assert d.binding.kind == "planned_start_snet"
        assert d.value == date(2026, 3, 16).isoformat()

    def test_calendar_snap_contribution_is_computed(self) -> None:
        # A finishes Friday; B's FS start snaps across the weekend to Monday — the
        # calendar's own contribution must be reported, not the raw offset.
        p = make_project(
            [task("A", "A", 5), task("B", "B", 1)],  # A: Mon-Fri
            dependencies=[Dependency("A", "B")],
        )
        d = derive_value(p, "B", Quantity.EARLY_START)
        assert d.binding is not None
        # Raw FS offset lands Saturday; snap adds 2 days to Monday.
        assert d.binding.calendar_days_added == 2
        assert date.fromisoformat(d.value).weekday() == 0  # Monday


# ---------------------------------------------------------------------------
# Backward pass — late dates
# ---------------------------------------------------------------------------


class TestBackward:
    def test_late_finish_of_terminal_bound_by_project_finish(self) -> None:
        p = make_project(
            [task("A", "A", 3), task("B", "B", 2)],
            dependencies=[Dependency("A", "B")],
        )
        d = derive_value(p, "B", Quantity.LATE_FINISH)
        assert d.pass_ == "backward"
        assert d.binding is not None
        assert d.binding.kind == "project_finish"

    def test_late_finish_bound_by_successor(self) -> None:
        p = make_project(
            [task("A", "A", 3), task("B", "B", 2)],
            dependencies=[Dependency("A", "B")],
        )
        d = derive_value(p, "A", Quantity.LATE_FINISH)
        assert d.binding is not None
        assert d.binding.kind == "successor_fs"
        assert d.binding.source_task_id == "B"


# ---------------------------------------------------------------------------
# Float
# ---------------------------------------------------------------------------


class TestFloat:
    def test_total_float_matches_engine(self) -> None:
        p = make_project(
            [task("A", "Crit", 5), task("B", "Slack", 1), task("C", "C", 2)],
            dependencies=[Dependency("A", "C"), Dependency("B", "C")],
        )
        result = schedule(p)
        by_id = {t.id: t for t in result.tasks}
        d = derive_value(p, "B", Quantity.TOTAL_FLOAT, result=result)
        assert d.pass_ == "float"
        assert d.value == by_id["B"].total_float.days
        assert d.value > 0  # the short parallel task has slack

    def test_free_float_binding_successor(self) -> None:
        p = make_project(
            [task("A", "A", 2), task("B", "B", 2), task("C", "C", 2)],
            dependencies=[Dependency("A", "B"), Dependency("B", "C")],
        )
        result = schedule(p)
        by_id = {t.id: t for t in result.tasks}
        d = derive_value(p, "A", Quantity.FREE_FLOAT, result=result)
        assert d.value == by_id["A"].free_float.days
        assert d.binding is not None

    def test_free_float_no_successors_falls_back_to_total_float(self) -> None:
        p = make_project(
            [task("A", "A", 3), task("B", "B", 2)],
            dependencies=[Dependency("A", "B")],
        )
        result = schedule(p)
        d = derive_value(p, "B", Quantity.FREE_FLOAT, result=result)
        assert d.binding is not None
        assert d.binding.kind == "total_float"


# ---------------------------------------------------------------------------
# Progress-aware (completed tasks)
# ---------------------------------------------------------------------------


class TestProgress:
    def test_completed_task_bound_by_recorded_actual(self) -> None:
        p = make_project(
            [
                task(
                    "A",
                    "Done",
                    3,
                    actual_start=date(2026, 3, 2),
                    actual_finish=date(2026, 3, 4),
                    percent_complete=100.0,
                ),
                task("B", "B", 2),
            ],
            dependencies=[Dependency("A", "B")],
        )
        d = derive_value(p, "A", Quantity.EARLY_FINISH)
        assert d.binding is not None
        assert d.binding.kind == "actual_finish"
        assert d.value == date(2026, 3, 4).isoformat()


# ---------------------------------------------------------------------------
# Errors and serialization
# ---------------------------------------------------------------------------


class TestErrorsAndSerialization:
    def test_unknown_task_raises(self) -> None:
        p = make_project([task("A", "A", 2)])
        with pytest.raises(UnknownTaskError):
            derive_value(p, "ZZ", Quantity.EARLY_START)

    def test_bad_quantity_raises_value_error(self) -> None:
        p = make_project([task("A", "A", 2)])
        with pytest.raises(ValueError):
            derive_value(p, "A", "not_a_quantity")

    def test_string_quantity_accepted(self) -> None:
        p = make_project([task("A", "A", 2)])
        d = derive_value(p, "A", "early_start")
        assert d.quantity == "early_start"

    def test_to_dict_is_json_serializable(self) -> None:
        p = make_project(
            [task("A", "A", 3), task("B", "B", 2)],
            dependencies=[Dependency("A", "B")],
        )
        d = derive_value(p, "B", Quantity.EARLY_START)
        payload = d.to_dict()
        # Round-trips through JSON without a custom encoder.
        reloaded = json.loads(json.dumps(payload))
        assert reloaded["quantity"] == "early_start"
        assert reloaded["pass"] == "forward"
        assert reloaded["binding"]["source_task_id"] == "A"
        assert isinstance(reloaded["contributions"], list)

    def test_derivation_returned_type(self) -> None:
        p = make_project([task("A", "A", 2)])
        d = derive_value(p, "A", Quantity.EARLY_START)
        assert isinstance(d, Derivation)


# ---------------------------------------------------------------------------
# Prebuilt-result equivalence — the incident-edge scan must match a fresh run
# ---------------------------------------------------------------------------


class TestPrebuiltResultEquivalence:
    def test_prebuilt_result_matches_fresh_schedule_for_all_quantities(self) -> None:
        """derive_value must produce byte-identical derivations whether it
        schedules the project itself or reuses a prebuilt ScheduleResult — across
        every task and all six quantities. This pins the O(degree) incident-edge
        scan (#1859) to the same output as scheduling from scratch: any drift in
        how predecessors/successors are gathered would surface as a dict diff."""
        project = make_project(
            [
                task("A", "Design", 3),
                task("B", "Build", 5),
                task("C", "Test", 2),
                task("D", "Ship", 1),
                task("E", "Docs", 1),
            ],
            dependencies=[
                Dependency("A", "B"),  # FS
                Dependency("A", "C", dep_type=DependencyType.SS, lag=timedelta(days=1)),
                Dependency("B", "D", dep_type=DependencyType.FF),
                Dependency("C", "D"),  # FS
                Dependency("D", "E", dep_type=DependencyType.SF, lag=timedelta(days=2)),
            ],
        )
        result = schedule(project)
        for t in result.tasks:
            for q in Quantity:
                fresh = derive_value(project, t.id, q)
                reused = derive_value(project, t.id, q, result=result)
                assert fresh.to_dict() == reused.to_dict(), (t.id, q)
