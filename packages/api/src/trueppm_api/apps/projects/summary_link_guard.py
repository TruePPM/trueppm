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
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

from trueppm_api.apps.scheduling.graph_guard import (
    SUMMARY_FORBIDDEN_LINK_TYPES,
    find_summary_start_links,
    printable_label,
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
            "Start-to-Start or Start-to-Finish link that stops the task becoming a "
            "summary (ADR-0370); ``successor_id`` is null when the successor is in "
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
    """The import warning for one skipped SS/SF-from-summary link (#4830)."""
    return (
        f"Task '{printable_label(predecessor_name)}': {dep_type} link to "
        f"'{printable_label(successor_name)}' skipped — a summary task cannot drive a "
        "Start-to-Start or Start-to-Finish link. Re-add it from one of the summary's "
        "subtasks, or as Finish-to-Start or Finish-to-Finish."
    )


def retire_revived_summary_start_links(scope: QuerySet[Task]) -> list[Any]:
    """Re-remove SS/SF links out of a summary that a trash restore just revived.

    Restoring a task (its subtree) or a whole project revives the tombstoned edges
    touching the restored rows. One of them can be a link out of a task that was a
    leaf when the rows were deleted and has become a summary since — legal then,
    forbidden now (ADR-0370, #4830). ``scope`` is the restored rows. Every live edge
    touching them right after the restore was revived by it (an edge cannot be
    created against a deleted task, and deleting a task or a project tombstones every
    edge touching it), so retiring the offending ones takes back only what this
    restore wrote; the rest of the restore stands.

    Summary status is read from each predecessor's own project's children map —
    the CPM's notion of a summary — once per project, not once per edge, so a project
    restore with many SS links stays a bounded number of queries.

    Returns the retired rows so the caller can report them.
    """
    from django.db.models import Q

    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.projects.serializers import _load_project_tasks_and_children_map

    candidates = list(
        Dependency.live.filter(
            Q(predecessor__in=scope) | Q(successor__in=scope),
            dep_type__in=sorted(SUMMARY_FORBIDDEN_LINK_TYPES),
        ).select_related("predecessor")
    )
    if not candidates:
        return []
    # Same row lock the structural guards and the SS/SF dependency write take on the
    # would-be summary, held before its children are read, so a concurrent indent
    # under one of these predecessors cannot slip between the read and the retire.
    # Ordered by pk so two restores sharing predecessors lock them in one order.
    from django.db import transaction

    from trueppm_api.apps.projects.models import Task as TaskModel

    if transaction.get_connection().in_atomic_block:
        list(
            TaskModel.objects.select_for_update()
            .filter(pk__in={dep.predecessor_id for dep in candidates})
            .order_by("pk")
            .values_list("pk", flat=True)
        )
    summaries: set[str] = set()
    for project_id in {dep.predecessor.project_id for dep in candidates}:
        _, children_map = _load_project_tasks_and_children_map(project_id)
        summaries.update(children_map)
    retired: list[Any] = []
    for dep in candidates:
        if str(dep.predecessor_id) in summaries:
            dep.soft_delete()
            logger.warning(
                "restore: SS/SF link %s from summary %s not revived (ADR-0370)",
                dep.pk,
                dep.predecessor_id,
            )
            retired.append(dep)
    return retired


def summary_start_link_block(task: Task) -> SummaryStartLinkBlock | None:
    """The refusal for making ``task`` a summary, or ``None`` when it may become one.

    One indexed query on the ``predecessor`` FK, run only by a caller that has
    established ``task`` is about to gain its first child — so a restructure that
    does not create a summary pays nothing.

    Every live edge counts, cross-project ones included: the program schedule
    expands cross-project edges through the same summary rule and refuses them the
    same way. A successor outside ``task``'s project is not named, because the
    caller is authorized on this project and not necessarily on that one; it is
    still listed by link id so a client can offer to retype or delete the link,
    which the caller may do — the link's predecessor is a task in this project.
    """
    from trueppm_api.apps.projects.models import Dependency

    links = list(
        Dependency.live.filter(
            predecessor_id=task.pk, dep_type__in=sorted(SUMMARY_FORBIDDEN_LINK_TYPES)
        )
        .select_related("successor")
        .only("id", "dep_type", "successor_id", "successor__name", "successor__project_id")
        .order_by("successor__name", "pk")
    )
    if not links:
        return None

    described: list[str] = []
    payload: list[dict[str, Any]] = []
    for link in links:
        same_project = link.successor.project_id == task.project_id
        payload.append(
            {
                "id": str(link.pk),
                "dep_type": link.dep_type,
                "successor_id": str(link.successor_id) if same_project else None,
            }
        )
        successor = (
            f"“{printable_label(link.successor.name)}”"
            if same_project
            else "a task in another project"
        )
        described.append(f"{successor} ({link.dep_type})")

    named = ", ".join(described[:MAX_NAMED_LINKS])
    if len(described) > MAX_NAMED_LINKS:
        named += f" and {len(described) - MAX_NAMED_LINKS} more"
    detail = (
        f"“{printable_label(task.name)}” cannot become a summary task: it drives {named} "
        "with a Start-to-Start or Start-to-Finish link, and a summary cannot drive a "
        "successor from its start. Change those links to Finish-to-Start or "
        "Finish-to-Finish, or delete them, first."
    )
    return SummaryStartLinkBlock(detail=detail, blocking_dependencies=payload)


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
