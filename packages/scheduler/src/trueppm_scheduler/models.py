"""Core data structures for the TruePPM scheduler."""

from __future__ import annotations

import bisect
import enum
import json
import math
import re
import sys
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, NoReturn, Self


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


@dataclass(frozen=True)
class DateRange:
    """A contiguous range of dates (inclusive on both ends).

    Immutable (#2462). :class:`Calendar` caches a merged-interval index derived
    from its ``exceptions``, and an in-place edit of a range inside that list
    changed nothing the cache could observe — so ``is_working_day`` kept
    answering from the pre-edit index and the whole schedule computed on a
    calendar that no longer existed. Freezing the range makes the edit a loud
    ``FrozenInstanceError`` instead of a silent wrong answer; build a new
    ``DateRange`` (and assign a new ``Calendar.exceptions``) to change a range.
    """

    start: date
    end: date

    def __post_init__(self) -> None:
        # A string bound is otherwise accepted and only surfaces later as a bare
        # AttributeError ('str' has no 'toordinal') deep in schedule() (#4518).
        for name in ("start", "end"):
            value = getattr(self, name)
            # datetime subclasses date but cannot be ordered against a plain date.
            if not isinstance(value, date) or isinstance(value, datetime):
                from trueppm_scheduler.engine import InvalidScheduleInput

                raise InvalidScheduleInput(
                    f"DateRange {name} must be a date (got {type(value).__name__})."
                )
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

    Note:
        A zero-duration milestone's ``early_start == early_finish`` is the day it
        is *shown* on, not an instant; ``milestone_at_day_end`` says which edge of
        that day it sits on. The shown day can move across a weekend or holiday
        while the working-time position does not, so compare two milestone dates
        in working time, not as a calendar-day difference. The full display rule
        is on :class:`~trueppm_scheduler.engine.ScheduleResult` (#4178).

    Attributes:
        calendar_id: Per-task calendar (ADR-0120 D3). When set, this task's
            *duration* arithmetic uses ``Project.calendars[calendar_id]`` instead of
            the pass-level ``Project.calendar`` — the substrate for a program-scoped
            CPM pass where tasks from different member projects each keep their own
            working week in one merged schedule. ``None`` (the default) means "use
            the pass-level calendar". When the project's ``calendars`` registry is
            ``None`` or empty, a set id is ignored and the task uses the pass-level
            calendar, so single-calendar documents schedule unchanged. When the
            registry is non-empty, an id naming no entry in it is **refused** with
            :class:`~trueppm_scheduler.engine.InvalidScheduleInput` by every entry
            point — it is never silently scheduled on the pass-level calendar, where
            a typo would yield a plausible schedule on the wrong working week.
        live_day_end_on: Input only, read on a **completed milestone** with
            recorded actuals (#4525). The day a previous, live run showed this
            milestone on with ``milestone_at_day_end`` True — that run's
            ``early_finish`` — or ``None``. When it names the milestone's recorded
            day (``actual_finish``, else ``actual_start``), the closed milestone
            stays at the end of that day: closing a milestone keeps the edge it
            had live, even when a predecessor is still open. Otherwise the edge is
            read from completed predecessors only, so no live forecast can move a
            closed milestone. A caller that persists schedule output (as the
            TruePPM API does) passes it back; ``None`` (the default) is always
            safe. Ignored on any other task.
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

    # Per-task calendar (ADR-0120 D3). Documented under ``Attributes:`` in the
    # class docstring so ``help(Task)`` shows the unknown-id refusal (#4516).
    calendar_id: str | None = None

    # Span start (ADR-0752). ``early_start`` means the *remaining-work window*
    # for an in-progress task (ADR-0132); ``scheduled_start`` means the task's
    # whole span instead, so a bar/consumer that wants "where does this task's
    # work begin" never has to branch on task state. See
    # :func:`trueppm_scheduler.engine._compute_scheduled_start` for the
    # per-state derivation table. ``scheduled_finish`` is deliberately NOT a
    # field here — it is always identical to ``early_finish`` (remaining work
    # ends when the task ends), so a second stored/computed date would just be
    # a copy; callers that want it read ``early_finish`` under that name.
    #
    # Declared LAST, out of its thematic group, on purpose (#2836). Field order
    # in an exported, non-``kw_only`` dataclass is a positional contract for
    # every PyPI consumer that constructs a ``Task`` positionally, and this field
    # was originally inserted between ``late_finish`` and ``total_float`` — which
    # silently re-bound the twelve fields after it with no ``TypeError``, because
    # dataclasses do no runtime type validation. New fields append; they never
    # slot in mid-sequence. ``tests/test_public_surface.py`` pins the order so the
    # next insertion fails at test time rather than in a consumer's schedule.
    scheduled_start: date | None = None

    # Where a zero-duration milestone sits within the day it is shown on (#4079).
    # A milestone is an instant; ``early_start == early_finish`` is only the day it
    # is *shown* on. ``True`` means the instant is the END of that day — the
    # milestone follows work (``A(Mon..Fri) -FS-> M`` shows ``M`` at the close of
    # Friday). ``False`` means the START of that day — it is held by a floor
    # (project start, SNET, data date, recorded actual start) or an SS link from
    # work, or a lag lands it on or just after non-working time and it is shown at
    # the start of the next working day (#4173) — and for every task that is not a
    # milestone. A completed milestone with recorded actuals keeps the edge it had
    # live (#4433): ``True`` when work finishing on its recorded day placed it. The
    # end of a Friday and the start of the next Monday are the same point in
    # working time, so the shown day can hop a weekend with no working-time move:
    # never diff two shown days as a slip (#4178, see ``ScheduleResult``).
    # Computed by the engine; an input value is ignored and overwritten. Appended
    # last for the positional-order reason given on ``scheduled_start`` above
    # (#2836).
    milestone_at_day_end: bool = False
    # Input only; see ``live_day_end_on`` under Attributes (#4525). Appended last for
    # the same positional-order reason.
    live_day_end_on: date | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the task to a JSON-safe dict.

        Durations are emitted as seconds (floats), dates as ISO-8601 strings, and
        ``delivery_mode`` as its enum value — the inverse of :meth:`from_dict`.
        Reserved-but-inert fields (``planned_finish``) round-trip unchanged.

        Raises:
            InvalidScheduleInput: If a field holds a value :meth:`from_dict` would
                refuse on the way back in — a wrong type (a string date, a
                ``datetime``, an ``int`` duration, a non-``bool`` flag, a
                non-:class:`DeliveryMode` ``delivery_mode``), a non-finite number,
                or a ``percent_complete`` outside [0, 100] (#4517).
        """
        _validate_task_fields(self)
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
            _require_str(d, "id", "task")
            _require_str(d, "name", "task")
            d["duration"] = _parse_timedelta(d["duration"])
            d["total_float"] = _parse_timedelta(d.get("total_float", 0))
            d["free_float"] = _parse_timedelta(d.get("free_float", 0))
            _require_bool(d, "is_critical")
            _require_bool(d, "milestone_at_day_end")
            _check_finite(d, "percent_complete")
            _check_percent_range(d)
            _check_finite(d, "story_points")
            _coerce_task_dates(d)
            _coerce_pert_durations(d)
            _coerce_delivery_mode(d)
            # Rust ``calendar_id: Option<String>``; a non-string id is refused by
            # schedule() too, so accepting it here split the accepted set (#4517).
            if d.get("calendar_id") is not None and not isinstance(d["calendar_id"], str):
                raise ValueError(
                    f"calendar_id must be a string or null (got {d['calendar_id']!r})."
                )
            return cls(**d)
        except InvalidScheduleInput:
            raise
        except (KeyError, ValueError, TypeError, AttributeError) as err:
            raise InvalidScheduleInput(f"Invalid task document: {err}") from err


def _require_str(d: dict[str, Any], field_name: str, owner: str) -> None:
    """Reject a non-string ``id``/``name`` on the ``from_dict`` path (#4130).

    The Rust engine's ``id``/``name`` are ``String`` under serde, so an integer id
    fails to parse there; Python used to accept it, scheduling the task as an
    isolated node (a dependency endpoint is string-checked, so it can never match),
    while an unhashable id (list/dict) or ``None`` leaked a bare TypeError/ValueError
    from the graph. A missing key is left to the caller's existing KeyError path.
    """
    if field_name in d and not isinstance(d[field_name], str):
        from trueppm_scheduler.engine import InvalidScheduleInput

        raise InvalidScheduleInput(
            f"{owner} {field_name} must be a string (got {type(d[field_name]).__name__}: "
            f"{d[field_name]!r})."
        )


def _require_number(value: Any, field_name: str) -> None:
    """Reject anything that is not a real JSON number (``int``/``float``, not ``bool``).

    ``float()`` accepts ``"259200"``, ``"2.592e5"``, ``" 86400 "`` and ``"259_200"``,
    and ``bool`` is an ``int`` subclass, so a bare ``float(val)`` let documents
    through that the Rust engine's serde rejects (``invalid type: string, expected
    f64``) — acceptance the 1.0 document format would otherwise inherit (#4512).
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a number, got {type(value).__name__}: {value!r}.")
    # An int beyond f64 range makes float() raise a bare OverflowError that escapes
    # the InvalidScheduleInput wrappers; Rust's serde rejects the same literal.
    if isinstance(value, int) and abs(value) > sys.float_info.max:
        raise ValueError(f"{field_name} is out of range for a finite number.")


def _require_bool(d: dict[str, Any], field_name: str) -> None:
    """Reject a non-``bool`` boolean field (Rust: ``invalid type, expected a boolean``)."""
    if field_name in d and not isinstance(d[field_name], bool):
        raise ValueError(
            f"{field_name} must be a boolean, got {type(d[field_name]).__name__}: "
            f"{d[field_name]!r}."
        )


def _check_percent_range(d: dict[str, Any]) -> None:
    """Reject a ``percent_complete`` outside [0, 100] (#4513).

    Mirrors the engine's ``_validate_task_numerics`` so the document path refuses at
    parse time, as it already does for a non-finite value.
    """
    value = d.get("percent_complete")
    if value is not None and not 0 <= float(value) <= 100:
        raise ValueError("percent_complete must be between 0 and 100.")


def _check_finite(d: dict[str, Any], field_name: str) -> None:
    """Reject a non-finite numeric field.

    ``from_json`` rejects NaN/Infinity at the JSON layer, but the ``from_dict`` path
    bypasses ``json.loads`` — without this an infinite ``story_points`` slips through
    parse and only blows up later as a bare ``OverflowError`` inside the velocity
    sampler (``int(np.ceil(inf/mean))``), bypassing the documented input contract
    (#1010). NaN is harmless (it fails the ``> 0`` sampler gate); Infinity is not.
    """
    value = d.get(field_name)
    if value is None:
        return
    _require_number(value, field_name)
    if not math.isfinite(float(value)):
        raise ValueError(f"{field_name} must be a finite number.")


def _list_field(d: dict[str, Any], field_name: str) -> list[Any]:
    """Return ``d[field_name]`` (default ``[]``), refusing a non-list (#4521).

    Rust's ``Vec<T>`` accepts only a JSON array; iterating ``""`` or ``{}`` parsed
    as an empty collection in Python. The ValueError is wrapped as
    ``InvalidScheduleInput`` by ``Project.from_dict``.
    """
    value = d.get(field_name, [])
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a list (got {type(value).__name__}: {value!r}).")
    return value


def _check_velocity_samples(velocity_samples: Any) -> None:
    """Reject a non-finite velocity sample on the ``from_dict`` path.

    ``from_json`` rejects non-finite literals up front, but a dict built in Python can
    smuggle an ``inf`` sample that later poisons the bootstrap mean in the velocity
    sampler (#1010). The bare ``ValueError`` is re-wrapped as ``InvalidScheduleInput``
    by the caller, matching the rest of the deserialization surface.
    """
    if velocity_samples is None:
        return
    # Rust ``Option<Vec<Option<f64>>>`` takes only a JSON array; iterating ``""`` or
    # ``{}`` parsed as "no samples" in Python (#4521).
    if not isinstance(velocity_samples, list):
        raise ValueError(
            f"velocity_samples must be a list (got {type(velocity_samples).__name__}: "
            f"{velocity_samples!r})."
        )
    for s in velocity_samples:
        if s is not None:
            _require_number(s, "velocity_samples")
            if not math.isfinite(float(s)):
                raise ValueError(f"velocity_samples must be finite numbers (got {s!r}).")


def _check_sprint_length(sprint_length_days: Any) -> None:
    """Pin ``sprint_length_days`` to an int on the ``from_dict`` path (#2178).

    It reaches ``project.sprint_length_days <= 0`` and the velocity sampler's index
    math unchecked otherwise: a non-numeric value (``"abc"``, a list, a dict) leaked a
    bare ``TypeError`` from the ``<=`` compare, and a fractional value (``2.5``) was
    silently accepted while the Rust engine only round-trips an integer sprint length —
    the silent Python↔Rust type divergence #1862 closed for
    ``hours_per_day``/``working_days``.

    ``bool`` is an ``int`` subclass but never a meaningful sprint length, so it is
    rejected explicitly.
    """
    if sprint_length_days is None:
        return
    if isinstance(sprint_length_days, bool) or not isinstance(sprint_length_days, int):
        raise ValueError(f"sprint_length_days must be an integer (got {sprint_length_days!r}).")


def _coerce_task_dates(d: dict[str, Any]) -> None:
    """Parse every strict ISO-8601 date field in place."""
    for f in (
        "planned_start",
        "planned_finish",
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "actual_start",
        "actual_finish",
        "scheduled_start",
        "live_day_end_on",
    ):
        if d.get(f) is not None:
            d[f] = _parse_date(d[f], f)


def _coerce_pert_durations(d: dict[str, Any]) -> None:
    """Parse the three PERT duration fields in place."""
    for f in ("optimistic_duration", "most_likely_duration", "pessimistic_duration"):
        if d.get(f) is not None:
            d[f] = _parse_timedelta(d[f])


def _coerce_delivery_mode(d: dict[str, Any]) -> None:
    """Parse ``delivery_mode`` in place, naming the allowed values on failure.

    Same first-run-legibility treatment as ``dep_type`` (#947): name the field and
    list the allowed modes instead of surfacing a bare enum ``ValueError``.
    """
    from trueppm_scheduler.engine import InvalidScheduleInput

    if d.get("delivery_mode") is None:
        return
    try:
        d["delivery_mode"] = DeliveryMode(d["delivery_mode"])
    except ValueError as err:
        allowed = ", ".join(m.value for m in DeliveryMode)
        raise InvalidScheduleInput(
            f"Invalid delivery_mode {d['delivery_mode']!r}; must be one of: {allowed}."
        ) from err


@dataclass
class Dependency:
    """A precedence relationship between two tasks."""

    predecessor_id: str
    successor_id: str
    dep_type: DependencyType = DependencyType.FS
    lag: timedelta = field(default_factory=timedelta)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict (``dep_type`` as its value, lag as seconds).

        Raises:
            InvalidScheduleInput: If an id is not a string, ``dep_type`` is not a
                :class:`DependencyType`, or ``lag`` is not a ``timedelta`` (#4517).
        """
        _validate_dependency_fields(self)
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
            InvalidScheduleInput: If ``data`` is not a mapping (``None``, a string,
                a list, ...), a required key is missing, ``predecessor_id``/
                ``successor_id`` is not a string, ``dep_type`` is not a known
                dependency type, or ``lag`` is not a finite number of seconds
                (strings and bools refused) (#4522).
        """
        # Wrap the whole body so a directly-called Dependency.from_dict (a public
        # classmethod) raises the documented InvalidScheduleInput rather than a bare
        # TypeError/AttributeError/KeyError — e.g. a non-mapping `data` (None, a
        # string, a list) failing `dict()`/`.get()`, or a dict missing a required
        # key (#4522), mirroring Task.from_dict's wrapper (#1209).
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            d = dict(data)
            # A bad dep_type would otherwise surface as Python's bare
            # ``ValueError: 'XX' is not a valid DependencyType`` — accurate but it
            # neither names the field nor lists what *is* allowed, which is exactly
            # the first-run error quality alpha adopters judge the library on (#947).
            # The Rust ``predecessor_id``/``successor_id`` are ``String`` under serde, so
            # a non-string id fails to parse there; Python used to accept it (#4521).
            _require_str(d, "predecessor_id", "dependency")
            _require_str(d, "successor_id", "dependency")
            raw_type = d.get("dep_type", "FS")
            try:
                dep_type = DependencyType(raw_type)
            except ValueError as err:
                allowed = ", ".join(t.value for t in DependencyType)
                raise InvalidScheduleInput(
                    f"Invalid dependency type {raw_type!r}; must be one of: {allowed}."
                ) from err
            try:
                lag = _parse_timedelta(d.get("lag", 0))
            except ValueError as err:
                raise InvalidScheduleInput(f"Invalid dependency lag: {err}") from err
            return cls(
                predecessor_id=d["predecessor_id"],
                successor_id=d["successor_id"],
                dep_type=dep_type,
                lag=lag,
            )
        except InvalidScheduleInput:
            raise
        except (KeyError, ValueError, TypeError, AttributeError) as err:
            raise InvalidScheduleInput(f"Invalid dependency document: {err}") from err


def _mask_days_between(lo: int, hi: int, mask: int) -> int:
    """Ordinals in ``[lo, hi)`` whose weekday is set in the ``working_days`` bitmask.

    ``date.fromordinal(1)`` is a Monday, so an ordinal's weekday bit is
    ``(o - 1) % 7`` — the same Monday=0 numbering :meth:`Calendar.is_working_day`
    reads from ``date.weekday()``. Module-level (rather than nested in
    :class:`Calendar` or :mod:`engine`) because both :class:`Calendar`'s exception
    coalescing (#4176) and :func:`engine._working_days_between` need it — moved
    here from :mod:`engine` when the coalescing decision started depending on it.
    """
    n = hi - lo
    if n <= 0:
        return 0
    full_weeks, rem = divmod(n, 7)
    count = full_weeks * (mask & 0b1111111).bit_count()
    first = lo + full_weeks * 7
    for o in range(first, first + rem):
        count += (mask >> ((o - 1) % 7)) & 1
    return count


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
    # Normalized to a tuple in __post_init__ (#2462) so the cached exception index
    # below cannot go stale: a tuple cannot be appended to or element-assigned, and
    # DateRange is frozen, so the only way to change the exception set is to assign
    # a NEW object to this attribute — which the cache detects by identity. Any
    # iterable of DateRange is accepted on construction, so ``Calendar(exceptions=[...])``
    # (the common call, including the TruePPM API's) is unaffected; only in-place
    # mutation, which was silently wrong before, now raises.
    exceptions: Sequence[DateRange] = field(default_factory=tuple)
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
    # — minutes of synchronous work. Lazily built on first use. Excluded from init,
    # repr, equality, and the manual to_dict — not part of the public surface.
    #
    # Runs are also coalesced across any gap that contributes no mask-working day
    # (e.g. a weekend), not just overlap/adjacency (#4176): a "closed until further
    # notice" period written as thousands of weekly Mon-Fri ranges is otherwise
    # thousands of *disjoint* intervals — one per week — even though it is a single
    # continuous closure once the already-non-working weekend gaps are accounted
    # for, and the snap/subtraction helpers below cost one step per interval. The
    # third array is a prefix sum of each run's own mask-working-day count, letting
    # :meth:`_exception_mask_days` answer a span query in O(log E) even when the
    # runs are NOT coalescible (genuinely separate closures) rather than O(runs
    # overlapping the span).
    #
    # Validity is keyed on the IDENTITY of the exceptions object the index was built
    # from, and ``_exc_src`` holds a strong reference to it (#2462), *and* on the
    # ``working_days`` mask the coalescing decision depends on (#4176) — a calendar
    # is mutable and ``_exc_mask`` catches a same-identity ``exceptions`` rebuilt
    # under a different mask. The previous ``(len, id)`` token was unsound twice
    # over: a same-length in-place replacement changed neither term, so the stale
    # index was served; and ``id()`` is unique only among *live* objects, so a
    # dropped list's address could be reused by a new same-length one. Holding the
    # reference pins the identity for as long as the cache claims it, and the
    # tuple/frozen-DateRange normalization above makes every remaining mutation
    # shape either impossible or a new object.
    _exc_index: tuple[list[int], list[int], list[int]] | None = field(
        default=None, init=False, repr=False, compare=False
    )
    _exc_src: Sequence[DateRange] | None = field(
        default=None, init=False, repr=False, compare=False
    )
    _exc_mask: int | None = field(default=None, init=False, repr=False, compare=False)

    def __setattr__(self, name: str, value: Any) -> None:
        # Normalize any accepted iterable to the immutable tuple the cache relies on.
        # Done in __setattr__ rather than __post_init__ so it covers *both* entry
        # points — the generated __init__ (which assigns through here) and a later
        # ``cal.exceptions = [...]`` reassignment. Normalizing only at construction
        # would leave a reassigned plain list in place, and in-place mutation of
        # that list would be silently stale all over again (#2462).
        if name == "exceptions" and not isinstance(value, tuple):
            value = tuple(value)
        super().__setattr__(name, value)

    def is_working_day(self, d: date) -> bool:
        """Return whether ``d`` is a working day under this calendar.

        The predicate the whole engine rests on: every date advance in the CPM
        forward and backward passes, every lag snap, and every Monte Carlo sample
        walks days through this method. It is also the natural thing for an
        embedder to call directly.

        A date is a working day when its weekday is set in the ``working_days``
        bitmask **and** it does not fall inside any exception range. Exceptions are
        merged into disjoint intervals and binary-searched, so the cost is
        logarithmic in the exception count rather than linear — which is what keeps
        a calendar with tens of thousands of holidays usable inside the passes.

        Args:
            d: The date to test.

        Returns:
            ``True`` if work can be scheduled on ``d``, else ``False``.
        """
        # date.weekday(): Monday=0, Sunday=6
        if not (self.working_days >> d.weekday()) & 1:
            return False
        if not self.exceptions:
            return True
        # Inlined rather than delegated to _exception_run: this is the per-day hot
        # path of every calendar walk, and the extra call cost ~14% of schedule().
        starts, ends, _ = self._exception_intervals()
        o = d.toordinal()
        # The intervals are merged and disjoint, so d is an exception iff it falls
        # within the single interval whose start is the rightmost <= d. A day the
        # mask-off-gap coalescing (#4176) folded INTO a run (e.g. a weekend between
        # two exception weeks) never reaches this check: the mask test above already
        # returned False for it, so whether the merged run "contains" it is moot.
        i = bisect.bisect_right(starts, o) - 1
        return not (i >= 0 and o <= ends[i])

    def _exception_run(self, o: int) -> tuple[int, int] | None:
        """The merged exception interval containing ordinal ``o``, or ``None``.

        Returned as inclusive ``(start, end)`` ordinals. The engine's snap helpers
        use it to cross a whole exception run in one step instead of testing every
        day inside it (#4161), including across a mask-off-only gap between two
        otherwise-separate runs (#4176) — the caller only ever asks for a masked
        *working* day's ordinal (see ``_snap_to_working_day``), so a run this
        returns is never one the coalescing folded a gap day into.
        """
        if not self.exceptions:
            return None
        starts, ends, _ = self._exception_intervals()
        # The intervals are merged and disjoint, so o is an exception iff it falls
        # within the single interval whose start is the rightmost <= o.
        i = bisect.bisect_right(starts, o) - 1
        if i >= 0 and o <= ends[i]:
            return starts[i], ends[i]
        return None

    def _exception_intervals(self) -> tuple[list[int], list[int], list[int]]:
        """Sorted, coalesced exception intervals as parallel ordinal lists, plus a
        prefix sum of each run's mask-working-day count (#1206, #4176).

        Rebuilt only when a *new* exceptions object is assigned, or the same one is
        reread under a different ``working_days`` mask — the cache holds a strong
        reference to the exceptions object it was built from and compares by
        identity (#2462), and separately compares the mask by value. Both are sound
        because the exception set is an immutable tuple of frozen ranges (cannot
        change without becoming a different object) and the mask is a plain int
        (compared by value is exactly "did it change").

        Two runs are coalesced not just when they overlap or sit day-adjacent, but
        whenever *every* day in the gap between them is already excluded by the
        ``working_days`` mask (#4176) — a "closed until further notice" period
        written as thousands of weekly Mon-Fri ranges is, once the intervening
        weekends are accounted for, a single continuous closure, and merging it
        back into one run is what makes the snap helpers and
        :meth:`_exception_mask_days` cost one step instead of one per week. This
        subsumes the plain overlap/adjacency case: a zero-or-negative-length gap
        always has zero mask-working days in it.
        """
        if (
            self._exc_index is not None
            and self._exc_src is self.exceptions
            and self._exc_mask == self.working_days
        ):
            return self._exc_index
        mask = self.working_days
        ranges = sorted((e.start.toordinal(), e.end.toordinal()) for e in self.exceptions)
        starts: list[int] = []
        ends: list[int] = []
        for s, e in ranges:
            if starts and _mask_days_between(ends[-1] + 1, s, mask) == 0:
                ends[-1] = max(ends[-1], e)
            else:
                starts.append(s)
                ends.append(e)
        prefix = [0] * (len(starts) + 1)
        for i, (s, e) in enumerate(zip(starts, ends, strict=True)):
            prefix[i + 1] = prefix[i] + _mask_days_between(s, e + 1, mask)
        self._exc_index = (starts, ends, prefix)
        # Strong reference: pins the identity the check above relies on, so the
        # source object cannot be collected and have its address reused (#2462).
        self._exc_src = self.exceptions
        self._exc_mask = mask
        return self._exc_index

    def _exception_mask_days(self, lo: int, hi: int) -> int:
        """Mask-working days inside any exception run overlapping ordinal span
        ``[lo, hi)`` — the subtraction :func:`_working_days_between` needs.

        O(log E) via the prefix sum :meth:`_exception_intervals` builds over the
        coalesced runs (#4176): summing every overlapping run one at a time is
        O(overlapping runs), which — before the same method's mask-off-gap
        coalescing — was one run per original ``exceptions`` entry a span crossed.
        Only the first and last overlapping runs need their own arithmetic (they
        may be clipped to ``lo``/``hi``); every run strictly between them is summed
        in one prefix-sum subtraction.
        """
        if not self.exceptions:
            return 0
        starts, ends, prefix = self._exception_intervals()
        mask = self.working_days
        # Rightmost run starting <= lo (may or may not overlap [lo, hi)); runs are
        # sorted and disjoint, so every later run's start is > lo.
        a = max(0, bisect.bisect_right(starts, lo) - 1)
        # Last run with a start < hi; if it precedes `a`, nothing overlaps.
        b = bisect.bisect_left(starts, hi) - 1
        if b < a:
            return 0
        if a == b:
            s = max(starts[a], lo)
            e = min(ends[a] + 1, hi)
            return _mask_days_between(s, e, mask) if s < e else 0
        s0 = max(starts[a], lo)
        e0 = ends[a] + 1
        first = _mask_days_between(s0, e0, mask) if s0 < e0 else 0
        middle = prefix[b] - prefix[a + 1]
        s_last = starts[b]
        e_last = min(ends[b] + 1, hi)
        last = _mask_days_between(s_last, e_last, mask) if s_last < e_last else 0
        return first + middle + last

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict.

        Emits the ``working_days`` bitmask, serialized ``exceptions``, and the
        reserved-but-inert ``hours_per_day``/``timezone`` fields. The private
        exception-index cache is excluded — it is rebuilt lazily on load.

        Raises:
            InvalidScheduleInput: If ``working_days`` is not an integer bitmask in
                [0, 127], ``hours_per_day`` is not a finite number, ``timezone`` is
                not a string, or an exception is not a :class:`DateRange` of plain
                dates — anything :meth:`from_dict` would refuse (#4517).
        """
        _validate_calendar_fields(self, "Calendar")
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
            InvalidScheduleInput: If ``data`` is not a mapping, ``working_days``
                is not an integer bitmask in range, ``exceptions`` is not a
                list, ``hours_per_day`` is not a number, or ``timezone`` is not a string.
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
        # The reserved-but-inert hours_per_day/timezone fields were duck-typed here
        # (any value passed straight through) while the Rust engine's serde is
        # type-strict — ``hours_per_day: f64`` accepts only a JSON number and
        # ``timezone: String`` only a JSON string. A document with
        # ``{"hours_per_day": "eight"}`` therefore parsed in Python and failed in
        # Rust: a silent cross-engine divergence (#1862). Validate the types here to
        # match serde's acceptance exactly. bool is an int subclass in Python but is
        # not a JSON number to serde, so reject it explicitly.
        hpd = data.get("hours_per_day", 8.0)
        if isinstance(hpd, bool) or not isinstance(hpd, (int, float)):
            raise InvalidScheduleInput(f"hours_per_day must be a number (got {hpd!r}).")
        # A non-finite value would serialize as the ``Infinity`` literal
        # ``from_json`` refuses (#4517). It reaches here from a Python dict, and from
        # JSON too: ``json.loads`` parses an overflowing literal such as ``1e400``
        # to ``inf`` without going through the NaN/Infinity constant hook.
        if not _is_finite_real(hpd):
            raise InvalidScheduleInput(f"hours_per_day must be a finite number (got {hpd!r}).")
        tz = data.get("timezone", "UTC")
        if not isinstance(tz, str):
            raise InvalidScheduleInput(f"timezone must be a string (got {tz!r}).")
        # Rust ``exceptions: Vec<DateRange>`` accepts only a JSON array. Python
        # iterated any iterable, so ``""``/``{}`` parsed as "no exceptions" and
        # ``null``/``5`` leaked a bare TypeError on a direct call (#4521).
        raw_exceptions = data.get("exceptions", [])
        if not isinstance(raw_exceptions, list):
            raise InvalidScheduleInput(
                f"exceptions must be a list (got {type(raw_exceptions).__name__}: "
                f"{raw_exceptions!r})."
            )
        return cls(
            working_days=wd,
            exceptions=[DateRange.from_dict(e) for e in raw_exceptions],
            hours_per_day=hpd,
            timezone=tz,
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

        Raises:
            InvalidScheduleInput: If ``calendars`` is not iterable or holds anything
                other than :class:`Calendar` instances.
        """
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            cals = list(calendars)
        except TypeError as err:
            raise InvalidScheduleInput(
                f"calendars must be an iterable of Calendar (got {type(calendars).__name__})."
            ) from err
        for c in cals:
            if not isinstance(c, Calendar):
                raise InvalidScheduleInput(
                    f"calendars must contain only Calendar instances (got {type(c).__name__})."
                )
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
    # which scrum tasks bootstrap-sample to estimate sprints-to-completion. A
    # zero-point sprint is an observation and is sampled like any other (#4535).
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
    # is). When this registry is non-empty, a ``calendar_id`` with no entry here is
    # refused with ``InvalidScheduleInput`` (#4516), never silently scheduled on
    # ``calendar``.
    calendars: dict[str, Calendar] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the whole project graph to a JSON-safe dict.

        Recursively serializes tasks, dependencies, and the calendar(s); dates
        become ISO-8601 strings and the optional per-task calendar registry is
        emitted as ``null`` when unused. The inverse of :meth:`from_dict`.

        Every field is checked against what :meth:`from_dict` accepts before it is
        serialized, so the output always loads back; see the serializable-field
        validation note at the bottom of this module for why this runs here rather
        than at construction.

        Raises:
            InvalidScheduleInput: If any field — on the project, its calendar(s),
                tasks or dependencies — holds a value :meth:`from_dict` would refuse,
                e.g. a string ``start_date``, ``tasks=None``, ``calendar=None``, a
                non-dict ``calendars`` or one keyed by a non-string id, or a
                wrong-typed task/dependency field (#4517).
        """
        _validate_project_scalar_fields(self)
        return {
            "id": self.id,
            "name": self.name,
            "start_date": self.start_date.isoformat(),
            "tasks": [t.to_dict() for t in self.tasks],
            "dependencies": [d.to_dict() for d in self.dependencies],
            "calendar": self.calendar.to_dict(),
            "velocity_samples": (
                list(self.velocity_samples) if self.velocity_samples is not None else None
            ),
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
                malformed (non-finite velocity samples included), or ``tasks``,
                ``dependencies`` or ``velocity_samples`` is not a list.
        """
        # Wrap the raw KeyError/ValueError/TypeError from a malformed document in
        # the public InvalidScheduleInput so the documented exception surface is
        # complete (#826) — callers catch one exception type, not the internals
        # of dict access / date parsing. Function-local import avoids the
        # models<->engine circular import at module load.
        from trueppm_scheduler.engine import InvalidScheduleInput

        try:
            velocity_samples = data.get("velocity_samples")
            _check_velocity_samples(velocity_samples)
            sprint_length_days = data.get("sprint_length_days")
            _check_sprint_length(sprint_length_days)
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
            # JSON keys are always strings; a Python-dict caller's int key would not
            # survive to_json (#4517).
            if calendars is not None and any(not isinstance(cid, str) for cid in calendars):
                raise ValueError("calendars keys must be string calendar ids.")
            _require_str(data, "id", "project")
            _require_str(data, "name", "project")
            return cls(
                id=data["id"],
                name=data["name"],
                start_date=_parse_date(data["start_date"], "start_date"),
                tasks=[Task.from_dict(t) for t in _list_field(data, "tasks")],
                dependencies=[Dependency.from_dict(d) for d in _list_field(data, "dependencies")],
                calendar=Calendar.from_dict(data.get("calendar", {})),
                velocity_samples=velocity_samples,
                sprint_length_days=sprint_length_days,
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

        Raises:
            InvalidScheduleInput: If the project holds a field :meth:`from_json`
                would refuse to load back (see :meth:`to_dict`).
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
            data = json.loads(
                s,
                parse_constant=_reject_nonfinite,
                object_pairs_hook=_reject_duplicate_keys,
            )
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


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """object_pairs_hook: reject a JSON object with a repeated key (#1862).

    ``json.loads`` silently keeps the *last* value for a duplicate key, so a
    document carrying (say) ``"duration"`` twice would schedule with the second
    value with no diagnostic. The Rust/WASM engine's serde deserializer rejects
    the identical document with a ``duplicate field`` error, so the lenient Python
    side is a silent cross-engine divergence: the same JSON schedules in one engine
    and fails to parse in the other. Reject a repeated key here so both engines
    agree that a duplicate key is malformed input, not a merge.
    """
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key {key!r} is not allowed in a project document.")
        result[key] = value
    return result


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
    _require_number(val, "Duration")
    seconds = float(val)
    if not math.isfinite(seconds):
        raise ValueError(f"Duration must be a finite number of seconds, got {val!r}.")
    try:
        td = timedelta(seconds=seconds)
    except OverflowError as err:  # finite but beyond timedelta's range (e.g. 1e300)
        raise ValueError(f"Duration is out of range, got {val!r}.") from err
    # Quantization guard (#1862). ``timedelta`` has microsecond resolution, so a
    # raw seconds value with a sub-microsecond fraction — e.g. 86400.0000001 s
    # (1 day + 100 ns) — is silently *rounded* to the nearest microsecond here
    # (→ exactly 1 day) and then passes the downstream whole-day check. The Rust
    # engine instead validates the *raw* f64 (``seconds % 86400.0 == 0``) and
    # rejects the same value, so the sub-µs fraction was a silent cross-engine
    # divergence. Detect the quantization by round-tripping: any timedelta that
    # ``to_dict`` ever emits is an exact microsecond multiple, so ``total_seconds()``
    # reproduces the input exactly; a value that does not round-trip carried
    # sub-µs precision that would be lost. Rejecting it here — before the timedelta
    # erases the evidence — is what item #1818 (which caught only the ≥0.5 µs,
    # representable half) could not, and it does not regress #1818: whole-day
    # multiples within the duration/lag caps are exactly representable in f64 and
    # round-trip cleanly, so a legitimate whole-day duration is never over-rejected.
    if td.total_seconds() != seconds:
        raise ValueError(
            f"Duration {seconds!r}s carries sub-microsecond precision that would be "
            "silently quantized; the Rust engine rejects it, so it is rejected here too."
        )
    return td


# --- Serializable-field validation (#4517) ---
#
# One set of field-type rules for the two ways a project reaches the engine: a
# document through ``from_dict``/``from_json``, and a directly constructed object
# through ``schedule()``/``monte_carlo()``/``derive_value()``. Before this, the
# direct-object validators only guarded fields the CPM pass *reads*, so a project
# with ``Calendar(hours_per_day="x")`` or ``Task(early_start="x")`` scheduled fine,
# but its own ``to_json()`` output was refused by ``from_json()``; and ``to_dict()``
# leaked a bare ``AttributeError``/``TypeError`` on a field it could not serialize.
#
# The rules run at the two serialization-relevant boundaries, ``to_dict`` and the
# engine's ``_validate_project``, and deliberately NOT in ``__post_init__``. Every
# model here is a mutable dataclass, so a construction-time check could not see a
# field assigned afterwards (the engine's own validators exist precisely because
# callers build and then mutate), and it would change construction behavior for
# every PyPI consumer, including code that builds a partial object and fills it in
# before scheduling. Checking where the value is consumed keeps construction lenient
# and makes the accepted set identical across the entry points: an object
# ``schedule()`` accepts serializes, and ``from_dict`` accepts what it serializes to.


def _invalid(msg: str) -> NoReturn:
    """Raise the public :class:`InvalidScheduleInput` (function-local import, no cycle)."""
    from trueppm_scheduler.engine import InvalidScheduleInput

    raise InvalidScheduleInput(msg)


def _is_finite_real(value: Any) -> bool:
    """``True`` for an ``int``/``float`` (not ``bool``) that converts to a finite float.

    ``math.isfinite`` raises a bare ``OverflowError`` on an ``int`` beyond float
    range, so the conversion is guarded rather than assumed.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _check_plain_date_field(value: Any, label: str, *, optional: bool = True) -> None:
    """``value`` must be a ``date`` that is not a ``datetime`` (or ``None`` if optional).

    A ``datetime`` serializes as ``YYYY-MM-DDTHH:MM:SS``, which the strict
    ``_parse_date`` refuses on the way back in.
    """
    if value is None and optional:
        return
    if not isinstance(value, date) or isinstance(value, datetime):
        expected = "a date or None" if optional else "a date"
        _invalid(f"{label} must be {expected} (got {type(value).__name__}: {value!r}).")


def _check_timedelta_field(value: Any, label: str, *, optional: bool) -> None:
    """``value`` must be a ``timedelta`` whose seconds form round-trips exactly.

    ``to_dict`` emits ``total_seconds()``; a float that does not rebuild the same
    timedelta is refused by ``_parse_timedelta``'s quantization guard on load.
    """
    if value is None and optional:
        return
    if not isinstance(value, timedelta):
        _invalid(f"{label} must be a timedelta (got {type(value).__name__}: {value!r}).")
    try:
        exact = timedelta(seconds=value.total_seconds()) == value
    except OverflowError:
        exact = False
    if not exact:
        _invalid(f"{label} {value!r} cannot be represented exactly in seconds.")


def _check_str_field(value: Any, label: str, *, optional: bool = False) -> None:
    if value is None and optional:
        return
    if not isinstance(value, str):
        _invalid(f"{label} must be a string (got {type(value).__name__}: {value!r}).")


def _validate_calendar_fields(cal: Calendar, label: str) -> None:
    """Refuse a calendar field ``Calendar.from_dict`` would refuse.

    ``working_days`` is held to the parse-time ``[0, 127]`` range here as well; the
    engine's own guard only rejected a non-int and an empty low-7-bit mask, so ``200``
    or ``-1`` scheduled as a direct object and failed ``from_dict`` (#4435).
    """
    wd = cal.working_days
    if isinstance(wd, bool) or not isinstance(wd, int) or not 0 <= wd < 0b1000_0000:
        _invalid(f"{label} working_days must be an integer bitmask in [0, 127] (got {wd!r}).")
    if not _is_finite_real(cal.hours_per_day):
        _invalid(f"{label} hours_per_day must be a finite number (got {cal.hours_per_day!r}).")
    _check_str_field(cal.timezone, f"{label} timezone")
    for exc in cal.exceptions:
        if not isinstance(exc, DateRange):
            _invalid(
                f"{label} exceptions must contain only DateRange instances "
                f"(got {type(exc).__name__}: {exc!r})."
            )
        for bound in ("start", "end"):
            _check_plain_date_field(
                getattr(exc, bound), f"{label} exception {bound}", optional=False
            )
        # DateRange.__post_init__ enforces this, but a frozen-dataclass bypass
        # (``object.__setattr__``) does not; DateRange.from_dict would refuse it.
        if exc.end < exc.start:
            _invalid(f"{label} exception end ({exc.end}) must be >= start ({exc.start}).")


_TASK_DATE_FIELDS = (
    "planned_start",
    "planned_finish",
    "early_start",
    "early_finish",
    "late_start",
    "late_finish",
    "actual_start",
    "actual_finish",
    "scheduled_start",
    "live_day_end_on",
)


def _validate_task_fields(t: Task) -> None:
    """Refuse a task field ``Task.from_dict`` would refuse, computed fields included.

    The engine overwrites the computed dates/floats on its own copy, so it never
    *read* a garbage input value there; but ``to_dict`` serializes it verbatim and
    the result would not load back.
    """
    _check_str_field(t.id, "Task id")
    _check_str_field(t.name, f"Task {t.id!r} name")
    _check_timedelta_field(t.duration, f"Task {t.id!r} duration", optional=False)
    for name in ("total_float", "free_float"):
        _check_timedelta_field(getattr(t, name), f"Task {t.id!r} {name}", optional=False)
    for name in ("optimistic_duration", "most_likely_duration", "pessimistic_duration"):
        _check_timedelta_field(getattr(t, name), f"Task {t.id!r} {name}", optional=True)
    for name in _TASK_DATE_FIELDS:
        _check_plain_date_field(getattr(t, name), f"Task {t.id!r} {name}")
    for name in ("is_critical", "milestone_at_day_end"):
        if not isinstance(getattr(t, name), bool):
            _invalid(f"Task {t.id!r} {name} must be a bool (got {getattr(t, name)!r}).")
    pct = t.percent_complete
    if pct is not None and (not _is_finite_real(pct) or not 0 <= pct <= 100):
        _invalid(f"Task {t.id!r} percent_complete must be a number in [0, 100] (got {pct!r}).")
    if t.story_points is not None and not _is_finite_real(t.story_points):
        _invalid(f"Task {t.id!r} story_points must be a finite number (got {t.story_points!r}).")
    # A plain "scrum" string serializes to the same JSON as DeliveryMode.SCRUM but is
    # not equal to it, so the object schedules as waterfall and its round-trip as
    # scrum — refuse rather than let the two forms of one project disagree.
    if t.delivery_mode is not None and not isinstance(t.delivery_mode, DeliveryMode):
        _invalid(
            f"Task {t.id!r} delivery_mode must be a DeliveryMode or None (got {t.delivery_mode!r})."
        )
    _check_str_field(t.calendar_id, f"Task {t.id!r} calendar_id", optional=True)


def _validate_dependency_fields(d: Dependency) -> None:
    """Refuse a dependency field ``Dependency.from_dict`` would refuse."""
    _check_str_field(d.predecessor_id, "Dependency predecessor_id")
    _check_str_field(d.successor_id, "Dependency successor_id")
    if not isinstance(d.dep_type, DependencyType):
        allowed = ", ".join(t.value for t in DependencyType)
        _invalid(f"Invalid dependency type {d.dep_type!r}; must be one of: {allowed}.")
    _check_timedelta_field(
        d.lag, f"Dependency {d.predecessor_id!r} → {d.successor_id!r} lag", optional=False
    )


def _validate_project_scalar_fields(p: Project) -> None:
    """Refuse a top-level project field ``Project.from_dict`` would refuse.

    Containers are checked for shape only; their elements are validated by the
    caller (``Project.to_dict`` delegates to each element's ``to_dict``).
    """
    _check_str_field(p.id, "Project id")
    _check_str_field(p.name, "Project name")
    _check_plain_date_field(p.start_date, "Project start_date", optional=False)
    _check_plain_date_field(p.status_date, "Project status_date")
    if not isinstance(p.tasks, list) or any(not isinstance(t, Task) for t in p.tasks):
        _invalid(f"Project tasks must be a list of Task (got {type(p.tasks).__name__}).")
    if not isinstance(p.dependencies, list) or any(
        not isinstance(d, Dependency) for d in p.dependencies
    ):
        _invalid(
            f"Project dependencies must be a list of Dependency "
            f"(got {type(p.dependencies).__name__})."
        )
    if not isinstance(p.calendar, Calendar):
        _invalid(f"Project calendar must be a Calendar (got {type(p.calendar).__name__}).")
    # JSON object keys are strings: an int key serializes as "1" and loads back as a
    # key a ``calendar_id="1"`` task now matches, scheduling it on a different
    # calendar than the object did; a tuple key makes ``json.dumps`` raise.
    if p.calendars is not None and (
        not isinstance(p.calendars, dict)
        or any(
            not isinstance(k, str) or not isinstance(v, Calendar) for k, v in p.calendars.items()
        )
    ):
        _invalid(
            f"Project calendars must be a dict of str calendar id to Calendar "
            f"(got {p.calendars!r})."
        )
    vs = p.velocity_samples
    if vs is not None:
        if not isinstance(vs, (list, tuple)):
            _invalid(f"velocity_samples must be a list of numbers (got {vs!r}).")
        for s in vs:
            if s is not None and not _is_finite_real(s):
                _invalid(f"velocity_samples must contain only finite numbers (got {s!r}).")
    sld = p.sprint_length_days
    if sld is not None and (isinstance(sld, bool) or not isinstance(sld, int)):
        _invalid(f"sprint_length_days must be an integer (got {sld!r}).")


def _validate_project_fields(p: Project) -> None:
    """Refuse any project whose ``to_dict`` output ``from_dict`` would not load back.

    Field types and parse-time ranges only, not scheduling semantics: an empty task
    list or a cycle serializes and loads fine, and is ``schedule()``'s to refuse.

    Raises:
        InvalidScheduleInput: On the first field that would not round-trip.
    """
    _validate_project_scalar_fields(p)
    _validate_calendar_fields(p.calendar, "Calendar")
    for cid, cal in (p.calendars or {}).items():
        _validate_calendar_fields(cal, f"Calendar {cid!r}")
    for t in p.tasks:
        _validate_task_fields(t)
    for d in p.dependencies:
        _validate_dependency_fields(d)
