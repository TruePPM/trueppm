"""Import parsed MS Project data into TruePPM models."""

from __future__ import annotations

import logging
from typing import Any

from trueppm_api.apps.msproject.dataclasses import ProjectData

logger = logging.getLogger(__name__)


def import_project(
    project_id: str,
    data: ProjectData,
    tracker: Any = None,
) -> dict[str, Any]:
    """Import parsed MS Project data into an existing TruePPM project.

    Creates tasks, dependencies, resources, and assignments using bulk operations
    to bypass django-simple-history (per ADR-0011). Existing tasks in the project
    are NOT deleted -- the import is additive.

    Args:
        project_id: UUID string of the target Project.
        data: Parsed ProjectData from the MS Project file.
        tracker: Optional TaskRunTracker for progress reporting.

    Returns:
        Summary dict for result_summary.
    """
    from django.db.models import F

    from trueppm_api.apps.projects.models import Dependency, Project, Task
    from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

    def _update(pct: int, msg: str) -> None:
        if tracker is not None:
            tracker.update(pct, msg)

    _update(5, "Preparing import...")

    summary: dict[str, Any] = {
        "tasks_created": 0,
        "dependencies_created": 0,
        "resources_matched": 0,
        "resources_created": 0,
        "assignments_created": 0,
        "warnings": list(data.warnings),
    }

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
            Resource.objects.bulk_create(new_resources)
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

    for i, td in enumerate(data.tasks):
        wbs_path = _outline_number_to_ltree(td.outline_number)
        task = Task(
            project_id=project_id,
            name=td.name,
            wbs_path=wbs_path if wbs_path else None,
            duration=td.duration_days,
            is_milestone=td.is_milestone,
            percent_complete=td.percent_complete,
            notes=td.notes,
            planned_start=td.start if td.start else None,
            short_id=f"{start_seq + i:08X}",
        )
        task_objects.append(task)

    Task.objects.bulk_create(task_objects)
    summary["tasks_created"] = len(task_objects)

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
        Dependency.objects.bulk_create(dep_objects, ignore_conflicts=True)
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
        TaskResource.objects.bulk_create(assignment_objects, ignore_conflicts=True)
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
            ProjectResource.objects.bulk_create(new_roster, ignore_conflicts=True)

    _update(90, "Import complete, triggering schedule recalculation...")
    return summary


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
