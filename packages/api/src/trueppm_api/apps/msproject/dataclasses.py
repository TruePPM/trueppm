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
class ProjectData:
    """Complete parsed project data from an MS Project file."""

    name: str = ""
    start_date: str | None = None  # ISO date string
    tasks: list[TaskData] = field(default_factory=list)
    resources: list[ResourceData] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
