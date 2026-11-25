"""Property tests for the in-package dependency graph and its sort (#4163).

The cross-engine conformance fixtures prove the Python and Rust engines agree with
each other (#2637), not that either orders a graph correctly, so the replacement for
the third-party graph library is held to the definitions directly.
"""

from __future__ import annotations

from datetime import date, timedelta
from itertools import pairwise, permutations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from trueppm_scheduler import (
    CyclicDependencyError,
    Dependency,
    DependencyType,
    Project,
    SchedulerError,
    Task,
    find_cycle,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.engine import (
    _DiGraph,
    _GraphHasCycle,
    _pairs_are_acyclic,
    _strongly_connected_components,
    _topological_order,
)

# Ids whose lexicographic order differs from their numeric and insertion order.
_IDS = ["1", "10", "2", "A", "B", "a", "b", "é"]

_edges = st.lists(st.tuples(st.sampled_from(_IDS), st.sampled_from(_IDS)), max_size=20)
_nodes = st.permutations(_IDS)


def _graph(nodes: list[str], edges: list[tuple[str, str]]) -> _DiGraph:
    g = _DiGraph()
    for node in nodes:
        g.add_node(node)
    for u, v in edges:
        g.add_edge(u, v)
    return g


def _reachable(edges: list[tuple[str, str]], start: str) -> set[str]:
    """Nodes reachable from ``start`` by one or more edges."""
    seen: set[str] = set()
    frontier = [start]
    while frontier:
        node = frontier.pop()
        for u, v in edges:
            if u == node and v not in seen:
                seen.add(v)
                frontier.append(v)
    return seen


def _is_cyclic(edges: list[tuple[str, str]]) -> bool:
    return any(node in _reachable(edges, node) for node in _IDS)


def _expected_order(nodes: list[str], edges: list[tuple[str, str]]) -> list[str]:
    """The definition: repeatedly take the smallest id with no unplaced predecessor."""
    left = set(nodes)
    out: list[str] = []
    while left:
        node = min(n for n in left if not any(v == n and u in left for u, v in edges))
        out.append(node)
        left.remove(node)
    return out


@pytest.mark.fuzz
@given(nodes=_nodes, edges=_edges)
@settings(max_examples=300, deadline=None)
def test_order_is_the_lexicographically_smallest_topological_order(
    nodes: list[str], edges: list[tuple[str, str]]
) -> None:
    """A valid topological order, ties broken on ``str(id)``, whatever the insertion order."""
    g = _graph(nodes, edges)
    if _is_cyclic(edges):
        with pytest.raises(_GraphHasCycle):
            _topological_order(g)
        return
    order = _topological_order(g)
    position = {node: i for i, node in enumerate(order)}
    assert sorted(order) == sorted(_IDS)
    assert all(position[u] < position[v] for u, v in edges)
    assert order == _expected_order(nodes, edges)
    assert _topological_order(_graph(list(reversed(nodes)), edges[::-1])) == order


@pytest.mark.fuzz
@given(edges=_edges)
@settings(max_examples=300, deadline=None)
def test_a_reported_cycle_is_a_real_cycle_of_the_input(edges: list[tuple[str, str]]) -> None:
    found = find_cycle(edges)
    assert _pairs_are_acyclic(edges) is not _is_cyclic(edges)
    assert bool(found) is _is_cyclic(edges)
    if found.cycle is not None:
        assert found.cycle[0] == found.cycle[-1]
        assert len(set(found.cycle[:-1])) == len(found.cycle) - 1
        assert all(pair in edges for pair in pairwise(found.cycle))
        # Starts at the smallest id that lies on any cycle, whatever the edge order.
        assert found.cycle[0] == min(n for n in _IDS if n in _reachable(edges, n))
        assert find_cycle(edges[::-1]).cycle == found.cycle


@pytest.mark.fuzz
@given(nodes=_nodes, edges=_edges)
@settings(max_examples=300, deadline=None)
def test_strongly_connected_components_match_mutual_reachability(
    nodes: list[str], edges: list[tuple[str, str]]
) -> None:
    components = _strongly_connected_components(_graph(nodes, edges))
    reach = {n: _reachable(edges, n) | {n} for n in _IDS}
    expected = {frozenset(m for m in reach[n] if n in reach[m]) for n in _IDS}
    assert sorted(map(sorted, components)) == sorted(map(sorted, expected))


@pytest.mark.fuzz
@given(edges=_edges)
@settings(max_examples=100, deadline=None)
def test_the_cycle_error_contract_is_unchanged(edges: list[tuple[str, str]]) -> None:
    """schedule() and monte_carlo() raise CyclicDependencyError naming a real cycle."""
    unique = list(dict.fromkeys(edges))
    if not _is_cyclic(unique):
        return
    project = Project(
        id="p",
        name="p",
        start_date=date(2026, 3, 2),
        tasks=[Task(id=i, name=i, duration=timedelta(days=1)) for i in _IDS],
        dependencies=[Dependency(predecessor_id=u, successor_id=v) for u, v in unique],
    )
    for run in (schedule, monte_carlo):
        with pytest.raises(CyclicDependencyError) as excinfo:
            run(project)
        assert isinstance(excinfo.value, SchedulerError)
        assert isinstance(excinfo.value, ValueError)
        assert excinfo.value.cycle == find_cycle(unique).cycle


def test_a_second_edge_on_a_pair_overwrites_and_keeps_its_position() -> None:
    first = Dependency(predecessor_id="a", successor_id="b")
    other = Dependency(predecessor_id="a", successor_id="c")
    second = Dependency(predecessor_id="a", successor_id="b", dep_type=DependencyType.SS)
    g = _DiGraph()
    for dep in (first, other, second):
        g.add_edge(dep.predecessor_id, dep.successor_id, dep=dep)
    assert list(g.successors("a")) == ["b", "c"]
    assert list(g.predecessors("b")) == ["a"]
    assert g["a"]["b"]["dep"] is second
    assert [(u, v, d["dep"]) for u, v, d in g.edges()] == [("a", "b", second), ("a", "c", other)]


def test_adjacency_is_insertion_ordered_in_both_directions() -> None:
    for order in permutations(["x", "y", "z"]):
        g = _graph([], [(u, "t") for u in order] + [("s", v) for v in order])
        assert list(g.predecessors("t")) == list(order)
        assert list(g.successors("s")) == list(order)


def test_a_chain_past_the_recursion_limit_is_handled() -> None:
    ids = [f"{i:05d}" for i in range(5_000)]
    edges = list(pairwise(ids))
    assert not find_cycle(edges)
    assert find_cycle([*edges, (ids[-1], ids[0])]).cycle == [*ids, ids[0]]
