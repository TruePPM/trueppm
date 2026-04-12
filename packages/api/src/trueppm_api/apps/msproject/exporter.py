"""Export TruePPM project data to MS Project XML format."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date

# MS Project XML namespace.
_NS = "http://schemas.microsoft.com/project"

# TruePPM dep_type -> MS Project PredecessorLink/Type.
_DEP_TYPE_TO_LINK_TYPE = {
    "FF": "0",
    "FS": "1",
    "SF": "2",
    "SS": "3",
}


def export_project_xml(project_id: str) -> bytes:
    """Export a TruePPM project to MS Project XML format.

    Returns:
        UTF-8 encoded XML bytes.
    """
    from trueppm_api.apps.projects.models import Dependency, Project, Task
    from trueppm_api.apps.resources.models import Resource, TaskResource

    project = Project.objects.get(pk=project_id)
    tasks = list(
        Task.objects.filter(project_id=project_id, is_deleted=False).order_by("wbs_path", "name")
    )
    dependencies = list(
        Dependency.objects.filter(
            predecessor__project_id=project_id, is_deleted=False
        ).select_related("predecessor", "successor")
    )
    task_ids = [str(t.pk) for t in tasks]
    assignments = list(TaskResource.objects.filter(task_id__in=task_ids).select_related("resource"))
    resource_ids = {a.resource_id for a in assignments}
    resources = list(Resource.objects.filter(pk__in=resource_ids))

    # UID maps - MS Project expects sequential integer UIDs.
    task_pk_to_uid: dict[str, int] = {}
    resource_pk_to_uid: dict[str, int] = {}

    for i, t in enumerate(tasks, start=1):
        task_pk_to_uid[str(t.pk)] = i
    for i, r in enumerate(resources, start=1):
        resource_pk_to_uid[str(r.pk)] = i

    # Build dependency lookup: successor_pk -> [(predecessor_pk, dep_type, lag)]
    dep_by_successor: dict[str, list[tuple[str, str, int]]] = {}
    for dep in dependencies:
        dep_by_successor.setdefault(str(dep.successor_id), []).append(
            (str(dep.predecessor_id), dep.dep_type, dep.lag)
        )

    # --- Build XML ---
    ET.register_namespace("", _NS)
    root = ET.Element(f"{{{_NS}}}Project")

    _sub_text(root, "Name", project.name)
    _sub_text(root, "StartDate", _format_date(project.start_date))

    # --- Tasks ---
    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")

    # Task UID 0: project summary task
    _add_summary_task(tasks_el, project)

    for task in tasks:
        uid = task_pk_to_uid[str(task.pk)]
        task_el = ET.SubElement(tasks_el, f"{{{_NS}}}Task")
        _sub_text(task_el, "UID", str(uid))
        _sub_text(task_el, "Name", task.name)
        _sub_text(task_el, "Duration", _days_to_duration(task.duration))
        _sub_text(task_el, "DurationFormat", "7")
        if task.wbs_path:
            _sub_text(task_el, "OutlineNumber", task.wbs_path)
            _sub_text(task_el, "OutlineLevel", str(task.wbs_path.count(".") + 1))
        else:
            _sub_text(task_el, "OutlineLevel", "1")
        _sub_text(task_el, "Milestone", "1" if task.is_milestone else "0")
        _sub_text(
            task_el,
            "PercentComplete",
            str(int(task.percent_complete * 100)),
        )
        if task.notes:
            _sub_text(task_el, "Notes", task.notes)
        if task.early_start:
            _sub_text(task_el, "Start", _format_date(task.early_start))
        elif task.planned_start:
            _sub_text(task_el, "Start", _format_date(task.planned_start))
        if task.early_finish:
            _sub_text(task_el, "Finish", _format_date(task.early_finish))

        # Predecessor links
        preds = dep_by_successor.get(str(task.pk), [])
        for pred_pk, dep_type, lag in preds:
            pred_uid = task_pk_to_uid.get(pred_pk)
            if pred_uid is None:
                continue
            pred_el = ET.SubElement(task_el, f"{{{_NS}}}PredecessorLink")
            _sub_text(pred_el, "PredecessorUID", str(pred_uid))
            _sub_text(
                pred_el,
                "Type",
                _DEP_TYPE_TO_LINK_TYPE.get(dep_type, "1"),
            )
            _sub_text(pred_el, "LinkLag", str(lag * 4800))
            _sub_text(pred_el, "LagFormat", "7")

    # --- Resources ---
    resources_el = ET.SubElement(root, f"{{{_NS}}}Resources")
    for resource in resources:
        uid = resource_pk_to_uid[str(resource.pk)]
        res_el = ET.SubElement(resources_el, f"{{{_NS}}}Resource")
        _sub_text(res_el, "UID", str(uid))
        _sub_text(res_el, "Name", resource.name)
        _sub_text(res_el, "MaxUnits", f"{float(resource.max_units):.2f}")

    # --- Assignments ---
    assignments_el = ET.SubElement(root, f"{{{_NS}}}Assignments")
    asgn_uid = 1
    for asgn in assignments:
        task_uid = task_pk_to_uid.get(str(asgn.task_id))
        res_uid = resource_pk_to_uid.get(str(asgn.resource_id))
        if task_uid is None or res_uid is None:
            continue
        asgn_el = ET.SubElement(assignments_el, f"{{{_NS}}}Assignment")
        _sub_text(asgn_el, "UID", str(asgn_uid))
        _sub_text(asgn_el, "TaskUID", str(task_uid))
        _sub_text(asgn_el, "ResourceUID", str(res_uid))
        _sub_text(asgn_el, "Units", f"{float(asgn.units):.2f}")
        asgn_uid += 1

    # Serialize
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")

    xml_decl = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    return xml_decl + ET.tostring(root, encoding="unicode").encode("utf-8")


def _sub_text(parent: ET.Element, tag: str, text: str) -> ET.Element:
    """Add a child element with text content."""
    el = ET.SubElement(parent, f"{{{_NS}}}{tag}")
    el.text = text
    return el


def _format_date(d: date) -> str:
    """Format a date as MS Project expects: YYYY-MM-DDT00:00:00."""
    return f"{d.isoformat()}T00:00:00"


def _days_to_duration(days: int) -> str:
    """Convert working days to MS Project ISO 8601 duration."""
    hours = days * 8
    return f"PT{hours}H0M0S"


def _add_summary_task(tasks_el: ET.Element, project: object) -> None:
    """Add the UID 0 project summary task."""
    task_el = ET.SubElement(tasks_el, f"{{{_NS}}}Task")
    _sub_text(task_el, "UID", "0")
    _sub_text(task_el, "Name", project.name)  # type: ignore[attr-defined]
    _sub_text(task_el, "OutlineLevel", "0")
    _sub_text(task_el, "OutlineNumber", "0")
