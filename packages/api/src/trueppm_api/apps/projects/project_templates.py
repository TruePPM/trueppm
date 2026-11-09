"""Project template structure: extract from a project, materialize into one (ADR-0789, #2729).

The whole point of this module is the pair of functions at the bottom, and the
asymmetry between them:

* :func:`extract_structure` reads a project and produces a **frozen document**. It
  is the gate that strips moment and person — every field it declines to copy is a
  live defect if carried, not merely noise (ADR-0789 §1).
* :func:`materialize_structure` reads that document and writes rows into a
  *different* project, resolving durations against *that* project's calendar and
  start date.

Nothing here calls Celery, touches a request, or knows about permissions. The task
in ``template_tasks.py`` supplies the transaction and the claim; the viewset
supplies the RBAC. Keeping this layer pure is what makes the seeding logic testable
without a broker.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from django.utils import timezone

from trueppm_api.apps.projects.wbs_paths import offset_wbs_path, root_ordinal_offset

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project, ProjectTemplate, Task

#: Current structure-document version. Bumped when the shape changes
#: incompatibly; ``materialize_structure`` refuses a version it does not know
#: rather than guessing at a field it has never seen.
STRUCTURE_VERSION = 1

#: Hard ceiling on nodes in one template, mirroring the seed importer's
#: ``MAX_SEED_NODES``. ``structure`` is JSONB, so the seeding job could otherwise
#: be handed an arbitrarily large document by any path that reaches the database.
MAX_TEMPLATE_NODES = 2000

#: What a template is allowed to carry, and therefore what ``carries`` reports.
#: This list is the human-readable face of the strip rules — it is published with
#: the template so an adopter can see what they are getting *before* they adopt.
CARRIES_STRUCTURE = "structure"
CARRIES_DEPENDENCIES = "dependencies"
CARRIES_DURATIONS = "durations"
CARRIES_MILESTONES = "milestones"
CARRIES_DELIVERY_MODES = "delivery_modes"
CARRIES_SPRINT_LENGTH = "sprint_length"


class TemplateStructureError(ValueError):
    """The structure document is unusable — malformed, too large, or a version we don't know."""


@dataclass(frozen=True)
class MaterializeResult:
    """What one apply wrote — the undo set, plus the counts the seed banner shows.

    ``milestones_created`` / ``dependencies_created`` are read off the rows and edges
    :func:`materialize_structure` already built in memory (ADR-0799 §2) — never a
    second query. The seed banner (#2731) reads these off
    ``TemplateApplication.result_summary`` rather than re-deriving them client-side
    from the full task list, which would be a second, driftable definition of the same
    counts the server already knows at write time.
    """

    task_ids: list[uuid.UUID]
    milestones_created: int
    dependencies_created: int
    #: One sentence per edge the document carried but this apply did not write — today
    #: only an SS/SF link out of a summary, which ADR-0370 forbids and the CPM refuses
    #: (#4830). Surfaced in ``result_summary["warnings"]`` so the skip is not silent.
    warnings: list[str] = field(default_factory=list)


def _task_node(task: Any) -> dict[str, Any]:
    """Serialize one task into its template node — shape only.

    Every field NOT copied here is a deliberate strip, and the reasons are
    different for each class (ADR-0789 §1):

    * ``assignee`` / ``TaskResource`` — the publisher's teammates are not the
      adopter's. A user id from another workspace is unresolvable, or resolvable to
      the wrong person.
    * ``planned_start`` / ``actual_*`` / ``early_*`` / ``baseline_*`` — a template
      applied in November must not schedule to the publisher's March. Dates come
      from the adopter's Start sheet and calendar, computed at apply time.
    * ``percent_complete`` / ``status`` — progress on work nobody has done.
    * comments, files, time entries — somebody else's conversation and evidence,
      re-attributed to work that has not happened.

    ``duration`` IS carried: it is an estimate of effort, a property of the shape,
    not of when the shape ran.
    """
    return {
        "ref": str(task.id),
        "name": task.name,
        "wbs_path": str(task.wbs_path) if task.wbs_path else None,
        "duration": task.duration,
        "is_milestone": task.is_milestone,
        "delivery_mode": task.delivery_mode,
        "governance_class": task.governance_class,
        "type": task.type,
        "is_subtask": task.is_subtask,
        "notes": task.notes or "",
    }


def extract_structure(project: Project) -> dict[str, Any]:
    """Freeze ``project``'s shape into a template structure document.

    Reads committed, non-deleted tasks in WBS order plus the dependency edges
    between them. Edges are recorded in **ref space** (the source task ids used as
    opaque labels), not in pk space — ``materialize_structure`` relabels them onto
    the rows it creates, so the document never carries a foreign key into a project
    the adopter cannot see.

    Recurring tasks are excluded for the same reason CPM excludes them (ADR-0090):
    they are calendar-driven parallel activities, not schedulable shape, and a
    template that seeded them would seed a recurrence rule with no owner and no
    anchor date.
    """
    from trueppm_api.apps.projects.models import Dependency, Task

    tasks = list(
        Task.objects.filter(project=project, is_deleted=False, is_recurring=False).order_by(
            "wbs_path", "name"
        )
    )
    if len(tasks) > MAX_TEMPLATE_NODES:
        raise TemplateStructureError(
            f"Project has {len(tasks)} tasks; a template carries at most {MAX_TEMPLATE_NODES}."
        )

    task_ids = {t.id for t in tasks}
    edges = [
        {
            "predecessor": str(dep.predecessor_id),
            "successor": str(dep.successor_id),
            "dep_type": dep.dep_type,
            "lag": dep.lag,
        }
        # Both endpoints must be inside the extracted set. A cross-project edge has
        # no meaning in a template — the other project is not coming along — so it is
        # dropped rather than dangled.
        for dep in Dependency.objects.filter(
            predecessor__project=project, is_deleted=False
        ).select_related(None)
        if dep.predecessor_id in task_ids and dep.successor_id in task_ids
    ]

    carries = [CARRIES_STRUCTURE]
    if edges:
        carries.append(CARRIES_DEPENDENCIES)
    if any(t.duration for t in tasks):
        carries.append(CARRIES_DURATIONS)
    if any(t.is_milestone for t in tasks):
        carries.append(CARRIES_MILESTONES)
    if any(t.delivery_mode for t in tasks):
        carries.append(CARRIES_DELIVERY_MODES)

    sprint_length = getattr(project, "sprint_length_days", None)
    if sprint_length:
        carries.append(CARRIES_SPRINT_LENGTH)

    return {
        "version": STRUCTURE_VERSION,
        "extracted_at": timezone.now().isoformat(),
        "methodology": project.methodology,
        "sprint_length_days": sprint_length,
        "tasks": [_task_node(t) for t in tasks],
        "dependencies": edges,
        "carries": carries,
    }


def summarize_structure(structure: dict[str, Any]) -> dict[str, Any]:
    """The counts a publisher is shown before, and inside, the publish form (#2909).

    Derived from the frozen document rather than re-queried from the project, for
    the same reason ``task_count`` is: the document is what ``apply`` will
    actually write, so a number read off it can never disagree with the outcome.
    Computing these in the client would let a collapsed or filtered Grid report a
    wrong count in the one place people trust it.

    A *phase* is a node with at least one structural descendant, mirroring
    ``task_is_phase`` — read here off ``wbs_path`` prefixes, since the document
    carries paths and not parent links. A *gate* is a gated milestone: the
    hold points a PMO is actually counting.
    """
    tasks = [t for t in structure.get("tasks", []) if isinstance(t, dict)]
    paths = [str(t.get("wbs_path") or "") for t in tasks]

    phases = 0
    for node in tasks:
        path = str(node.get("wbs_path") or "")
        if not path or node.get("is_subtask"):
            continue
        if any(other != path and other.startswith(f"{path}.") for other in paths):
            phases += 1

    return {
        "task_count": len(tasks),
        "phase_count": phases,
        "gate_count": sum(
            1 for t in tasks if t.get("is_milestone") and t.get("governance_class") == "gated"
        ),
        "milestone_count": sum(1 for t in tasks if t.get("is_milestone")),
        "dependency_count": len(structure.get("dependencies") or []),
        "methodology": structure.get("methodology"),
        "carries": list(structure.get("carries") or []),
    }


def _validate_structure_envelope(structure: Any) -> tuple[dict[str, Any], list[Any]]:
    """Check the document wrapper; return the narrowed document and its task list."""
    if not isinstance(structure, dict):
        raise TemplateStructureError("Structure must be an object.")
    version = structure.get("version")
    if version != STRUCTURE_VERSION:
        # Refuse rather than guess: an unknown version means fields we have never
        # seen, and materializing it would write rows nobody designed.
        raise TemplateStructureError(
            f"Unsupported structure version {version!r} (this server writes v{STRUCTURE_VERSION})."
        )
    tasks = structure.get("tasks")
    if not isinstance(tasks, list):
        raise TemplateStructureError("Structure has no task list.")
    if len(tasks) > MAX_TEMPLATE_NODES:
        raise TemplateStructureError(
            f"Structure carries {len(tasks)} tasks; the ceiling is {MAX_TEMPLATE_NODES}."
        )
    return structure, tasks


def _validate_task_nodes(tasks: list[Any]) -> set[str]:
    """Check every task node and return the set of refs they declare."""
    refs: set[str] = set()
    for node in tasks:
        if not isinstance(node, dict) or not node.get("name"):
            raise TemplateStructureError("Every task node needs a name.")
        ref = node.get("ref")
        if not ref or ref in refs:
            raise TemplateStructureError("Every task node needs a unique ref.")
        refs.add(str(ref))
        _validate_task_node_values(node)
    return refs


def _validate_task_node_values(node: dict[str, Any]) -> None:
    """Refuse a node whose enum or milestone state could not exist on a real task.

    ``_build_template_task_row`` assigns these straight onto an unsaved ``Task`` and
    ``bulk_create`` skips ``full_clean``; Django emits no CHECK for ``choices``, so
    nothing downstream would catch a bad value. Absent keys are fine: the writer
    leaves them at the model default (``waterfall`` / ``flow`` / ``task`` /
    not-a-milestone), so the coupling below is evaluated on the *effective* values.
    Only the ``is_milestone`` <=> ``delivery_mode == milestone`` coupling and
    ``milestone => duration == 0`` are enforced; a zero-duration *non*-milestone is a
    legitimate row (an unscheduled idea, a phase whose duration rolls up).
    """
    from trueppm_api.apps.projects.models import (
        MAX_TASK_DURATION_DAYS,
        DeliveryMode,
        GovernanceClass,
        TaskType,
    )

    ref = node["ref"]
    # A legacy source row can fail these checks at publish time, where the user only
    # knows the task by name and WBS position, not by its ref (a UUID).
    label = f"Task {ref!r}"
    if node.get("name"):
        # Bounded and repr'd: both values come from a JSONB document that may have
        # been hand-edited, and they end up in a 400 body.
        name = str(node["name"])
        name = name if len(name) <= 80 else name[:79] + "\u2026"
        label += f" ({name!r}"
        label += f", WBS {str(node['wbs_path'])[:80]!r})" if node.get("wbs_path") else ")"
    for attr, choices in (
        ("delivery_mode", DeliveryMode),
        ("governance_class", GovernanceClass),
        ("type", TaskType),
    ):
        value = node.get(attr)
        if value and value not in choices.values:
            raise TemplateStructureError(f"{label} has an unrecognized {attr} {value!r}.")

    is_milestone = node.get("is_milestone")
    if is_milestone is not None and not isinstance(is_milestone, bool):
        raise TemplateStructureError(f"{label} has a non-boolean is_milestone.")
    duration = node.get("duration")
    if duration is not None and (
        isinstance(duration, bool)
        or not isinstance(duration, int)
        or not 0 <= duration <= MAX_TASK_DURATION_DAYS
    ):
        raise TemplateStructureError(
            f"{label} has an invalid duration; it must be a whole number of days "
            f"from 0 to {MAX_TASK_DURATION_DAYS}."
        )

    is_milestone_mode = (node.get("delivery_mode") or DeliveryMode.WATERFALL) == (
        DeliveryMode.MILESTONE
    )
    if bool(is_milestone) != is_milestone_mode:
        raise TemplateStructureError(
            f"{label}: is_milestone and delivery_mode 'milestone' must agree."
        )
    if is_milestone and duration:
        raise TemplateStructureError(f"{label} is a milestone and must have duration 0.")


def _validate_dependency_edges(edges: Any, refs: set[str]) -> None:
    """Check every dependency edge resolves to a task node in the same document."""
    for edge in edges or []:
        if not isinstance(edge, dict):
            raise TemplateStructureError("Every dependency must be an object.")
        # A dangling edge would silently vanish at materialize time, so the
        # template would apply "successfully" while quietly dropping the structure
        # the adopter chose it for.
        if str(edge.get("predecessor")) not in refs or str(edge.get("successor")) not in refs:
            raise TemplateStructureError("Dependency references a task not in this template.")


def validate_structure(structure: Any) -> dict[str, Any]:
    """Check a structure document before it is turned into somebody's rows.

    Run at publish **and again at apply**. The second run is not belt-and-braces:
    ``structure`` is a JSONB column, so a template row can be edited by any path
    that reaches the database, and the apply job is the one that turns it into rows
    in a project. Validating only on the way in would trust a value that a
    different writer may have replaced.
    """
    document, tasks = _validate_structure_envelope(structure)
    refs = _validate_task_nodes(tasks)
    _validate_dependency_edges(document.get("dependencies"), refs)
    _validate_dependency_graph(document)
    return document


def _validate_dependency_graph(document: dict[str, Any]) -> None:
    """Refuse a document whose links are cyclic or join a summary to its own subtask.

    ``materialize_structure`` bulk-creates the edges, bypassing the serializer's
    cycle check, so a template carrying such a link would otherwise be copied into
    every adopter and fail every recalculation there (#4856). Runs from
    ``validate_structure``, which the publish and preview actions call on the freshly
    extracted structure and the apply action and ``materialize_structure`` call on the
    stored one. The
    summary shape comes from the engine's own ``build_children_map`` over the
    document's ``wbs_path`` values. SS/SF links out of a summary are left out of the
    check: materialize skips them with a warning rather than refusing the template.
    """
    from types import SimpleNamespace

    from trueppm_scheduler import InvalidScheduleInput

    from trueppm_api.apps.scheduling.graph_guard import (
        InfeasibleGraphError,
        find_summary_start_links,
        validate_task_graph,
    )
    from trueppm_api.apps.scheduling.services import build_children_map

    triples = [
        (str(e["predecessor"]), str(e["successor"]), str(e.get("dep_type") or "FS"))
        for e in document.get("dependencies") or []
    ]
    if not triples:
        return
    children_map = build_children_map(
        [SimpleNamespace(id=str(n["ref"]), wbs_path=n.get("wbs_path")) for n in document["tasks"]]
    )
    dropped = set(find_summary_start_links(triples, children_map.keys()))
    edges = [(p, s) for p, s, t in triples if (p, s, t) not in dropped]
    try:
        validate_task_graph(edges, children_map=children_map)
    except (InfeasibleGraphError, InvalidScheduleInput) as exc:
        raise TemplateStructureError(
            "This template's dependencies form a cycle, or link a summary task to one of "
            "its own subtasks, so it cannot be scheduled. Fix the links in the source "
            "project and publish again."
        ) from exc


def _build_template_task_row(
    node: dict[str, Any],
    *,
    project: Project,
    template: ProjectTemplate,
    short_id: str,
    seeded_at: Any,
    wbs_offset: int = 0,
) -> Task:
    """Build one unsaved ``Task`` from a template node.

    No dates are written: durations are carried and the schedule comes from the
    adopter's calendar via the CPM pass the caller enqueues afterwards. Writing the
    publisher's dates here is the defect ADR-0789 §1 exists to prevent.
    """
    from trueppm_api.apps.projects.models import Task, TaskSource

    row = Task(
        project=project,
        name=str(node["name"])[:512],
        duration=int(node.get("duration") or 0),
        is_milestone=bool(node.get("is_milestone")),
        notes=str(node.get("notes") or ""),
        short_id=short_id,
        wbs_path=offset_wbs_path(node.get("wbs_path"), wbs_offset),
        server_version=1,
    )
    for attr in ("delivery_mode", "governance_class", "type"):
        value = node.get(attr)
        if value:
            setattr(row, attr, value)
    if node.get("is_subtask"):
        row.is_subtask = True
    # Seed provenance (ADR-0786, #2730). edited_at is deliberately left null:
    # a machine wrote this row and nobody has touched it, which is exactly what
    # makes it eligible for the "Delete untouched rows (N)" sweep — and what
    # lets undo tell a seeded row from one somebody has since typed into.
    row.source_kind = TaskSource.TEMPLATE
    row.source_id = template.id
    row.source_version = str(template.version)
    row.seeded_at = seeded_at
    return row


def materialize_structure(
    template: ProjectTemplate,
    project: Project,
    *,
    applied_by: Any = None,
) -> MaterializeResult:
    """Write ``template``'s shape into ``project`` and return what was written.

    Returns ids rather than objects because the caller stores them on the
    ``TemplateApplication`` row — they are the undo set, and undo must be exact. The
    milestone/dependency counts travel alongside for the same reason (ADR-0799 §2):
    the caller writes them straight into ``result_summary`` for the seed banner.

    Three things this deliberately does NOT do:

    * **No dates are written.** Durations are carried; the schedule comes from the
      adopter's calendar via the CPM pass the caller enqueues afterwards. Writing
      the publisher's dates here is the defect ADR-0789 §1 exists to prevent.
    * **No `save()` per row.** ``bulk_create`` for the same reason the seed importer
      uses it — but that bypasses ``VersionedModel.save()``, so ``server_version``
      and the ``sync_seq`` delta cursor are stamped explicitly below. A row left at
      ``sync_seq = 0`` sits below every checkpoint and is invisible to every offline
      client forever, and it fails silently.
    * **No CPM.** The caller enqueues a recalculation through
      ``scheduling.services.enqueue_recalculate`` once the rows commit.
    """
    from trueppm_api.apps.projects.models import (
        Dependency,
        bulk_create_tasks,
        draw_project_sequence,
    )
    from trueppm_api.apps.projects.summary_link_guard import (
        skipped_link_warning,
        split_summary_start_links,
        summary_ids_from_paths,
    )
    from trueppm_api.apps.sync.sequence import allocate_for_projects

    structure = validate_structure(template.structure)
    nodes = structure["tasks"]
    if not nodes:
        return MaterializeResult(task_ids=[], milestones_created=0, dependencies_created=0)

    # Allocate a contiguous short_id block in one UPDATE, exactly as the MS Project
    # importer does — per-row allocation would be N round-trips and the per-project
    # unique constraint rejects the second blank one.
    count = len(nodes)
    end_seq = draw_project_sequence(project.pk, "object_sequence", by=count)
    start_seq = end_seq - count + 1

    seeded_at = timezone.now()
    # Second and later adoptions append past the rows already there rather than
    # writing onto their paths (#3061). Zero for an empty project, so a first
    # adoption keeps the document's paths verbatim.
    wbs_offset = root_ordinal_offset(
        project.pk, document_paths=[node.get("wbs_path") for node in nodes]
    )
    ref_to_task: dict[str, Task] = {}
    rows: list[Task] = []
    for i, node in enumerate(nodes):
        row = _build_template_task_row(
            node,
            project=project,
            template=template,
            short_id=f"{start_seq + i:06X}"[-8:],
            seeded_at=seeded_at,
            wbs_offset=wbs_offset,
        )
        rows.append(row)
        ref_to_task[str(node["ref"])] = row

    # One cursor for the whole batch: the rows are created together and the delta
    # filter is `> since`, which ``coalesce_sync_seq``'s contract explicitly permits.
    seq = allocate_for_projects([str(project.pk)])
    for row in rows:
        row.sync_seq = seq

    # `bulk_create_tasks`, not `Task.objects.bulk_create`: a template's phase rows
    # have children the moment they land, and `bulk_create` never reaches the
    # declaration that `Task.save()` paths run — so a materialized template used to
    # arrive with every phase as `structure_role='work'` (#3030). With #2909's
    # bundled starters this is a first-run path.
    bulk_create_tasks(rows, batch_size=500)

    # Relabel the ref-space edges onto the rows just created. A missing endpoint is
    # impossible here — validate_structure rejects a dangling edge — but the lookup
    # is guarded anyway so a malformed row can never raise mid-batch and abort an
    # otherwise good application.
    edges = [
        Dependency(
            predecessor=ref_to_task[str(e["predecessor"])],
            successor=ref_to_task[str(e["successor"])],
            dep_type=e.get("dep_type") or "FS",
            lag=int(e.get("lag") or 0),
            server_version=1,
            sync_seq=seq,
        )
        for e in structure.get("dependencies") or []
        if str(e.get("predecessor")) in ref_to_task and str(e.get("successor")) in ref_to_task
    ]
    # ADR-0370 (#4830): a template extracted from a project that already held an
    # SS/SF link out of a summary — or a document edited in the JSONB column — would
    # otherwise seed a plan the CPM refuses on every recalculation. Skip and report.
    edges, skipped = split_summary_start_links(
        edges, summary_ids_from_paths((row.pk, row.wbs_path) for row in rows)
    )
    by_id = {str(row.pk): row.name for row in rows}
    warnings = [
        skipped_link_warning(
            by_id.get(str(dep.predecessor_id), "unknown task"),
            by_id.get(str(dep.successor_id), "unknown task"),
            str(dep.dep_type),
        )
        for dep in skipped
    ]
    if edges:
        Dependency.objects.bulk_create(edges, batch_size=500, ignore_conflicts=True)

    return MaterializeResult(
        task_ids=[row.id for row in rows],
        milestones_created=sum(1 for row in rows if row.is_milestone),
        dependencies_created=len(edges),
        warnings=warnings,
    )
