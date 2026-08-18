"""Data structures for MS Project import/export interchange."""

from __future__ import annotations

from dataclasses import dataclass, field

#: MSPDI ``<ConstraintType>`` codes the importer can express, mapped onto
#: ``Task.planned_start`` — which *is* a start-no-earlier-than floor applied by
#: the CPM forward pass (#2891).
#:
#: - **4, Start No Earlier Than** — exactly ``planned_start``'s semantics. Carried
#:   across losslessly.
#: - **2, Must Start On** — floors the start on the same date, but TruePPM has no
#:   way to enforce the "and no later" half. Carried across as the floor *and*
#:   warned, because a half-enforced commitment the operator believes is whole is
#:   worse than one they know is advisory.
#:
#: Code 0 (As Soon As Possible) is TruePPM's own default and therefore loses
#: nothing when dropped. Every remaining code (1 ALAP, 3 MFO, 5 SNLT, 6 FNET,
#: 7 FNLT) has no model home at all and is reported in the import warnings.
#:
#: Lives here rather than in ``parser`` because it is a claim about the
#: *interchange contract* — what a ``TaskData.constraint_type`` value causes the
#: importer to do — which every adapter that fills the field needs to know.
CONSTRAINT_TYPES_APPLIED_AS_SNET: frozenset[int] = frozenset({2, 4})


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
    # MSPDI <ConstraintType> code, 0-7 (#2891). This is the mechanism a PM uses
    # to *pin a committed date*, so dropping it silently turned a defensible
    # commitment into a CPM-derived guess. TruePPM models exactly one constraint
    # — the start-no-earlier-than floor `Task.planned_start` — so only the two
    # codes that floor a start (4 SNET, 2 MSO) reach the model; the parser warns
    # for every other code rather than pretending it was carried over. See
    # `MSPDI_CONSTRAINT_NAMES` / `CONSTRAINT_TYPES_APPLIED_AS_SNET` in parser.py.
    constraint_type: int | None = None
    # <ConstraintDate> as an ISO date string, or None. Only meaningful alongside
    # a constraint_type that carries a date (codes 2-7).
    constraint_date: str | None = None
    # <ActualStart> / <ActualFinish> as ISO date strings (#2891). These map
    # one-to-one onto Task.actual_start / Task.actual_finish, so unlike the
    # constraint family they are carried across exactly.
    actual_start: str | None = None
    actual_finish: str | None = None
    predecessor_links: list[PredecessorLinkData] = field(default_factory=list)
    resource_assignments: list[AssignmentData] = field(default_factory=list)
    # Label *names* (not slugs or ids) this task carries, in first-seen order
    # (ADR-0400, #2406). Deliberately names: the parser that fills this cannot
    # see the database, so resolving a name to a catalog entry — matching an
    # existing one case-insensitively, or creating it — belongs to
    # ``import_project``. Populated by the CSV/Excel adapter today; the Jira
    # adapter's components/labels, dropped since #743, are the obvious next
    # producer.
    labels: list[str] = field(default_factory=list)


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
