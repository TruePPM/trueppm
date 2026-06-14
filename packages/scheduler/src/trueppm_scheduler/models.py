"""Core data structures for the TruePPM scheduler."""

from __future__ import annotations

import enum
import json
import math
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Self


class DependencyType(enum.Enum):
    """Relationship type between two tasks."""

    FS = "FS"  # Finish-to-Start
    FF = "FF"  # Finish-to-Finish
    SS = "SS"  # Start-to-Start
    SF = "SF"  # Start-to-Finish


class DeliveryMode(enum.Enum):
    """How a task's duration uncertainty is modeled in Monte Carlo (#411).

    ``WATERFALL`` (the default when ``Task.delivery_mode`` is ``None``) samples
    from the task's three-point PERT estimate, or uses the deterministic duration
    when no estimate is set. ``SCRUM`` instead treats the task as a sprint-delivered
    body of work: its duration is sampled from the team's velocity distribution
    (``Project.velocity_samples``), estimating sprints-to-completion from the
    committed ``story_points`` rather than a per-task duration estimate.
    """

    WATERFALL = "waterfall"
    SCRUM = "scrum"


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
        # Wrap malformed input in the public InvalidScheduleInput (#826) so the
        # deserialization surface raises one documented exception type.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            return cls(
                start=date.fromisoformat(data["start"]),
                end=date.fromisoformat(data["end"]),
            )
        except (KeyError, ValueError, TypeError) as err:
            raise InvalidScheduleInput(f"Invalid date range: {err}") from err


@dataclass
class Task:
    """A schedulable unit of work."""

    id: str
    name: str
    duration: timedelta

    # Planned dates (user-set). Only ``planned_start`` is consumed by the engine
    # (as a start-no-earlier-than constraint). ``planned_finish`` is RESERVED
    # (#826): it round-trips through to_dict/from_dict for API parity but the CPM
    # pass does not yet treat it as a finish-no-later-than constraint. Documented
    # as reserved rather than removed so existing serialized documents stay valid;
    # honoring it as an SNLT constraint is a planned, separately-reviewed change.
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
    # RESERVED (#826): round-trips for API parity but is NOT consumed by schedule()
    # or monte_carlo() — neither uses it as a remaining-duration driver yet.
    # Documented rather than removed to keep serialized documents valid.
    percent_complete: float = 0.0

    # Three-point estimation (PERT)
    optimistic_duration: timedelta | None = None
    most_likely_duration: timedelta | None = None
    pessimistic_duration: timedelta | None = None

    # Agile-aware Monte Carlo (#411). ``delivery_mode=SCRUM`` + ``story_points``
    # make the task sample from the project's velocity distribution instead of a
    # three-point estimate. ``None`` delivery_mode == WATERFALL (backward compatible
    # with every existing serialized document — both fields default to absent).
    delivery_mode: DeliveryMode | None = None
    story_points: float | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = _serialize(asdict(self))
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        d = dict(data)
        d["duration"] = _parse_timedelta(d["duration"])
        d["total_float"] = _parse_timedelta(d.get("total_float", 0))
        d["free_float"] = _parse_timedelta(d.get("free_float", 0))
        pc = d.get("percent_complete")
        if pc is not None and not math.isfinite(float(pc)):
            raise ValueError("percent_complete must be a finite number.")
        # from_json rejects NaN/Infinity at the JSON layer, but the from_dict path
        # bypasses json.loads — without this an infinite story_points slips through
        # parse and only blows up later as a bare OverflowError inside the velocity
        # sampler (int(np.ceil(inf/mean))), bypassing the documented input contract
        # (#1010). NaN is harmless (it fails the > 0 sampler gate); Infinity is not.
        sp = d.get("story_points")
        if sp is not None and not math.isfinite(float(sp)):
            raise ValueError("story_points must be a finite number.")
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
        if d.get("delivery_mode") is not None:
            # Same first-run-legibility treatment as dep_type (#947): name the
            # field and list the allowed modes instead of a bare enum ValueError.
            try:
                d["delivery_mode"] = DeliveryMode(d["delivery_mode"])
            except ValueError as err:
                from trueppm_scheduler.engine import InvalidScheduleInput

                allowed = ", ".join(m.value for m in DeliveryMode)
                raise InvalidScheduleInput(
                    f"Invalid delivery_mode {d['delivery_mode']!r}; must be one of: {allowed}."
                ) from err
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
        # A bad dep_type would otherwise surface as Python's bare
        # ``ValueError: 'XX' is not a valid DependencyType`` — accurate but it
        # neither names the field nor lists what *is* allowed, which is exactly
        # the first-run error quality alpha adopters judge the library on (#947).
        raw_type = data.get("dep_type", "FS")
        try:
            dep_type = DependencyType(raw_type)
        except ValueError as err:
            from trueppm_scheduler.engine import InvalidScheduleInput

            allowed = ", ".join(t.value for t in DependencyType)
            raise InvalidScheduleInput(
                f"Invalid dependency type {raw_type!r}; must be one of: {allowed}."
            ) from err
        return cls(
            predecessor_id=data["predecessor_id"],
            successor_id=data["successor_id"],
            dep_type=dep_type,
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
    # RESERVED (#826): the engine schedules in whole-day units, so hours_per_day
    # and timezone are NOT consumed by CPM/Monte Carlo today — they round-trip for
    # API/calendar parity only. hours_per_day in particular is a knob users will
    # assume affects calculation; it does not (yet). Documented rather than removed
    # so serialized calendars stay valid; sub-day scheduling is a future change.
    hours_per_day: float = 8.0
    timezone: str = "UTC"

    def is_working_day(self, d: date) -> bool:
        # date.weekday(): Monday=0, Sunday=6
        if not (self.working_days >> d.weekday()) & 1:
            return False
        return not any(exc.start <= d <= exc.end for exc in self.exceptions)

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
            exceptions=[DateRange.from_dict(e) for e in data.get("exceptions", [])],
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

    # Agile-aware Monte Carlo inputs (#411). ``velocity_samples`` is the team's
    # historical throughput series — completed story points per closed sprint —
    # which scrum tasks bootstrap-sample to estimate sprints-to-completion.
    # ``sprint_length_days`` is the cadence in *working* days (the engine schedules
    # in working days). Both default to absent; without them a SCRUM task gracefully
    # falls back to its deterministic duration.
    velocity_samples: list[float] | None = None
    sprint_length_days: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "start_date": self.start_date.isoformat(),
            "tasks": [t.to_dict() for t in self.tasks],
            "dependencies": [d.to_dict() for d in self.dependencies],
            "calendar": self.calendar.to_dict(),
            "velocity_samples": self.velocity_samples,
            "sprint_length_days": self.sprint_length_days,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        # Wrap the raw KeyError/ValueError/TypeError from a malformed document in
        # the public InvalidScheduleInput so the documented exception surface is
        # complete (#826) — callers catch one exception type, not the internals
        # of dict access / date parsing. Function-local import avoids the
        # models<->engine circular import at module load.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            # Finite-check velocity_samples on the from_dict path too — from_json
            # rejects non-finite literals up front, but a dict built in Python can
            # smuggle an inf sample that later poisons the bootstrap mean in the
            # velocity sampler (#1010). The bare ValueError is re-wrapped as
            # InvalidScheduleInput by the surrounding except, matching the rest of
            # the deserialization surface.
            velocity_samples = data.get("velocity_samples")
            if velocity_samples is not None:
                for s in velocity_samples:
                    if s is not None and not math.isfinite(float(s)):
                        raise ValueError(f"velocity_samples must be finite numbers (got {s!r}).")
            return cls(
                id=data["id"],
                name=data["name"],
                start_date=date.fromisoformat(data["start_date"]),
                tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
                dependencies=[Dependency.from_dict(d) for d in data.get("dependencies", [])],
                calendar=Calendar.from_dict(data.get("calendar", {})),
                velocity_samples=velocity_samples,
                sprint_length_days=data.get("sprint_length_days"),
            )
        except (KeyError, ValueError, TypeError) as err:
            raise InvalidScheduleInput(f"Invalid project document: {err}") from err

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_json(cls, s: str) -> Self:
        # json.loads accepts the non-standard literals NaN/Infinity/-Infinity by
        # default; reject them so a hostile document can't smuggle a non-finite
        # duration (→ OverflowError) or percent_complete (→ invalid JSON on the
        # way back out) into the engine.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            data = json.loads(s, parse_constant=_reject_nonfinite)
        except (ValueError, TypeError) as err:  # JSONDecodeError is a ValueError
            raise InvalidScheduleInput(f"Invalid project JSON: {err}") from err
        return cls.from_dict(data)


# --- Serialization helpers ---


def _reject_nonfinite(token: str) -> Any:
    """parse_constant hook: reject NaN / Infinity / -Infinity in a project document."""
    raise ValueError(f"Non-finite JSON literal {token!r} is not allowed in a project document.")


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
    """Parse a timedelta from seconds (int/float) or an existing timedelta.

    Rejects non-finite values: ``timedelta(seconds=inf)`` raises a bare
    ``OverflowError`` that callers don't expect, so normalise it to a
    ``ValueError`` here (covers the ``from_dict`` path, which does not go
    through ``json.loads``).
    """
    if isinstance(val, timedelta):
        return val
    seconds = float(val)
    if not math.isfinite(seconds):
        raise ValueError(f"Duration must be a finite number of seconds, got {val!r}.")
    return timedelta(seconds=seconds)
