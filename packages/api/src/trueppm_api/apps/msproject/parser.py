"""Parsers for MS Project .xml and .mpp files."""

from __future__ import annotations

import contextlib
import logging
import math
import os
import subprocess
import tempfile
import threading
import xml.etree.ElementTree as ET
from datetime import date

from defusedxml.ElementTree import fromstring as _safe_fromstring
from django.conf import settings

from trueppm_api.apps.msproject.dataclasses import (
    AssignmentData,
    CalendarData,
    CalendarExceptionData,
    PredecessorLinkData,
    ProjectData,
    ResourceData,
    TaskData,
)
from trueppm_api.apps.msproject.extended_attributes import (
    DURATION1_FIELD_ID,
    DURATION2_FIELD_ID,
    DURATION3_FIELD_ID,
    PERT_ALIAS_TOKENS,
    PERT_ROLE_BY_FIELD_ID,
)

logger = logging.getLogger(__name__)

# MS Project PredecessorLink/Type values -> TruePPM dep_type.
_LINK_TYPE_MAP = {
    "0": "FF",
    "1": "FS",
    "2": "SF",
    "3": "SS",
}

# MSPDI WeekDay/DayType (1=Sunday … 7=Saturday) -> TruePPM Calendar.working_days
# bit (Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64). DayType 0 is the
# legacy (2003-style) per-date exception form, handled separately.
_DAY_TYPE_TO_BIT = {
    "1": 64,  # Sunday
    "2": 1,  # Monday
    "3": 2,  # Tuesday
    "4": 4,  # Wednesday
    "5": 8,  # Thursday
    "6": 16,  # Friday
    "7": 32,  # Saturday
}

# Subprocess timeout for MPXJ (seconds).
_MPXJ_TIMEOUT = 120

# Sane upper bound for resource MaxUnits / assignment Units (#1720). MS Project
# expresses these as fractions of a resource's capacity (1.0 = 100%); a value of
# 10 already means ten full-time equivalents. Anything past this is either a
# corrupt/hostile file or a non-finite value we clamp — the value flows into
# resource-leveling and allocation math, so we bound it rather than let inf/NaN
# or an astronomical figure poison those computations.
_MAX_UNITS = 1_000.0


class MsProjectImportError(ValueError):
    """The uploaded MS Project file is too large to import (row-count cap, #1721).

    A ``ValueError`` subclass so the import task's ``except Exception`` marks the
    outbox row DEAD (deterministic failure — the same bytes always exceed the
    cap) and surfaces ``str(exc)`` to the UI.
    """


def _finite_float(raw: str, default: float, *, low: float, high: float) -> float:
    """Parse ``raw`` to a finite float clamped to ``[low, high]`` (#1720).

    ``bulk_create`` bypasses the model field validators, so a crafted MSPDI file
    could otherwise smuggle ``nan``, ``inf``/``-inf``, or ``1e999`` (which
    Python parses to ``inf``) straight into a ``FloatField``. Non-finite floats
    then poison CPM / Monte Carlo math and — because ``json.dumps`` emits bare
    ``NaN``/``Infinity`` tokens — produce invalid JSON in API, sync, and webhook
    bodies. We reject non-finite values by falling back to ``default`` and clamp
    the finite range so the same choke point also caps absurd magnitudes.
    """
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    return max(low, min(value, high))


# Upper bound matches Task.duration's MaxValueValidator(36_525) (~100 years).
# bulk_create() bypasses the model validators, so a crafted MSPDI file could
# otherwise smuggle astronomical integer values into the database (e.g.
# PT9999999999H gets us 1.25 billion days). Clamping in the helper is a single
# choke point that covers every parser caller — primary Duration, PERT
# Duration1/2/3, and any future Duration-typed ExtendedAttribute.
_MAX_DURATION_DAYS = 36_525


def _enforce_row_cap(kind: str, count: int, limit: int) -> None:
    """Reject an import whose ``kind`` element count exceeds ``limit`` (#1721)."""
    if count > limit:
        raise MsProjectImportError(
            f"MS Project file has too many {kind} ({count}); the import limit is "
            f"{limit}. Split the file and import in batches."
        )


def _parse_duration_to_days(duration_str: str) -> int:
    """Parse MS Project ISO 8601 duration string to working days.

    MS Project uses PT<hours>H<minutes>M<seconds>S for task durations where
    hours represent calendar hours. We convert to working days using 8h/day.
    Also handles P<n>D and P<n>DT<n>H formats. The result is clamped to
    ``[0, _MAX_DURATION_DAYS]`` because ``bulk_create`` skips the model's
    ``MaxValueValidator(36_525)`` — see the constant above for rationale.
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
    return max(0, min(total_days, _MAX_DURATION_DAYS))


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


def _positive_int_or_none(raw: str) -> int | None:
    """Parse a calendar UID reference, mapping absent/none sentinels to ``None``.

    Real calendar UIDs are positive; MSPDI uses ``-1`` for "no calendar"
    (task-level) and ``0`` never refers to a calendar.
    """
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _time_to_minutes(raw: str) -> int | None:
    """Parse an MSPDI time-of-day string (``HH:MM:SS``) to minutes since midnight."""
    parts = raw.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hours, minutes = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hours <= 24 and 0 <= minutes < 60):
        return None
    return hours * 60 + minutes


def _iso_date_or_none(raw: str) -> str | None:
    """Take the ``YYYY-MM-DD`` prefix of an MSPDI datetime, or None if malformed."""
    candidate = raw.strip()[:10]
    try:
        date.fromisoformat(candidate)
    except ValueError:
        return None
    return candidate


def _parse_calendar_exception_dates(exc_el: ET.Element, ns: str) -> tuple[str | None, str | None]:
    """Extract the (start, end) ISO dates from an ``<Exception>`` element.

    MSPDI has two encodings in the wild: the schema's ``<TimePeriod>``
    (``FromDate``/``ToDate``, written by MS Project 2007+ and MPXJ) and the
    ``EnteredStartDate``/``EnteredFinishDate`` pair some exporters emit instead.
    Prefer TimePeriod, fall back to the Entered* pair.
    """
    period = exc_el.find(f"{ns}TimePeriod")
    if period is not None:
        start = period.findtext(f"{ns}FromDate") or ""
        end = period.findtext(f"{ns}ToDate") or ""
    else:
        start = exc_el.findtext(f"{ns}EnteredStartDate") or ""
        end = exc_el.findtext(f"{ns}EnteredFinishDate") or ""
    return _iso_date_or_none(start), _iso_date_or_none(end)


def _weekday_working_hours(day_el: ET.Element, ns: str) -> float:
    """Sum a working ``<WeekDay>``'s ``<WorkingTime>`` shifts into hours.

    Zero-length and reversed (``To <= From``) shifts are ignored so a malformed
    entry contributes nothing rather than a negative total.
    """
    total = 0.0
    times_el = day_el.find(f"{ns}WorkingTimes")
    for wt in times_el.findall(f"{ns}WorkingTime") if times_el is not None else []:
        frm = _time_to_minutes(wt.findtext(f"{ns}FromTime") or "")
        to = _time_to_minutes(wt.findtext(f"{ns}ToTime") or "")
        if frm is not None and to is not None and to > frm:
            total += (to - frm) / 60.0
    return total


def _legacy_weekday_exception(
    day_el: ET.Element, ns: str, name: str, *, working: bool, warnings: list[str]
) -> CalendarExceptionData | None:
    """Parse a legacy (2003-style) dated ``<WeekDay DayType=0>`` exception.

    These encode an exception as a dated WeekDay entry rather than an
    ``<Exceptions>`` child but share the non-working-only constraint: a working
    exception is unrepresentable and warned+skipped, and an undated one is
    dropped silently. Returns ``None`` when nothing usable was found.
    """
    start, end = _parse_calendar_exception_dates(day_el, ns)
    if working:
        warnings.append(
            f"Calendar '{name}': working-time exception "
            f"{start or '?'} to {end or '?'} is not supported and was skipped"
        )
        return None
    if start and end:
        return CalendarExceptionData(start=start, end=end)
    return None


def _parse_weekday_definitions(
    cal_el: ET.Element, ns: str, name: str, warnings: list[str]
) -> tuple[int, list[float], list[CalendarExceptionData]]:
    """Walk ``<WeekDays>`` into (working-day mask, per-day hours, legacy exceptions).

    The mask starts from the Mon-Fri default and each listed ``<WeekDay>``
    overrides its own day; a resulting all-non-working week is guarded back to
    Mon-Fri (the model's ``validate_working_day_mask`` invariant — a maskless
    calendar would spin the engine's calendar walk, and the importer writes rows
    without running field validators). Legacy dated exceptions are collected here
    so they precede the ``<Exceptions>`` block's rows in the final list.
    """
    mask = 31  # Mon–Fri baseline; listed WeekDay entries override per day.
    day_hours: list[float] = []
    exceptions: list[CalendarExceptionData] = []

    weekdays_el = cal_el.find(f"{ns}WeekDays")
    for day_el in weekdays_el.findall(f"{ns}WeekDay") if weekdays_el is not None else []:
        day_type = (day_el.findtext(f"{ns}DayType") or "").strip()
        working = (day_el.findtext(f"{ns}DayWorking") or "").strip() == "1"
        if day_type == "0":
            exc = _legacy_weekday_exception(day_el, ns, name, working=working, warnings=warnings)
            if exc is not None:
                exceptions.append(exc)
            continue
        bit = _DAY_TYPE_TO_BIT.get(day_type)
        if bit is None:
            continue
        if working:
            mask |= bit
            hours = _weekday_working_hours(day_el, ns)
            if hours > 0:
                day_hours.append(hours)
        else:
            mask &= ~bit

    if mask & 0b111_1111 == 0:
        warnings.append(
            f"Calendar '{name}': no working weekday defined; defaulted to Monday-Friday"
        )
        mask = 31

    return mask, day_hours, exceptions


def _parse_calendar_exceptions(
    cal_el: ET.Element, ns: str, name: str, warnings: list[str]
) -> list[CalendarExceptionData]:
    """Parse the ``<Exceptions>`` block into non-working ``CalendarExceptionData`` rows.

    Working exceptions (``DayWorking=1``, e.g. a make-up Saturday) cannot be
    expressed by ``CalendarException`` (non-working only) and are warned+skipped,
    as are entries whose date range is missing or reversed.
    """
    exceptions: list[CalendarExceptionData] = []
    exceptions_el = cal_el.find(f"{ns}Exceptions")
    for exc_el in exceptions_el.findall(f"{ns}Exception") if exceptions_el is not None else []:
        exc_name = (exc_el.findtext(f"{ns}Name") or "").strip()
        start, end = _parse_calendar_exception_dates(exc_el, ns)
        working = (exc_el.findtext(f"{ns}DayWorking") or "0").strip() == "1"
        if working:
            warnings.append(
                f"Calendar '{name}': working-time exception "
                f"'{exc_name or (start or '?')}' is not supported and was skipped"
            )
            continue
        if start is None or end is None or end < start:
            warnings.append(
                f"Calendar '{name}': exception '{exc_name or '?'}' has an "
                f"unparseable date range and was skipped"
            )
            continue
        exceptions.append(CalendarExceptionData(start=start, end=end, name=exc_name))
    return exceptions


def _modal_hours_per_day(day_hours: list[float]) -> float:
    """Collapse per-day working totals to the single ``Calendar.hours_per_day`` scalar.

    Most common daily total wins (ties break toward the first seen): one scalar
    has to represent the week, and the modal day length is what duration
    conversion (days -> real dates) should assume. Defaults to 8.0 with no data
    and is clamped to a sane [1, 24] range.
    """
    if not day_hours:
        return 8.0
    hours = max(day_hours, key=day_hours.count)
    return max(1.0, min(hours, 24.0))


def _parse_one_calendar(cal_el: ET.Element, ns: str, warnings: list[str]) -> CalendarData | None:
    """Parse a single ``<Calendar>`` element, or ``None`` to skip it.

    Non-integer UIDs and non-base calendars (``IsBaseCalendar != 1``) are
    skipped; per-resource calendars have no TruePPM equivalent and importing
    them would only pollute the shared calendar library.
    """
    uid_str = (cal_el.findtext(f"{ns}UID") or "").strip()
    try:
        uid = int(uid_str)
    except ValueError:
        return None
    if (cal_el.findtext(f"{ns}IsBaseCalendar") or "").strip() != "1":
        return None
    name = (cal_el.findtext(f"{ns}Name") or "").strip() or f"Imported calendar {uid}"

    mask, day_hours, exceptions = _parse_weekday_definitions(cal_el, ns, name, warnings)
    # Legacy dated exceptions (from the WeekDays walk) precede the <Exceptions>
    # block's rows, matching the original single-pass append order.
    exceptions.extend(_parse_calendar_exceptions(cal_el, ns, name, warnings))

    return CalendarData(
        uid=uid,
        name=name,
        working_days=mask,
        hours_per_day=_modal_hours_per_day(day_hours),
        exceptions=exceptions,
    )


def _parse_calendars(root: ET.Element, ns: str, warnings: list[str]) -> list[CalendarData]:
    """Parse the ``<Calendars>`` block into ``CalendarData`` rows (#1769).

    Only *base* calendars are returned: MS Project requires project and task
    calendars to be base calendars, and per-resource calendars
    (``IsBaseCalendar=0``, one auto-generated per resource) have no TruePPM
    equivalent — importing them would only pollute the shared calendar library.

    Fidelity notes (each degradation is deliberate; see the field-coverage
    matrix in the docs):

    - The weekday mask starts from the Mon-Fri default and applies whatever
      ``<WeekDay>`` entries the file lists. Genuine MS Project exports list all
      seven days, fully overwriting the default; sparse third-party files only
      shift the days they mention instead of losing the whole week.
    - ``Calendar.hours_per_day`` is a single scalar, so per-day
      ``<WorkingTimes>`` collapse to the most common daily total across working
      days (ties break toward the first seen). Shift start/end times are not
      preserved — TruePPM schedules in whole working days.
    - Exceptions that *add* working time (``DayWorking=1``, e.g. a make-up
      Saturday) cannot be expressed by ``CalendarException`` (non-working only)
      and are skipped with a warning.
    """
    calendars_el = root.find(f"{ns}Calendars")
    if calendars_el is None:
        return []

    calendars: list[CalendarData] = []
    for cal_el in calendars_el.findall(f"{ns}Calendar"):
        cal = _parse_one_calendar(cal_el, ns, warnings)
        if cal is not None:
            calendars.append(cal)
    return calendars


def parse_xml(xml_content: bytes) -> ProjectData:
    """Parse MS Project XML content into a ProjectData structure.

    Handles both namespaced (Project 2003+) and non-namespaced XML.
    """
    # Local import (models must be app-ready): TaskStatus is used only to derive
    # each task's status from its raw PercentComplete (#1768).
    from trueppm_api.apps.projects.models import TaskStatus

    # Parse with defusedxml (#771): it forbids entity expansion and external-
    # entity resolution by default, defending against billion-laughs / XXE on the
    # user-uploaded file. The 10 MB upload cap in MsProjectImportView bounds size
    # but does NOT stop entity expansion — that was the prior, incorrect rationale.
    root = _safe_fromstring(xml_content)

    # Detect namespace
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    # Row-count cap (#1721): the upload SIZE is bounded but the row count is not.
    # A 50 MB MSPDI encodes ~1M tasks; without this cap the importer builds ~1M
    # Task objects, computes WBS over all of them, and bulk-creates the lot —
    # exhausting worker memory and holding a giant transaction open. Reject
    # outright (like the risk-CSV importer's MAX_ROWS) before building anything.
    # Counted directly off the element tree so we never materialize the objects.
    max_rows = getattr(settings, "MSPROJECT_MAX_ROWS", 20_000)
    _enforce_row_cap("tasks", len(root.findall(f".//{ns}Task")), max_rows)
    _enforce_row_cap("resources", len(root.findall(f".//{ns}Resource")), max_rows)
    _enforce_row_cap("dependencies", len(root.findall(f".//{ns}PredecessorLink")), max_rows)
    _enforce_row_cap("calendars", len(root.findall(f".//{ns}Calendar")), max_rows)
    _enforce_row_cap("calendar exceptions", len(root.findall(f".//{ns}Exception")), max_rows)

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
        calendar_uid=_positive_int_or_none(_ft(root, "CalendarUID")),
    )

    # --- Parse calendars (#1769) ---
    project_data.calendars = _parse_calendars(root, ns, project_data.warnings)

    # --- Parse project-level ExtendedAttribute definitions (#798, ADR-0093) ---
    # Build a {role: field_id} map (e.g. {"optimistic": "188743783"}) for the
    # three PERT roles. Per the architect decision (Q1), trust the FieldID:
    # accept the binding when the canonical PERT FieldID is present and the
    # alias text either confirms the role or is empty. If the alias text
    # contradicts the role (e.g. Duration1 aliased "Risk Score") drop the
    # binding and warn — we'd rather skip than import the wrong field as
    # Optimistic. Files with no ExtendedAttributes block produce an empty map
    # and three-point import is silently skipped.
    pert_role_to_field_id = _parse_pert_extended_attribute_defs(root, ns, project_data.warnings)

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
            # Finite-guard + clamp (#1720): reject nan/inf/1e999 and cap absurd
            # capacities before the value reaches a bulk_create'd FloatField.
            max_units = (
                _finite_float(max_units_str, 1.0, low=0.0, high=_MAX_UNITS)
                if max_units_str
                else 1.0
            )
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
            # Finite-guard + clamp (#1720), same rationale as MaxUnits above.
            units = _finite_float(units_str, 1.0, low=0.0, high=_MAX_UNITS) if units_str else 1.0
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

            # PERT three-point values come in as per-task <ExtendedAttribute>
            # children matching the FieldIDs detected at project level. Values
            # are ISO-8601 durations parsed via the same _parse_duration_to_days
            # helper used for the primary Duration field. Summary tasks and
            # milestones are skipped (ADR-0093 Q5): MS Project leaves these
            # empty on summaries/milestones in practice; if a file violates
            # that we still skip to keep Monte Carlo input consistent with
            # MS Project's own semantics. Summary detection happens later
            # (importer rebuilds WBS), so we only filter milestones here and
            # leave summary filtering to the importer.
            pert_values = (
                _extract_pert_task_values(task_el, ns, pert_role_to_field_id)
                if pert_role_to_field_id
                else (None, None, None)
            )
            opt_days, ml_days, pess_days = pert_values
            is_milestone = milestone_str == "1"
            if is_milestone and (opt_days, ml_days, pess_days) != (None, None, None):
                # Drop silently rather than warn — milestones with three-point
                # values are common file noise from PMs who blanket-applied
                # estimates and there's nothing the user needs to do.
                opt_days = ml_days = pess_days = None
            # All-or-none (Q3): if fewer than all three are present, drop all
            # three and warn. The scheduler engine requires all three for
            # PERT-Beta sampling (engine.py:892), so a partial import would
            # surface as a half-populated UI with no Monte Carlo effect.
            present = sum(v is not None for v in (opt_days, ml_days, pess_days))
            if 0 < present < 3:
                missing = []
                if opt_days is None:
                    missing.append("Optimistic")
                if ml_days is None:
                    missing.append("Most Likely")
                if pess_days is None:
                    missing.append("Pessimistic")
                project_data.warnings.append(
                    f"Task '{name}': partial three-point estimate "
                    f"(missing {', '.join(missing)}), all three values skipped"
                )
                opt_days = ml_days = pess_days = None

            # Ordering guard (#2002): even a complete triple is unusable if it
            # violates optimistic <= most_likely <= pessimistic. The scheduler
            # engine rejects it (engine._validate_project) and, because the
            # importer marks estimates accepted, the invalid row would detonate
            # the first CPM/Monte-Carlo run after import. Drop all three and warn
            # — mirroring the all-or-none policy above — rather than importing
            # data that breaks scheduling.
            if (
                opt_days is not None
                and ml_days is not None
                and pess_days is not None
                and not opt_days <= ml_days <= pess_days
            ):
                project_data.warnings.append(
                    f"Task '{name}': three-point estimate out of order "
                    f"(optimistic ≤ most likely ≤ pessimistic required; got "
                    f"{opt_days} ≤ {ml_days} ≤ {pess_days}), all three values skipped"
                )
                opt_days = ml_days = pess_days = None

            # Finite-guard + clamp to [0, 100] (#1720): MS Project PercentComplete
            # is 0-100. nan/inf/1e999 (and any out-of-range figure) is rejected/
            # clamped before it reaches progress + EVM math.
            raw_percent = _finite_float(pct_str, 0.0, low=0.0, high=100.0) if pct_str else 0.0
            # Derive status from the RAW file percent (0-100), gated on whether the
            # task has a start (#1768). Keyed on the raw value so it is independent
            # of how percent is stored downstream (the 0-1-vs-0-100 question, #1759).
            # A task with no start has its percent clamped to 0 by the importer
            # (ADR-0057 Q5), so it must stay NOT_STARTED — leave status None (the
            # importer's default) rather than IN_PROGRESS, so status and progress
            # can never disagree.
            td_status: str | None = None
            if start_str:
                if raw_percent >= 100.0:
                    td_status = TaskStatus.COMPLETE.value
                elif raw_percent > 0.0:
                    td_status = TaskStatus.IN_PROGRESS.value
            td = TaskData(
                uid=uid,
                name=name,
                duration_days=_parse_duration_to_days(duration_str),
                outline_number=outline_number,
                outline_level=int(outline_level_str) if outline_level_str else 0,
                is_milestone=is_milestone,
                # Finite-guard + clamp to [0, 100] (#1720, #1759): MSPDI
                # PercentComplete is a 0-100 integer and Task.percent_complete is
                # the same 0-100 scale (validators [0,100]; EVM/rollup treat it as
                # a percent), so we keep the value on that scale here. An earlier
                # /100 divided it into a 0-1 fraction, which the importer then wrote
                # straight into the 0-100 field — a 75% task landed as 0.75%.
                # raw_percent is the same finite-clamped 0-100 value derived above
                # for status inference, so reuse it rather than re-running the guard.
                percent_complete=raw_percent,
                status=td_status,
                notes=notes,
                start=start_str[:10] if start_str else None,
                calendar_uid=_positive_int_or_none(_ft(task_el, "CalendarUID")),
                optimistic_duration_days=opt_days,
                most_likely_duration_days=ml_days,
                pessimistic_duration_days=pess_days,
                predecessor_links=pred_links,
                resource_assignments=task_assignments.get(uid, []),
            )
            project_data.tasks.append(td)

    return project_data


def _parse_pert_extended_attribute_defs(
    root: ET.Element, ns: str, warnings: list[str]
) -> dict[str, str]:
    """Detect which FieldIDs the file uses for the three PERT roles.

    Walks ``<ExtendedAttributes>/<ExtendedAttribute>`` and returns
    ``{role: field_id}`` for roles (optimistic / most_likely / pessimistic)
    backed by the canonical Duration1/2/3 FieldIDs. Duration4 is informational
    (formula slot) and ignored.

    Refuses to bind a role when the FieldID matches but the alias text
    contradicts (e.g. someone repurposed Duration1 with alias 'Risk Score') —
    the FieldID is the interchange contract, but a contradicting alias is
    strong evidence the slot has been reused.
    """
    ea_block = root.find(f"{ns}ExtendedAttributes")
    if ea_block is None:
        return {}
    bound: dict[str, str] = {}
    for ea in ea_block.findall(f"{ns}ExtendedAttribute"):
        fid_el = ea.find(f"{ns}FieldID")
        if fid_el is None:
            continue
        field_id = (fid_el.text or "").strip()
        if not field_id:
            continue
        role = PERT_ROLE_BY_FIELD_ID.get(field_id)
        if role is None or role == "expected":
            # Either not a PERT slot, or the formula slot (Duration4) we never
            # import. Skip silently.
            continue
        alias_el = ea.find(f"{ns}Alias")
        alias_raw = alias_el.text if alias_el is not None else None
        alias_text = (alias_raw or "").strip().lower()
        if alias_text:
            expected_tokens = PERT_ALIAS_TOKENS.get(field_id, ())
            if not any(tok in alias_text for tok in expected_tokens):
                # Truncate the reflected alias before surfacing it in the
                # import summary — a multi-megabyte <Alias> would bloat the
                # warnings list (and any frontend rendering it). 100 chars
                # is enough to diagnose the mismatch.
                alias_display = (alias_raw or "")[:100]
                warnings.append(
                    f"Project ExtendedAttribute FieldID {field_id} has "
                    f"non-standard alias '{alias_display}'; three-point "
                    f"estimate ({role}) skipped"
                )
                continue
        bound[role] = field_id
    return bound


def _extract_pert_task_values(
    task_el: ET.Element, ns: str, pert_role_to_field_id: dict[str, str]
) -> tuple[int | None, int | None, int | None]:
    """Pull a task's Duration1/2/3 ExtendedAttribute values, in working days.

    Returns ``(optimistic, most_likely, pessimistic)`` with ``None`` for any
    role whose FieldID was either not defined at project level or not present
    on this task. Uses the same ``_parse_duration_to_days`` helper as the
    primary Duration field so working-day semantics (8h/day floor) match.
    """
    opt_fid = pert_role_to_field_id.get("optimistic")
    ml_fid = pert_role_to_field_id.get("most_likely")
    pess_fid = pert_role_to_field_id.get("pessimistic")
    values: dict[str, int | None] = {
        DURATION1_FIELD_ID: None,
        DURATION2_FIELD_ID: None,
        DURATION3_FIELD_ID: None,
    }
    for ea in task_el.findall(f"{ns}ExtendedAttribute"):
        fid_el = ea.find(f"{ns}FieldID")
        val_el = ea.find(f"{ns}Value")
        if fid_el is None or val_el is None:
            continue
        fid = (fid_el.text or "").strip()
        if fid not in values:
            continue
        raw = (val_el.text or "").strip()
        if not raw:
            continue
        values[fid] = _parse_duration_to_days(raw)
    return (
        values.get(opt_fid) if opt_fid else None,
        values.get(ml_fid) if ml_fid else None,
        values.get(pess_fid) if pess_fid else None,
    )


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

    max_output = getattr(settings, "MPXJ_MAX_OUTPUT_MB", 512) * 1024 * 1024
    max_heap = getattr(settings, "MPXJ_MAX_HEAP_MB", 512)

    with tempfile.NamedTemporaryFile(suffix=".mpp", delete=False) as tmp:
        tmp.write(mpp_content)
        tmp_path = tmp.name

    try:
        # Bounded stdout streaming (#1722). The old capture_output=True buffered
        # MPXJ's entire stdout with no limit, so a decompression-bomb .mpp — small
        # enough to pass the 50 MB upload cap — could expand to multi-GB XML and
        # OOM the worker. We stream stdout in chunks and abort the moment the total
        # crosses MPXJ_MAX_OUTPUT_MB, killing the JVM. `-Xmx` is a second bound:
        # even a bomb that balloons MPXJ's in-memory model dies with a JVM OOM
        # (non-zero exit) rather than driving the host into swap. stderr is small
        # (error text only) and read after EOF, so it cannot deadlock the pipe.
        proc = subprocess.Popen(
            ["java", f"-Xmx{max_heap}m", "-jar", jar_path, tmp_path, "-o", "xml"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        # Watchdog: preserve the original hard timeout even though we no longer use
        # subprocess.run's timeout= (a blocking read on a hung, silent JVM would
        # otherwise never return).
        timed_out = threading.Event()

        def _kill_on_timeout() -> None:
            timed_out.set()
            proc.kill()

        timer = threading.Timer(_MPXJ_TIMEOUT, _kill_on_timeout)
        timer.start()

        chunks: list[bytes] = []
        total = 0
        try:
            assert proc.stdout is not None
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_output:
                    proc.kill()
                    raise RuntimeError(
                        "MPXJ produced more than "
                        f"{max_output // (1024 * 1024)} MB of XML — aborting as a "
                        "likely decompression bomb."
                    )
                chunks.append(chunk)
            proc.wait()
        finally:
            timer.cancel()

        if timed_out.is_set():
            raise RuntimeError(f"MPXJ conversion timed out after {_MPXJ_TIMEOUT}s")

        if proc.returncode != 0:
            stderr_bytes = proc.stderr.read() if proc.stderr is not None else b""
            stderr = stderr_bytes.decode("utf-8", errors="replace")
            raise RuntimeError(f"MPXJ conversion failed (exit {proc.returncode}): {stderr[:500]}")

        xml_output = b"".join(chunks)
        if not xml_output:
            raise RuntimeError("MPXJ produced no output")

        return parse_xml(xml_output)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
