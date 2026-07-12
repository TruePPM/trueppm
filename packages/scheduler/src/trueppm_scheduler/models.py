"""Core data structures for the TruePPM scheduler."""

from __future__ import annotations

import bisect
import enum
import json
import math
import re
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Self


# Enum value-casing convention (frozen public contract).
#
# These string *values* are persisted to disk and round-tripped by PyPI
# consumers, so their casing is a 1.0 contract that must not change without a
# coordinated data migration in every store that holds them (including the
# TruePPM API, which mirrors both enums). Two deliberate, distinct conventions:
#
#   * Acronym enums use UPPERCASE values that *are* the acronym
#     (``DependencyType``: ``FS``/``FF``/``SS``/``SF`` — the industry CPM
#     convention shared by MS Project and Primavera and by the API
#     ``DependencyType``).
#   * Word enums use lowercase identifier values (``DeliveryMode``:
#     ``waterfall``/``scrum`` — matching the API ``DeliveryMode`` TextChoices).
#
# The casing therefore differs *between* the two enums by design; it is uniform
# *within* each value-kind. Do not "normalise" one to the other — that would
# break interop with the API and every serialized document already on disk.
class DependencyType(enum.Enum):
    """Relationship type between two tasks.

    Values are uppercase acronyms (``FS``/``FF``/``SS``/``SF``); see the
    enum-casing convention note above — this casing is a frozen public contract.
    """

    FS = "FS"  # Finish-to-Start
    FF = "FF"  # Finish-to-Finish
    SS = "SS"  # Start-to-Start
    SF = "SF"  # Start-to-Finish


class DeliveryMode(enum.Enum):
    """How a task's duration uncertainty is modeled in Monte Carlo.

    Values are lowercase identifiers (``waterfall``/``scrum``); see the
    enum-casing convention note above — this casing is a frozen public contract.

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
        """Serialize to a JSON-safe dict with ISO-8601 ``start``/``end`` dates."""
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        """Build a :class:`DateRange` from a ``to_dict`` mapping.

        Args:
            data: A mapping with ``start`` and ``end`` date strings in strict
                ISO-8601 ``YYYY-MM-DD`` form.

        Returns:
            The reconstructed :class:`DateRange`.

        Raises:
            InvalidScheduleInput: If a key is missing or a date is malformed.
        """
        # Wrap malformed input in the public InvalidScheduleInput (#826) so the
        # deserialization surface raises one documented exception type.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            return cls(
                start=_parse_date(data["start"], "start"),
                end=_parse_date(data["end"], "end"),
            )
        except (KeyError, ValueError, TypeError) as err:
            raise InvalidScheduleInput(f"Invalid date range: {err}") from err


@dataclass
class Task:
    """A schedulable unit of work.

    Note:
        Reserved-but-inert field: ``planned_finish`` is accepted for
        serialization parity (it round-trips through ``to_dict`` / ``from_dict``)
        but is **not yet consumed** by the engine — the CPM pass does not treat
        it as a finish-no-later-than constraint. ``planned_start`` *is* honored,
        as a start-no-earlier-than floor.
    """

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
    # Progress (ADR-0132). Consumed by both schedule() and monte_carlo() as a
    # remaining-duration driver: an in-progress task contributes only
    # ``duration * (1 - percent_complete/100)`` of remaining work, scheduled
    # forward from the project ``status_date`` (the data date), not its full
    # estimate from project start. Clamped to [0, 100] by the engine.
    percent_complete: float = 0.0

    # Actuals (ADR-0132). When ``actual_finish`` is set the task is treated as
    # complete and pinned to its recorded dates — not re-scheduled or (in Monte
    # Carlo) re-sampled. ``actual_start`` records when work began; both default
    # to absent, so a document with no actuals schedules exactly as before.
    actual_start: date | None = None
    actual_finish: date | None = None

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

    # Per-task calendar (ADR-0120 D3, cross-project dependencies). When set, and
    # the owning :class:`Project` supplies a matching entry in ``Project.calendars``,
    # this task's *duration* arithmetic uses that calendar instead of the
    # pass-level ``Project.calendar``. It is the substrate for a program-scoped
    # CPM pass where tasks drawn from different member projects each keep their
    # own working week in one merged schedule. ``None`` (the default) — or an id
    # with no matching entry — means "use the pass-level calendar", so every
    # existing single-calendar document schedules byte-for-byte as before.
    calendar_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the task to a JSON-safe dict.

        Durations are emitted as seconds (floats), dates as ISO-8601 strings, and
        ``delivery_mode`` as its enum value — the inverse of :meth:`from_dict`.
        Reserved-but-inert fields (``planned_finish``) round-trip unchanged.
        """
        result: dict[str, Any] = _serialize(asdict(self))
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        """Build a :class:`Task` from a :meth:`to_dict` mapping.

        Args:
            data: A task mapping. ``duration`` and the PERT/float fields are
                seconds (int/float) or timedeltas; date fields are strict
                ISO-8601 ``YYYY-MM-DD`` strings; ``delivery_mode`` is a
                :class:`DeliveryMode` value.

        Returns:
            The reconstructed :class:`Task`.

        Raises:
            InvalidScheduleInput: If a required field is missing or malformed, a
                numeric field is non-finite, or ``delivery_mode`` is not a known
                mode.
        """
        # Wrap the whole body so a directly-called Task.from_dict (a public
        # classmethod) raises the documented InvalidScheduleInput rather than a bare
        # TypeError/KeyError — e.g. a non-string planned_start hitting
        # _parse_date, or an unknown field reaching cls(**d) (#1209). Via
        # Project.from_dict the same coverage already applied; this closes the
        # direct-call surface. InvalidScheduleInput is re-raised unwrapped so its
        # specific message (bad delivery_mode) survives.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
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
                "actual_start",
                "actual_finish",
            ):
                if d.get(f) is not None:
                    d[f] = _parse_date(d[f], f)
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
                    allowed = ", ".join(m.value for m in DeliveryMode)
                    raise InvalidScheduleInput(
                        f"Invalid delivery_mode {d['delivery_mode']!r}; must be one of: {allowed}."
                    ) from err
            return cls(**d)
        except InvalidScheduleInput:
            raise
        except (KeyError, ValueError, TypeError, AttributeError) as err:
            raise InvalidScheduleInput(f"Invalid task document: {err}") from err


@dataclass
class Dependency:
    """A precedence relationship between two tasks."""

    predecessor_id: str
    successor_id: str
    dep_type: DependencyType = DependencyType.FS
    lag: timedelta = field(default_factory=timedelta)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict (``dep_type`` as its value, lag as seconds)."""
        return {
            "predecessor_id": self.predecessor_id,
            "successor_id": self.successor_id,
            "dep_type": self.dep_type.value,
            "lag": self.lag.total_seconds(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        """Build a :class:`Dependency` from a :meth:`to_dict` mapping.

        Args:
            data: A mapping with ``predecessor_id``, ``successor_id``, an optional
                ``dep_type`` (defaults to ``FS``), and an optional ``lag`` in
                seconds.

        Returns:
            The reconstructed :class:`Dependency`.

        Raises:
            InvalidScheduleInput: If ``dep_type`` is not a known dependency type.
        """
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

    Note:
        Reserved-but-inert fields: ``hours_per_day`` and ``timezone`` are
        accepted for serialization parity but are **not yet consumed** by the
        engine — scheduling is in whole-day units, so ``Calendar(hours_per_day=4)``
        does *not* produce half-day scheduling. Sub-day scheduling is a future
        change (#1216).
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

    # Cached sorted/merged exception intervals as parallel ordinal lists, for an
    # O(log E) is_working_day lookup instead of an O(E) linear scan (#1206). The
    # calendar walk calls is_working_day once per day stepped, so the old linear
    # scan made a schedule on a calendar with thousands of exceptions O(span x E)
    # — minutes of synchronous work. Lazily built on first use and keyed by a cheap
    # (len, id) token so a reassigned/grown exceptions list rebuilds. Excluded from
    # init, repr, equality, and the manual to_dict — not part of the public surface.
    _exc_index: tuple[list[int], list[int]] | None = field(
        default=None, init=False, repr=False, compare=False
    )
    _exc_token: tuple[int, int] | None = field(default=None, init=False, repr=False, compare=False)

    def is_working_day(self, d: date) -> bool:
        # date.weekday(): Monday=0, Sunday=6
        if not (self.working_days >> d.weekday()) & 1:
            return False
        if not self.exceptions:
            return True
        starts, ends = self._exception_intervals()
        o = d.toordinal()
        # The intervals are merged and disjoint, so d is an exception iff it falls
        # within the single interval whose start is the rightmost <= d.
        i = bisect.bisect_right(starts, o) - 1
        return not (i >= 0 and o <= ends[i])

    def _exception_intervals(self) -> tuple[list[int], list[int]]:
        """Sorted, merged exception intervals as parallel ordinal lists (#1206).

        Rebuilt only when the exceptions list is replaced or changes length (the
        cheap ``(len, id)`` token). Merging overlapping/adjacent ranges keeps the
        intervals disjoint, so a single :func:`bisect.bisect_right` locates the only
        range that could contain a date.
        """
        token = (len(self.exceptions), id(self.exceptions))
        if self._exc_token == token and self._exc_index is not None:
            return self._exc_index
        ranges = sorted((e.start.toordinal(), e.end.toordinal()) for e in self.exceptions)
        starts: list[int] = []
        ends: list[int] = []
        for s, e in ranges:
            if ends and s <= ends[-1] + 1:
                ends[-1] = max(ends[-1], e)
            else:
                starts.append(s)
                ends.append(e)
        self._exc_index = (starts, ends)
        self._exc_token = token
        return self._exc_index

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict.

        Emits the ``working_days`` bitmask, serialized ``exceptions``, and the
        reserved-but-inert ``hours_per_day``/``timezone`` fields. The private
        exception-index cache is excluded — it is rebuilt lazily on load.
        """
        return {
            "working_days": self.working_days,
            "exceptions": [e.to_dict() for e in self.exceptions],
            "hours_per_day": self.hours_per_day,
            "timezone": self.timezone,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        """Build a :class:`Calendar` from a :meth:`to_dict` mapping.

        Args:
            data: A mapping with an optional ``working_days`` integer bitmask in
                ``[0, 127]`` (defaults to Mon-Fri), an ``exceptions`` list of
                date-range mappings, and optional ``hours_per_day``/``timezone``.

        Returns:
            The reconstructed :class:`Calendar`.

        Raises:
            InvalidScheduleInput: If ``data`` is not a mapping or ``working_days``
                is not an integer bitmask in range.
        """
        from trueppm_scheduler.engine import InvalidScheduleInput

        # A non-dict ``calendar`` (e.g. the JSON string ``"weekdays"``) otherwise
        # reaches ``data.get`` and leaks a bare AttributeError past the documented
        # exception contract (#1207).
        if not isinstance(data, dict):
            raise InvalidScheduleInput(f"calendar must be an object, got {type(data).__name__}.")
        # Validate the bitmask at parse time: a string/float/negative working_days
        # is silently accepted here and only blows up later inside schedule() as a
        # bare TypeError on ``working_days & mask`` (#1209). bool is an int subclass
        # but never a valid mask, so reject it explicitly.
        wd = data.get("working_days", 0b0011111)
        if isinstance(wd, bool) or not isinstance(wd, int) or not (0 <= wd < 0b1000_0000):
            raise InvalidScheduleInput(
                f"working_days must be an integer bitmask in [0, 127] (got {wd!r})."
            )
        return cls(
            working_days=wd,
            exceptions=[DateRange.from_dict(e) for e in data.get("exceptions", [])],
            hours_per_day=data.get("hours_per_day", 8.0),
            timezone=data.get("timezone", "UTC"),
        )

    @classmethod
    def compose(cls, calendars: Iterable[Calendar]) -> Calendar:
        """Overlay several calendars into one effective non-working mask (#906).

        A day is **non-working** in the composed calendar iff **any** source
        calendar marks it non-working — the union of every source's non-working
        time. Two independent axes carry that union:

        - **Weekly pattern**: ``working_days`` is the bitwise-AND of every
          source mask, so a weekday counts as working only when *every* source
          treats it as working (e.g. a Mon-Fri project calendar AND-ed with a
          Mon-Thu part-time calendar yields Mon-Thu).
        - **Exception ranges**: the composed ``exceptions`` is the concatenation
          of every source's ranges. ``is_working_day`` already merges overlapping
          intervals lazily (``_exception_intervals``), so overlapping holidays
          across calendars collapse correctly and the O(log E) lookup is
          preserved — no interval structure is needed here (issue #906 Q3).

        ``hours_per_day``/``timezone`` are reserved-but-inert (they do not affect
        whole-day CPM), so the first source's values are carried for parity and
        the rest are ignored rather than reconciled.

        This is the OSS composition seam enterprise extends by contributing
        additional sources (e.g. per-resource PTO) to ``calendars`` — it takes a
        plain iterable of dataclasses and stays Django-free.

        Args:
            calendars: The source calendars to overlay, in display order. An
                empty iterable yields the Mon-Fri/8h/UTC default.

        Returns:
            A new :class:`Calendar` whose non-working time is the union of every
            source's non-working time.
        """
        cals = list(calendars)
        if not cals:
            return cls()
        working_days = cals[0].working_days
        for c in cals[1:]:
            working_days &= c.working_days
        exceptions: list[DateRange] = []
        for c in cals:
            exceptions.extend(c.exceptions)
        return cls(
            working_days=working_days,
            exceptions=exceptions,
            hours_per_day=cals[0].hours_per_day,
            timezone=cals[0].timezone,
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

    # Data date (ADR-0132). The "as-of" anchor for progress-aware forecasting:
    # completed work is held fixed, and remaining/not-started work is scheduled
    # no earlier than this date. ``None`` means "no status anchor" — the engine
    # schedules from ``start_date`` exactly as before. Callers resolve a null
    # project status date to today before invoking the engine (the engine itself
    # stays pure and never reads the wall clock).
    status_date: date | None = None

    # Per-task calendar registry (ADR-0120 D3, cross-project dependencies). A
    # mapping of calendar id → :class:`Calendar` that tasks opt into via
    # ``Task.calendar_id``. ``None`` (or empty) means the whole project schedules
    # on the single pass-level ``calendar`` — the existing behavior, byte-for-byte.
    # The program-scoped CPM pass populates this so each member project's tasks
    # keep their own working week in one merged schedule, while lag on any edge is
    # consumed on the *successor's* calendar (the constraint lands where the wait
    # is). A ``calendar_id`` with no entry here falls back to ``calendar``.
    calendars: dict[str, Calendar] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the whole project graph to a JSON-safe dict.

        Recursively serializes tasks, dependencies, and the calendar(s); dates
        become ISO-8601 strings and the optional per-task calendar registry is
        emitted as ``null`` when unused. The inverse of :meth:`from_dict`.
        """
        return {
            "id": self.id,
            "name": self.name,
            "start_date": self.start_date.isoformat(),
            "tasks": [t.to_dict() for t in self.tasks],
            "dependencies": [d.to_dict() for d in self.dependencies],
            "calendar": self.calendar.to_dict(),
            "velocity_samples": self.velocity_samples,
            "sprint_length_days": self.sprint_length_days,
            "status_date": self.status_date.isoformat() if self.status_date else None,
            "calendars": (
                {cid: cal.to_dict() for cid, cal in self.calendars.items()}
                if self.calendars
                else None
            ),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        """Build a :class:`Project` from a :meth:`to_dict` mapping.

        Args:
            data: A project mapping with ``id``, ``name``, ``start_date`` and
                optional ``tasks``, ``dependencies``, ``calendar``, velocity
                inputs, ``status_date``, and per-task ``calendars`` registry.

        Returns:
            The reconstructed :class:`Project`.

        Raises:
            InvalidScheduleInput: If the document is not a mapping, a required
                field is missing, or any nested task/dependency/calendar is
                malformed (non-finite velocity samples included).
        """
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
            # Per-task calendar registry (ADR-0120 D3). Absent/null → None (the
            # single-calendar default). A non-dict value reaches ``.items()`` and
            # is wrapped as InvalidScheduleInput by the surrounding except, like
            # every other malformed-shape on this path.
            calendars_data = data.get("calendars")
            calendars = (
                {cid: Calendar.from_dict(cal) for cid, cal in calendars_data.items()}
                if calendars_data is not None
                else None
            )
            return cls(
                id=data["id"],
                name=data["name"],
                start_date=_parse_date(data["start_date"], "start_date"),
                tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
                dependencies=[Dependency.from_dict(d) for d in data.get("dependencies", [])],
                calendar=Calendar.from_dict(data.get("calendar", {})),
                velocity_samples=velocity_samples,
                sprint_length_days=data.get("sprint_length_days"),
                status_date=(
                    _parse_date(data["status_date"], "status_date")
                    if data.get("status_date") is not None
                    else None
                ),
                calendars=calendars,
            )
        except (KeyError, ValueError, TypeError, AttributeError) as err:
            # AttributeError covers a non-dict top-level document (``[1,2,3]``,
            # ``42``) reaching ``data.get`` / ``data[...]`` — without it the
            # untrusted-input ``from_json`` path leaked a bare AttributeError past
            # the documented exception contract (#1207).
            raise InvalidScheduleInput(f"Invalid project document: {err}") from err

    def to_json(self, **kwargs: Any) -> str:
        """Serialize the project to a JSON string.

        Args:
            **kwargs: Forwarded to :func:`json.dumps` (e.g. ``indent``).

        Returns:
            The project's :meth:`to_dict` form encoded as JSON.
        """
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_json(cls, s: str) -> Self:
        """Build a :class:`Project` from a JSON string produced by :meth:`to_json`.

        Non-standard JSON literals (``NaN``/``Infinity``/``-Infinity``) are
        rejected so a hostile document cannot smuggle a non-finite value into the
        engine.

        Args:
            s: A JSON document describing a project.

        Returns:
            The reconstructed :class:`Project`.

        Raises:
            InvalidScheduleInput: If the JSON is malformed, nested too deeply, or
                describes an invalid project (see :meth:`from_dict`).
        """
        # json.loads accepts the non-standard literals NaN/Infinity/-Infinity by
        # default; reject them so a hostile document can't smuggle a non-finite
        # duration (→ OverflowError) or percent_complete (→ invalid JSON on the
        # way back out) into the engine.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            data = json.loads(s, parse_constant=_reject_nonfinite)
        except (ValueError, TypeError) as err:  # JSONDecodeError is a ValueError
            raise InvalidScheduleInput(f"Invalid project JSON: {err}") from err
        except RecursionError as err:
            # Deeply nested JSON (e.g. ``"[" * 20000``) overflows the parser's C
            # recursion limit; RecursionError is neither ValueError nor TypeError,
            # so without this a ~20 KB untrusted payload escaped the contract as a
            # raw RecursionError / DoS (#1207).
            raise InvalidScheduleInput("Project JSON is nested too deeply to parse.") from err
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


# Strict ISO-8601 *extended calendar* date: exactly YYYY-MM-DD with ASCII digits.
# [0-9] (not \d) so Unicode digits can't sneak past into date.fromisoformat.
_STRICT_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _parse_date(val: Any, field_name: str) -> date:
    """Parse a date string, accepting strict ``YYYY-MM-DD`` only.

    Python 3.11+ ``date.fromisoformat`` is lenient — it also accepts compact
    (``"20260401"``), week-date (``"2026-W15-1"``), and ordinal (``"2026-092"``)
    forms. The Rust/WASM engine's chrono ``NaiveDate`` parser accepts
    ``%Y-%m-%d`` only, so a lenient form would schedule in Python but fail to
    parse in Rust — a silent cross-engine divergence (#1861). The
    deserialization surface therefore pins the single canonical format that
    ``to_dict``/``to_json`` emit and both engines parse.

    Args:
        val: The raw value from a deserialized document.
        field_name: The document field being parsed, named in the error.

    Returns:
        The parsed :class:`datetime.date`.

    Raises:
        ValueError: If ``val`` is not a string in strict ``YYYY-MM-DD`` form or
            is not a real calendar date. Callers wrap this in the public
            ``InvalidScheduleInput`` like the rest of the deserialization
            surface.
    """
    if not isinstance(val, str) or not _STRICT_DATE_RE.fullmatch(val):
        raise ValueError(
            f"{field_name} must be an ISO-8601 date string in YYYY-MM-DD format, got {val!r}."
        )
    # The regex pins the shape; fromisoformat still validates the calendar
    # (month in 1..12, day in range for the month).
    return date.fromisoformat(val)


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
