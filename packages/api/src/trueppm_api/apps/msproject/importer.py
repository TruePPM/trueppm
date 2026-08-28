"""Import parsed MS Project data into TruePPM models."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from trueppm_api.apps.msproject.dataclasses import (
    CONSTRAINT_TYPES_APPLIED_AS_SNET,
    CalendarData,
    ProjectData,
    TaskData,
)
from trueppm_api.apps.sync.sequence import allocate_for_projects

if TYPE_CHECKING:
    from trueppm_api.apps.scheduling.graph_guard import InfeasibleGraphError

logger = logging.getLogger(__name__)


def import_project(
    project_id: str,
    data: ProjectData,
    tracker: Any = None,
    wipe_existing: bool = False,
    *,
    source_kind: str | None = None,
    source_id: Any = None,
) -> dict[str, Any]:
    """Import parsed MS Project data into a TruePPM project.

    Creates tasks, dependencies, resources, and assignments using bulk operations
    to bypass django-simple-history (per ADR-0011).

    Args:
        project_id: UUID string of the target Project.
        data: Parsed ProjectData from the MS Project file.
        tracker: Optional TaskRunTracker for progress reporting.
        wipe_existing: When True (create-from-import, ADR-0092), delete the
            project's existing tasks before bulk-create so an orphan-drain
            re-dispatch converges instead of duplicating. The default (False)
            keeps the import-into-existing-project path additive — and, since
            #3069, also shifts the file's WBS numbering past the rows already in
            the project instead of writing onto them.
        source_kind: Seed provenance stamped on every created row (ADR-0786,
            #2730). Defaults to ``TaskSource.MSPROJECT_IMPORT``; the CSV/Excel
            wizard reuses this whole path (``csvimport/tasks.py``) and passes
            ``TaskSource.CSV_IMPORT`` so the two are distinguishable afterwards.
        source_id: Id of the import job that wrote these rows, for the divergence
            digest. ``None`` for a path with no persisted job row.

    Returns:
        Summary dict for result_summary. ``task_count`` and ``project_start_date``
        feed the post-import summary the UI shows on the project landing.
    """
    from django.conf import settings

    from trueppm_api.apps.projects.models import Task

    # Chunk every bulk_create (#1721) so a large import is not emitted as one
    # unbounded multi-row INSERT (which pins the whole set in a single statement
    # and can blow PostgreSQL's parameter limit). Paired with the parser row cap.
    batch_size = getattr(settings, "IMPORT_BULK_BATCH_SIZE", 500)

    def _update(pct: int, msg: str) -> None:
        if tracker is not None:
            tracker.update(pct, msg)

    _update(5, "Preparing import...")
    summary = _init_summary(data)

    if wipe_existing:
        # Safe because the project was created empty for this import (ADR-0092);
        # only a partial prior attempt could leave rows. Dependency/TaskResource
        # cascade off Task, so deleting tasks clears the prior attempt.
        Task.objects.filter(project_id=project_id).delete()

    # --- Step 0: Apply the file's calendar (#1769) ---
    # Runs before the no-tasks early return: the calendar is header-level plan
    # data (like name/start_date) and applies even to a file with no tasks.
    _update(8, "Applying project calendar...")
    _apply_calendar(project_id, data, summary, overwrite=wipe_existing, batch_size=batch_size)

    if not data.tasks:
        summary["warnings"].append("No tasks found in file")
        return summary

    # --- Step 1: Create or match resources ---
    _update(10, "Matching resources...")
    resource_uid_to_pk = _import_resources(data, summary, batch_size=batch_size)

    # --- Step 2: Create tasks ---
    _update(30, f"Creating {len(data.tasks)} tasks...")
    task_objects = _create_tasks(
        project_id,
        data,
        summary,
        batch_size=batch_size,
        source_kind=source_kind,
        source_id=source_id,
        wipe_existing=wipe_existing,
    )
    task_uid_to_pk = {td.uid: str(task_objects[i].pk) for i, td in enumerate(data.tasks)}
    # ADR-0810 (#2756, CSV path only): every row this import wrote, so the caller
    # can record the ⌘Z undo ledger. Harmless for the MS Project path, which has
    # no undo affordance today and simply ignores the key.
    summary["created_task_ids"] = [str(t.pk) for t in task_objects]

    # --- Step 3: Create dependencies ---
    _update(50, "Creating dependencies...")
    _import_dependencies(
        data, task_uid_to_pk, summary, project_id=project_id, batch_size=batch_size
    )

    # --- Step 4: Create resource assignments ---
    _update(70, "Creating resource assignments...")
    _import_assignments(
        project_id, data, task_uid_to_pk, resource_uid_to_pk, summary, batch_size=batch_size
    )

    # --- Step 5: Attach labels ---
    _update(80, "Attaching labels...")
    _import_labels(project_id, data, task_uid_to_pk, summary, batch_size=batch_size)

    _update(90, "Import complete, triggering schedule recalculation...")
    return summary


def _init_summary(data: ProjectData) -> dict[str, Any]:
    """Build the zeroed result-summary dict, seeded from the parsed file."""
    summary: dict[str, Any] = {
        "tasks_created": 0,
        "task_count": 0,
        "dependencies_created": 0,
        "resources_matched": 0,
        "resources_created": 0,
        "assignments_created": 0,
        # Three-point / PERT counts (#798, ADR-0093). The UI uses these to
        # confirm e.g. "3-point estimates imported for 17 of 23 work tasks".
        # ``tasks_with_three_point_estimates`` includes only tasks that
        # actually received all three values; ``tasks_skipped_partial_three_point``
        # counts tasks the parser dropped to None because the file only
        # supplied a subset.
        "tasks_with_three_point_estimates": 0,
        "tasks_skipped_partial_three_point": 0,
        # Calendar mapping (#1769). ``calendar_applied`` is True when the file's
        # calendar was wired as Project.calendar (created or matched);
        # ``calendar_created``/``calendar_matched`` say which path produced it.
        "calendar_applied": False,
        "calendar_name": None,
        "calendar_created": False,
        "calendar_matched": False,
        "project_start_date": data.start_date,
        # #873/#867: set True when an imported task predated the project start and
        # the start was pulled back. The import task broadcasts project_updated so
        # live collaborators on an existing project re-fetch the moved boundary.
        "project_start_shifted": False,
        # Label attach counts (#2406, ADR-0400). ``labels_matched`` are catalog
        # entries the file reused; ``labels_created`` are ones it minted.
        "labels_matched": 0,
        "labels_created": 0,
        "label_assignments_created": 0,
        "warnings": list(data.warnings),
    }
    # Count tasks the parser warned about for partial PERT data; the warning
    # text is the canonical marker (the parser dropped values to None before
    # we got here, so we can't tell from the dataclass alone).
    summary["tasks_skipped_partial_three_point"] = sum(
        1 for w in data.warnings if "partial three-point estimate" in w
    )
    return summary


def broadcast_import_project_record_change(project_id: str, summary: dict[str, Any]) -> None:
    """Broadcast ``project_updated`` when an import moved project-record state.

    Two things an import can change live outside the task tree: the project's
    ``start_date`` (pulled back when an imported task predates it, #867/#873) and
    ``Project.calendar`` (#1769). Neither is invalidated by the recalc's
    ``cpm_complete`` or by ``tasks_restructured`` — both of those speak about
    tasks — so without this a collaborator watching the Gantt sees the whole
    schedule shift under them with no signal and no attribution.

    Deferred with ``transaction.on_commit`` so a rolled-back import never tells
    peers a boundary moved. Callers invoke this *after* the import's ``atomic()``
    block has committed, at which point no ambient transaction remains and the
    callback fires immediately.

    Shared by all three import wrappers on purpose. MS Project, CSV and Jira all
    run this same ``import_project``, but each had its own task module, and the
    #873 broadcast was added to one of them and never reached the other two —
    CSV and Jira shifted the start silently for three releases (#2610). A fork
    with three call sites and one behavior is a drift waiting to happen; there is
    now one site.
    """
    if not (summary.get("project_start_shifted") or summary.get("calendar_applied")):
        return

    from django.db import transaction

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    transaction.on_commit(
        lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
    )


def _import_labels(
    project_id: str,
    data: ProjectData,
    task_uid_to_pk: dict[int, str],
    summary: dict[str, Any],
    *,
    batch_size: int,
) -> None:
    """Match-or-create the file's label names in the project catalog and attach them.

    Matching is **case-insensitive against the project's existing catalog**
    (ADR-0400 scopes ``Label`` to a project), so re-importing a sheet that says
    ``Safety`` into a project that already has ``safety`` reuses the existing
    entry instead of minting a near-duplicate the operator then has to merge.
    The existing spelling wins on a match — the catalog is curated, the
    spreadsheet is not.

    Idempotent across re-import in both directions: labels resolve by name, and
    the ``TaskLabel`` rows use ``ignore_conflicts`` against the
    ``unique(task, label)`` constraint, so a second run of the same file creates
    nothing new.
    """
    from trueppm_api.apps.projects.models import Label, LabelColor, TaskLabel

    wanted: dict[str, str] = {}
    for td in data.tasks:
        for name in td.labels:
            wanted.setdefault(name.lower(), name)
    if not wanted:
        return

    existing = {
        label.name.lower(): label
        for label in Label.objects.filter(project_id=project_id, is_deleted=False)
    }
    summary["labels_matched"] = sum(1 for key in wanted if key in existing)

    # Colors cycle the palette from the end of the current catalog, so an import
    # of several labels produces a distinguishable set rather than a wall of the
    # default. Position continues the catalog's order for the same reason.
    palette = [choice[0] for choice in LabelColor.choices]
    start = len(existing)
    new_labels = [
        Label(
            project_id=project_id,
            name=wanted[key],
            color=palette[(start + offset) % len(palette)],
            position=start + offset,
        )
        for offset, key in enumerate(k for k in wanted if k not in existing)
    ]
    if new_labels:
        # bulk_create bypasses VersionedModel.save(), so these rows draw no delta
        # cursor of their own and would sit at sync_seq=0 — below every checkpoint,
        # and so never delivered to an offline client. `labels` is its own sync
        # collection, so it needs the same one-value-per-import treatment the task
        # rows get above (ADR-0686). The post-import recalculation cannot stand in
        # for this: it writes through bulk_update and allocates nothing.
        seq = allocate_for_projects([project_id])
        for label in new_labels:
            label.sync_seq = seq
        Label.objects.bulk_create(new_labels, batch_size=batch_size)
        summary["labels_created"] = len(new_labels)
        existing.update({label.name.lower(): label for label in new_labels})

    assignments = [
        TaskLabel(task_id=task_uid_to_pk[td.uid], label=existing[name.lower()])
        for td in data.tasks
        if td.uid in task_uid_to_pk
        for name in td.labels
        if name.lower() in existing
    ]
    if assignments:
        TaskLabel.objects.bulk_create(assignments, batch_size=batch_size, ignore_conflicts=True)
        summary["label_assignments_created"] = len(assignments)


def _import_resources(
    data: ProjectData, summary: dict[str, Any], *, batch_size: int
) -> dict[int, str]:
    """Match parsed resources to the shared library by name, creating the rest.

    Returns a map from the file's resource UID to the TruePPM Resource PK.
    """
    from trueppm_api.apps.resources.models import Resource

    resource_uid_to_pk: dict[int, str] = {}
    if not data.resources:
        return resource_uid_to_pk

    existing = {r.name.lower(): r for r in Resource.objects.all()}
    new_resources: list[Resource] = []

    for rd in data.resources:
        name_lower = rd.name.lower()
        if name_lower in existing:
            resource_uid_to_pk[rd.uid] = str(existing[name_lower].pk)
            summary["resources_matched"] += 1
        else:
            new_resources.append(Resource(name=rd.name, max_units=rd.max_units))

    if new_resources:
        Resource.objects.bulk_create(new_resources, batch_size=batch_size)
        summary["resources_created"] = len(new_resources)
        _map_created_resource_pks(data, resource_uid_to_pk)
    return resource_uid_to_pk


def _map_created_resource_pks(data: ProjectData, resource_uid_to_pk: dict[int, str]) -> None:
    """Fill in PKs for the just-created resources by re-reading the library by name.

    bulk_create does not populate PKs on the passed instances for every backend, so
    the newly created rows are re-fetched and matched to their file UIDs by name.
    """
    from trueppm_api.apps.resources.models import Resource

    all_resources = {r.name.lower(): r for r in Resource.objects.all()}
    for rd in data.resources:
        if rd.uid not in resource_uid_to_pk:
            matched = all_resources.get(rd.name.lower())
            if matched:
                resource_uid_to_pk[rd.uid] = str(matched.pk)


def _create_tasks(
    project_id: str,
    data: ProjectData,
    summary: dict[str, Any],
    *,
    batch_size: int,
    source_kind: str | None = None,
    source_id: Any = None,
    wipe_existing: bool = False,
) -> list[Any]:
    """Bulk-create Task rows for the parsed tasks and return them in file order.

    Allocates a contiguous block of short_ids, computes WBS paths and summary-task
    membership once, builds each row, pulls the project start back if a task
    predates it, then bulk-creates. Returns the built Task objects so the caller
    can map file UIDs to persisted PKs.

    ``wipe_existing`` decides whether the file's own numbering is authoritative.
    On create-from-import the project was made empty for this file, so its paths
    are written verbatim. On import-into-existing they are shifted past the rows
    already there — see the offset block below.
    """
    from django.db.models import F
    from django.utils import timezone

    from trueppm_api.apps.projects.models import Project, Task, TaskSource, bulk_create_tasks
    from trueppm_api.apps.projects.wbs_paths import offset_wbs_path, root_ordinal_offset

    # Allocate a batch of short_ids: increment object_sequence by len(tasks)
    # in one UPDATE, then assign sequential hex IDs.
    task_count = len(data.tasks)
    Project.objects.filter(pk=project_id).update(object_sequence=F("object_sequence") + task_count)
    end_seq: int = Project.objects.values_list("object_sequence", flat=True).get(pk=project_id)
    start_seq = end_seq - task_count + 1

    wbs_paths = _build_wbs_paths(data.tasks)
    if not wipe_existing:
        # The file numbers its tasks from 1, which is only right for a project that
        # started empty. Importing a revised .mpp / CSV / Jira pull into a project
        # that already holds rows would otherwise write straight onto their paths
        # (#3069) — the same defect template adoption had in #3061, and the reason
        # `unique_task_wbs_path_per_project_live` now rejects it at COMMIT rather
        # than letting it silently collapse the next rewrite_level pass.
        #
        # Shifted before summary detection, not after, so both work off one set of
        # paths. The result is identical either way — `offset_wbs_path` moves only
        # the leading segment, so ancestor/descendant relationships are preserved —
        # but reading the same list twice is what keeps that true if either side
        # changes.
        offset = root_ordinal_offset(project_id, document_paths=wbs_paths)
        if offset:
            wbs_paths = [offset_wbs_path(path, offset) or path for path in wbs_paths]
    # Summary-task detection (ADR-0093 Q5): a task is a summary if any later
    # task's wbs_path is strictly descended from this one's. Computed once in
    # O(N) by sweeping the WBS paths and marking each strict ancestor present
    # in the prefix set. Three-point fields are NOT written on summary rows
    # because MS Project never populates them there; round-tripping them
    # would drift on re-export.
    summary_indices = _summary_indices(wbs_paths)

    task_objects: list[Task] = [
        _build_task_object(
            td, wbs_paths[i], i in summary_indices, project_id, start_seq + i, summary
        )
        for i, td in enumerate(data.tasks)
    ]

    _maybe_shift_project_start(project_id, data, summary)

    # bulk_create bypasses VersionedModel.save(), so nothing draws a delta cursor
    # for these rows — they would sit at sync_seq=0, below every checkpoint, and
    # never reach an offline client. One value for the whole import is right: the
    # rows are created together, and the delta is `> since` (ADR-0686).
    seq = allocate_for_projects([project_id])
    # Seed provenance (ADR-0786, #2730). Stamped on the instances rather than
    # after the fact because bulk_create never reaches Task.save() — which is also
    # why edited_at stays null here: a machine wrote these rows and no person has
    # touched them, which is precisely what makes them sweepable for seven days.
    seeded_at = timezone.now()
    kind = source_kind or TaskSource.MSPROJECT_IMPORT
    for task in task_objects:
        task.sync_seq = seq
        task.source_kind = kind
        task.source_id = source_id
        task.seeded_at = seeded_at

    # `bulk_create_tasks`, not `Task.objects.bulk_create`: a summary row here has
    # children and must land DECLARED a container, or the Board renders every
    # imported phase as a card (#3030). The summary indices computed above answer
    # the same question for the three-point gate, but the declaration is derived
    # inside the helper so this path and the restructure endpoints cannot drift.
    bulk_create_tasks(task_objects, batch_size=batch_size)
    summary["tasks_created"] = len(task_objects)
    summary["task_count"] = len(task_objects)
    return task_objects


def _build_task_object(
    td: TaskData,
    wbs_path: str,
    is_summary: bool,
    project_id: str,
    short_id_seq: int,
    summary: dict[str, Any],
) -> Any:
    """Construct a single Task row from parsed TaskData, applying the import-time
    invariants (three-point gating, milestone normalization, progress-anchor
    clamp) that bulk_create bypasses by skipping the TaskSerializer.
    """
    from trueppm_api.apps.projects.models import DeliveryMode, Task, TaskStatus

    # All-or-none gate (ADR-0093 Q3): the parser already enforces it, so
    # if any one of the three fields is set we know the other two are too.
    # Skip three-point write on summaries (Q5) and milestones (already
    # nulled by the parser, but kept defensive here).
    if is_summary or td.is_milestone:
        opt = ml = pess = None
        est_status = None
    else:
        opt = td.optimistic_duration_days
        ml = td.most_likely_duration_days
        pess = td.pessimistic_duration_days
        # estimate_status="accepted" on import (ADR-0093 Q4): the uploader
        # holds project-admin permission and the values are PM-authored
        # migration data, not contributor suggestions. Setting "pending"
        # would force re-approval per task under SUGGEST_APPROVE for no
        # governance benefit (the PM chose to import them).
        est_status = "accepted" if ml is not None else None
    if ml is not None:
        summary["tasks_with_three_point_estimates"] += 1
    # #1768: carry the source status onto Task.status so completed / in-flight
    # work does not re-import as NOT_STARTED (which the scheduler treats as
    # unstarted future work, inflating every forecast). Both importers populate
    # td.status upstream — the Jira parser from the issue status name, the MS
    # Project parser from the raw PercentComplete gated on start — so this path
    # is agnostic to the percent storage scale (#1759). Fall back to the model
    # default when the source supplied no usable status.
    task_status = td.status or TaskStatus.NOT_STARTED.value
    # Clamp percent to 0 when no start date — preserves the progress-anchor
    # invariant that bulk_create bypasses (ADR-0057 Q5). A .mpp file can encode
    # PercentComplete > 0 on an *unstarted* task; importing that value would
    # create a task with ghost progress and no schedule anchor. A task whose
    # status is terminal (REVIEW/COMPLETE) is not "unstarted" — its progress is
    # real completion, not ghost — so it keeps its percent even with no start
    # (the Jira path, which carries no dates), otherwise a COMPLETE issue would
    # persist at 0% and read as unstarted future work (#1768).
    _terminal = task_status in (TaskStatus.REVIEW.value, TaskStatus.COMPLETE.value)
    # "Has an anchor" is `_task_anchor(td)`, not `td.start`. Those were the same
    # condition until #2891: `planned_start` came only from `<Start>`, so a truthy
    # `td.start` was exactly "this task has a schedule anchor". Two new sources
    # broke that equivalence — `planned_start` can now come from a
    # `<ConstraintDate>`, and `actual_start` is imported — and an actual start is
    # the *strongest* anchor there is. Reading `td.start` here would force a real
    # in-progress task to 0% whenever the file pinned it by constraint instead of
    # by `<Start>`, which is the inverse of the invariant this clamp exists for.
    effective_percent = td.percent_complete if (_task_anchor(td) or _terminal) else 0
    return Task(
        project_id=project_id,
        name=td.name,
        wbs_path=wbs_path if wbs_path else None,
        # Milestone invariant (#1773): bulk_create bypasses the TaskSerializer
        # coupling, so enforce the canonical milestone state here — a milestone
        # is zero-duration and carries delivery_mode='milestone' so the phase
        # rollup weights it at 0. A source .mpp can encode a non-zero duration
        # on a <Milestone> task; importing it raw would violate the invariant
        # and the next PATCH would silently re-zero the duration and shift dates.
        duration=0 if td.is_milestone else td.duration_days,
        is_milestone=td.is_milestone,
        delivery_mode=DeliveryMode.MILESTONE if td.is_milestone else DeliveryMode.WATERFALL,
        status=task_status,
        percent_complete=effective_percent,
        notes=td.notes,
        planned_start=_resolve_planned_start(td),
        actual_start=td.actual_start,
        actual_finish=td.actual_finish,
        optimistic_duration=opt,
        most_likely_duration=ml,
        pessimistic_duration=pess,
        estimate_status=est_status,
        short_id=f"{short_id_seq:08X}",
    )


def _resolve_planned_start(td: TaskData) -> str | None:
    """Choose the SNET floor for an imported task: its constraint date, else Start.

    ``Task.planned_start`` is documented as *start no earlier than*, applied by
    the CPM forward pass — which is exactly what an MSPDI
    ``<ConstraintType>4</ConstraintType>`` plus ``<ConstraintDate>`` means. So
    when the file carries one of the codes TruePPM can express, the **constraint
    date wins over ``<Start>``** (#2891).

    That precedence is the point of the fix rather than a detail. ``<Start>`` is
    MS Project's *computed* schedule date; the constraint date is the commitment
    the PM made. Reading only ``<Start>`` meant a task whose commitment differed
    from its current computed start silently lost the commitment, and TruePPM then
    rescheduled from CPM alone — producing dates the PM could not defend at the
    next governance review.

    In the overwhelmingly common case the two agree (MS Project sets SNET
    automatically when a start is typed in), so this changes nothing; it matters
    precisely when they diverge, which is when the commitment is load-bearing.
    """
    if td.constraint_type in CONSTRAINT_TYPES_APPLIED_AS_SNET and td.constraint_date is not None:
        return td.constraint_date
    return td.start or None


def _task_anchor(td: TaskData) -> str | None:
    """The earliest date that anchors this task in the schedule, or ``None``.

    ``_resolve_planned_start`` is the CPM floor; an ``actual_start`` is a *harder*
    anchor than any planned date, and it can predate the floor on a task that
    started early. Every "does this task sit somewhere on the calendar?" question
    goes through here so the answer cannot drift between call sites again — which
    is exactly what happened when `planned_start` gained a second source and two
    of the three `td.start` reads were left behind.
    """
    candidates = [d for d in (_resolve_planned_start(td), td.actual_start) if d]
    return min(candidates) if candidates else None


def _maybe_shift_project_start(project_id: str, data: ProjectData, summary: dict[str, Any]) -> None:
    """Pull the project start back to the earliest imported task anchor (#873/#867).

    The importer bulk_creates tasks, bypassing the TaskSerializer auto-shift, so a
    .mpp whose tasks predate the project start would otherwise persist sub-start
    "ghost" planned_starts the CPM clamps. Mirrors the interactive path: the
    project boundary is elastic earlier. Dates are ISO strings (which sort
    chronologically), parsed to a date for the comparison/assignment.

    Reads ``_task_anchor``, **not** ``td.start`` (#2891). Reading ``<Start>`` here
    reopened the very bug this branch fixes: MS Project keeps a ``<ConstraintDate>``
    that predates the project start while computing ``<Start>`` *at* the project
    start, so `ConstraintDate < StartDate <= Start` is the canonical shape. Keyed
    on ``<Start>``, no shift fires, the constraint-derived ``planned_start`` lands
    below the project floor, and ``early_start = max(project_start, planned_start,
    …)`` clamps it away — the commitment dropped silently a second time, one
    function downstream of the fix. ``actual_start`` is included for the same
    reason: work that demonstrably began before the project start still has to fit
    inside the project's window.
    """
    from datetime import date as _date

    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.projects.services import shift_project_start_if_needed

    task_start_strs = [anchor for td in data.tasks if (anchor := _task_anchor(td))]
    if not task_start_strs:
        return
    earliest_start = _date.fromisoformat(min(task_start_strs))
    project = Project.objects.filter(pk=project_id).first()
    if project is not None and shift_project_start_if_needed(project, earliest_start):
        summary["project_start_date"] = project.start_date.isoformat()
        summary["project_start_shifted"] = True


def collect_dependency_edges(data: ProjectData) -> list[tuple[str, str]]:
    """Return every predecessor link in the file's own uid space.

    Exists so a caller can run the ADR-0259 graph guard *before* any row is
    written. Cycle and self-reference structure is invariant under relabeling,
    so validating uids rather than the PKs they become is what lets a cyclic
    file be rejected while the project is still empty — ``bulk_create`` bypasses
    ``DependencySerializer._check_no_cycle``, so there is no later gate.

    Links whose predecessor uid is absent from the file are included: a dangling
    uid can only ever be a source node (successors are always file tasks), so it
    cannot manufacture a cycle, and keeping them makes this edge set identical
    in shape to the one the CSV importer validates.
    """
    return [
        (str(link.predecessor_uid), str(td.uid))
        for td in data.tasks
        for link in td.predecessor_links
    ]


def describe_bad_graph(data: ProjectData, exc: InfeasibleGraphError) -> str:
    """Name the offending tasks of a rejected graph in the uploader's terms.

    Built from ``exc.reason``/``exc.offending`` rather than ``str(exc)``, whose
    message is a domain signal carrying an internal reason code and a list repr
    in uid space ("Infeasible task graph (cyclic_dependency): ['2', '5', '2']").
    The person who uploaded the file knows task names, not uids, and needs the
    two reasons distinguished — a self-referencing task is a different edit from
    a multi-task loop.
    """
    names = {str(td.uid): td.name for td in data.tasks}
    labelled = [f"{names.get(uid, 'unknown task')} (uid {uid})" for uid in exc.offending]
    if exc.reason == "self_reference":
        return f"Task {labelled[0]} lists itself as its own predecessor."
    return "Circular dependency: " + " -> ".join(labelled)


def _import_dependencies(
    data: ProjectData,
    task_uid_to_pk: dict[int, str],
    summary: dict[str, Any],
    *,
    project_id: str,
    batch_size: int,
) -> None:
    """Create Dependency rows from parsed predecessor links.

    Warns (one entry per link) on any predecessor UID absent from the import.
    """
    from trueppm_api.apps.projects.models import Dependency

    dep_objects: list[Dependency] = []
    for td in data.tasks:
        successor_pk = task_uid_to_pk.get(td.uid)
        if not successor_pk:
            continue
        for pl in td.predecessor_links:
            predecessor_pk = task_uid_to_pk.get(pl.predecessor_uid)
            if not predecessor_pk:
                summary["warnings"].append(
                    f"Task '{td.name}': predecessor UID {pl.predecessor_uid} "
                    f"not found, dependency skipped"
                )
                continue
            dep_objects.append(
                Dependency(
                    predecessor_id=predecessor_pk,
                    successor_id=successor_pk,
                    dep_type=pl.dep_type,
                    lag=pl.lag_days,
                )
            )

    if dep_objects:
        # `dependencies` is its own delta collection filtered on the row's own
        # cursor, and bulk_create bypasses save() — so without this the imported
        # graph would sit at sync_seq=0 and never reach an offline client, leaving
        # it a task list with no edges to recompute from (ADR-0686).
        seq = allocate_for_projects([project_id])
        for dep in dep_objects:
            dep.sync_seq = seq
        Dependency.objects.bulk_create(dep_objects, ignore_conflicts=True, batch_size=batch_size)
        summary["dependencies_created"] = len(dep_objects)


def _import_assignments(
    project_id: str,
    data: ProjectData,
    task_uid_to_pk: dict[int, str],
    resource_uid_to_pk: dict[int, str],
    summary: dict[str, Any],
    *,
    batch_size: int,
) -> None:
    """Create TaskResource assignments, then auto-roster each assigned resource."""
    from trueppm_api.apps.resources.models import TaskResource

    assignment_objects: list[TaskResource] = []
    for td in data.tasks:
        task_pk = task_uid_to_pk.get(td.uid)
        if not task_pk:
            continue
        for ad in td.resource_assignments:
            resource_pk = resource_uid_to_pk.get(ad.resource_uid)
            if not resource_pk:
                continue
            assignment_objects.append(
                TaskResource(task_id=task_pk, resource_id=resource_pk, units=ad.units)
            )

    if not assignment_objects:
        return

    TaskResource.objects.bulk_create(
        assignment_objects, ignore_conflicts=True, batch_size=batch_size
    )
    summary["assignments_created"] = len(assignment_objects)
    _roster_assigned_resources(project_id, assignment_objects, batch_size=batch_size)


def _roster_assigned_resources(
    project_id: str, assignment_objects: list[Any], *, batch_size: int
) -> None:
    """Roster every assigned resource onto the project so they appear in Team →
    Roster / Heatmap / Allocation views after import (#241).

    Bulk-builds the rows because bulk_create skipped the per-row signal path used
    by the API ViewSet.
    """
    from trueppm_api.apps.resources.models import ProjectResource

    rostered_resource_pks = {a.resource_id for a in assignment_objects}
    existing_pairs = set(
        ProjectResource.objects.filter(
            project_id=project_id,
            resource_id__in=rostered_resource_pks,
        ).values_list("resource_id", flat=True)
    )
    new_roster = [
        ProjectResource(project_id=project_id, resource_id=pk)
        for pk in rostered_resource_pks
        if pk not in existing_pairs
    ]
    if new_roster:
        ProjectResource.objects.bulk_create(
            new_roster, ignore_conflicts=True, batch_size=batch_size
        )


def _apply_calendar(
    project_id: str,
    data: ProjectData,
    summary: dict[str, Any],
    *,
    overwrite: bool,
    batch_size: int,
) -> None:
    """Wire the file's project calendar onto ``Project.calendar`` (#1769).

    Resolution: the project-level ``<CalendarUID>`` picks the calendar; when the
    header omits it and the file has exactly one base calendar, that calendar is
    unambiguous and used. The row is reused from the shared calendar library
    only on an exact semantic match (see ``_match_or_create_calendar``),
    otherwise created together with its ``CalendarException`` rows.

    Overwrite policy mirrors ``_apply_header_to_project``: create-from-import
    (``overwrite=True``) treats the file as authoritative; import-into-existing
    keeps a PM-configured project calendar and only warns when the file's
    calendar differs semantically (silently "conflicting" on the ubiquitous
    vanilla Standard calendar would be pure noise).

    TruePPM has no per-task calendars, so task-level ``CalendarUID`` references
    to any *other* calendar degrade to one aggregated warning per calendar.
    """
    from trueppm_api.apps.projects.models import Project

    if not data.calendars:
        return

    by_uid = {c.uid: c for c in data.calendars}
    cal_data = _resolve_project_calendar_data(data, by_uid, summary)

    _warn_unhonored_task_calendars(data, cal_data, by_uid, summary)

    if cal_data is None:
        return

    project = (
        Project.objects.select_related("calendar")
        .prefetch_related("calendar__exceptions")
        .get(pk=project_id)
    )
    if project.calendar_id is not None and not overwrite:
        if project.calendar is not None and not _calendar_matches(project.calendar, cal_data):
            summary["warnings"].append(
                f"File calendar '{cal_data.name}' differs from the project's "
                f"configured calendar '{project.calendar.name}'; the project "
                f"calendar was kept — imported dates may shift"
            )
        return

    calendar = _match_or_create_calendar(cal_data, summary, batch_size=batch_size)
    if project.calendar_id != calendar.pk:
        project.calendar = calendar
        # save() rather than .update() so server_version bumps and sync clients
        # observe the calendar change — same pattern as
        # shift_project_start_if_needed on the start-date pull-back.
        project.save(update_fields=["calendar"])
    summary["calendar_applied"] = True
    summary["calendar_name"] = calendar.name


def _resolve_project_calendar_data(
    data: ProjectData, by_uid: dict[int, CalendarData], summary: dict[str, Any]
) -> CalendarData | None:
    """Pick the file's project calendar: the explicit ``CalendarUID`` if present,
    else the sole base calendar when unambiguous. Warns and returns None when the
    referenced UID is missing, or when the header omits it and several calendars exist.
    """
    cal_data = by_uid.get(data.calendar_uid) if data.calendar_uid is not None else None
    if cal_data is not None:
        return cal_data
    if data.calendar_uid is not None:
        summary["warnings"].append(
            f"Project calendar UID {data.calendar_uid} not found among the "
            f"file's base calendars; project calendar left unchanged"
        )
    elif len(data.calendars) == 1:
        cal_data = data.calendars[0]
    else:
        summary["warnings"].append(
            f"File defines {len(data.calendars)} base calendars but no "
            f"project CalendarUID; project calendar left unchanged"
        )
    return cal_data


def _warn_unhonored_task_calendars(
    data: ProjectData,
    cal_data: CalendarData | None,
    by_uid: dict[int, CalendarData],
    summary: dict[str, Any],
) -> None:
    """Emit one aggregated warning per distinct task-level calendar TruePPM cannot
    honor (it has no per-task calendars) — never one warning per task, so a
    500-task plan on a shared task calendar produces a single line, not 500.
    """
    project_cal_uid = cal_data.uid if cal_data is not None else data.calendar_uid
    task_cal_counts: dict[int, int] = {}
    for td in data.tasks:
        if td.calendar_uid is not None and td.calendar_uid != project_cal_uid:
            task_cal_counts[td.calendar_uid] = task_cal_counts.get(td.calendar_uid, 0) + 1
    for uid, count in sorted(task_cal_counts.items()):
        ref = by_uid.get(uid)
        label = f"'{ref.name}' (UID {uid})" if ref is not None else f"UID {uid}"
        summary["warnings"].append(
            f"{count} task(s) reference calendar {label}; TruePPM has no "
            f"per-task calendars — they are scheduled on the project calendar"
        )


def _match_or_create_calendar(
    cal_data: CalendarData, summary: dict[str, Any], *, batch_size: int
) -> Any:
    """Return a library ``Calendar`` row for the parsed calendar, reusing on exact match.

    Reuse requires the same (case-insensitive) name AND identical semantics —
    mask, hours per day, and exception ranges. A name-only match (every MS
    Project file ships a "Standard") could silently attach another team's
    holidays to this project; a semantics-only match under a different name
    would confuse the calendar library UI. Repeated imports of the same file
    therefore converge on one row instead of accreting duplicates.
    """
    from datetime import date as _date

    from trueppm_api.apps.projects.models import Calendar, CalendarException

    candidates = Calendar.objects.filter(
        name__iexact=cal_data.name, is_deleted=False
    ).prefetch_related("exceptions")
    for candidate in candidates:
        if _calendar_matches(candidate, cal_data):
            summary["calendar_matched"] = True
            return candidate

    calendar = Calendar.objects.create(
        name=cal_data.name[:255],
        working_days=cal_data.working_days,
        hours_per_day=cal_data.hours_per_day,
    )
    if cal_data.exceptions:
        CalendarException.objects.bulk_create(
            [
                CalendarException(
                    calendar=calendar,
                    exc_start=_date.fromisoformat(exc.start),
                    exc_end=_date.fromisoformat(exc.end),
                    description=exc.name[:255],
                )
                for exc in cal_data.exceptions
            ],
            batch_size=batch_size,
        )
    summary["calendar_created"] = True
    return calendar


def _calendar_matches(calendar: Any, cal_data: CalendarData) -> bool:
    """True when a ``Calendar`` row is semantically identical to parsed data.

    Compares the CPM inputs only — mask, hours per day, and exception date
    ranges. Exception descriptions and timezone are metadata that cannot shift
    a schedule, so they don't block reuse.
    """
    if calendar.working_days != cal_data.working_days:
        return False
    if abs(calendar.hours_per_day - cal_data.hours_per_day) > 1e-6:
        return False
    existing = {
        (exc.exc_start.isoformat(), exc.exc_end.isoformat()) for exc in calendar.exceptions.all()
    }
    parsed = {(exc.start, exc.end) for exc in cal_data.exceptions}
    return existing == parsed


def _build_wbs_paths(tasks: list[TaskData]) -> list[str]:
    """Compute an ltree ``wbs_path`` per task, preserving the WBS hierarchy.

    MS Project encodes hierarchy two ways: the dotted ``OutlineNumber``
    ("1", "1.1", "1.2") and the integer ``OutlineLevel`` (indent depth).
    Genuine MS Project exports keep both consistent, but many third-party and
    generated MSPDI files write a *flat* ``OutlineNumber`` (1, 2, 3, …) and
    carry the hierarchy only in ``OutlineLevel`` (#794). Trusting the outline
    number alone flattens those files — every phase imports as a sibling of its
    own sub-tasks. So:

      - if any task has a dotted ``OutlineNumber`` the file uses the
        hierarchical form: map each number straight to an ltree path (the
        original, well-formed-file behavior — unchanged);
      - otherwise, when ``OutlineLevel`` indicates nesting, reconstruct the
        hierarchy from the level sequence (tasks arrive in document order).
    """
    has_dotted = any("." in (t.outline_number or "") for t in tasks)
    if has_dotted:
        return [_outline_number_to_ltree(t.outline_number) for t in tasks]

    levels = [t.outline_level for t in tasks]
    if len(set(levels)) <= 1:
        # Genuinely flat project (or no level info): keep the outline number,
        # which is itself flat (1, 2, 3, …) for these files.
        return [_outline_number_to_ltree(t.outline_number) for t in tasks]

    return _wbs_paths_from_levels(levels)


def _wbs_paths_from_levels(levels: list[int]) -> list[str]:
    """Reconstruct dotted ltree paths from a document-ordered OutlineLevel list.

    Walks tasks in document order maintaining a sibling counter per depth. A
    deeper level opens a child ("1" -> "1.1"); the same or a shallower level
    advances the sibling counter at that depth ("1.1" -> "1.2", "1.4" -> "2").
    Levels are normalized so the shallowest observed level becomes depth 1, so
    files whose top-level tasks start at OutlineLevel 1 (or any value) behave
    identically.
    """
    base = min(levels)
    counters: list[int] = []
    paths: list[str] = []
    for level in levels:
        depth = max(level - base + 1, 1)
        if depth <= len(counters):
            # Same or shallower: drop deeper ancestors, bump this depth's sibling.
            counters = counters[:depth]
            counters[depth - 1] += 1
        else:
            # Deeper: open child levels (pads with 1s if a level is skipped).
            while len(counters) < depth:
                counters.append(1)
        paths.append(".".join(str(c) for c in counters))
    return paths


def _summary_indices(wbs_paths: list[str]) -> set[int]:
    """Return the indices of summary tasks (have at least one descendant).

    A task is a summary when some other task's ``wbs_path`` is strictly
    descended from this one's (e.g. ``"1"`` is a summary if any task has
    path ``"1.1"`` or deeper). Implemented in O(N) by collecting all strict
    ancestor paths in one pass, then marking every task whose own path is in
    that set. Used by the importer to skip three-point field writes on
    summary rows (ADR-0093 Q5).
    """
    ancestor_paths: set[str] = set()
    for path in wbs_paths:
        if not path:
            continue
        parts = path.split(".")
        # Each strict prefix of a leaf is an ancestor (excluding the path
        # itself, since a task with no descendants is a leaf).
        for end in range(1, len(parts)):
            ancestor_paths.add(".".join(parts[:end]))
    return {i for i, p in enumerate(wbs_paths) if p and p in ancestor_paths}


def _outline_number_to_ltree(outline_number: str) -> str:
    """Convert MS Project OutlineNumber (e.g. '1.2.3') to ltree path.

    MS Project OutlineNumber is already dot-separated and hierarchical,
    which maps directly to the ltree format used by wbs_path.
    """
    if not outline_number:
        return ""
    parts = outline_number.split(".")
    cleaned: list[str] = []
    for p in parts:
        p = p.strip()
        if p.isdigit():
            cleaned.append(p)
        else:
            return ""
    return ".".join(cleaned)
