"""Import parsed MS Project data into TruePPM models."""

from __future__ import annotations

import logging
from typing import Any

from trueppm_api.apps.msproject.dataclasses import CalendarData, ProjectData, TaskData

logger = logging.getLogger(__name__)


def import_project(
    project_id: str,
    data: ProjectData,
    tracker: Any = None,
    wipe_existing: bool = False,
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
            keeps the import-into-existing-project path additive.

    Returns:
        Summary dict for result_summary. ``task_count`` and ``project_start_date``
        feed the post-import summary the UI shows on the project landing.
    """
    from django.conf import settings
    from django.db.models import F

    from trueppm_api.apps.projects.models import (
        DeliveryMode,
        Dependency,
        Project,
        Task,
        TaskStatus,
    )
    from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

    # Chunk every bulk_create (#1721) so a large import is not emitted as one
    # unbounded multi-row INSERT (which pins the whole set in a single statement
    # and can blow PostgreSQL's parameter limit). Paired with the parser row cap.
    batch_size = getattr(settings, "IMPORT_BULK_BATCH_SIZE", 500)

    def _update(pct: int, msg: str) -> None:
        if tracker is not None:
            tracker.update(pct, msg)

    _update(5, "Preparing import...")

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
        "warnings": list(data.warnings),
    }
    # Count tasks the parser warned about for partial PERT data; the warning
    # text is the canonical marker (the parser dropped values to None before
    # we got here, so we can't tell from the dataclass alone).
    summary["tasks_skipped_partial_three_point"] = sum(
        1 for w in data.warnings if "partial three-point estimate" in w
    )

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
    resource_uid_to_pk: dict[int, str] = {}

    if data.resources:
        existing = {r.name.lower(): r for r in Resource.objects.all()}
        new_resources: list[Resource] = []

        for rd in data.resources:
            name_lower = rd.name.lower()
            if name_lower in existing:
                resource_uid_to_pk[rd.uid] = str(existing[name_lower].pk)
                summary["resources_matched"] += 1
            else:
                r = Resource(name=rd.name, max_units=rd.max_units)
                new_resources.append(r)

        if new_resources:
            Resource.objects.bulk_create(new_resources, batch_size=batch_size)
            summary["resources_created"] = len(new_resources)
            all_resources = {r.name.lower(): r for r in Resource.objects.all()}
            for rd in data.resources:
                if rd.uid not in resource_uid_to_pk:
                    matched = all_resources.get(rd.name.lower())
                    if matched:
                        resource_uid_to_pk[rd.uid] = str(matched.pk)

    # --- Step 2: Create tasks ---
    _update(30, f"Creating {len(data.tasks)} tasks...")
    task_uid_to_pk: dict[int, str] = {}
    task_objects: list[Task] = []

    # Allocate a batch of short_ids: increment object_sequence by len(tasks)
    # in one UPDATE, then assign sequential hex IDs.
    task_count = len(data.tasks)
    Project.objects.filter(pk=project_id).update(object_sequence=F("object_sequence") + task_count)
    end_seq: int = Project.objects.values_list("object_sequence", flat=True).get(pk=project_id)
    start_seq = end_seq - task_count + 1

    wbs_paths = _build_wbs_paths(data.tasks)
    # Summary-task detection (ADR-0093 Q5): a task is a summary if any later
    # task's wbs_path is strictly descended from this one's. Computed once in
    # O(N) by sweeping the WBS paths and marking each strict ancestor present
    # in the prefix set. Three-point fields are NOT written on summary rows
    # because MS Project never populates them there; round-tripping them
    # would drift on re-export.
    summary_indices = _summary_indices(wbs_paths)

    for i, td in enumerate(data.tasks):
        wbs_path = wbs_paths[i]
        # All-or-none gate (ADR-0093 Q3): the parser already enforces it, so
        # if any one of the three fields is set we know the other two are too.
        # Skip three-point write on summaries (Q5) and milestones (already
        # nulled by the parser, but kept defensive here).
        is_summary = i in summary_indices
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
        effective_percent = td.percent_complete if (td.start or _terminal) else 0
        task = Task(
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
            planned_start=td.start if td.start else None,
            optimistic_duration=opt,
            most_likely_duration=ml,
            pessimistic_duration=pess,
            estimate_status=est_status,
            short_id=f"{start_seq + i:08X}",
        )
        task_objects.append(task)

    # #873/#867: pull the project start back to the earliest imported task start
    # before persisting. The importer bulk_creates tasks, bypassing the
    # TaskSerializer auto-shift, so a .mpp whose tasks predate the project start
    # would otherwise persist sub-start "ghost" planned_starts the CPM clamps.
    # Mirrors the interactive path: the project boundary is elastic earlier.
    # ``td.start`` is an ISO date string (sorts chronologically), parsed to a
    # date for the comparison/assignment the helper performs.
    from datetime import date as _date

    from trueppm_api.apps.projects.services import shift_project_start_if_needed

    task_start_strs = [td.start for td in data.tasks if td.start]
    if task_start_strs:
        earliest_start = _date.fromisoformat(min(task_start_strs))
        project = Project.objects.filter(pk=project_id).first()
        if project is not None and shift_project_start_if_needed(project, earliest_start):
            summary["project_start_date"] = project.start_date.isoformat()
            summary["project_start_shifted"] = True

    Task.objects.bulk_create(task_objects, batch_size=batch_size)
    summary["tasks_created"] = len(task_objects)
    summary["task_count"] = len(task_objects)

    for i, td in enumerate(data.tasks):
        task_uid_to_pk[td.uid] = str(task_objects[i].pk)

    # --- Step 3: Create dependencies ---
    _update(50, "Creating dependencies...")
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
        Dependency.objects.bulk_create(dep_objects, ignore_conflicts=True, batch_size=batch_size)
        summary["dependencies_created"] = len(dep_objects)

    # --- Step 4: Create resource assignments ---
    _update(70, "Creating resource assignments...")
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
                TaskResource(
                    task_id=task_pk,
                    resource_id=resource_pk,
                    units=ad.units,
                )
            )

    if assignment_objects:
        TaskResource.objects.bulk_create(
            assignment_objects, ignore_conflicts=True, batch_size=batch_size
        )
        summary["assignments_created"] = len(assignment_objects)

        # Auto-roster every assigned resource so they appear in Team → Roster /
        # Heatmap / Allocation views after import (#241). Bulk-builds the rows
        # because bulk_create skipped the per-row signal path used by the API
        # ViewSet.
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

    _update(90, "Import complete, triggering schedule recalculation...")
    return summary


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
    cal_data = by_uid.get(data.calendar_uid) if data.calendar_uid is not None else None
    if cal_data is None:
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

    # Aggregate per-task calendar references we cannot honor: one warning per
    # distinct calendar, not per task (a 500-task plan on a shared task calendar
    # must not produce 500 warnings).
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
