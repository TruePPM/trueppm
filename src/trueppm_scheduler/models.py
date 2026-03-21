"""Core data structures for the TruePPM scheduler."""

from __future__ import annotations

import enum
import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Self


class DependencyType(enum.Enum):
    """Relationship type between two tasks."""

    FS = "FS"  # Finish-to-Start
    FF = "FF"  # Finish-to-Finish
    SS = "SS"  # Start-to-Start
    SF = "SF"  # Start-to-Finish


@dataclass
class DateRange:
    """A contiguous range of dates (inclusive on both ends)."""

    start: date
    end: date

    def __post_init__(self) -> None:
        if self.end < self.start:
            msg = f"end ({self.end}) must be >= start ({self.start})"
            raise ValueError(msg)

    def to_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            start=date.fromisoformat(data["start"]),
            end=date.fromisoformat(data["end"]),
        )


@dataclass
class Task:
    """A schedulable unit of work."""

    id: str
    name: str
    duration: timedelta

    # Planned dates (user-set)
    planned_start: date | None = None
    planned_finish: date | None = None

    # CPM-computed dates
    early_start: date | None = None
    early_finish: date | None = None
    late_start: date | None = None
    late_finish: date | None = None

    # Float
    total_float: timedelta = field(default_factory=timedelta)
    free_float: timedelta = field(default_factory=timedelta)

    # Status
    is_critical: bool = False
    percent_complete: float = 0.0

    # Three-point estimation (PERT)
    optimistic_duration: timedelta | None = None
    most_likely_duration: timedelta | None = None
    pessimistic_duration: timedelta | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = _serialize(asdict(self))
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        d = dict(data)
        d["duration"] = _parse_timedelta(d["duration"])
        d["total_float"] = _parse_timedelta(d.get("total_float", 0))
        d["free_float"] = _parse_timedelta(d.get("free_float", 0))
        for f in (
            "planned_start",
            "planned_finish",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
        ):
            if d.get(f) is not None:
                d[f] = date.fromisoformat(d[f])
        for f in (
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
        ):
            if d.get(f) is not None:
                d[f] = _parse_timedelta(d[f])
        return cls(**d)


@dataclass
class Dependency:
    """A precedence relationship between two tasks."""

    predecessor_id: str
    successor_id: str
    dep_type: DependencyType = DependencyType.FS
    lag: timedelta = field(default_factory=timedelta)

    def to_dict(self) -> dict[str, Any]:
        return {
            "predecessor_id": self.predecessor_id,
            "successor_id": self.successor_id,
            "dep_type": self.dep_type.value,
            "lag": self.lag.total_seconds(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            predecessor_id=data["predecessor_id"],
            successor_id=data["successor_id"],
            dep_type=DependencyType(data.get("dep_type", "FS")),
            lag=_parse_timedelta(data.get("lag", 0)),
        )


@dataclass
class Calendar:
    """Defines working time for scheduling calculations.

    working_days is a 7-bit mask where bit 0 = Monday, bit 6 = Sunday.
    Default 0b0011111 (Mon-Fri).
    """

    working_days: int = 0b0011111
    exceptions: list[DateRange] = field(default_factory=list)
    hours_per_day: float = 8.0
    timezone: str = "UTC"

    def is_working_day(self, d: date) -> bool:
        # date.weekday(): Monday=0, Sunday=6
        if not (self.working_days >> d.weekday()) & 1:
            return False
        return not any(
            exc.start <= d <= exc.end for exc in self.exceptions
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "working_days": self.working_days,
            "exceptions": [e.to_dict() for e in self.exceptions],
            "hours_per_day": self.hours_per_day,
            "timezone": self.timezone,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            working_days=data.get("working_days", 0b0011111),
            exceptions=[
                DateRange.from_dict(e) for e in data.get("exceptions", [])
            ],
            hours_per_day=data.get("hours_per_day", 8.0),
            timezone=data.get("timezone", "UTC"),
        )


@dataclass
class Project:
    """Top-level container for a scheduled project."""

    id: str
    name: str
    start_date: date
    tasks: list[Task] = field(default_factory=list)
    dependencies: list[Dependency] = field(default_factory=list)
    calendar: Calendar = field(default_factory=Calendar)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "start_date": self.start_date.isoformat(),
            "tasks": [t.to_dict() for t in self.tasks],
            "dependencies": [d.to_dict() for d in self.dependencies],
            "calendar": self.calendar.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            id=data["id"],
            name=data["name"],
            start_date=date.fromisoformat(data["start_date"]),
            tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
            dependencies=[
                Dependency.from_dict(d) for d in data.get("dependencies", [])
            ],
            calendar=Calendar.from_dict(data.get("calendar", {})),
        )

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_json(cls, s: str) -> Self:
        return cls.from_dict(json.loads(s))


# --- Serialization helpers ---


def _serialize(obj: Any) -> Any:
    """Recursively convert dataclass-asdict output to JSON-safe types."""
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize(v) for v in obj]
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, timedelta):
        return obj.total_seconds()
    if isinstance(obj, enum.Enum):
        return obj.value
    return obj


def _parse_timedelta(val: Any) -> timedelta:
    """Parse a timedelta from seconds (int/float) or an existing timedelta."""
    if isinstance(val, timedelta):
        return val
    return timedelta(seconds=float(val))
