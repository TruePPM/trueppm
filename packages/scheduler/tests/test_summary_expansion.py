"""Tests for expand_summary_dependencies — summary task dependency fan-out."""

from __future__ import annotations

from datetime import timedelta

import pytest

from trueppm_scheduler import Dependency, DependencyType, Task, expand_summary_dependencies
from trueppm_scheduler.engine import InvalidScheduleInput

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def task(tid: str, days: int = 5) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestExpandSummaryDependencies:
    def test_leaf_to_leaf_passes_through(self) -> None:
        """Normal dependencies without summaries are unchanged."""
        tasks = [task("A"), task("B")]
        deps = [Dependency(predecessor_id="A", successor_id="B", dep_type=DependencyType.FS)]
        children_map: dict[str, list[str]] = {}

        leaf_tasks, expanded = expand_summary_dependencies(tasks, deps, children_map)

        assert [t.id for t in leaf_tasks] == ["A", "B"]
        assert len(expanded) == 1
        assert expanded[0].predecessor_id == "A"
        assert expanded[0].successor_id == "B"

    def test_summary_to_leaf_fans_out(self) -> None:
        """Summary → leaf creates edges from all summary leaves to the leaf."""
        tasks = [task("S"), task("S1"), task("S2"), task("T")]
        deps = [Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.FS)]
        children_map = {"S": ["S1", "S2"]}

        leaf_tasks, expanded = expand_summary_dependencies(tasks, deps, children_map)

        # Summary "S" removed from leaf tasks
        assert "S" not in {t.id for t in leaf_tasks}
        assert {t.id for t in leaf_tasks} == {"S1", "S2", "T"}

        # Two edges: S1→T, S2→T
        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("S1", "T"), ("S2", "T")}

    def test_leaf_to_summary_fans_out(self) -> None:
        """Leaf → summary creates edges from the leaf to all summary leaves."""
        tasks = [task("T"), task("S"), task("S1"), task("S2")]
        deps = [Dependency(predecessor_id="T", successor_id="S", dep_type=DependencyType.FS)]
        children_map = {"S": ["S1", "S2"]}

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("T", "S1"), ("T", "S2")}

    def test_summary_to_summary_cross_product(self) -> None:
        """Summary → summary produces cross-product of all leaves."""
        tasks = [task("A"), task("A1"), task("A2"), task("B"), task("B1"), task("B2")]
        deps = [Dependency(predecessor_id="A", successor_id="B", dep_type=DependencyType.FS)]
        children_map = {"A": ["A1", "A2"], "B": ["B1", "B2"]}

        leaf_tasks, expanded = expand_summary_dependencies(tasks, deps, children_map)

        assert {t.id for t in leaf_tasks} == {"A1", "A2", "B1", "B2"}
        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("A1", "B1"), ("A1", "B2"), ("A2", "B1"), ("A2", "B2")}

    def test_deduplicates_edges(self) -> None:
        """Multiple summary deps resolving to the same leaf pair produce one edge."""
        tasks = [task("S"), task("S1"), task("T")]
        deps = [
            Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.FS),
            Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.FS),
        ]
        children_map = {"S": ["S1"]}

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        assert len(expanded) == 1

    def test_nested_summary_finds_deep_leaves(self) -> None:
        """Nested summaries (A > A1 > A1a, A1b) correctly find deep leaves."""
        tasks = [task("A"), task("A1"), task("A1a"), task("A1b"), task("T")]
        deps = [Dependency(predecessor_id="A", successor_id="T", dep_type=DependencyType.FS)]
        children_map = {"A": ["A1"], "A1": ["A1a", "A1b"]}

        leaf_tasks, expanded = expand_summary_dependencies(tasks, deps, children_map)

        assert {t.id for t in leaf_tasks} == {"A1a", "A1b", "T"}
        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("A1a", "T"), ("A1b", "T")}

    def test_preserves_dep_type_and_lag(self) -> None:
        """Expanded edges inherit dep_type and lag from the original.

        Uses FF (Finish-to-Finish), which anchors on the summary's finish (its
        latest-finishing leaf) and is correctly modelled by the leaf cross-product,
        so it survives the fan-out. SS/SF *from* a summary are rejected (ADR-0370)
        and are covered by the rejection tests below.
        """
        tasks = [task("S"), task("S1"), task("T")]
        deps = [
            Dependency(
                predecessor_id="S",
                successor_id="T",
                dep_type=DependencyType.FF,
                lag=timedelta(days=3),
            )
        ]
        children_map = {"S": ["S1"]}

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        assert len(expanded) == 1
        assert expanded[0].dep_type == DependencyType.FF
        assert expanded[0].lag == timedelta(days=3)

    def test_self_referencing_edge_skipped(self) -> None:
        """If a summary's only leaf would create a self-referencing edge, skip it."""
        tasks = [task("S"), task("L")]
        deps = [Dependency(predecessor_id="S", successor_id="L", dep_type=DependencyType.FS)]
        children_map = {"S": ["L"]}  # L is both child of S and successor

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        # L→L would be self-referencing — should be skipped
        assert len(expanded) == 0

    def test_no_summaries_passthrough(self) -> None:
        """Empty children_map returns tasks and deps unchanged."""
        tasks = [task("A"), task("B")]
        deps = [Dependency(predecessor_id="A", successor_id="B", dep_type=DependencyType.FS)]

        leaf_tasks, expanded = expand_summary_dependencies(tasks, deps, {})

        assert len(leaf_tasks) == 2
        assert len(expanded) == 1


class TestRejectStartLinksFromSummary:
    """ADR-0370: SS/SF *from* a summary task are rejected, not fanned out.

    A summary's start is its earliest-starting leaf (ADR-0024 §3). The leaf
    cross-product preserves the dep type, so an SS/SF edge from a summary would
    anchor the successor on the summary's *latest*-starting leaf instead — silently
    over-constraining it by up to the summary's whole span. FS/FF anchor on the
    summary's finish (its latest-finishing leaf), which the cross-product models
    correctly, so they keep fanning out.
    """

    def test_multi_leaf_summary_ss_predecessor_rejected(self) -> None:
        """Worked example from #1854: S = {S1 10d, S2 1d}, S —SS→ T is rejected.

        The correct SS anchor is S's earliest-starting leaf, but the cross-product
        would make T wait for the last-starting leaf. Reject rather than mis-schedule.
        """
        tasks = [task("S"), task("S1", days=10), task("S2", days=1), task("T")]
        deps = [Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.SS)]
        children_map = {"S": ["S1", "S2"]}

        with pytest.raises(InvalidScheduleInput, match="summary task 'S'"):
            expand_summary_dependencies(tasks, deps, children_map)

    def test_multi_leaf_summary_sf_predecessor_rejected(self) -> None:
        """SF from a summary is anchored on the summary's start, so it is rejected too."""
        tasks = [task("S"), task("S1", days=10), task("S2", days=1), task("T")]
        deps = [Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.SF)]
        children_map = {"S": ["S1", "S2"]}

        with pytest.raises(InvalidScheduleInput, match="not supported"):
            expand_summary_dependencies(tasks, deps, children_map)

    def test_single_leaf_summary_ss_predecessor_rejected(self) -> None:
        """The restriction is uniform: even a single-leaf summary rejects SS/SF.

        The rule is "no SS/SF from a summary" — not "only when the fan-out actually
        changes the anchor" — so users get one predictable, MS-Project-aligned rule.
        """
        tasks = [task("S"), task("S1"), task("T")]
        deps = [Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.SS)]
        children_map = {"S": ["S1"]}

        with pytest.raises(InvalidScheduleInput):
            expand_summary_dependencies(tasks, deps, children_map)

    def test_fs_from_summary_still_fans_out(self) -> None:
        """Regression guard: FS from a summary keeps its correct cross-product."""
        tasks = [task("S"), task("S1", days=10), task("S2", days=1), task("T")]
        deps = [Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.FS)]
        children_map = {"S": ["S1", "S2"]}

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("S1", "T"), ("S2", "T")}
        assert all(d.dep_type == DependencyType.FS for d in expanded)

    def test_ff_from_summary_still_fans_out(self) -> None:
        """Regression guard: FF from a summary keeps its correct cross-product."""
        tasks = [task("S"), task("S1", days=10), task("S2", days=1), task("T")]
        deps = [Dependency(predecessor_id="S", successor_id="T", dep_type=DependencyType.FF)]
        children_map = {"S": ["S1", "S2"]}

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("S1", "T"), ("S2", "T")}
        assert all(d.dep_type == DependencyType.FF for d in expanded)

    def test_ss_to_summary_successor_still_fans_out(self) -> None:
        """SS where the summary is the *successor* is out of scope (#1854): it stays.

        The reachable over-constraint bug is SS/SF *from* a summary (predecessor).
        A leaf —SS→ summary anchors on the successor side and is left conservatively
        untouched; only the predecessor case is rejected.
        """
        tasks = [task("T"), task("S"), task("S1"), task("S2")]
        deps = [Dependency(predecessor_id="T", successor_id="S", dep_type=DependencyType.SS)]
        children_map = {"S": ["S1", "S2"]}

        _, expanded = expand_summary_dependencies(tasks, deps, children_map)

        edges = {(d.predecessor_id, d.successor_id) for d in expanded}
        assert edges == {("T", "S1"), ("T", "S2")}
