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
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

from trueppm_api.apps.scheduling.graph_guard import (
    SUMMARY_FORBIDDEN_LINK_TYPES,
    find_summary_start_links,
    printable_label,
)

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Task


class _EdgeLike(Protocol):
    """What :func:`split_summary_start_links` reads off an unsaved ``Dependency``."""

    predecessor_id: Any
    successor_id: Any
    dep_type: Any


DependencyT = TypeVar("DependencyT", bound=_EdgeLike)

#: Stable machine code for the refusal, shared by every structural endpoint.
SUMMARY_START_LINK_CODE = "summary_start_link"

#: Most links a refusal names before collapsing the rest into a count — the message is
#: prose a person reads, and the full list travels in ``blocking_dependencies``.
MAX_NAMED_LINKS = 3

#: OpenAPI fragment for the ``blocking_dependencies`` key of the refusal body, for the
#: endpoints that declare their 400 with ``state_refusal_400(extra_properties=...)``.
BLOCKING_DEPENDENCIES_SCHEMA: dict[str, Any] = {
    "blocking_dependencies": {
        "type": "array",
        "description": (
            "Present only with code ``summary_start_link``: every Start-to-Start or "
            "Start-to-Finish link that stops the task becoming a summary (ADR-0370). "
            "``successor_id`` is null when the successor is in another project."
        ),
        "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "format": "uuid"},
                "dep_type": {"type": "string", "enum": ["SS", "SF"]},
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

    def body(self) -> dict[str, Any]:
        """The ``{code, detail, blocking_dependencies}`` body the WBS endpoints return."""
        return {
            "code": SUMMARY_START_LINK_CODE,
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
