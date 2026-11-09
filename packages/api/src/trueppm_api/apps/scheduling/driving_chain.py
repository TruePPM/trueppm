"""Bounded driving chain for one task, walked from a single CPM pass (ADR-1381, #4891).

The chain is a **server fact**: it is read off ``ScheduleResult.driving_edges`` — the
edges the engine itself marked as binding or zero relationship free float (#4704) —
over the network *after* ADR-0105's summary expansion. A client that walks stored
dependencies instead never sees the leaf edges a summary link fans out to (#3602),
which is why this exists rather than N derivation calls.

Bounded on purpose (#4656): ``depth`` hops per direction and a hard node cap, with an
explicit ``truncated`` flag. Nothing here returns an uncapped id list.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any

DEFAULT_DEPTH = 25
MAX_DEPTH = 50
NODE_CAP = 200


@dataclass(frozen=True)
class _EdgeFacts:
    lag_days: int
    via_summary: list[str] | None


def _ancestors_by_leaf(children_map: dict[str, list[str]]) -> dict[str, set[str]]:
    """Map every id to the set of summary ids above it (itself excluded)."""
    parent: dict[str, str] = {}
    for summary_id, children in children_map.items():
        for child in children:
            parent[child] = summary_id
    out: dict[str, set[str]] = {}
    for node in set(parent) | set(children_map):
        seen: set[str] = set()
        cur = parent.get(node)
        while cur is not None and cur not in seen:
            seen.add(cur)
            cur = parent.get(cur)
        out[node] = seen
    return out


def _edge_facts(
    expanded_deps: list[Any], raw_deps: list[Any], children_map: dict[str, list[str]]
) -> dict[tuple[str, str, str], _EdgeFacts]:
    """Lag the engine used and the summary link(s) each leaf edge was expanded from.

    A leaf edge that is also a direct stored link reports ``via_summary=None``: the
    direct link exists whether or not a summary fan-out also produced it. Otherwise
    ``via_summary`` names the summary endpoint(s) of every raw link that expands onto
    it — the same rule as ``expand_summary_dependencies`` (a raw link covers every
    leaf beneath each summary endpoint), applied in reverse.
    """
    summary_ids = set(children_map)
    above = _ancestors_by_leaf(children_map)
    direct = {(d.predecessor_id, d.successor_id, d.dep_type.value) for d in raw_deps}
    summary_raw = [
        d for d in raw_deps if d.predecessor_id in summary_ids or d.successor_id in summary_ids
    ]
    facts: dict[tuple[str, str, str], _EdgeFacts] = {}
    for d in expanded_deps:
        key = (d.predecessor_id, d.successor_id, d.dep_type.value)
        lag_days = d.lag.days
        if key in direct:
            facts[key] = _EdgeFacts(lag_days, None)
            continue
        pred_scope = {d.predecessor_id} | above.get(d.predecessor_id, set())
        succ_scope = {d.successor_id} | above.get(d.successor_id, set())
        via: set[str] = set()
        for r in summary_raw:
            if (
                r.dep_type == d.dep_type
                and r.predecessor_id in pred_scope
                and r.successor_id in succ_scope
            ):
                via |= {r.predecessor_id, r.successor_id} & summary_ids
        facts[key] = _EdgeFacts(lag_days, sorted(via) or None)
    return facts


def build_driving_chain(
    *,
    result: Any,
    expanded_deps: list[Any],
    raw_deps: list[Any],
    children_map: dict[str, list[str]],
    db_tasks_by_id: dict[str, Any],
    task_id: str,
    depth: int = DEFAULT_DEPTH,
    node_cap: int = NODE_CAP,
) -> dict[str, Any]:
    """Walk the driving chain through ``task_id`` in both directions.

    Upstream follows driving predecessors toward the anchor (tasks nothing drives);
    downstream follows driving successors toward the project finish. Breadth-first in
    sorted-id order, each task visited once, so the output is deterministic. The CPM
    network is a DAG (``schedule()`` rejects a cycle before this runs), so the chain is
    cycle-free by construction.

    Args:
        result: The ``ScheduleResult`` of the single pass.
        expanded_deps: The leaf-level dependencies the pass received.
        raw_deps: The stored dependencies before summary expansion.
        children_map: Summary id → direct child ids.
        db_tasks_by_id: Django ``Task`` rows (``sprint`` selected) keyed by str id.
        task_id: The task the chain is walked through; must be in the network.
        depth: Maximum hops per direction.
        node_cap: Maximum nodes in the response, the task itself included. The task
            takes one slot and downstream is guaranteed ``min(its reachable nodes,
            node_cap // 2)`` slots; upstream gets the rest, and downstream fills any
            slots upstream leaves unused. When both ``depth`` and ``node_cap`` bind,
            ``truncated_reason`` reports ``node_cap``.

    Returns:
        ``{nodes, edges, truncated, truncated_reason}`` — see
        ``ScheduleDrivingChainSerializer`` for the field contract.
    """
    preds: dict[str, list[Any]] = {}
    succs: dict[str, list[Any]] = {}
    for e in result.driving_edges:
        preds.setdefault(e.successor_id, []).append(e)
        succs.setdefault(e.predecessor_id, []).append(e)

    hops: dict[str, tuple[str, int]] = {task_id: ("self", 0)}

    def walk(
        direction: str, adjacency: dict[str, list[Any]], far_end: str, limit: int
    ) -> str | None:
        """Breadth-first walk adding nodes until ``len(hops)`` reaches ``limit``.

        Re-walking a direction passes through the nodes an earlier, smaller-limit pass
        already placed (same BFS order, so the same hops) and continues past them. Returns
        the limit that cut the walk short, or ``None`` if it reached the chain's end.
        """
        reason: str | None = None
        seen = {task_id}
        queue: deque[tuple[str, int]] = deque([(task_id, 0)])
        while queue:
            node, dist = queue.popleft()
            nexts = sorted({getattr(e, far_end) for e in adjacency.get(node, [])})
            for nxt in nexts:
                if nxt in seen:
                    continue
                if nxt in hops:
                    seen.add(nxt)
                    queue.append((nxt, hops[nxt][1]))
                    continue
                if dist >= depth:
                    reason = reason or "depth"
                    break
                if len(hops) >= limit:
                    return "node_cap"
                seen.add(nxt)
                hops[nxt] = (direction, dist + 1)
                queue.append((nxt, dist + 1))
        return reason

    # Fair split of the node cap: downstream (the path to the finish, the half that
    # answers "why critical") is placed first, up to node_cap // 2 nodes beyond the
    # task itself; upstream then fills the cap; downstream then takes whatever upstream
    # left. A fan-in larger than the cap can no longer starve the downstream half.
    walk("downstream", succs, "successor_id", 1 + node_cap // 2)
    reasons = {
        walk("upstream", preds, "predecessor_id", node_cap),
        walk("downstream", succs, "successor_id", node_cap),
    }
    # One reason is reported; node_cap wins over depth when both bind.
    truncated_reason = (
        "node_cap" if "node_cap" in reasons else "depth" if "depth" in reasons else None
    )

    # Only the chain's own edges are resolved: matching every expanded edge against
    # every summary link is O(edges x summary links) on a large WBS, and the response
    # carries at most a few hundred edges.
    chain_keys = {
        (e.predecessor_id, e.successor_id, e.dep_type)
        for e in result.driving_edges
        if e.predecessor_id in hops and e.successor_id in hops
    }
    facts = _edge_facts(
        [
            d
            for d in expanded_deps
            if (d.predecessor_id, d.successor_id, d.dep_type.value) in chain_keys
        ],
        raw_deps,
        children_map,
    )
    sched_by_id = {t.id: t for t in result.tasks}
    nodes = []
    for nid, (direction, hop) in sorted(hops.items(), key=lambda kv: (kv[1][1], kv[0])):
        st = sched_by_id[nid]
        db = db_tasks_by_id.get(nid)
        sprint = getattr(db, "sprint", None) if db is not None else None
        nodes.append(
            {
                "task_id": nid,
                "name": st.name,
                "status": getattr(db, "status", None),
                "direction": direction,
                "hops": hop,
                "early_start": st.early_start,
                "early_finish": st.early_finish,
                "total_float_days": st.total_float.days,
                "is_critical": bool(st.is_critical),
                "is_project_finish": st.early_finish == result.project_finish,
                # Sprint-bound is a fact about the task, not the team: id and end date
                # only — never assignee, hours, or velocity (#4891).
                "sprint": (
                    {"id": str(sprint.pk), "finish_date": sprint.finish_date}
                    if sprint is not None
                    else None
                ),
            }
        )

    edges = []
    for e in result.driving_edges:
        if e.predecessor_id in hops and e.successor_id in hops:
            f = facts.get((e.predecessor_id, e.successor_id, e.dep_type))
            edges.append(
                {
                    "predecessor_id": e.predecessor_id,
                    "successor_id": e.successor_id,
                    "dep_type": e.dep_type,
                    "lag_days": f.lag_days if f else 0,
                    "is_driving": True,
                    "via_summary": f.via_summary if f else None,
                }
            )

    return {
        "nodes": nodes,
        "edges": edges,
        "truncated": truncated_reason is not None,
        "truncated_reason": truncated_reason,
    }
