"""Summary-task dependency expansion onto leaf tasks."""

from __future__ import annotations

from collections.abc import (
    Iterable,
    Iterator,
)
from dataclasses import (
    dataclass,
)
from typing import (
    Any,
)

from trueppm_scheduler._slots import pickle_as_field_dict
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


@pickle_as_field_dict
@dataclass(slots=True)
class SummaryExpansion:
    """Result of expanding summary-task dependencies (see :func:`expand_summary_dependencies`).

    Wraps the ``(tasks, dependencies)`` pair so this public, ``__all__``-exported
    helper can grow fields without breaking the pip contract (#1325). Iterable for
    backward compatibility — ``leaf_tasks, deps = expand_summary_dependencies(...)``
    still unpacks — while ``.tasks`` / ``.dependencies`` are the named accessors.

    Attributes:
        tasks: Input tasks with summary tasks removed (only leaves remain).
        dependencies: Dependencies fanned out to leaf-level edges, deduplicated.
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
    _reject_children_cycle(children_map)


def _reject_children_cycle(children_map: dict[str, list[str]]) -> None:
    """Refuse a parent-child cycle anywhere in ``children_map`` (#5018).

    The cycle used to be found only lazily, inside the leaf walk of a summary that
    some dependency happened to name, so the same malformed map was accepted — and
    its tasks silently dropped from the result — whenever no link touched the
    cycle. One iterative three-colour DFS over the whole map makes the verdict a
    property of the map alone, independent of the links. Iterative so a map nested
    deeper than Python's recursion limit still raises cleanly.
    """
    visiting, done = 1, 2
    state: dict[str, int] = {}
    for root in children_map:
        if root in state:
            continue
        state[root] = visiting
        stack: list[tuple[str, Iterator[str]]] = [(root, iter(children_map[root]))]
        while stack:
            node, kids = stack[-1]
            for child_id in kids:
                if child_id not in children_map:
                    continue  # a leaf cannot close a cycle
                mark = state.get(child_id)
                if mark == visiting:
                    raise InvalidScheduleInput(
                        f"children_map contains a cycle through task {_short_repr(child_id)}."
                    )
                if mark is None:
                    state[child_id] = visiting
                    stack.append((child_id, iter(children_map[child_id])))
                    break
            else:
                state[node] = done
                stack.pop()


def _check_children_exist(tasks: list[Task], children_map: dict[str, list[str]]) -> None:
    """Reject a ``children_map`` child id that names no task (#4100).

    Without this an unknown child ``Z`` expands to an edge ``Z -> X`` that
    ``schedule()`` later refuses as "Dependency references unknown task", naming an
    edge the caller never wrote. Skipped when ``tasks`` is empty: callers such as
    the API's structure-only graph guard expand edges against a ``children_map``
    alone, with no task list to check against.
    """
    if not tasks:
        return
    known = {t.id for t in tasks}
    for sid, kids in children_map.items():
        for child_id in kids:
            if child_id not in known:
                raise InvalidScheduleInput(
                    f"children_map[{_short_repr(sid)}] lists child {_short_repr(child_id)}, "
                    "which is not a task id."
                )


def collect_leaves(
    task_id: str,
    children_map: dict[str, list[str]],
) -> list[str]:
    """Collect the distinct leaf task IDs under a summary task, in first-visit order.

    Public API since 0.5 (#4158). ``_collect_leaves`` remains as an alias for one
    release.

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

    Args:
        task_id: The task whose leaf descendants are collected. A task with no
            entry (or an empty entry) in ``children_map`` is its own only leaf.
        children_map: Mapping of summary task ID to its direct child IDs.

    Returns:
        The distinct leaf task IDs, in first-visit (declared) order.

    Raises:
        InvalidScheduleInput: ``children_map`` contains a parent-child cycle
            reachable from ``task_id``, or the subtree fans out to more than
            ``MAX_EXPANDED_EDGES`` root-to-leaf paths.
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


# Deprecated alias, kept for one release (#4158): trueppm-api <= 0.4 imports it.
_collect_leaves = collect_leaves


def _path_counts(
    roots: set[str],
    children_map: dict[str, list[str]],
) -> dict[str, int]:
    """Count root-to-leaf paths below every node reachable from ``roots``, once (#5014).

    One memoized post-order pass shared by every endpoint, so the cost is
    O(reachable nodes + edges) however many endpoints there are and however deep
    the nesting — a per-endpoint walk that materialized each leaf list was
    quadratic in depth, and did that work *before* the edge bound could refuse the
    input. For a forest the path count equals the distinct-leaf count; for a diamond
    it is an upper bound on it, which is the safe direction for a cap. ``children_map``
    must already be cycle-free (:func:`_check_children_map`).

    A node whose own path count passes ``MAX_EXPANDED_EDGES`` raises the same error
    :func:`collect_leaves` does (#1822), so a doubling map is refused here in O(1) per
    node. Counting per root-to-leaf path, not per distinct leaf, is the pre-existing
    #1822 semantics of :func:`collect_leaves`, kept here unchanged.

    Returns:
        Path count per node, leaves (nodes absent from ``children_map``) counting 1.
    """
    counts: dict[str, int] = {}
    for root in roots:
        if root in counts:
            continue
        stack: list[tuple[str, bool]] = [(root, False)]
        while stack:
            node, is_exit = stack.pop()
            if is_exit:
                total = sum(counts[c] for c in children_map[node])
                if total > MAX_EXPANDED_EDGES:
                    raise InvalidScheduleInput(
                        f"Expanding summary dependencies would exceed {MAX_EXPANDED_EDGES:,} "
                        "leaf-level edges: a summary task fans out to that many root-to-leaf "
                        "paths (typically a summary→summary dependency crossing a deep or "
                        "wide WBS). Depend on specific leaf tasks, or split the summary edge."
                    )
                counts[node] = total
                continue
            if node in counts:
                continue
            kids = children_map.get(node)
            if not kids:
                counts[node] = 1
                continue
            stack.append((node, True))
            stack.extend((c, False) for c in kids if c not in counts)
    return counts


def _check_expansion_bound(deps: list[Dependency], counts: dict[str, int]) -> None:
    """Refuse an expansion whose leaf-count cross products pass ``MAX_EXPANDED_EDGES``.

    Takes path counts, not leaf lists (#1208, #5014), so nothing is materialized
    before the refusal. The sum is an upper bound on the distinct edges.
    """
    if _expansion_exceeds_bound(((d.predecessor_id, d.successor_id) for d in deps), counts):
        raise InvalidScheduleInput(
            f"Expanding summary dependencies to leaf level would exceed "
            f"{MAX_EXPANDED_EDGES:,} edges (an upper bound: links that expand onto the "
            "same leaf pair are counted separately). A summary→summary dependency is "
            "fanning out to the cross product of both summaries' leaves — depend on "
            "specific leaf tasks, or split the wide summary edge, and retry."
        )


def _expansion_exceeds_bound(
    pairs: Iterable[tuple[str, str]],
    counts: dict[str, int],
) -> bool:
    """Whether the summed leaf-count cross products pass ``MAX_EXPANDED_EDGES``.

    Computed from counts alone, before any leaf list exists. The sum is an upper
    bound on the distinct edges: it counts a pair twice when two links expand onto it
    (#5014), which is the safe direction for a cap.
    """
    estimated = 0
    for pred_id, succ_id in pairs:
        estimated += counts.get(pred_id, 1) * counts.get(succ_id, 1)
        if estimated > MAX_EXPANDED_EDGES:
            return True
    return False


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
    :class:`InvalidScheduleInput` (#4434). Two links the caller wrote on the same
    pair of plain tasks are refused, not merged (#5019).

    Args:
        tasks: All tasks including summaries.
        deps: Dependencies that may reference summary tasks.
        children_map: Mapping of summary task ID to list of direct child IDs.

    Returns:
        A :class:`SummaryExpansion` whose ``tasks`` are the input tasks with
        summaries removed and whose ``dependencies`` are expanded to leaf-level
        edges. Unpacks as ``leaf_tasks, expanded_deps`` for backward compatibility.

    A task listed under more than one parent (a diamond ``children_map``) is
    deliberately accepted: its leaves are expanded once and it is not a cycle. The
    API builds its map from ``wbs_path`` and so never produces one; the library
    does not enforce a strict tree.

    Raises:
        InvalidScheduleInput: Raised for each of these causes:

            * ``children_map`` is not a dict, or a summary id (key) or child id
              is not a string (``None`` and other non-string ids are refused,
              #4522).
            * A ``children_map`` value is not a list.
            * A summary has an empty children list.
            * A child id in ``children_map`` names no task in ``tasks`` (checked
              when ``tasks`` is non-empty; the error names the ``children_map``
              entry, not a synthesized edge).
            * ``children_map`` contains a parent-child cycle (including a task
              listed as its own child), wherever in the map it sits and whether
              or not any link touches it (#5018).
            * A Start-to-Start or Start-to-Finish link from a summary task
              (ADR-0370), checked before the shared-leaf rule below, so an SS/SF
              link from a summary to its own descendant raises this rather than
              ``CyclicDependencyError``.
            * Two links between the same pair of plain (non-summary) tasks, whether
              or not ``children_map`` is empty (#5019); the message matches
              ``schedule()``'s "Duplicate dependency".
            * Two links that expand onto the same leaf pair carry different
              dependency types (#4434).
            * The leaf cross product would exceed ``MAX_EXPANDED_EDGES``
              (checked per endpoint and across the whole expansion).
        CyclicDependencyError: If a link's endpoints share a leaf (see above).
            ``cycle`` names the *source* link, not the leaves it expands to:
            ``[pred, succ, pred]``, or ``[pred, pred]`` when both endpoints are
            the same id.
    """
    summary_ids = set(children_map) if isinstance(children_map, dict) else set()
    # Leaf-to-leaf duplicates are a user error whether or not the WBS has a summary
    # (#5019): schedule() refuses them, so the verdict must not hinge on children_map.
    _reject_duplicate_leaf_links(deps, summary_ids)
    if not children_map:
        # Fresh containers, never the caller's own list objects.
        return SummaryExpansion(tasks=list(tasks), dependencies=list(deps))
    _check_children_map(children_map)
    _check_children_exist(tasks, children_map)

    leaf_tasks = [t for t in tasks if t.id not in summary_ids]

    _reject_summary_start_links(deps, summary_ids)

    leaves = _resolve_endpoint_leaves(deps, summary_ids, children_map)
    _reject_overlapping_links(deps, leaves)

    return SummaryExpansion(tasks=leaf_tasks, dependencies=_cross_product_edges(deps, leaves))


def _reject_duplicate_leaf_links(deps: list[Dependency], summary_ids: set[str]) -> None:
    """Refuse two links on one leaf-to-leaf pair, as ``schedule()`` does (#5019).

    Only links that expand from a summary merge by meaning (see
    :func:`_cross_product_edges`); two links the caller wrote on the same pair of
    plain tasks are a mistake the engine rejects everywhere else, so a populated
    ``children_map`` must not turn it into a silent max-lag merge.
    """
    seen: set[tuple[str, str]] = set()
    for dep in deps:
        if dep.predecessor_id in summary_ids or dep.successor_id in summary_ids:
            continue
        key = (dep.predecessor_id, dep.successor_id)
        if key in seen:
            raise InvalidScheduleInput(
                f"Duplicate dependency {_short_repr(dep.predecessor_id)} → "
                f"{_short_repr(dep.successor_id)}; "
                "each task pair may carry at most one dependency (declare a single "
                "relationship per predecessor/successor pair)."
            )
        seen.add(key)


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
    """Bound the expansion from counts, then resolve each endpoint to its leaves (#1208, #5014).

    The bound is applied on shared path counts *before* any leaf list is built, so a
    pathological ``children_map`` is refused without the per-endpoint walk and
    materialization that made refusal itself quadratic in nesting depth. An endpoint
    id recurs across many edges, so leaves are then resolved per distinct id rather
    than per edge.
    """
    endpoint_ids = {d.predecessor_id for d in deps} | {d.successor_id for d in deps}
    counts = _path_counts(endpoint_ids & summary_ids, children_map)
    _check_expansion_bound(deps, counts)
    return {
        nid: (_collect_leaves(nid, children_map) if nid in summary_ids else [nid])
        for nid in endpoint_ids
    }


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
