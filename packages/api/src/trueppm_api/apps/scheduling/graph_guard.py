"""Reusable dependency-graph validation for bulk / agent-authored task writes.

The human write path (``DependencySerializer._check_no_cycle``) runs
self-reference and cycle detection on every single proposed edge before it is
persisted. Bulk and agent write paths — the MS Project importer, the offline
Jira importer (#1664), and any future non-interactive writer — build whole
``Dependency`` graphs with ``bulk_create`` and therefore **bypass** that gate
entirely.

That gap is benign only while no bulk writer accepts an untrusted graph. The
moment a prospect's messy Jira export can be imported (#1664), a cyclic or
self-referential link would persist an infeasible dependency network that then
crashes the CPM / what-if engine on the imported data. The differentiator's
whole claim is that human and agent principals are governed identically; a
validation gate that only the human path enforces violates "hybrid by
construction."

This module is the shared gate. It wraps the *same* ``trueppm_scheduler``
``find_cycle`` algorithm the serializer uses — so the human and agent paths
detect the identical set of cycles — plus the trivial self-reference identity
check. Callers pass the *complete* edge set they are about to persist (they
already hold it in memory, so no DB round-trip is needed) and run this guard
**before** the write and before ``enqueue_recalculate``.

The guard operates on opaque string node ids, so callers may validate in their
own external-id space (Jira issue keys, MS Project uids) *before* creating any
row — the cycle/self-reference structure is invariant under relabeling, so a bad
graph is rejected before a single task is written.
"""

from __future__ import annotations

from trueppm_scheduler import find_cycle


class InfeasibleGraphError(Exception):
    """A proposed task-dependency graph cannot be persisted.

    Deliberately not a DRF ``ValidationError``: this is a domain signal raised
    from service / importer code that has no request context. Callers translate
    it to whatever their surface needs — an importer marks its outbox row DEAD
    and records the reason on the TaskRunTracker; a view would map it to a 400.

    Attributes:
        reason: A stable machine code — ``"self_reference"`` or
            ``"cyclic_dependency"`` — so callers can branch (quarantine a
            self-loop vs. reject a whole import) without string-matching the
            message.
        offending: The node ids implicated. For ``"self_reference"`` the single
            offending node; for ``"cyclic_dependency"`` the ordered cycle path
            (first id repeated at the end, e.g. ``["A", "B", "A"]``), matching
            :func:`trueppm_scheduler.find_cycle`.
    """

    def __init__(self, reason: str, offending: list[str]) -> None:
        self.reason = reason
        self.offending = offending
        super().__init__(f"Infeasible task graph ({reason}): {offending}")


def validate_task_graph(
    edges: list[tuple[str, str]],
    *,
    children_map: dict[str, list[str]] | None = None,
) -> None:
    """Reject a self-referential or cyclic dependency graph before it is written.

    Runs the same self-reference and :func:`trueppm_scheduler.find_cycle` checks
    the interactive ``DependencySerializer`` path runs, so bulk / agent writers
    are governed identically to the human write path.

    Args:
        edges: The complete ``(predecessor_id, successor_id)`` set the caller is
            about to persist, as opaque string node ids. Callers that want to
            validate before minting DB rows may pass their external-id space
            (e.g. Jira issue keys) — cycle/self-reference detection is invariant
            under relabeling.
        children_map: Optional ``{summary_id: [child_id, ...]}`` mapping so that
            summary→leaf logical cycles are expanded and caught, matching the
            serializer's summary handling. Omit (``None``) for flat graphs with
            no summary tasks (the minimal-import case), where direct edge cycle
            detection is sufficient.

    Raises:
        InfeasibleGraphError: With ``reason="self_reference"`` if any edge links
            a task to itself, or ``reason="cyclic_dependency"`` if the graph
            contains a cycle. The message and ``offending`` path let the caller
            surface an actionable error rather than crash the CPM engine.
        InvalidScheduleInput: Re-raised unchanged if the graph is *malformed*
            (a pathological summary fan-out beyond the engine's cap, or a
            children_map that is itself cyclic) — a distinct failure from a
            cycle in the edges. Callers treat it the same as a rejection.
    """
    # Self-reference is a cheap identity check that also gives the caller a
    # precise offending node (find_cycle would report it as a length-1 loop,
    # but a dedicated code lets importers *quarantine* a self-loop — skip it
    # with a warning — rather than reject the whole import).
    for predecessor, successor in edges:
        if predecessor == successor:
            raise InfeasibleGraphError("self_reference", [predecessor])

    result = find_cycle(edges, children_map=children_map)
    if result.cycle is not None:
        raise InfeasibleGraphError("cyclic_dependency", result.cycle)
