"""Refuse a structural edit that would make a task with SS/SF links a summary (#4830).

ADR-0370 forbids a Start-to-Start or Start-to-Finish link *from* a summary task, and
the CPM engine refuses every recalculation of a project that holds one.
``DependencySerializer`` enforces the rule when the link is written, but the link can
also become illegal without being touched: a leaf that already drives a successor SS
turns into a summary the moment it gains a child. Indent, outdent, reparent, and
create-with-``parent_id`` each do exactly that, and none of them reads an edge's type,
so before this module they all returned success and left the project unschedulable
until somebody found and deleted the link.

Every one of those paths calls :func:`summary_start_link_block` at the moment it
knows a task is about to gain its *first* child. Only the first: a task that is
already a summary and already holds such a link was broken before this request, and
refusing an unrelated restructure on that account would block the edits that repair
it — the same differential rule ``assert_graph_feasible`` follows.

The same moves can also make an existing link run between a summary and one of its
own descendants (#4705): ``Design -FS-> Build`` on adjacent rows, then indent Build,
gives ``Design{Build} -FS-> Build``. ``find_cycle`` and the CPM's summary expansion
both treat that as a cycle, so every recalculation of the project is refused.
:func:`summary_descendant_link_block` is the check for it. Each restructure passes the
tasks that become *new* ancestors and the tasks that move under them, so a link that
already ran between an ancestor and its descendant before the request is not blamed
on it, for the same differential reason.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

from django.db.models import Q
from rest_framework.exceptions import APIException, ValidationError

from trueppm_api.apps.scheduling.graph_guard import (
    SUMMARY_FORBIDDEN_INBOUND_LINK_TYPES,
    SUMMARY_FORBIDDEN_LINK_TYPES,
    TypedPair,
    find_summary_start_links,
    printable_label,
    validate_graph_transition,
)

if TYPE_CHECKING:
    from django.db.models import QuerySet

    from trueppm_api.apps.projects.models import Task

logger = logging.getLogger(__name__)


class _EdgeLike(Protocol):
    """What :func:`split_summary_start_links` reads off an unsaved ``Dependency``."""

    predecessor_id: Any
    successor_id: Any
    dep_type: Any


DependencyT = TypeVar("DependencyT", bound=_EdgeLike)

#: Stable machine code for the refusal, shared by every structural endpoint.
SUMMARY_START_LINK_CODE = "summary_start_link"

#: Stable machine code for a move that would link a summary to its own descendant (#4705).
SUMMARY_DESCENDANT_LINK_CODE = "summary_descendant_link"

#: Stable machine code for a write the recalculation could not schedule afterwards (#4828, #5046).
UNSCHEDULABLE_CHANGE_CODE = "unschedulable_change"

#: Most links a refusal names before collapsing the rest into a count — the message is
#: prose a person reads, and the full list travels in ``blocking_dependencies``.
MAX_NAMED_LINKS = 3

#: OpenAPI fragment for the ``blocking_dependencies`` key of the refusal body, for the
#: endpoints that declare their 400 with ``state_refusal_400(extra_properties=...)``.
BLOCKING_DEPENDENCIES_SCHEMA: dict[str, Any] = {
    "blocking_dependencies": {
        "type": "array",
        "description": (
            "Present only with code ``summary_start_link`` or "
            "``summary_descendant_link``. For ``summary_start_link``: every "
            "Start-to-Start or Start-to-Finish link the task drives, and every "
            "Finish-to-Finish or Start-to-Finish link into it, that stops it becoming a "
            "summary (ADR-0370, #4437); ``successor_id`` is null when the successor is in "
            "another project. For ``summary_descendant_link``: every link the move "
            "would leave between a summary task and one of its own subtasks, which "
            "the scheduler treats as a cycle (#4705)."
        ),
        "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "format": "uuid"},
                "dep_type": {"type": "string", "enum": ["FS", "SS", "FF", "SF"]},
                "successor_id": {"type": "string", "format": "uuid", "nullable": True},
            },
            "required": ["id", "dep_type", "successor_id"],
        },
    }
}


@dataclass(frozen=True)
class SummaryStartLinkBlock:
    """Why ``task`` cannot become a summary, ready to render as a 400 body."""

    detail: str
    blocking_dependencies: list[dict[str, Any]] = field(default_factory=list)
    code: str = SUMMARY_START_LINK_CODE

    def body(self) -> dict[str, Any]:
        """The ``{code, detail, blocking_dependencies}`` body the WBS endpoints return."""
        return {
            "code": self.code,
            "detail": self.detail,
            "blocking_dependencies": self.blocking_dependencies,
        }


def summary_ids_from_paths(rows: Iterable[tuple[Any, str | None]]) -> set[str]:
    """The ids among ``(id, wbs_path)`` rows that have at least one direct child.

    Direct-parent semantics on purpose, matching the CPM's own children map
    (``_load_project_tasks_and_children_map``): a task is a summary to the engine
    exactly when some row's parent path is its path. ``rows`` must be one project's —
    WBS paths are only unique within a project.
    """
    by_path = {str(path): str(row_id) for row_id, path in rows if path}
    summaries: set[str] = set()
    for path in by_path:
        parent, _, _ = path.rpartition(".")
        if parent and parent in by_path:
            summaries.add(by_path[parent])
    return summaries


def split_summary_start_links(
    deps: Sequence[DependencyT], summary_ids: set[str]
) -> tuple[list[DependencyT], list[DependencyT]]:
    """Partition unsaved ``Dependency`` rows into ``(kept, skipped)`` by the ADR-0370 rule.

    The import-side half of #4830: an importer that is about to ``bulk_create``
    edges drops the SS/SF links out of a summary and reports each one, rather than
    persisting a graph the engine will refuse on every recalculation or refusing a
    whole file over one link. The rule itself is
    :func:`~trueppm_api.apps.scheduling.graph_guard.find_summary_start_links`.
    """
    offending = set(
        find_summary_start_links(
            ((str(d.predecessor_id), str(d.successor_id), str(d.dep_type)) for d in deps),
            summary_ids,
        )
    )
    kept: list[DependencyT] = []
    skipped: list[DependencyT] = []
    for dep in deps:
        key = (str(dep.predecessor_id), str(dep.successor_id), str(dep.dep_type))
        (skipped if key in offending else kept).append(dep)
    return kept, skipped


def skipped_link_warning(predecessor_name: str, successor_name: str, dep_type: str) -> str:
    """The import warning for one skipped summary link (#4830, #4437).

    An SS link can only be skipped for its summary predecessor and an FF link only
    for its summary successor; an SF link can be either, so its warning names both.
    """
    head = (
        f"Task '{printable_label(predecessor_name)}': {dep_type} link to "
        f"'{printable_label(successor_name)}' skipped — "
    )
    if dep_type == "FF":
        return head + (
            "a summary task cannot be the successor of a Finish-to-Finish or "
            "Start-to-Finish link. Re-add it to one of the summary's subtasks, or as "
            "Finish-to-Start or Start-to-Start."
        )
    if dep_type == "SF":
        return head + (
            "a summary task cannot drive a Start-to-Start or Start-to-Finish link, or "
            "be the successor of a Finish-to-Finish or Start-to-Finish link. Re-add it "
            "between subtasks."
        )
    return head + (
        "a summary task cannot drive a "
        "Start-to-Start or Start-to-Finish link. Re-add it from one of the summary's "
        "subtasks, or as Finish-to-Start or Finish-to-Finish."
    )


def retire_revived_summary_start_links(scope: QuerySet[Task]) -> list[Any]:
    """Re-remove summary-illegal links that a trash restore just revived.

    Restoring a task (its subtree) or a whole project revives the tombstoned edges
    touching the restored rows. One of them can touch a task that was a leaf when the
    rows were deleted and has become a summary since — legal then, forbidden now: an
    SS/SF link *out of* a summary (ADR-0370, #4830) or an FF/SF link *into* one
    (#4437). ``scope`` is the restored rows. Every live edge touching them right after
    the restore was revived by it (an edge cannot be created against a deleted task,
    and deleting a task or a project tombstones every edge touching it), so retiring
    the offending ones takes back only what this restore wrote; the rest of the
    restore stands.

    Summary status is read from each endpoint's own project's children map — the
    CPM's notion of a summary — once per project, not once per edge, so a project
    restore with many links stays a bounded number of queries. The rule itself is
    :func:`~trueppm_api.apps.scheduling.graph_guard.find_summary_start_links`.

    Returns the retired rows so the caller can report them.
    """
    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.projects.serializers import _load_project_tasks_and_children_map

    candidates = list(
        Dependency.live.filter(
            Q(predecessor__in=scope) | Q(successor__in=scope),
            dep_type__in=sorted(
                SUMMARY_FORBIDDEN_LINK_TYPES | SUMMARY_FORBIDDEN_INBOUND_LINK_TYPES
            ),
        ).select_related("predecessor", "successor")
    )
    if not candidates:
        return []
    # Same row lock the structural guards and the dependency write take on the
    # would-be summary, held before its children are read, so a concurrent indent
    # under one of these endpoints cannot slip between the read and the retire.
    # Ordered by pk so two restores sharing endpoints lock them in one order.
    from django.db import transaction

    from trueppm_api.apps.projects.models import Task as TaskModel

    if transaction.get_connection().in_atomic_block:
        endpoint_ids = {dep.predecessor_id for dep in candidates} | {
            dep.successor_id for dep in candidates
        }
        list(
            TaskModel.objects.select_for_update()
            .filter(pk__in=endpoint_ids)
            .order_by("pk")
            .values_list("pk", flat=True)
        )
    summaries: set[str] = set()
    project_ids = {dep.predecessor.project_id for dep in candidates} | {
        dep.successor.project_id for dep in candidates
    }
    for project_id in project_ids:
        _, children_map = _load_project_tasks_and_children_map(project_id)
        summaries.update(children_map)
    offending = set(
        find_summary_start_links(
            ((str(d.predecessor_id), str(d.successor_id), str(d.dep_type)) for d in candidates),
            summaries,
        )
    )
    retired: list[Any] = []
    for dep in candidates:
        if (str(dep.predecessor_id), str(dep.successor_id), str(dep.dep_type)) in offending:
            dep.soft_delete()
            logger.warning(
                "restore: %s link %s (%s -> %s) touching a summary not revived (ADR-0370, #4437)",
                dep.dep_type,
                dep.pk,
                dep.predecessor_id,
                dep.successor_id,
            )
            retired.append(dep)
    return retired


def summary_start_link_block(task: Task) -> SummaryStartLinkBlock | None:
    """The refusal for making ``task`` a summary, or ``None`` when it may become one.

    Two indexed queries (one per FK), run only by a caller that has established
    ``task`` is about to gain its first child — so a restructure that does not
    create a summary pays nothing. The links that block it are the ones the engine
    refuses around a summary: SS/SF the task *drives* (ADR-0370) and FF/SF *into*
    the task (#4437). Several of these callers never run the both-sides
    ``assert_graph_feasible``, so this is the only thing standing between an indent
    and a project that cannot be recalculated.

    Every live edge counts, cross-project ones included: the program schedule
    expands cross-project edges through the same summary rule and refuses them the
    same way. A task outside ``task``'s project is not named, because the caller is
    authorized on this project and not necessarily on that one; the link is still
    listed by id so a client can offer to retype or delete it, which the caller may
    do — one of its endpoints is a task in this project.
    """
    from trueppm_api.apps.projects.models import Dependency

    links = list(
        Dependency.live.filter(
            Q(predecessor_id=task.pk, dep_type__in=sorted(SUMMARY_FORBIDDEN_LINK_TYPES))
            | Q(successor_id=task.pk, dep_type__in=sorted(SUMMARY_FORBIDDEN_INBOUND_LINK_TYPES))
        )
        .select_related("predecessor", "successor")
        .only(
            "id",
            "dep_type",
            "predecessor_id",
            "successor_id",
            "predecessor__name",
            "predecessor__project_id",
            "successor__name",
            "successor__project_id",
        )
        .order_by("successor__name", "predecessor__name", "pk")
    )
    if not links:
        return None

    outbound: list[str] = []
    inbound: list[str] = []
    payload: list[dict[str, Any]] = []
    for link in links:
        is_inbound = link.successor_id == task.pk
        other = link.predecessor if is_inbound else link.successor
        same_project = other.project_id == task.project_id
        payload.append(
            {
                "id": str(link.pk),
                "dep_type": link.dep_type,
                "successor_id": (str(link.successor_id) if (is_inbound or same_project) else None),
            }
        )
        label = f"“{printable_label(other.name)}”" if same_project else "a task in another project"
        (inbound if is_inbound else outbound).append(f"{label} ({link.dep_type})")

    clauses: list[str] = []
    fixes: list[str] = []
    if outbound:
        clauses.append(
            f"it drives {_name_links(outbound)} with a Start-to-Start or "
            "Start-to-Finish link, and a summary cannot drive a successor from "
            "its start"
        )
        fixes.append("Start-to-Start or Start-to-Finish")
    if inbound:
        clauses.append(
            f"{_name_links(inbound)} link into it with a Finish-to-Finish or "
            "Start-to-Finish link, and a summary cannot be the successor of one "
            "that constrains its finish"
        )
        fixes.append("Finish-to-Finish or Start-to-Finish")
    detail = (
        f"“{printable_label(task.name)}” cannot become a summary task: "
        + "; and ".join(clauses)
        + ". Change those links to Finish-to-Start (or, for a Start-to-Start link, "
        "Finish-to-Finish), or delete them, first."
    )
    return SummaryStartLinkBlock(detail=detail, blocking_dependencies=payload)


def _name_links(described: list[str]) -> str:
    """Join described links for a refusal sentence, collapsing the tail into a count."""
    named = ", ".join(described[:MAX_NAMED_LINKS])
    if len(described) > MAX_NAMED_LINKS:
        named += f" and {len(described) - MAX_NAMED_LINKS} more"
    return named


def summary_descendant_link_block(
    new_ancestors: Sequence[Task], moved: Sequence[Task]
) -> SummaryStartLinkBlock | None:
    """The refusal for a move that would link a summary to its own descendant (#4705).

    ``new_ancestors`` are the tasks the move makes ancestors of ``moved`` that were not
    ancestors of them before; ``moved`` is every task that ends up under them (the
    moved task and its whole subtree). A live link in either direction between the two
    sets would, after the move, run between a summary and one of its own descendants.
    The scheduler expands that link to a self-loop on a shared leaf: ``find_cycle``
    reports it as a cycle and ``expand_summary_dependencies`` raises
    ``CyclicDependencyError``, so the project could not be recalculated again until
    the link was found and deleted. In a WBS tree, "shares a leaf" is exactly
    "ancestor and descendant", so this is the engine's own rule, narrowed to the
    pairs the move creates.

    One indexed query on the two dependency FKs. Both sets belong to the caller's
    project, so every task named in the message is one the caller may read.
    """
    from django.db.models import Q

    from trueppm_api.apps.projects.models import Dependency

    ancestor_ids = [t.pk for t in new_ancestors]
    moved_ids = [t.pk for t in moved]
    if not ancestor_ids or not moved_ids:
        return None
    links = list(
        Dependency.live.filter(
            Q(predecessor_id__in=ancestor_ids, successor_id__in=moved_ids)
            | Q(predecessor_id__in=moved_ids, successor_id__in=ancestor_ids)
        )
        .select_related("predecessor", "successor")
        .only("id", "dep_type", "predecessor__name", "successor_id", "successor__name")
        .order_by("predecessor__name", "successor__name", "pk")
    )
    if not links:
        return None

    described = [
        f"“{printable_label(link.predecessor.name)}” → "
        f"“{printable_label(link.successor.name)}” ({link.dep_type})"
        for link in links
    ]
    named = ", ".join(described[:MAX_NAMED_LINKS])
    if len(described) > MAX_NAMED_LINKS:
        named += f" and {len(described) - MAX_NAMED_LINKS} more"
    detail = (
        f"This move would put a summary task over a task it is linked to: {named}. A "
        "summary task cannot be linked to one of its own subtasks, because the "
        "schedule would depend on itself. Delete or change those links first."
    )
    payload = [
        {"id": str(link.pk), "dep_type": link.dep_type, "successor_id": str(link.successor_id)}
        for link in links
    ]
    return SummaryStartLinkBlock(
        detail=detail, blocking_dependencies=payload, code=SUMMARY_DESCENDANT_LINK_CODE
    )


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

#: Fields whose value decides whether the recalculation schedules a task at all.
FEED_ELIGIBILITY_FIELDS: frozenset[str] = frozenset({"status", "type", "is_recurring"})


def is_feed_eligible(status: Any, task_type: Any, is_recurring: Any) -> bool:
    """Whether the CPM recalculation feed admits a task with these values.

    The same three exclusions ``scheduling.tasks._run_schedule`` applies before it
    builds the children map (ADR-0090, ADR-0105, #1772): a recurring row, an epic, or
    a backlog row is not scheduled, so it is neither a summary's child nor a link
    endpoint as far as the engine is concerned.
    """
    from trueppm_api.apps.projects.models import TaskStatus, TaskType

    return not is_recurring and task_type != TaskType.EPIC and status != TaskStatus.BACKLOG


@dataclass
class _FeedRow:
    path: str | None
    status: Any
    task_type: Any
    is_recurring: bool
    is_subtask: bool
    name: str
    parent: str | None = None


def _feed_graph(
    rows: dict[str, _FeedRow], edges: list[TypedPair], *, rolled_up: bool
) -> tuple[list[TypedPair], dict[str, list[str]]]:
    """The ``(edges, children_map)`` the recalculation would build from ``rows``.

    ``rolled_up=False`` reads each row's status as stored, which is what the very next
    recalculation sees. ``rolled_up=True`` first re-derives every phase's status from
    its leaves the way ``rollup_phase_statuses`` does in that pass's write-back (a phase
    is ``BACKLOG`` exactly when every non-subtask leaf under it is), which is what the
    follow-up recalculation ``_schedule_backlog_flip_recompute`` enqueues sees. #5046
    lives in the second view: a phase whose only child is a backlog row is itself
    ``BACKLOG`` and outside the feed, so its FF/SF inbound link is harmless until that
    child commits, the rollup commits the phase, and it re-enters the feed a summary.
    """
    children: dict[str, list[str]] = {}
    for tid, row in rows.items():
        if row.parent is not None:
            children.setdefault(row.parent, []).append(tid)

    committed_leaf: dict[str, bool] = {}

    def has_committed_leaf(tid: str) -> bool:
        # Leaves for the rollup are non-subtask rows with no non-subtask descendant.
        if tid in committed_leaf:
            return committed_leaf[tid]
        kids = [c for c in children.get(tid, []) if not rows[c].is_subtask]
        from trueppm_api.apps.projects.models import TaskStatus

        value = (
            any(has_committed_leaf(c) for c in kids)
            if kids
            else rows[tid].status != TaskStatus.BACKLOG
        )
        committed_leaf[tid] = value
        return value

    def eligible(tid: str) -> bool:
        row = rows[tid]
        status = row.status
        if (
            rolled_up
            and not row.is_subtask
            and any(not rows[c].is_subtask for c in children.get(tid, []))
        ):
            from trueppm_api.apps.projects.models import TaskStatus

            # Any non-backlog value stands in for the derived one: only the BACKLOG
            # boundary changes what the feed admits.
            status = TaskStatus.NOT_STARTED if has_committed_leaf(tid) else TaskStatus.BACKLOG
        return is_feed_eligible(status, row.task_type, row.is_recurring)

    included = {tid for tid in rows if eligible(tid)}
    children_map: dict[str, list[str]] = {}
    for tid in included:
        parent = rows[tid].parent
        if parent is not None and parent in included:
            children_map.setdefault(parent, []).append(tid)
    return [e for e in edges if e[0] in included and e[1] in included], children_map


def _load_feed(project_id: Any) -> tuple[dict[str, _FeedRow], dict[str, str], list[TypedPair]]:
    """The project's rows, ``{wbs_path: id}`` and live same-project edges, as stored.

    Rows carry their parent resolved by path, which is the parenthood the CPM's own
    children map reads. Returns no rows when the project has no dependencies: a
    graph without edges cannot fail the recalculation, so the row read is skipped.
    """
    from trueppm_api.apps.projects.models import Dependency, Task

    edges: list[TypedPair] = [
        (str(p), str(s), str(t))
        for p, s, t in Dependency.live.filter(predecessor__project_id=project_id).values_list(
            "predecessor_id", "successor_id", "dep_type"
        )
    ]
    rows: dict[str, _FeedRow] = {}
    by_path: dict[str, str] = {}
    if not edges:
        return rows, by_path, edges
    for pk, path, status, task_type, is_recurring, is_subtask, name in Task.objects.filter(
        project_id=project_id, is_deleted=False
    ).values_list("id", "wbs_path", "status", "type", "is_recurring", "is_subtask", "name"):
        rows[str(pk)] = _FeedRow(
            path=str(path) if path else None,
            status=status,
            task_type=task_type,
            is_recurring=bool(is_recurring),
            is_subtask=bool(is_subtask),
            name=name,
        )
    for key, feed_row in rows.items():
        if feed_row.path:
            by_path.setdefault(feed_row.path, key)
    for feed_row in rows.values():
        if feed_row.path and "." in feed_row.path:
            feed_row.parent = by_path.get(feed_row.path.rpartition(".")[0])
    return rows, by_path, edges


_FeedGraph = tuple[list[TypedPair], dict[str, list[str]]]


def _both_views(rows: dict[str, _FeedRow], edges: list[TypedPair]) -> tuple[_FeedGraph, _FeedGraph]:
    """The graph as stored and after the phase-status rollup (see :func:`_feed_graph`)."""
    return _feed_graph(rows, edges, rolled_up=False), _feed_graph(rows, edges, rolled_up=True)


def _transition_block(
    before: tuple[_FeedGraph, _FeedGraph],
    after: tuple[_FeedGraph, _FeedGraph],
    names: Mapping[str, str],
) -> SummaryStartLinkBlock | None:
    """Ask the engine about ``after`` against ``before`` in both views; render a refusal."""
    from trueppm_scheduler import CyclicDependencyError, InvalidScheduleInput

    from trueppm_api.apps.scheduling.graph_guard import InfeasibleGraphError

    try:
        validate_graph_transition(before[0], after[0])
        validate_graph_transition(before[1], after[1])
    except (InvalidScheduleInput, CyclicDependencyError, InfeasibleGraphError) as exc:
        # The engine names tasks by id. Every id it can name here is a row of this
        # project, which the caller is authorized on, so naming them discloses nothing.
        message = _UUID.sub(
            lambda m: (
                f"“{printable_label(names[m.group(0)])}”"
                if m.group(0) in names
                else "a task in another project"
            ),
            str(exc),
        )
        return SummaryStartLinkBlock(
            detail=(
                "This change would leave a schedule that cannot be recalculated: "
                f"{message} Nothing was changed."
            ),
            code=UNSCHEDULABLE_CHANGE_CODE,
        )
    return None


#: Stand-in id for the row a create is about to insert. Not a UUID, so it can never
#: collide with a stored row, and it has no edges for the engine to name it by.
_NEW_ROW = "new-task"


def recalc_transition_block(
    project_id: Any,
    *,
    reparent: Mapping[Any, str] | None = None,
    changes: Mapping[Any, Mapping[str, Any]] | None = None,
    add_child: tuple[str, Mapping[str, Any]] | None = None,
) -> SummaryStartLinkBlock | None:
    """Refuse a write that would make the project's recalculation raise (#4828, #5046).

    The one structural guard that asks the engine itself. ``summary_start_link_block``
    and ``summary_descendant_link_block`` each name one rule; this rebuilds the graph
    the CPM pass would build after the write and runs the engine's expansion and cycle
    check over it (:func:`~trueppm_api.apps.scheduling.graph_guard.validate_graph_transition`),
    so a rule neither of them states — a summary link and a differently typed leaf
    link expanding onto the same leaf pair, a cycle a move closes through a summary —
    is refused too. Callers run it after the narrower guards, which give a more
    specific body for the cases they cover.

    Args:
        project_id: The project being written. Same-project edges only, as the
            single-project recalculation reads them.
        reparent: ``{task_id: new_parent_wbs_path}`` — each task moves, with its
            subtree, under the task at that path (``""`` for the root). Paths are the
            pre-write ones, so a caller states the move before it writes anything.
        changes: ``{task_id: {field: value}}`` for :data:`FEED_ELIGIBILITY_FIELDS`
            about to be written.
        add_child: ``(parent_wbs_path, fields)`` for a task about to be created under
            that parent, ``fields`` holding any of ``status``, ``type``,
            ``is_recurring`` and ``is_subtask`` (defaults: not started, a plain task,
            not recurring, not a subtask). A parent whose existing children are all
            backlog, epic or recurring is a leaf to the engine, so its first
            *committed* child makes it a summary even though it "already has
            children" (#5046).

    Differential: a project whose recalculation already fails is not refused, so the
    edits that repair it stay possible. Two queries; a project with no dependencies
    returns after one.
    """
    from trueppm_api.apps.projects.models import TaskStatus, TaskType

    rows, by_path, edges = _load_feed(project_id)
    if not edges:
        return None
    before = _both_views(rows, edges)

    for tid, new_parent_path in (reparent or {}).items():
        moved = rows.get(str(tid))
        if moved is not None:
            moved.parent = by_path.get(new_parent_path) if new_parent_path else None
    for tid, fields in (changes or {}).items():
        changed = rows.get(str(tid))
        if changed is None:
            continue
        changed.status = fields.get("status", changed.status)
        changed.task_type = fields.get("type", changed.task_type)
        changed.is_recurring = bool(fields.get("is_recurring", changed.is_recurring))
    if add_child is not None:
        parent_path, fields = add_child
        parent_id = by_path.get(parent_path)
        if parent_id is None:
            return None
        rows[_NEW_ROW] = _FeedRow(
            path=None,
            status=fields.get("status") or TaskStatus.NOT_STARTED,
            task_type=fields.get("type") or TaskType.TASK,
            is_recurring=bool(fields.get("is_recurring", False)),
            is_subtask=bool(fields.get("is_subtask", False)),
            name="",
            parent=parent_id,
        )

    return _transition_block(
        before, _both_views(rows, edges), {tid: row.name for tid, row in rows.items()}
    )


@dataclass(frozen=True)
class RecalcState:
    """A project's recalculation graph captured before a write :func:`recalc_state_block` checks."""

    views: tuple[_FeedGraph, _FeedGraph]


def capture_recalc_state(project_id: Any) -> RecalcState:
    """Snapshot the graph the recalculation would build now, for a post-write check.

    For a write too broad to state up front — a trash restore revives a subtree and
    the links touching it at once. Take the snapshot inside the write's transaction,
    write, then call :func:`recalc_state_block` and roll back on a refusal. Two queries.
    """
    rows, _, edges = _load_feed(project_id)
    return RecalcState(views=_both_views(rows, edges))


def recalc_state_block(project_id: Any, before: RecalcState) -> SummaryStartLinkBlock | None:
    """:func:`recalc_transition_block` for a write already applied, against ``before``."""
    rows, _, edges = _load_feed(project_id)
    if not edges:
        return None
    return _transition_block(
        before.views, _both_views(rows, edges), {tid: row.name for tid, row in rows.items()}
    )


class UnschedulableChange(APIException):
    """A write refused with :data:`UNSCHEDULABLE_CHANGE_CODE`, as a ``{code, detail}`` 400.

    For a path with no request field to hang the refusal on (a recurrence rule's
    attach or detach flips the template's ``is_recurring``, which no client writes):
    raised from ``perform_create``/``perform_destroy`` before any row is written, so
    DRF's handler returns the same body the WBS endpoints do.
    """

    status_code = 400
    default_code = UNSCHEDULABLE_CHANGE_CODE

    def __init__(self, block: SummaryStartLinkBlock) -> None:
        super().__init__(detail={"code": block.code, "detail": block.detail})


class UnschedulableTaskChange(ValidationError):
    """``TaskSerializer.update``'s refusal of a status or type change (#5046).

    A field error under the written field, so the REST PATCH and ``tasks/bulk`` rows
    report it as any other validation failure. Its own type so the mobile sync upload
    can report that one row as a conflict and commit the rest of the batch, rather
    than roll the whole upload back over a row the client must fix by hand.
    """

    def __init__(self, field: str, detail: str) -> None:
        super().__init__({field: [detail]}, code=UNSCHEDULABLE_CHANGE_CODE)
        self.field = field
        self.message = detail
