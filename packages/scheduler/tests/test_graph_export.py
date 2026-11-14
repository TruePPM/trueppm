"""Rendering-neutral graph export (#4894): float, link types, round trip, cycles."""

from __future__ import annotations

import dataclasses
import json
import pickle
from datetime import date, timedelta
from typing import Any

import pytest

from trueppm_scheduler import (
    GRAPH_FORMAT_VERSION,
    Calendar,
    CyclicDependencyError,
    DateRange,
    Dependency,
    DependencyType,
    DrivingEdge,
    GraphExport,
    InvalidScheduleInput,
    Project,
    Task,
    schedule,
    to_graph,
)

MON = date(2026, 1, 5)


def _task(tid: str, days: int) -> Task:
    return Task(id=tid, name=f"Task {tid}", duration=timedelta(days=days))


def _dep(p: str, s: str, kind: DependencyType = DependencyType.FS, lag: int = 0) -> Dependency:
    return Dependency(predecessor_id=p, successor_id=s, dep_type=kind, lag=timedelta(days=lag))


def _diamond() -> Project:
    # A(3d) Mon-Wed -> B(2d) Thu-Fri is the critical chain (finish Fri Jan 9).
    # A -> C(1d): C runs Thu and may slip to Fri: total float exactly 1 working day.
    # D(1d) Mon -> B: B waits on A, so D's link is not driving and D floats 2 days
    # (late finish Wed, early finish Mon): two working days of slack.
    return Project(
        id="p",
        name="P",
        start_date=MON,
        tasks=[_task("A", 3), _task("B", 2), _task("C", 1), _task("D", 1)],
        dependencies=[_dep("A", "B"), _dep("A", "C"), _dep("D", "B")],
    )


def _export(project: Project) -> GraphExport:
    return to_graph(schedule(project), project)


class TestHandCheckedFloat:
    def test_float_and_critical_flags(self) -> None:
        g = _export(_diamond())
        nodes = {n.id: n for n in g.nodes}
        assert nodes["A"].early_start == date(2026, 1, 5)
        assert nodes["A"].early_finish == date(2026, 1, 7)
        assert nodes["B"].early_start == date(2026, 1, 8)
        assert nodes["B"].early_finish == date(2026, 1, 9)
        assert nodes["C"].early_finish == date(2026, 1, 8)
        assert nodes["C"].late_finish == date(2026, 1, 9)
        assert nodes["A"].total_float_days == 0.0
        assert nodes["B"].total_float_days == 0.0
        assert nodes["C"].total_float_days == 1.0
        assert nodes["D"].total_float_days == 2.0
        assert {i for i, n in nodes.items() if n.is_critical} == {"A", "B"}

    def test_driving_flags(self) -> None:
        g = _export(_diamond())
        driving = {(e.predecessor_id, e.successor_id): e.is_driving for e in g.edges}
        assert driving == {("A", "B"): True, ("A", "C"): True, ("D", "B"): False}

    def test_export_agrees_with_the_result_it_came_from(self) -> None:
        project = _diamond()
        result = schedule(project)
        g = to_graph(result, project)
        by_id = {t.id: t for t in result.tasks}
        for n in g.nodes:
            t = by_id[n.id]
            assert (n.early_start, n.early_finish) == (t.early_start, t.early_finish)
            assert (n.late_start, n.late_finish) == (t.late_start, t.late_finish)
            assert timedelta(days=n.total_float_days) == t.total_float
            assert n.is_critical == t.is_critical
        engine_driving = {
            (e.predecessor_id, e.successor_id, e.dep_type) for e in result.driving_edges
        }
        export_driving = {
            (e.predecessor_id, e.successor_id, e.dep_type) for e in g.edges if e.is_driving
        }
        assert export_driving == engine_driving


class TestDependencyTypesAndCalendar:
    @pytest.mark.parametrize("kind", list(DependencyType))
    def test_each_dependency_type_exports_with_its_lag(self, kind: DependencyType) -> None:
        project = Project(
            id="p",
            name="P",
            start_date=MON,
            tasks=[_task("A", 3), _task("B", 3)],
            dependencies=[_dep("A", "B", kind, lag=2)],
        )
        result = schedule(project)
        g = to_graph(result, project)
        (edge,) = g.edges
        assert (edge.dep_type, edge.lag_days) == (kind.value, 2.0)
        assert {n.id for n in g.nodes} == {"A", "B"}
        by_id = {t.id: t for t in result.tasks}
        assert {n.id: n.early_start for n in g.nodes} == {
            i: t.early_start for i, t in by_id.items()
        }

    def test_float_is_counted_on_the_calendar(self) -> None:
        # A Wed-Thu holiday: A runs Mon, Tue, Fri; B and C then both start Mon Jan 12.
        cal = Calendar(exceptions=[DateRange(start=date(2026, 1, 7), end=date(2026, 1, 8))])
        project = Project(
            id="p",
            name="P",
            start_date=MON,
            tasks=[_task("A", 3), _task("B", 1), _task("C", 1)],
            dependencies=[_dep("A", "B"), _dep("A", "C")],
            calendar=cal,
        )
        g = _export(project)
        nodes = {n.id: n for n in g.nodes}
        # A: Mon, Tue, Fri (Wed/Thu are holidays). B, C both start Mon Jan 12.
        assert nodes["A"].early_finish == date(2026, 1, 9)
        assert nodes["B"].early_start == date(2026, 1, 12) == nodes["C"].early_start
        # Two equal leaves on the critical finish: both zero float.
        assert nodes["B"].total_float_days == nodes["C"].total_float_days == 0.0

    def test_float_counts_working_days_not_calendar_days(self) -> None:
        # A (1d) starts Thu Jan 8. B (1d) finishes Fri Jan 9 but may slip to Thu Jan 15
        # behind the 5-day C: 4 working days, where calendar days would say 6.
        project = Project(
            id="p",
            name="P",
            start_date=date(2026, 1, 8),
            tasks=[_task("A", 1), _task("B", 1), _task("C", 5)],
            dependencies=[_dep("A", "B"), _dep("A", "C")],
        )
        b = {n.id: n for n in _export(project).nodes}["B"]
        assert b.early_finish == date(2026, 1, 9)
        assert b.late_finish == date(2026, 1, 15)
        assert b.total_float_days == 4.0

    def test_completed_task_is_never_critical_even_at_zero_float(self) -> None:
        project = Project(
            id="p",
            name="P",
            start_date=MON,
            tasks=[
                Task(
                    id="A",
                    name="Task A",
                    duration=timedelta(days=2),
                    actual_start=MON,
                    actual_finish=MON + timedelta(days=1),
                    percent_complete=100.0,
                )
            ],
        )
        (a,) = _export(project).nodes
        assert a.total_float_days == 0.0
        assert a.is_critical is False


class TestRoundTrip:
    def test_json_round_trip_is_lossless_and_byte_stable(self) -> None:
        g = _export(_diamond())
        text = g.to_json()
        again = GraphExport.from_json(text)
        assert again == g
        assert again.to_json() == text
        assert json.loads(text)["format_version"] == GRAPH_FORMAT_VERSION

    def test_deterministic_ordering(self) -> None:
        p = _diamond()
        reordered = dataclasses.replace(
            p, tasks=list(reversed(p.tasks)), dependencies=list(reversed(p.dependencies))
        )
        assert _export(p).to_json() == _export(reordered).to_json()

    def test_frozen_key_set(self) -> None:
        d = _export(_diamond()).to_dict()
        assert set(d) == {
            "format_version",
            "project_id",
            "project_start",
            "project_finish",
            "nodes",
            "edges",
        }
        assert set(d["nodes"][0]) == {
            "id", "name", "early_start", "early_finish", "late_start", "late_finish",
            "total_float_days", "is_critical", "milestone_at_day_end",
        }  # fmt: skip
        assert set(d["edges"][0]) == {
            "predecessor_id", "successor_id", "dep_type", "lag_days", "is_driving",
        }  # fmt: skip

    def test_driving_edge_contract_is_frozen(self) -> None:
        assert [f.name for f in dataclasses.fields(DrivingEdge)] == [
            "predecessor_id", "successor_id", "dep_type",
        ]  # fmt: skip
        edge = DrivingEdge("A", "B", "FS")
        assert set(edge.to_dict()) == {"predecessor_id", "successor_id", "dep_type"}
        with pytest.raises(dataclasses.FrozenInstanceError):
            edge.dep_type = "SS"  # type: ignore[misc]

    def test_pickles(self) -> None:
        g = _export(_diamond())
        assert pickle.loads(pickle.dumps(g)) == g

    def test_empty_edges_round_trip(self) -> None:
        project = Project(id="p", name="P", start_date=MON, tasks=[_task("A", 2)])
        g = _export(project)
        assert g.edges == ()
        assert GraphExport.from_json(g.to_json()) == g


class TestRefusals:
    def test_cycle_raises_and_names_ids(self) -> None:
        g = _export(_diamond()).to_dict()
        g["edges"].append(
            {"predecessor_id": "B", "successor_id": "A", "dep_type": "FS",
             "lag_days": 0.0, "is_driving": False}
        )  # fmt: skip
        with pytest.raises(CyclicDependencyError) as exc:
            GraphExport.from_dict(g)
        assert {"A", "B"} <= set(exc.value.cycle)
        assert "'A'" in str(exc.value) and "'B'" in str(exc.value)

    def test_to_graph_refuses_cycle_on_a_result_for_other_edges(self) -> None:
        project = _diamond()
        result = schedule(project)
        cyclic = dataclasses.replace(project, dependencies=[*project.dependencies, _dep("B", "A")])
        with pytest.raises(CyclicDependencyError) as exc:
            to_graph(result, cyclic)
        assert set(exc.value.cycle) == {"A", "B"}

    def test_dangling_edge_names_the_unknown_id(self) -> None:
        project = _diamond()
        result = schedule(project)
        bad = dataclasses.replace(project, dependencies=[*project.dependencies, _dep("A", "ghost")])
        with pytest.raises(InvalidScheduleInput, match="ghost"):
            to_graph(result, bad)

    def test_dangling_edge_in_payload(self) -> None:
        d = _export(_diamond()).to_dict()
        d["edges"][0]["successor_id"] = "nope"
        with pytest.raises(InvalidScheduleInput, match="nope"):
            GraphExport.from_dict(d)

    def test_duplicate_node_id_in_payload(self) -> None:
        d = _export(_diamond()).to_dict()
        d["nodes"].append(dict(d["nodes"][0]))
        with pytest.raises(InvalidScheduleInput, match="Duplicate"):
            GraphExport.from_dict(d)

    def test_result_for_a_different_project(self) -> None:
        project = _diamond()
        other = dataclasses.replace(project, id="other")
        with pytest.raises(InvalidScheduleInput, match="other"):
            to_graph(schedule(project), other)

    def test_unscheduled_task_is_refused(self) -> None:
        project = _diamond()
        result = schedule(project)
        result.tasks[0] = _task(result.tasks[0].id, 1)  # no computed dates
        with pytest.raises(InvalidScheduleInput, match="no computed dates"):
            to_graph(result, project)

    @pytest.mark.parametrize("version", [0, 2, "1", True, None])
    def test_unsupported_format_version(self, version: Any) -> None:
        d = _export(_diamond()).to_dict()
        d["format_version"] = version
        with pytest.raises(InvalidScheduleInput):
            GraphExport.from_dict(d)

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda d: d.pop("nodes"),
            lambda d: d["nodes"][0].update(early_start="20260105"),
            lambda d: d["nodes"][0].update(total_float_days=float("nan")),
            lambda d: d["nodes"][0].update(is_critical="yes"),
            lambda d: d["edges"][0].update(dep_type="XX"),
            lambda d: d["edges"][0].update(lag_days=True),
            lambda d: d.update(project_id=5),
        ],
    )
    def test_malformed_payload_raises_invalid_schedule_input(self, mutate: Any) -> None:
        d = _export(_diamond()).to_dict()
        mutate(d)
        with pytest.raises(InvalidScheduleInput):
            GraphExport.from_dict(d)

    @pytest.mark.parametrize("text", ["not json", "[]", "null"])
    def test_malformed_json(self, text: str) -> None:
        with pytest.raises(InvalidScheduleInput):
            GraphExport.from_json(text)
