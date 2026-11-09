"""Result types returned by :func:`schedule` and :func:`monte_carlo`."""

from __future__ import annotations

from dataclasses import (
    dataclass,
    field,
)
from datetime import (
    date,
)
from typing import (
    Any,
)

from trueppm_scheduler.models import (
    Task,
)

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DrivingEdge:
    """A dependency that binds its successor or has zero relationship free float (#2095, #4704).

    A *driving* edge is the predecessor→successor link that actually controls the
    successor's early date: the successor's early start/finish sits exactly on the
    date this link imposes, read in the successor's working time — the "binding"
    term :func:`trueppm_scheduler.derive.derive_value` cites — or whose
    relationship free float is zero. The set is the union of the two, so it can
    hold a zero-free-float link that does not bind: at a merge where a five-day
    ``P`` and a seven-day ``Q`` both feed ``S``, both are reported while
    ``derive_value`` binds only ``Q``. Non-driving links have
    slack — the successor would start at the same time even if that predecessor
    finished later.

    The two tests are not the same, and free float stays a separate output. Float
    is counted in the predecessor's working days, so a link can place its
    successor and still leave the predecessor slack that moves nothing: a
    seven-day-week predecessor finishing on a Friday into a Monday-to-Friday
    successor has two days of free float (its weekend) and still drives it onto
    Monday, and a calendar-day lag landing on a weekend does the same on one
    calendar (#4537). Testing zero free float alone dropped those links (#4704).

    Identified by the (predecessor, successor) pair plus ``dep_type`` (the string
    value ``"FS"``/``"SS"``/``"FF"``/``"SF"``), matching the stored dependency row.
    Purely presentational metadata for the schedule view's link hierarchy — the
    forward/backward passes and float values are unaffected.

    A driving edge does **not** imply ``total_float(predecessor) <=
    total_float(successor)`` in general (#4269). The textbook identity needs the
    link to be a fixed working-time offset counted in one unit, and four links
    here are not:

    * a non-zero lag is calendar days, so it spans fewer working days once the
      predecessor's late date reaches a weekend. ``M1 -FS+2d-> M2`` from a Monday
      covers two working days, from the end of a Friday none, so in the #4269
      repro ``M1`` floats 5 days while the ``M2`` it drives floats 4.
    * a zero-duration successor's own float is capped by
      :func:`_float_late_instant` (#4183) while its predecessors read the uncapped
      late instant, so it can report a day less float than the task driving it.
    * float is counted in each task's own working days (ADR-0120 D3), so across
      two calendars the same calendar-time slack differs: a 7-day-week
      predecessor can float 10 days while the 5-day-week successor it drives
      floats 8.
    * an SS/SF link out of a started predecessor measures from its recorded
      ``actual_start`` (ADR-0132 §2a, #4523), which already happened: no slip of
      the predecessor's own remaining work can move the link, so the backward
      pass gives the predecessor no late-date bound from this edge. The link can
      still be what holds the successor, so the predecessor's float — bounded
      only by its other edges, if any — can run past the successor's.

    With a zero lag into a work task on the predecessor's calendar, read from a
    start that is not a recorded actual, the identity holds. The scheduler's
    ``test_cpm_invariants.py`` checks exactly that scope and pins all four
    exceptions.
    """

    predecessor_id: str
    successor_id: str
    dep_type: str

    def to_dict(self) -> dict[str, str]:
        """Return this driving edge as a JSON-serializable dict.

        Returns:
            ``{"predecessor_id", "successor_id", "dep_type"}`` — the edge that
            determined the successor's early start, identified by task id rather
            than by object so the result survives serialization.
        """
        return {
            "predecessor_id": self.predecessor_id,
            "successor_id": self.successor_id,
            "dep_type": self.dep_type,
        }


@dataclass
class ScheduleResult:
    """Output of a CPM schedule calculation.

    Each task in ``tasks`` carries early/late start and finish, total float, free
    float, and an ``is_critical`` flag. ``free_float``, ``total_float``, and
    ``is_critical`` all account for every dependency type (FS/SS/FF/SF) per the
    standard critical-path float definitions.

    Task ordering contract (#1862): **the order of tasks in** ``tasks`` **is
    unspecified.** The Python engine happens to preserve input order and the
    Rust/WASM engine emits topological order; neither is a promised part of the
    contract, and callers must not depend on either. Look a task up by its ``id``
    (e.g. ``{t.id: t for t in result.tasks}``), never by list position — position
    is the one field that legitimately differs between the two engines.

    Display rule (#4079, #4173, #4178): ``project_finish`` is a **day**, the latest
    ``early_finish``, not an instant. Work ends at the *end* of its finish day. A
    zero-duration milestone is an instant, and its ``early_finish`` is only the day
    it is *shown* on; :attr:`Task.milestone_at_day_end` says which edge of that
    day the instant is. It is the end when the milestone follows work, and the
    start when a floor holds it, an SS link places it, or a lag lands it on or just
    after non-working time — that last case is shown at the start of the next
    working day. The end of a Friday and the start of the following Monday are the
    same point in working time, so **the shown day can move across a weekend or
    holiday while the working-time finish does not move**. Do not compute slip as
    the calendar-day difference of two ``project_finish`` values: compare in
    working time, reading a start-of-day milestone finish as the end of the last
    working day before it. Pinned by ``tests/test_display_rule_doc.py``:

    >>> from datetime import date, timedelta
    >>> from trueppm_scheduler import Dependency, DependencyType, Project, Task, schedule
    >>> def finish(lag_days: int) -> tuple[str, bool]:
    ...     a = Task(id="A", name="A", duration=timedelta(days=5))
    ...     m = Task(id="M", name="M", duration=timedelta(0))
    ...     link = Dependency(
    ...         predecessor_id="A", successor_id="M",
    ...         dep_type=DependencyType.FS, lag=timedelta(days=lag_days),
    ...     )
    ...     project = Project(
    ...         id="p", name="p", start_date=date(2026, 8, 3),  # a Monday
    ...         tasks=[a, m], dependencies=[link],
    ...     )
    ...     result = schedule(project)
    ...     shown = next(t for t in result.tasks if t.id == "M")
    ...     return result.project_finish.strftime("%a %d"), shown.milestone_at_day_end
    >>> finish(0)  # the end of Friday
    ('Fri 07', True)
    >>> finish(1)  # Sunday midnight, shown at the start of Monday: no working-time move
    ('Mon 10', False)
    >>> finish(3)  # Tuesday midnight, after Monday's work: one working day later
    ('Mon 10', True)
    """

    project_id: str
    project_start: date
    project_finish: date
    # Ordering is UNSPECIFIED — look up by id, not position (see class docstring, #1862).
    tasks: list[Task]  # copies with all CPM fields populated
    critical_path: list[str]  # every critical task ID, in topological order (not one chain)
    # Dependencies that bind their successor or whose relationship free float is
    # zero (#2095, #4704). Order is
    # deterministic (sorted) so the two engines' snapshots stay comparable.
    driving_edges: list[DrivingEdge] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Copy the sequence fields and sort ``driving_edges`` deterministically."""
        # Defensive copy of the sequence containers (#826): the result owns its
        # lists, so a caller mutating the list it passed in — or the engine
        # reusing its internal working list — can't retroactively alter a returned
        # ScheduleResult. The Task objects are already CPM-field copies.
        self.tasks = list(self.tasks)
        self.critical_path = list(self.critical_path)
        # Sort for a deterministic, engine-agnostic order (petgraph vs networkx
        # visit order differs) so conformance snapshots match (#2095).
        self.driving_edges = sorted(
            self.driving_edges,
            key=lambda e: (e.predecessor_id, e.successor_id, e.dep_type),
        )

    def __getstate__(self) -> dict[str, Any]:
        """Return the pickle/copy state without the milestone replay cache."""
        # The milestone pass state schedule() keeps for derive_value (#4524) holds a
        # weak reference, which cannot be pickled; it is only a cache, so a pickled
        # or copied result drops it and derive_value replays the passes instead.
        state = dict(self.__dict__)
        state.pop(_MILESTONE_REPLAY_ATTR, None)
        return state

    def to_dict(self) -> dict[str, Any]:
        """Return the whole schedule result as a JSON-serializable dict.

        Returns:
            Project dates as ISO-8601 strings, every task converted via
            ``Task.to_dict()``, the critical path as a list of task ids, and the
            driving edges (already sorted deterministically, so two runs over the
            same input serialize byte-identically).
        """
        return {
            "project_id": self.project_id,
            "project_start": self.project_start.isoformat(),
            "project_finish": self.project_finish.isoformat(),
            "tasks": [t.to_dict() for t in self.tasks],
            "critical_path": self.critical_path,
            "driving_edges": [e.to_dict() for e in self.driving_edges],
        }


@dataclass
class TaskSensitivity:
    """How strongly one task's duration drives the project finish.

    ``index`` is the absolute Spearman rank correlation between the task's
    per-run sampled duration and the project's per-run completion offset, in
    [0, 1] — the @RISK-style "sensitivity tornado" measure of *which tasks move
    the finish most*. Tasks whose duration cannot vary the finish (deterministic,
    completed, or zero-duration milestones) are omitted rather than reported as 0.
    """

    task_id: str
    index: float

    def to_dict(self) -> dict[str, Any]:
        """Return this sensitivity entry as a JSON-serializable dict.

        Returns:
            ``{"task_id", "index"}`` — the correlation of this task's sampled
            duration with the project finish. Tasks with no sampled variance are
            absent from the list entirely rather than reported as ``0``.
        """
        return {"task_id": self.task_id, "index": self.index}


_Date = date  # ``Percentile.date`` shadows the name inside its own class body


@dataclass(frozen=True)
class Percentile:
    """One computed confidence level of a Monte Carlo finish distribution.

    Attributes:
        date: The completion date at this level, shown on a day the way
            :attr:`ScheduleResult.project_finish` is.
        at_day_start: Which edge of ``date`` the level is. ``True`` means the
            *start* of the day (the finish is a start-of-day milestone, #4079),
            ``False`` the end (#4204).
    """

    date: _Date
    at_day_start: bool = False


@dataclass(init=False)
class MonteCarloResult:
    """Output of a Monte Carlo probabilistic schedule simulation.

    The computed confidence levels live in :attr:`percentiles`, keyed by the
    integer level (``50``, ``80``, ``95``). ``p50``/``p80``/``p95`` and
    ``p50_at_day_start``/``p80_at_day_start``/``p95_at_day_start`` are read-only
    properties over it, so the long-standing attribute reads and the
    :meth:`to_dict` shape are unchanged.

    ``p50``/``p80``/``p95`` are completion dates at those confidence levels, not
    three competing estimates: 50%, 80%, and 95% of simulated runs finished on or
    before each. P80 is the conventional commitment date; P50 sits later than the
    deterministic :func:`schedule` finish by the expected slip. On a network of
    FS/SS links the CPM finish is the earliest any run can finish, so its own
    probability is low, not even. When all
    three are equal the project had nothing to vary (no three-point estimates, no
    velocity signal) and the simulation correctly collapsed onto the CPM finish.

    Each percentile is an order statistic over the runs' **working-time** finish
    positions (#4204), shown on a day the way :attr:`ScheduleResult.project_finish`
    is. ``Percentile.at_day_start`` says which edge of that day the percentile is:
    ``True`` means the *start* of the day (the finish is a start-of-day milestone,
    #4079), ``False`` the end. The end of a Friday and the start of the following
    Monday are the same working-time position, so compare a percentile with a CPM
    finish, or with another run's percentile, in working time — reading a
    start-of-day finish as the end of the last working day before it — never as the
    calendar-day difference of the two shown days. The edge defaults to ``False``,
    the reading every finish had before #4079.

    Construction accepts either the established ``p50``/``p80``/``p95`` keywords
    (and the ``*_at_day_start`` flags), in their original positional order, or
    ``percentiles=`` — not both. ``percentiles`` must contain at least levels 50,
    80 and 95 (a ``TypeError`` names any missing); further levels are kept but not
    emitted by :meth:`to_dict`.

    Attributes:
        project_id: The simulated project's id.
        runs: Number of simulation runs.
        distribution: Full sorted distribution of simulated completion dates;
            useful for rendering histogram tooltips.
        sensitivity: Per-task duration-sensitivity tornado (ADR-0140), sorted by
            ``index`` descending and capped to the top entries. Empty for a fully
            deterministic project.
        percentiles: The confidence levels that were computed, keyed by integer
            level.
    """

    project_id: str
    runs: int
    distribution: list[date]
    sensitivity: list[TaskSensitivity]
    percentiles: dict[int, Percentile]

    def __init__(
        self,
        project_id: str,
        runs: int,
        p50: date | None = None,
        p80: date | None = None,
        p95: date | None = None,
        distribution: list[date] | None = None,
        sensitivity: list[TaskSensitivity] | None = None,
        p50_at_day_start: bool = False,
        p80_at_day_start: bool = False,
        p95_at_day_start: bool = False,
        *,
        percentiles: dict[int, Percentile] | None = None,
    ) -> None:
        """Build a Monte Carlo result from legacy keywords or ``percentiles=``.

        Args:
            project_id: The simulated project's id.
            runs: Number of simulation runs.
            p50: Completion date 50% of runs finished on or before. Required
                unless ``percentiles`` is given.
            p80: Completion date 80% of runs finished on or before. Required
                unless ``percentiles`` is given.
            p95: Completion date 95% of runs finished on or before. Required
                unless ``percentiles`` is given.
            distribution: Sorted distribution of simulated completion dates.
                Defaults to an empty list.
            sensitivity: Per-task duration-sensitivity entries. Defaults to an
                empty list.
            p50_at_day_start: Whether ``p50`` is the start of its day rather
                than the end. Legacy form only.
            p80_at_day_start: Whether ``p80`` is the start of its day. Legacy
                form only.
            p95_at_day_start: Whether ``p95`` is the start of its day. Legacy
                form only.
            percentiles: Confidence levels keyed by integer level; must include
                50, 80 and 95. Keyword-only, and mutually exclusive with the
                ``p50``/``p80``/``p95`` and ``*_at_day_start`` arguments.

        Raises:
            TypeError: If both forms are given, if neither is complete, or if
                ``percentiles`` lacks level 50, 80 or 95.
        """
        legacy = (p50, p80, p95)
        if percentiles is not None:
            if any(v is not None for v in legacy) or any(
                (p50_at_day_start, p80_at_day_start, p95_at_day_start)
            ):
                raise TypeError(
                    "pass either percentiles= or the p50/p80/p95 (+ *_at_day_start) "
                    "arguments to MonteCarloResult, not both"
                )
            levels = dict(percentiles)
            missing = [q for q in (50, 80, 95) if q not in levels]
            if missing:
                raise TypeError(
                    f"percentiles= must include levels 50, 80 and 95; missing {missing}"
                )
        else:
            if any(v is None for v in legacy):
                raise TypeError("MonteCarloResult requires p50, p80 and p95 (or percentiles=)")
            assert p50 is not None and p80 is not None and p95 is not None
            levels = {
                50: Percentile(p50, p50_at_day_start),
                80: Percentile(p80, p80_at_day_start),
                95: Percentile(p95, p95_at_day_start),
            }
        self.project_id = project_id
        self.runs = runs
        self.distribution = [] if distribution is None else distribution
        self.sensitivity = [] if sensitivity is None else sensitivity
        self.percentiles = levels

    @property
    def p50(self) -> date:
        """Completion date that 50% of simulated runs finished on or before."""
        return self.percentiles[50].date

    @property
    def p80(self) -> date:
        """Completion date that 80% of simulated runs finished on or before."""
        return self.percentiles[80].date

    @property
    def p95(self) -> date:
        """Completion date that 95% of simulated runs finished on or before."""
        return self.percentiles[95].date

    @property
    def p50_at_day_start(self) -> bool:
        """Whether :attr:`p50` is the start (``True``) or end of its day (#4204)."""
        return self.percentiles[50].at_day_start

    @property
    def p80_at_day_start(self) -> bool:
        """Whether :attr:`p80` is the start (``True``) or end of its day (#4204)."""
        return self.percentiles[80].at_day_start

    @property
    def p95_at_day_start(self) -> bool:
        """Whether :attr:`p95` is the start (``True``) or end of its day (#4204)."""
        return self.percentiles[95].at_day_start

    def to_dict(self) -> dict[str, Any]:
        """Return the simulation result as a JSON-serializable dict.

        Returns:
            The percentile dates as ISO-8601 strings, the full ``distribution``
            (one date per run — this is the large field, and callers that only
            need the percentiles should read those attributes instead of
            serializing), the duration-sensitivity tornado, and each percentile's
            edge-of-day reading (``p50_at_day_start`` etc., #4204).
        """
        return {
            "project_id": self.project_id,
            "runs": self.runs,
            "p50": self.p50.isoformat(),
            "p80": self.p80.isoformat(),
            "p95": self.p95.isoformat(),
            "p50_at_day_start": self.p50_at_day_start,
            "p80_at_day_start": self.p80_at_day_start,
            "p95_at_day_start": self.p95_at_day_start,
            "distribution": [d.isoformat() for d in self.distribution],
            "sensitivity": [s.to_dict() for s in self.sensitivity],
        }


_MILESTONE_REPLAY_ATTR = "_trueppm_milestone_replay"
