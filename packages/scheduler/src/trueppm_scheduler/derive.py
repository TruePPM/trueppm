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
    ScheduleResult,
    _effective_duration_days,
    _is_complete,
    _next_working_day,
    _prev_working_day,
    _resolve_task_calendars,
    _safe_offset,
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


# Which pass produced each quantity — a fixed fact of the CPM algorithm.
_PASS_FOR_QUANTITY: dict[Quantity, str] = {
    Quantity.EARLY_START: "forward",
    Quantity.EARLY_FINISH: "forward",
    Quantity.LATE_START: "backward",
    Quantity.LATE_FINISH: "backward",
    Quantity.TOTAL_FLOAT: "float",
    Quantity.FREE_FLOAT: "float",
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
    #: ``successor_free_slack``.
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


class UnknownTaskError(ValueError):
    """Raised when ``task_id`` names no task in the project.

    Subclasses :class:`ValueError` so existing ``except ValueError`` callers keep
    working; the API maps it to a ``404``.
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
    contribs: list[DerivationContribution] = []

    # Completed tasks are pinned to their recorded actuals and taken out of network
    # logic (engine ADR-0136); the honest binding is the recorded actual, not a
    # predecessor link.
    if _is_complete(task):
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
        value = task.early_finish if want_finish else task.early_start
        return (value.isoformat() if value else None, contribs)

    # --- Early-start candidates (mirror engine._forward_pass) ---
    start_base = _next_working_day(project_start, cal)
    contribs.append(
        DerivationContribution(
            kind="project_start",
            imposed_date=start_base,
            calendar_days_added=_days_between(project_start, start_base),
        )
    )
    if status_date is not None:
        snapped = _next_working_day(status_date, cal)
        contribs.append(
            DerivationContribution(
                kind="data_date",
                imposed_date=snapped,
                calendar_days_added=_days_between(status_date, snapped),
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

    ef_terms: list[DerivationContribution] = []
    for pred, dep_type, lag in preds:
        assert pred.early_start is not None and pred.early_finish is not None
        lag_days = lag.days
        if dep_type == DependencyType.FS:
            raw = _safe_offset(pred.early_finish, timedelta(days=1) + lag)
            imposed = _next_working_day(raw, cal)
            contribs.append(
                DerivationContribution(
                    kind="predecessor_fs",
                    source_task_id=pred.id,
                    source_task_name=pred.name,
                    dep_type="FS",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )
        elif dep_type == DependencyType.SS:
            raw = _safe_offset(pred.early_start, lag)
            imposed = _next_working_day(raw, cal)
            contribs.append(
                DerivationContribution(
                    kind="predecessor_ss",
                    source_task_id=pred.id,
                    source_task_name=pred.name,
                    dep_type="SS",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )
        elif dep_type == DependencyType.FF:
            raw = _safe_offset(pred.early_finish, lag)
            imposed = _next_working_day(raw, cal)
            ef_terms.append(
                DerivationContribution(
                    kind="predecessor_ff",
                    source_task_id=pred.id,
                    source_task_name=pred.name,
                    dep_type="FF",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )
        elif dep_type == DependencyType.SF:
            raw = _safe_offset(pred.early_start, lag)
            imposed = _next_working_day(raw, cal)
            ef_terms.append(
                DerivationContribution(
                    kind="predecessor_sf",
                    source_task_id=pred.id,
                    source_task_name=pred.name,
                    dep_type="SF",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )

    # The engine's final values are authoritative (taken from the ScheduleResult);
    # flag whichever candidate produced them. Start is bound by the ES term whose
    # imposed_date equals the final early_start; finish, by an EF term (FF/SF) when
    # one drove it, else derived from the start (duration expansion).
    es_terms = [c for c in contribs if c.kind not in ("predecessor_ff", "predecessor_sf")]
    contribs.extend(ef_terms)

    if want_finish:
        binding = _flag_binding(ef_terms, task.early_finish)
        if binding is None:
            # Finish derived from the (start + duration) expansion, not an FF/SF term.
            # The date this term produces is the early_finish itself.
            binding = DerivationContribution(
                kind="duration_from_early_start",
                imposed_date=task.early_finish,
                is_binding=True,
                slack_days=_effective_duration_days(task),
            )
            contribs.append(binding)
        value = task.early_finish
    else:
        binding = _flag_binding(es_terms, task.early_start)
        if binding is None:
            # Rare: an FF/SF finish constraint pulled the start back below every ES
            # term (engine EF-pullback branch). The finish driver is the honest cause;
            # the date it forces onto the start is the early_start itself.
            driver = min(ef_terms, key=lambda c: c.imposed_date or date.max) if ef_terms else None
            binding = DerivationContribution(
                kind="early_finish_pullback",
                source_task_id=driver.source_task_id if driver else None,
                source_task_name=driver.source_task_name if driver else None,
                dep_type=driver.dep_type if driver else None,
                lag_days=driver.lag_days if driver else None,
                imposed_date=task.early_start,
                is_binding=True,
            )
            contribs.append(binding)
        value = task.early_start

    return (value.isoformat() if value else None, contribs)


def _derive_backward(
    task: Task,
    succs: list[tuple[Task, DependencyType, timedelta]],
    cal: Calendar,
    project_finish: date,
    *,
    want_start: bool,
) -> tuple[str | int | None, list[DerivationContribution]]:
    """Replay :func:`engine._backward_pass` for one node, recording provenance."""
    contribs: list[DerivationContribution] = []

    if _is_complete(task):
        # Completed → late == early → zero float; the finish anchor is its own finish.
        contribs.append(
            DerivationContribution(
                kind="early_start", imposed_date=task.late_start, is_binding=want_start
            )
        )
        contribs.append(
            DerivationContribution(
                kind="project_finish", imposed_date=task.late_finish, is_binding=not want_start
            )
        )
        value = task.late_start if want_start else task.late_finish
        return (value.isoformat() if value else None, contribs)

    # The project-finish anchor snaps to this node's own last workable day, exactly
    # as engine._backward_pass seeds it (#1820) — the provenance must cite the date
    # the engine actually floors at, not a raw weekend project_finish.
    lf_terms: list[DerivationContribution] = [
        DerivationContribution(
            kind="project_finish", imposed_date=_prev_working_day(project_finish, cal)
        )
    ]
    ls_terms: list[DerivationContribution] = []
    for succ, dep_type, lag in succs:
        # A completed successor is out of network logic and imposes no backward
        # constraint (engine._backward_pass skips it, #1819); it must not appear as
        # a derivation term or the explanation would disagree with the late dates.
        if _is_complete(succ):
            continue
        assert succ.late_start is not None and succ.late_finish is not None
        lag_days = lag.days
        if dep_type == DependencyType.FS:
            raw = _safe_offset(succ.late_start, -timedelta(days=1) - lag)
            imposed = _prev_working_day(raw, cal)
            lf_terms.append(
                DerivationContribution(
                    kind="successor_fs",
                    source_task_id=succ.id,
                    source_task_name=succ.name,
                    dep_type="FS",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )
        elif dep_type == DependencyType.FF:
            raw = _safe_offset(succ.late_finish, -lag)
            imposed = _prev_working_day(raw, cal)
            lf_terms.append(
                DerivationContribution(
                    kind="successor_ff",
                    source_task_id=succ.id,
                    source_task_name=succ.name,
                    dep_type="FF",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )
        elif dep_type == DependencyType.SS:
            raw = _safe_offset(succ.late_start, -lag)
            imposed = _prev_working_day(raw, cal)
            ls_terms.append(
                DerivationContribution(
                    kind="successor_ss",
                    source_task_id=succ.id,
                    source_task_name=succ.name,
                    dep_type="SS",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )
        elif dep_type == DependencyType.SF:
            raw = _safe_offset(succ.late_finish, -lag)
            imposed = _prev_working_day(raw, cal)
            ls_terms.append(
                DerivationContribution(
                    kind="successor_sf",
                    source_task_id=succ.id,
                    source_task_name=succ.name,
                    dep_type="SF",
                    lag_days=lag_days,
                    imposed_date=imposed,
                    calendar_days_added=_days_between(raw, imposed),
                )
            )

    contribs.extend(lf_terms)
    contribs.extend(ls_terms)

    if want_start:
        binding = _flag_binding(ls_terms, task.late_start)
        if binding is None:
            # Late start derived from the late finish (duration expansion backward);
            # the date this term produces is the late_start itself.
            binding = DerivationContribution(
                kind="duration_from_late_finish",
                imposed_date=task.late_start,
                is_binding=True,
                slack_days=_effective_duration_days(task),
            )
            contribs.append(binding)
        value = task.late_start
    else:
        # lf_terms always includes the project_finish anchor, so min(lf_terms) is
        # always one of them — _flag_binding never returns None here.
        binding = _flag_binding(lf_terms, task.late_finish)
        value = task.late_finish

    return (value.isoformat() if value else None, contribs)


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


def _derive_free_float(
    task: Task,
    task_map: dict[str, Task],
    succs: list[tuple[Task, DependencyType, timedelta]],
    cal: Calendar,
    tf_days: int,
    task_calendars: dict[str, Calendar] | None,
    default_cal: Calendar,
) -> tuple[int, list[DerivationContribution]]:
    """Replay :func:`engine._compute_floats` free-float slack, recording provenance.

    Free float is the minimum working-day slack to any successor across all four
    dependency types, capped at total float; the binding successor is the tightest.
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
        succ_cal = _cal_for(succ.id, default_cal, task_calendars)
        if dep_type == DependencyType.FS:
            imposed = _next_working_day(
                _safe_offset(task.early_finish, timedelta(days=1) + lag), succ_cal
            )
            succ_date = succ.early_start
        elif dep_type == DependencyType.SS:
            imposed = _next_working_day(_safe_offset(task.early_start, lag), succ_cal)
            succ_date = succ.early_start
        elif dep_type == DependencyType.FF:
            imposed = _next_working_day(_safe_offset(task.early_finish, lag), succ_cal)
            succ_date = succ.early_finish
        else:  # SF
            imposed = _next_working_day(_safe_offset(task.early_start, lag), succ_cal)
            succ_date = succ.early_finish
        slack = max(0, _working_days_between(imposed, succ_date, succ_cal))
        c = DerivationContribution(
            kind="successor_free_slack",
            source_task_id=succ.id,
            source_task_name=succ.name,
            dep_type=dep_type.value,
            lag_days=lag.days,
            imposed_date=succ_date,
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
        # No successors: free float falls back to total float.
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
            ``total_float`` / ``free_float``).
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
    else:  # TOTAL_FLOAT / FREE_FLOAT — both start from the same total-float replay.
        tf_days, tf_contribs = _derive_total_float(task, cal)
        if q is Quantity.TOTAL_FLOAT:
            value, contribs = tf_days, tf_contribs
        else:
            value, contribs = _derive_free_float(
                task, task_map, succs, cal, tf_days, task_calendars, default_cal
            )

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
