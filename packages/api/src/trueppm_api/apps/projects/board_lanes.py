"""Board lane assignment, server-side (#2953, ADR-0843).

The case 16 rendering rule renders in the browser
(``packages/web/src/features/board/laneAssignment.ts``). This is the same rule
as a server derivation, used as the **oracle for ADR-0843 invariant 1**: the
structure-declaration suites assert that a row promoted to a container by
indent, or created as one by import, groups here as a lane and never as a card.
The three invariants are identical to the browser's, and deliberately so — two
answers to one question is worse than one answer stated twice:

1. **A container is never a card.** A row with structural children is a lane,
   never a work item in a column, at any depth.
2. **Every task appears exactly once**, in the lane of its top-level container
   ancestor. Containers nested below that lane travel on the card as a crumb.
3. **Root-level work belongs to the project node**, whose lane carries the
   project's name and is absent when it holds nothing.

``group_depth`` defaults to 1 and is a parameter so a caller can cut lanes
deeper; the depth distribution measured on 2026-08-18 put 94.9% of leaf rows at
depth <= 2 with no crumb at all, so nothing asks for anything else today.
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


def _container_paths(by_path: dict[str, Task]) -> set[str]:
    """Every path with something beneath it.

    A row is a container iff something else sits beneath it. Derived, exactly as
    ``task_is_phase`` derives it — this must not diverge from the rollup's notion of a
    phase (ADR-0844: the derived fact wins for the math).
    """
    container_paths: set[str] = set()
    for path in by_path:
        parts = path.split(".")
        for i in range(1, len(parts)):
            container_paths.add(".".join(parts[:i]))
    return container_paths


def _crumb_for(parts: list[str], lane_path: str, by_path: dict[str, Task]) -> str | None:
    """The row's own parent name when the lane cannot show it, else ``None``."""
    parent_path = ".".join(parts[:-1])
    if parent_path != lane_path:
        parent = by_path.get(parent_path)
        if parent is not None:
            return parent.name
    return None


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
    container_paths = _container_paths(by_path)

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

        crumb = _crumb_for(parts, lane_path, by_path)
        if crumb is not None:
            crumbs[str(task.id)] = crumb

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
