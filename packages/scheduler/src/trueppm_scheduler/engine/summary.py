"""Summary-task dependency expansion onto leaf tasks."""

from __future__ import annotations

from collections.abc import (
    Iterator,
)
from dataclasses import (
    dataclass,
)
from typing import (
    Any,
)

from trueppm_scheduler.engine.errors import (
    CyclicDependencyError,
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.limits import (
    MAX_EXPANDED_EDGES,
)
from trueppm_scheduler.engine.validate import (
    _describe_link,
)
from trueppm_scheduler.models import (
    Dependency,
    DependencyType,
    Task,
    _short_repr,
)


@dataclass
class SummaryExpansion:
    """Result of expanding summary-task dependencies (see :func:`expand_summary_dependencies`).

    Wraps the ``(tasks, dependencies)`` pair so this public, ``__all__``-exported
    helper can grow fields without breaking the pip contract (#1325). Iterable for
    backward compatibility — ``leaf_tasks, deps = expand_summary_dependencies(...)``
    still unpacks — while ``.tasks`` / ``.dependencies`` are the named accessors.
    """

    #: Input tasks with summary tasks removed (only leaves remain).
    tasks: list[Task]
    #: Dependencies fanned out to leaf-level edges, deduplicated.
    dependencies: list[Dependency]

    def __iter__(self) -> Iterator[Any]:
        """Yield ``tasks`` then ``dependencies`` so the result unpacks as a pair."""
        yield self.tasks
        yield self.dependencies


# ---------------------------------------------------------------------------
# Summary task dependency expansion
# ---------------------------------------------------------------------------


def _check_children_map(children_map: dict[str, list[str]]) -> None:
    """Validate a children_map's shape before it drives leaf expansion (#1070, #1825).

    Rejects a summary entry with an empty child list (#1070): ``_collect_leaves``
    treats a node with no children as a leaf, so an empty entry made the summary id
    *itself* survive expansion as a leaf — while ``expand_summary_dependencies``
    removed it from the task list, leaving a dangling edge that later failed with a
    generic "unknown task" ValueError far from the actual mistake.

    Also rejects a non-list child value (#1825): ``expand_summary_dependencies`` is
    the twin of ``find_cycle`` (which already guards this at its own entry point),
    and both funnel through here. Without the guard a non-list value leaks a bare
    ``TypeError`` from ``reversed()`` in ``_collect_leaves`` — and, worse, a *string*
    value silently iterates its characters as child ids, producing corrupt expanded
    dependencies with no error at all.

    Also rejects a non-string child id (#4522): a ``None`` or unhashable (list/dict)
    entry otherwise reaches ``children_map.get(node)`` inside ``_collect_leaves`` and
    either leaks a bare ``TypeError`` ("unhashable type") or — for ``None``, which
    *is* hashable — is silently accepted as a leaf id, producing a
    :class:`Dependency` whose endpoint is ``None`` instead of a task id, with no
    error at all. Every task/dependency id elsewhere in this module is required to
    be a string (:func:`_require_str`); a child id is no exception.

    Also rejects a non-string summary id (key, #4522): an ``int`` (or other
    non-string) key never matches a string edge/task endpoint, so the whole entry
    silently becomes a dead no-op instead of being refused as the malformed input
    it is.
    """
    if not isinstance(children_map, dict):
        raise InvalidScheduleInput(
            f"children_map must be a dict of summary id -> child ids "
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
        if not kids:
            raise InvalidScheduleInput(
                f"Summary task {_short_repr(sid)} has an empty children list; remove it from "
                "children_map or give it children."
            )
        for child_id in kids:
            if not isinstance(child_id, str):
                raise InvalidScheduleInput(
                    f"children_map[{_short_repr(sid)}] contains a non-string child id "
                    f"(got {type(child_id).__name__}: {_short_repr(child_id)})."
                )


def _collect_leaves(
    task_id: str,
    children_map: dict[str, list[str]],
) -> list[str]:
    """Collect the distinct leaf task IDs under a summary task, in first-visit order.

    A leaf is a task that has no children in children_map. Traversal is
    iterative with an explicit stack and an active-path set, so a malformed
    ``children_map`` (a parent-child cycle, or nesting deeper than Python's
    recursion limit) raises a clean :class:`InvalidScheduleInput` instead of a
    ``RecursionError``. A node legitimately reachable via multiple parents (a
    diamond) is *not* a cycle; it is expanded once and its leaves are returned
    once. Callers deduplicate edges downstream, so the distinct set is
    equivalent to the former once-per-path list.

    Each node is expanded at most once (memoized), so the walk is O(V + E)
    regardless of how many root-to-leaf paths the DAG has (#4693). The #1822 cap
    still bounds the root-to-leaf *path* count, tracked as a per-node integer
    rather than by materializing one list entry per path.
    """
    leaves: list[str] = []
    # Number of root-to-leaf paths below each fully expanded node.
    path_count: dict[str, int] = {}
    # Stack entries are (node, is_exit_marker). The exit marker pops the node
    # back off the active path once its whole subtree has been visited.
    stack: list[tuple[str, bool]] = [(task_id, False)]
    path: set[str] = set()
    while stack:
        node, is_exit = stack.pop()
        if is_exit:
            path.discard(node)
            # Bound the leaf-*path* count (#1822). A "doubling" children_map (each
            # summary points at the next twice) has 2^depth paths to a single leaf;
            # callers cap the leaf *product* across an edge at MAX_EXPANDED_EDGES, so a
            # single endpoint exceeding it already forces every incident edge over the
            # cap. Counting (not listing) paths keeps this check O(1) per node.
            total = sum(path_count[child_id] for child_id in children_map[node])
            if total > MAX_EXPANDED_EDGES:
                raise InvalidScheduleInput(
                    f"Expanding summary dependencies would exceed {MAX_EXPANDED_EDGES:,} "
                    "leaf-level edges: a summary task fans out to that many root-to-leaf "
                    "paths (typically a summary→summary dependency crossing a deep or "
                    "wide WBS). Depend on specific leaf tasks, or split the summary edge."
                )
            path_count[node] = total
            continue
        children = children_map.get(node)
        if not children:
            if node not in path_count:
                path_count[node] = 1
                leaves.append(node)
            continue
        if node in path:
            raise InvalidScheduleInput(
                f"children_map contains a cycle through task {_short_repr(node)}."
            )
        if node in path_count:
            continue  # already expanded via another parent (diamond)
        path.add(node)
        stack.append((node, True))
        # Push children in reverse so they pop in declared order (stable output).
        for child_id in reversed(children):
            stack.append((child_id, False))
    return leaves


def expand_summary_dependencies(
    tasks: list[Task],
    deps: list[Dependency],
    children_map: dict[str, list[str]],
) -> SummaryExpansion:
    """Expand summary task dependencies into leaf-level edges.

    Summary tasks (those with entries in children_map) are removed from the
    task list. Dependencies involving summary tasks are fanned out to all
    their leaf descendants, producing a cross-product of edges. A link whose two
    endpoints share a leaf — a summary linked to itself, to one of its own
    descendants, or from one (and, with a diamond ``children_map``, two summaries
    holding a common leaf) — is a logical cycle and raises
    :class:`CyclicDependencyError`, exactly as :func:`find_cycle` reports it
    (#4705, #4538). The one exception is a Start-to-Start or Start-to-Finish link
    *from* a summary: the ADR-0370 check runs first and raises
    :class:`InvalidScheduleInput` for it, whatever its successor. Links that
    expand onto the same leaf pair are merged by meaning, not list order: same
    type keeps the largest (most binding) lag; different types raise
    :class:`InvalidScheduleInput` (#4434).

    Args:
        tasks: All tasks including summaries.
        deps: Dependencies that may reference summary tasks.
        children_map: Mapping of summary task ID to list of direct child IDs.

    Returns:
        A :class:`SummaryExpansion` whose ``tasks`` are the input tasks with
        summaries removed and whose ``dependencies`` are expanded to leaf-level
        edges. Unpacks as ``leaf_tasks, expanded_deps`` for backward compatibility.

    Raises:
        InvalidScheduleInput: If ``children_map`` is malformed — not a dict, a
            summary id (key) or child id that is not a string (``None`` and
            other non-string ids are refused, #4522), a value that is not a
            list, or a summary with an empty children list. Also raised for a
            Start-to-Start or Start-to-Finish link from a summary task (ADR-0370),
            checked before the shared-leaf rule below, so an SS/SF link from a
            summary to its own descendant raises this rather than
            ``CyclicDependencyError``.
        CyclicDependencyError: If a link's endpoints share a leaf (see above).
            ``cycle`` names the *source* link, not the leaves it expands to:
            ``[pred, succ, pred]``, or ``[pred, pred]`` when both endpoints are
            the same id.
    """
    if not children_map:
        return SummaryExpansion(tasks=tasks, dependencies=deps)
    _check_children_map(children_map)

    summary_ids = set(children_map.keys())
    leaf_tasks = [t for t in tasks if t.id not in summary_ids]

    _reject_summary_start_links(deps, summary_ids)

    leaves = _resolve_endpoint_leaves(deps, summary_ids, children_map)
    _check_expansion_bound(deps, leaves)
    _reject_overlapping_links(deps, leaves)

    return SummaryExpansion(tasks=leaf_tasks, dependencies=_cross_product_edges(deps, leaves))


def _reject_summary_start_links(deps: list[Dependency], summary_ids: set[str]) -> None:
    """Reject a Start-to-Start / Start-to-Finish link *from* a summary task (ADR-0370).

    A summary's START is its earliest-starting leaf (ADR-0024 §3, matching MS Project
    semantics), but the leaf cross-product fans a summary edge out to *every* leaf and
    preserves the dep type. For SS/SF that turns the successor's CPM ``max()`` over its
    predecessors into "wait for the LAST-starting leaf" — silently over-constraining the
    successor by up to the summary's whole span (the #1854 bug). FS/FF anchor on the
    summary's FINISH (its latest-finishing leaf), which ``max()`` over all leaves
    computes correctly, so those keep the fan-out.

    Rather than re-anchor to the earliest leaf (alternative a) or synthesize a hammock
    node (alternative b), the link is rejected with an actionable error, matching MS
    Project's own restriction posture. Deliberately kept out of
    :func:`_expand_edges_for_cycle_check` — cycle detection stays conservative and must
    still see the expanded edges.
    """
    for dep in deps:
        if dep.predecessor_id in summary_ids and dep.dep_type in (
            DependencyType.SS,
            DependencyType.SF,
        ):
            raise InvalidScheduleInput(
                f"Start-to-Start/Start-to-Finish dependency from summary task "
                f"{_short_repr(dep.predecessor_id)} is not supported (ADR-0024); link to a "
                f"specific "
                "leaf task instead."
            )


def _resolve_endpoint_leaves(
    deps: list[Dependency],
    summary_ids: set[str],
    children_map: dict[str, list[str]],
) -> dict[str, list[str]]:
    """Resolve every edge endpoint to its leaves, once per distinct id (#1208).

    An endpoint id recurs across many edges and ``_collect_leaves`` walks the subtree
    on each call, so resolving per distinct id rather than per edge is what keeps a
    wide WBS cheap. Mirrors the caching the cycle-check twin
    (:func:`_expand_edges_for_cycle_check`) already did — the asymmetry was a missed
    optimization here.
    """
    endpoint_ids = {d.predecessor_id for d in deps} | {d.successor_id for d in deps}
    return {
        nid: (_collect_leaves(nid, children_map) if nid in summary_ids else [nid])
        for nid in endpoint_ids
    }


def _check_expansion_bound(deps: list[Dependency], leaves: dict[str, list[str]]) -> None:
    """Bound the cross product from leaf *counts* before materialising a Dependency (#1208).

    A summary→summary edge fans out to ``len(L(pred)) * len(L(succ))`` objects, so
    without this a wide top-of-WBS edge produces millions of Dependency objects (and a
    graph that then chokes ``schedule()``). The cheap cycle-check path already enforced
    ``MAX_EXPANDED_EDGES`` this way; the expensive real-expansion path was the one
    missing the guard.
    """
    estimated = 0
    for dep in deps:
        estimated += len(leaves[dep.predecessor_id]) * len(leaves[dep.successor_id])
        if estimated > MAX_EXPANDED_EDGES:
            raise InvalidScheduleInput(
                f"Expanding summary dependencies to leaf level would exceed "
                f"{MAX_EXPANDED_EDGES:,} edges. A summary→summary dependency is fanning "
                "out to the cross product of both summaries' leaves — depend on specific "
                "leaf tasks, or split the wide summary edge, and retry."
            )


def _reject_overlapping_links(deps: list[Dependency], leaves: dict[str, list[str]]) -> None:
    """Refuse a link whose endpoints share a leaf, naming the source link (#4705, #4538).

    Expanding such a link puts a self-loop on the shared leaf. The cycle-check twin
    (:func:`_expand_edges_for_cycle_check`) keeps that self-loop because it *is* the
    cycle, so :func:`find_cycle` reports it. This path used to skip it as a harmless
    self-reference, which turned the same input into one of three wrong answers: the
    link vanished (any single-leaf case, and ``S -> S``), the remaining leaf pairs
    survived as an invented sibling order (``S{a, b} -FS-> a`` became ``b -> a``), or
    ``schedule()`` later raised a cycle through two leaves the user never linked.

    Shared leaves are exactly the overlap the cycle check sees: an id linked to
    itself, an ancestor and its descendant in either direction (a descendant's
    leaves are a non-empty subset of its ancestor's, since empty child lists are
    refused), and two summaries holding a common leaf through a diamond. The check
    runs after :func:`_check_expansion_bound`, so the per-link set work is bounded by
    the same cap.
    """
    leaf_sets: dict[str, set[str]] = {}
    for dep in deps:
        pred, succ = dep.predecessor_id, dep.successor_id
        if pred == succ:
            raise CyclicDependencyError([pred, pred])
        pred_leaves = leaf_sets.setdefault(pred, set(leaves[pred]))
        if any(leaf in pred_leaves for leaf in leaves[succ]):
            raise CyclicDependencyError([pred, succ, pred])


def _cross_product_edges(deps: list[Dependency], leaves: dict[str, list[str]]) -> list[Dependency]:
    """Fan each edge out to the cross product of its endpoints' leaves.

    No edge can expand onto a self-loop: :func:`_reject_overlapping_links` has
    already refused every link whose endpoints share a leaf.

    Two source links can expand onto the same leaf pair — ``A -FS-> C`` plus
    ``S(A, B) -FS+7d-> C`` both yield ``A → C``. The engine graph holds one edge per
    pair, so the collision must be resolved, and it must be resolved by *meaning*,
    never by list order (#4434): the API passes DB row order, so "first seen wins"
    let two recalcs of one project produce different finishes and silently dropped
    the binding summary link whenever the leaf link happened to come first.

    - **Same dep type:** both constraints read ``succ_X >= pred_Y + lag`` on the same
      anchors, so the larger lag implies the smaller one. Keep the largest lag — the
      merged edge is exactly the conjunction of both links.
    - **Different dep types:** the two constrain different anchors and neither
      implies the other, so no single edge can represent both. Reject with
      :class:`InvalidScheduleInput` naming both source links rather than silently
      dropping one.

    The surviving edge keeps the position of the pair's first occurrence, so the
    output order is stable for a given input while its *content* is order-independent.
    """
    chosen: dict[tuple[str, str], tuple[Dependency, Dependency]] = {}

    for dep in deps:
        for p in leaves[dep.predecessor_id]:
            for s in leaves[dep.successor_id]:
                prior = chosen.get((p, s))
                if prior is not None:
                    _, prior_source = prior
                    if prior_source.dep_type != dep.dep_type:
                        raise InvalidScheduleInput(
                            f"Dependencies {_describe_link(prior_source)} and "
                            f"{_describe_link(dep)} both resolve to leaf link {_short_repr(p)} → "
                            f"{_short_repr(s)} with different types ({prior_source.dep_type.value} "
                            f"vs "
                            f"{dep.dep_type.value}); a task pair can hold only one "
                            "dependency type. Remove one link or change its type to match."
                        )
                    if dep.lag <= prior_source.lag:
                        continue
                    # A dict update keeps the key's original insertion position.
                chosen[(p, s)] = (
                    Dependency(
                        predecessor_id=p, successor_id=s, dep_type=dep.dep_type, lag=dep.lag
                    ),
                    dep,
                )

    return [edge for edge, _ in chosen.values()]
