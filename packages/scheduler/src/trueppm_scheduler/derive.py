"""Derivation graph for computed schedule values (ADR-0218).

The CPM engine (:mod:`trueppm_scheduler.engine`) computes each task's
``early_start`` / ``early_finish`` / ``late_start`` / ``late_finish`` /
``total_float`` / ``free_float`` as the ``max`` (forward pass) or ``min``
(backward pass) of a set of candidate constraints, then discards *which* term
won. This module recovers the **why**: for a single target value it replays the
engine's own constraint formulas — reusing the exact private helpers the passes
use — and reports the binding constraint, every candidate contribution, the lag
and calendar-snap contribution of each, and which pass set the value.

The derivation is faithful **by construction**, not guessed: it evaluates the
same ``max``/``min`` the engine evaluated, over inputs (the predecessors'/
successors' final early/late dates) taken from a completed
:class:`~trueppm_scheduler.engine.ScheduleResult`. Because those inputs are
already final, deriving one task's one value needs only the ``<= degree(task)``
dependency edges incident to the task, gathered by one filtered scan of the
dependency list — no graph rebuild and no whole-network re-pass — and the
reported binding date equals the engine's
computed value (asserted by the library's unit tests). Nothing is fabricated: a
contribution is emitted only for a constraint the engine actually evaluates.

Monte Carlo percentile derivation (P50/P80/P95) is intentionally *not* here — the
"why" behind a percentile (``cpm_finish``, ``delta_vs_cpm``, the ADR-0140
sensitivity tornado) is already a first-class engine output surfaced by the API
(#987); the API layer composes it rather than recomputing it.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from trueppm_scheduler.engine import (
    SchedulerError,
    ScheduleResult,
    _effective_duration_days,
    _is_complete,
    _next_working_day,
    _prev_working_day,
    _resolve_task_calendars,
    _retreat_calendar_days,
    _safe_offset,
    _start_from_finish,
    _working_days_between,
    schedule,
)
from trueppm_scheduler.models import Calendar, Dependency, DependencyType, Project, Task


class Quantity(enum.Enum):
    """A computed schedule value whose derivation can be explained.

    Values match the corresponding :class:`~trueppm_scheduler.models.Task`
    attribute names, so ``Quantity.EARLY_START.value == "early_start"``. This
    casing is a public contract (the API mirrors these strings as query values).
    """

    EARLY_START = "early_start"
    EARLY_FINISH = "early_finish"
    LATE_START = "late_start"
    LATE_FINISH = "late_finish"
    TOTAL_FLOAT = "total_float"
    FREE_FLOAT = "free_float"
    #: The task's span start (ADR-0752), as distinct from ``early_start``'s
    #: remaining-work window. ``scheduled_finish`` is deliberately NOT a
    #: member here — it is always identical to ``early_finish``, and a second
    #: name for one quantity in this allow-list would invite a client to ask
    #: the same question twice and get two answers (ADR-0752 §5).
    SCHEDULED_START = "scheduled_start"


# Which pass produced each quantity — a fixed fact of the CPM algorithm.
_PASS_FOR_QUANTITY: dict[Quantity, str] = {
    Quantity.EARLY_START: "forward",
    Quantity.EARLY_FINISH: "forward",
    Quantity.LATE_START: "backward",
    Quantity.LATE_FINISH: "backward",
    Quantity.TOTAL_FLOAT: "float",
    Quantity.FREE_FLOAT: "float",
    Quantity.SCHEDULED_START: "forward",
}


@dataclass
class DerivationContribution:
    """One candidate constraint that participated in computing a value.

    Exactly one contribution in a :class:`Derivation` carries ``is_binding=True``
    — the term the engine's ``max``/``min`` selected (its ``imposed_date`` equals
    the derived value for a date quantity). ``calendar_days_added`` is the number
    of days the working-day snap pushed the raw offset (lag/duration arithmetic is
    calendar-agnostic; the calendar's own contribution is this snap), computed as
    ``(snapped_working_day - raw_offset).days`` — never estimated.
    """

    #: Constraint category: ``project_start`` | ``data_date`` |
    #: ``planned_start_snet`` | ``predecessor_fs`` | ``predecessor_ss`` |
    #: ``predecessor_ff`` | ``predecessor_sf`` | ``project_finish`` |
    #: ``successor_fs`` | ``successor_ss`` | ``successor_ff`` | ``successor_sf`` |
    #: ``actual_start`` | ``actual_finish`` | ``early_start`` | ``late_start`` |
    #: ``successor_free_slack`` | ``total_float`` | ``duration_from_early_start`` |
    #: ``early_finish_pullback`` | ``duration_from_late_finish`` |
    #: ``duration_from_late_start`` | ``full_duration_backoff`` (ADR-0752
    #: ``scheduled_start``: the calendar back-off of the task's full duration
    #: from ``early_finish``, for an in-progress task with no ``actual_start``).
    kind: str
    #: The driving predecessor/successor task id for a link term; ``None`` for an
    #: anchor (project start/finish, data date, SNET, recorded actual).
    source_task_id: str | None = None
    #: The driving task's human-readable name, for citation; ``None`` for anchors.
    source_task_name: str | None = None
    #: Dependency type of the link (``FS``/``SS``/``FF``/``SF``); ``None`` for anchors.
    dep_type: str | None = None
    #: Signed lag in calendar days on the link; ``None`` for anchors.
    lag_days: int | None = None
    #: The date this constraint forced onto the target; ``None`` for a float slack term.
    imposed_date: date | None = None
    #: Days the working-day snap added to the raw offset; ``None`` when N/A.
    calendar_days_added: int | None = None
    #: Working-day slack this term allows (free-float successor slack / total-float span).
    slack_days: int | None = None
    is_binding: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Return this contribution as a JSON-serializable dict.

        Returns:
            The contribution's fields with dates rendered as ISO-8601 strings, so
            an explanation can be serialized straight to an API response.
        """
        return {
            "kind": self.kind,
            "source_task_id": self.source_task_id,
            "source_task_name": self.source_task_name,
            "dep_type": self.dep_type,
            "lag_days": self.lag_days,
            "imposed_date": self.imposed_date.isoformat() if self.imposed_date else None,
            "calendar_days_added": self.calendar_days_added,
            "slack_days": self.slack_days,
            "is_binding": self.is_binding,
        }


@dataclass
class Derivation:
    """The server-computed *why* behind one computed schedule value.

    ``value`` is an ISO-8601 date string for a date quantity, or an integer count
    of working days for ``total_float`` / ``free_float``. ``binding`` is the single
    contribution the engine selected; ``contributions`` is every candidate it
    weighed (with the binding one flagged), so a consumer can show not just the
    winner but what it beat.
    """

    task_id: str
    task_name: str
    quantity: str
    value: str | int | None
    pass_: str
    is_critical: bool
    binding: DerivationContribution | None
    contributions: list[DerivationContribution] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Return this derivation as a JSON-serializable dict.

        Note:
            The ``pass_`` attribute is emitted under the key ``"pass"`` — the
            trailing underscore exists only because ``pass`` is a Python keyword,
            and the wire contract uses the unsuffixed name.

        Returns:
            The derivation's fields, with ``binding`` and each entry of
            ``contributions`` recursively converted.
        """
        return {
            "task_id": self.task_id,
            "task_name": self.task_name,
            "quantity": self.quantity,
            "value": self.value,
            "pass": self.pass_,
            "is_critical": self.is_critical,
            "binding": self.binding.to_dict() if self.binding else None,
            "contributions": [c.to_dict() for c in self.contributions],
        }


class UnknownTaskError(SchedulerError):
    """Raised when ``task_id`` names no task in the project.

    Subclasses :class:`~trueppm_scheduler.engine.SchedulerError` (which is itself
    a :class:`ValueError`) so a single ``except SchedulerError`` catches every
    scheduler-originated failure — including this one from the exported
    :func:`derive_value` — while existing ``except ValueError`` callers keep
    working. Reparented from a bare ``ValueError`` ahead of the 1.0 public-surface
    freeze: interposing the common base is backward compatible to add now but
    would be a breaking change to add later. The API maps it to a ``404``.
    """


def _cal_for(
    task_id: str,
    calendar: Calendar,
    task_calendars: dict[str, Calendar] | None,
) -> Calendar:
    """The calendar governing ``task_id``'s own date arithmetic (ADR-0120 D3)."""
    if task_calendars is None:
        return calendar
    return task_calendars.get(task_id, calendar)


def _days_between(a: date, b: date) -> int:
    """Signed calendar-day delta ``(b - a).days`` — the calendar-snap contribution."""
    return (b - a).days


def _completed_forward_contribs(task: Task, *, want_finish: bool) -> list[DerivationContribution]:
    """Provenance for a completed task pinned to its recorded actuals (ADR-0136).

    Completed tasks are taken out of network logic; the honest binding is the
    recorded actual (or, for a bare 100%-complete task, the full-duration
    planning position from the un-floored project start), not a predecessor link.
    The two contributions are emitted finish-first or start-first to mirror which
    actual the engine treated as authoritative.
    """
    contribs: list[DerivationContribution] = []
    if task.actual_finish is not None:
        contribs.append(
            DerivationContribution(
                kind="actual_finish", imposed_date=task.early_finish, is_binding=want_finish
            )
        )
        contribs.append(
            DerivationContribution(
                kind="actual_start", imposed_date=task.early_start, is_binding=not want_finish
            )
        )
    elif task.actual_start is not None:
        contribs.append(
            DerivationContribution(
                kind="actual_start", imposed_date=task.early_start, is_binding=not want_finish
            )
        )
        contribs.append(
            DerivationContribution(
                kind="actual_finish", imposed_date=task.early_finish, is_binding=want_finish
            )
        )
    else:
        # 100%-complete with no recorded actuals: laid out at full duration from
        # the un-floored project start (engine full-duration planning position).
        contribs.append(
            DerivationContribution(
                kind="project_start", imposed_date=task.early_start, is_binding=not want_finish
            )
        )
        contribs.append(
            DerivationContribution(
                kind="early_start", imposed_date=task.early_finish, is_binding=want_finish
            )
        )
    return contribs


def _derive_scheduled_start(
    task: Task, cal: Calendar
) -> tuple[str | None, list[DerivationContribution]]:
    """Explain ``scheduled_start`` (ADR-0752 §2): the task's span start.

    Mirrors :func:`engine._compute_scheduled_start`'s branches, each with its own
    honest citation:

    - Not started or complete: the remaining-work window *is* the span, so the
      binding citation is ``early_start`` itself.
    - In progress with a recorded ``actual_start``: that actual is the binding
      citation — work began when it began, however long ago, regardless of what
      the network would otherwise compute.
    - In progress with no ``actual_start``: the binding citation is the
      full-duration calendar back-off from ``early_finish`` (unaffected by
      progress — remaining work still ends when the task ends), so the
      contribution carries the ``early_finish`` it was computed from and the
      full duration (in ``slack_days``, following ``_forward_duration_binding``'s
      precedent of citing a duration count there).
    """
    assert task.early_start is not None and task.early_finish is not None
    if _is_complete(task) or (task.percent_complete or 0.0) <= 0:
        contribs = [
            DerivationContribution(
                kind="early_start", imposed_date=task.early_start, is_binding=True
            )
        ]
        return task.early_start.isoformat(), contribs

    if task.actual_start is not None:
        contribs = [
            DerivationContribution(
                kind="actual_start", imposed_date=task.actual_start, is_binding=True
            )
        ]
        return task.actual_start.isoformat(), contribs

    full_days = task.duration.days
    scheduled_start = _start_from_finish(task.early_finish, full_days, cal)
    contribs = [
        DerivationContribution(
            kind="early_finish", imposed_date=task.early_finish, is_binding=False
        ),
        DerivationContribution(
            kind="full_duration_backoff",
            imposed_date=scheduled_start,
            slack_days=full_days,
            is_binding=True,
        ),
    ]
    return scheduled_start.isoformat(), contribs


# Provenance kind + label per dependency type, mirroring ``engine._forward_pass``.
_FORWARD_PRED_KIND: dict[DependencyType, tuple[str, str]] = {
    DependencyType.FS: ("predecessor_fs", "FS"),
    DependencyType.SS: ("predecessor_ss", "SS"),
    DependencyType.FF: ("predecessor_ff", "FF"),
    DependencyType.SF: ("predecessor_sf", "SF"),
}


def _pred_forward_contribution(
    pred: Task, dep_type: DependencyType, lag: timedelta, cal: Calendar
) -> DerivationContribution:
    """One predecessor's early-* contribution, snapped to a working day.

    Reproduces the FS/SS/FF/SF anchoring of ``engine._forward_pass``: FS/FF read
    the predecessor's ``early_finish`` (FS with the extra +1 inclusive→exclusive
    interval day), SS/SF its ``early_start``, then snap ``anchor + lag`` forward
    to the next working day.
    """
    assert pred.early_start is not None and pred.early_finish is not None
    if dep_type == DependencyType.FS:
        raw = _safe_offset(pred.early_finish, timedelta(days=1) + lag)
    elif dep_type == DependencyType.FF:
        raw = _safe_offset(pred.early_finish, lag)
    else:  # SS / SF anchor on the predecessor start
        raw = _safe_offset(pred.early_start, lag)
    imposed = _next_working_day(raw, cal)
    kind, label = _FORWARD_PRED_KIND[dep_type]
    return DerivationContribution(
        kind=kind,
        source_task_id=pred.id,
        source_task_name=pred.name,
        dep_type=label,
        lag_days=lag.days,
        imposed_date=imposed,
        calendar_days_added=_days_between(raw, imposed),
    )


def _derive_forward(
    task: Task,
    task_map: dict[str, Task],
    preds: list[tuple[Task, DependencyType, timedelta]],
    cal: Calendar,
    project_start: date,
    status_date: date | None,
    *,
    want_finish: bool,
) -> tuple[str | int | None, list[DerivationContribution]]:
    """Replay :func:`engine._forward_pass` for one node, recording provenance.

    Returns the value (ISO date string) and the candidate contributions, with the
    binding one flagged. ``want_finish`` selects ``early_finish`` vs ``early_start``.
    """
    # Completed tasks are pinned to their recorded actuals and taken out of network
    # logic (engine ADR-0136); the honest binding is the recorded actual, not a
    # predecessor link.
    if _is_complete(task):
        contribs = _completed_forward_contribs(task, want_finish=want_finish)
        value = task.early_finish if want_finish else task.early_start
        return (value.isoformat() if value else None, contribs)

    # --- Early-start candidates (mirror engine._forward_pass) ---
    contribs = _forward_floor_contribs(task, cal, project_start, status_date)

    # FS/SS impose the early start (appended in-line); FF/SF impose the early finish
    # and are collected separately so the binding resolution below can flag them.
    ef_terms: list[DerivationContribution] = []
    for pred, dep_type, lag in preds:
        contribution = _pred_forward_contribution(pred, dep_type, lag, cal)
        if dep_type in (DependencyType.FF, DependencyType.SF):
            ef_terms.append(contribution)
        else:
            contribs.append(contribution)

    es_terms = [c for c in contribs if c.kind not in ("predecessor_ff", "predecessor_sf")]
    contribs.extend(ef_terms)

    value, derived = _resolve_forward_binding(task, es_terms, ef_terms, want_finish=want_finish)
    if derived is not None:
        contribs.append(derived)

    return (value.isoformat() if value else None, contribs)


def _resolve_forward_binding(
    task: Task,
    es_terms: list[DerivationContribution],
    ef_terms: list[DerivationContribution],
    *,
    want_finish: bool,
) -> tuple[date | None, DerivationContribution | None]:
    """Flag whichever candidate produced the engine's authoritative value.

    The engine's final values come from the ``ScheduleResult`` and are authoritative;
    this only decides which candidate to mark as binding. Start is bound by the ES
    term whose ``imposed_date`` equals the final ``early_start``; finish, by an EF
    term (FF/SF) when one drove it, else derived from the start (duration expansion).

    ``_flag_binding`` marks the matching term in place and returns it; ``None`` means
    no candidate produced the engine's value, so the second element of the returned
    tuple is the derived term that explains it.
    """
    if want_finish:
        derived = (
            None
            if _flag_binding(ef_terms, task.early_finish) is not None
            else _forward_duration_binding(task)
        )
        return task.early_finish, derived

    derived = (
        None
        if _flag_binding(es_terms, task.early_start) is not None
        else _forward_pullback_binding(task, ef_terms)
    )
    return task.early_start, derived


def _forward_floor_contribs(
    task: Task, cal: Calendar, project_start: date, status_date: date | None
) -> list[DerivationContribution]:
    """The non-network early-start candidates: project start, data date, SNET, and
    — for in-progress work — the recorded ``actual_start`` floor.

    ``actual_start`` (ADR-0132 §2, #2621) is only reachable here for a task that
    is not complete (``_derive_forward`` routes completed tasks through
    :func:`_completed_forward_contribs` instead); it is emitted unsnapped, unlike
    the calendar-anchored terms, mirroring ``engine._forward_pass``: actuals are
    truth and are never renegotiated onto a working day.
    """
    start_base = _next_working_day(project_start, cal)
    contribs = [
        DerivationContribution(
            kind="project_start",
            imposed_date=start_base,
            calendar_days_added=_days_between(project_start, start_base),
        )
    ]
    if status_date is not None:
        snapped = _next_working_day(status_date, cal)
        contribs.append(
            DerivationContribution(
                kind="data_date",
                imposed_date=snapped,
                calendar_days_added=_days_between(status_date, snapped),
            )
        )
    if task.actual_start is not None:
        contribs.append(
            DerivationContribution(
                kind="actual_start",
                imposed_date=task.actual_start,
            )
        )
    if task.planned_start is not None:
        snapped = _next_working_day(task.planned_start, cal)
        contribs.append(
            DerivationContribution(
                kind="planned_start_snet",
                imposed_date=snapped,
                calendar_days_added=_days_between(task.planned_start, snapped),
            )
        )
    return contribs


def _forward_duration_binding(task: Task) -> DerivationContribution:
    """Finish derived from the (start + duration) expansion, not an FF/SF term.

    The date this term produces is the ``early_finish`` itself.
    """
    return DerivationContribution(
        kind="duration_from_early_start",
        imposed_date=task.early_finish,
        is_binding=True,
        slack_days=_effective_duration_days(task),
    )


def _forward_pullback_binding(
    task: Task, ef_terms: list[DerivationContribution]
) -> DerivationContribution:
    """Rare: an FF/SF finish constraint pulled the start back below every ES term.

    This is the engine's EF-pullback branch. The finish driver is the honest cause;
    the date it forces onto the start is the ``early_start`` itself.
    """
    driver = min(ef_terms, key=lambda c: c.imposed_date or date.max) if ef_terms else None
    return DerivationContribution(
        kind="early_finish_pullback",
        source_task_id=driver.source_task_id if driver else None,
        source_task_name=driver.source_task_name if driver else None,
        dep_type=driver.dep_type if driver else None,
        lag_days=driver.lag_days if driver else None,
        imposed_date=task.early_start,
        is_binding=True,
    )


def _derive_backward(
    task: Task,
    succs: list[tuple[Task, DependencyType, timedelta]],
    cal: Calendar,
    project_finish: date,
    *,
    want_start: bool,
) -> tuple[str | int | None, list[DerivationContribution]]:
    """Replay :func:`engine._backward_pass` for one node, recording provenance."""
    if _is_complete(task):
        # Completed → late == early → zero float; the finish anchor is its own finish.
        contribs = [
            DerivationContribution(
                kind="early_start", imposed_date=task.late_start, is_binding=want_start
            ),
            DerivationContribution(
                kind="project_finish", imposed_date=task.late_finish, is_binding=not want_start
            ),
        ]
        value = task.late_start if want_start else task.late_finish
        return (value.isoformat() if value else None, contribs)

    lf_terms, ls_terms = _backward_successor_terms(succs, cal, project_finish)
    contribs = [*lf_terms, *ls_terms]

    # _flag_binding marks the matching term in place and returns it; None means no
    # candidate produced the engine's value, so the derived term below is the cause.
    if want_start:
        if _flag_binding(ls_terms, task.late_start) is None:
            contribs.append(_backward_duration_binding(task))
        value = task.late_start
    else:
        if _flag_binding(lf_terms, task.late_finish) is None:
            contribs.append(_backward_pullback_binding(task, ls_terms))
        value = task.late_finish

    return (value.isoformat() if value else None, contribs)


def _backward_successor_terms(
    succs: list[tuple[Task, DependencyType, timedelta]],
    cal: Calendar,
    project_finish: date,
) -> tuple[list[DerivationContribution], list[DerivationContribution]]:
    """Split the outgoing edges into late-finish and late-start candidate terms.

    Seeded with the project-finish anchor, which snaps to this node's own last
    workable day exactly as ``engine._backward_pass`` seeds it (#1820) — the
    provenance must cite the date the engine actually floors at, not a raw weekend
    ``project_finish``.
    """
    lf_terms: list[DerivationContribution] = [
        DerivationContribution(
            kind="project_finish", imposed_date=_prev_working_day(project_finish, cal)
        )
    ]
    ls_terms: list[DerivationContribution] = []

    # FS/FF bound when this task may finish; SS/SF bound when it may start. The
    # dep_type label is spelled out rather than read off the enum so the emitted
    # provenance strings stay pinned to their frozen public contract.
    bounds: dict[DependencyType, tuple[list[DerivationContribution], str, str]] = {
        DependencyType.FS: (lf_terms, "successor_fs", "FS"),
        DependencyType.FF: (lf_terms, "successor_ff", "FF"),
        DependencyType.SS: (ls_terms, "successor_ss", "SS"),
        DependencyType.SF: (ls_terms, "successor_sf", "SF"),
    }

    for succ, dep_type, lag in succs:
        # A completed successor is out of network logic and imposes no backward
        # constraint (engine._backward_pass skips it, #1819); it must not appear as
        # a derivation term or the explanation would disagree with the late dates.
        if _is_complete(succ):
            continue
        assert succ.late_start is not None and succ.late_finish is not None

        if dep_type == DependencyType.FS:
            raw = _safe_offset(succ.late_start, -timedelta(days=1) - lag)
        elif dep_type == DependencyType.SS:
            raw = _safe_offset(succ.late_start, -lag)
        else:  # FF and SF both retreat from the successor's late finish.
            raw = _safe_offset(succ.late_finish, -lag)

        terms, kind, label = bounds[dep_type]
        imposed = _prev_working_day(raw, cal)
        terms.append(
            DerivationContribution(
                kind=kind,
                source_task_id=succ.id,
                source_task_name=succ.name,
                dep_type=label,
                lag_days=lag.days,
                imposed_date=imposed,
                calendar_days_added=_days_between(raw, imposed),
            )
        )

    return lf_terms, ls_terms


def _backward_duration_binding(task: Task) -> DerivationContribution:
    """Late start derived from the late finish (duration expansion backward).

    The date this term produces is the ``late_start`` itself.
    """
    return DerivationContribution(
        kind="duration_from_late_finish",
        imposed_date=task.late_start,
        is_binding=True,
        slack_days=_effective_duration_days(task),
    )


def _backward_pullback_binding(
    task: Task, ls_terms: list[DerivationContribution]
) -> DerivationContribution:
    """Rare: an SS/SF successor pulled late_start below the LF-derived start.

    This is the engine's LS-pullback branch: the forward re-expansion
    ``finish_from_start(late_start, duration)`` undercut every LF term, so
    ``late_finish`` matches none of them. The tightest SS/SF successor is the honest
    driver; the date its pullback forces onto the finish (via the duration expansion)
    is the ``late_finish`` itself.
    """
    driver = min(ls_terms, key=lambda c: c.imposed_date or date.max) if ls_terms else None
    return DerivationContribution(
        kind="duration_from_late_start",
        source_task_id=driver.source_task_id if driver else None,
        source_task_name=driver.source_task_name if driver else None,
        dep_type=driver.dep_type if driver else None,
        lag_days=driver.lag_days if driver else None,
        imposed_date=task.late_finish,
        is_binding=True,
        slack_days=_effective_duration_days(task),
    )


def _flag_binding(
    terms: list[DerivationContribution], target: date | None
) -> DerivationContribution | None:
    """Flag and return the term whose ``imposed_date`` equals ``target``.

    When ``target`` is ``None`` (the EF/LS-pullback fallback), the tightest term is
    flagged instead — the finish constraint that pulled the start off its own terms.
    """
    if not terms:
        return None
    if target is not None:
        matches = [c for c in terms if c.imposed_date == target]
        if not matches:
            return None
        # On a tie (several terms impose the same binding date) prefer a real
        # driver — a predecessor/successor link — over a trivial anchor (project
        # start/finish, data date): "task B waits on task A" is a more useful
        # answer than "the project started then" when both are equally true.
        chosen = next((c for c in matches if c.source_task_id is not None), matches[0])
        chosen.is_binding = True
        return chosen
    # Fallback: the min imposed_date drove an EF pullback (forward) / the min drove
    # LS (backward). Both select the tightest (earliest) finish constraint.
    tightest = min(terms, key=lambda c: c.imposed_date or date.max)
    tightest.is_binding = True
    return tightest


def _derive_total_float(task: Task, cal: Calendar) -> tuple[int, list[DerivationContribution]]:
    """total_float = working days between early_start and late_start (engine def)."""
    assert task.early_start is not None and task.late_start is not None
    tf_days = _working_days_between(task.early_start, task.late_start, cal)
    contribs = [
        DerivationContribution(
            kind="early_start", imposed_date=task.early_start, is_binding=True, slack_days=tf_days
        ),
        DerivationContribution(kind="late_start", imposed_date=task.late_start, is_binding=True),
    ]
    return tf_days, contribs


def _inverse_link_constraint(
    task: Task,
    succ: Task,
    dep_type: DependencyType,
    lag: timedelta,
    cal: Calendar,
) -> tuple[date, int]:
    """Latest date this link permits, and the working-day slip to it.

    Inverts the forward constraint — retreating from the successor's *early* date by
    the calendar-day lag and snapping on this task's own calendar — rather than
    measuring the gap from the forward-imposed date, which diverged whenever a
    calendar-day lag re-landed across non-working days (#1828).

    Returns ``(latest, slack)``.
    """
    assert task.early_start is not None and task.early_finish is not None
    assert succ.early_start is not None and succ.early_finish is not None

    if dep_type == DependencyType.FS:
        # Latest finish that leaves succ.early_start unmoved (inverse of the
        # forward FS constraint; matches the backward pass's LF retreat).
        latest = _prev_working_day(_safe_offset(succ.early_start, -timedelta(days=1) - lag), cal)
        return latest, _working_days_between(task.early_finish, latest, cal)
    if dep_type == DependencyType.SS:
        latest = _retreat_calendar_days(succ.early_start, lag, cal)
        return latest, _working_days_between(task.early_start, latest, cal)
    if dep_type == DependencyType.FF:
        latest = _retreat_calendar_days(succ.early_finish, lag, cal)
        return latest, _working_days_between(task.early_finish, latest, cal)
    # SF: successor finish is bounded by this task's start + lag
    latest = _retreat_calendar_days(succ.early_finish, lag, cal)
    return latest, _working_days_between(task.early_start, latest, cal)


def _derive_free_float(
    task: Task,
    succs: list[tuple[Task, DependencyType, timedelta]],
    cal: Calendar,
    tf_days: int,
) -> tuple[int, list[DerivationContribution]]:
    """Replay :func:`engine._compute_floats` free-float slack, recording provenance.

    Mirrors the post-#1828 engine exactly: for each live successor link the
    forward constraint is **inverted** — retreat from the successor's *early*
    date by the calendar-day lag, snapping on this task's own calendar — to find
    the latest date this task could finish (FS/FF) or start (SS/SF) without
    moving the successor. The slack is the working-day slip from the task's own
    early date to that latest date, measured on the task's own calendar. Free
    float is the minimum slack, capped at total float; the binding successor is
    the tightest. (The earlier proxy measured the gap from the *forward*-imposed
    date to the successor's early date on the successor's calendar, which
    diverged whenever a calendar-day lag re-landed across non-working days.)

    Each contribution's ``imposed_date`` is the latest allowable date the link
    permits (the inverse constraint) — the date the slack is measured *to*.
    """
    contribs: list[DerivationContribution] = []
    ff_days = tf_days
    binding: DerivationContribution | None = None
    for succ, dep_type, lag in succs:
        # Skip completed successors, matching engine._compute_floats (#1819): a done
        # task imposes no live constraint, so it is not a free-float term. With all
        # successors complete, binding stays None and free float falls back to total.
        if _is_complete(succ):
            continue
        assert (
            task.early_start is not None
            and task.early_finish is not None
            and succ.early_start is not None
            and succ.early_finish is not None
        )
        latest, slack = _inverse_link_constraint(task, succ, dep_type, lag, cal)
        slack = max(0, slack)
        c = DerivationContribution(
            kind="successor_free_slack",
            source_task_id=succ.id,
            source_task_name=succ.name,
            dep_type=dep_type.value,
            lag_days=lag.days,
            imposed_date=latest,
            slack_days=slack,
        )
        contribs.append(c)
        if slack <= ff_days:
            ff_days = slack
            binding = c
    ff_days = max(0, ff_days)
    if binding is not None:
        binding.is_binding = True
    else:
        # No live successor bound the slip (none exist, all are complete, or every
        # link's slack exceeds total float): free float falls back to total float.
        fallback = DerivationContribution(kind="total_float", slack_days=tf_days, is_binding=True)
        contribs.append(fallback)
    return ff_days, contribs


def derive_value(
    project: Project,
    task_id: str,
    quantity: Quantity | str,
    result: ScheduleResult | None = None,
) -> Derivation:
    """Explain how the CPM engine computed one value for one task (ADR-0218).

    Args:
        project: The project to schedule (or already scheduled, if ``result`` given).
        task_id: The task whose computed value is being explained.
        quantity: Which value to explain — a :class:`Quantity` or its string value
            (``early_start`` / ``early_finish`` / ``late_start`` / ``late_finish`` /
            ``total_float`` / ``free_float`` / ``scheduled_start``).
        result: A precomputed :class:`~trueppm_scheduler.engine.ScheduleResult` for
            ``project``. When omitted, ``schedule(project)`` is run. Passing the
            already-computed result avoids scheduling the network twice.

    Returns:
        A :class:`Derivation` naming the binding constraint, every candidate
        contribution, and which pass set the value.

    Raises:
        UnknownTaskError: If ``task_id`` names no task in the project.
        ValueError: If ``quantity`` is not a known quantity.
        SchedulerError: Propagated from :func:`schedule` for a degenerate project.
    """
    q = quantity if isinstance(quantity, Quantity) else Quantity(quantity)

    if result is None:
        result = schedule(project)

    task_map: dict[str, Task] = {t.id: t for t in result.tasks}
    task = task_map.get(task_id)
    if task is None:
        raise UnknownTaskError(f"Task {task_id!r} is not in the project.")

    task_calendars = _resolve_task_calendars(project)
    default_cal = project.calendar
    cal = _cal_for(task_id, default_cal, task_calendars)

    # Only the <= degree(task_id) edges incident to the target are ever read, so a
    # single filtering scan of the dependency list suffices — rebuilding the full
    # nx.DiGraph here cost O(V + E) time plus a transient whole-adjacency
    # allocation per explained value (#1859). The dicts keyed by the far endpoint
    # mirror nx.DiGraph adjacency semantics exactly: insertion-ordered, and the
    # last duplicate (predecessor, successor) pair wins. (schedule() rejects such
    # duplicates outright, so the tiebreak only matters for a caller passing a
    # prebuilt ``result`` for input the engine would refuse.)
    pred_deps: dict[str, Dependency] = {}
    succ_deps: dict[str, Dependency] = {}
    for dep in project.dependencies:
        if dep.successor_id == task_id:
            pred_deps[dep.predecessor_id] = dep
        if dep.predecessor_id == task_id:
            succ_deps[dep.successor_id] = dep

    preds: list[tuple[Task, DependencyType, timedelta]] = [
        (task_map[pred_id], dep.dep_type, dep.lag) for pred_id, dep in pred_deps.items()
    ]
    succs: list[tuple[Task, DependencyType, timedelta]] = [
        (task_map[succ_id], dep.dep_type, dep.lag) for succ_id, dep in succ_deps.items()
    ]

    value: str | int | None
    contribs: list[DerivationContribution]
    if q in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        value, contribs = _derive_forward(
            task,
            task_map,
            preds,
            cal,
            project.start_date,
            project.status_date,
            want_finish=q is Quantity.EARLY_FINISH,
        )
    elif q in (Quantity.LATE_START, Quantity.LATE_FINISH):
        value, contribs = _derive_backward(
            task,
            succs,
            cal,
            result.project_finish,
            want_start=q is Quantity.LATE_START,
        )
    elif q is Quantity.SCHEDULED_START:
        value, contribs = _derive_scheduled_start(task, cal)
    else:  # TOTAL_FLOAT / FREE_FLOAT — both start from the same total-float replay.
        tf_days, tf_contribs = _derive_total_float(task, cal)
        if q is Quantity.TOTAL_FLOAT:
            value, contribs = tf_days, tf_contribs
        else:
            value, contribs = _derive_free_float(task, succs, cal, tf_days)

    binding = next((c for c in contribs if c.is_binding), None)
    return Derivation(
        task_id=task.id,
        task_name=task.name,
        quantity=q.value,
        value=value,
        pass_=_PASS_FOR_QUANTITY[q],
        is_critical=task.is_critical,
        binding=binding,
        contributions=contribs,
    )
