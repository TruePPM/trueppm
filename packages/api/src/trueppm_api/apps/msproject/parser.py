"""Parsers for MS Project .xml and .mpp files."""

from __future__ import annotations

import contextlib
import logging
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from django.conf import settings

from trueppm_api.apps.msproject.dataclasses import (
    AssignmentData,
    PredecessorLinkData,
    ProjectData,
    ResourceData,
    TaskData,
)

logger = logging.getLogger(__name__)

# MS Project XML namespace (Project 2003+).
_NS = "http://schemas.microsoft.com/project"
_NS_MAP = {"ms": _NS}

# MS Project PredecessorLink/Type values -> TruePPM dep_type.
_LINK_TYPE_MAP = {
    "0": "FF",
    "1": "FS",
    "2": "SF",
    "3": "SS",
}

# Subprocess timeout for MPXJ (seconds).
_MPXJ_TIMEOUT = 120


def _parse_duration_to_days(duration_str: str) -> int:
    """Parse MS Project ISO 8601 duration string to working days.

    MS Project uses PT<hours>H<minutes>M<seconds>S for task durations where
    hours represent calendar hours. We convert to working days using 8h/day.
    Also handles P<n>D and P<n>DT<n>H formats.
    """
    if not duration_str:
        return 1

    s = duration_str.strip()
    if not s.startswith("P"):
        return 1

    s = s[1:]
    days = 0
    hours = 0

    if "T" in s:
        day_part, time_part = s.split("T", 1)
    else:
        day_part = s
        time_part = ""

    if day_part and day_part.endswith("D"):
        with contextlib.suppress(ValueError):
            days = int(day_part[:-1])

    if time_part:
        h_idx = time_part.find("H")
        if h_idx > 0:
            with contextlib.suppress(ValueError):
                hours = int(time_part[:h_idx])

    total_days = days + (hours // 8)
    return max(total_days, 0) if (days > 0 or hours > 0) else 1


def _parse_lag_to_days(lag_tenths_of_minutes: str) -> int:
    """Convert MS Project LinkLag (tenths of minutes) to working days.

    MS Project stores lag in tenths of minutes. 4800 = 480 min = 8h = 1 day.
    """
    if not lag_tenths_of_minutes:
        return 0
    try:
        tenths = int(lag_tenths_of_minutes)
    except ValueError:
        return 0
    return tenths // 4800


def parse_xml(xml_content: bytes) -> ProjectData:
    """Parse MS Project XML content into a ProjectData structure.

    Handles both namespaced (Project 2003+) and non-namespaced XML.
    """
    root = ET.fromstring(xml_content)

    # Detect namespace
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    def _ft(el: ET.Element, tag: str) -> str:
        child = el.find(f"{ns}{tag}")
        return child.text if child is not None and child.text else ""

    def _fe(el: ET.Element, tag: str) -> ET.Element | None:
        return el.find(f"{ns}{tag}")

    def _fa(el: ET.Element, tag: str) -> list[ET.Element]:
        return el.findall(f"{ns}{tag}")

    project_data = ProjectData(
        name=_ft(root, "Name"),
        start_date=_ft(root, "StartDate")[:10] if _ft(root, "StartDate") else None,
    )

    # --- Parse resources ---
    resources_el = _fe(root, "Resources")
    resource_map: dict[int, ResourceData] = {}
    if resources_el is not None:
        for res_el in _fa(resources_el, "Resource"):
            uid_str = _ft(res_el, "UID")
            name = _ft(res_el, "Name")
            if not uid_str or not name:
                continue
            uid = int(uid_str)
            if uid == 0:
                continue
            max_units_str = _ft(res_el, "MaxUnits")
            max_units = float(max_units_str) if max_units_str else 1.0
            rd = ResourceData(uid=uid, name=name, max_units=max_units)
            resource_map[uid] = rd
            project_data.resources.append(rd)

    # --- Parse assignments (index by task UID) ---
    assignments_el = _fe(root, "Assignments")
    task_assignments: dict[int, list[AssignmentData]] = {}
    if assignments_el is not None:
        for asgn_el in _fa(assignments_el, "Assignment"):
            task_uid_str = _ft(asgn_el, "TaskUID")
            res_uid_str = _ft(asgn_el, "ResourceUID")
            if not task_uid_str or not res_uid_str:
                continue
            task_uid = int(task_uid_str)
            res_uid = int(res_uid_str)
            if res_uid == 0 or res_uid not in resource_map:
                continue
            units_str = _ft(asgn_el, "Units")
            units = float(units_str) if units_str else 1.0
            ad = AssignmentData(task_uid=task_uid, resource_uid=res_uid, units=units)
            task_assignments.setdefault(task_uid, []).append(ad)

    # --- Parse tasks ---
    tasks_el = _fe(root, "Tasks")
    if tasks_el is not None:
        for task_el in _fa(tasks_el, "Task"):
            uid_str = _ft(task_el, "UID")
            name = _ft(task_el, "Name")
            if not uid_str:
                continue
            uid = int(uid_str)
            if uid == 0:
                continue
            if not name:
                project_data.warnings.append(f"Task UID {uid}: missing name, skipped")
                continue

            duration_str = _ft(task_el, "Duration")
            outline_number = _ft(task_el, "OutlineNumber")
            outline_level_str = _ft(task_el, "OutlineLevel")
            milestone_str = _ft(task_el, "Milestone")
            pct_str = _ft(task_el, "PercentComplete")
            notes = _ft(task_el, "Notes")
            start_str = _ft(task_el, "Start")

            pred_links: list[PredecessorLinkData] = []
            for pred_el in _fa(task_el, "PredecessorLink"):
                pred_uid_str = _ft(pred_el, "PredecessorUID")
                if not pred_uid_str:
                    continue
                link_type_str = _ft(pred_el, "Type") or "1"
                link_lag_str = _ft(pred_el, "LinkLag") or "0"
                dep_type = _LINK_TYPE_MAP.get(link_type_str, "FS")
                lag_days = _parse_lag_to_days(link_lag_str)
                pred_links.append(
                    PredecessorLinkData(
                        predecessor_uid=int(pred_uid_str),
                        dep_type=dep_type,
                        lag_days=lag_days,
                    )
                )

            td = TaskData(
                uid=uid,
                name=name,
                duration_days=_parse_duration_to_days(duration_str),
                outline_number=outline_number,
                outline_level=int(outline_level_str) if outline_level_str else 0,
                is_milestone=milestone_str == "1",
                percent_complete=float(pct_str) / 100.0 if pct_str else 0.0,
                notes=notes,
                start=start_str[:10] if start_str else None,
                predecessor_links=pred_links,
                resource_assignments=task_assignments.get(uid, []),
            )
            project_data.tasks.append(td)

    return project_data


def parse_mpp(mpp_content: bytes) -> ProjectData:
    """Parse MS Project .mpp binary file via MPXJ subprocess.

    Raises:
        RuntimeError: If MPXJ JAR is not available or conversion fails.
    """
    jar_path = getattr(settings, "MPXJ_JAR_PATH", "/opt/mpxj/mpxj-cli.jar")
    if not os.path.isfile(jar_path):
        raise RuntimeError(
            "MPXJ JAR not found. .mpp import requires Java and the MPXJ CLI JAR. "
            f"Expected at: {jar_path}. Set MPXJ_JAR_PATH in settings to override."
        )

    with tempfile.NamedTemporaryFile(suffix=".mpp", delete=False) as tmp:
        tmp.write(mpp_content)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["java", "-jar", jar_path, tmp_path, "-o", "xml"],
            capture_output=True,
            timeout=_MPXJ_TIMEOUT,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"MPXJ conversion failed (exit {result.returncode}): {stderr[:500]}")

        xml_output = result.stdout
        if not xml_output:
            raise RuntimeError("MPXJ produced no output")

        return parse_xml(xml_output)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"MPXJ conversion timed out after {_MPXJ_TIMEOUT}s") from None
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
