"""Board lane assignment, server-side (#2953, ADR-0843).

The case 16 rendering rule shipped in the browser first
(``packages/web/src/features/board/laneAssignment.ts``) because it needed no
field and no migration. That was the right first move and the wrong resting
place: it left the board's grouping as **web logic no other client can reach**,
which is the #986 API-first gap. An MCP client, an agent, or anyone's
integration cannot reproduce the board a human is looking at.

This is that rule as a server fact. The three invariants are identical, and
deliberately so — two answers to one question is worse than the gap:

1. **A container is never a card.** A row with structural children is a lane,
   never a work item in a column, at any depth.
2. **Every task appears exactly once**, in the lane of its top-level container
   ancestor. Containers nested below that lane travel on the card as a crumb.
3. **Root-level work belongs to the project node**, whose lane carries the
   project's name and is absent when it holds nothing.

``group_depth`` defaults to 1. It exists as a parameter so a client can ask for
something else; no UI exposes it, because the depth distribution measured on
2026-08-18 put 94.9% of leaf rows at depth <= 2 with no crumb at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Task

#: Sentinel lane id for work hanging directly off the project node.
ROOT_LANE_ID = "root"


@dataclass
class Lane:
    """One board swimlane: a real container, or the project node."""

    id: str
    name: str
    #: True for the project-node lane — says *which* object it is, not that it lacks one.
    is_root: bool = False
    task_ids: list[str] = field(default_factory=list)


def _wbs_parts(task: Task) -> list[str]:
    return str(task.wbs_path).split(".") if task.wbs_path else []


def build_lanes(
    tasks: list[Task],
    *,
    project_name: str,
    group_depth: int = 1,
) -> tuple[list[Lane], dict[str, str]]:
    """Group ``tasks`` into lanes, and say which crumb each card carries.

    Returns ``(lanes, crumb_by_task_id)``. A task absent from the crumb map sits
    directly in its lane, which is the overwhelming majority.

    Parenthood is the ltree ``wbs_path`` — there is no ``parent_id`` column — so
    a lane at ``group_depth=1`` is the first path segment, and the crumb names
    the row's immediate parent when that parent is not the lane itself.
    """
    by_path: dict[str, Task] = {
        str(t.wbs_path): t for t in tasks if t.wbs_path and not t.is_subtask
    }
    # A row is a container iff something else sits beneath it. Derived, exactly
    # as `task_is_phase` derives it — this must not diverge from the rollup's
    # notion of a phase (ADR-0844: the derived fact wins for the math).
    container_paths: set[str] = set()
    for path in by_path:
        parts = path.split(".")
        for i in range(1, len(parts)):
            container_paths.add(".".join(parts[:i]))

    lanes: dict[str, Lane] = {}
    order: list[str] = []
    crumbs: dict[str, str] = {}
    root_lane = Lane(id=ROOT_LANE_ID, name=project_name, is_root=True)

    for path, task in sorted(by_path.items(), key=lambda kv: _sort_key(kv[0])):
        if path in container_paths:
            continue  # invariant 1 — a container is never a card

        parts = path.split(".")
        if len(parts) <= group_depth:
            root_lane.task_ids.append(str(task.id))
            continue

        lane_path = ".".join(parts[:group_depth])
        head = by_path.get(lane_path)
        if head is None:
            # A gap in the tree (a deleted ancestor) must not drop the card.
            root_lane.task_ids.append(str(task.id))
            continue
        if lane_path not in lanes:
            lanes[lane_path] = Lane(id=str(head.id), name=head.name)
            order.append(lane_path)
        lanes[lane_path].task_ids.append(str(task.id))

        # The crumb names the row's own parent when the lane cannot show it.
        parent_path = ".".join(parts[:-1])
        if parent_path != lane_path:
            parent = by_path.get(parent_path)
            if parent is not None:
                crumbs[str(task.id)] = parent.name

    out = [lanes[p] for p in order]
    # Invariant 3: the project-node lane is absent when it holds nothing.
    if root_lane.task_ids:
        out.append(root_lane)
    return out, crumbs


def _sort_key(path: str) -> tuple[int, ...]:
    """Numeric WBS ordering — ``1.10`` sorts after ``1.9``, not between 1 and 2."""
    try:
        return tuple(int(p) for p in path.split("."))
    except ValueError:
        return (0,)
