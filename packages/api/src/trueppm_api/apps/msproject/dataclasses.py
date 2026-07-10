"""Data structures for MS Project import/export interchange."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class TaskData:
    """Parsed task from an MS Project file."""

    uid: int
    name: str
    duration_days: int = 1
    outline_number: str = ""
    outline_level: int = 0
    is_milestone: bool = False
    percent_complete: float = 0.0
    notes: str = ""
    start: str | None = None  # ISO date string (YYYY-MM-DD)
    # Canonical TaskStatus *value* string (e.g. "complete"), or None when the
    # source did not supply an explicit status. The Jira parser maps the issue's
    # status name onto this field; the MS Project importer derives it from the
    # clamped percent-complete when None (#1768). Keeping the interchange value a
    # plain string keeps this dataclass free of a Django-model import.
    status: str | None = None
    # Task-level <CalendarUID> (#1769). TruePPM has no per-task calendars, so
    # the importer only uses this to warn when a task references a calendar
    # other than the project calendar. None covers both "element absent" and
    # the MSPDI sentinel -1 ("no task calendar").
    calendar_uid: int | None = None
    # Three-point / PERT estimate fields (#798, ADR-0093). Working days,
    # nullable, all-or-none: the importer sets all three to None unless the
    # source file supplied all three for a leaf (non-summary, non-milestone)
    # task. The fields map to Task.optimistic_duration / most_likely_duration /
    # pessimistic_duration (IntegerField, working days) on the model.
    optimistic_duration_days: int | None = None
    most_likely_duration_days: int | None = None
    pessimistic_duration_days: int | None = None
    predecessor_links: list[PredecessorLinkData] = field(default_factory=list)
    resource_assignments: list[AssignmentData] = field(default_factory=list)


@dataclass
class PredecessorLinkData:
    """Parsed predecessor link from an MS Project file."""

    predecessor_uid: int
    dep_type: str = "FS"  # FS, SS, FF, SF
    lag_days: int = 0


@dataclass
class ResourceData:
    """Parsed resource from an MS Project file."""

    uid: int
    name: str
    max_units: float = 1.0


@dataclass
class AssignmentData:
    """Parsed resource assignment from an MS Project file."""

    task_uid: int
    resource_uid: int
    units: float = 1.0


@dataclass
class CalendarExceptionData:
    """Parsed non-working exception (holiday, shutdown) from a calendar (#1769)."""

    start: str  # ISO date string (YYYY-MM-DD)
    end: str  # ISO date string (YYYY-MM-DD), inclusive
    name: str = ""


@dataclass
class CalendarData:
    """Parsed base calendar from an MS Project file (#1769).

    ``working_days`` uses the TruePPM ``Calendar.working_days`` bitmask
    (Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64) — the parser converts
    from MSPDI ``DayType`` (1=Sunday … 7=Saturday). Only base calendars are
    parsed; resource calendars (``IsBaseCalendar=0``) have no TruePPM home.
    """

    uid: int
    name: str
    working_days: int = 31  # Mon–Fri
    hours_per_day: float = 8.0
    exceptions: list[CalendarExceptionData] = field(default_factory=list)


@dataclass
class ProjectData:
    """Complete parsed project data from an MS Project file."""

    name: str = ""
    start_date: str | None = None  # ISO date string
    # Project-level <CalendarUID> — which parsed calendar the plan is scheduled
    # on (#1769). None when the header omits it.
    calendar_uid: int | None = None
    calendars: list[CalendarData] = field(default_factory=list)
    tasks: list[TaskData] = field(default_factory=list)
    resources: list[ResourceData] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
