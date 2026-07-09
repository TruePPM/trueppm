"""Export TruePPM project data to MS Project XML format."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date
from typing import Any

from trueppm_api.apps.msproject.extended_attributes import (
    DURATION1_FIELD_ID,
    DURATION2_FIELD_ID,
    DURATION3_FIELD_ID,
    DURATION4_FIELD_ID,
    PERT_ALIAS_LABELS,
    PERT_EXPECTED_FORMULA,
    PERT_FIELD_NAMES,
)

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

    # --- Project-level ExtendedAttribute definitions (#798, ADR-0093) ---
    # Emit the four PERT slots only when at least one non-summary, non-milestone
    # task carries all three values. MS Project tolerates the block being
    # absent; emitting it unconditionally would clutter files that don't use
    # three-point estimates. The summary set is precomputed once for O(N)
    # filtering of per-task emission below.
    summary_pks = _summary_pks_from_tasks(tasks)
    pert_tasks = [
        t
        for t in tasks
        if (
            str(t.pk) not in summary_pks
            and not t.is_milestone
            and t.optimistic_duration is not None
            and t.most_likely_duration is not None
            and t.pessimistic_duration is not None
        )
    ]
    if pert_tasks:
        _add_pert_extended_attribute_defs(root)

    # --- Tasks ---
    tasks_el = ET.SubElement(root, f"{{{_NS}}}Tasks")

    # Task UID 0: project summary task
    _add_summary_task(tasks_el, project)

    pert_task_pks = {str(t.pk) for t in pert_tasks}
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
        # Task.percent_complete is already a 0-100 percent (#1759) and MSPDI
        # PercentComplete is the same 0-100 scale, so emit it as-is. The earlier
        # `* 100` turned a native 50% task into an invalid PercentComplete=5000.
        _sub_text(
            task_el,
            "PercentComplete",
            str(round(task.percent_complete or 0)),
        )
        if task.notes:
            _sub_text(task_el, "Notes", task.notes)
        if task.early_start:
            _sub_text(task_el, "Start", _format_date(task.early_start))
        elif task.planned_start:
            _sub_text(task_el, "Start", _format_date(task.planned_start))
        if task.early_finish:
            _sub_text(task_el, "Finish", _format_date(task.early_finish))

        # PERT three-point per-task values. Only emitted for the leaf,
        # non-milestone tasks selected into pert_task_pks above (ADR-0093 Q5).
        # Duration4 is the PERT-Expected formula slot; MS Project derives it
        # on read from the project-level Formula definition, so we never emit
        # a per-task Duration4 value.
        if str(task.pk) in pert_task_pks:
            # All three are non-None by the pert_tasks filter above, but mypy
            # can't carry that proof across the comprehension.
            assert task.optimistic_duration is not None
            assert task.most_likely_duration is not None
            assert task.pessimistic_duration is not None
            _add_pert_task_values(
                task_el,
                task.optimistic_duration,
                task.most_likely_duration,
                task.pessimistic_duration,
            )

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


def _summary_pks_from_tasks(tasks: list[Any]) -> set[str]:
    """Return the set of task primary keys that are summary tasks.

    A task is a summary when another task's ``wbs_path`` is strictly descended
    from this one's (e.g. ``"1"`` is a summary if any task has path ``"1.1"``).
    O(N) over the task list: build the set of strict ancestor paths from every
    leaf path in one pass, then mark every task whose own path is in that set.
    """
    ancestor_paths: set[str] = set()
    for t in tasks:
        path = getattr(t, "wbs_path", None)
        if not path:
            continue
        path = str(path)
        parts = path.split(".")
        for end in range(1, len(parts)):
            ancestor_paths.add(".".join(parts[:end]))
    return {
        str(t.pk)
        for t in tasks
        if getattr(t, "wbs_path", None) and str(t.wbs_path) in ancestor_paths
    }


def _add_pert_extended_attribute_defs(root: ET.Element) -> None:
    """Emit the four PERT ExtendedAttribute definitions at project level.

    Duration1–3 carry the aliases Optimistic / Most Likely / Pessimistic.
    Duration4 carries the formula MS Project uses to derive PERT Expected
    on file open. The caller is responsible for invoking this **before** the
    ``<Tasks>`` block is appended, so the resulting element order
    (``<ExtendedAttributes>`` then ``<Tasks>``) matches MS Project's own
    element order. ``ET.SubElement`` appends at call time, so call ordering
    is the positional guarantee — don't move this call after ``<Tasks>``.
    """
    ea_block = ET.SubElement(root, f"{{{_NS}}}ExtendedAttributes")
    for fid in (DURATION1_FIELD_ID, DURATION2_FIELD_ID, DURATION3_FIELD_ID, DURATION4_FIELD_ID):
        ea = ET.SubElement(ea_block, f"{{{_NS}}}ExtendedAttribute")
        _sub_text(ea, "FieldID", fid)
        _sub_text(ea, "FieldName", PERT_FIELD_NAMES[fid])
        _sub_text(ea, "Alias", PERT_ALIAS_LABELS[fid])
        if fid == DURATION4_FIELD_ID:
            _sub_text(ea, "Formula", PERT_EXPECTED_FORMULA)


def _add_pert_task_values(
    task_el: ET.Element,
    optimistic_days: int,
    most_likely_days: int,
    pessimistic_days: int,
) -> None:
    """Emit per-task <ExtendedAttribute> values for Duration1/2/3.

    Values are encoded as ISO-8601 ``PT{hours}H0M0S`` (8h working day) using
    the same convention as the primary Duration field. ``DurationFormat=7``
    marks the value as a duration in days for MS Project's UI.
    """
    for fid, days in (
        (DURATION1_FIELD_ID, optimistic_days),
        (DURATION2_FIELD_ID, most_likely_days),
        (DURATION3_FIELD_ID, pessimistic_days),
    ):
        ea = ET.SubElement(task_el, f"{{{_NS}}}ExtendedAttribute")
        _sub_text(ea, "FieldID", fid)
        _sub_text(ea, "Value", _days_to_duration(days))
        _sub_text(ea, "DurationFormat", "7")
