"""The engine's dependency graph and the algorithms run over it (#4163).

A small directed graph in the package replaces the third-party graph library the
engine used through 0.4. Two behaviors of that library are load-bearing and are
kept exactly:

* Adjacency is **insertion-ordered**, in both directions. Several passes walk a
  node's predecessors or successors and keep the first of two equal constraints,
  and :mod:`trueppm_scheduler.derive` mirrors the same order from the raw
  dependency list.
* A second edge between the same pair **overwrites** the first one's dependency
  and keeps its position. :func:`~trueppm_scheduler.engine.validate` refuses such
  pairs because of it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from heapq import heapify, heappop, heappush
from typing import Any

from trueppm_scheduler.models import Dependency


class _GraphHasCycle(Exception):
    """A topological sort could not order every node, so the graph has a cycle."""


class _DiGraph:
    """Directed graph of task ids whose edges carry their :class:`Dependency`.

    ``g[u][v]["dep"]`` reads an edge's dependency. Edges added without one (the
    cycle check works on bare id pairs) carry an empty mapping.
    """

    __slots__ = ("_pred", "_succ")

    def __init__(self) -> None:
        self._succ: dict[str, dict[str, dict[str, Dependency]]] = {}
        # The same per-edge mapping object as ``_succ`` holds, keyed the other way.
        self._pred: dict[str, dict[str, dict[str, Dependency]]] = {}

    def add_node(self, node: str) -> None:
        """Add ``node``; a node already present keeps its position and edges."""
        if node not in self._succ:
            self._succ[node] = {}
            self._pred[node] = {}

    def add_edge(self, u: str, v: str, dep: Dependency | None = None) -> None:
        """Add ``u`` -> ``v``, overwriting the dependency of an existing such edge."""
        self.add_node(u)
        self.add_node(v)
        data = self._succ[u].get(v)
        if data is None:
            data = {}
            self._succ[u][v] = data
            self._pred[v][u] = data
        if dep is not None:
            data["dep"] = dep

    def __iter__(self) -> Iterator[str]:
        """Iterate node ids in insertion order."""
        return iter(self._succ)

    def __len__(self) -> int:
        """Return the number of nodes."""
        return len(self._succ)

    def __getitem__(self, node: str) -> dict[str, dict[str, Dependency]]:
        """Return ``node``'s successors mapped to their edge data."""
        return self._succ[node]

    def successors(self, node: str) -> Iterator[str]:
        """Iterate ``node``'s successors in edge insertion order."""
        return iter(self._succ[node])

    def predecessors(self, node: str) -> Iterator[str]:
        """Iterate ``node``'s predecessors in edge insertion order."""
        return iter(self._pred[node])

    def has_edge(self, u: str, v: str) -> bool:
        """Return whether the edge ``u`` -> ``v`` exists."""
        return v in self._succ.get(u, ())

    def edges(self) -> Iterator[tuple[str, str, dict[str, Dependency]]]:
        """Iterate ``(u, v, data)``, grouped by ``u`` in node insertion order."""
        for u, successors in self._succ.items():
            for v, data in successors.items():
                yield u, v, data


def _topological_order(g: _DiGraph, key: Callable[[str], Any] = str) -> list[str]:
    """Return the lexicographically smallest topological order of ``g`` under ``key``.

    Kahn's algorithm over a heap, so the order depends only on the graph and the
    keys, which the Rust engine's identical sort shares (#909). Nodes with equal
    keys fall back to node insertion order.

    Raises:
        _GraphHasCycle: If ``g`` is cyclic.
    """
    position = {node: i for i, node in enumerate(g)}
    waiting = {node: len(preds) for node, preds in g._pred.items()}
    ready = [(key(node), position[node], node) for node, n in waiting.items() if not n]
    heapify(ready)
    order: list[str] = []
    while ready:
        node = heappop(ready)[2]
        order.append(node)
        for succ in g._succ[node]:
            waiting[succ] -= 1
            if not waiting[succ]:
                heappush(ready, (key(succ), position[succ], succ))
    if len(order) != len(g):
        raise _GraphHasCycle
    return order


def _pairs_are_acyclic(edges: list[tuple[str, str]]) -> bool:
    """Whether bare ``(predecessor, successor)`` pairs form an acyclic graph.

    Order-free Kahn pass for the public cycle check's success path, which runs on
    every accepted dependency create and so builds no :class:`_DiGraph` and no
    heap (#3785). Repeated pairs are counted and consumed alike.
    """
    successors: dict[str, list[str]] = {}
    waiting: dict[str, int] = {}
    for u, v in edges:
        if u in successors:
            successors[u].append(v)
        else:
            successors[u] = [v]
        waiting[v] = waiting.get(v, 0) + 1
    ready = [u for u in successors if u not in waiting]
    consumed = 0
    while ready:
        for v in successors.get(ready.pop(), ()):
            consumed += 1
            waiting[v] -= 1
            if not waiting[v]:
                ready.append(v)
    # An edge is consumed only once its source is ordered, so any edge left over
    # hangs off a node that a cycle kept from ever becoming ready.
    return consumed == len(edges)


def _strongly_connected_components(g: _DiGraph) -> list[set[str]]:
    """Tarjan's strongly connected components, iteratively (no recursion limit)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    components: list[set[str]] = []
    work: list[tuple[str, Iterator[str]]] = []

    def enter(node: str) -> None:
        index[node] = low[node] = len(index)
        stack.append(node)
        on_stack.add(node)
        work.append((node, g.successors(node)))

    for root in g:
        if root in index:
            continue
        enter(root)
        while work:
            node, remaining = work[-1]
            for succ in remaining:
                if succ not in index:
                    enter(succ)
                    break
                if succ in on_stack:
                    low[node] = min(low[node], index[succ])
            else:
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[node])
                if low[node] == index[node]:
                    component: set[str] = set()
                    while node not in component:
                        member = stack.pop()
                        on_stack.discard(member)
                        component.add(member)
                    components.append(component)
    return components
