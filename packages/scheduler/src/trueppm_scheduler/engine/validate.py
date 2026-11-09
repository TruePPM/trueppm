"""Input validation run before the engine touches a project."""

from __future__ import annotations

import math
from collections.abc import (
    Iterable,
)
from datetime import (
    date,
    datetime,
    timedelta,
)

from trueppm_scheduler.engine.calendar_math import (
    _next_working_day,
)
from trueppm_scheduler.engine.errors import (
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.limits import (
    _MAX_VELOCITY_SPRINT_TOTAL,
    MAX_CALENDAR_EXCEPTIONS,
    MAX_CALENDAR_SCAN_DAYS,
    MAX_DEPENDENCIES,
    MAX_DURATION_DAYS,
    MAX_LAG_DAYS,
    MAX_PROJECT_SPAN_DAYS,
)
from trueppm_scheduler.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    Task,
    _is_finite_real,
    _short_repr,
    _validate_calendar_fields,
    _validate_project_fields,
)


def _describe_link(dep: Dependency) -> str:
    """Render a source link for an error message, e.g. ``'S' → 'C' (FS, lag 7d)``."""
    return (
        f"{_short_repr(dep.predecessor_id)} → {_short_repr(dep.successor_id)} "
        f"({dep.dep_type.value}, lag {dep.lag.days}d)"
    )


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def _check_whole_days(td: timedelta, label: str) -> None:
    """Reject a duration/lag that is not a whole number of days (#1818).

    The engine consumes durations and lags via ``timedelta.days`` (floor toward
    negative infinity), while the Rust engine rounds ``seconds / 86400`` to the
    nearest whole day.
    A sub-day value therefore schedules *differently* in the two engines (e.g. 1.5d
    → Python 1-day, Rust 2-day), and a sub-day lag even drives a late date before an
    early date in Python alone. Rather than pick a shared rounding rule, both engines
    reject a non-whole-day value up front so the two can never disagree. A whole-day
    ``timedelta`` has zero sub-day component regardless of sign.
    """
    if td.seconds or td.microseconds:
        raise InvalidScheduleInput(
            f"{label} must be a whole number of days (got {td}); sub-day durations and "
            "lags are not supported and would schedule differently across engines."
        )


def _check_duration(td: timedelta, label: str) -> None:
    """Reject a negative, absurdly large, or fractional working-day duration."""
    _check_whole_days(td, label)
    days = td.days
    if days < 0:
        raise InvalidScheduleInput(f"{label} must not be negative (got {days} days).")
    if days > MAX_DURATION_DAYS:
        raise InvalidScheduleInput(
            f"{label} exceeds the maximum of {MAX_DURATION_DAYS} days (got {days})."
        )


def _velocity_observations(velocity_samples: Iterable[float | None]) -> list[float]:
    """The per-sprint throughput observations the velocity sampler bootstraps from.

    A zero-point sprint is a real observation — the team ran the sprint and delivered
    nothing — so it stays in the population (#4535). Dropping it forecast a team with
    history ``[20, 0, 0, 0]`` (mean 5) exactly like one with ``[20]`` (mean 20). The
    one intentional exclusion is upstream: a sprint flagged ``exclude_from_velocity``
    never reaches ``velocity_samples`` at all. ``None`` (no recorded points) is not an
    observation, and a negative sample is not a meaningful throughput, so both are
    skipped. :func:`_velocity_mean` and :func:`_sample_velocity_durations` both read
    this one population, so the horizon bound always matches what is sampled.
    """
    return [float(s) for s in velocity_samples if s is not None and s >= 0]


def _velocity_mean(project: Project) -> float | None:
    """Mean of the project's velocity observations, or ``None`` with no signal.

    The team's mean pace in points per sprint, zero-point sprints included (see
    :func:`_velocity_observations`). Returns ``None`` when there is no observation or
    every observation is zero: a team that has delivered nothing has no pace to
    project a sprints-to-completion from (the ratio is unbounded), so the task falls
    back to its deterministic duration — the same "no usable signal" path the
    sampler takes.
    """
    if not project.velocity_samples:
        return None
    observations = _velocity_observations(project.velocity_samples)
    if not observations:
        return None
    mean = sum(observations) / len(observations)
    return mean if mean > 0 else None


def _velocity_worst_case_days(task: Task, project: Project) -> int:
    """Upper bound (working days) on a scrum task's velocity-sampled duration.

    Mirrors the ``max_sprints`` clamp in :func:`_sample_velocity_durations` —
    the sampler never returns a duration above ``max_sprints * sprint_length_days``
    — so this bound is exact, not heuristic. Used both to size the Monte Carlo
    working-day index (a sampled completion past the index end would be silently
    clamped to the last entry, #1067) and to count scrum tasks against
    :data:`MAX_PROJECT_SPAN_DAYS` (the sampler allocates ``runs * max_sprints``
    draws, so an unbounded ``story_points`` is a memory amplification, #1067).
    Returns 0 when the task would not take the velocity path.
    """
    if (
        task.delivery_mode != DeliveryMode.SCRUM
        or task.story_points is None
        or task.story_points <= 0
        or not project.velocity_samples
        or project.sprint_length_days is None
        or project.sprint_length_days <= 0
    ):
        return 0
    mean = _velocity_mean(project)
    if mean is None:
        return 0
    # Deliberately the *uncapped* horizon — not clamped to MAX_VELOCITY_SPRINTS like
    # the sampler (#1202). This term must remain a safe upper bound for its two
    # callers: it sizes the MC working-day index (an under-estimate would undersize
    # the index and silently clamp a sampled completion, #1067) and it counts the
    # task against MAX_PROJECT_SPAN_DAYS (the eager span-guard rejection of a hostile
    # ``story_points`` depends on this staying unclamped — clamp it and a 1e12-point
    # task slips the guard and is silently mis-forecast instead of rejected). The
    # sampler's absolute cap only ever makes the real horizon *smaller* than this,
    # so it stays an upper bound; it is exact whenever the cap does not bind.
    #
    # story_points is finite-checked (models.py) but its magnitude is unbounded, and
    # mean can be an arbitrarily small positive velocity sample, so story_points/mean
    # can overflow float64 to inf — and math.ceil(inf) raises a bare OverflowError past
    # the documented contract (#2178). (Oversized story_points with a *normal* mean is
    # already rejected by the MAX_PROJECT_SPAN_DAYS span guard; only this division-
    # overflow corner slips through.) Reject the non-finite ratio here, as the
    # InvalidScheduleInput it is, before math.ceil sees it — this helper runs inside
    # the span-guard sweep of _validate_project, so the rejection is eager.
    ratio = task.story_points / mean
    if not math.isfinite(ratio):
        raise InvalidScheduleInput(
            f"Task {_short_repr(task.id)} velocity horizon is not computable: story_points "
            f"({_short_repr(task.story_points)}) over mean velocity ({_short_repr(mean)}) "
            f"overflows to a "
            "non-finite value."
        )
    max_sprints = math.ceil(ratio) * 4 + 10
    return int(max_sprints) * project.sprint_length_days


def _validate_project_shape(project: Project) -> None:
    """Type-guard the project's top-level containers for the direct-object API (#3846).

    The ``from_dict``/``from_json`` path already produces well-typed containers — a
    ``list`` of :class:`Task`, a ``list`` of :class:`Dependency`, a :class:`Calendar`,
    and a ``dict`` of :class:`Calendar` (or ``None``) for ``calendars`` — but a direct-
    object caller (#1209) can pass any Python value for these fields (a bare string or
    int for ``tasks``/``dependencies``, ``None`` for ``calendar``, a string for
    ``calendars``). Every one of those otherwise leaks a bare AttributeError/TypeError
    from deep inside a later pass — iterating a string's characters and reading
    ``.id``/``.lag`` off a single character, ``len(None)``, ``"x".items()`` — past the
    documented contract. Reject the wrong shape here, before any field on an element is
    read, so the rest of ``_validate_project`` can assume every container holds what its
    type says it holds.
    """
    # Project/Task id and name are ``String`` in the Rust engine, so a non-str value
    # fails its parse; ``from_dict`` rejects it via ``_require_str``, and the direct-
    # object path must too or the two engines disagree on the same input (#4130).
    for field_name in ("id", "name"):
        value = getattr(project, field_name)
        if not isinstance(value, str):
            raise InvalidScheduleInput(
                f"Project {field_name} must be a string, got {type(value).__name__}: "
                f"{_short_repr(value)}."
            )
    if not isinstance(project.calendar, Calendar):
        raise InvalidScheduleInput(
            f"Project calendar must be a Calendar instance, got {type(project.calendar).__name__}."
        )
    if not isinstance(project.tasks, list) or any(not isinstance(t, Task) for t in project.tasks):
        raise InvalidScheduleInput(
            f"Project tasks must be a list of Task, got {_short_repr(project.tasks)}."
        )
    # Task.id keys every lookup; a non-str id is unhashable (TypeError), None (bare
    # networkx ValueError), or an int the Rust engine's String serde rejects (#4130).
    # Task.name is likewise a Rust ``String``; Python never reads it during a pass,
    # so without this guard a non-str name schedules silently here and fails in Rust.
    for t in project.tasks:
        if not isinstance(t.id, str):
            raise InvalidScheduleInput(
                f"Task id must be a string, got {type(t.id).__name__}: {_short_repr(t.id)}."
            )
        if not isinstance(t.name, str):
            raise InvalidScheduleInput(
                f"Task {_short_repr(t.id)} name must be a string, got {type(t.name).__name__}: "
                f"{_short_repr(t.name)}."
            )
    if not isinstance(project.dependencies, list) or any(
        not isinstance(d, Dependency) for d in project.dependencies
    ):
        raise InvalidScheduleInput(
            f"Project dependencies must be a list of Dependency, got "
            f"{_short_repr(project.dependencies)}."
        )
    if project.calendars is not None and (
        not isinstance(project.calendars, dict)
        or any(not isinstance(c, Calendar) for c in project.calendars.values())
    ):
        raise InvalidScheduleInput(
            f"Project calendars must be a dict of calendar id to Calendar, got "
            f"{_short_repr(project.calendars)}."
        )


def _validate_unique_task_ids(project: Project) -> None:
    # Unique task IDs: the engine keys task_map, the graph, and every per-task
    # result on Task.id, so a duplicate id silently shadows one task — the loser
    # never gets CPM fields computed and surfaces in the result with all-None
    # early/late dates, crashing any consumer that reads them. Reject it as the
    # structural error it is rather than emitting a corrupt ScheduleResult.
    seen_ids: set[str] = set()
    for t in project.tasks:
        if t.id in seen_ids:
            raise InvalidScheduleInput(
                f"Duplicate task id {_short_repr(t.id)}; every task must have a unique id."
            )
        seen_ids.add(t.id)


def _validate_project_calendar(project: Project) -> None:
    # working_days reaches a bitwise ``&`` below; a non-int mask (a direct-object
    # caller passing a string/float, not the from_dict path which already validates)
    # would leak a bare TypeError past the documented contract (#1209).
    if isinstance(project.calendar.working_days, bool) or not isinstance(
        project.calendar.working_days, int
    ):
        raise InvalidScheduleInput(
            f"Calendar working_days must be an integer bitmask "
            f"(got {_short_repr(project.calendar.working_days)})."
        )
    if project.calendar.working_days & 0b111_1111 == 0:
        raise InvalidScheduleInput(
            "Calendar has no working weekday set (working_days bitmask is empty); "
            "at least one of Mon-Sun must be a working day."
        )

    # Bound the exception-range count (#1206): is_working_day is called once per day
    # stepped by every walk, so an unbounded exceptions list turns a schedule into
    # O(span x E). The bisect index keeps each lookup O(log E), but a multi-million-
    # entry list is still pathological — reject it up front.
    if len(project.calendar.exceptions) > MAX_CALENDAR_EXCEPTIONS:
        raise InvalidScheduleInput(
            f"Calendar has {len(project.calendar.exceptions)} exception ranges, exceeding "
            f"the maximum of {MAX_CALENDAR_EXCEPTIONS:,}; a real calendar has at most a few "
            "hundred holidays or closures."
        )

    # start_date feeds every calendar walk below (the reachability probe here, then
    # both passes) via ``.weekday()``; a non-date (a direct-object caller passing
    # None/str, not the from_dict path which already coerces it) would leak a bare
    # AttributeError past the documented contract (#1823) — the same #1209
    # direct-object gap the task/calendar fields already guard. datetime is a date
    # subclass but mixes badly with date arithmetic, so reject it like the date pins.
    if not isinstance(project.start_date, date) or isinstance(project.start_date, datetime):
        raise InvalidScheduleInput(
            f"Project start_date must be a date, not {type(project.start_date).__name__}."
        )

    # status_date (ADR-0132) feeds the same date arithmetic in _validate_span_bounds
    # (``project.status_date - project.start_date``); a non-date direct-object value
    # (#3846, the same #1209 gap start_date/planned_start/actual_* already guard)
    # would otherwise leak a bare TypeError from that subtraction past the documented
    # contract. Reuses _require_plain_date — the same object-path guard already
    # applied to every other date field on Task.
    _require_plain_date(project.status_date, "Project status_date")

    # Reachability probe: a working day must exist within MAX_CALENDAR_SCAN_DAYS
    # of the project start. Catches a valid weekday mask whose `exceptions`
    # blanket the schedule — the common degenerate case — eagerly and with the
    # same message on every entry point, rather than relying on whichever pass
    # happens to hit a snap helper first. schedule()'s forward pass snaps the
    # start anyway, but monte_carlo() builds its working-day index without a prior
    # snap, so before this probe a blanket-exceptions calendar drove the MC path
    # into an uncaught OverflowError. Mirrors the Rust engine's validate_project
    # (#749) so both engines reject identically at the validation layer.
    # The calendar's remaining fields are checked first: the probe reads
    # ``exceptions``, and a non-DateRange entry would leak a bare AttributeError
    # from it (#4517).
    _validate_calendar_fields(project.calendar, "Calendar")
    _next_working_day(project.start_date, project.calendar)


def _validate_task_calendars(project: Project) -> None:
    # Per-task calendar registry (ADR-0120 D3): every named calendar a task may opt
    # into is held to the same guards as the project calendar, so a degenerate
    # member-project calendar can't drive the merged program pass into a spin. Each
    # is reachability-probed from the project start (the merged pass anchors every
    # calendar at the same start). The offending id is named so a bad member-project
    # calendar is traceable in a program-scoped run.
    if project.calendars:
        for cal_id, cal in project.calendars.items():
            if isinstance(cal.working_days, bool) or not isinstance(cal.working_days, int):
                raise InvalidScheduleInput(
                    f"Calendar {_short_repr(cal_id)} working_days must be an integer bitmask "
                    f"(got {_short_repr(cal.working_days)})."
                )
            if cal.working_days & 0b111_1111 == 0:
                raise InvalidScheduleInput(
                    f"Calendar {_short_repr(cal_id)} has no working weekday set (working_days "
                    f"bitmask "
                    "is empty); at least one of Mon-Sun must be a working day."
                )
            if len(cal.exceptions) > MAX_CALENDAR_EXCEPTIONS:
                raise InvalidScheduleInput(
                    f"Calendar {_short_repr(cal_id)} has {len(cal.exceptions)} exception ranges, "
                    f"exceeding "
                    f"the maximum of {MAX_CALENDAR_EXCEPTIONS:,}."
                )
            _validate_calendar_fields(cal, f"Calendar {_short_repr(cal_id)}")
            _next_working_day(project.start_date, cal)


def _validate_agile_inputs(project: Project) -> None:
    # Non-finite agile inputs crash deep inside the velocity sampler (NaN/inf
    # story_points hit ``int(np.ceil(...))``; an inf velocity sample passes the
    # ``>= 0`` observation filter and poisons the bootstrap mean), so reject them eagerly
    # with the documented exception type (#1070).
    if project.velocity_samples is not None:
        # A direct-object caller (#3846/#1209) can pass a bare scalar (e.g. ``-1``)
        # instead of a list — ``for s in project.velocity_samples`` then leaks a bare
        # TypeError ("'int' object is not iterable") past the documented contract.
        if not isinstance(project.velocity_samples, (list, tuple)):
            raise InvalidScheduleInput(
                f"velocity_samples must be a list of numbers, got "
                f"{_short_repr(project.velocity_samples)}."
            )
        for s in project.velocity_samples:
            if s is None:
                continue
            # isinstance gate before math.isfinite (#1209): a string sample would
            # otherwise raise a bare TypeError from isfinite. bool is an int subclass
            # but never a meaningful velocity, so reject it explicitly.
            if not _is_finite_number(s):
                raise InvalidScheduleInput(
                    f"velocity_samples must contain only finite numbers (got {_short_repr(s)})."
                )

    # sprint_length_days reaches ``project.sprint_length_days <= 0`` in
    # _velocity_worst_case_days and the velocity sampler's working-day index math; the
    # from_dict/from_json path already pins it to an int, but a direct-object caller
    # (#1209) can pass a non-int, which otherwise leaks a bare TypeError from the
    # ``<=`` compare past the documented contract (#2178). A non-integer float (``2.5``)
    # is also rejected: it simulates in Python but the Rust engine only round-trips an
    # integer sprint length, the same silent Python<->Rust type divergence #1862 closed
    # for hours_per_day/working_days. bool is an int subclass but never a meaningful
    # sprint length, so reject it explicitly.
    if project.sprint_length_days is not None and (
        isinstance(project.sprint_length_days, bool)
        or not isinstance(project.sprint_length_days, int)
    ):
        raise InvalidScheduleInput(
            f"sprint_length_days must be an integer (got "
            f"{_short_repr(project.sprint_length_days)})."
        )


def _validate_tasks(project: Project) -> None:
    """Reject structurally impossible task input, one concern per guard.

    The guards run in a fixed order and that order is observable — the contract and
    fuzz suites assert *which* message a malformed task produces, so a task tripping
    two guards must keep tripping the earlier one.
    """
    for t in project.tasks:
        _validate_task_date_types(t)
        _validate_task_actual_order(t)
        _validate_task_calendar_id(t, project.calendars)
        _validate_task_durations(t)
        _validate_task_numerics(t)
        _validate_task_span(t, project.start_date)


def _require_plain_date(value: object, label: str) -> None:
    """Reject a ``datetime`` (or non-date) where a plain ``date`` is required.

    ``datetime`` is a ``date`` subclass but mixes badly with date arithmetic — a
    ``datetime`` in ``_start_from_finish`` or the span guard raises a bare TypeError
    from deep inside a pass instead of the documented ``InvalidScheduleInput`` (#1209).
    """
    if value is None:
        return
    if not isinstance(value, date) or isinstance(value, datetime):
        raise InvalidScheduleInput(f"{label} must be a date, not {type(value).__name__}.")


def _validate_task_date_types(t: Task) -> None:
    """Type guards for the direct-object API (#1209).

    The ``from_dict``/``from_json`` path already coerces these, but a caller building
    ``Task`` objects by hand can pass the wrong type, which otherwise leaks
    AttributeError/TypeError from deep in a pass. ``actual_start``/``actual_finish``
    (ADR-0136) feed the same date arithmetic as the span guard, so they are held to
    the same contract as ``planned_start``.
    """
    if not isinstance(t.duration, timedelta):
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} duration must be a timedelta (got "
            f"{_short_repr(t.duration)})."
        )
    # Exact-type fast path: a plain ``date`` (or None) needs no label. A ``datetime``
    # is a ``date`` subclass, so it must miss the fast path and reach the full check.
    for name in ("planned_start", "actual_start", "actual_finish"):
        value = getattr(t, name)
        if value is not None and type(value) is not date:
            _require_plain_date(value, f"Task {_short_repr(t.id)} {name}")


def _validate_task_actual_order(t: Task) -> None:
    """A recorded pair of actuals must be internally ordered.

    ADR-0136 keeps a completed task's actuals VERBATIM (early_start = actual_start,
    early_finish = actual_finish) so out-of-sequence reality — a task sitting before
    its predecessor — is surfaced rather than normalized away. But a single task
    claiming it finished BEFORE it started is not out-of-sequence truth; it is
    physically impossible input, in the same class as a negative duration. Left
    unchecked it produces an inverted early window (early_start > early_finish) that
    every downstream consumer — the Gantt renderer, float math, Monte Carlo, the API
    serializer — reads as garbage; the contract fuzz suite caught it as an
    ``_assert_schedule_invariants`` violation (#2119). Reject it here so the inversion
    never leaves the boundary.
    """
    if t.actual_start is None or t.actual_finish is None:
        return
    if t.actual_start > t.actual_finish:
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} actual_start must not be after actual_finish "
            f"(got {t.actual_start.isoformat()} > {t.actual_finish.isoformat()})."
        )


def _validate_task_calendar_id(t: Task, calendars: dict[str, Calendar] | None) -> None:
    """``calendar_id`` (ADR-0120 D3) must be None, or a string naming a registry entry.

    It is looked up as a dict key against the project's calendar registry; a
    non-string id can never match an entry and would silently fall back to the default
    calendar, so reject it explicitly rather than schedule on the wrong calendar.

    A string id absent from a **non-empty** registry is refused for the same reason
    (#4516): a typo or a dropped registry entry used to fall back to the pass-level
    calendar and produce a plausible schedule on the wrong working week, with no
    diagnostic. With no registry (``None`` or empty) every task schedules on the
    pass-level calendar and a set id is ignored — the single-calendar document shape,
    which carries ids it has no registry for and must keep scheduling unchanged.
    """
    if t.calendar_id is None:
        return
    if not isinstance(t.calendar_id, str):
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} calendar_id must be a string or None, "
            f"not {type(t.calendar_id).__name__}."
        )
    if calendars and t.calendar_id not in calendars:
        raise InvalidScheduleInput(_unknown_calendar_id_message(t.id, t.calendar_id))


def _unknown_calendar_id_message(task_id: str, calendar_id: str) -> str:
    """The refusal both the validator and the resolver raise, so they read identically."""
    return (
        f"Task {_short_repr(task_id)} calendar_id {_short_repr(calendar_id)} names no calendar in "
        f"the "
        "project's calendars registry."
    )


def _is_valid_duration(td: object) -> bool:
    """``True`` only when ``td`` is an exact ``timedelta`` that ``_check_duration`` accepts.

    A fast pre-check so the per-task validator can skip building an error label for
    the overwhelmingly common valid value; ``False`` means "run the full check", not
    "invalid".
    """
    return (
        type(td) is timedelta
        and not td.seconds
        and not td.microseconds
        and 0 <= td.days <= MAX_DURATION_DAYS
    )


def _validate_task_durations(t: Task) -> None:
    """Duration bounds, plus the ordering of a complete three-point estimate.

    An inconsistent triple (most_likely outside [optimistic, pessimistic], or
    optimistic above pessimistic) used to be silently "handled" by ``_sample_pert``'s
    degenerate fallback — every run sampling the constant most_likely, possibly beyond
    the user's own pessimistic bound (#1069). Partial estimates are not validated:
    Monte Carlo only samples when all three are present.
    """
    # Exact-type fast path: a whole-day, in-range ``timedelta`` passes ``_check_duration``
    # by construction, so its label is only built for a value that fails it.
    if not _is_valid_duration(t.duration):
        _check_duration(t.duration, f"Task {_short_repr(t.id)} duration")
    for field_name, value in (
        ("optimistic_duration", t.optimistic_duration),
        ("most_likely_duration", t.most_likely_duration),
        ("pessimistic_duration", t.pessimistic_duration),
    ):
        if value is not None:
            # Type guard for the direct-object API (#3846/#1209): a caller building a
            # Task by hand can pass a non-timedelta PERT field (from_dict already
            # coerces these via _coerce_pert_durations), which otherwise leaks a bare
            # AttributeError from _check_duration's ``.seconds``/``.days`` access past
            # the documented contract.
            if not isinstance(value, timedelta):
                raise InvalidScheduleInput(
                    f"Task {_short_repr(t.id)} {field_name} must be a timedelta (got "
                    f"{_short_repr(value)})."
                )
            if not _is_valid_duration(value):
                _check_duration(value, f"Task {_short_repr(t.id)} {field_name}")

    if (
        t.optimistic_duration is None
        or t.most_likely_duration is None
        or t.pessimistic_duration is None
    ):
        return
    o = t.optimistic_duration.days
    m = t.most_likely_duration.days
    pe = t.pessimistic_duration.days
    if not o <= m <= pe:
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} three-point estimates must satisfy "
            f"optimistic <= most_likely <= pessimistic "
            f"(got {o} <= {m} <= {pe} days)."
        )


def _is_finite_number(value: object) -> bool:
    """``True`` for a real finite int/float. ``bool`` is excluded deliberately.

    An ``int`` beyond float range is not finite here; ``math.isfinite`` would raise a
    bare ``OverflowError`` on it (#4517).
    """
    return _is_finite_real(value)


def _validate_task_numerics(t: Task) -> None:
    """``story_points`` (when set) and ``percent_complete`` must be finite numbers.

    ``percent_complete`` (ADR-0132/0136) feeds ``_effective_duration_days``
    (``int(duration * pct/100)``) and ``_is_complete`` (``pct >= 100``); a NaN there
    raised a bare ValueError from ``int(nan)`` and a non-numeric value a bare TypeError
    from the ``>= 100`` compare, while monte_carlo's own ``pct > 0`` gate silently
    ignored the same NaN — so ``schedule()`` and ``monte_carlo()`` diverged on
    identical input (#1452). The ``from_dict``/``from_json`` path already rejects
    non-finite here (models.py); this closes the direct-object gap to match it.

    ``None`` is refused (#4881): ``Task.from_dict`` refuses an explicit null for parity
    with Rust's ``percent_complete: f64``, so accepting it here broke the
    ``to_json``/``from_json`` round-trip. A finite
    value outside [0, 100] is rejected too (#4513): the passes would clamp it
    (``min(pct, 100)``; a negative reads as not-started), so a sign-flipped or x100
    import bug (0.5 sent as 50, 50 as 5000) scheduled plausibly and silently.
    Rejecting later would be a breaking narrowing of the input contract.
    """
    if t.story_points is not None and not _is_finite_number(t.story_points):
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} story_points must be a finite number (got "
            f"{_short_repr(t.story_points)})."
        )
    if t.percent_complete is None:
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} percent_complete must be a finite number (got None)."
        )
    if not _is_finite_number(t.percent_complete):
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} percent_complete must be a finite number (got "
            f"{_short_repr(t.percent_complete)})."
        )
    if not 0 <= t.percent_complete <= 100:
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} percent_complete must be between 0 and 100 "
            f"(got {_short_repr(t.percent_complete)})."
        )


def _validate_task_span(t: Task, project_start: date) -> None:
    """``planned_start`` (SNET) extends the schedule directly, so the span cap applies.

    Otherwise a pin in year 9999 is accepted and drives the Monte Carlo working-day
    index build into a multi-million-entry walk (#1068).
    """
    if (
        t.planned_start is not None
        and (t.planned_start - project_start).days > MAX_PROJECT_SPAN_DAYS
    ):
        raise InvalidScheduleInput(
            f"Task {_short_repr(t.id)} planned_start is more than {MAX_PROJECT_SPAN_DAYS} days "
            "after the project start; the schedule cannot be computed within a "
            "representable date range."
        )


def _validate_dependencies(project: Project) -> None:
    # Bound the raw edge count (#1203) before the loop below (and every later O(E)
    # pass — graph build, summary expansion) touches it. Checked from len() so it is
    # O(1) and rejects a multi-million-edge payload before any per-edge work or the
    # list's memory footprint becomes the cost.
    if len(project.dependencies) > MAX_DEPENDENCIES:
        raise InvalidScheduleInput(
            f"Project has {len(project.dependencies)} dependencies, exceeding the "
            f"maximum of {MAX_DEPENDENCIES}; the graph cannot be scheduled within "
            "resource limits."
        )
    seen_edges: set[tuple[str, str]] = set()
    for dep in project.dependencies:
        # Type guard for the direct-object API (#1209): a non-timedelta lag would
        # otherwise leak AttributeError from ``.days`` here and in both passes.
        if not isinstance(dep.lag, timedelta):
            raise InvalidScheduleInput(
                f"Dependency {_short_repr(dep.predecessor_id)} → {_short_repr(dep.successor_id)} "
                f"lag must be a "
                f"timedelta (got {_short_repr(dep.lag)})."
            )
        # Type guards for the direct-object API (#3846/#1209): predecessor_id/
        # successor_id key ``seen_edges`` (a set) below and, for dep_type, the Monte
        # Carlo lag-delta cache (``_build_lag_delta_table``) — an unhashable value
        # (e.g. a list) would otherwise leak a bare "TypeError: unhashable type"
        # from whichever of those a run happens to reach first, rather than the
        # documented contract at validation time.
        if not isinstance(dep.predecessor_id, str) or not isinstance(dep.successor_id, str):
            raise InvalidScheduleInput(
                f"Dependency predecessor_id/successor_id must be strings (got "
                f"{_short_repr(dep.predecessor_id)} → {_short_repr(dep.successor_id)})."
            )
        if not isinstance(dep.dep_type, DependencyType):
            # Same first-run-legibility treatment as the from_dict path (#947): name
            # the field and list the allowed values instead of a bare TypeError from
            # the lag-delta cache key, or a silently no-op comparison against every
            # DependencyType member.
            allowed = ", ".join(dt.value for dt in DependencyType)
            raise InvalidScheduleInput(
                f"Invalid dependency type {_short_repr(dep.dep_type)}; must be one of: {allowed}."
            )
        # Duplicate (predecessor, successor) edges diverge between engines (#1817):
        # ``_build_graph`` uses ``nx.DiGraph``, which *overwrites* the edge attribute
        # so only the last dependency on a pair survives, while the Rust engine keeps
        # parallel edges and applies *all* of them (a different schedule, floats, and
        # critical path). Rather than silently drop or silently merge, both engines
        # reject a duplicated pair — the caller must express a single relationship per
        # pair (a self-loop A→A is caught later as a cycle, not here).
        key = (dep.predecessor_id, dep.successor_id)
        if key in seen_edges:
            raise InvalidScheduleInput(
                f"Duplicate dependency {_short_repr(dep.predecessor_id)} → "
                f"{_short_repr(dep.successor_id)}; "
                "each task pair may carry at most one dependency (declare a single "
                "relationship per predecessor/successor pair)."
            )
        seen_edges.add(key)
        # Sub-day lag schedules differently across engines and can drive a late date
        # before an early date (#1818); reject a non-whole-day lag like a duration.
        # The label is only built when the lag is not already a whole number of days.
        if dep.lag.seconds or dep.lag.microseconds:
            _check_whole_days(
                dep.lag,
                f"Dependency {_short_repr(dep.predecessor_id)} → "
                f"{_short_repr(dep.successor_id)} lag",
            )
        if abs(dep.lag.days) > MAX_LAG_DAYS:
            raise InvalidScheduleInput(
                f"Dependency {_short_repr(dep.predecessor_id)} → {_short_repr(dep.successor_id)} "
                f"lag exceeds "
                f"the maximum of ±{MAX_LAG_DAYS} days (got {dep.lag.days})."
            )


def _task_span_totals(project: Project) -> tuple[int, int, int, dict[str, int]]:
    """Sum the worst-case task span and find the furthest pin and actual.

    The span uses the worst case across the deterministic duration AND every PERT
    estimate: Monte Carlo samples within ``[optimistic, pessimistic]`` but falls back
    to ``most_likely`` when the range is degenerate, so ``most_likely`` — which a
    partial estimate may set above the deterministic duration — must count too.

    A scrum task's velocity worst case is returned per task instead of summed
    (#4695): it bounds only where Monte Carlo can place the task, not any work the
    engine does, so it is charged along the longest dependency chain by
    :func:`_validate_span_bounds`. Summed, every 1-point story cost
    ``(ceil(sp/mean)*4 + 10) * sprint_length_days`` against the cap whether or not it
    ran in parallel with every other story. It is still computed here, in the same
    sweep, so a non-finite ``story_points / mean`` is refused where it always was
    (#1067, #2178).

    Recorded actuals (ADR-0132/0136) anchor a completed task's full-duration span and
    feed the same calendar walk (``_start_from_finish`` / ``_finish_from_start``) as a
    ``planned_start`` pin, so an actual far from the project start must be bounded the
    same way — otherwise a year-9999 ``actual_finish`` drives the working-day scan past
    the representable range (the #951 precedent). ``abs()`` bounds both a far-future
    and a far-past actual.

    Returns ``(total_span, max_snet_days, max_actual_days, velocity_days)``, where
    ``total_span`` excludes the velocity term and ``velocity_days`` maps each scrum
    task that takes the velocity path to its :func:`_velocity_worst_case_days`.
    """
    total_span = 0
    max_snet_days = 0
    max_actual_days = 0
    velocity_days: dict[str, int] = {}
    for t in project.tasks:
        total_span += _task_worst_case_days(t)
        velocity = _velocity_worst_case_days(t, project)
        if velocity > 0:
            velocity_days[t.id] = velocity
        if t.planned_start is not None:
            max_snet_days = max(max_snet_days, (t.planned_start - project.start_date).days)
        for actual in (t.actual_start, t.actual_finish):
            if actual is not None:
                max_actual_days = max(max_actual_days, abs((actual - project.start_date).days))
    return total_span, max_snet_days, max_actual_days, velocity_days


def _task_worst_case_days(t: Task) -> int:
    """Largest of a task's deterministic duration and PERT estimates, floored at 0."""
    task_max_days = t.duration.days
    for est in (t.optimistic_duration, t.most_likely_duration, t.pessimistic_duration):
        if est is not None:
            task_max_days = max(task_max_days, est.days)
    return max(0, task_max_days)


def _longest_chain_days(project: Project, weight: dict[str, int]) -> int | None:
    """Longest dependency chain of ``weight`` plus ``|lag|`` per link, or None if cyclic.

    Kahn's algorithm over the raw dependency list, O(tasks + dependencies); it runs
    inside :func:`_validate_project`, before the graph is built and before cycles are
    reported, so a cycle (or a link naming an unknown task, refused later) returns
    ``None`` and the caller falls back to the serial sum.
    """
    indegree = dict.fromkeys(weight, 0)
    successors: dict[str, list[tuple[str, int]]] = {tid: [] for tid in weight}
    for dep in project.dependencies:
        if dep.predecessor_id not in weight or dep.successor_id not in weight:
            return None
        successors[dep.predecessor_id].append((dep.successor_id, abs(dep.lag.days)))
        indegree[dep.successor_id] += 1
    ready = [tid for tid, deg in indegree.items() if deg == 0]
    start_at = dict.fromkeys(weight, 0)
    longest = 0
    visited = 0
    while ready:
        tid = ready.pop()
        visited += 1
        finish = start_at[tid] + weight[tid]
        longest = max(longest, finish)
        for succ, lag in successors[tid]:
            start_at[succ] = max(start_at[succ], finish + lag)
            indegree[succ] -= 1
            if indegree[succ] == 0:
                ready.append(succ)
    return longest if visited == len(weight) else None


def _validate_span_bounds(project: Project) -> None:
    """Refuse a project whose worst-case span cannot be computed in a sane range.

    Two bounds, because the two worst cases cost different things (#4695):

    * **Work span** — every task's deterministic/PERT worst case and every ``|lag|``,
      summed, plus the furthest pin, data date or actual. This is unchanged and is
      deliberately a *sum*, not a path: :func:`schedule`'s forward and backward
      passes walk each task's duration day by day, so the sum bounds their total
      work as well as the span. It mirrors ``validate_span`` in the Rust engine.
    * **Chain span** — only when a scrum task takes the velocity path. Each task
      weighs the larger of its PERT worst case and its velocity worst case, and the
      bound is the longest dependency chain of those weights plus ``|lag|`` per link,
      plus the same once-only shift. Velocity durations are only ever *sampled* by
      Monte Carlo and laid out by index lookups, never walked, so the work they
      cause is bounded elsewhere (the total sprint budget below, ``max_runs``,
      ``max_index_cells``); what must stay bounded here is how far a run can reach.

    Why the chain span is an upper bound on any reachable finish, in the guard's own
    units (working days of duration, calendar days of lag): a task's start is the
    latest of its floors and its link proposals. Every floor — the project start, its
    ``planned_start``, the data date, a recorded actual — lies within the once-only
    shift of the start. Every link, whatever its type, proposes at most the
    predecessor's finish plus ``max(0, lag)``: an SS/SF anchor is a start, which is no
    later than the finish, and an FF/SF link constrains the successor's *finish* to
    that value, so its start is earlier still; a negative lag only pulls work
    earlier. So by induction in topological order a task finishes no later than
    ``shift + (longest chain of weights and |lag| ending at it)``. Summing every task
    instead is the same argument with every task on one chain, which is why it was
    sound but refused ~1,750 parallel stories. The engine converts these working-day
    figures to dates per calendar later; the ``* 7`` reach check below and
    :func:`_mc_horizon` (which re-runs this induction on real calendars) do that
    conversion conservatively. A cyclic graph has no longest path; it falls back to
    the serial sum and is reported as a cycle afterwards.

    A hostile ``story_points`` is still refused (#1067): one task is a chain of one,
    so a velocity worst case above the cap fails the chain span on its own. Its
    draw cost is bounded separately: the sampler draws ``runs x max_sprints`` per
    scrum task, and ``max_sprints`` sums over parallel tasks as well as chained ones,
    so the total uncapped sprint horizon stays under :data:`_MAX_VELOCITY_SPRINT_TOTAL`.
    """
    # status_date (the data date, ADR-0132) floors all not-yet-finished work, so
    # like a planned_start pin it shifts the schedule directly and is bounded by
    # the same span cap — otherwise a data date in year 9999 drives the Monte
    # Carlo working-day index build into a multi-million-entry walk. The MC index
    # adds (status_date - start_date) to its size, so this guard runs before the
    # index is built (#1186).
    status_offset = 0
    if project.status_date is not None:
        status_offset = (project.status_date - project.start_date).days
        if status_offset > MAX_PROJECT_SPAN_DAYS:
            raise InvalidScheduleInput(
                f"status_date is more than {MAX_PROJECT_SPAN_DAYS} days after the "
                "project start; the schedule cannot be computed within a "
                "representable date range."
            )

    total_span, max_snet_days, max_actual_days, velocity_days = _task_span_totals(project)
    if max_actual_days > MAX_PROJECT_SPAN_DAYS:
        raise InvalidScheduleInput(
            f"A task actual_start/actual_finish is more than {MAX_PROJECT_SPAN_DAYS} "
            "days from the project start; the schedule cannot be computed within a "
            "representable date range."
        )
    lag_total = sum(abs(dep.lag.days) for dep in project.dependencies)
    # A planned_start pin, the data-date floor, and a recorded actual each shift work
    # along the timeline, so the furthest of them adds to the span bound exactly once
    # (they don't accumulate the way durations on a chain do).
    shift = max(max_snet_days, max(0, status_offset), max_actual_days)
    total_span += lag_total + shift
    if total_span > MAX_PROJECT_SPAN_DAYS:
        raise InvalidScheduleInput(
            f"Total project span ({total_span} days across all task durations and lags) "
            f"exceeds the maximum of {MAX_PROJECT_SPAN_DAYS} days; the schedule cannot be "
            "computed within a representable date range."
        )

    reach_span = total_span
    if velocity_days:
        weight = {
            t.id: max(_task_worst_case_days(t), velocity_days.get(t.id, 0)) for t in project.tasks
        }
        chain = _longest_chain_days(project, weight)
        if chain is None:
            chain = sum(weight.values()) + lag_total
        chain_span = chain + shift
        if chain_span > MAX_PROJECT_SPAN_DAYS:
            raise InvalidScheduleInput(
                f"Total project span ({chain_span} days along the longest dependency "
                "chain, counting each scrum task's velocity worst case) exceeds the "
                f"maximum of {MAX_PROJECT_SPAN_DAYS} days; the schedule cannot be "
                "computed within a representable date range."
            )
        # _velocity_worst_case_days returns max_sprints * sprint_length_days exactly.
        assert project.sprint_length_days is not None
        total_sprints = sum(velocity_days.values()) // project.sprint_length_days
        if total_sprints > _MAX_VELOCITY_SPRINT_TOTAL:
            raise InvalidScheduleInput(
                f"Total velocity sprint horizon ({total_sprints} sprints across all scrum "
                f"tasks) exceeds the maximum of {_MAX_VELOCITY_SPRINT_TOTAL}; reduce "
                "story_points or the number of scrum tasks."
            )
        reach_span = max(reach_span, chain_span)

    # date.max overflow guard (#1207). The engine walks in *calendar* days; a valid
    # weekday-only calendar inflates a working-day span by up to 7x, and a single
    # snap can advance up to MAX_CALENDAR_SCAN_DAYS. A start date close enough to the
    # representable ceiling that the walk would step past date.max otherwise raised a
    # bare OverflowError deep in a forward-pass date addition (escaping the CLI and
    # Celery worker, and the documented contract). Reject it cleanly here. The
    # estimate is conservative: it can refuse an absurd far-future start with a huge
    # span, but never a realistically-dated project. (The symmetric date.min
    # underflow is no longer strictly unreachable: an SF-linked task can sit before
    # start_date (#4218), reaching back at most the SF chain's durations and leads.
    # Only a start date within that reach of date.min can underflow, and
    # _safe_offset turns it into InvalidScheduleInput rather than an OverflowError.)
    max_calendar_reach = reach_span * 7 + MAX_CALENDAR_SCAN_DAYS
    if (date.max - project.start_date).days < max_calendar_reach:
        raise InvalidScheduleInput(
            f"Project start date {project.start_date.isoformat()} is too close to the "
            f"maximum representable date for a span of {reach_span} working days; the "
            "schedule would overflow the date range. Use an earlier start date."
        )


def _validate_project(project: Project) -> None:
    """Reject degenerate input before any calendar walk runs.

    A pure-Python CPM pass walks the calendar one day at a time, so an empty
    working-day mask or a century-long duration/lag turns into a multi-million-
    iteration spin. Validating here keeps a single hostile or fat-fingered
    project from tying up the caller (notably the synchronous Monte Carlo
    request path in the TruePPM API).
    """
    # Each helper below owns one cohesive family of guards and preserves the exact
    # order they fired in when this was a single linear body: container shape
    # first (#3846 — every later guard assumes ``tasks``/``dependencies`` are the
    # lists of dataclass instances their type hints promise), then id uniqueness,
    # the project calendar, per-task calendars, agile inputs, per-task fields, the
    # dependency edges, and finally the cumulative span / date-range bounds (which
    # read fields the earlier guards have already type-checked).
    _validate_project_shape(project)
    _validate_unique_task_ids(project)
    _validate_project_calendar(project)
    _validate_task_calendars(project)
    _validate_agile_inputs(project)
    _validate_tasks(project)
    _validate_dependencies(project)
    _validate_span_bounds(project)
    # Last, so every guard above keeps the message it has always produced: the
    # fields the CPM pass never reads (reserved calendar fields, computed task
    # dates/floats, flags) must still be ones ``to_dict`` can serialize and
    # ``from_dict`` load back, or schedule() accepts a project its own JSON form
    # cannot express (#4517). Shared with ``Project.to_dict``.
    _validate_project_fields(project)
