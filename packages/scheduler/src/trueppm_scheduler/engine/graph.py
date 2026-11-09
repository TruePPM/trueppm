"""Dependency-graph construction and cycle detection."""

from __future__ import annotations

from dataclasses import (
    dataclass,
)
from typing import (
    Any,
    NoReturn,
)

import networkx as nx

from trueppm_scheduler.engine.errors import (
    CyclicDependencyError,
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.limits import (
    MAX_EXPANDED_EDGES,
)
from trueppm_scheduler.engine.summary import (
    _check_children_map,
    _collect_leaves,
)
from trueppm_scheduler.engine.validate import (
    _unknown_calendar_id_message,
)
from trueppm_scheduler.models import (
    Calendar,
    Project,
    _short_repr,
)


def _resolve_task_calendars(project: Project) -> dict[str, Calendar] | None:
    """Map each task id to the calendar its own date arithmetic should use (ADR-0120 D3).

    Returns ``None`` when the project declares no per-task ``calendars`` registry —
    the signal for the engine to take the single-calendar fast path that is
    byte-for-byte identical to the pre-ADR-0120 behavior. Otherwise every task
    resolves to its ``Project.calendars[task.calendar_id]`` entry, or to the
    pass-level ``project.calendar`` when ``calendar_id`` is unset.

    A ``calendar_id`` naming no registry entry raises :class:`InvalidScheduleInput`
    (#4516). :func:`_validate_project` refuses it first on every validated entry
    point; raising here too keeps the callers that resolve calendars without
    re-validating — :func:`~trueppm_scheduler.derive.derive_value` given a
    precomputed ``result``, :func:`perturb_task_duration` — from silently scheduling
    the task on the wrong working week.

    This map governs *duration* arithmetic only: a task's own working week. Lag on
    an edge is consumed on the **successor's** calendar (the constraint lands where
    the wait is), so the passes look the successor up in this same map separately.
    """
    if not project.calendars:
        return None
    default = project.calendar
    calendars = project.calendars
    resolved: dict[str, Calendar] = {}
    for t in project.tasks:
        if t.calendar_id is None:
            resolved[t.id] = default
            continue
        cal = calendars.get(t.calendar_id)
        if cal is None:
            raise InvalidScheduleInput(_unknown_calendar_id_message(t.id, t.calendar_id))
        resolved[t.id] = cal
    return resolved


# ---------------------------------------------------------------------------
# Graph utilities
# ---------------------------------------------------------------------------


def _build_graph(project: Project) -> nx.DiGraph[str]:
    """Build a directed graph from project tasks and dependencies."""
    g: nx.DiGraph[str] = nx.DiGraph()
    task_ids = {t.id for t in project.tasks}
    for task in project.tasks:
        g.add_node(task.id)
    for dep in project.dependencies:
        if dep.predecessor_id not in task_ids or dep.successor_id not in task_ids:
            # A dependency naming a non-existent task is degenerate input by the
            # #749 definition, so raise the documented type (not a bare ValueError)
            # — this keeps the cross-engine reject-parity contract symmetric: the
            # Rust build_graph returns Err for the same input, and the shared
            # fixtures/invalid/unknown_dependency_task.json conformance fixture
            # asserts InvalidScheduleInput on both schedule() and monte_carlo()
            # (#1087). InvalidScheduleInput subclasses ValueError, so existing
            # ``except ValueError`` callers are unaffected.
            raise InvalidScheduleInput(
                f"Dependency references unknown task: {_short_repr(dep.predecessor_id)} → "
                f"{_short_repr(dep.successor_id)}"
            )
        g.add_edge(dep.predecessor_id, dep.successor_id, dep=dep)
    return g


def _raise_cycle_error(g: nx.DiGraph[str]) -> NoReturn:
    """Reconstruct and raise the cycle from a graph a topological sort rejected.

    Called only from the ``NetworkXUnfeasible`` handler of a topological sort:
    the sort has already proved the graph cyclic in ~3ms, so the SCC pass and
    BFS in :func:`_canonical_cycle` run only on this error path to reconstruct
    the user-facing cycle (#1526) — never on the happy path,
    where checking cycles eagerly with ``find_cycle`` was 37% of the
    ``schedule()`` budget for a result the topological sort already proves.
    """
    raise CyclicDependencyError(_canonical_cycle(g))


def _node_key(node: object) -> tuple[str, str]:
    return (str(node), repr(node))


def _canonical_cycle(g: nx.DiGraph[str]) -> list[str]:
    """Return one cycle of ``g`` independent of edge/node insertion order.

    Picks the non-trivial strongly connected component holding the smallest id,
    then the shortest cycle through that id (BFS over sorted successors), so the
    result starts at the smallest id on it and closes by repeating it. Ids are
    ordered by ``str`` then ``repr`` so mixed-type ids still sort stably.
    """
    sccs = [
        c
        for c in nx.strongly_connected_components(g)
        if len(c) > 1 or any(g.has_edge(n, n) for n in c)
    ]
    start = min((min(c, key=_node_key) for c in sccs), key=_node_key)
    scc = next(c for c in sccs if start in c)
    parent: dict[str, str | None] = {start: None}
    queue = [start]
    closer: str | None = None
    for node in queue:
        for nxt in sorted(g.successors(node), key=_node_key):
            if nxt == start:
                closer = node
                break
            if nxt in scc and nxt not in parent:
                parent[nxt] = node
                queue.append(nxt)
        if closer is not None:
            break
    path: list[str] = []
    cur: str | None = closer
    while cur is not None:
        path.append(cur)
        cur = parent[cur]
    path.reverse()
    return [*path, start]


@dataclass
class CycleCheck:
    """Result of a dependency-graph cycle check (see :func:`find_cycle`).

    Wraps the raw cycle path so this public, ``__all__``-exported helper can grow
    new fields later (e.g. the dependency types along the cycle) without breaking
    callers — the pip wheel ships this API, so its shape is a forward-compatibility
    contract (#1325). Truthy iff a cycle was found, so ``if find_cycle(...):`` still
    reads naturally.
    """

    #: The cycle as an ordered list of task IDs with the first repeated at the end
    #: (e.g. ``["A", "B", "C", "A"]``), or ``None`` when the graph is acyclic.
    cycle: list[str] | None

    def __bool__(self) -> bool:
        """Return ``True`` when a cycle was found, ``False`` when the graph is acyclic."""
        return self.cycle is not None

    def to_dict(self) -> dict[str, Any]:
        """Return this cycle-check result as a JSON-serializable dict.

        Returns:
            ``{"cycle": [<task id>, ...]}`` naming the offending tasks, or
            ``{"cycle": None}`` when the graph is acyclic. Note that the object
            itself is falsy in the acyclic case (``__bool__``), so
            ``if find_cycle(...)`` reads correctly without inspecting this dict.
        """
        return {"cycle": self.cycle}


def find_cycle(
    edges: list[tuple[str, str]],
    children_map: dict[str, list[str]] | None = None,
) -> CycleCheck:
    """Detect a cycle in a dependency graph; return ordered task IDs or None.

    Operates on raw ``(predecessor_id, successor_id)`` tuples so callers do
    not need to construct full :class:`Task` / :class:`Dependency` model
    objects just to validate a single proposed edge.

    When ``children_map`` is provided, summary→X and X→summary edges are
    expanded to their leaf descendants before detection so logical cycles
    through summary tasks are caught (e.g. ``Eng (summary) → Validate`` where
    ``Validate`` is one of ``Eng``'s leaves is a cycle).

    Args:
        edges: All ``(predecessor_id, successor_id)`` edges in the proposed
            graph, including the new edge being validated.
        children_map: Optional mapping of summary task ID to list of direct
            child IDs. Tasks not in the mapping are treated as leaves.

    Returns:
        A :class:`CycleCheck` whose ``cycle`` is the cycle as an ordered list of
        task IDs with the first repeated at the end (e.g. ``['A', 'B', 'C', 'A']``)
        so callers can render an unambiguous path, or ``None`` if the graph is
        acyclic. The cycle is deterministic: independent of edge order, it is
        the shortest cycle through the smallest id of the smallest non-trivial
        strongly connected component, starting at that id and closing by
        repeating it. The result is truthy iff a cycle was found.

    Raises:
        InvalidScheduleInput: If ``children_map`` itself is malformed — not a
            dict, a summary id (key) or child id that is not a string (``None``
            and other non-string ids are refused, #4522), a value that is not a
            list, a summary with an empty children list, or a cycle in
            ``children_map`` itself (a summary that is its own ancestor) —
            distinct from a cycle in the ``edges`` being validated, which is
            returned, not raised. Also raised if expanding summary→summary
            edges would exceed :data:`MAX_EXPANDED_EDGES` leaf-level tuples (a
            pathological cross product); the graph is rejected rather than
            allowed to spin.
    """
    edge_list = _validate_edge_list(edges)
    _validate_children_map_shape(children_map)

    if children_map:
        edge_list = _expand_edges_for_cycle_check(edge_list, children_map)
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from(edge_list)
    if nx.is_directed_acyclic_graph(g):
        return CycleCheck(cycle=None)
    return CycleCheck(cycle=_canonical_cycle(g))


def _validate_edge_list(edges: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Validate the raw edge input shape for the public :func:`find_cycle` API.

    Checked up front so a malformed call raises the documented
    ``InvalidScheduleInput`` rather than a bare ``NetworkXError``/``TypeError``
    from deep inside networkx or ``_collect_leaves`` (#1209).
    """
    try:
        edge_list = list(edges)
    except TypeError as err:
        raise InvalidScheduleInput(
            f"edges must be an iterable of pairs (got {_short_repr(edges)})."
        ) from err
    for e in edge_list:
        if not (isinstance(e, tuple) and len(e) == 2):
            raise InvalidScheduleInput(
                f"each edge must be a (predecessor_id, successor_id) 2-tuple (got "
                f"{_short_repr(e)})."
            )
        u, v = e
        if not isinstance(u, str) or not isinstance(v, str):
            raise InvalidScheduleInput(
                f"edge endpoints must be string task ids (got {_short_repr(e)})."
            )
    return edge_list


def _validate_children_map_shape(children_map: dict[str, list[str]] | None) -> None:
    """Guard the container type before ``.items()`` (#1825).

    A non-dict argument (a list or str) would otherwise leak a bare
    ``AttributeError`` past the documented contract. Also rejects a non-string
    summary id (key) or child id (#4522) — a ``None``/unhashable (list/dict)
    child entry otherwise reaches ``children_map.get(node)`` inside
    ``_collect_leaves`` during expansion and either leaks a bare
    ``TypeError``/``ValueError`` or, for ``None``, is silently accepted as a leaf
    id with no error at all; a non-string key (e.g. an ``int``) never matches a
    string edge endpoint, so the whole entry is silently accepted and ignored as
    a dead no-op instead of being refused as the malformed input it is.
    """
    if children_map is None:
        return
    if not isinstance(children_map, dict):
        raise InvalidScheduleInput(
            f"children_map must be a dict of summary id -> child ids or None "
            f"(got {type(children_map).__name__})."
        )
    for sid, kids in children_map.items():
        if not isinstance(sid, str):
            raise InvalidScheduleInput(
                f"children_map contains a non-string summary id "
                f"(got {type(sid).__name__}: {_short_repr(sid)})."
            )
        if not isinstance(kids, list):
            raise InvalidScheduleInput(
                f"children_map[{_short_repr(sid)}] must be a list of child ids (got "
                f"{_short_repr(kids)})."
            )
        for child_id in kids:
            if not isinstance(child_id, str):
                raise InvalidScheduleInput(
                    f"children_map[{_short_repr(sid)}] contains a non-string child id "
                    f"(got {type(child_id).__name__}: {_short_repr(child_id)})."
                )


def _expand_edges_for_cycle_check(
    edges: list[tuple[str, str]],
    children_map: dict[str, list[str]],
) -> list[tuple[str, str]]:
    """Expand summary↔leaf edges to leaf-level tuples for cycle detection.

    Operates on raw edge tuples — no :class:`Dependency` objects required.
    Deduplicates the result. Self-loops *produced by expansion* are kept: a
    summary→its-own-leaf edge expands to a self-loop on the leaf, and that
    self-loop is precisely the logical cycle this function exists to surface.
    :func:`expand_summary_dependencies` refuses the same links with
    :class:`CyclicDependencyError` (#4705), so the two agree on every input.
    """
    summary_ids = set(children_map.keys())
    if not summary_ids:
        return edges
    _check_children_map(children_map)

    # Resolve each endpoint to its leaves once: an endpoint id can recur across many
    # edges, and _collect_leaves walks the subtree each call.
    endpoint_ids = {pid for pid, _ in edges} | {sid for _, sid in edges}
    leaves = {
        nid: (_collect_leaves(nid, children_map) if nid in summary_ids else [nid])
        for nid in endpoint_ids
    }

    # Bound the cross product from leaf *counts* before materialising a single
    # tuple (#357). The worst case — a wide summary→summary edge — is O(P*S) per
    # edge; summing the per-edge products up front lets us reject a pathological
    # graph in O(edges + leaves) instead of after building millions of tuples (or
    # timing out). The estimate is an upper bound (it ignores cross-edge dedup),
    # which is the safe direction: we never under-count and let a blowup through.
    estimated = 0
    for pred_id, succ_id in edges:
        estimated += len(leaves[pred_id]) * len(leaves[succ_id])
        if estimated > MAX_EXPANDED_EDGES:
            raise InvalidScheduleInput(
                f"Cannot validate cycles: expanding summary dependencies to leaf "
                f"level would exceed {MAX_EXPANDED_EDGES:,} edges. A summary→summary "
                "dependency is fanning out to the cross product of both summaries' "
                "leaves — simplify the structure (depend on specific leaf tasks, or "
                "split the wide summary edge) and retry."
            )

    seen: set[tuple[str, str]] = set()
    expanded: list[tuple[str, str]] = []
    for pred_id, succ_id in edges:
        for p in leaves[pred_id]:
            for s in leaves[succ_id]:
                if (p, s) in seen:
                    continue
                seen.add((p, s))
                expanded.append((p, s))
    return expanded
