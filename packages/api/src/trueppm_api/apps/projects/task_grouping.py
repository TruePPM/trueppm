"""Transactional Group / Ungroup primitives for the schedule outline (#2955).

Group is ``create container`` + ``reparent N rows``; ungroup is its mirror. Both are
composable client-side out of the existing single-row ``reparent`` endpoint, and
composing them that way is the defect already filed as #2914: N+1 un-transacted calls
whose partial failure leaves a half-made phase with some rows moved and some not, and
no way to reverse it. The design requires each operation to be **one undo step**, so
each is one request that either applies whole or writes nothing.

Two invariants this module exists to hold that the naive composition cannot:

1. **Nothing is written on a rejection.** Every guard raises :class:`GroupingRejected`
   *out* of the caller's ``atomic()`` block rather than returning a response from
   inside it, so the rollback is the transaction's, not a hand-rolled compensation.
   That includes the ADR-0259 graph guard, which runs over the tree the operation
   *would* leave behind. See :func:`assert_graph_feasible` for why that guard is a
   tripwire rather than a gate — and why its verdict is differential.

2. **A level's subtree survives its renumbering.** Removing a row from the middle of
   a WBS level shifts every later sibling's number, and a sibling's descendants carry
   that number as a path *prefix*. :func:`rewrite_level` therefore snapshots the whole
   affected subtree into memory before the first write and computes every new path
   from that snapshot — a sibling shifting into a position another sibling still
   occupies cannot corrupt the prefix match that moves its children.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from django.db.models import Q

from trueppm_api.apps.projects.models import StructuralOperationKind
from trueppm_api.apps.projects.structural_operation_services import StructuralCapture

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Project, Task


#: Placeholder name for a freshly wrapped phase. The design names the phase *last* —
#: the user selects rows, wraps them, and the UI focuses the name field — so the
#: container is minted with a placeholder rather than demanding a name up front.
DEFAULT_CONTAINER_NAME = "New phase"

#: Upper bound on one selection. Not a performance ceiling so much as a blast-radius
#: one: past this size the caller is restructuring the plan, not wrapping a phase, and
#: a mis-clicked ⌘A should not silently rewrite every path in the project.
MAX_GROUP_SELECTION = 500

#: Why a selected row was not wrapped. Both are reported to the caller — the UI has to
#: tell the user which rows it left alone, or a group that quietly dropped half the
#: selection reads as a bug.
REASON_ANCESTOR_SELECTED = "ancestor_selected"
REASON_DIFFERENT_PARENT = "different_parent"


class GroupingRejected(Exception):
    """A group/ungroup request the server refuses, carrying its 4xx body.

    Raised rather than returned so that it unwinds the caller's ``transaction.atomic()``
    block: a guard that fires after some rows have already moved must leave nothing
    behind, and the transaction is the only mechanism that guarantees that without a
    hand-written inverse for every partial state.
    """

    def __init__(
        self,
        code: str,
        detail: str,
        *,
        status_code: int = 400,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code
        self.body: dict[str, Any] = {"code": code, "detail": detail}
        if extra:
            self.body.update(extra)


@dataclass(frozen=True)
class LeftAlone:
    """One selected row the operation deliberately did not wrap."""

    task_id: str
    reason: str
    ancestor_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.task_id, "reason": self.reason, "ancestor_id": self.ancestor_id}


@dataclass(frozen=True)
class Selection:
    """The outcome of applying the design's selection rules to a raw ``task_ids``."""

    kept: list[Task]
    left_alone: list[LeftAlone]
    parent_path: str


# ── Selection ───────────────────────────────────────────────────────────────────


def resolve_selection(selected: list[Task]) -> Selection:
    """Reduce a raw multi-select to the rows one container can actually wrap.

    Two rules, in order, both from the design:

    1. **Drop any row whose own ancestor is also selected.** You cannot wrap a phase
       together with the work inside it — the work is already inside the phase, and
       moving both would either duplicate the subtree or flatten it. The *nearest*
       selected ancestor is reported so the UI can say which phase covered the row.
    2. **Group on the parent shared by most of the remainder.** A selection spanning
       levels is a normal consequence of shift-clicking down a tree, not a mistake to
       reject; the majority parent is the one the user was working in. Ties break
       toward the parent of the first row in *request* order, which is the row the
       selection started from.

    ``selected`` must be in request order — the tie-break depends on it.
    """
    paths = {str(t.pk): str(t.wbs_path) for t in selected}

    left_alone: list[LeftAlone] = []
    remainder: list[Task] = []
    for task in selected:
        own = paths[str(task.pk)]
        # Nearest selected ancestor = the longest selected path that is a strict
        # prefix of this row's path. Longest wins so the reported ancestor is the
        # phase the row is actually inside, not its grandparent.
        ancestors = [
            other_id
            for other_id, other_path in paths.items()
            if other_id != str(task.pk) and own.startswith(f"{other_path}.")
        ]
        if ancestors:
            nearest = max(ancestors, key=lambda oid: len(paths[oid]))
            left_alone.append(
                LeftAlone(str(task.pk), REASON_ANCESTOR_SELECTED, ancestor_id=nearest)
            )
            continue
        remainder.append(task)

    if not remainder:
        # Only reachable when every row was covered by another selected row, which
        # means the caller selected a phase and its contents and nothing else.
        raise GroupingRejected(
            "nothing_to_group",
            "Every selected row sits inside another selected row, so there is nothing to wrap.",
            extra={"left_alone": [entry.as_dict() for entry in left_alone]},
        )

    parent_of = {str(t.pk): parent_path_of(str(t.wbs_path)) for t in remainder}
    counts: dict[str, int] = {}
    for task in remainder:
        counts[parent_of[str(task.pk)]] = counts.get(parent_of[str(task.pk)], 0) + 1
    best = max(counts.values())
    # Tie-break on request order: the first row in the request whose parent is tied
    # for the majority. `remainder` preserves request order, so the first hit wins.
    chosen = next(parent_of[str(t.pk)] for t in remainder if counts[parent_of[str(t.pk)]] == best)

    kept: list[Task] = []
    for task in remainder:
        if parent_of[str(task.pk)] == chosen:
            kept.append(task)
        else:
            left_alone.append(LeftAlone(str(task.pk), REASON_DIFFERENT_PARENT))

    return Selection(kept=kept, left_alone=left_alone, parent_path=chosen)


def parent_path_of(wbs_path: str) -> str:
    """The parent's ``wbs_path``, or ``""`` for a root-level row."""
    parent, _, _ = wbs_path.rpartition(".")
    return parent


# ── WBS rewriting ───────────────────────────────────────────────────────────────


def _subtree_snapshot(project_id: Any, roots: list[Task]) -> dict[str, list[Task]]:
    """Load every live descendant of ``roots``, bucketed by the root it sits under.

    One query for the whole set, and taken **before** any write in the operation, for
    the reason in the module docstring: once the first path is rewritten, a prefix
    match against the database no longer describes the tree the caller started from.
    """
    from trueppm_api.apps.projects.models import Task as TaskModel

    if not roots:
        return {}
    predicate = Q()
    for root in roots:
        predicate |= Q(wbs_path__startswith=f"{root.wbs_path}.")
    rows = list(
        TaskModel.objects.select_for_update()
        .filter(project_id=project_id, is_deleted=False)
        .filter(predicate)
        .order_by("wbs_path")
    )
    buckets: dict[str, list[Task]] = {str(root.wbs_path): [] for root in roots}
    for row in rows:
        # Longest matching prefix, so a descendant is filed under its nearest
        # snapshotted root rather than an outer one when roots nest.
        owner = max(
            (p for p in buckets if str(row.wbs_path).startswith(f"{p}.")),
            key=len,
            default=None,
        )
        if owner is not None:
            buckets[owner].append(row)
    return buckets


def _move_root(
    root: Task, descendants: list[Task], new_path: str, updated: list[dict[str, str]]
) -> None:
    """Move one row and its snapshotted subtree to ``new_path``, recording the changes."""
    old_path = str(root.wbs_path)
    if old_path != new_path:
        root.wbs_path = new_path
        root.save(update_fields=["wbs_path"])
    updated.append({"id": str(root.pk), "wbs_path": new_path})
    for descendant in descendants:
        rewritten = new_path + str(descendant.wbs_path)[len(old_path) :]
        if str(descendant.wbs_path) != rewritten:
            descendant.wbs_path = rewritten
            descendant.save(update_fields=["wbs_path"])
        updated.append({"id": str(descendant.pk), "wbs_path": rewritten})


def rewrite_level(project_id: Any, parent_path: str, ordered: list[Task]) -> list[dict[str, str]]:
    """Renumber a whole WBS level to ``ordered``, carrying every subtree with it.

    The counterpart to ``views._renumber_siblings``, which rewrites sibling paths only.
    That is sufficient where the caller has already handled descendants separately, and
    silently wrong here: group and ungroup both *insert into* and *remove from* the
    middle of a level, so later siblings shift and their children must shift with them.
    """
    from trueppm_api.apps.projects.views import _build_wbs_path

    snapshot = _subtree_snapshot(project_id, ordered)
    updated: list[dict[str, str]] = []
    for position, task in enumerate(ordered, start=1):
        _move_root(
            task,
            snapshot.get(str(task.wbs_path), []),
            _build_wbs_path(parent_path, position),
            updated,
        )
    return updated


def staging_base(siblings: list[Task]) -> int:
    """The first level position guaranteed not to collide with an existing sibling.

    ``len(siblings) + 1`` is the obvious answer and is wrong: a level is not necessarily
    numbered contiguously (a delete leaves ``1, 3``, and ``len + 1 == 3`` collides with
    a live row). Both operations stage rows at out-of-range positions before the level
    is renumbered, so the slot has to be free against the *actual* labels, not the count.
    """
    highest = 0
    for sibling in siblings:
        _, _, label = str(sibling.wbs_path).rpartition(".")
        if label.isdigit():
            highest = max(highest, int(label))
    return highest + 1


def _park_level(project_id: Any, parent_path: str, rows: list[Task], base: int) -> None:
    """Move ``rows`` to reserved, out-of-range positions at ``parent_path``.

    Both operations need to hold rows *somewhere* at the destination level while the
    level is renumbered around them. Parking them past the level's highest live label
    keeps every intermediate path collision-free without needing a second numbering
    scheme — ``rewrite_level`` then assigns their real positions in the same pass as
    everyone else's.
    """
    from trueppm_api.apps.projects.views import _build_wbs_path

    snapshot = _subtree_snapshot(project_id, rows)
    sink: list[dict[str, str]] = []
    for offset, row in enumerate(rows):
        _move_root(
            row,
            snapshot.get(str(row.wbs_path), []),
            _build_wbs_path(parent_path, base + offset),
            sink,
        )


# ── Graph guard ─────────────────────────────────────────────────────────────────


#: A project's dependency edges and WBS children-map — the two inputs the ADR-0259
#: guard reads. Captured before a restructure so a verdict on the post-state can be
#: compared against the pre-state rather than blamed on this operation blindly.
GraphState = tuple[list[tuple[str, str]], dict[str, list[str]]]


def capture_graph_state(project_id: Any) -> GraphState:
    """Read the guard's two inputs. Two queries; no cycle detection."""
    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.projects.serializers import _load_project_tasks_and_children_map

    task_ids, children_map = _load_project_tasks_and_children_map(project_id)
    if not task_ids:
        return [], {}
    edges = [
        (str(pred), str(succ))
        for pred, succ in Dependency.objects.filter(
            is_deleted=False, predecessor_id__in=[uuid.UUID(t) for t in task_ids]
        ).values_list("predecessor_id", "successor_id")
    ]
    return edges, children_map


def _verdict(state: GraphState) -> Exception | None:
    """``None`` when this graph is schedulable, else the guard's own exception."""
    from trueppm_scheduler import InvalidScheduleInput

    from trueppm_api.apps.scheduling.graph_guard import (
        InfeasibleGraphError,
        validate_task_graph,
    )

    edges, children_map = state
    if not edges:
        # No edges, no cycle — and no reason to expand a whole project's children_map
        # to prove it. A plan with no dependencies is the common case for the outline
        # this endpoint serves, so the cheap exit is the usual one.
        return None
    try:
        validate_task_graph(edges, children_map=children_map)
    except (InfeasibleGraphError, InvalidScheduleInput) as exc:
        return exc
    return None


def assert_graph_feasible(project_id: Any, before: GraphState) -> None:
    """Run the ADR-0259 graph guard over the tree this operation left behind.

    Called after the restructure is written and before the transaction commits, because
    the thing being validated is the post-move tree. The guard is the same one
    ``tasks/bulk`` runs, applied for the same reason: a write must not hand the CPM
    engine a graph it cannot schedule.

    **The verdict is differential, and that is load-bearing.** A project can already be
    infeasible without this caller's help — the importers validate their own edges but
    a project assembled across several of them can still arrive cyclic — and rejecting
    every subsequent restructure of it would leave the user unable to touch the plan
    they need to restructure in order to *fix* it. So an infeasibility that was already
    there is not this operation's to refuse, exactly as ``tasks/bulk`` terminates rather
    than rejecting its own rows over a pre-existing cycle (ADR-0772 §4). The pre-state
    check runs only when the post-state fails, so the happy path pays two queries and
    one cycle detection rather than two of each.

    **Worth stating plainly: on today's expansion rules this cannot fire.**
    ``find_cycle`` resolves every edge endpoint to its *leaf* descendants, and neither
    operation changes any existing summary's leaf set — group inserts a container
    between a parent and rows that were already under it, so the parent's leaves are
    the same tasks reached one level deeper, and ungroup removes such a container
    again. Neither writes an edge. The guard is retained as a tripwire rather than
    deleted as dead code: it is one detection over a graph the caller has already
    loaded, and the property protecting it ("a restructure preserves every leaf set")
    is exactly the kind that a later change to what a container may carry would break
    silently.
    """
    after = capture_graph_state(project_id)
    failure = _verdict(after)
    if failure is None:
        return
    if _verdict(before) is not None:
        # Already broken when we arrived. Not ours to refuse.
        return

    offending = getattr(failure, "offending", None)
    reason = getattr(failure, "reason", "invalid_graph_input")
    raise GroupingRejected(
        reason,
        "This restructure would make the dependency graph infeasible. No rows were moved.",
        extra={"offending": offending} if offending is not None else None,
    ) from failure


# ── Guards shared by both operations ────────────────────────────────────────────


def load_selection(project: Project, raw_ids: Any) -> list[Task]:
    """Parse and resolve a ``task_ids`` body field into locked, live, in-project rows.

    Order is preserved: :func:`resolve_selection`'s tie-break is defined on request
    order, so the caller must not be handed a set.
    """
    from trueppm_api.apps.projects.models import Task as TaskModel

    if not isinstance(raw_ids, list) or not raw_ids:
        raise GroupingRejected("invalid_task_ids", "`task_ids` must be a non-empty array.")
    if len(raw_ids) > MAX_GROUP_SELECTION:
        raise GroupingRejected(
            "selection_too_large",
            f"A group may wrap at most {MAX_GROUP_SELECTION} rows in one request.",
        )

    parsed: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for raw in raw_ids:
        # str() first: a non-string, non-UUID member (a dict, a list, an int) must be a
        # 400 naming the field, never a 500 out of uuid.UUID's TypeError (#2785/#2795).
        if not isinstance(raw, str):
            raise GroupingRejected("invalid_task_ids", "`task_ids` members must be UUID strings.")
        try:
            parsed_id = uuid.UUID(raw)
        except ValueError as exc:
            raise GroupingRejected(
                "invalid_task_ids", f"`task_ids` contains a value that is not a UUID: {raw!r}."
            ) from exc
        if parsed_id in seen:
            continue  # a duplicated id is the same row, not two rows
        seen.add(parsed_id)
        parsed.append(parsed_id)

    rows = {
        row.pk: row
        for row in TaskModel.objects.select_for_update().filter(
            pk__in=parsed, project_id=project.pk, is_deleted=False
        )
    }
    missing = [str(pid) for pid in parsed if pid not in rows]
    if missing:
        raise GroupingRejected(
            "unknown_task",
            "One or more task ids do not name a live task in this project.",
            status_code=404,
            extra={"unknown": missing},
        )

    ordered = [rows[pid] for pid in parsed]
    if any(row.is_subtask for row in ordered):
        raise GroupingRejected(
            "cannot_group_subtasks",
            (
                "Subtasks belong to their parent task and cannot be wrapped in a phase. "
                "Remove them from the selection."
            ),
        )
    if any(not row.wbs_path for row in ordered):
        raise GroupingRejected(
            "task_without_wbs_path", "A selected task has no WBS path and cannot be moved."
        )
    return ordered


def _require_restructure(request: Request, tasks: list[Task]) -> None:
    """Gate every row the operation will move at field-edit authority (ADR-0133).

    Group and ungroup both rewrite ``wbs_path`` on rows the caller did not name
    individually, so the per-row check is the load-bearing one — the view-level
    permission classes only answer "may this caller author this project's plan at all".
    """
    from trueppm_api.apps.projects.views import _require_wbs_restructure_permission

    for task in tasks:
        _require_wbs_restructure_permission(request, task)


# ── Group ───────────────────────────────────────────────────────────────────────


def perform_group(project: Project, request: Request, raw_ids: Any, name: Any) -> dict[str, Any]:
    """Wrap a selection in a new declared container. Caller supplies ``atomic()``.

    Returns the response body. Raises :class:`GroupingRejected` or ``PermissionDenied``
    on any refusal, both of which unwind the caller's transaction so a rejection after
    a partial move leaves nothing written.
    """
    from trueppm_api.apps.projects.models import StructureRole, sync_structure_shadow_values
    from trueppm_api.apps.projects.views import (
        _build_wbs_path,
        _get_siblings,
    )

    if name is not None and not isinstance(name, str):
        raise GroupingRejected("invalid_name", "`name` must be a string or null.")
    container_name = (name or "").strip() or DEFAULT_CONTAINER_NAME
    if len(container_name) > 512:
        raise GroupingRejected("invalid_name", "`name` must be 512 characters or fewer.")

    selected = load_selection(project, raw_ids)
    selection = resolve_selection(selected)
    _require_restructure(request, selection.kept)

    project_id = str(project.pk)
    graph_before = capture_graph_state(project_id)
    parent_path = selection.parent_path
    capture = StructuralCapture.begin(project.pk, {parent_path})

    parent: Task | None = None
    if parent_path:
        from trueppm_api.apps.projects.models import Task as TaskModel

        parent = (
            TaskModel.objects.select_for_update()
            .filter(project_id=project_id, wbs_path=parent_path, is_deleted=False)
            .first()
        )

    siblings = _get_siblings(project_id, parent_path, lock=True)
    kept_ids = {task.pk for task in selection.kept}
    # Tree order, not request order: the container's contents read top-to-bottom the way
    # the outline already showed them, so wrapping never silently reorders the plan.
    kept_in_tree_order = [s for s in siblings if s.pk in kept_ids]
    remaining = [s for s in siblings if s.pk not in kept_ids]
    first_index = next(i for i, s in enumerate(siblings) if s.pk in kept_ids)

    # Phase 1 — mint the container past the end of the level, where no path can
    # collide, and move the kept subtrees under it.
    from trueppm_api.apps.projects.models import Task as TaskModel

    staging_path = _build_wbs_path(parent_path, staging_base(siblings))
    container = TaskModel.objects.create(
        project=project,
        name=container_name,
        wbs_path=staging_path,
        # A grouped container is *declared*, not inferred (#2950). `auto_container`
        # stays False on purpose: the row did not drift into container-ness by
        # acquiring a child, so losing its last child must not silently demote it
        # back to work. The user asked for a phase; it stays a phase until they say
        # otherwise.
        structure_role=StructureRole.CONTAINER,
        auto_container=False,
    )

    updated: list[dict[str, str]] = []
    inner_snapshot = _subtree_snapshot(project_id, kept_in_tree_order)
    for position, task in enumerate(kept_in_tree_order, start=1):
        _move_root(
            task,
            inner_snapshot.get(str(task.wbs_path), []),
            _build_wbs_path(staging_path, position),
            updated,
        )

    # Phase 2 — put the container where the first wrapped row used to be and renumber
    # the level around it.
    new_level = [*remaining[:first_index], container, *remaining[first_index:]]
    level_updates = rewrite_level(project_id, parent_path, new_level)

    by_id: dict[str, str] = {entry["id"]: entry["wbs_path"] for entry in updated}
    for entry in level_updates:
        by_id[entry["id"]] = entry["wbs_path"]

    # The container has children the moment it is created, so park its own status and
    # estimate the same way any row promoted over the container line does. Without this
    # the placeholder duration would read as the phase's own estimate rather than as a
    # parked value the rollup shadows.
    container.refresh_from_db()
    if sync_structure_shadow_values(container):
        container.save(
            update_fields=[
                "structure_role",
                "auto_container",
                "own_status",
                "own_estimate",
                "server_version",
            ]
        )

    assert_graph_feasible(project_id, graph_before)

    warning: str | None = None
    if parent is not None:
        from trueppm_api.apps.resources.models import TaskResource

        # Mirrors reparent's warning: the level's parent has not changed shape here,
        # but a *newly* childless-to-parent transition on it would surface the same
        # "assignments on a summary" condition. Only fires when the container is the
        # parent's first structural child, which happens when the whole level was
        # wrapped.
        if not remaining and TaskResource.objects.filter(task=parent).exists():
            warning = "has_assignments"

    operation = capture.record(
        project=project,
        applied_by=request.user,
        kind=StructuralOperationKind.GROUP,
        anchors=[task.pk for task in selection.kept],
        created_task_ids=[container.pk],
    )

    return {
        "container": {
            "id": str(container.pk),
            "name": container.name,
            "wbs_path": by_id.get(str(container.pk), str(container.wbs_path)),
            "structure_role": container.structure_role,
            "parent_id": str(parent.pk) if parent is not None else None,
        },
        "grouped_ids": [str(task.pk) for task in kept_in_tree_order],
        "left_alone": [entry.as_dict() for entry in selection.left_alone],
        "updated": [{"id": tid, "wbs_path": path} for tid, path in by_id.items()],
        "warning": warning,
        "operation_id": str(operation.pk),
    }


# ── Ungroup ─────────────────────────────────────────────────────────────────────


def perform_ungroup(project: Project, request: Request, raw_id: Any) -> dict[str, Any]:
    """Dissolve a container, lifting its children one level. Caller supplies ``atomic()``.

    "Only the wrapper goes": the children keep their ids, their dependency edges, their
    resource assignments and their estimates, because nothing about them is rewritten
    except ``wbs_path``. The wrapper's *own* edges go with the wrapper — that is what
    ``Task.soft_delete`` does to any task — and are reported back so the UI can say so
    rather than letting the links vanish silently.
    """
    from trueppm_api.apps.access.permissions import can_user_edit_task
    from trueppm_api.apps.projects.models import (
        Dependency,
        sync_structure_shadow_values,
    )
    from trueppm_api.apps.projects.models import (
        Task as TaskModel,
    )
    from trueppm_api.apps.projects.views import _get_siblings

    if not isinstance(raw_id, str):
        raise GroupingRejected("invalid_task_id", "`task_id` must be a UUID string.")
    try:
        container_id = uuid.UUID(raw_id)
    except ValueError as exc:
        raise GroupingRejected("invalid_task_id", "`task_id` must be a UUID string.") from exc

    project_id = str(project.pk)
    container = (
        TaskModel.objects.select_for_update()
        .filter(pk=container_id, project_id=project_id, is_deleted=False)
        .first()
    )
    if container is None:
        raise GroupingRejected(
            "unknown_task", "No live task with that id in this project.", status_code=404
        )
    if not container.wbs_path:
        raise GroupingRejected(
            "task_without_wbs_path", "This task has no WBS path and cannot be dissolved."
        )
    if container.is_subtask:
        raise GroupingRejected(
            "cannot_ungroup_subtask", "A subtask is not a phase and cannot be dissolved."
        )

    container_path = str(container.wbs_path)
    parent_path = parent_path_of(container_path)

    # A phase should never carry drawer subtasks ("phases group work — add tasks inside
    # the phase, not subtasks"), but if one somehow does, `Task.soft_delete` would
    # cascade-delete them along with the wrapper. Refusing is the only outcome that
    # keeps "only the wrapper goes" true.
    if TaskModel.objects.filter(
        project_id=project_id,
        is_deleted=False,
        is_subtask=True,
        wbs_path__startswith=f"{container_path}.",
    ).exists():
        raise GroupingRejected(
            "container_has_subtasks",
            (
                "This phase carries subtasks, which would be deleted with it. "
                "Move or delete them first."
            ),
        )

    children = _get_siblings(project_id, container_path, lock=True)
    _require_restructure(request, [container, *children])
    if not can_user_edit_task(request, container, method="DELETE"):
        from rest_framework.exceptions import PermissionDenied

        raise PermissionDenied("You do not have permission to delete this phase.")

    siblings = _get_siblings(project_id, parent_path, lock=True)
    container_index = next(i for i, s in enumerate(siblings) if s.pk == container.pk)
    graph_before = capture_graph_state(project_id)
    capture = StructuralCapture.begin(project.pk, {parent_path})

    removed_dependency_ids = [
        str(dep_id)
        for dep_id in Dependency.objects.filter(is_deleted=False)
        .filter(Q(predecessor_id=container.pk) | Q(successor_id=container.pk))
        .values_list("pk", flat=True)
    ]
    from trueppm_api.apps.resources.models import TaskResource

    warning = "has_assignments" if TaskResource.objects.filter(task=container).exists() else None

    # Park the children at the destination level before the wrapper goes, so the
    # renumbering pass below sees one flat level with no path collisions.
    _park_level(project_id, parent_path, children, staging_base(siblings))

    container.soft_delete()

    new_level = siblings[:container_index] + children + siblings[container_index + 1 :]
    updated = rewrite_level(project_id, parent_path, new_level)

    if parent_path:
        parent = (
            TaskModel.objects.select_for_update()
            .filter(project_id=project_id, wbs_path=parent_path, is_deleted=False)
            .first()
        )
        # Dissolving an *empty* phase can take its parent's last structural child, which
        # is the transition that restores the parent's parked status and estimate.
        if parent is not None and sync_structure_shadow_values(parent):
            parent.save(
                update_fields=[
                    "structure_role",
                    "auto_container",
                    "own_status",
                    "own_estimate",
                    "server_version",
                ]
            )

    assert_graph_feasible(project_id, graph_before)

    # This row is what makes #3006 answerable: the wrapper is soft-deleted, so restoring
    # it returns the *original* id, name, notes and labels rather than the new container
    # a re-group would mint. Nothing about the wrapper needs snapshotting — the soft
    # delete retains all of it; only the pointer does.
    operation = capture.record(
        project=project,
        applied_by=request.user,
        kind=StructuralOperationKind.UNGROUP,
        anchors=[container.pk, *[child.pk for child in children]],
        deleted_task_ids=[container.pk],
        removed_dependency_ids=[uuid.UUID(dep_id) for dep_id in removed_dependency_ids],
    )

    return {
        "container_id": str(container.pk),
        "lifted_ids": [str(child.pk) for child in children],
        "removed_dependency_ids": removed_dependency_ids,
        "updated": updated,
        "warning": warning,
        "operation_id": str(operation.pk),
    }
