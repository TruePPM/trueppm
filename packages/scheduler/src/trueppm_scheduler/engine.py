"""CPM scheduling engine and Monte Carlo simulation for trueppm-scheduler.

Zero-duration milestones (#4079)
--------------------------------
The engine counts in whole working days with an inclusive ``early_finish``, which
has no way to say "an instant at the end of day D". A zero-duration task used to be
given a start *day* and then treated as a one-day task on both sides of every link,
so each milestone on a path delayed everything behind it by one working day. The
engine now follows the MS Project / Primavera P6 convention:

* A milestone is an **instant**: a midnight, where the end of one day is the start
  of the next. ``early_start == early_finish`` is the day it is *shown* on.
* A milestone driven by work sits at the **end of its driving predecessor's
  finish day**: ``A(5d, Mon..Fri) -FS-> M`` puts ``M`` on Friday, not Monday.
* A milestone held by a floor (project start, SNET, data date, recorded actual
  start) sits at the **start** of that day, and an FS successor starts that day.
* A milestone whose instant falls just after **non-working** time (the midnight
  opening Sunday or Monday after a weekend) — because of a lag, or because its
  predecessor's recorded finish is itself on a non-working day — is shown at the
  **start of the next working day**, the way MS Project snaps an elapsed lag onto
  working time, never at the end of the working day before it (#4173). Otherwise a
  later midnight could be shown on an earlier day than an earlier midnight, and a
  longer predecessor would show the milestone, and ``project_finish``, a day
  *earlier*. The shown day is monotone in the instant; it is not a function of
  working-time position alone (Saturday midnight is still the end of Friday).
* Links **into** a milestone propose a raw instant too: the link's anchor instant
  plus the lag, never snapped to a working day. A milestone's start and finish are
  one instant, so FF into it is the same link as FS (:func:`_milestone_link`) and
  ``A -FF+1d-> M`` lands ``M`` exactly where ``A -FS+1d-> M`` does (#4272).
* Links **out of** a milestone measure from the instant (FS/SS, and an FF or SF
  with a positive lag, #4273, #4333) or the last working day before it (an FF or
  SF with no lag or a lead, so a finish is monotone in its lag). The instant
  is never rounded to a working day, so calendar-day lags compose through it:
  ``A -FS(l1)-> M -FS(l2)-> B`` schedules exactly as ``A -FS(l1+l2)-> B`` unless
  ``l2`` is negative or a hard floor holds ``M``. The project-start floor does not
  break it: it only sets the day ``M`` is shown on, and links out of ``M`` measure
  from the instant below it (#4225). A negative ``l2`` can reach ``M``'s own
  project-finish bound, as it would for any node inserted into the link. The data
  date, an SNET and a recorded actual start do hold ``M`` and every lag measured
  from it, so ``B`` can land later than the direct link puts it.
* The backward pass and free float invert the same rule (:func:`_milestone_latest`,
  :func:`_milestone_refs`), and every late date is seeded from the instant the
  project ends (:func:`_finish_instant`), so a milestone on the critical path
  carries zero float. When that instant already reads as start of day, a
  milestone may sit as late as the midnight opening the next working day
  (:func:`_milestone_finish_bound`, #4174): landing on Monday rather than Sunday
  midnight does not move the shown finish.

Start-to-Finish from ordinary work (#4145)
------------------------------------------
An SF link anchors on the last working day *before* its predecessor's start day,
not on the start day itself: MS Project and P6 finish the successor at the start of
that day, so with lag 0 the successor's last working day is the day before. That is
the same rule the milestone branch above applies to an instant, so an SF link from a
1-day task starting on day D and one from a zero-duration milestone standing at D's
opening midnight now schedule identically — before #4145 the two disagreed by one
working day, and the work branch scheduled one day later than the source plan an MS
Project import came from.

A *positive* SF lag counts from the start instant itself — from ``start - 1``, the
day it closes — not from that pre-snapped working day (#4333). Otherwise a
predecessor starting on Monday anchored on Friday, ``Friday + 2d`` landed on Sunday,
and the snap to Monday absorbed the lag: ``-SF+2d->`` finished the successor on
Monday, where MS Project finishes it on Tuesday.

An SF-linked task may start before the project start (#4218, #4220)
--------------------------------------------------------------------
A task's project-start floor is ``min(project start, SF placement)``, where the SF
placement is where its SF links alone put it. SF is the one link type that can
legitimately require a successor to run *before* its predecessor, and the ordinary
shape (a predecessor on the project's first working day, an SF successor finishing
the day before) is exactly what MS Project schedules — it moves the successor, and
the project's earliest date with it, ahead of the nominal start. Flooring that task
used to discard its SF bound silently: the bound can only pull a finish *later*, so
the task floated to the project start as if it were unlinked.

A task with no SF link has no SF placement and takes the project start. A task
with one is held at or after its SF placement by the SF link itself, so
``min(project start, SF placement)`` never binds it, and the engine leaves the
project-start floor out for every task with an SF link (:func:`_sf_linked`). What
places it is the latest of its links and its hard floors, so a binding FS/SS/FF
lead may put it before the project start too.

#4218 first lifted the floor only for a task whose links were *all* SF. That was
non-monotone (#4220): adding a non-binding FS/SS/FF link moved the task later, to
the project start, and so could a *shorter* SF lag or an upstream change that made
an SF bound earlier, because a non-SF link then became the binding one. With the
floor fixed by the task's link types, every placement is the latest of bounds that
are each monotone in their inputs: a shorter lag never finishes work later, and
adding a link never moves any task later unless that link binds. Adding an SF link
can move its successor *earlier*, because it lifts that task's project-start floor.

The **data date** still floors every task. The project start is a planning
convention the network may overrule; the data date is a fact about time — remaining
work cannot be forecast to happen before "as of now" — and an SF anchor in the past
says the successor is already late, not that it finished. An SNET or a recorded
actual start still binds. Whether MS Project floors a task with mixed SF and FS/SS/FF
links, or a lead, the same way is **unverified** (#4319). :func:`monte_carlo` widens
its working-day index backwards to hold the same placements
(:func:`_mc_pre_start_pad_days`).

Completed tasks are pinned out of network logic (ADR-0136) and keep their recorded
dates. A pinned task with work is ordinary work to its successors; a pinned
zero-duration task stays a milestone, an instant. With no actuals it sits at the
start of its pinned day (#4343). With actuals it sits on its ``actual_finish`` (else
``actual_start``) day, at the edge of that day it had live (#4433): the end only when
work finishing that day placed it, the start when nothing precedes it or a floor
(data date, SNET) held it — so closing a milestone on the day it was forecast moves
none of its successors. ``monte_carlo``
carries each run's milestone instant as a date (:func:`_mc_milestone_bounds`), and
the Rust/WASM engine mirrors the rule (``packages/wasm-scheduler/src/forward.rs``).
"""

from __future__ import annotations

import copy
import math
import weakref
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from typing import Any, NoReturn

import networkx as nx
import numpy as np

from trueppm_scheduler.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    Task,
    _is_finite_real,
    _mask_days_between,
    _validate_calendar_fields,
    _validate_project_fields,
)

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class SchedulerError(ValueError):
    """Common base class for every exception the scheduler engine raises.

    Subclasses :class:`ValueError` so existing ``except ValueError`` callers keep
    working, while giving consumers of the public ``trueppm-scheduler`` package a
    single type to catch (``except SchedulerError``) for any scheduler-originated
    failure. Introduced ahead of the 1.0 public-surface freeze: interposing a
    common base is backward compatible to add now (the concrete exceptions remain
    :class:`ValueError` subclasses) but would be a breaking change to add later.
    """


class CyclicDependencyError(SchedulerError):
    """Raised when the dependency graph contains a cycle.

    The offending cycle is provided so callers can surface it to users
    without parsing a raw networkx exception.
    """

    def __init__(self, cycle: list[str]) -> None:
        self.cycle = cycle
        ids = " → ".join(cycle)
        super().__init__(f"Cyclic dependency detected: {ids}")


class SimulationCapExceeded(SchedulerError):
    """Raised when n_simulations or task count exceeds the configured cap.

    The message is user-facing and suitable for inclusion in an API response
    body without further processing.
    """


class InvalidScheduleInput(SchedulerError):
    """Raised when a project's input is structurally valid but out of range.

    Covers the degenerate inputs that would otherwise drive the day-by-day
    calendar walk into a multi-million-iteration spin and an uncaught
    ``OverflowError`` (a calendar with no working day, an absurd duration or
    lag), plus malformed ``children_map`` cycles. Subclasses :class:`SchedulerError`
    (and thus :class:`ValueError`) so existing ``except ValueError`` callers keep
    working; raised eagerly at the public entry points so a single hostile project
    can never tie up a worker. The message is user-facing.
    """


# ---------------------------------------------------------------------------
# Input bounds
# ---------------------------------------------------------------------------
#
# The CPM engine walks the calendar one day at a time, so every loop's cost is
# linear in the day span it covers. Python's ``date`` ceiling (year 9999) is
# the only thing that bounds an unguarded walk today — a ~2.9M-iteration spin
# that ends in an uncaught ``OverflowError``. These caps reject the pathological
# inputs up front instead. They are deliberately generous (no real project task
# runs for a century) and exported so downstream validators (e.g. the TruePPM
# API) can enforce the *same* limit rather than drift from it.

MAX_DURATION_DAYS = 36_525  # ~100 years — a single task longer than this is degenerate
MAX_LAG_DAYS = 36_525  # ~100 years of lead/lag in either direction
# Largest run of consecutive non-working days to scan before declaring a
# calendar degenerate. A working calendar always has a working day within a
# week; 100 years of uninterrupted holidays means working_days/exceptions are
# broken, not that the project is real.
MAX_CALENDAR_SCAN_DAYS = 366 * 100
# Upper bound on the cumulative project span: the sum of every task's (worst-case)
# duration plus the magnitude of every lag. Per-task/-lag caps alone don't bound
# this — a long dependency chain still accumulates dates one working day at a
# time, so without this an 80+ task max-duration chain would spin
# _build_working_day_index / the forward pass and could walk a date past the
# representable range (an uncaught OverflowError). 1000 years is far beyond any
# real program and keeps every walk bounded regardless of task count.
MAX_PROJECT_SPAN_DAYS = 366 * 1000
# Ceiling on the number of leaf-level edges produced when expanding summary↔summary
# dependencies for cycle detection (#357). A summary→summary edge fans out to the
# full cross product of the two summaries' leaves — len(L(pred)) * len(L(succ))
# tuples — so a single top-of-WBS edge on a 5,000-leaf project can demand 6.25M
# tuples before networkx ever runs, stalling every subsequent dep-create. Typical
# projects never approach this (a 100k ceiling allows e.g. a 300-leaf → 300-leaf
# edge); a graph that exceeds it is pathological or hostile and is rejected with an
# actionable error rather than allowed to spin. The cost is checked from leaf
# *counts* before any cross product is materialised, so the guard itself is cheap.
MAX_EXPANDED_EDGES = 100_000
# Ceiling on the raw dependency-edge count on the project as submitted, before any
# summary expansion (#1203). This is the most fundamental of the edge caps: it is
# the root enabler of every per-edge derived guard — MAX_EXPANDED_EDGES bounds the
# post-expansion cross product and MAX_LAG_DELTA_CELLS bounds the distinct-lag delta
# arrays, but both are only reachable after the engine has already iterated the raw
# edge list at least once (validation, graph build). A caller submitting tens of
# millions of edges makes even those O(E) pre-passes — and the list's own memory —
# pathological. 100k raw edges is generous for any real network (a 5,000-task project
# with a dense-but-sane 20 predecessors each) and is checked from the list length
# before any per-edge work runs, so the guard is O(1). Applies uniformly to schedule()
# and monte_carlo() because both route through _validate_project.
MAX_DEPENDENCIES = 100_000
# Ceiling on the number of calendar exception ranges (#1206). ``is_working_day`` is
# called once per day stepped by every calendar walk, and the old linear ``any()``
# scan over ``exceptions`` made a schedule O(span x E) — a few thousand exceptions on
# a long span tied up a worker for minutes. The lookup is now O(log E) via a cached
# merged-interval bisect, but building that index is still O(E log E), and a real
# calendar has at most a few hundred holidays/closures, so a multi-million-entry list
# is pathological or hostile. Generous (no real calendar approaches it) and bounds the
# one-time index build and its memory.
MAX_CALENDAR_EXCEPTIONS = 100_000
# Ceiling on the Monte Carlo lag-delta precompute: (distinct dependency
# type/lag combinations) x (working-day index span) cells (#1201). The vectorised
# MC forward pass builds one delta array of length ``index_size`` per *distinct*
# ``(dep_type, lag)`` key; this product is the cost the span guard does NOT bound.
# ``MAX_PROJECT_SPAN_DAYS`` caps Σlag and the total span, but an SF dependency with
# zero lag contributes 0 to Σlag while still needing a full delta array, so a wide
# fan-out of such edges slips the span guard entirely. 50M cells is ~400 MB of
# float64 (200 MB now that the arrays are stored as int32, #4129) — generous for
# any real network (a handful of distinct lags over a span of tens of thousands of
# days) and far below the multi-GB blowup a hostile graph would otherwise force.
# Checked incrementally as keys are discovered, before the offending array is
# materialised. This is the *library* default: it protects a batch caller that
# owns the whole machine. A request-scoped embedder (a synchronous web endpoint
# sharing a pod with other requests) should pass a much smaller
# ``max_lag_delta_cells`` to :func:`monte_carlo`.
MAX_LAG_DELTA_CELLS = 50_000_000
# Ceiling on the per-run sprint horizon of the velocity sampler (#1202). The
# bootstrap draw matrix is ``runs x max_sprints`` floats, and ``max_sprints`` scales
# with ``story_points / mean_velocity`` — unbounded by ``MAX_PROJECT_SPAN_DAYS``,
# which only caps ``max_sprints x sprint_length_days``. With ``sprint_length_days=1``
# the span guard permits a ~360k sprint horizon, so a single scrum task could demand
# ``runs x 360k`` floats (multi-GB). 10,000 sprints is ~380 years of fortnightly
# cadence — no real task approaches it — and bounds the matrix to ``runs x 10k``
# regardless of ``sprint_length_days``. A run past this horizon clamps to it (the
# same deep-tail truncation the sampler already documents).
MAX_VELOCITY_SPRINTS = 10_000

# Default ceiling on the number of tasks returned in a Monte Carlo sensitivity
# tornado (ADR-0140). The ranking is "the tasks that move the finish most", so a
# top-N is the point — and it bounds the response payload regardless of project
# size. Callers can override via the ``sensitivity_cap`` parameter of
# :func:`monte_carlo`.
MC_SENSITIVITY_CAP = 20

# Number of runs the sensitivity tornado is computed over (#1525). The full Monte
# Carlo distribution still uses every run for P50/P80/P95; only the duration
# tornado — an O(n · runs · log runs) all-columns rank sort — is capped, at this
# many runs. Spearman rank correlation converges quickly, so a few thousand runs
# fix the top-N ranking to within ~0.02 of the full-run correlation, far tighter
# than the ranking needs. This makes the tornado cost independent of ``runs``.
MC_SENSITIVITY_SUBSAMPLE = 2_000


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DrivingEdge:
    """A dependency whose relationship free float is zero (#2095).

    A *driving* edge is the predecessor→successor link that actually controls the
    successor's early date: the successor's early start/finish sits exactly on the
    date this link imposes, so slipping the predecessor by a single working day
    would push the successor. Non-driving links have slack — the successor would
    start at the same time even if that predecessor finished later.

    Identified by the (predecessor, successor) pair plus ``dep_type`` (the string
    value ``"FS"``/``"SS"``/``"FF"``/``"SF"``), matching the stored dependency row.
    Purely presentational metadata for the schedule view's link hierarchy — the
    forward/backward passes and float values are unaffected.

    A driving edge does **not** imply ``total_float(predecessor) <=
    total_float(successor)`` in general (#4269). The textbook identity needs the
    link to be a fixed working-time offset counted in one unit, and three links
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

    With a zero lag into a work task on the predecessor's calendar the identity
    holds. The scheduler's
    ``test_cpm_invariants.py`` checks exactly that scope and pins both exceptions.
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
    # Dependencies whose relationship free float is zero (#2095). Order is
    # deterministic (sorted) so the two engines' snapshots stay comparable.
    driving_edges: list[DrivingEdge] = field(default_factory=list)

    def __post_init__(self) -> None:
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
    before each. P80 is the conventional commitment date; P50 sits close to the
    deterministic :func:`schedule` finish and carries roughly even odds. When all
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


# ---------------------------------------------------------------------------
# Calendar-aware date arithmetic
# ---------------------------------------------------------------------------


def _safe_offset(d: date, delta: timedelta) -> date:
    """``d + delta``, converting a ``date`` min/max OverflowError into the public type.

    The engine accumulates dates one calendar step (and one lag) at a time; near the
    representable ceiling a raw ``date + timedelta`` raises a bare ``OverflowError``
    that escapes the documented exception contract and crashes the CLI / Celery
    worker (#1207). The eager span/reach guards in :func:`_validate_project` reject
    the realistic cases up front; this is the last-line backstop so no calendar walk
    or lag add can leak an ``OverflowError``.
    """
    try:
        return d + delta
    except OverflowError as err:
        raise InvalidScheduleInput(
            "The schedule span pushed a date past the representable date range; move "
            "the project start date away from that end of the range or reduce "
            "durations/lags."
        ) from err


_MIN_ORDINAL = date.min.toordinal()
_MAX_ORDINAL = date.max.toordinal()


def _safe_fromordinal(ordinal: int) -> date:
    """``date.fromordinal`` with the :func:`_safe_offset` contract.

    Monte Carlo works in integer ordinals and steps a day off them (the day before
    a milestone, an FF/SF anchor plus lag) without going through ``date``
    arithmetic, so a project starting at ``date.min`` reaches ordinal 0 and
    ``date.fromordinal`` raises a bare ``ValueError`` where ``schedule()`` raises
    :class:`InvalidScheduleInput` for the same input (#4265).
    """
    if not _MIN_ORDINAL <= ordinal <= _MAX_ORDINAL:
        raise InvalidScheduleInput(
            "The schedule span pushed a date past the representable date range; move "
            "the project start date away from that end of the range or reduce "
            "durations/lags."
        )
    return date.fromordinal(ordinal)


def _snap_to_working_day(
    d: date, calendar: Calendar, *, forward: bool, max_scan: int = MAX_CALENDAR_SCAN_DAYS
) -> date:
    """Return ``d`` if it is a working day, else the nearest one in ``forward`` direction.

    Why it jumps instead of stepping (#4161): the CPM passes snap once per
    dependency edge, and a single long exception range (a "closed until further
    notice" entry just short of :data:`MAX_CALENDAR_SCAN_DAYS`) made each of those
    snaps a ~36k-day walk — ``schedule()`` was O(edges * range length), minutes of
    synchronous CPU for a few hundred edges. The calendar already holds its
    exceptions as merged, disjoint intervals, so a day inside one is crossed to the
    interval's far edge in a single O(log E) step; only weekday-mask gaps (at most
    six days between exception runs) are still stepped. Each iteration therefore
    leaves at least one whole non-working run behind, and the result is the same
    date the day-by-day walk returned.

    The guards are the day-by-day walk's, restated on the jump: every day skipped
    is non-working, so a landing more than ``max_scan`` days from ``d`` means the
    walk would have exhausted its budget first (:class:`InvalidScheduleInput`), and
    a landing past the representable ``date`` range raises the
    :func:`_safe_offset` overflow error — unless the budget would have run out
    before the walk reached the boundary, exactly the order the walk hit them in.
    """
    step = 1 if forward else -1
    boundary = _MAX_ORDINAL if forward else _MIN_ORDINAL
    mask = calendar.working_days
    origin = o = d.toordinal()
    while True:
        # Works on ordinals so a weekend step costs no ``date`` construction. A day
        # whose weekday is in the mask is non-working only inside an exception, so
        # the interval lookup runs only then. ``(o - 1) % 7`` is the Monday=0
        # weekday (ordinal 1 is a Monday), the numbering ``is_working_day`` reads.
        if (mask >> ((o - 1) % 7)) & 1:
            run = calendar._exception_run(o)
            if run is None:
                return d if o == origin else date.fromordinal(o)
            o = run[1] + 1 if forward else run[0] - 1
        else:
            o += step
        if (o - boundary) * step > 0 and abs(boundary - origin) < max_scan:
            _safe_offset(date.fromordinal(boundary), timedelta(days=step))
        if abs(o - origin) > max_scan:
            raise InvalidScheduleInput(
                f"Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days "
                "of the requested date; check the working_days bitmask and exceptions."
            )


def _next_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the next working day.

    Guarded against a degenerate calendar (no working day, or exceptions
    blanketing the search window): rather than spin to the ``date`` ceiling and
    raise an opaque ``OverflowError``, it bails out with an actionable
    :class:`InvalidScheduleInput` after :data:`MAX_CALENDAR_SCAN_DAYS`.
    """
    if calendar.is_working_day(d):
        return d
    return _snap_to_working_day(d, calendar, forward=True)


def _prev_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the previous working day.

    Guarded symmetrically to :func:`_next_working_day`.
    """
    if calendar.is_working_day(d):
        return d
    return _snap_to_working_day(d, calendar, forward=False)


def _scan_for_working_day(current: date, calendar: Calendar, *, forward: bool) -> date:
    """Step one day from ``current`` (forward/backward) to the next working day.

    Unlike :func:`_next_working_day` / :func:`_prev_working_day` — which return
    ``current`` itself when it is already a working day — this always *advances*
    at least one day, so it is the primitive for walking off a known working day
    to the next one (duration expansion, working-day indexing).

    Guarded with the same :data:`MAX_CALENDAR_SCAN_DAYS` bound as the snap
    helpers: a calendar whose ``exceptions`` blanket the window *after* a valid
    start day (e.g. a single working day followed by a century of holidays) would
    otherwise walk the date past its representable ceiling and raise an opaque
    ``OverflowError`` mid-pass. Bailing here keeps every calendar walk — in both
    :func:`schedule` and :func:`monte_carlo` — bounded and surfacing one
    documented :class:`InvalidScheduleInput` instead.

    The first day off ``current`` counts against the budget, so the snap from
    there gets one day less of it.
    """
    step = timedelta(days=1) if forward else timedelta(days=-1)
    current = _safe_offset(current, step)
    # Fast path: the next day is usually a working day. Duration expansion calls
    # this once per working day of every task, so skipping the snap's setup here
    # is measurable on large projects.
    if calendar.is_working_day(current):
        return current
    return _snap_to_working_day(
        current,
        calendar,
        forward=forward,
        max_scan=MAX_CALENDAR_SCAN_DAYS - 1,
    )


def _finish_from_start(start: date, duration_days: int, calendar: Calendar) -> date:
    """Return the last working day of a task given its start and working-day duration.

    A duration of 1 means the task occupies only the start day.
    A duration of 0 is treated as a milestone: returns the start day unchanged.

    Why the walk begins at ``_next_working_day(start)`` rather than at ``start``
    (#3963): ``duration`` counts **working** days, so the first day of the walk has
    to be one. ``start`` is not guaranteed to be — a recorded ``actual_start`` is
    kept verbatim as the ES floor (ADR-0132 §2 / :func:`_early_start_floors`:
    actuals are truth and are never renegotiated), and the API sets one with no
    user intent at all ("Any → IN_PROGRESS: set actual_start = today"), so a
    contributor moving a card on a Saturday arms it. Counting that Saturday as
    work-day 1 spent one working day of the duration on a day the calendar says
    nobody works: the task finished a working day early, and because the backward
    pass lays the same duration back from a working-day LF, ``late_start`` landed
    *before* ``early_start`` and the inverted span was then clamped to zero float.

    Two separate quantities were being conflated. *When work began* is the recorded
    date and is kept; *how many working days of effort it takes* is the duration
    and is now laid out on working days only. Both engines take this rule
    (``wasm-scheduler/src/calendar.rs::finish_from_start``), and it is the rule
    ``monte_carlo``'s :func:`_mc_es_floors` already applied, which is why the two
    passes disagreed on a fully deterministic project.

    A duration of 0 is not a walk: a milestone keeps its verbatim date, so a
    completed milestone stays pinned exactly where it was recorded.
    """
    if duration_days <= 0:
        return start
    remaining = duration_days - 1
    current = _next_working_day(start, calendar)
    while remaining > 0:
        current = _scan_for_working_day(current, calendar, forward=True)
        remaining -= 1
    return current


def _start_from_finish(finish: date, duration_days: int, calendar: Calendar) -> date:
    """Return the first working day of a task given its finish and working-day duration.

    Inverse of :func:`_finish_from_start`, and snapped the same way for the same
    reason (#3963): the walk begins at ``_prev_working_day(finish)`` because the
    duration it lays out counts working days only. ``finish`` can be a non-working
    day — a completed task's ``actual_finish`` is recorded verbatim (ADR-0136,
    "actuals are truth") and drives this back-off in :func:`_pinned_placement` —
    and counting it as the last work day gave the task one working day fewer than
    its duration, the mirror image of the forward defect. Keeping the two helpers
    snapped symmetrically is what makes them inverses on every input rather than
    only on working-day ones.

    A duration of 0 returns ``finish`` unchanged, for the milestone reason in
    :func:`_finish_from_start`.
    """
    if duration_days <= 0:
        return finish
    remaining = duration_days - 1
    current = _prev_working_day(finish, calendar)
    while remaining > 0:
        current = _scan_for_working_day(current, calendar, forward=False)
        remaining -= 1
    return current


def _effective_duration_days(task: Task) -> int:
    """Working-day duration of the *remaining* work on a task (ADR-0132).

    A task that has not started (``percent_complete == 0``) contributes its full
    estimate. An in-progress task contributes only the portion not yet done:
    ``duration - floor(duration * pct/100)``, clamped to ``[0, duration]``. The
    elapsed portion uses integer truncation so the rule is unambiguous and
    reproducible across the Python and Rust engines (the conformance contract).
    A completed task (see :func:`_is_complete`) is laid out at its full duration by
    the caller and never routed through this function.
    """
    duration_days = task.duration.days
    pct = task.percent_complete
    if not pct or pct <= 0:
        return duration_days
    elapsed = int(duration_days * min(pct, 100.0) / 100.0)
    return max(0, duration_days - elapsed)


def _is_complete(task: Task) -> bool:
    """Whether a task counts as finished for layout purposes (ADR-0136).

    True when an ``actual_finish`` is recorded *or* ``percent_complete`` has reached
    100. The scheduler dataclass has no ``status`` field, so completion is read from
    these two facts alone (the API normally keeps them aligned — a 100% task is
    promoted to REVIEW/COMPLETE — but the engine does not rely on that). A completed
    task is laid out at its *full* duration, never through
    :func:`_effective_duration_days` — otherwise a 100% task would have zero
    remaining work and collapse to a single day (ADR-0136).
    """
    return task.actual_finish is not None or (task.percent_complete or 0) >= 100


def _working_days_between(start: date, end: date, calendar: Calendar) -> int:
    """Count working days in [start, end) — start inclusive, end exclusive.

    Used to compute total float: working_days_between(early_start, late_start).
    Returns 0 when end <= start.

    Counted arithmetically rather than day by day (#4161): mask days in the span,
    minus mask days inside each exception run that overlaps it. It is the fallback
    for every span :class:`_WorkingDayCounter` does not cover, and a free-float
    slack measured across a century-long exception lands outside that range once
    per edge — so a day loop here was the same O(edges * range length) cost the
    snap helpers had. The subtraction is now :meth:`Calendar._exception_mask_days`,
    which is O(log E) via a prefix sum over the calendar's mask-off-gap-coalesced
    runs (#4176) rather than O(overlapping runs) — a span crossing a "closed until
    further notice" period written as thousands of weekly ranges used to walk one
    run per week; it now walks the handful of runs that are genuinely disjoint
    once weekend-only gaps are folded in.
    """
    if end <= start:
        return 0
    lo = start.toordinal()
    hi = end.toordinal()
    mask = calendar.working_days
    count = _mask_days_between(lo, hi, mask)
    if calendar.exceptions:
        count -= calendar._exception_mask_days(lo, hi)
    return count


class _WorkingDayCounter:
    """O(log n) working-day span counts over a schedule's fixed date range (#822).

    :func:`_working_days_between` is an O(span) day loop, and ``_compute_floats``
    calls it twice per successor link, so float computation was O(tasks · span).
    This precomputes the sorted ordinals of every working day in
    ``[lo, hi]`` once per :func:`schedule` call (the CPM counterpart to
    monte_carlo's :func:`_build_working_day_index`); :meth:`between` then counts a
    span with two binary searches.

    ``between(start, end)`` reproduces :func:`_working_days_between` *exactly* —
    working days in ``[start, end)`` — as
    ``searchsorted(end) - searchsorted(start)`` (the array holds exactly the
    working days, so ``side="left"`` on ``end`` excludes it and on ``start``
    includes it). The scalar function remains the conformance reference; a span
    that falls outside the built range falls back to it, so a miscovered range can
    never silently miscount.
    """

    def __init__(self, ordinals: np.ndarray, lo: date, hi: date, calendar: Calendar) -> None:
        self._ords = ordinals
        self._lo_ord = lo.toordinal()
        self._hi_ord = hi.toordinal()
        self._calendar = calendar

    @classmethod
    def build(cls, lo: date, hi: date, calendar: Calendar) -> _WorkingDayCounter:
        """Build a counter covering working days in the inclusive range ``[lo, hi]``."""
        ords: list[int] = []
        if hi >= lo:
            current = lo
            while current <= hi:
                if calendar.is_working_day(current):
                    ords.append(current.toordinal())
                current += timedelta(days=1)
        return cls(np.fromiter(ords, dtype=np.int64, count=len(ords)), lo, hi, calendar)

    def between(self, start: date, end: date) -> int:
        if end <= start:
            return 0
        s_ord = start.toordinal()
        e_ord = end.toordinal()
        # ``[start, end)`` counts working days up to ``end - 1``; valid only when
        # the whole span lies inside the built range. Otherwise fall back to the
        # scalar reference (defensive — callers stay within the schedule span).
        if s_ord < self._lo_ord or e_ord - 1 > self._hi_ord:
            return _working_days_between(start, end, self._calendar)
        lo = int(np.searchsorted(self._ords, s_ord, side="left"))
        hi = int(np.searchsorted(self._ords, e_ord, side="left"))
        return hi - lo


def _advance_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Advance d by lag calendar days and snap to the next working day."""
    return _next_working_day(_safe_offset(d, lag), calendar)


def _retreat_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Retreat d by lag calendar days and snap to the previous working day."""
    return _prev_working_day(_safe_offset(d, -lag), calendar)


# ---------------------------------------------------------------------------
# Zero-duration milestones as instants (#4079) — see the module docstring
# ---------------------------------------------------------------------------

_ONE_DAY = timedelta(days=1)

_START_ANCHORED = (DependencyType.FS, DependencyType.SS)
"""Dependency types whose successor constraint bounds the successor's *start*."""

_Instant = tuple[date, bool]
"""A milestone's position: ``(instant, start_display)``.

``instant`` is the midnight the milestone sits on — the end of one day is the
start of the next — and is the only thing links measure from. ``start_display``
only chooses how it is shown: at the start of the instant's own day (a milestone
held by a floor or an SS link from work) or at the end of the previous working
day (a milestone that follows work, when that day is a working day — see
:func:`_start_reading`).
"""


def _edge_anchor(
    dep_type: DependencyType,
    start: date,
    finish: date,
    instant: date | None,
    pred_cal: Calendar,
    lag: timedelta = timedelta(0),
) -> date:
    """The raw date a predecessor's constraint on its successor is measured from.

    Every forward constraint is ``_next_working_day(anchor + lag)`` on the
    successor's calendar; only the anchor depends on the dependency type and on
    whether the predecessor is a milestone. For ordinary work (``instant`` is
    ``None``) FS measures from the day after the inclusive finish, SS from the
    start, FF from the finish, and SF from the last working day *before* the start
    (from ``start - 1`` with a positive lag, #4333). Callers pass the start an SS/SF
    link measures from (:func:`_link_start`): a started task's recorded
    ``actual_start``, never its data-date-floored remaining window (#4523).

    A milestone is one instant, so its start and its finish are the same point:
    FS and SS measure from the instant itself, SF from the last working day
    before it (from ``instant - 1`` with a positive lag). This is what lets a
    milestone sit on its driving predecessor's finish without delaying anything
    behind it.

    FF out of a milestone (#4273) is a finish link measured from the instant
    itself, the same point FS measures from. With no lag there is no date to snap,
    so the successor only has to reach the instant in working time — the last
    working day before it. A positive lag counts forward from the day the instant
    closes, ``instant - 1``, which is a non-working day when the instant opens a
    working day after a weekend, and the result snaps forward like any lagged FF
    (#2534). Anchoring a positive lag on the last working day as well (the
    pre-#4273 rule) let a weekend absorb it: ``M`` at the start of Monday
    ``-FF+2d->`` finished its successor on Monday, where the same lag from ``M``'s
    instant reaches Tuesday.

    A lead counts back from the zero-lag anchor, the last working day before the
    instant, so the successor's finish is monotone in the lag: ``M`` at the start
    of Monday ``-FF-1d->`` finishes it Thursday, a day before zero lag's Friday.
    Counting a lead from ``instant - 1`` instead put a weekend between the lead and
    the working day it should reach — ``-1d`` landed on Saturday and snapped
    forward to Monday, *later* than zero lag. Links *into* a milestone do not come
    through here (:func:`_milestone_proposal`).

    SF (#4145) is the finish-anchored rule applied to the predecessor's *start*
    instant, which is why the two branches agree: MS Project and P6 finish an SF
    successor at the start of its predecessor's start day, so its last working day
    is the day before — exactly where a zero-duration milestone standing at that
    same midnight puts it. Anchoring on the start day itself (the pre-#4145
    behavior) scheduled the successor one working day later than either.

    That makes SF the FF-out-of-a-milestone rule above, whether the predecessor is
    work or a milestone, and it takes the same positive-lag branch (#4333): a lag
    counts forward from the day the start instant closes, ``start - 1``, not from
    the last working day before it. A predecessor starting on Monday anchors on
    Sunday, so ``-SF+2d->`` finishes its successor on Tuesday, as MS Project does;
    pre-snapping to Friday (the pre-#4333 rule) put the lag on Sunday, snapped it
    forward to Monday, and let the weekend absorb it. Zero lag and leads keep the
    last working day before the start, so the finish stays monotone in the lag.
    """
    if instant is None:
        if dep_type == DependencyType.FS:
            return _safe_offset(finish, _ONE_DAY)
        if dep_type == DependencyType.FF:
            return finish
        if dep_type == DependencyType.SS:
            return start
        # SF: the predecessor's start instant is the midnight its start day opens
        # on, so fall through to the finish-anchored rule below with that instant.
        instant = start
    if dep_type in _START_ANCHORED:
        return instant
    if lag > timedelta(0):
        # FF out of a milestone, or SF from anything (#4273, #4333).
        return _safe_offset(instant, -_ONE_DAY)
    return _prev_working_day(_safe_offset(instant, -_ONE_DAY), pred_cal)


def _start_is_recorded(task: Task) -> bool:
    """Whether ``task`` is live work whose start is a recorded fact (#4523).

    True for a task with work that is not complete and carries an
    ``actual_start``. Its ``early_start`` is the start of its *remaining* work
    (ADR-0132), floored at the data date and at its other floors, so it moves with
    every status update; the start itself happened on ``actual_start`` and does
    not. A completed task is pinned at its actuals already (ADR-0136) and a
    milestone is placed as an instant, so neither needs the distinction.
    """
    return task.actual_start is not None and task.duration.days > 0 and not _is_complete(task)


def _elapsed_link_days(task: Task) -> int:
    """Working days of ``task``'s span before its remaining-work window (#4523).

    Non-zero only for live work with progress and no recorded ``actual_start``
    (:func:`_start_is_recorded` covers the recorded case): its span start
    (``scheduled_start``, ADR-0752) is the full duration backed off from
    ``early_finish``, which is exactly this many working days before
    ``early_start``. Zero for everything else, where the span start *is* the early
    start.
    """
    if task.actual_start is not None or task.duration.days <= 0 or _is_complete(task):
        return 0
    return task.duration.days - _effective_duration_days(task)


def _link_start(task: Task) -> date:
    """The start an SS or SF link out of ``task`` measures from (ADR-0132 §2a, #4523).

    The task's span start, never its remaining-work window: the recorded
    ``actual_start`` of a started task (:func:`_start_is_recorded`); for live work
    with progress but no recorded start, its derived span start
    ``scheduled_start`` (:func:`_elapsed_link_days`); otherwise ``early_start``,
    which is the span start. Measuring from the remaining-work window instead
    re-added the link's lag from the data date on every status update: ``A``
    started 03-02 ``-SS+10d-> B`` put ``B`` on 03-16 at a 03-04 data date and two
    days later at a 03-06 one, with nothing else changed. ``early_start`` is never
    before either span start for a live task, so they agree whenever nothing but
    the start holds the task.

    ``scheduled_start`` is read off the task, so this is only called after the
    forward pass resolved it (:func:`_compute_scheduled_start`), as every caller
    does.
    """
    assert task.early_start is not None
    if _start_is_recorded(task):
        assert task.actual_start is not None
        return task.actual_start
    if _elapsed_link_days(task) > 0:
        assert task.scheduled_start is not None
        return task.scheduled_start
    return task.early_start


def _start_fixed_link(task: Task, dep: Dependency) -> bool:
    """Whether ``dep`` out of ``task`` measures from a recorded start (#4523).

    Such a link cannot be moved by ``task``'s remaining work slipping, so it
    imposes no late-date bound on ``task`` and gives it no free-float limit; it is
    still the driving edge of a successor it holds. A link measured from a
    *derived* span start (:func:`_elapsed_link_days`) is not one: that start is
    backed off from the forecast finish and slips with the remaining work, so it
    keeps its bound (:func:`_window_start_bound`).
    """
    return dep.dep_type in (DependencyType.SS, DependencyType.SF) and _start_is_recorded(task)


def _window_start_bound(span_bound: date, task: Task, cal: Calendar) -> date:
    """The latest ``early_start`` that keeps ``task``'s link start at or before ``span_bound``.

    The backward inverse of :func:`_link_start` for a derived span start (#4523):
    the span start sits :func:`_elapsed_link_days` working days before the
    remaining-work window, so a bound on the one is that many working days later
    on the other. ``span_bound`` is always a working day on ``cal`` (every backward
    bound is snapped), and on working days the two helpers are inverses. The
    identity when nothing has elapsed.
    """
    elapsed = _elapsed_link_days(task)
    if elapsed <= 0:
        return span_bound
    return _finish_from_start(span_bound, elapsed + 1, cal)


def _milestone_link(dep: Dependency) -> Dependency:
    """``dep`` as a zero-duration successor sees it: FF is FS (#4272, #4273).

    A milestone's start and finish are one instant, so a link that bounds its
    finish and one that bounds its start bound the same point. FF and FS also
    anchor on the same point of the predecessor — its finish instant, or a
    milestone predecessor's own instant (:func:`_edge_anchor`) — so into a
    milestone they are the same link, and every pass treats them as one. SF keeps
    its own anchor (the close of the working day before the predecessor's start).
    """
    if dep.dep_type == DependencyType.FF:
        return replace(dep, dep_type=DependencyType.FS)
    return dep


def _milestone_proposal(
    dep_type: DependencyType,
    lag: timedelta,
    start: date,
    finish: date,
    pred_instant: _Instant | None,
    pred_cal: Calendar,
    cal: Calendar,
) -> _Instant:
    """The ``(instant, start_display)`` one incoming link proposes to a milestone.

    The proposal is the link's anchor *instant* plus the lag, never snapped: a
    milestone occupies no working day, so there is nothing for a lag to land on
    but the instant itself (#4272). FS/SS — and FF, which into a milestone is FS
    (:func:`_milestone_link`) — propose ``anchor + lag``; SF proposes the midnight
    closing its anchor day, plus the lag. This is what makes ``A -FF+1d-> M`` and
    ``A -FS+1d-> M`` land ``M`` on the same instant. Before #4272 an FF/SF link
    proposed the end of the first working day on or after ``anchor + lag``, as if
    the milestone had a finish day to snap, so a lag across a weekend put ``M`` a
    working day after its FS equivalent and moved everything behind it.

    The reading is the FS/SS-from-work one — end of day, start of day after SS —
    except at zero lag out of a milestone, where the proposal is the very midnight
    the predecessor occupies and carries its reading over (#4079); an instant just
    after non-working time always reads as start of day (:func:`_start_reading`,
    #4173). ``cal`` is the milestone's own calendar.
    """
    if dep_type == DependencyType.FF:
        dep_type = DependencyType.FS  # one link into a milestone (_milestone_link)
    instant = None if pred_instant is None else pred_instant[0]
    anchor = _edge_anchor(dep_type, start, finish, instant, pred_cal, lag)
    if dep_type == DependencyType.SF:
        # The close of the anchor day: the working day before the start, or with a
        # positive lag the day the start instant closes, so the proposal is the
        # start instant plus the lag (#4333).
        raw = _safe_offset(_safe_offset(anchor, _ONE_DAY), lag)
        return raw, _start_reading(raw, False, cal)
    raw = _safe_offset(anchor, lag)
    if pred_instant is not None and lag == timedelta(0):
        # Same midnight as the predecessor milestone (#4079): its own reading
        # carries over verbatim.
        base_display = pred_instant[1]
    else:
        # Ordinary work, or a milestone predecessor reached through a nonzero lag:
        # a different midnight than the predecessor's own instant, so its reading
        # is computed fresh rather than inherited (#4079 fuzz regression) —
        # inheriting it would let a display quirk of the predecessor's instant
        # (the Sunday/Monday snap, #4173) leak into an instant it has nothing to
        # do with.
        base_display = dep_type == DependencyType.SS
    return raw, _start_reading(raw, base_display, cal)


def _instant_day(instant: date, start_display: bool, cal: Calendar) -> date:
    """The day an instant is shown on.

    A start-of-day reading is shown on the first working day at or after the
    instant (the start of Monday for Saturday midnight); an end-of-day reading on
    the last working day before it (the end of Friday).
    """
    if start_display:
        return _next_working_day(instant, cal)
    return _prev_working_day(_safe_offset(instant, -_ONE_DAY), cal)


def _start_reading(instant: date, start_display: bool, cal: Calendar) -> bool:
    """Whether an instant proposed by a start-anchored link reads as a day start.

    An end-of-day reading names the end of the working day before the instant,
    which only exists when that day *is* a working day. A lag that lands the
    instant just after non-working time (Sunday or Monday midnight, after a
    weekend) sits in non-working time, and it is shown the way MS Project snaps an
    elapsed lag there: at the start of the next working day (#4173).

    This is what keeps the shown day monotone in the instant. Sunday and Monday
    midnight are the same working-time position; read at the end of the previous
    working day, the later midnight was shown on Friday while the earlier one, read
    at the start of the next, was shown on Monday — so a *longer* predecessor moved
    a milestone, and with it ``project_finish``, a working day *earlier*, and
    Monte Carlo reported P50 before the deterministic finish.
    """
    return start_display or not cal.is_working_day(_safe_offset(instant, -_ONE_DAY))


def _milestone_refs(instant: date) -> tuple[date, date]:
    """``(start_ref, finish_ref)`` a milestone successor offers its predecessors.

    The backward pass and free float invert each forward constraint as
    ``anchor + lag <= ref``, against a successor's start for FS/SS links and its
    inclusive finish for SF ones (FF into a milestone is FS, :func:`_milestone_link`).
    A link into a milestone proposes the raw instant ``anchor + lag`` (FS/SS) or
    ``anchor + 1 + lag`` (SF, whose anchor is an inclusive day), so the references
    are the instant itself and the day it closes — *unsnapped*, because the
    proposal is never snapped either (#4272). Snapping the finish reference back to
    a working day inverted the pre-#4272 rule, which snapped the proposal forward.
    """
    return instant, _safe_offset(instant, -_ONE_DAY)


def _milestone_free_instants(
    topo_order: list[str],
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    instants: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, date]:
    """The latest instant each milestone may reach without moving anything (#4180).

    Free float asks how far a predecessor can slip before a successor moves, and a
    milestone's early position is its shown day plus its reading, not the raw
    instant. A start-of-day reading is shown on ``next_wd(instant)``, and every
    midnight from the instant up to that one lies in the same stretch of
    non-working time, with the same shown day and reading. So
    ``A(4d) -FS+2d-> M`` (Sunday midnight, shown Monday) lets ``A`` slip one day to
    Monday midnight without moving ``M``: one day of free float, not zero.

    An end-of-day reading stays at the raw instant: ``A -FS+1d-> M`` puts ``M`` at
    Saturday midnight shown Friday, and the next midnight is shown Monday (#4173).
    This is the free-float twin of :func:`_milestone_finish_bound`.

    The raw instant is still what the milestone's own links measure from, and a
    calendar-day lag carries it downstream (``M -FS+1d-> N`` proposes Monday
    midnight from Sunday, Tuesday midnight from Monday). So the stretch is also
    capped by every live successor link, inverted with :func:`_milestone_latest`
    against that successor's early references — its own free instant when it is
    a milestone, which is why this runs in reverse topological order. Moving the
    instant anywhere up to the result moves nothing downstream.

    A milestone held up by the project-start floor alone (#4225) is shown at the
    floor but measured from by its successors at its earlier link instant
    (``link_instants``, :func:`_place_milestone`). Its stretch runs from that link
    instant — the one a predecessor's slip moves — up to the same shown-day bound
    and successor caps, so its predecessors see the slack the direct link gives them.

    A successor that is itself a milestone is reached through the same reading-tie
    bound :func:`_free_float_days` applies to ordinary work (:func:`_free_start_ref`,
    #4183) — not just :func:`_milestone_latest` against its raw free instant
    (#4329). Without it, this bound can overstate how far *this* milestone's own
    instant may travel: pushing it up to that successor's raw free instant can flip
    the successor's reading from the end-of-day instant another, unrelated,
    predecessor already occupies to a start-of-day one at the very same raw
    instant — and a start-of-day proposal always outranks an end-of-day one at a
    tie (:func:`_place_milestone`), so the successor's *shown day* moves even
    though its raw free instant, taken alone, did not. Capping at the tie-adjusted
    reference keeps this milestone's own stretch inside the range that leaves every
    live successor's shown position — not just its raw instant — untouched.
    """
    links = link_instants or {}
    free: dict[str, date] = {}
    for node_id in reversed(topo_order):
        early = instants.get(node_id)
        if early is None:
            continue
        instant, start_display = early
        own_link = links.get(node_id, early)
        link = own_link[0]
        cal = cal_for(node_id)
        if not start_display:
            free[node_id] = instant
            continue
        bound = _next_working_day(instant, cal)
        for succ_id in g.successors(node_id):
            succ = task_map[succ_id]
            if _is_complete(succ):
                continue
            dep: Dependency = g[node_id][succ_id]["dep"]
            succ_free = free.get(succ_id)
            if succ_free is None:
                assert succ.early_start is not None and succ.early_finish is not None
                # The same working-day snap _free_float_days reads a work successor
                # at (#4332): a live task's verbatim non-working actual_start is the
                # working-time position of the next working day, so capping from the
                # raw date ends this milestone's stretch early (#4345).
                refs = (_next_working_day(succ.early_start, cal_for(succ_id)), succ.early_finish)
            else:
                dep = _milestone_link(dep)
                succ_cal = cal_for(succ_id)
                raw_refs = _milestone_refs(succ_free)
                succ_instant = instants.get(succ_id)
                assert succ_instant is not None
                start_ref = _free_start_ref(
                    (succ_free, succ_instant[1]), dep.dep_type, dep.lag, own_link, succ_cal
                )
                refs = (start_ref, raw_refs[1])
            bound = min(bound, _milestone_latest(dep.dep_type, dep.lag, *refs, cal))
        free[node_id] = max(link, bound)
    return free


def _milestone_latest(
    dep_type: DependencyType,
    lag: timedelta,
    start_ref: date,
    finish_ref: date,
    node_cal: Calendar,
) -> date:
    """Latest instant a milestone may sit on and still honor one successor link.

    The inverse of :func:`_edge_anchor` for a milestone predecessor: the largest
    instant ``X`` whose forward bound does not pass the successor's reference. A
    start-anchored link measures from ``X`` itself; a finish-anchored one from
    ``prev_wd(X - 1)``, which stays at or before ``W`` for every ``X`` up to the
    first working day after ``W``.

    An FF or SF with a positive lag measures from ``X - 1`` itself (#4273, #4333),
    so its inverse is the raw ``W + 1 - lag``; a lead measures from
    ``prev_wd(X - 1)`` like zero lag and inverts through the finish-anchored
    branch. FF reaches this only from a successor with work: into a milestone it is
    FS (:func:`_milestone_link`), and the caller converts it.
    """
    if dep_type in _START_ANCHORED:
        return _safe_offset(start_ref, -lag)
    if lag > timedelta(0):
        return _safe_offset(finish_ref, _ONE_DAY - lag)
    last = _prev_working_day(_safe_offset(finish_ref, -lag), node_cal)
    return _scan_for_working_day(last, node_cal, forward=True)


def _sf_latest_start(succ_finish: date, lag: timedelta, node_cal: Calendar) -> date:
    """Latest start day an ordinary task may take without moving an SF successor's finish.

    The inverse of :func:`_edge_anchor`'s SF anchor for ordinary work (#4145). The
    forward bound is measured from ``prev_wd(start - 1)``, so inverting
    ``next_wd(anchor + lag) <= W`` gives the largest allowed anchor
    ``A = prev_wd(W - lag)`` — and the largest *start day* whose anchor is still at
    or before ``A`` is the first working day after ``A``, since any later start day
    would drag the anchor past it.

    This is deliberately the same expression as :func:`_milestone_latest`'s
    finish-anchored branch: a start instant and a milestone instant invert
    identically, which is the consistency #4145 restored.

    A positive lag measures from ``start - 1`` itself (#4333), so the forward bound
    is ``next_wd(start - 1 + lag) <= W``, which holds exactly when
    ``start <= W + 1 - lag``; the latest start is the last working day at or
    before that — :func:`_milestone_latest`'s positive-lag branch, snapped to a day
    this task can start on.
    """
    if lag > timedelta(0):
        return _prev_working_day(_safe_offset(succ_finish, _ONE_DAY - lag), node_cal)
    last = _prev_working_day(_safe_offset(succ_finish, -lag), node_cal)
    return _scan_for_working_day(last, node_cal, forward=True)


def _milestone_finish_bound(finish_instant: date, project_finish: date, node_cal: Calendar) -> date:
    """Latest instant the project-finish seed admits for a milestone (#4174).

    When the finish instant already reads as start of day — ``project_finish`` is
    on or after it, e.g. ``A(4d) -FS+2d-> M`` placing ``M`` at Sunday midnight,
    shown Monday — every midnight up to the one that opens the next working day
    shows the same finish, so a milestone at any of them does not move it. Seeding
    at the raw instant told that milestone Monday midnight was a slip, which gave
    ``A`` zero float and put it on the critical path.

    When the instant reads as end of day instead (``project_finish`` before it —
    ``A -FS+1d-> M`` at Saturday midnight, shown Friday), the raw instant is the
    bound: under #4173's display rule Sunday midnight is shown Monday, so landing
    there *does* move the finish and the predecessor has no float to give.

    The shown day stays capped at ``project_finish`` by :func:`_late_display`.
    """
    if project_finish >= finish_instant:
        return _next_working_day(finish_instant, node_cal)
    return finish_instant


def _start_read_cap(
    instant: date, start_display: bool, cal: Calendar, project_finish: date
) -> date:
    """Latest instant up to ``instant`` that a given reading shows by ``project_finish`` (#4183).

    A milestone's late instant is the latest midnight its successors and the
    finish seed admit, but the day it is *shown* on also depends on its reading
    (:func:`_start_reading`). When the project ends at the end of a day (``W``
    finishing Friday: finish instant Saturday midnight, ``project_finish``
    Friday), a milestone at Saturday midnight read as end of day is shown Friday,
    but read as start of day it is shown Monday and moves ``project_finish``. So a
    start-of-day reading is capped at the last working day ``D`` on or before
    ``project_finish``, the latest midnight it still shows by then. With a
    start-of-day finish (``project_finish`` on or after the instant, #4174) the
    cap never binds.

    An end-of-day reading reaches the cap too, when the instant sits just after
    non-working time and so reads as a day start (:func:`_start_reading`) — e.g.
    ``project_finish`` a Sunday (a weekend ``actual_finish``) and the instant the
    Monday midnight after it. Its latest admissible instant is ``D + 1``, the
    midnight that *closes* ``D``: ``D`` is a working day, so that midnight reads as
    end of day and is shown on ``D``. Capping it at ``D`` cost every FS/SS
    predecessor, and the milestone's own float, one working day, and reported a
    task with one day of float as critical (#4344). A start-of-day reading keeps
    ``D``: at ``D + 1`` it is shown on the next working day, past the finish.
    """
    if not _start_reading(instant, start_display, cal):
        return instant
    if _next_working_day(instant, cal) <= project_finish:
        return instant
    last_day = _prev_working_day(project_finish, cal)
    if start_display:
        return last_day
    # Here ``instant > last_day + 1``: at ``last_day + 1`` the end-of-day reading
    # holds (``last_day`` works), so the first branch would have returned.
    return _safe_offset(last_day, _ONE_DAY)


def _link_start_ref(
    start_ref: date,
    dep_type: DependencyType,
    lag: timedelta,
    pred_is_milestone: bool,
    succ_cal: Calendar,
    project_finish: date,
) -> date:
    """The milestone ``start_ref`` one FS/SS link into it may use (#4183).

    The reading is the one this link would give the milestone
    (:func:`_place_milestone`): start of day after SS from work, end of day after
    FS from work. Measured against the raw late instant, ``X(2d) -SS+3-> M`` beside
    ``W(5d)`` reported two days of float when a two-day slip lands ``M`` on Saturday
    midnight, shown Monday.

    The cap is per link, not on the milestone's late instant itself: an FS
    predecessor of the same milestone really can slip it to Saturday midnight, where
    it is shown Friday, so capping the shared instant would understate its float.

    A zero-lag link from a milestone carries that milestone's reading over, and the
    backward pass computes each milestone's late instant for the end-of-day reading
    (the uncapped one). The start-of-day bound follows from it by the same cap —
    the cap is a ``min``, so it commutes with the ``min`` over successor links — and
    is applied where it is read: :func:`_float_late_instant` for the milestone's own
    float, and this function for an SS or work predecessor reaching it.
    """
    if dep_type not in _START_ANCHORED:
        return start_ref
    inherits = pred_is_milestone and lag == timedelta(0)
    base_display = dep_type == DependencyType.SS and not inherits
    return _start_read_cap(start_ref, base_display, succ_cal, project_finish)


def _link_finish_ref(
    late: date, dep_type: DependencyType, succ_cal: Calendar, project_finish: date
) -> date:
    """The milestone ``finish_ref`` one SF link into it may use (#4431).

    The SF twin of :func:`_link_start_ref`. An SF proposal into a milestone is read
    like FS from work — end of day, or start of day just after non-working time
    (:func:`_milestone_proposal`) — so the latest instant it may propose is
    :func:`_start_read_cap` of the late instant for the end-of-day reading, and the
    reference is the day *that* instant closes (:func:`_milestone_refs`). Inverting
    against the uncapped instant gave an SF predecessor one working day of float
    that, used, showed the milestone past ``project_finish``. Every other type
    inverts against the start reference, so its finish reference is left raw.
    """
    if dep_type != DependencyType.SF:
        return _milestone_refs(late)[1]
    return _milestone_refs(_start_read_cap(late, False, succ_cal, project_finish))[1]


def _float_late_instant(late: date, early: _Instant, cal: Calendar, project_finish: date) -> date:
    """The late instant a milestone's *own* total float is measured to (#4183).

    This *defines* a milestone's own total float: slipping the milestone keeps the
    reading that places it early, so its float stops where that reading would show
    it past ``project_finish`` — the same cap :func:`_link_start_ref` applies to a
    predecessor reaching it with that reading. Predecessors still read the uncapped
    instant (:func:`_late_refs`).

    Why this definition: in the tie case (a start-of-day milestone whose late
    instant is an end-of-day finish instant) it makes ``total_float`` the
    working-day span between the milestone's shown ``early_start`` and its shown
    ``late_start``, the rule the scheduler conventions page states for every task.
    :func:`_late_display` already capped the *shown* late start at
    ``project_finish``; measuring float to the raw instant reported ``M`` with
    early start 01-08, late start 01-09 and total float 2 in the #4183 repro. It is
    **not** needed for insertion invariance: ``A -FS-> M -FS-> B`` scheduling as
    ``A -FS-> B`` asserts nothing about ``M``'s own float and holds either way.

    It is a semantic choice with collateral effects beyond the reported tie: a
    lone start-of-day milestone held by a floor, or one reached by ``X -SF-> M``,
    also reports one day less float when its late instant is the end-of-day finish
    instant, and can now be ``is_critical`` / on ``critical_path`` where it was not.

    It is also **not** a general "float == shown-day span" invariant. The cap only
    reaches a late instant past the last working day of ``project_finish``, i.e.
    the window near the *finish* instant. Elsewhere a milestone can still report a
    float that differs from the span between its shown days: the remaining cases
    seen are a start-of-day milestone whose late instant is a Saturday or Sunday
    midnight before the finish, shown late on the Friday before it while its float
    runs through that Friday. A derandomized sample of 1,500 fuzzed networks during
    review found 43 such milestones left, down from 643 before this change.
    """
    return max(_start_read_cap(late, early[1], cal, project_finish), early[0])


def _free_start_ref(
    succ_early: _Instant,
    dep_type: DependencyType,
    lag: timedelta,
    own: _Instant | None,
    succ_cal: Calendar,
) -> date:
    """The start reference an FS/SS link's free float may run to in a milestone (#4183).

    The free-float face of the same midnight tie. An end-of-day milestone at
    instant ``I`` (``A -FS-> M``, shown the end of Friday for Saturday midnight)
    changes its shown day without its instant moving when a start-of-day proposal
    reaches ``I``: two proposals at one midnight resolve to the start-of-day
    reading (:func:`_place_milestone`), so ``M`` flips to the start of Monday. Its
    ``early_start`` moves, and so does the reading any zero-lag milestone after it
    inherits. Inverting such a link against ``I`` itself counted that flip as free.

    So when this link would read ``I`` as start of day, computed exactly as
    :func:`_place_milestone` reads it (SS from work, a lagged SS from a milestone,
    or a zero-lag link carrying a start-of-day predecessor milestone's reading),
    the latest proposal that leaves ``M`` alone is one day before ``I``. An FS link
    from work, or any link into a milestone already read as start of day, keeps
    ``I``: a tie there changes nothing. The slipping predecessor milestone keeps
    its early reading, as :func:`_float_late_instant` assumes for total float.
    """
    instant, start_display = succ_early
    if start_display or dep_type not in _START_ANCHORED:
        return instant
    if own is not None and lag == timedelta(0):
        base_display = own[1]
    else:
        base_display = dep_type == DependencyType.SS
    if not _start_reading(instant, base_display, succ_cal):
        return instant
    return _safe_offset(instant, -_ONE_DAY)


def _late_display(
    late_instant: date, task: Task, early: _Instant, cal: Calendar, project_finish: date
) -> date:
    """The day a milestone's late instant is shown on.

    A late instant at the same working-time position as the early one is zero
    float and is shown on the early day — this also keeps a milestone floored at a
    non-working actual (a Saturday ``actual_start``) a single point. Otherwise the
    milestone is shown the way it is shown early, except that a start-of-day
    reading is never shown past the project finish: the latest instant is often
    the end of the finish day, which is shown as that day.
    """
    assert task.early_start is not None
    if _next_working_day(late_instant, cal) == _next_working_day(early[0], cal):
        return task.early_start
    if early[1] and cal.is_working_day(late_instant) and late_instant <= project_finish:
        return late_instant
    return _prev_working_day(_safe_offset(late_instant, -_ONE_DAY), cal)


def _finish_instant(task_map: dict[str, Task], instants: dict[str, _Instant]) -> date:
    """The instant the project ends: the latest task finish, milestones as instants.

    ``project_finish`` is a *day* — the latest ``early_finish`` — and a milestone at
    the start of that day ends the project at its start, not its end. Seeding late
    dates at the end of the finish day would give the work before it a day of
    float it does not have.
    """
    latest: date | None = None
    for tid, t in task_map.items():
        assert t.early_finish is not None
        own = instants.get(tid)
        end = _safe_offset(t.early_finish, _ONE_DAY) if own is None else own[0]
        latest = end if latest is None or end > latest else latest
    assert latest is not None
    return latest


def _place_milestone(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    es_floors: list[date],
    links: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    start_floor: date | None = None,
) -> tuple[_Instant, date, _Instant]:
    """Place a zero-duration task as an instant: ``(shown, day, link)``.

    ``shown`` is ``(instant, start_display)``, the position the milestone is shown at
    on ``day``; ``link`` is the instant its own successors measure from, read off
    ``links`` for each predecessor milestone in turn.

    Each floor and each incoming link proposes an instant, and the latest wins:

    * floors (project start, data date, SNET, a recorded actual start) propose the
      start of their day, shown on that day;
    * FS/SS links propose ``anchor + lag`` (:func:`_edge_anchor`) — shown at the end
      of the previous working day after FS from work, at the start of the day after
      SS from work, and — only at zero lag, where the proposed instant is the very
      same midnight the predecessor milestone occupies — the way that predecessor is
      shown; a *lagged* link out of a milestone proposes a different midnight and
      falls back to the FS/SS-from-work rule, or the composed lag would inherit a
      display quirk (Sunday/Monday snapping, #4173) that belongs to the
      predecessor's own instant and not to this one (#4079 fuzz regression). Every
      case is subject to the same override: an instant just after non-working time
      is always shown at the start of the next working day (:func:`_start_reading`,
      #4173);
    * FF links propose exactly what FS would (:func:`_milestone_link`), and SF links
      the midnight closing their anchor day plus the lag, read like FS from work —
      raw instants, never snapped to a working day (#4272,
      :func:`_milestone_proposal`).

    Two proposals at the same midnight resolve to the start-of-day reading, so a
    milestone floored at the data date or an SNET day is never shown before it.
    Because the instant is a raw midnight and never rounded, lags compose through a
    milestone exactly as they would without it.

    The **project-start floor** (``start_floor``) only places the milestone where it
    is *shown* (#4225). ``es_floors`` holds the others — data date, SNET, a recorded
    actual start — which are facts about when the milestone can happen, so they bind
    ``link`` as well. The project start is a display bound: nothing is shown before
    the plan opens, but every successor carries that same floor itself, so a
    milestone held at it by the floor alone has nothing to add downstream. Measuring
    a successor's lag from the floored instant instead made the milestone a node
    that moved its successor: with ``A`` placed before the project start (an
    SF-linked task, #4218, or a negative lag), ``A -FS(2cd)-> B`` and
    ``A -FS-> M -FS(2cd)-> B`` put ``B`` a working day apart. ``link`` is therefore
    the latest proposal *without* the project-start floor, and ``shown`` with it —
    the same raw-versus-shown split :func:`_start_reading` keeps for a display-only
    snap (#4173). When nothing but the project-start floor proposes, the two are
    the same instant.
    """
    best: tuple[date, bool, date] | None = None

    def offer(candidate: tuple[date, bool, date]) -> None:
        nonlocal best
        if best is None or candidate[:2] > best[:2]:
            best = candidate

    for floor in es_floors:
        offer((floor, True, floor))

    for pred_id in g.predecessors(node_id):
        pred = task_map[pred_id]
        dep: Dependency = g[pred_id][node_id]["dep"]
        assert pred.early_start is not None and pred.early_finish is not None
        raw, start_display = _milestone_proposal(
            dep.dep_type,
            dep.lag,
            _link_start(pred),
            pred.early_finish,
            links.get(pred_id),
            cal_for(pred_id),
            cal,
        )
        offer((raw, start_display, _instant_day(raw, start_display, cal)))

    link = best
    if start_floor is not None:
        offer((start_floor, True, start_floor))
    # start_floor is given for every task except an SF-linked one (#4218), and that one
    # has at least one SF link, which offers a candidate.
    assert best is not None
    # `resolved` and `link` both still read as `tuple[...] | None` to SonarPython
    # here: `best` is reassigned via `nonlocal` from inside the `offer()` closure,
    # and its dataflow analysis does not carry this assert's narrowing across that
    # closure boundary — rebinding to a fresh name (`resolved`, #4259) did not clear
    # it either, since `link = best` above captured the same unnarrowed type before
    # the assert ever ran. Genuinely non-Optional below: every call path offers at
    # least one candidate (an `es_floors` entry, a predecessor edge, or
    # `start_floor`) before this line, per the docstring and the `assert` itself.
    resolved = best
    shown = (resolved[0], resolved[1])  # NOSONAR
    if link is None:
        return shown, resolved[2], shown  # NOSONAR
    return shown, resolved[2], (link[0], link[1])  # NOSONAR


def _resolve_task_calendars(project: Project) -> dict[str, Calendar] | None:
    """Map each task id to the calendar its own date arithmetic should use (ADR-0120 D3).

    Returns ``None`` when the project declares no per-task ``calendars`` registry —
    the signal for the engine to take the single-calendar fast path that is
    byte-for-byte identical to the pre-ADR-0120 behavior. Otherwise every task
    resolves to its ``Project.calendars[task.calendar_id]`` entry, or to the
    pass-level ``project.calendar`` when ``calendar_id`` is unset.

    A ``calendar_id`` naming no registry entry raises :class:`InvalidScheduleInput`
    (#4516). :func:`_validate_project` refuses it first on every validated entry
    point; raising here too keeps the callers that resolve calendars without
    re-validating — :func:`~trueppm_scheduler.derive.derive_value` given a
    precomputed ``result``, :func:`perturb_task_duration` — from silently scheduling
    the task on the wrong working week.

    This map governs *duration* arithmetic only: a task's own working week. Lag on
    an edge is consumed on the **successor's** calendar (the constraint lands where
    the wait is), so the passes look the successor up in this same map separately.
    """
    if not project.calendars:
        return None
    default = project.calendar
    calendars = project.calendars
    resolved: dict[str, Calendar] = {}
    for t in project.tasks:
        if t.calendar_id is None:
            resolved[t.id] = default
            continue
        cal = calendars.get(t.calendar_id)
        if cal is None:
            raise InvalidScheduleInput(_unknown_calendar_id_message(t.id, t.calendar_id))
        resolved[t.id] = cal
    return resolved


# ---------------------------------------------------------------------------
# Graph utilities
# ---------------------------------------------------------------------------


def _build_graph(project: Project) -> nx.DiGraph[str]:
    """Build a directed graph from project tasks and dependencies."""
    g: nx.DiGraph[str] = nx.DiGraph()
    task_ids = {t.id for t in project.tasks}
    for task in project.tasks:
        g.add_node(task.id)
    for dep in project.dependencies:
        if dep.predecessor_id not in task_ids or dep.successor_id not in task_ids:
            # A dependency naming a non-existent task is degenerate input by the
            # #749 definition, so raise the documented type (not a bare ValueError)
            # — this keeps the cross-engine reject-parity contract symmetric: the
            # Rust build_graph returns Err for the same input, and the shared
            # fixtures/invalid/unknown_dependency_task.json conformance fixture
            # asserts InvalidScheduleInput on both schedule() and monte_carlo()
            # (#1087). InvalidScheduleInput subclasses ValueError, so existing
            # ``except ValueError`` callers are unaffected.
            raise InvalidScheduleInput(
                f"Dependency references unknown task: {dep.predecessor_id!r} → {dep.successor_id!r}"
            )
        g.add_edge(dep.predecessor_id, dep.successor_id, dep=dep)
    return g


def _raise_cycle_error(g: nx.DiGraph[str]) -> NoReturn:
    """Reconstruct and raise the cycle from a graph a topological sort rejected.

    Called only from the ``NetworkXUnfeasible`` handler of a topological sort:
    the sort has already proved the graph cyclic in ~3ms, so the ~148ms
    ``nx.find_cycle`` edge-DFS (5K tasks/5.7K edges, #1526) runs only on this
    error path to reconstruct the user-facing cycle — never on the happy path,
    where checking cycles eagerly with ``find_cycle`` was 37% of the
    ``schedule()`` budget for a result the topological sort already proves.
    """
    cycle = nx.find_cycle(g)
    raise CyclicDependencyError([u for u, _ in cycle] + [cycle[-1][1]])


@dataclass
class CycleCheck:
    """Result of a dependency-graph cycle check (see :func:`find_cycle`).

    Wraps the raw cycle path so this public, ``__all__``-exported helper can grow
    new fields later (e.g. the dependency types along the cycle) without breaking
    callers — the pip wheel ships this API, so its shape is a forward-compatibility
    contract (#1325). Truthy iff a cycle was found, so ``if find_cycle(...):`` still
    reads naturally.
    """

    #: The cycle as an ordered list of task IDs with the first repeated at the end
    #: (e.g. ``["A", "B", "C", "A"]``), or ``None`` when the graph is acyclic.
    cycle: list[str] | None

    def __bool__(self) -> bool:
        return self.cycle is not None

    def to_dict(self) -> dict[str, Any]:
        """Return this cycle-check result as a JSON-serializable dict.

        Returns:
            ``{"cycle": [<task id>, ...]}`` naming the offending tasks, or
            ``{"cycle": None}`` when the graph is acyclic. Note that the object
            itself is falsy in the acyclic case (``__bool__``), so
            ``if find_cycle(...)`` reads correctly without inspecting this dict.
        """
        return {"cycle": self.cycle}


@dataclass
class SummaryExpansion:
    """Result of expanding summary-task dependencies (see :func:`expand_summary_dependencies`).

    Wraps the ``(tasks, dependencies)`` pair so this public, ``__all__``-exported
    helper can grow fields without breaking the pip contract (#1325). Iterable for
    backward compatibility — ``leaf_tasks, deps = expand_summary_dependencies(...)``
    still unpacks — while ``.tasks`` / ``.dependencies`` are the named accessors.
    """

    #: Input tasks with summary tasks removed (only leaves remain).
    tasks: list[Task]
    #: Dependencies fanned out to leaf-level edges, deduplicated.
    dependencies: list[Dependency]

    def __iter__(self) -> Iterator[Any]:
        yield self.tasks
        yield self.dependencies


def find_cycle(
    edges: list[tuple[str, str]],
    children_map: dict[str, list[str]] | None = None,
) -> CycleCheck:
    """Detect a cycle in a dependency graph; return ordered task IDs or None.

    Operates on raw ``(predecessor_id, successor_id)`` tuples so callers do
    not need to construct full :class:`Task` / :class:`Dependency` model
    objects just to validate a single proposed edge.

    When ``children_map`` is provided, summary→X and X→summary edges are
    expanded to their leaf descendants before detection so logical cycles
    through summary tasks are caught (e.g. ``Eng (summary) → Validate`` where
    ``Validate`` is one of ``Eng``'s leaves is a cycle).

    Args:
        edges: All ``(predecessor_id, successor_id)`` edges in the proposed
            graph, including the new edge being validated.
        children_map: Optional mapping of summary task ID to list of direct
            child IDs. Tasks not in the mapping are treated as leaves.

    Returns:
        A :class:`CycleCheck` whose ``cycle`` is the cycle as an ordered list of
        task IDs with the first repeated at the end (e.g. ``['A', 'B', 'C', 'A']``)
        so callers can render an unambiguous path, or ``None`` if the graph is
        acyclic. The result is truthy iff a cycle was found.

    Raises:
        InvalidScheduleInput: If ``children_map`` itself is malformed — not a
            dict, a summary id (key) or child id that is not a string (``None``
            and other non-string ids are refused, #4522), a value that is not a
            list, a summary with an empty children list, or a cycle in
            ``children_map`` itself (a summary that is its own ancestor) —
            distinct from a cycle in the ``edges`` being validated, which is
            returned, not raised. Also raised if expanding summary→summary
            edges would exceed :data:`MAX_EXPANDED_EDGES` leaf-level tuples (a
            pathological cross product); the graph is rejected rather than
            allowed to spin.
    """
    edge_list = _validate_edge_list(edges)
    _validate_children_map_shape(children_map)

    if children_map:
        edge_list = _expand_edges_for_cycle_check(edge_list, children_map)
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from(edge_list)
    try:
        cycle = nx.find_cycle(g)
    except nx.NetworkXNoCycle:
        return CycleCheck(cycle=None)
    return CycleCheck(cycle=[u for u, _ in cycle] + [cycle[-1][1]])


def _validate_edge_list(edges: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Validate the raw edge input shape for the public :func:`find_cycle` API.

    Checked up front so a malformed call raises the documented
    ``InvalidScheduleInput`` rather than a bare ``NetworkXError``/``TypeError``
    from deep inside networkx or ``_collect_leaves`` (#1209).
    """
    try:
        edge_list = list(edges)
    except TypeError as err:
        raise InvalidScheduleInput(f"edges must be an iterable of pairs (got {edges!r}).") from err
    for e in edge_list:
        if not (isinstance(e, tuple) and len(e) == 2):
            raise InvalidScheduleInput(
                f"each edge must be a (predecessor_id, successor_id) 2-tuple (got {e!r})."
            )
        u, v = e
        if not isinstance(u, str) or not isinstance(v, str):
            raise InvalidScheduleInput(f"edge endpoints must be string task ids (got {e!r}).")
    return edge_list


def _validate_children_map_shape(children_map: dict[str, list[str]] | None) -> None:
    """Guard the container type before ``.items()`` (#1825).

    A non-dict argument (a list or str) would otherwise leak a bare
    ``AttributeError`` past the documented contract. Also rejects a non-string
    summary id (key) or child id (#4522) — a ``None``/unhashable (list/dict)
    child entry otherwise reaches ``children_map.get(node)`` inside
    ``_collect_leaves`` during expansion and either leaks a bare
    ``TypeError``/``ValueError`` or, for ``None``, is silently accepted as a leaf
    id with no error at all; a non-string key (e.g. an ``int``) never matches a
    string edge endpoint, so the whole entry is silently accepted and ignored as
    a dead no-op instead of being refused as the malformed input it is.
    """
    if children_map is None:
        return
    if not isinstance(children_map, dict):
        raise InvalidScheduleInput(
            f"children_map must be a dict of summary id -> child ids or None "
            f"(got {type(children_map).__name__})."
        )
    for sid, kids in children_map.items():
        if not isinstance(sid, str):
            raise InvalidScheduleInput(
                f"children_map contains a non-string summary id "
                f"(got {type(sid).__name__}: {sid!r})."
            )
        if not isinstance(kids, list):
            raise InvalidScheduleInput(
                f"children_map[{sid!r}] must be a list of child ids (got {kids!r})."
            )
        for child_id in kids:
            if not isinstance(child_id, str):
                raise InvalidScheduleInput(
                    f"children_map[{sid!r}] contains a non-string child id "
                    f"(got {type(child_id).__name__}: {child_id!r})."
                )


def _expand_edges_for_cycle_check(
    edges: list[tuple[str, str]],
    children_map: dict[str, list[str]],
) -> list[tuple[str, str]]:
    """Expand summary↔leaf edges to leaf-level tuples for cycle detection.

    Operates on raw edge tuples — no :class:`Dependency` objects required.
    Deduplicates the result. Unlike :func:`expand_summary_dependencies`
    (which drops self-loops because the CPM engine cannot consume them),
    self-loops *produced by expansion* are kept here: a summary→its-own-leaf
    edge expands to a self-loop on the leaf, and that self-loop is precisely
    the logical cycle this function exists to surface.
    """
    summary_ids = set(children_map.keys())
    if not summary_ids:
        return edges
    _check_children_map(children_map)

    # Resolve each endpoint to its leaves once: an endpoint id can recur across many
    # edges, and _collect_leaves walks the subtree each call.
    endpoint_ids = {pid for pid, _ in edges} | {sid for _, sid in edges}
    leaves = {
        nid: (_collect_leaves(nid, children_map) if nid in summary_ids else [nid])
        for nid in endpoint_ids
    }

    # Bound the cross product from leaf *counts* before materialising a single
    # tuple (#357). The worst case — a wide summary→summary edge — is O(P*S) per
    # edge; summing the per-edge products up front lets us reject a pathological
    # graph in O(edges + leaves) instead of after building millions of tuples (or
    # timing out). The estimate is an upper bound (it ignores cross-edge dedup),
    # which is the safe direction: we never under-count and let a blowup through.
    estimated = 0
    for pred_id, succ_id in edges:
        estimated += len(leaves[pred_id]) * len(leaves[succ_id])
        if estimated > MAX_EXPANDED_EDGES:
            raise InvalidScheduleInput(
                f"Cannot validate cycles: expanding summary dependencies to leaf "
                f"level would exceed {MAX_EXPANDED_EDGES:,} edges. A summary→summary "
                "dependency is fanning out to the cross product of both summaries' "
                "leaves — simplify the structure (depend on specific leaf tasks, or "
                "split the wide summary edge) and retry."
            )

    seen: set[tuple[str, str]] = set()
    expanded: list[tuple[str, str]] = []
    for pred_id, succ_id in edges:
        for p in leaves[pred_id]:
            for s in leaves[succ_id]:
                if (p, s) in seen:
                    continue
                seen.add((p, s))
                expanded.append((p, s))
    return expanded


# ---------------------------------------------------------------------------
# CPM: forward and backward passes
# ---------------------------------------------------------------------------


def _forward_pass(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    project_start: date,
    calendar: Calendar,
    status_date: date | None = None,
    task_calendars: dict[str, Calendar] | None = None,
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, _Instant]:
    """Compute early_start and early_finish for every task (in-place).

    Progress-aware (ADR-0132): a completed task (``actual_finish`` set, or
    ``percent_complete >= 100``) is pinned by :func:`_pinned_placement` and removed
    from network logic (ADR-0136, #4343); an in-progress task
    contributes only its remaining duration; and when ``status_date`` (the data
    date) is given, remaining/not-started work is floored at it — future work is
    never scheduled in the past. An in-progress task's ``actual_start``, when
    recorded, is an additional early-start floor (ADR-0132 §2, #2621): work
    already underway stays where it actually started, even past the data date
    or a predecessor's constraint. With no actuals and no status date the
    result is byte-identical to a pure planning pass.

    Per-task calendars (ADR-0120 D3): when ``task_calendars`` is supplied, the task
    being computed (the successor of every incoming edge) uses its own calendar for
    *all* of its arithmetic — duration expansion **and** the working-day snap of
    every predecessor constraint, since lag lands on the successor's calendar and
    the successor *is* the node here. ``task_calendars=None`` (or any task absent
    from it) falls back to ``calendar``, making the single-calendar path identical.

    Zero-duration tasks scheduled through the network are placed as instants
    (#4079, see the module docstring). Returns ``{task_id: (instant,
    start_display)}`` for each of them (:data:`_Instant`), which the backward pass,
    float computation and Monte Carlo's completed-task constraints read to invert
    and extend the same rule. A completed task with work is absent: it is ordinary
    work to its successors. A completed milestone is present, with or without
    actuals: it stays an instant (:func:`_pinned_milestone_instant`, #4343), on the
    edge of its day it had live when actuals are recorded (#4433).

    ``link_instants``, when given, is filled with the instant each of those
    milestones' successors measure from (:func:`_place_milestone`'s ``link``). It
    differs from the shown instant only for a milestone held up by the project-start
    floor alone (#4225).
    """
    floors: dict[int, tuple[date, date, date | None]] = {}
    instants: dict[str, _Instant] = {}
    links: dict[str, _Instant] = {} if link_instants is None else link_instants

    def cal_for(tid: str) -> Calendar:
        return calendar if task_calendars is None else task_calendars.get(tid, calendar)

    for node_id in topo_order:
        task = task_map[node_id]
        # The node being computed is the successor of all its incoming edges, so a
        # single calendar — its own — governs both its duration and the snap of
        # every predecessor constraint (lag is consumed on the successor's
        # calendar). With no per-task calendars this is always ``calendar``.
        cal = calendar if task_calendars is None else task_calendars.get(node_id, calendar)
        start_base, start, data_floor = _calendar_floors(cal, project_start, status_date, floors)
        # Only a milestone can sit at the end of its day (#4079, #4433);
        # reset first so an input carrying a previous run's value cannot leak.
        task.milestone_at_day_end = False

        pinned = _pinned_placement(task, cal, start_base)
        if pinned is not None:
            task.early_start, task.early_finish = pinned
            if task.duration.days == 0:
                # A completed milestone stays an instant (#4343, #4433), on the
                # edge of its day it would have been read at live.
                recorded = task.actual_finish or task.actual_start
                live_start = recorded is None or _live_milestone_edge(
                    node_id, task_map, g, cal, links, cal_for, recorded
                )
                instants[node_id], links[node_id] = _pinned_milestone_instant(
                    task, cal, pinned[0], live_start
                )
                task.milestone_at_day_end = not instants[node_id][1]
            task.scheduled_start = _compute_scheduled_start(task, cal)
            continue

        sf_linked = _sf_linked(node_id, g)
        duration_days, es_constraints = _early_start_floors(
            task, cal, start, data_floor, sf_linked=sf_linked
        )

        if duration_days == 0:
            # Every floor but the project start's — the list an SF-linked task gets —
            # binds the instant successors measure from; the project start only
            # bounds where the milestone is shown (#4225, see _place_milestone).
            _, hard_floors = _early_start_floors(task, cal, start, data_floor, sf_linked=True)
            instant, day, links[node_id] = _place_milestone(
                node_id,
                task_map,
                g,
                cal,
                hard_floors,
                links,
                cal_for,
                None if sf_linked else start_base,
            )
            task.early_start = task.early_finish = day
            instants[node_id] = instant
            # ``start_display`` False = shown at the end of ``day`` (follows work).
            task.milestone_at_day_end = not instant[1]
            task.scheduled_start = _compute_scheduled_start(task, cal)
            continue

        pred_es, ef_constraints = _forward_edge_constraints(
            node_id, task_map, g, cal, links, cal_for
        )
        es_constraints.extend(pred_es)

        if not es_constraints:
            # An SF-linked task with no FS/SS link and no data date, SNET or actual
            # start (#4218): its finish links place it, and nothing floors the start
            # they back-solve. ``_sf_linked`` guarantees ef_constraints here.
            min_ef = max(ef_constraints)
            task.early_start = _start_from_finish(min_ef, duration_days, cal)
            task.early_finish = max(
                _finish_from_start(task.early_start, duration_days, cal), min_ef
            )
            task.scheduled_start = _compute_scheduled_start(task, cal)
            continue

        # ES = latest of all ES constraints.
        task.early_start = max(es_constraints)
        task.early_finish = _finish_from_start(task.early_start, duration_days, cal)

        # Apply EF constraints (from FF/SF dependencies).
        if ef_constraints:
            min_ef = max(ef_constraints)
            if min_ef > task.early_finish:
                task.early_finish = min_ef
                # Pull ES back to match: task must start early enough to hit EF.
                back_start = _start_from_finish(task.early_finish, duration_days, cal)
                # ES cannot go below its own constraints.
                task.early_start = max(back_start, max(es_constraints))
                # Recompute EF from the (possibly adjusted) ES.
                task.early_finish = max(
                    _finish_from_start(task.early_start, duration_days, cal),
                    min_ef,
                )

        task.scheduled_start = _compute_scheduled_start(task, cal)

    return instants


def _sf_linked(node_id: str, g: nx.DiGraph[str]) -> bool:
    """Whether ``node_id`` has at least one incoming SF link (#4218, #4220).

    Such a task is not floored at the project start (see "An SF-linked task may
    start before the project start" in the module docstring): its floor is
    ``min(project start, SF placement)``, which never binds. It reads the graph the
    pass schedules — the same edge set :mod:`trueppm_scheduler.derive` explains
    from — and the Monte Carlo pass, the
    derivation and the Rust engine (``forward.rs::sf_linked``) apply the same test.
    """
    return any(g[p][node_id]["dep"].dep_type == DependencyType.SF for p in g.predecessors(node_id))


def _early_start_floors(
    task: Task,
    cal: Calendar,
    start: date,
    data_floor: date | None = None,
    *,
    sf_linked: bool = False,
) -> tuple[int, list[date]]:
    """Return ``(duration_days, es_constraints)``: the duration to schedule and the ES lower bounds.

    The bounds cover the project-start / data-date floor, an in-progress task's
    ``actual_start``, and ``planned_start`` (SNET). Predecessor-driven bounds are
    added by the caller.

    ``sf_linked`` (:func:`_sf_linked`) drops the project-start floor and keeps only the
    data date (``data_floor``, ``None`` when no status date is set), so the list
    may come back empty (#4218). For a task with an SF link the project-start floor
    is ``min(project start, SF placement)``, which its SF link already enforces, so
    leaving it out is that rule (#4220). Why the two floors part here: the project start
    is where the plan *nominally* opens, and an SF link is the one dependency that
    can legitimately require work before an early predecessor — MS Project moves
    such a successor ahead of the project start rather than dropping its link. The
    data date is not a planning choice: remaining work cannot be forecast into the
    past, so an SF anchor behind it means the successor is late, and it stays on
    the data date like any other unfinished work.

    Only reached for a task that is not complete: every completed task is pinned by
    :func:`_pinned_placement` before the forward pass asks for its floors (#4343).
    """
    # In-progress work contributes only what is left, laid forward from the
    # data date; not-started work uses its full estimate.
    duration_days = _effective_duration_days(task)
    es_floor = data_floor if sf_linked else start
    es_constraints: list[date] = [] if es_floor is None else [es_floor]
    if task.actual_start is not None:
        # ADR-0132 §2 / #2621: work already underway is floored at where
        # it actually started, not just at the data date or predecessor
        # constraints — actuals are truth and are never smoothed back
        # to an earlier network slot. Unsnapped, unlike planned_start:
        # a recorded actual can legitimately land on a non-working day
        # (e.g. logged over a weekend) and is not renegotiated.
        es_constraints.append(task.actual_start)

    # planned_start (SNET) is an additional ES lower-bound: the task may
    # not start before this date regardless of network logic.
    if task.planned_start is not None:
        es_constraints.append(_next_working_day(task.planned_start, cal))
    return duration_days, es_constraints


def _calendar_floors(
    cal: Calendar,
    project_start: date,
    status_date: date | None,
    cache: dict[int, tuple[date, date, date | None]],
) -> tuple[date, date, date | None]:
    """The project-start floor and the data-date floor for ``cal``, memoized (#1824).

    Both floors snap to the task's *own* calendar — a task can never begin on its own
    non-working day. With one project calendar every task resolves the same value the
    pre-ADR-0120 pass hoisted out of the loop, so the result is byte-identical.

    Memoized because both are identical for every task sharing a calendar, and
    re-snapping per task made the forward pass O(tasks · scan_depth): a valid calendar
    whose exceptions blanket a ~36k-day gap after the start (one working day just past
    it, so validation's reachability probe passes) turned even a few hundred tasks into
    a multi-second spin — every task repeating the same 36k-day walk. Keyed by object
    identity: Calendar holds a mutable exceptions list and isn't hashable, and the
    resolved objects are stable here.

    Returns ``(start_base, start, data_floor)`` — the project-start floor, that floor
    raised to the data date when one is set, and the data-date floor on its own
    (``None`` without a status date). A status date at or before project start is
    already covered by the project-start floor in ``start``; ``data_floor`` is what an
    SF-linked task, which the project start does not floor, is held at (#4218).
    """
    key = id(cal)
    cached = cache.get(key)
    if cached is not None:
        return cached

    start_base = _next_working_day(project_start, cal)
    start = start_base
    data_floor: date | None = None
    if status_date is not None:
        # The data date floors all not-yet-finished work: nothing remaining can be
        # scheduled before "as of now".
        data_floor = _next_working_day(status_date, cal)
        start = max(start_base, data_floor)
    cache[key] = (start_base, start, data_floor)
    return start_base, start, data_floor


def _compute_scheduled_start(task: Task, cal: Calendar) -> date:
    """The task's span start (ADR-0752), as distinct from ``early_start``.

    ``early_start``/``early_finish`` mean the *remaining-work window* for an
    in-progress task (ADR-0132) — correct for network scheduling, but not the
    task's span. ``scheduled_start`` is the span start, per this table:

    - Not started (``percent_complete <= 0``): ``early_start`` — the windows
      coincide, nothing has been consumed yet.
    - Complete (:func:`_is_complete`): ``early_start`` — ADR-0136 already pins
      a completed task at its full duration, so the remaining window *is* the
      span.
    - In progress, ``actual_start`` recorded: ``actual_start`` — the span
      began when work actually began, however long ago that was. The span may
      then exceed ``duration`` (a task running long); that divergence is the
      whole point of the field (ADR-0752 §2).
    - In progress, no ``actual_start``: the full duration backed off from
      ``early_finish`` (which is unaffected by this — remaining work still
      ends when the task ends), calendar-aware via :func:`_start_from_finish`.

    Must be called after ``task.early_start``/``task.early_finish`` are set
    for this task (i.e. from within :func:`_forward_pass`, after the early
    window is resolved for both the pinned and network-scheduled branches).
    """
    assert task.early_start is not None and task.early_finish is not None
    if _is_complete(task):
        return task.early_start
    pct = task.percent_complete or 0.0
    if pct <= 0:
        return task.early_start
    if task.actual_start is not None:
        return task.actual_start
    full_days = task.duration.days
    return _start_from_finish(task.early_finish, full_days, cal)


def _pinned_placement(task: Task, cal: Calendar, start_base: date) -> tuple[date, date] | None:
    """Early window for a completed task, which is pinned out of network logic.

    A completed task (``actual_finish`` set, or ``percent_complete >= 100``) is laid
    out at its FULL duration so the bar keeps its shape (ADR-0136). Whatever actuals
    exist anchor the span; a missing endpoint is derived from full duration. Actuals
    are truth, so a pinned task leaves network logic entirely — it may even sit before
    a predecessor, surfacing out-of-sequence reality rather than smoothing it away.

    A completed task with **no** actuals at all is pinned too (#4343): its full
    duration is laid out from ``start_base`` — the project start snapped to the
    task's calendar, never the data date, because completed work is historical —
    raised to its ``planned_start`` (SNET) when one is set. Predecessors do not move
    it. That is the position the backward pass, free float, Monte Carlo and the
    derivation already assumed (they all treat a completed task as out of the
    network); placing it through the network here instead made the two halves of the
    engine disagree about the same task, inflating its predecessors' float and
    dropping them off the critical path.

    Returns ``None`` — "schedule this one through the network" — only when the task
    is not complete.
    """
    if not _is_complete(task):
        return None

    full_days = task.duration.days
    if task.actual_finish is not None:
        # Finish is known; start is the recorded actual, else a full duration back
        # from the finish (the actual_finish drives FS successors, the resolved
        # start drives SS/SF successors).
        start = (
            task.actual_start
            if task.actual_start is not None
            else _start_from_finish(task.actual_finish, full_days, cal)
        )
        return start, task.actual_finish
    if task.actual_start is not None:
        # Start is known (e.g. a REVIEW task: done, awaiting sign-off); lay the full
        # duration forward from it.
        return task.actual_start, _finish_from_start(task.actual_start, full_days, cal)
    # No actuals: the un-floored project start, or the SNET when it is later.
    start = start_base
    if task.planned_start is not None:
        start = max(start, _next_working_day(task.planned_start, cal))
    return start, _finish_from_start(start, full_days, cal)


def _live_milestone_edge(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    links: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
    recorded: date,
) -> bool:
    """Whether a closed milestone sits at the *start* of its recorded day (#4433).

    The edge of the day a live milestone sits on is set by whatever places it: a
    floor (project start, data date, SNET) proposes the start of its day, an FS
    link from work the end of the work's finish day (:func:`_place_milestone`).
    Closing it records *when* it happened, not a different kind of instant, so it
    keeps that edge — "preserve the live edge".

    The recorded day is offered as a start-of-day floor alongside the links, which
    is what a data-date or SNET floor that placed the milestone live amounts to
    once the actuals supply the date: the end of the day wins only when an FS
    proposal from work reaches past the start of the recorded day — the work
    finished that day (or later). Asking the links alone read every milestone
    with an FS predecessor as end-of-day, so one whose work finished days before
    it was signed off, or held by a later SNET, slipped its successors a working
    day when it was closed — the #4433 bug again. With no predecessor nothing but
    a floor can place it: the start of its day.
    """
    if not any(True for _ in g.predecessors(node_id)):
        return True
    shown, _, _ = _place_milestone(node_id, task_map, g, cal, [recorded], links, cal_for)
    return shown[1]


def _pinned_milestone_instant(
    task: Task, cal: Calendar, day: date, live_start: bool = True
) -> tuple[_Instant, _Instant]:
    """``(shown, link)`` for a completed milestone pinned on ``day`` (#4343, #4433).

    Pinning takes the milestone out of the network, but not out of being a
    milestone. With no actuals it is an instant at the start of its pinned day,
    as a live milestone with no links is (#4343); the pair is what
    :func:`_place_milestone` returns with no predecessors: the SNET is a fact
    about when the milestone happens and binds ``link``; the project start only
    bounds where it is shown (#4225), so ``link`` falls back to it only when no
    SNET is set.

    With actuals recorded — the API's normal path, since ``COMPLETE`` stamps
    ``actual_finish`` — the day is the recorded one (``actual_finish``, else
    ``actual_start``), shown and linked from alike, and the edge of that day is
    the one the milestone had live (``live_start``, :func:`_live_milestone_edge`).
    A milestone that nothing precedes, or that a floor held, stays at the start of
    its day: laying it out as ordinary work, ending at the end of the day, slipped
    every FS successor a working day the moment the milestone was closed (#4433).
    One placed by work finishing that day stays at the end of it, so closing it
    then does not pull its successors into the day the work was still finishing.
    """
    recorded = task.actual_finish if task.actual_finish is not None else task.actual_start
    if recorded is not None:
        if live_start:
            actual: _Instant = (recorded, True)
        else:
            # The end of the recorded day is the next midnight, read the way an FS
            # proposal from work is (_start_reading: a weekend actual snaps forward).
            raw = _safe_offset(recorded, _ONE_DAY)
            actual = (raw, _start_reading(raw, False, cal))
        return actual, actual
    shown: _Instant = (day, True)
    if task.planned_start is None:
        return shown, shown
    return shown, (_next_working_day(task.planned_start, cal), True)


def _forward_edge_constraints(
    node_id: str,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    cal: Calendar,
    instants: dict[str, _Instant],
    cal_for: Callable[[str], Calendar],
) -> tuple[list[date], list[date]]:
    """Split a node's incoming edges into early-start and early-finish constraints.

    FS/SS bound when the successor may *start*; FF/SF bound when it may *finish*. All
    snapping uses ``cal`` — the successor's calendar — because lag is consumed on the
    successor's calendar and the successor is the node being computed. Each bound is
    ``next_wd(anchor + lag)``; :func:`_edge_anchor` supplies the anchor, which for a
    milestone predecessor is the instant its successors measure from (``instants``
    here is :func:`_forward_pass`'s link map, #4225) rather than a day it occupies
    (#4079).
    """
    es_constraints: list[date] = []
    ef_constraints: list[date] = []

    for pred_id in g.predecessors(node_id):
        pred = task_map[pred_id]
        dep: Dependency = g[pred_id][node_id]["dep"]
        # Predecessors are visited first in topological order, so these are always set.
        assert pred.early_start is not None and pred.early_finish is not None
        anchor = _edge_anchor(
            dep.dep_type,
            _link_start(pred),
            pred.early_finish,
            instants[pred_id][0] if pred_id in instants else None,
            cal_for(pred_id),
            dep.lag,
        )
        bound = _advance_calendar_days(anchor, dep.lag, cal)
        if dep.dep_type in _START_ANCHORED:
            es_constraints.append(bound)
        else:
            ef_constraints.append(bound)

    return es_constraints, ef_constraints


def _backward_pass(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    project_finish: date,
    calendar: Calendar,
    task_calendars: dict[str, Calendar] | None = None,
    instants: dict[str, _Instant] | None = None,
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, date]:
    """Compute late_start and late_finish for every task (in-place).

    Progress-aware (ADR-0132/0136): a completed task carries zero float (late ==
    early — it is done, it has no slack), reusing the full-duration span the forward
    pass resolved, and an in-progress task's late dates span only its remaining
    duration, matching the forward pass so total/free float stay internally
    consistent.

    Per-task calendars (ADR-0120 D3): the node being computed (the *predecessor* of
    every outgoing edge here) is the one whose late_start/late_finish this call
    produces. Mirroring the forward pass — where the node being computed always
    uses its *own* calendar for its own arithmetic, because that arithmetic must
    land on a day the node itself can work — every successor-derived constraint
    here also snaps to a working day on **this task's own** calendar (``node_cal``),
    never the successor's. (The successor's calendar governs lag arithmetic and the
    free-float mirror in :func:`_compute_floats`, which simulates what the forward
    pass would impose *on the successor* — a different node, a different question.
    Using the successor's calendar here instead was issue #1490: it could snap a
    predecessor's own late date to a day before its early date.) With
    ``task_calendars=None`` every lookup resolves to ``calendar`` and the pass is
    identical to before.

    ``instants`` is the milestone map :func:`_forward_pass` returned (#4079). A
    milestone's late instant is the latest one every successor link still admits
    (:func:`_milestone_latest`), and a milestone successor offers its predecessors
    its late instant (:func:`_milestone_refs`) in place of a late start/finish it
    does not occupy. Returns each live milestone's late instant: the day it is
    shown on does not determine it (the end of Tuesday is the start of
    Wednesday). These are the *uncapped* instants predecessors read; a milestone's
    own total float is measured to :func:`_float_late_instant` of them, which the
    caller computes (#4183).

    ``link_instants`` is :func:`_forward_pass`'s link map (#4225). A milestone held
    up by the project-start floor alone is shown later than the instant its
    successors measure from, and its late instant is floored at the latter: that is
    the coordinate its predecessors invert against, so the floor at the shown
    instant would hand them a bound the direct link never imposes. Its own late
    date is still never shown before its early one.
    """
    early_instants = instants or {}
    links = link_instants or {}
    late_instants: dict[str, date] = {}
    # Every late date is seeded from the instant the project ends. Without
    # milestones that is the end of the finish day, exactly the old seed; a
    # milestone at the *start* of the finish day ends the project there, and
    # ordinary work finishing later that day would delay it (#4079).
    finish_instant = (
        _finish_instant(task_map, early_instants)
        if early_instants
        else _safe_offset(project_finish, _ONE_DAY)
    )

    def cal_for(tid: str) -> Calendar:
        return calendar if task_calendars is None else task_calendars.get(tid, calendar)

    for node_id in reversed(topo_order):
        task = task_map[node_id]
        # This node is the predecessor of its outgoing edges; its own calendar lays
        # out its duration (and floors its late finish at the project finish).
        node_cal = cal_for(node_id)

        # Completed (actual_finish set, or percent_complete >= 100): late == early,
        # so the task carries zero float and never distorts the critical path. The
        # forward pass already resolved its full-duration span (ADR-0136).
        if _is_complete(task):
            assert task.early_start is not None and task.early_finish is not None
            task.late_finish = task.early_finish
            task.late_start = task.early_start
            continue

        early = early_instants.get(node_id)
        if early is not None:
            late_instants[node_id] = _apply_milestone_late_date(
                node_id,
                task,
                (early, links.get(node_id, early)),
                g,
                task_map,
                node_cal,
                (project_finish, finish_instant),
                late_instants,
                cal_for,
            )
            continue

        lf_constraints, ls_constraints = _collect_backward_constraints(
            node_id, g, task_map, node_cal, (project_finish, finish_instant), late_instants, cal_for
        )
        _apply_late_dates(task, lf_constraints, ls_constraints, node_cal)

    return late_instants


def _late_refs(
    succ_id: str,
    succ: Task,
    late_instants: dict[str, date],
    cal_for: Callable[[str], Calendar],
    link: tuple[Dependency, bool, date],
) -> tuple[date, date]:
    """``(start_ref, finish_ref)`` a live successor's late window offers its predecessor.

    ``link`` is ``(dep, pred_is_milestone, project_finish)``: a milestone successor's
    start reference depends on how that link would show it (:func:`_link_start_ref`),
    and so does the finish reference an SF link inverts against
    (:func:`_link_finish_ref`, #4431).
    """
    late = late_instants.get(succ_id)
    if late is not None:
        succ_cal = cal_for(succ_id)
        start_ref = _milestone_refs(late)[0]
        dep, pred_is_milestone, project_finish = link
        return (
            _link_start_ref(
                start_ref, dep.dep_type, dep.lag, pred_is_milestone, succ_cal, project_finish
            ),
            _link_finish_ref(late, dep.dep_type, succ_cal, project_finish),
        )
    assert succ.late_start is not None and succ.late_finish is not None
    return succ.late_start, succ.late_finish


def _apply_milestone_late_date(
    node_id: str,
    task: Task,
    early_pair: tuple[_Instant, _Instant],
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    node_cal: Calendar,
    finish: tuple[date, date],
    late_instants: dict[str, date],
    cal_for: Callable[[str], Calendar],
) -> date:
    """Set a milestone's late date (``late_start == late_finish``); return its instant.

    The latest instant every live successor link still admits, capped at the
    project's finish (:func:`_milestone_finish_bound`; ``finish`` is
    ``(project_finish, finish_instant)``) and floored at the early instant for the
    same coordinate-system reason as :func:`_apply_late_dates` (#4079).

    ``early_pair`` is ``(shown, link)`` (:func:`_place_milestone`). The returned
    instant, which predecessors read, is floored at ``link``; the shown late date
    at ``shown`` (#4225).
    """
    early, link = early_pair
    project_finish, finish_instant = finish
    bounds: list[date] = [_milestone_finish_bound(finish_instant, project_finish, node_cal)]
    for succ_id in g.successors(node_id):
        succ = task_map[succ_id]
        if _is_complete(succ):
            continue
        dep: Dependency = g[node_id][succ_id]["dep"]
        if succ_id in late_instants:
            dep = _milestone_link(dep)
        start_ref, finish_ref = _late_refs(
            succ_id, succ, late_instants, cal_for, (dep, True, project_finish)
        )
        bounds.append(_milestone_latest(dep.dep_type, dep.lag, start_ref, finish_ref, node_cal))
    late = max(min(bounds), link[0])
    task.late_start = task.late_finish = _late_display(
        max(late, early[0]), task, early, node_cal, project_finish
    )
    return late


def _collect_backward_constraints(
    node_id: str,
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    node_cal: Calendar,
    finish: tuple[date, date],
    late_instants: dict[str, date],
    cal_for: Callable[[str], Calendar],
) -> tuple[list[date], list[date]]:
    """Gather the LF and LS constraints this task's successors impose on it.

    ``finish`` is ``(project_finish, finish_instant)``; ``finish_instant`` is the
    midnight the project ends (the day after ``project_finish`` unless a
    start-of-day milestone ends it, #4079). The
    project-finish seed floors the task's late finish at the project end, but
    snapped to *this node's own* last workable day: ``project_finish`` is
    ``max(early_finish)`` across all tasks and can land on a day this node cannot
    work — a completed task's weekend ``actual_finish`` (single calendar) or a max
    EF contributed by a 7-day-calendar task (per-task calendars, ADR-0120). Seeding
    the raw value would overstate this task's float by ≥1 and propagate the error
    upstream through backward-pass edges (#1820). With one project calendar and no
    out-of-sequence weekend actuals, ``project_finish`` is itself a working day and
    this is a no-op.

    A completed successor is out of network logic (ADR-0136): the forward pass lays
    it at its actuals, possibly out of sequence, and it carries zero float, so it
    imposes no backward constraint on a still-live predecessor. Including it would
    clamp this task's late dates to the done successor's actuals — reporting
    false-zero float and polluting the critical path (#1819).

    Every bound produced here is snapped to a working day, so none of them can
    express an early window that sits on a non-working day; the coordinate-system
    mismatch that creates is resolved once, in :func:`_apply_late_dates` (#3963),
    rather than by special-casing each constraint.
    """
    project_finish, finish_instant = finish
    lf_constraints: list[date] = [
        _prev_working_day(_safe_offset(finish_instant, -_ONE_DAY), node_cal)
    ]
    ls_constraints: list[date] = []
    task = task_map[node_id]

    for succ_id in g.successors(node_id):
        succ = task_map[succ_id]
        if _is_complete(succ):
            continue
        dep: Dependency = g[node_id][succ_id]["dep"]
        if _start_fixed_link(task, dep):
            # Measured from a start that already happened (#4523): no slip of this
            # task's remaining work can move the successor through it.
            continue
        if succ_id in late_instants:
            dep = _milestone_link(dep)
        start_ref, finish_ref = _late_refs(
            succ_id, succ, late_instants, cal_for, (dep, False, project_finish)
        )
        _append_successor_constraint(
            dep, start_ref, finish_ref, node_cal, lf_constraints, ls_constraints, task
        )

    return lf_constraints, ls_constraints


def _append_successor_constraint(
    dep: Dependency,
    succ_start: date,
    succ_finish: date,
    node_cal: Calendar,
    lf_constraints: list[date],
    ls_constraints: list[date],
    task: Task | None = None,
) -> None:
    """Translate one successor edge into an LF or LS bound on the predecessor.

    An SS/SF bound is on the start the link measures from (:func:`_link_start`);
    for a predecessor whose span start is derived it is moved onto the
    remaining-work window the late dates describe (:func:`_window_start_bound`,
    #4523). ``task`` is that predecessor; ``None`` keeps the bound as is.

    Each result becomes *this* task's own late date, so it snaps to a working day on
    this task's own calendar (``node_cal``) — snapping on the successor's calendar
    instead (the #1490 bug) could push it before its own early_finish.

    ``succ_start``/``succ_finish`` are the successor's late start and late finish,
    or — for a milestone successor — the working-day positions of its late instant
    (:func:`_milestone_refs`, #4079).
    """
    lag = dep.lag

    if dep.dep_type == DependencyType.FS:
        # Predecessor must finish the day before successor's late start minus lag.
        lf_constraints.append(
            _prev_working_day(_safe_offset(succ_start, -timedelta(days=1) - lag), node_cal)
        )
    elif dep.dep_type == DependencyType.SS:
        # Predecessor must start no later than successor's late start minus lag.
        bound = _retreat_calendar_days(succ_start, lag, node_cal)
        ls_constraints.append(bound if task is None else _window_start_bound(bound, task, node_cal))
    elif dep.dep_type == DependencyType.FF:
        # Predecessor must finish no later than successor's late finish minus lag.
        lf_constraints.append(_retreat_calendar_days(succ_finish, lag, node_cal))
    elif dep.dep_type == DependencyType.SF:
        # Predecessor must start no later than the first working day after the
        # successor's late finish minus lag: its SF anchor is the working day
        # *before* its start, so it may start one working day beyond that bound
        # (#4145). A positive lag anchors on ``start - 1`` itself (#4333).
        bound = _sf_latest_start(succ_finish, lag, node_cal)
        ls_constraints.append(bound if task is None else _window_start_bound(bound, task, node_cal))


def _apply_late_dates(
    task: Task,
    lf_constraints: list[date],
    ls_constraints: list[date],
    node_cal: Calendar,
) -> None:
    """Set ``late_finish``/``late_start`` from the binding constraints, in place.

    The late window is finally floored at the task's own early window (#3963): a
    late date is never earlier than its early counterpart. That is not a tie-break
    or a tolerance — a task asked to finish before the day it can finish has an
    incoherent window that no consumer can draw, and ``late_start``/``late_finish``
    are persisted and read by the web float bar
    (``packages/web/src/hooks/useScheduleTasks.ts``), which renders the span
    backwards. ``_working_days_between`` clamps the negative span to ``0`` on the
    way into ``total_float``, so the task is additionally reported as *critical*
    and the evidence is erased.

    It is needed because the two passes work in different coordinate systems on
    exactly one class of input. An early window may sit on a **non-working day** —
    a recorded ``actual_start`` is kept verbatim (ADR-0132 §2). (A live
    zero-duration milestone no longer reaches this function: it is an instant, and
    :func:`_apply_milestone_late_date` places it — #4079. The milestone example
    below is kept because it is the history of this floor.) Every backward bound, by
    contrast, is ``_prev_working_day``-snapped (:func:`_collect_backward_constraints`,
    :func:`_append_successor_constraint`) and so *cannot* name that day: a milestone
    pinned to a Saturday whose successor starts Monday gets a late finish of Friday.
    Friday and Saturday are the same position in working-day arithmetic — the float
    is genuinely zero either way — so raising the late window to the early one picks
    the coherent representation of an already-correct answer rather than discarding
    a constraint. For every window that lies on working days the floor is a no-op.

    Stated once here rather than at each constraint site: the bounds are produced
    in four places, and a rule spread across four snaps is the shape that let the
    #3963 class survive four previous fixes (#1830, #1929, #2461, #1827).

    **It is not a purely local correction — say so rather than let it surprise.**
    This pass runs in reverse topological order and
    :func:`_append_successor_constraint` reads ``succ.late_start``, so raising one
    task's late window propagates upstream: on ``P -FS-> M(milestone, actual_start
    = Sat) -FS-> S``, ``P``'s total float goes from 1 working day to 2, and ``P``
    carries no actual and sits entirely on working days. The new number is the
    right one — ``P`` really can finish a day later and still let ``M`` begin on
    its recorded Saturday — but "representational" describes the *choice between
    two encodings of the same float*, not the blast radius, and a predecessor's
    ``late_start``, ``late_finish`` and ``total_float`` all move.
    """
    duration_days = _effective_duration_days(task)

    # LF = earliest of all LF constraints (binding constraint).
    task.late_finish = min(lf_constraints)
    task.late_start = _start_from_finish(task.late_finish, duration_days, node_cal)

    # Apply LS constraints (from SS/SF dependencies).
    if ls_constraints:
        max_ls = min(ls_constraints)
        if max_ls < task.late_start:
            task.late_start = max_ls
            # Push LF forward to match.
            fwd_finish = _finish_from_start(task.late_start, duration_days, node_cal)
            task.late_finish = min(fwd_finish, min(lf_constraints))

    assert task.early_start is not None and task.early_finish is not None
    task.late_finish = max(task.late_finish, task.early_finish)
    task.late_start = max(task.late_start, task.early_start)


def _compute_floats(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    calendar: Calendar,
    wd_counter: _WorkingDayCounter | None = None,
    task_calendars: dict[str, Calendar] | None = None,
    instants: dict[str, _Instant] | None = None,
    late_instants: dict[str, date] | None = None,
    link_instants: dict[str, _Instant] | None = None,
    free_instants_out: dict[str, date] | None = None,
) -> list[DrivingEdge]:
    """Compute total_float, free_float, and is_critical for every task (in-place).

    Returns the list of :class:`DrivingEdge` s discovered as a side output of the
    free-float slack loop — links whose relationship free float is zero (#2095).

    ``total_float`` is the working-day span between a task's early and late start;
    a task is ``is_critical`` when it is zero.

    ``free_float`` is the number of working days a task can slip without delaying
    the early start (FS/SS links) or the early finish (FF/SF links) of *any* of
    its successors — the standard critical-path-method definition of free float,
    evaluated across **all four** dependency types. Like total float it is computed
    by **inverting** the forward constraint (the same inversion the backward pass
    applies for late dates), anchored on each successor's *early* date: for every
    link we find the latest date this task could finish/start that still leaves the
    successor's early date untouched, and take the working-day slip to it. Free
    float is the minimum of those slacks, capped at total float; a task with no
    live successor falls back to its total float. (Earlier versions inspected FS
    successors only and let SS/FF/SF tasks report ``free_float == total_float``;
    that FS-only caveat was removed in #825. Earlier still, the slack was measured
    from the *forward*-imposed date instead of the inverse constraint — a proxy
    that diverged whenever a calendar-day lag re-landed across non-working days as
    the task slipped, #1828.)

    Per-task calendars (ADR-0120 D3): every span — total-float and each free-float
    slack — is measured on the task's *own* calendar, because the slip is counted
    in that task's working days; each free-float constraint is snapped on that same
    calendar, mirroring the backward pass. With one project calendar every span
    resolves to ``calendar`` and the fast ``wd_counter`` is used for all of them.

    A milestone's spans are measured between *instants* (#4079): its early instant
    (``instants``, from :func:`_forward_pass`) and, in ``late_instants``, the late
    instant its own float runs to — :func:`_backward_pass`'s instant already capped
    by :func:`_float_late_instant` (#4183), not the raw one. The day a milestone is
    shown on can name the end of Tuesday as "Tuesday" and the start of Wednesday as
    "Wednesday", one instant apart by zero working days, so a span between shown
    days would miscount.

    ``link_instants`` is :func:`_forward_pass`'s link map (#4225): a milestone's own
    floats run from its shown instant, its successors' free-float stretch from the
    instant they measure from.

    ``free_instants_out``, when given, receives the milestone free-float instants
    computed here, so :func:`schedule` can hand them to :mod:`derive` instead of it
    rebuilding the graph to recompute the same map (#4524).
    """
    early_instants = instants or {}
    lates = late_instants or {}
    links = link_instants or {}

    # Driving edges (#2095): links whose per-edge free-float slack is zero — the
    # predecessor that pins the successor's early date. Collected as a side output
    # of the same slack loop that computes free float; purely presentational.
    driving_edges: list[DrivingEdge] = []
    # Free float compares a milestone successor by its shown position, not its raw
    # instant (#4180).
    free_instants = _milestone_free_instants(
        topo_order,
        g,
        task_map,
        early_instants,
        lambda tid: calendar if task_calendars is None else task_calendars.get(tid, calendar),
        links,
    )
    if free_instants_out is not None:
        free_instants_out.update(free_instants)

    for node_id in topo_order:
        task = task_map[node_id]
        node_cal = calendar if task_calendars is None else task_calendars.get(node_id, calendar)

        # Total float: working days between early_start and late_start.
        # A task is critical when this is zero (cannot be delayed at all).
        # All passes have run by now, so these fields are always set.
        assert task.early_start is not None and task.late_start is not None
        assert task.early_finish is not None
        early = early_instants.get(node_id)
        if early is not None and node_id in lates:
            tf_days = _wd_span(
                early[0],
                lates[node_id],
                node_cal,
                wd_counter,
                calendar,
            )
        else:
            tf_days = _wd_span(task.early_start, task.late_start, node_cal, wd_counter, calendar)
        task.total_float = timedelta(days=tf_days)
        # A completed task is never on the critical path. The backward pass pins a
        # done task to late == early (ADR-0132/0136), which mechanically yields
        # zero total float — but a finished task has no remaining work and no slack
        # to manage, so it cannot drive the project finish and must not be reported
        # as critical (nor pull the completed prefix of the schedule into the
        # critical_path list). Completion overrides the zero-float rule; total_float
        # stays 0 because the task genuinely has no slack (#1863).
        task.is_critical = tf_days == 0 and not _is_complete(task)

        # Free float: the largest number of working days this task can slip before
        # it would push the early date of *any* live successor. Like total float,
        # it must **invert** the forward constraint rather than approximate it. For
        # each link we compute the latest date this task could finish (FS/FF) or
        # start (SS/SF) that still leaves the successor's early date untouched —
        # applying the *same* calendar-day retreat the backward pass uses for late
        # dates (see :func:`_backward_pass`), but anchored on the successor's
        # **early** dates (not late), which is exactly what turns the result into
        # free float rather than total float. Free float is the working-day slip
        # from this task's own early date to that latest date, minimized over all
        # successors and capped at total float; a task with no live successor falls
        # back to its total float.
        #
        # The earlier version instead measured the working-day gap between the
        # *forward*-imposed date and the successor's early date. That proxy assumes
        # one working day of slip moves the imposed date by one working day, which
        # fails whenever a calendar-day lag re-lands across non-working days as the
        # task slips: a single working day of slip can jump the imposed date by
        # several working days (or none), so the proxy both over- and under-counted
        # the true slack (#1828). Inverting the constraint — the way total float
        # already does — is exact for every dep type and lag.
        #
        # The slip is measured in *this* task's working days, and each constraint
        # is snapped on this task's own calendar (``node_cal``) — mirroring the
        # backward pass, whose retreat also lands on ``node_cal``. With one project
        # calendar every span resolves to ``calendar`` and the fast counter is used.
        ff_days = _free_float_days(
            node_id,
            task,
            g,
            task_map,
            node_cal,
            tf_days,
            wd_counter,
            calendar,
            driving_edges,
            (early_instants, links),
            task_calendars,
            free_instants,
        )
        task.free_float = timedelta(days=max(0, ff_days))

    return driving_edges


def _wd_span(
    start: date,
    end: date,
    cal: Calendar,
    wd_counter: _WorkingDayCounter | None,
    calendar: Calendar,
) -> int:
    """Working-day span, via the O(log n) counter when it is valid for ``cal``.

    The counter is built over the default project ``calendar`` (the ``schedule()``
    hot path, #822), so it is only valid for spans measured on that calendar — a
    per-task calendar falls back to the scalar O(span) reference. Both return
    identical counts.
    """
    if wd_counter is not None and cal is calendar:
        return wd_counter.between(start, end)
    return _working_days_between(start, end, cal)


def _free_float_days(
    node_id: str,
    task: Task,
    g: nx.DiGraph[str],
    task_map: dict[str, Task],
    node_cal: Calendar,
    tf_days: int,
    wd_counter: _WorkingDayCounter | None,
    calendar: Calendar,
    driving_edges: list[DrivingEdge],
    instant_maps: tuple[dict[str, _Instant], dict[str, _Instant]],
    task_calendars: dict[str, Calendar] | None,
    free_instants: dict[str, date],
) -> int:
    """Working days this task can slip before it moves any live successor in working time.

    A successor's early start is read at the working day it sits at, so a verbatim
    non-working ``actual_start`` (a Saturday) counts as the Monday after it (#4332);
    every other early date already is a working day.

    Appends to ``driving_edges`` as a side output: a link whose relationship free
    float is zero is the one pinning the successor's early date (#2095). The forward
    pass guarantees ``slack >= 0``, so the exact zero test is deterministic across
    both engines.

    Mirrors the backward pass in skipping completed successors: one is out of
    network logic (ADR-0136) and cannot bound this task's slip, and including it
    would report false-zero free float on the live predecessor (#1819).

    A task with no live successor falls back to its total float.

    ``instant_maps`` is ``(instants, link_instants)``: this task's own slip runs from
    its shown instant, and a zero-lag link carries its link instant's reading into a
    milestone successor (:func:`_place_milestone`, #4225).
    """
    instants, links = instant_maps
    ff_days = tf_days
    for succ_id in g.successors(node_id):
        succ = task_map[succ_id]
        if _is_complete(succ):
            continue
        dep: Dependency = g[node_id][succ_id]["dep"]
        assert succ.early_start is not None and succ.early_finish is not None
        succ_instant = instants.get(succ_id)
        succ_free = free_instants.get(succ_id)
        # The driving edge keeps the link's own type; the arithmetic below uses the
        # type a milestone successor sees (FF is FS, #4272).
        label = dep.dep_type.value
        if succ_free is not None:
            dep = _milestone_link(dep)
        own = instants.get(node_id)
        own_instant = None if own is None else own[0]
        own_link = links.get(node_id, own)
        succ_cal = calendar if task_calendars is None else task_calendars.get(succ_id, calendar)
        if succ_free is None:
            # A work successor is measured from the working day its start sits at,
            # not the raw date (#4332). The only early start that can fall on a
            # non-working day is a live task's verbatim ``actual_start`` (ADR-0132
            # §2), and a Saturday start is the same working-time position as the
            # Monday after it — total float already counts it that way, giving
            # zero working days from Saturday to Monday. Inverting from the raw
            # Saturday instead retreated an SS link to the Friday before, so a
            # predecessor whose link imposes Friday read zero slack and was
            # reported as the driver, although its slip to Monday leaves the
            # successor's working-time start and its finish where they are — the
            # actual start is what holds the task, and the predecessor kept the
            # day of total float that proved it. Every inversion in
            # :func:`_link_slack` assumes a working-day reference, as the late
            # dates the backward pass feeds the same formulas always are; the
            # snap is the identity for every other successor.
            refs = raw_refs = (_next_working_day(succ.early_start, succ_cal), succ.early_finish)
        else:
            # The free-float instant a lagged milestone successor is measured at
            # (#4180) is the baseline both the slack and the driving-edge check use.
            raw_refs = _milestone_refs(succ_free)
            # A tie that flips the milestone's reading moves it (#4183), layered on
            # top of that free instant. The two adjustments never both act on the
            # same instant: #4180 only advances one that reads as start of day, and
            # #4183's tie bound only adjusts one that reads as end of day.
            assert succ_instant is not None  # free_instants mirrors instants' domain
            start_ref = _free_start_ref(
                (succ_free, succ_instant[1]), dep.dep_type, dep.lag, own_link, succ_cal
            )
            refs = (start_ref, raw_refs[1])
        slack = _link_slack(dep, task, refs, own_instant, node_cal, wd_counter, calendar)
        if not _start_fixed_link(task, dep):
            # A link measured from a recorded start (#4523) limits nothing this
            # task's remaining work can do; it is still checked for driving below.
            ff_days = min(ff_days, max(0, slack))
        # Whether a link *drives* is read off the free instant, not #4183's further
        # tie adjustment: a link bounded only by a reading tie does not set the
        # milestone's instant, another link does, so it is not the milestone's
        # driving predecessor even at zero free float.
        if refs != raw_refs:
            slack = _link_slack(dep, task, raw_refs, own_instant, node_cal, wd_counter, calendar)
        if slack == 0:
            driving_edges.append(DrivingEdge(node_id, succ_id, label))
    return ff_days


def _link_slack(
    dep: Dependency,
    task: Task,
    succ_refs: tuple[date, date],
    instant: date | None,
    node_cal: Calendar,
    wd_counter: _WorkingDayCounter | None,
    calendar: Calendar,
) -> int:
    """Slip this task can absorb on one link without moving the successor's early date.

    Computed by **inverting** the forward constraint — the same inversion the
    backward pass applies for late dates — but anchored on the successor's *early*
    dates, which is exactly what makes the result free float rather than total float.

    The earlier version instead measured the working-day gap between the *forward*-
    imposed date and the successor's early date. That proxy assumes one working day
    of slip moves the imposed date by one working day, which fails whenever a
    calendar-day lag re-lands across non-working days as the task slips: a single
    working day of slip can jump the imposed date by several working days (or none),
    so the proxy both over- and under-counted the true slack (#1828).

    ``succ_refs`` is a work successor's ``(early_start, early_finish)`` with the start
    snapped to the working day it sits at (#4332, see :func:`_free_float_days`), or a milestone
    successor's references at its free-float instant (:func:`_milestone_refs` of
    :func:`_milestone_free_instants`); ``instant`` is
    this task's own early instant when it is a milestone (#4079), whose slip is
    measured between instants.
    """
    assert task.early_start is not None and task.early_finish is not None
    succ_start, succ_finish = succ_refs
    lag = dep.lag

    if instant is not None:
        latest = _milestone_latest(dep.dep_type, lag, succ_start, succ_finish, node_cal)
        if latest < instant:
            return -_wd_span(latest, instant, node_cal, wd_counter, calendar)
        return _wd_span(instant, latest, node_cal, wd_counter, calendar)
    if dep.dep_type == DependencyType.FS:
        # Latest finish that leaves succ.early_start unmoved (inverse of the
        # forward FS constraint; matches the backward pass's LF retreat).
        latest = _prev_working_day(_safe_offset(succ_start, -timedelta(days=1) - lag), node_cal)
        return _wd_span(task.early_finish, latest, node_cal, wd_counter, calendar)
    if dep.dep_type == DependencyType.SS:
        # Measured from the start the link anchors on: a started task's recorded
        # start (#4523, :func:`_link_start`), where only the zero test for a
        # driving edge reads it (:func:`_free_float_days`).
        latest = _retreat_calendar_days(succ_start, lag, node_cal)
        return _wd_span(_link_start(task), latest, node_cal, wd_counter, calendar)
    if dep.dep_type == DependencyType.FF:
        latest = _retreat_calendar_days(succ_finish, lag, node_cal)
        return _wd_span(task.early_finish, latest, node_cal, wd_counter, calendar)
    # SF: the successor's finish is bounded by the working day before this task's
    # start, so the latest start is one working day past the retreated bound (#4145);
    # with a positive lag, by the day before it (#4333, :func:`_sf_latest_start`).
    latest = _sf_latest_start(succ_finish, lag, node_cal)
    return _wd_span(_link_start(task), latest, node_cal, wd_counter, calendar)


# ---------------------------------------------------------------------------
# Summary task dependency expansion
# ---------------------------------------------------------------------------


def _check_children_map(children_map: dict[str, list[str]]) -> None:
    """Validate a children_map's shape before it drives leaf expansion (#1070, #1825).

    Rejects a summary entry with an empty child list (#1070): ``_collect_leaves``
    treats a node with no children as a leaf, so an empty entry made the summary id
    *itself* survive expansion as a leaf — while ``expand_summary_dependencies``
    removed it from the task list, leaving a dangling edge that later failed with a
    generic "unknown task" ValueError far from the actual mistake.

    Also rejects a non-list child value (#1825): ``expand_summary_dependencies`` is
    the twin of ``find_cycle`` (which already guards this at its own entry point),
    and both funnel through here. Without the guard a non-list value leaks a bare
    ``TypeError`` from ``reversed()`` in ``_collect_leaves`` — and, worse, a *string*
    value silently iterates its characters as child ids, producing corrupt expanded
    dependencies with no error at all.

    Also rejects a non-string child id (#4522): a ``None`` or unhashable (list/dict)
    entry otherwise reaches ``children_map.get(node)`` inside ``_collect_leaves`` and
    either leaks a bare ``TypeError`` ("unhashable type") or — for ``None``, which
    *is* hashable — is silently accepted as a leaf id, producing a
    :class:`Dependency` whose endpoint is ``None`` instead of a task id, with no
    error at all. Every task/dependency id elsewhere in this module is required to
    be a string (:func:`_require_str`); a child id is no exception.

    Also rejects a non-string summary id (key, #4522): an ``int`` (or other
    non-string) key never matches a string edge/task endpoint, so the whole entry
    silently becomes a dead no-op instead of being refused as the malformed input
    it is.
    """
    if not isinstance(children_map, dict):
        raise InvalidScheduleInput(
            f"children_map must be a dict of summary id -> child ids "
            f"(got {type(children_map).__name__})."
        )
    for sid, kids in children_map.items():
        if not isinstance(sid, str):
            raise InvalidScheduleInput(
                f"children_map contains a non-string summary id "
                f"(got {type(sid).__name__}: {sid!r})."
            )
        if not isinstance(kids, list):
            raise InvalidScheduleInput(
                f"children_map[{sid!r}] must be a list of child ids (got {kids!r})."
            )
        if not kids:
            raise InvalidScheduleInput(
                f"Summary task {sid!r} has an empty children list; remove it from "
                "children_map or give it children."
            )
        for child_id in kids:
            if not isinstance(child_id, str):
                raise InvalidScheduleInput(
                    f"children_map[{sid!r}] contains a non-string child id "
                    f"(got {type(child_id).__name__}: {child_id!r})."
                )


def _collect_leaves(
    task_id: str,
    children_map: dict[str, list[str]],
) -> list[str]:
    """Collect leaf task IDs under a summary task.

    A leaf is a task that has no children in children_map. Traversal is
    iterative with an explicit stack and an active-path set, so a malformed
    ``children_map`` (a parent-child cycle, or nesting deeper than Python's
    recursion limit) raises a clean :class:`InvalidScheduleInput` instead of a
    ``RecursionError``. A node legitimately reachable via multiple parents (a
    diamond) is *not* a cycle and still yields its leaf once per path — callers
    deduplicate edges downstream, matching the previous recursive behaviour.
    """
    leaves: list[str] = []
    # Stack entries are (node, is_exit_marker). The exit marker pops the node
    # back off the active path once its whole subtree has been visited.
    stack: list[tuple[str, bool]] = [(task_id, False)]
    path: set[str] = set()
    while stack:
        node, is_exit = stack.pop()
        if is_exit:
            path.discard(node)
            continue
        children = children_map.get(node)
        if not children:
            leaves.append(node)
            # Bound the leaf-*path* count during traversal (#1822). A leaf is yielded
            # once per root-to-leaf path, so a "doubling" children_map (each summary
            # points at the next twice) has 2^depth paths to a single leaf — the
            # exponential list that made ``len(_collect_leaves(...))`` blow up *before*
            # the callers' MAX_EXPANDED_EDGES guard (which reads that length) ever ran.
            # Capping here keeps the walk O(MAX_EXPANDED_EDGES · depth). This never
            # rejects an input the callers would accept: they cap the leaf *product*
            # across an edge at MAX_EXPANDED_EDGES, so a single endpoint exceeding it
            # already forces every incident edge's product over the cap.
            if len(leaves) > MAX_EXPANDED_EDGES:
                raise InvalidScheduleInput(
                    f"Expanding summary dependencies would exceed {MAX_EXPANDED_EDGES:,} "
                    "leaf-level edges: a summary task fans out to that many root-to-leaf "
                    "paths (typically a summary→summary dependency crossing a deep or "
                    "wide WBS). Depend on specific leaf tasks, or split the summary edge."
                )
            continue
        if node in path:
            raise InvalidScheduleInput(f"children_map contains a cycle through task {node!r}.")
        path.add(node)
        stack.append((node, True))
        # Push children in reverse so they pop in declared order (stable output).
        for child_id in reversed(children):
            stack.append((child_id, False))
    return leaves


def expand_summary_dependencies(
    tasks: list[Task],
    deps: list[Dependency],
    children_map: dict[str, list[str]],
) -> SummaryExpansion:
    """Expand summary task dependencies into leaf-level edges.

    Summary tasks (those with entries in children_map) are removed from the
    task list. Dependencies involving summary tasks are fanned out to all
    their leaf descendants, producing a cross-product of edges. Self-referencing
    edges (where predecessor == successor after expansion) are skipped.
    Links that expand onto the same leaf pair are merged by meaning, not list
    order: same type keeps the largest (most binding) lag; different types
    raise :class:`InvalidScheduleInput` (#4434).

    Args:
        tasks: All tasks including summaries.
        deps: Dependencies that may reference summary tasks.
        children_map: Mapping of summary task ID to list of direct child IDs.

    Returns:
        A :class:`SummaryExpansion` whose ``tasks`` are the input tasks with
        summaries removed and whose ``dependencies`` are expanded to leaf-level
        edges. Unpacks as ``leaf_tasks, expanded_deps`` for backward compatibility.

    Raises:
        InvalidScheduleInput: If ``children_map`` is malformed — not a dict, a
            summary id (key) or child id that is not a string (``None`` and
            other non-string ids are refused, #4522), a value that is not a
            list, or a summary with an empty children list.
    """
    if not children_map:
        return SummaryExpansion(tasks=tasks, dependencies=deps)
    _check_children_map(children_map)

    summary_ids = set(children_map.keys())
    leaf_tasks = [t for t in tasks if t.id not in summary_ids]

    _reject_summary_start_links(deps, summary_ids)

    leaves = _resolve_endpoint_leaves(deps, summary_ids, children_map)
    _check_expansion_bound(deps, leaves)

    return SummaryExpansion(tasks=leaf_tasks, dependencies=_cross_product_edges(deps, leaves))


def _reject_summary_start_links(deps: list[Dependency], summary_ids: set[str]) -> None:
    """Reject a Start-to-Start / Start-to-Finish link *from* a summary task (ADR-0370).

    A summary's START is its earliest-starting leaf (ADR-0024 §3, matching MS Project
    semantics), but the leaf cross-product fans a summary edge out to *every* leaf and
    preserves the dep type. For SS/SF that turns the successor's CPM ``max()`` over its
    predecessors into "wait for the LAST-starting leaf" — silently over-constraining the
    successor by up to the summary's whole span (the #1854 bug). FS/FF anchor on the
    summary's FINISH (its latest-finishing leaf), which ``max()`` over all leaves
    computes correctly, so those keep the fan-out.

    Rather than re-anchor to the earliest leaf (alternative a) or synthesize a hammock
    node (alternative b), the link is rejected with an actionable error, matching MS
    Project's own restriction posture. Deliberately kept out of
    :func:`_expand_edges_for_cycle_check` — cycle detection stays conservative and must
    still see the expanded edges.
    """
    for dep in deps:
        if dep.predecessor_id in summary_ids and dep.dep_type in (
            DependencyType.SS,
            DependencyType.SF,
        ):
            raise InvalidScheduleInput(
                f"Start-to-Start/Start-to-Finish dependency from summary task "
                f"{dep.predecessor_id!r} is not supported (ADR-0024); link to a specific "
                "leaf task instead."
            )


def _resolve_endpoint_leaves(
    deps: list[Dependency],
    summary_ids: set[str],
    children_map: dict[str, list[str]],
) -> dict[str, list[str]]:
    """Resolve every edge endpoint to its leaves, once per distinct id (#1208).

    An endpoint id recurs across many edges and ``_collect_leaves`` walks the subtree
    on each call, so resolving per distinct id rather than per edge is what keeps a
    wide WBS cheap. Mirrors the caching the cycle-check twin
    (:func:`_expand_edges_for_cycle_check`) already did — the asymmetry was a missed
    optimization here.
    """
    endpoint_ids = {d.predecessor_id for d in deps} | {d.successor_id for d in deps}
    return {
        nid: (_collect_leaves(nid, children_map) if nid in summary_ids else [nid])
        for nid in endpoint_ids
    }


def _check_expansion_bound(deps: list[Dependency], leaves: dict[str, list[str]]) -> None:
    """Bound the cross product from leaf *counts* before materialising a Dependency (#1208).

    A summary→summary edge fans out to ``len(L(pred)) * len(L(succ))`` objects, so
    without this a wide top-of-WBS edge produces millions of Dependency objects (and a
    graph that then chokes ``schedule()``). The cheap cycle-check path already enforced
    ``MAX_EXPANDED_EDGES`` this way; the expensive real-expansion path was the one
    missing the guard.
    """
    estimated = 0
    for dep in deps:
        estimated += len(leaves[dep.predecessor_id]) * len(leaves[dep.successor_id])
        if estimated > MAX_EXPANDED_EDGES:
            raise InvalidScheduleInput(
                f"Expanding summary dependencies to leaf level would exceed "
                f"{MAX_EXPANDED_EDGES:,} edges. A summary→summary dependency is fanning "
                "out to the cross product of both summaries' leaves — depend on specific "
                "leaf tasks, or split the wide summary edge, and retry."
            )


def _cross_product_edges(deps: list[Dependency], leaves: dict[str, list[str]]) -> list[Dependency]:
    """Fan each edge out to the cross product of its endpoints' leaves.

    Self-referencing edges (predecessor == successor after expansion) are skipped.

    Two source links can expand onto the same leaf pair — ``A -FS-> C`` plus
    ``S(A, B) -FS+7d-> C`` both yield ``A → C``. The engine graph holds one edge per
    pair, so the collision must be resolved, and it must be resolved by *meaning*,
    never by list order (#4434): the API passes DB row order, so "first seen wins"
    let two recalcs of one project produce different finishes and silently dropped
    the binding summary link whenever the leaf link happened to come first.

    - **Same dep type:** both constraints read ``succ_X >= pred_Y + lag`` on the same
      anchors, so the larger lag implies the smaller one. Keep the largest lag — the
      merged edge is exactly the conjunction of both links.
    - **Different dep types:** the two constrain different anchors and neither
      implies the other, so no single edge can represent both. Reject with
      :class:`InvalidScheduleInput` naming both source links rather than silently
      dropping one.

    The surviving edge keeps the position of the pair's first occurrence, so the
    output order is stable for a given input while its *content* is order-independent.
    """
    chosen: dict[tuple[str, str], tuple[Dependency, Dependency]] = {}

    for dep in deps:
        for p in leaves[dep.predecessor_id]:
            for s in leaves[dep.successor_id]:
                if p == s:
                    continue
                prior = chosen.get((p, s))
                if prior is not None:
                    _, prior_source = prior
                    if prior_source.dep_type != dep.dep_type:
                        raise InvalidScheduleInput(
                            f"Dependencies {_describe_link(prior_source)} and "
                            f"{_describe_link(dep)} both resolve to leaf link {p!r} → "
                            f"{s!r} with different types ({prior_source.dep_type.value} vs "
                            f"{dep.dep_type.value}); a task pair can hold only one "
                            "dependency type. Remove one link or change its type to match."
                        )
                    if dep.lag <= prior_source.lag:
                        continue
                    # A dict update keeps the key's original insertion position.
                chosen[(p, s)] = (
                    Dependency(
                        predecessor_id=p, successor_id=s, dep_type=dep.dep_type, lag=dep.lag
                    ),
                    dep,
                )

    return [edge for edge, _ in chosen.values()]


def _describe_link(dep: Dependency) -> str:
    """Render a source link for an error message, e.g. ``'S' → 'C' (FS, lag 7d)``."""
    return (
        f"{dep.predecessor_id!r} → {dep.successor_id!r} ({dep.dep_type.value}, lag {dep.lag.days}d)"
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


def _velocity_mean(project: Project) -> float | None:
    """Mean of the project's *positive* velocity samples, or ``None`` with no signal.

    The team's mean pace in points per sprint. Non-positive and missing samples are
    dropped rather than averaged in: a zero-throughput sprint would drag the mean
    toward zero and inflate every sprints-to-completion estimate derived from it,
    and the sampler (:func:`_sample_velocity_durations`) bootstraps from the same
    positive-only series — so both must read the same filtered population or the
    horizon bounds stop matching what is actually sampled.
    """
    if not project.velocity_samples:
        return None
    positive = [s for s in project.velocity_samples if s is not None and s > 0]
    if not positive:
        return None
    return sum(positive) / len(positive)


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
            f"Task {task.id!r} velocity horizon is not computable: story_points "
            f"({task.story_points!r}) over mean velocity ({mean!r}) overflows to a "
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
                f"Project {field_name} must be a string, got {type(value).__name__}: {value!r}."
            )
    if not isinstance(project.calendar, Calendar):
        raise InvalidScheduleInput(
            f"Project calendar must be a Calendar instance, got {type(project.calendar).__name__}."
        )
    if not isinstance(project.tasks, list) or any(not isinstance(t, Task) for t in project.tasks):
        raise InvalidScheduleInput(f"Project tasks must be a list of Task, got {project.tasks!r}.")
    # Task.id keys every lookup; a non-str id is unhashable (TypeError), None (bare
    # networkx ValueError), or an int the Rust engine's String serde rejects (#4130).
    # Task.name is likewise a Rust ``String``; Python never reads it during a pass,
    # so without this guard a non-str name schedules silently here and fails in Rust.
    for t in project.tasks:
        if not isinstance(t.id, str):
            raise InvalidScheduleInput(
                f"Task id must be a string, got {type(t.id).__name__}: {t.id!r}."
            )
        if not isinstance(t.name, str):
            raise InvalidScheduleInput(
                f"Task {t.id!r} name must be a string, got {type(t.name).__name__}: {t.name!r}."
            )
    if not isinstance(project.dependencies, list) or any(
        not isinstance(d, Dependency) for d in project.dependencies
    ):
        raise InvalidScheduleInput(
            f"Project dependencies must be a list of Dependency, got {project.dependencies!r}."
        )
    if project.calendars is not None and (
        not isinstance(project.calendars, dict)
        or any(not isinstance(c, Calendar) for c in project.calendars.values())
    ):
        raise InvalidScheduleInput(
            f"Project calendars must be a dict of calendar id to Calendar, got "
            f"{project.calendars!r}."
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
                f"Duplicate task id {t.id!r}; every task must have a unique id."
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
            f"(got {project.calendar.working_days!r})."
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
                    f"Calendar {cal_id!r} working_days must be an integer bitmask "
                    f"(got {cal.working_days!r})."
                )
            if cal.working_days & 0b111_1111 == 0:
                raise InvalidScheduleInput(
                    f"Calendar {cal_id!r} has no working weekday set (working_days bitmask "
                    "is empty); at least one of Mon-Sun must be a working day."
                )
            if len(cal.exceptions) > MAX_CALENDAR_EXCEPTIONS:
                raise InvalidScheduleInput(
                    f"Calendar {cal_id!r} has {len(cal.exceptions)} exception ranges, exceeding "
                    f"the maximum of {MAX_CALENDAR_EXCEPTIONS:,}."
                )
            _validate_calendar_fields(cal, f"Calendar {cal_id!r}")
            _next_working_day(project.start_date, cal)


def _validate_agile_inputs(project: Project) -> None:
    # Non-finite agile inputs crash deep inside the velocity sampler (NaN/inf
    # story_points hit ``int(np.ceil(...))``; an inf velocity sample passes the
    # ``> 0`` filter and poisons the bootstrap mean), so reject them eagerly
    # with the documented exception type (#1070).
    if project.velocity_samples is not None:
        # A direct-object caller (#3846/#1209) can pass a bare scalar (e.g. ``-1``)
        # instead of a list — ``for s in project.velocity_samples`` then leaks a bare
        # TypeError ("'int' object is not iterable") past the documented contract.
        if not isinstance(project.velocity_samples, (list, tuple)):
            raise InvalidScheduleInput(
                f"velocity_samples must be a list of numbers, got {project.velocity_samples!r}."
            )
        for s in project.velocity_samples:
            if s is None:
                continue
            # isinstance gate before math.isfinite (#1209): a string sample would
            # otherwise raise a bare TypeError from isfinite. bool is an int subclass
            # but never a meaningful velocity, so reject it explicitly.
            if not _is_finite_number(s):
                raise InvalidScheduleInput(
                    f"velocity_samples must contain only finite numbers (got {s!r})."
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
            f"sprint_length_days must be an integer (got {project.sprint_length_days!r})."
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
            f"Task {t.id!r} duration must be a timedelta (got {t.duration!r})."
        )
    _require_plain_date(t.planned_start, f"Task {t.id!r} planned_start")
    _require_plain_date(t.actual_start, f"Task {t.id!r} actual_start")
    _require_plain_date(t.actual_finish, f"Task {t.id!r} actual_finish")


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
            f"Task {t.id!r} actual_start must not be after actual_finish "
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
            f"Task {t.id!r} calendar_id must be a string or None, "
            f"not {type(t.calendar_id).__name__}."
        )
    if calendars and t.calendar_id not in calendars:
        raise InvalidScheduleInput(_unknown_calendar_id_message(t.id, t.calendar_id))


def _unknown_calendar_id_message(task_id: str, calendar_id: str) -> str:
    """The refusal both the validator and the resolver raise, so they read identically."""
    return (
        f"Task {task_id!r} calendar_id {calendar_id!r} names no calendar in the "
        "project's calendars registry."
    )


def _validate_task_durations(t: Task) -> None:
    """Duration bounds, plus the ordering of a complete three-point estimate.

    An inconsistent triple (most_likely outside [optimistic, pessimistic], or
    optimistic above pessimistic) used to be silently "handled" by ``_sample_pert``'s
    degenerate fallback — every run sampling the constant most_likely, possibly beyond
    the user's own pessimistic bound (#1069). Partial estimates are not validated:
    Monte Carlo only samples when all three are present.
    """
    _check_duration(t.duration, f"Task {t.id!r} duration")
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
                    f"Task {t.id!r} {field_name} must be a timedelta (got {value!r})."
                )
            _check_duration(value, f"Task {t.id!r} {field_name}")

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
            f"Task {t.id!r} three-point estimates must satisfy "
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
    """``story_points`` and ``percent_complete`` must be finite numbers when set.

    ``percent_complete`` (ADR-0132/0136) feeds ``_effective_duration_days``
    (``int(duration * pct/100)``) and ``_is_complete`` (``pct >= 100``); a NaN there
    raised a bare ValueError from ``int(nan)`` and a non-numeric value a bare TypeError
    from the ``>= 100`` compare, while monte_carlo's own ``pct > 0`` gate silently
    ignored the same NaN — so ``schedule()`` and ``monte_carlo()`` diverged on
    identical input (#1452). The ``from_dict``/``from_json`` path already rejects
    non-finite here (models.py); this closes the direct-object gap to match it.

    ``None`` is tolerated (read as not-started, as both passes already do). A finite
    value outside [0, 100] is rejected too (#4513): the passes would clamp it
    (``min(pct, 100)``; a negative reads as not-started), so a sign-flipped or x100
    import bug (0.5 sent as 50, 50 as 5000) scheduled plausibly and silently.
    Rejecting later would be a breaking narrowing of the input contract.
    """
    if t.story_points is not None and not _is_finite_number(t.story_points):
        raise InvalidScheduleInput(
            f"Task {t.id!r} story_points must be a finite number (got {t.story_points!r})."
        )
    if t.percent_complete is not None and not _is_finite_number(t.percent_complete):
        raise InvalidScheduleInput(
            f"Task {t.id!r} percent_complete must be a finite number (got {t.percent_complete!r})."
        )
    if t.percent_complete is not None and not 0 <= t.percent_complete <= 100:
        raise InvalidScheduleInput(
            f"Task {t.id!r} percent_complete must be between 0 and 100 "
            f"(got {t.percent_complete!r})."
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
            f"Task {t.id!r} planned_start is more than {MAX_PROJECT_SPAN_DAYS} days "
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
                f"Dependency {dep.predecessor_id!r} → {dep.successor_id!r} lag must be a "
                f"timedelta (got {dep.lag!r})."
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
                f"{dep.predecessor_id!r} → {dep.successor_id!r})."
            )
        if not isinstance(dep.dep_type, DependencyType):
            # Same first-run-legibility treatment as the from_dict path (#947): name
            # the field and list the allowed values instead of a bare TypeError from
            # the lag-delta cache key, or a silently no-op comparison against every
            # DependencyType member.
            allowed = ", ".join(dt.value for dt in DependencyType)
            raise InvalidScheduleInput(
                f"Invalid dependency type {dep.dep_type!r}; must be one of: {allowed}."
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
                f"Duplicate dependency {dep.predecessor_id!r} → {dep.successor_id!r}; "
                "each task pair may carry at most one dependency (declare a single "
                "relationship per predecessor/successor pair)."
            )
        seen_edges.add(key)
        # Sub-day lag schedules differently across engines and can drive a late date
        # before an early date (#1818); reject a non-whole-day lag like a duration.
        _check_whole_days(dep.lag, f"Dependency {dep.predecessor_id!r} → {dep.successor_id!r} lag")
        if abs(dep.lag.days) > MAX_LAG_DAYS:
            raise InvalidScheduleInput(
                f"Dependency {dep.predecessor_id!r} → {dep.successor_id!r} lag exceeds "
                f"the maximum of ±{MAX_LAG_DAYS} days (got {dep.lag.days})."
            )


def _task_span_totals(project: Project) -> tuple[int, int, int]:
    """Sum the worst-case task span and find the furthest pin and actual.

    The span uses the worst case across the deterministic duration AND every PERT
    estimate: Monte Carlo samples within ``[optimistic, pessimistic]`` but falls back
    to ``most_likely`` when the range is degenerate, so ``most_likely`` — which a
    partial estimate may set above the deterministic duration — must count too. Scrum
    tasks count their velocity-sampling worst case; without it an oversized
    ``story_points`` bypassed this guard entirely (#1067).

    Recorded actuals (ADR-0132/0136) anchor a completed task's full-duration span and
    feed the same calendar walk (``_start_from_finish`` / ``_finish_from_start``) as a
    ``planned_start`` pin, so an actual far from the project start must be bounded the
    same way — otherwise a year-9999 ``actual_finish`` drives the working-day scan past
    the representable range (the #951 precedent). ``abs()`` bounds both a far-future
    and a far-past actual.

    Returns ``(total_span, max_snet_days, max_actual_days)``.
    """
    total_span = 0
    max_snet_days = 0
    max_actual_days = 0
    for t in project.tasks:
        task_max_days = t.duration.days
        for est in (t.optimistic_duration, t.most_likely_duration, t.pessimistic_duration):
            if est is not None:
                task_max_days = max(task_max_days, est.days)
        task_max_days = max(task_max_days, _velocity_worst_case_days(t, project))
        total_span += max(0, task_max_days)
        if t.planned_start is not None:
            max_snet_days = max(max_snet_days, (t.planned_start - project.start_date).days)
        for actual in (t.actual_start, t.actual_finish):
            if actual is not None:
                max_actual_days = max(max_actual_days, abs((actual - project.start_date).days))
    return total_span, max_snet_days, max_actual_days


def _validate_span_bounds(project: Project) -> None:
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

    # Cumulative span: an upper bound on the longest path (and on the Monte Carlo
    # completion offset, which can sample each task up to its pessimistic
    # duration). Bounding the sum keeps the day-by-day walk and the working-day
    # index build from spinning — or overflowing the date range — no matter how
    # many tasks are chained.
    total_span, max_snet_days, max_actual_days = _task_span_totals(project)
    if max_actual_days > MAX_PROJECT_SPAN_DAYS:
        raise InvalidScheduleInput(
            f"A task actual_start/actual_finish is more than {MAX_PROJECT_SPAN_DAYS} "
            "days from the project start; the schedule cannot be computed within a "
            "representable date range."
        )
    total_span += sum(abs(dep.lag.days) for dep in project.dependencies)
    # A planned_start pin, the data-date floor, and a recorded actual each shift work
    # along the timeline, so the furthest of them adds to the span bound exactly once
    # (they don't accumulate the way durations on a chain do).
    total_span += max(max_snet_days, max(0, status_offset), max_actual_days)
    if total_span > MAX_PROJECT_SPAN_DAYS:
        raise InvalidScheduleInput(
            f"Total project span ({total_span} days across all task durations and lags) "
            f"exceeds the maximum of {MAX_PROJECT_SPAN_DAYS} days; the schedule cannot be "
            "computed within a representable date range."
        )

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
    max_calendar_reach = total_span * 7 + MAX_CALENDAR_SCAN_DAYS
    if (date.max - project.start_date).days < max_calendar_reach:
        raise InvalidScheduleInput(
            f"Project start date {project.start_date.isoformat()} is too close to the "
            f"maximum representable date for a span of {total_span} working days; the "
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


# ---------------------------------------------------------------------------
# Public API: schedule()
# ---------------------------------------------------------------------------


def _require_project(project: object) -> None:
    """Refuse a non-:class:`Project` argument at a public entry point (#4518).

    ``schedule(None)`` and friends otherwise reach ``project.tasks`` and leak a bare
    ``AttributeError`` past the :class:`SchedulerError` contract.
    """
    if not isinstance(project, Project):
        raise InvalidScheduleInput(f"project must be a Project (got {type(project).__name__}).")


def schedule(project: Project) -> ScheduleResult:
    """Run CPM on a project and return a ScheduleResult.

    The dates this returns are **deterministic and optimistic**: the forward pass
    computes the *earliest feasible* schedule, i.e. what happens if every task
    takes exactly its estimated ``duration`` and nothing slips. The project finish
    is therefore a single point on a distribution, not a confidence-weighted
    commitment date — in practice it lands near the P50 of the corresponding
    :func:`monte_carlo` run, so committing to it is close to a coin flip. Callers
    presenting a CPM date to a human should say which of the two it is; see
    :func:`monte_carlo` for the probabilistic counterpart.

    The original project is not mutated; a deep copy is made for computation.

    Every task in ``project.tasks`` is placed in the network and scheduled. The
    engine has no concept of a recurring or template task: recurrence is a domain
    concern that callers must resolve before invoking the engine. Callers must
    therefore exclude any task that should not occupy the schedule (e.g. a
    recurring-task template) *before* calling — passing one in is not an error,
    it is simply scheduled like any other task. Keeping this boundary explicit
    stops a future contributor from "helpfully" teaching the engine about
    recurrence and breaking the separation.

    Args:
        project: The project to schedule. Must have at least one task.

    Returns:
        ScheduleResult with ES/EF/LS/LF/float computed for every task
        and the critical path identified. The result contains exactly one entry
        per input task.

        Note: ``free_float``, ``total_float``, and ``is_critical`` are all
        dependency-type complete — each accounts for FS/SS/FF/SF links per the
        standard free-/total-float definitions.

        Note: the order of ``ScheduleResult.tasks`` is **unspecified** and differs
        between the Python and Rust/WASM engines (#1862) — retrieve a task by its
        ``id``, never by list position.

    Raises:
        CyclicDependencyError: If the dependency graph contains a cycle.
        InvalidScheduleInput: If the calendar has no working day, or a duration
            or lag is negative/out of range.
        InvalidScheduleInput: Also if ``project`` is not a :class:`Project`.
        ValueError: If a dependency references an unknown task ID.
    """
    _require_project(project)
    if not project.tasks:
        raise InvalidScheduleInput("Project must have at least one task.")
    _validate_project(project)

    g = _build_graph(project)

    # Detect cycles via the topological sort itself: it raises NetworkXUnfeasible
    # on a cycle in ~3ms, versus ~148ms for an eager nx.find_cycle on every
    # happy-path call at 5K tasks (#1526). find_cycle runs only on the error
    # path, inside _raise_cycle_error, to rebuild the cycle for the message.
    try:
        topo_order: list[str] = list(nx.topological_sort(g))
    except nx.NetworkXUnfeasible:
        _raise_cycle_error(g)

    # Isolate the caller's input (schedule() must not mutate project.tasks) with
    # a shallow copy: every Task field is an immutable scalar (str/date/timedelta/
    # float/enum/None) and each CPM pass *reassigns* the computed attributes
    # rather than mutating a shared container, so copy.copy is semantically
    # identical to the prior copy.deepcopy at ~10x the speed — deepcopy spent
    # ~113ms recursing over 5K tasks for no benefit (#1526). If a mutable field
    # is ever added to Task, this shallow copy must be revisited.
    tasks = [copy.copy(t) for t in project.tasks]
    task_map = {t.id: t for t in tasks}

    # Per-task calendars (ADR-0120 D3): resolved once and threaded through every
    # pass. ``None`` when the project declares no ``calendars`` registry — the
    # single-calendar fast path, identical to the pre-ADR-0120 behavior.
    task_calendars = _resolve_task_calendars(project)

    link_instants: dict[str, _Instant] = {}
    instants = _forward_pass(
        task_map,
        topo_order,
        g,
        project.start_date,
        project.calendar,
        project.status_date,
        task_calendars,
        link_instants,
    )

    # Project finish = latest early_finish across all tasks.
    # Forward pass guarantees every task has early_finish set.
    project_finish: date = max(t.early_finish for t in tasks if t.early_finish is not None)

    late_instants = _backward_pass(
        task_map,
        topo_order,
        g,
        project_finish,
        project.calendar,
        task_calendars,
        instants,
        link_instants,
    )
    # A milestone's own float stops where its reading would show it past the
    # finish (#4183); its predecessors already read the uncapped instant.
    float_lates = {
        tid: _float_late_instant(
            late,
            instants[tid],
            project.calendar
            if task_calendars is None
            else task_calendars.get(tid, project.calendar),
            project_finish,
        )
        for tid, late in late_instants.items()
    }
    # Precompute a working-day index over the schedule's span so float
    # computation is O(log n) per span instead of O(span) (#822, ADR-0142). Every
    # date _compute_floats measures lies within [earliest early start,
    # project_finish]; the earliest early start is start_date or earlier, since an
    # SF-linked task can be placed before the project start (#4218). The counter is
    # built over the default calendar; per-task-calendar spans fall back to the
    # scalar count inside _compute_floats.
    counter_lo = min(
        [project.start_date, *(t.early_start for t in task_map.values() if t.early_start)]
    )
    wd_counter = _WorkingDayCounter.build(counter_lo, project_finish, project.calendar)
    has_milestone = any(t.duration.days == 0 for t in project.tasks)
    free_instants: dict[str, date] | None = {} if has_milestone else None
    driving_edges = _compute_floats(
        task_map,
        topo_order,
        g,
        project.calendar,
        wd_counter,
        task_calendars,
        instants,
        float_lates,
        link_instants,
        free_instants,
    )

    # Order the critical path deterministically AND topologically. Filtering a
    # topological order keeps every predecessor ahead of its successor; the catch
    # is that plain ``nx.topological_sort`` resolves ties by a networkx-internal
    # rule that the Rust engine's petgraph does not share, so the order would be
    # non-deterministic and cross-engine divergent (#909). A *lexicographic*
    # topological sort keyed by ``(early_start, id)`` is deterministic and
    # engine-agnostic — and, unlike sorting the filtered list by ``(early_start,
    # id)`` directly, it can never place a successor before its predecessor when
    # the two share an equal early_start (e.g. an SS-lag-0 or FF-lag-0 critical
    # pair, where a value-sort would invert them). The Rust engine runs the
    # identical lexicographic Kahn ordering (lib.rs / incremental.rs).
    critical_path = [
        tid
        for tid in nx.lexicographical_topological_sort(
            g, key=lambda tid: (task_map[tid].early_start, tid)
        )
        if task_map[tid].is_critical
    ]

    # Use min(early_start) across all tasks — topo_order[0] is arbitrary when
    # multiple parallel roots exist and may not be the earliest-starting one.
    project_start_date = min(t.early_start for t in tasks if t.early_start is not None)

    result = ScheduleResult(
        project_id=project.id,
        project_start=project_start_date,
        project_finish=project_finish,
        tasks=tasks,
        critical_path=critical_path,
        driving_edges=driving_edges,
    )
    if free_instants is not None:
        # Keep the pass state derive_value would otherwise replay (#4524). Nothing
        # after the backward pass writes to these maps, so they are exactly what
        # _milestone_instants / _project_free_instants would rebuild.
        setattr(
            result,
            _MILESTONE_REPLAY_ATTR,
            _MilestoneReplay(
                project=weakref.ref(project),
                instants=instants,
                late_instants=late_instants,
                finish_instant=_finish_instant(task_map, instants),
                link_instants=link_instants,
                free_instants=free_instants,
            ),
        )
    return result


_MILESTONE_REPLAY_ATTR = "_trueppm_milestone_replay"


@dataclass(frozen=True)
class _MilestoneReplay:
    """The milestone pass state :func:`schedule` computed, kept for :mod:`derive` (#4524).

    A milestone's instants are not in the result, so explaining any value on a
    project with a zero-duration task needs them. Replaying both passes to recover
    them made every such derivation cost a full schedule (~140x at 10k tasks).
    :func:`schedule` already holds the exact maps, so it attaches them to the
    result it returns as a private, non-field attribute — off the dataclass so
    the public field list, ``==``, ``to_dict()`` and ``dataclasses.replace``
    (which drops it) are unchanged.

    ``project`` is a weak reference to the :class:`Project` that was scheduled.
    :func:`_milestone_replay` trusts the maps only for that same object; any other
    project — an equal copy included — falls back to the replay, which is the
    reference behavior. Mutating the scheduled project in place after
    :func:`schedule` is outside the ``derive_value(project, …, result)`` contract,
    which already requires ``result`` to be that project's schedule.
    """

    project: weakref.ref[Project]
    instants: dict[str, _Instant]
    late_instants: dict[str, date]
    finish_instant: date
    link_instants: dict[str, _Instant]
    free_instants: dict[str, date]


def _milestone_replay(
    project: Project, result: ScheduleResult
) -> tuple[dict[str, _Instant], dict[str, date], date, dict[str, _Instant], dict[str, date]]:
    """``(instants, late_instants, finish_instant, link_instants, free_instants)``.

    Read from what :func:`schedule` attached to ``result`` when it scheduled this
    very ``project`` (:class:`_MilestoneReplay`); otherwise — a result built by
    hand, deserialized, or from another engine — replayed with
    :func:`_milestone_instants` and :func:`_project_free_instants`, which compute
    the same maps from scratch (#4524). Callers must not mutate the returned maps:
    they are shared with ``result``.
    """
    cached = getattr(result, _MILESTONE_REPLAY_ATTR, None)
    if isinstance(cached, _MilestoneReplay) and cached.project() is project:
        return (
            cached.instants,
            cached.late_instants,
            cached.finish_instant,
            cached.link_instants,
            cached.free_instants,
        )
    instants, late_instants, finish_instant, link_instants = _milestone_instants(project)
    free_instants = (
        _project_free_instants(project, result.tasks, instants, link_instants) if instants else {}
    )
    return instants, late_instants, finish_instant, link_instants, free_instants


def _milestone_instants(
    project: Project,
) -> tuple[dict[str, _Instant], dict[str, date], date, dict[str, _Instant]]:
    """``(instants, late_instants, finish_instant, link_instants)`` as :func:`schedule` has them.

    Replays the forward and backward passes over copies, which is the only faithful
    source (#4079): a milestone's instant can chain through other milestones
    upstream, and its late instant through milestones downstream. Used by
    :mod:`trueppm_scheduler.derive` (through :func:`_milestone_replay`) only for a
    project with a zero-duration task whose result :func:`schedule` did not produce
    for that same project object — the common path reads the maps :func:`schedule`
    kept (#4524).
    """
    g = _build_graph(project)
    topo_order: list[str] = list(nx.topological_sort(g))
    task_map = {t.id: copy.copy(t) for t in project.tasks}
    task_calendars = _resolve_task_calendars(project)
    link_instants: dict[str, _Instant] = {}
    instants = _forward_pass(
        task_map,
        topo_order,
        g,
        project.start_date,
        project.calendar,
        project.status_date,
        task_calendars,
        link_instants,
    )
    project_finish = max(t.early_finish for t in task_map.values() if t.early_finish is not None)
    late_instants = _backward_pass(
        task_map,
        topo_order,
        g,
        project_finish,
        project.calendar,
        task_calendars,
        instants,
        link_instants,
    )
    return instants, late_instants, _finish_instant(task_map, instants), link_instants


def _project_free_instants(
    project: Project,
    scheduled: list[Task],
    instants: dict[str, _Instant],
    link_instants: dict[str, _Instant] | None = None,
) -> dict[str, date]:
    """:func:`_milestone_free_instants` over a scheduled project, for :mod:`derive` (#4180).

    ``scheduled`` is the result's task list, which carries the early dates the
    project's own (unscheduled) tasks do not.
    """
    g = _build_graph(project)
    task_calendars = _resolve_task_calendars(project)
    return _milestone_free_instants(
        list(nx.topological_sort(g)),
        g,
        {t.id: t for t in scheduled},
        instants,
        lambda tid: (
            project.calendar
            if task_calendars is None
            else task_calendars.get(tid, project.calendar)
        ),
        link_instants,
    )


# ---------------------------------------------------------------------------
# Monte Carlo simulation
# ---------------------------------------------------------------------------


def _sample_pert(
    opt: float,
    ml: float,
    pess: float,
    n: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Sample n durations from a PERT-Beta distribution.

    The convention is a Beta scaled to [opt, pess] and **fitted by method of
    moments to the classic PERT mean ``(opt + 4*ml + pess) / 6`` and standard
    deviation ``(pess - opt) / 6``** — not the lambda=4 Beta-PERT of Vose / @RISK
    (``alpha = 1 + 4(ml - opt)/(pess - opt)``). Both share the mean; the spread
    differs. On a symmetric triple this fit is ~12% tighter than lambda=4 (so its
    P80/P95 land slightly earlier); on a triple whose mode sits at an end it is
    wider (#4133). Switching conventions would move every seeded percentile, so it
    is a semantics change with a migration, not a bugfix (ADR-1245).

    When opt == pess (degenerate task), returns the constant value.
    When estimates are missing, falls back to ml.
    """
    if pess - opt < 1e-9:
        return np.full(n, ml)

    # PERT mean and variance via the standard formulas.
    mu = (opt + 4.0 * ml + pess) / 6.0
    sigma = (pess - opt) / 6.0
    sigma2 = sigma**2

    # Normalize mu to [0, 1] for the Beta parameterisation.
    range_ = pess - opt
    mu_norm = np.clip((mu - opt) / range_, 1e-4, 1.0 - 1e-4)
    var_norm = sigma2 / (range_**2)

    # Method-of-moments Beta parameters.
    kappa = mu_norm * (1.0 - mu_norm) / var_norm - 1.0
    alpha = mu_norm * kappa
    beta_param = (1.0 - mu_norm) * kappa

    # Both parameters must be positive; fall back to constant if degenerate.
    if alpha <= 0 or beta_param <= 0:
        return np.full(n, ml)

    samples = rng.beta(alpha, beta_param, size=n)
    return opt + samples * range_


def _sample_velocity_durations(
    story_points: float,
    velocity_samples: list[float],
    sprint_length_days: int,
    n: int,
    rng: np.random.Generator,
) -> np.ndarray | None:
    """Sample n durations (in working days) for a scrum task from team velocity (#411).

    This is throughput Monte Carlo, not three-point estimation: instead of perturbing
    a duration estimate, it asks "how many sprints to burn down ``story_points`` given
    the team's historical per-sprint throughput?" For each run it bootstrap-samples
    completed-points-per-sprint observations (``velocity_samples``) with replacement,
    accumulates them, and counts the sprints needed to reach ``story_points``; the
    duration is that sprint count times ``sprint_length_days`` working days. A faster team
    (high-throughput draws) finishes in fewer sprints; the slow tail finishes later —
    so the spread reflects velocity variability, the real driver of agile uncertainty.

    Returns ``None`` (caller falls back to the deterministic duration) when there is no
    usable signal: no positive velocity samples, non-positive ``story_points``, or a
    non-positive sprint length. With a single positive sample the result is a constant
    (degenerate distribution) — honest: one data point cannot express variance.
    """
    positive = np.asarray([s for s in velocity_samples if s is not None and s > 0], dtype=float)
    if story_points <= 0 or positive.size == 0 or sprint_length_days <= 0:
        return None

    mean = float(positive.mean())
    # Bound the per-run sprint horizon so a pathologically slow bootstrap path can't
    # spin: 4x the mean-pace sprint count plus a floor. Runs that still haven't burned
    # down by then clamp to the cap (a deep-tail outlier), keeping the sim finite.
    # The absolute MAX_VELOCITY_SPRINTS ceiling bounds the draw matrix (``n x
    # max_sprints`` floats) independently of ``sprint_length_days`` (#1202): without
    # it, ``sprint_length_days=1`` lets the span guard pass a ~360k horizon and a
    # single scrum task allocates multi-GB. _velocity_worst_case_days applies the
    # identical clamp so the MC index stays correctly sized (#1067).
    max_sprints = min(int(np.ceil(story_points / mean)) * 4 + 10, MAX_VELOCITY_SPRINTS)
    draws = rng.choice(positive, size=(n, max_sprints), replace=True)
    cumulative = np.cumsum(draws, axis=1)
    reached = cumulative >= story_points
    sprints_needed = np.where(
        reached.any(axis=1),
        reached.argmax(axis=1) + 1,  # first sprint index that meets the target (+1 = count)
        max_sprints,
    )
    return sprints_needed.astype(np.float64) * float(sprint_length_days)


def _build_working_day_index(start: date, calendar: Calendar, n_working_days: int) -> list[date]:
    """Build a lookup list: working_day_index[k] = the k-th working day from start.

    Used to convert integer working-day offsets (from MC simulation) back to dates.

    Both the initial snap and each subsequent step are guarded against a
    degenerate calendar (see :func:`_scan_for_working_day`), so a Monte Carlo run
    on a project whose ``exceptions`` blanket the schedule raises a documented
    :class:`InvalidScheduleInput` rather than spinning to an ``OverflowError``.
    This is the Monte Carlo counterpart to the snap that guards :func:`schedule`'s
    forward pass — without it the MC path had no calendar-reachability guard.

    ``n_working_days`` counts working days of *this* calendar, so the calendar-day
    span the index reaches depends on how sparse the calendar is. ``monte_carlo``
    passes :func:`_mc_index_size`, the most working days any of its calendars has up
    to :func:`_mc_horizon`'s date bound, so every calendar's index reaches that date
    (#4429). A working-day count summed over task durations does not: on a denser
    calendar it ends before a sparse predecessor's work does.
    """
    result: list[date] = []
    if n_working_days <= 0:
        return result
    current = _next_working_day(start, calendar)
    result.append(current)
    while len(result) < n_working_days:
        current = _scan_for_working_day(current, calendar, forward=True)
        result.append(current)
    return result


def _average_ranks(a: np.ndarray) -> np.ndarray:
    """Return the average (tie-corrected) ranks of a 1-D array.

    This is the ranking convention `scipy.stats.rankdata(method="average")` uses,
    reimplemented with numpy so the scheduler keeps its networkx+numpy-only
    dependency footprint. Ties share the mean of the ranks they span — required
    for a correct Spearman correlation when the data has repeated values (common
    here: completion offsets and sampled durations are discrete working-day
    counts, so ties are the rule, not the exception).
    """
    # The default introsort (unstable) is correct here even with ties: the
    # average-rank convention below groups purely by exact value equality, so the
    # dense rank and the averaged rank are identical no matter how the sort permutes
    # equal elements. The result is therefore tie-order-invariant and deterministic
    # for fixed input — a stable sort would only add cost (#1525).
    sorter = np.argsort(a)
    inv = np.empty(a.shape[0], dtype=np.intp)
    inv[sorter] = np.arange(a.shape[0])
    a_sorted = a[sorter]
    # `obs[i]` marks the start of a new value-group in the sorted array.
    obs = np.r_[True, a_sorted[1:] != a_sorted[:-1]]
    dense = obs.cumsum()[inv]  # 1-based dense rank of each element
    # Cumulative counts at each group boundary; the average rank of a group is the
    # mean of its first and last 1-based positions.
    counts = np.r_[np.nonzero(obs)[0], a.shape[0]]
    ranks: np.ndarray = 0.5 * (counts[dense] + counts[dense - 1] + 1)
    return ranks


def _duration_sensitivity(
    dur_matrix: np.ndarray,
    completion_offsets: np.ndarray,
    topo_order: list[str],
    cap: int,
) -> list[TaskSensitivity]:
    """Rank tasks by how strongly their sampled duration moves the project finish.

    The sensitivity index of a task is ``|spearman(duration, finish)|`` across all
    runs — the @RISK-style duration tornado (ADR-0140). Returns the top ``cap``
    tasks by index, descending. Tasks whose sampled duration has zero variance
    (deterministic, completed, or milestone) cannot move the finish and are
    omitted; if the finish itself has zero variance (fully deterministic project)
    the result is empty.
    """
    runs = completion_offsets.shape[0]
    if runs < 2:
        return []
    # Rank the finish once; if every run finished on the same offset there is no
    # variance to attribute and the whole tornado is empty.
    if np.ptp(completion_offsets) == 0:
        return []
    y = _average_ranks(completion_offsets)
    yc = y - y.mean()
    y_norm = float(np.sqrt(np.dot(yc, yc)))
    # Div-by-zero guard: a norm is sqrt(dot(v, v)) so it is always >= 0; `<= 0.0`
    # is equivalent to `== 0.0` here but avoids a float-equality comparison (S1244).
    if y_norm <= 0.0:
        return []

    scored: list[TaskSensitivity] = []
    for col, tid in enumerate(topo_order):
        x = dur_matrix[:, col]
        # Fast-path: a constant-duration column (completed task, deterministic
        # duration, zero-duration milestone) cannot correlate with the finish.
        # Skip it before paying for the rank sort.
        if np.ptp(x) == 0:
            continue
        xr = _average_ranks(x)
        xc = xr - xr.mean()
        x_norm = float(np.sqrt(np.dot(xc, xc)))
        # Same div-by-zero guard as y_norm above: a norm is always >= 0, so `<= 0.0`
        # matches `== 0.0` without a float-equality comparison (S1244).
        if x_norm <= 0.0:
            continue
        # Clamped to [-1, 1] before abs() (#3765). A Spearman correlation cannot
        # mathematically leave that interval, but this computes it as a raw
        # dot-product ratio, and when the two centred rank vectors are collinear the
        # division rounds to 1.0000000000000002 — an index ABOVE the 0..1 the public
        # contract and ADR-0140 both promise, which the API serializes through a bare
        # FloatField with no max_value straight to the client.
        #
        # The overshoot is latent without the duration floor and reachable with it:
        # flooring collapses a sampled column onto a single tied value, and a
        # tie-dense column ranks to a near-constant vector whose correlation with the
        # finish is exactly ±1 in exact arithmetic — precisely the collinear case that
        # rounds out of range. Measured over 800 sensitivity entries on the same
        # projects and seeds: 0 above 1.0 with the floor off, 105 with it on.
        corr = float(np.clip(np.dot(xc, yc) / (x_norm * y_norm), -1.0, 1.0))
        scored.append(TaskSensitivity(task_id=tid, index=abs(corr)))

    # Sort by index desc; tie-break on task_id so the order is deterministic under
    # a fixed seed regardless of topological insertion order.
    scored.sort(key=lambda s: (-s.index, s.task_id))
    return scored[: max(0, cap)]


_MAX_RUNS_ABSOLUTE = 100_000_000  # hard ceiling on ``runs`` independent of the caller's max_runs


def _validate_monte_carlo_args(
    project: Project,
    runs: int,
    seed: int | None,
    max_runs: int | None,
    max_tasks: int | None,
) -> None:
    """Validate ``monte_carlo()``'s own parameters before any network work.

    Covers the run count, the seed, the embedding-layer caps, and the non-empty
    requirement. The schedule payload itself is validated separately by
    :func:`_validate_project`.
    """
    _require_project(project)
    # ``runs`` is a documented public int param that sizes ``np.empty((runs, ...))``.
    # A non-int leaked a bare TypeError (a str from ``runs < 1``, a float from
    # ``np.empty``) past the SchedulerError contract — the same gap the ``seed``
    # guard below already closes (#1453). bool is an int subclass but never a
    # meaningful run count, so reject it explicitly (#1825).
    if isinstance(runs, bool) or not isinstance(runs, int):
        raise InvalidScheduleInput(f"runs must be a positive integer (got {runs!r}).")
    if runs < 1:
        raise InvalidScheduleInput(f"runs must be a positive integer (got {runs}).")
    # An absurd count otherwise reaches ``np.empty((runs, ...))`` and surfaces as a
    # bare numpy ValueError/MemoryError (#4518).
    if runs > _MAX_RUNS_ABSOLUTE and not (isinstance(max_runs, int) and runs > max_runs):
        raise InvalidScheduleInput(
            f"runs exceeds the maximum of {_MAX_RUNS_ABSOLUTE} (got {runs})."
        )
    for name, cap in (("max_runs", max_runs), ("max_tasks", max_tasks)):
        if cap is not None and (isinstance(cap, bool) or not isinstance(cap, int)):
            raise InvalidScheduleInput(f"{name} must be an integer or None (got {cap!r}).")
    # seed is passed straight to np.random.default_rng(seed); a negative int raises
    # a bare numpy ValueError and a float/non-int a bare TypeError, both escaping the
    # documented SchedulerError contract for a documented public parameter (#1453).
    # Accept None (non-deterministic) or a non-negative int; bool is an int subclass
    # but never a meaningful seed, so reject it like the other numeric guards.
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int) or seed < 0):
        raise InvalidScheduleInput(f"seed must be a non-negative integer or None (got {seed!r}).")
    if max_tasks is not None and len(project.tasks) > max_tasks:
        raise SimulationCapExceeded(
            f"Project task count ({len(project.tasks)}) exceeds the configured "
            f"maximum (max_tasks={max_tasks}); raise max_tasks (or pass None to "
            "disable the cap) to simulate larger projects."
        )
    if max_runs is not None and runs > max_runs:
        raise SimulationCapExceeded(
            f"Requested runs ({runs}) exceeds the configured maximum "
            f"(max_runs={max_runs}); raise max_runs (or pass None to disable the "
            "cap) to allow more iterations."
        )
    if not project.tasks:
        raise InvalidScheduleInput("Project must have at least one task.")


def _floor_sampled_at_duration(dur_matrix: np.ndarray, col: int, base: float) -> None:
    """Clamp one sampled duration column up to the task's deterministic ``duration``.

    ``schedule()`` lays every task out at ``Task.duration``; ``monte_carlo()``
    replaces that with a sampled column whenever the task carries a velocity signal
    or a complete three-point estimate. Nothing bound the two inputs together, so a
    task whose estimates simply sit *below* its planned duration produced a forecast
    earlier than the earliest date the deterministic pass considers feasible — a risk
    tool under-reporting risk, which fails silently and plausibly (#3765, same
    invariant class as #2833).

    Ordering the triple is not enough, and that is the whole reason the floor lives
    here rather than in ``_validate_task_durations``. Requiring
    ``optimistic <= duration <= pessimistic`` still admits ``duration=20`` against
    ``(1, 1, 20)``: the PERT-Beta mass piles onto ``most_likely``, and P95 lands ~13
    working days before the CPM finish. A differential sweep over 600 random projects
    measured *more* violations under bracketing triples (152 p95, 319 p50) than
    without them (83 / 129), because bracketing forces a wide, left-skewed window
    rather than a narrow one. No ordering rule over the triple alone can bind the
    two passes; only a comparison against ``duration`` itself can.

    Rejecting the state instead was the other candidate and was refused on evidence:
    three shipped ingress paths write the triple and the duration independently and
    legitimately — the MS Project importer (PERT Analysis fields are independent of
    ``Duration`` in the source file), ``EstimatesTab`` (each estimate PATCHes on its
    own and never touches ``duration``), and the velocity-suggestion accept, which
    writes ``most_likely_duration`` alone straight through the model. Rejecting would
    have turned all three into hard failures and detonated the next CPM recompute on
    every legacy row, the failure class #1981/#2002/#2005 already paid for.

    What this costs, stated plainly: the optimistic tail below ``duration`` is
    truncated, so a plan deliberately padded above its own estimates reports no
    upside. That is the trade — the simulation answers "how much later than the plan,
    and how likely", and the deterministic pass keeps the last word on the earliest
    feasible date. Reading the smaller of the two answers as the forecast is the one
    outcome that is not defensible.

    Applied after sampling and to every path (velocity, PERT, deterministic) so the
    seeded RNG stream is byte-for-byte unchanged and no source of uncertainty is
    exempt. The deterministic path is already ``base``, so the clamp is a no-op there.
    The elapsed portion of an in-progress task is subtracted from the *sampled* value
    downstream (:func:`_mc_effective_duration`) using the same integer rule
    :func:`_effective_duration_days` applies to ``duration``, so flooring the full
    sampled duration here floors the remaining work by exactly the same amount.
    """
    np.maximum(dur_matrix[:, col], base, out=dur_matrix[:, col])


def _sample_duration_matrix(
    project: Project,
    topo_order: list[str],
    task_map: dict[str, Task],
    runs: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Sample each task's per-run duration column into a ``(runs, n_tasks)`` matrix.

    Durations are sampled column-by-column in ``topo_order`` from the single seeded
    ``rng`` so the stream — and therefore seeded P50/P80/P95 — is independent of
    task insertion order. Each task takes one of three paths in priority order
    (velocity → three-point PERT → deterministic); a completed task's column is
    collapsed to its base duration *after* sampling so the RNG stream is unchanged.

    Every sampled column is then floored at the task's deterministic
    ``duration`` — see :func:`_floor_sampled_at_duration` for why.

    The priority order below is a contract, not an implementation detail: anything
    that wants to *move* a task's sampled duration has to shift whichever input the
    branch that claims it will read. :func:`perturb_task_duration` is the one place
    that encodes it — add a fourth branch here and teach it there, or a what-if on a
    task taking the new branch silently reports a zero risk delta (#3533).
    """
    dur_matrix = np.empty((runs, len(topo_order)), dtype=np.float64)
    for col, tid in enumerate(topo_order):
        t = task_map[tid]
        base = float(t.duration.days)
        velocity_durations: np.ndarray | None = None
        # Agile-aware path (#411): a SCRUM task with committed story points samples
        # from the team's velocity distribution, not its duration estimate. Takes
        # precedence over PERT — the delivery mode is an explicit declaration that
        # uncertainty comes from throughput, not a three-point guess. Falls through
        # to PERT / deterministic when the project carries no velocity signal.
        if (
            t.delivery_mode == DeliveryMode.SCRUM
            and t.story_points is not None
            and project.velocity_samples
            and project.sprint_length_days is not None
        ):
            velocity_durations = _sample_velocity_durations(
                float(t.story_points),
                project.velocity_samples,
                project.sprint_length_days,
                runs,
                rng,
            )
        if velocity_durations is not None:
            dur_matrix[:, col] = velocity_durations
        elif (
            t.optimistic_duration is not None
            and t.most_likely_duration is not None
            and t.pessimistic_duration is not None
        ):
            opt = float(t.optimistic_duration.days)
            ml = float(t.most_likely_duration.days)
            pess = float(t.pessimistic_duration.days)
            dur_matrix[:, col] = _sample_pert(opt, ml, pess, runs, rng)
        else:
            dur_matrix[:, col] = base
        _floor_sampled_at_duration(dur_matrix, col, base)
        # A completed task is pinned to a constant offset pair in the forward pass
        # (its sampled column is never read there), so its sampled duration cannot
        # move the finish — a varying column would surface in the sensitivity tornado
        # as pure bootstrap noise, contradicting the documented contract that
        # completed tasks are omitted (#1827). Collapse the column to a constant so
        # ``np.ptp == 0`` excludes it from the tornado. Done *after* sampling (not by
        # skipping it) so the seeded RNG stream — and therefore every other task's
        # samples and P50/P80/P95 — is byte-for-byte unchanged.
        if _is_complete(t):
            dur_matrix[:, col] = base
    return dur_matrix


def _shift_duration(td: timedelta | None, delta_days: int) -> timedelta | None:
    """Shift a duration by ``delta_days``, flooring at zero; ``None`` passes through.

    A negative delta that would drive a duration below zero clamps to zero rather
    than producing a nonsensical negative duration.
    """
    if td is None:
        return None
    shifted = td + timedelta(days=delta_days)
    return shifted if shifted > timedelta(0) else timedelta(0)


def _shift_remaining_work(project: Project, task: Task, delta_days: int) -> Task:
    """Shift an in-progress task's remaining work, holding its elapsed days constant.

    Returns ``task`` with a new ``duration`` and ``percent_complete`` (and, when the
    shift consumes every remaining day, an ``actual_finish``). Elapsed working days
    are ``floor(duration * pct / 100)`` — the rule :func:`_effective_duration_days`
    and Monte Carlo both apply — and work already done cannot be undone by a
    what-if, so the new duration is ``elapsed + max(0, remaining + delta_days)``.

    The new percentage is placed at the *midpoint* of the band that floors to
    ``elapsed`` — ``(elapsed + 0.5) / new_duration`` — rather than at its lower
    edge, so float rounding in ``elapsed / new_duration * 100`` can never truncate
    one day short. With at least one remaining day that value is strictly below
    100, so the task stays in progress. The original percentage is kept whenever it
    already yields the same elapsed count, so a zero delta changes nothing.

    A pull-in that consumes all remaining work cannot be expressed as an in-progress
    task (the integer rule needs ``pct < 100`` and so always leaves a day), so the
    task becomes complete. A bare 100% is not enough: the engine lays a completed
    task out at its full duration *from its actuals or the project start* (ADR-0136),
    which is a statement about history, not "finished as of now" — it moved the
    finish *later* on a task whose elapsed days outran its ``actual_start``, or that
    had none. The completed task is therefore pinned to finish on the working day
    before the baseline's remaining-work window began: zero remaining days end
    exactly where they would have started, so successors keep the start they would
    have had with nothing left to do. ``actual_start`` is kept unless it falls after
    that finish; when unset, the engine derives it from the finish.
    """
    duration_days = task.duration.days
    pct = min(task.percent_complete or 0.0, 100.0)
    elapsed = int(duration_days * pct / 100.0)
    remaining = max(0, duration_days - elapsed + delta_days)
    new_days = elapsed + remaining
    if remaining > 0:
        if int(new_days * pct / 100.0) != elapsed:
            pct = (elapsed + 0.5) * 100.0 / new_days
        return replace(task, duration=timedelta(days=new_days), percent_complete=pct)

    # The remaining-work window's start in the unperturbed schedule. Only this task
    # changes, so nothing upstream of it — its predecessors, the data-date floor —
    # can move that start. Run once, only on this rare exhausting branch.
    window_start = next(t for t in schedule(project).tasks if t.id == task.id).early_start
    assert window_start is not None
    calendars = _resolve_task_calendars(project)
    cal = calendars[task.id] if calendars is not None else project.calendar
    finish = _scan_for_working_day(window_start, cal, forward=False)
    actual_start = task.actual_start
    if actual_start is not None and actual_start > finish:
        actual_start = finish
    return replace(
        task,
        duration=timedelta(days=new_days),
        percent_complete=100.0,
        actual_start=actual_start,
        actual_finish=finish,
    )


def perturb_task_duration(project: Project, task_id: str, delta_days: int) -> Project:
    """Return a copy of ``project`` with one task's duration shifted by ``delta_days``.

    The single entry point for a what-if duration perturbation, and the reason it
    lives in the engine rather than in its callers: a task's duration reaches the
    forecast through **three different inputs**, and which one Monte Carlo actually
    reads depends on the sampling priority documented in
    :func:`_sample_duration_matrix` (velocity → three-point PERT → deterministic).
    A caller that shifts only the fields it happens to know about moves the
    deterministic CPM finish while the P50/P80/P95 bands stay exactly where they
    were, and then reports both — a what-if that answers "this change carries no
    schedule risk" about a change it never applied (#3533, the same mirror-drift
    class as #3527). Encapsulating the priority here means a fourth sampling branch
    is a one-file change rather than a silent divergence in every caller.

    All three inputs are shifted, so the target is covered whichever branch claims
    it — a branch that does not claim it never reads the input, so the extra shifts
    are inert rather than compounding:

    * ``duration`` — what :func:`schedule` lays the task out at, and the floor every
      sampled column is clamped up to (see :func:`_floor_sampled_at_duration`).
    * the three-point PERT triple, when complete. Shifting all three legs by the
      same offset translates the sampled Beta **exactly**: the PERT sample is
      ``optimistic + s * (pessimistic - optimistic)`` and neither the range nor the
      normalized mean that sets the Beta's shape parameters changes under a common
      shift, so the band moves by ``delta_days`` and keeps its shape.
    * ``story_points``, when the task will take the velocity branch. That branch
      never reads a duration at all — it asks how many sprints burn down the
      committed points — so a day offset has to be converted into the unit it does
      read, at the team's mean pace (``mean(velocity_samples) / sprint_length_days``
      points per working day). The band then moves by ``delta_days`` in expectation,
      quantized to whole sprints, which is what a sprint-delivered task's schedule
      genuinely does.

    On an **in-progress** task the offset applies to the *remaining* work only
    (#4432). The engine reads ``percent_complete`` against ``duration`` to split a
    task into elapsed and remaining working days (:func:`_effective_duration_days`,
    and the same integer rule in Monte Carlo's elapsed subtraction), so shifting
    ``duration`` with ``percent_complete`` held would grow the elapsed share along
    with it and swallow part of the delta — a +1-day slip on a critical 50%-complete
    task moved the finish by zero. ``percent_complete`` is therefore rescaled so the
    elapsed working days stay exactly constant; see :func:`_shift_remaining_work`.
    The PERT legs need no extra handling: Monte Carlo subtracts that same constant
    elapsed count from every sampled value, so shifting each leg by ``delta_days``
    shifts the sampled remaining work by ``delta_days``.

    Sampling semantics are untouched: this only changes what the engine is asked
    about, never how it answers.

    Args:
        project: The baseline project. Read only — neither it nor any task on it is
            mutated; a new :class:`Project` with a new task list is returned.
        task_id: Id of the task to perturb.
        delta_days: Signed day offset. Positive slips the task later, negative pulls
            it in. Durations floor at zero (on an in-progress task, at its elapsed
            working days, since done work cannot be undone), and so do story
            points — a shift that
            would zero the remaining points drops the task to its deterministic
            duration, the honest reading of "this work no longer takes a sprint".

    Returns:
        A new :class:`Project`, identical to ``project`` except for the target
        task's shifted duration inputs. On an in-progress task that includes a
        rescaled ``percent_complete``; on a pull-in that consumes all remaining
        work it also sets ``actual_finish`` and may move ``actual_start`` earlier
        (see :func:`_shift_remaining_work`).

    Raises:
        InvalidScheduleInput: If ``task_id`` names no task in ``project``. A silent
            no-op is the failure this function exists to prevent, so an unknown id
            is refused rather than returning an unperturbed project that the caller
            would report as a zero-impact what-if. A non-:class:`Project` ``project``,
            a ``delta_days`` that is not an ``int`` (``bool`` included, as for
            ``runs``/``seed``), or one whose magnitude exceeds
            :data:`MAX_DURATION_DAYS` is refused too (#4518). A **completed** task (an
            ``actual_finish`` recorded or ``percent_complete`` at 100, the
            :func:`_is_complete` predicate) is refused for the same reason: its dates
            are actuals, so a duration shift would leave both :func:`schedule` and
            :func:`monte_carlo` exactly where they were (#4515).
    """
    _require_project(project)
    # bool is an int subclass but never a meaningful day offset; the magnitude bound
    # keeps ``timedelta`` from raising a bare OverflowError on a huge int (#4518).
    if isinstance(delta_days, bool) or not isinstance(delta_days, int):
        raise InvalidScheduleInput(f"delta_days must be an integer (got {delta_days!r}).")
    if abs(delta_days) > MAX_DURATION_DAYS:
        raise InvalidScheduleInput(
            f"delta_days exceeds the maximum magnitude of {MAX_DURATION_DAYS} days "
            f"(got {delta_days})."
        )
    target = next((t for t in project.tasks if t.id == task_id), None)
    if target is None:
        raise InvalidScheduleInput(f"Task {task_id!r} is not in project {project.id!r}.")
    if _is_complete(target):
        # Completed work is pinned by its actuals and laid out at full duration
        # regardless of what ``duration`` says, so any offset is a silent zero-impact
        # what-if — refuse it like the unknown id above.
        raise InvalidScheduleInput(
            f"Task {task_id!r} is complete; its dates are actuals and a duration "
            "change cannot move the forecast."
        )

    story_points = target.story_points
    # Gate the points conversion on the same predicate the sampler uses, so a task
    # that will NOT take the velocity branch keeps its points untouched.
    if (
        target.delivery_mode == DeliveryMode.SCRUM
        and story_points is not None
        and story_points > 0
        and project.sprint_length_days is not None
        and project.sprint_length_days > 0
    ):
        mean = _velocity_mean(project)
        if mean is not None:
            points_per_working_day = mean / project.sprint_length_days
            story_points = max(0.0, story_points + delta_days * points_per_working_day)

    # ``duration`` is non-optional on Task, so the shift is never None here.
    new_duration = _shift_duration(target.duration, delta_days) or timedelta(0)
    if target.percent_complete and target.percent_complete > 0:
        shifted = _shift_remaining_work(project, target, delta_days)
    else:
        shifted = replace(target, duration=new_duration)
    perturbed = replace(
        shifted,
        optimistic_duration=_shift_duration(target.optimistic_duration, delta_days),
        most_likely_duration=_shift_duration(target.most_likely_duration, delta_days),
        pessimistic_duration=_shift_duration(target.pessimistic_duration, delta_days),
        story_points=story_points,
    )
    return replace(
        project,
        tasks=[perturbed if t.id == task_id else t for t in project.tasks],
    )


def _mc_horizon(
    project: Project,
    task_map: dict[str, Task],
    g: nx.DiGraph[str],
    topo_order: list[str],
    cal_of: dict[str, Calendar],
) -> date:
    """A calendar DATE no task finishes after in any Monte Carlo run.

    The bound is a serial walk in topological order over real calendars: a cursor
    starts at the latest of the project start, every ``planned_start`` pin (SNET,
    #1068), the data date (ADR-0132) and every recorded actual (#1821), and each task
    is then laid out on **its own** calendar from the working day after
    ``cursor + its largest positive incoming lag``, over its longest possible sampled
    duration (the pessimistic estimate and the velocity sampler's ``max_sprints``
    clamp, #1067), advancing the cursor to its finish.

    Why it is an upper bound: by induction over the topological order the cursor is
    at or after every already-walked task's latest possible finish — and so after
    every anchor a link out of one can take (a start, a finish, or the day before a
    start, #4145). A task's real start is the latest of its link proposals and its
    floors; each proposal is at most ``cursor + lag`` and every floor is at most the
    cursor's opening value, so its start is at most the walk's start and, since
    laying out a fixed working-day duration is monotone in the start, its finish at
    most the walk's finish. An FF/SF successor's finish is pinned at most
    ``cursor + lag`` too, which the walk's finish already clears.

    Why it is a DATE and not a working-day count (#4429): a duration of D working
    days on a sparse calendar — a four-day week, Monday-only, a 16-week plant
    shutdown — spans many more than D working days of a denser calendar. The
    previous bound summed working-day durations and used that one count as the length
    of *every* calendar's index, so a successor on a denser calendar ran past its
    index end, where the lookups silently clamped to the last entry and Monte Carlo
    reported P50/P95 weeks to months before ``schedule()``. Expressed as a date, the
    bound is re-counted in each calendar's own working days by :func:`_mc_index_size`.
    """
    cursor = project.start_date
    if project.status_date is not None:
        cursor = max(cursor, project.status_date)
    for t in task_map.values():
        for pinned in (t.planned_start, t.actual_start, t.actual_finish):
            if pinned is not None:
                cursor = max(cursor, pinned)
    for tid in topo_order:
        t = task_map[tid]
        d_days = t.duration.days
        if t.pessimistic_duration is not None:
            d_days = max(d_days, t.pessimistic_duration.days)
        d_days = max(0, d_days, _velocity_worst_case_days(t, project))
        lag_days = max(
            (g[pred][tid]["dep"].lag.days for pred in g.predecessors(tid)),
            default=0,
        )
        start = _next_working_day(
            _safe_offset(cursor, timedelta(days=1 + max(0, lag_days))), cal_of[tid]
        )
        cursor = max(cursor, _finish_from_start(start, d_days, cal_of[tid]))
    return cursor


def _count_working_days(start: date, end: date, calendar: Calendar) -> int:
    """Working days of ``calendar`` in the closed range ``[start, end]``."""
    count = 0
    day = start
    while day <= end:
        if calendar.is_working_day(day):
            count += 1
        day = _safe_offset(day, _ONE_DAY)
    return count


def _mc_index_size(
    horizon: date,
    index_origin: date,
    calendars: Iterable[Calendar],
    n_tasks: int,
) -> int:
    """The working-day index length that holds every offset on EVERY calendar.

    Every calendar's index is built with this one length, so it is the largest count
    of any calendar's own working days in ``[index_origin, horizon]`` — the densest
    calendar needs the most cells to span the same calendar days — plus the task
    count and a small buffer. ``horizon`` (:func:`_mc_horizon`) is a calendar date
    no run finishes after, so each index then spans at least to it in calendar days,
    whatever its working week (#4429). A working-day count summed across calendars
    cannot be that bound: D working days on a sparse calendar are far more than D
    working days of a dense one. ``index_origin`` already includes the pre-start pad
    (:func:`_mc_pre_start_pad_days`), so the pad needs no separate allowance.
    """
    widest = max(_count_working_days(index_origin, horizon, cal) for cal in calendars)
    return widest + n_tasks + 30


# Calendar days of slack added below the earliest pre-start placement the pad bound
# derives, so the working-day lookups one day either side of it stay on the index.
_MC_PRE_START_PAD_BUFFER_DAYS = 14


def _mc_pre_start_pad_days(
    project: Project,
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    cal_of: dict[str, Calendar],
) -> tuple[int, frozenset[str]]:
    """``(pad_days, sf_linked_ids)``: how far before the project start the index must reach.

    An SF-linked task (:func:`_sf_linked`) is not floored at the project start (#4218), so
    a run can place it before the working-day index's first day, where no offset
    exists. The index therefore opens ``pad_days`` calendar days early. With no
    SF-linked task the pad is 0 and every offset is exactly what it was before.

    The bound is a lower bound on every run's start, not a deterministic replay: in a
    run, a task that is not SF-linked starts no earlier than the project-start floor
    (or, when complete, at its fixed pinned start), and an SF-linked task's
    start is at least the back-solve of any single SF bound — its other links only
    raise it (#4220) — over its *longest*
    possible sampled duration, measured from that lower bound on the predecessor —
    the SF bound is monotone in the predecessor's start and the back-solve is
    monotone in both arguments. That start is the one the SF link measures from
    (:func:`_link_start`, #4523): a started task's recorded ``actual_start``, or a
    derived span start a fixed number of elapsed working days before its window,
    either of which can sit before the task's own lower bound. An SF-linked task's
    own floors (data date, SNET, a recorded actual start) only raise its true
    start, so leaving them out of *its* bound keeps that bound safe. A milestone's
    floors are different — they can lower the instant its successors measure
    from — and are handled below.

    A milestone that is not SF-linked is *shown* no earlier than the project start,
    but its successors measure from its link instant, which the project-start floor
    does not raise (#4225). Its bound is therefore the one any single proposal to
    that instant proves — the link instant is the latest proposal, so it is at least
    each of them — and an SF-linked successor of it is bounded from there. Its hard
    floors (:func:`_milestone_hard_floors`: a recorded actual start, SNET, the data
    date) are proposals too, and the earliest of them can lie before the project
    start: a live milestone carrying a pre-start ``actual_start`` has its link instant
    there, so its SF successor is placed before the project start as well. Bounding
    the milestone from its links alone left that successor below the index, where its
    finish clamped to offset 0 and Monte Carlo finished a working day after
    ``schedule()`` (#4510).

    A milestone's bound is always recorded in ``lo`` (a successor reads it, possibly
    through further milestones), but it widens the index only when the milestone has
    an SF successor of its own. Any other reader of its link instant either resolves
    it in date space or is floored at the project start, and a downstream SF-linked
    task widens the index by its own bound. Without that guard, a typo-year
    ``actual_start`` on any milestone of a project with one unrelated SF link grew
    the index by centuries of cells.
    """
    sf_linked = frozenset(tid for tid in topo_order if _sf_linked(tid, g))
    if not sf_linked:
        return 0, sf_linked
    lo: dict[str, date] = {}
    # What an SS/SF link out of each task measures from is its span start, which
    # can lie before ``lo`` (#4523, :func:`_link_start`): a recorded actual start,
    # or a derived span start that many elapsed working days earlier. Links read
    # this; a task's own placement reads ``lo``.
    link_lo: dict[str, date] = {}

    def record_link_lo(tid: str) -> None:
        task = task_map[tid]
        bound = lo[tid]
        if _start_is_recorded(task):
            assert task.actual_start is not None
            bound = min(bound, task.actual_start)
        elif _elapsed_link_days(task) > 0:
            bound = _start_from_finish(bound, _elapsed_link_days(task) + 1, cal_of[tid])
        link_lo[tid] = bound

    earliest = project.start_date
    for tid in topo_order:
        task = task_map[tid]
        cal = cal_of[tid]
        pinned = _pinned_placement(task, cal, _next_working_day(project.start_date, cal))
        if pinned is not None:
            lo[tid] = pinned[0]
            record_link_lo(tid)
            continue
        if tid not in sf_linked:
            lo[tid] = _next_working_day(project.start_date, cal)
            if task.duration.days == 0:
                proposals = [
                    *_milestone_hard_floors(task, cal, project.status_date),
                    *_link_lower_bound(g, tid, link_lo, cal_of),
                ]
                if proposals:
                    lo[tid] = min(lo[tid], max(proposals))
                    # Only an SF successor turns this instant into a cell anyone reads;
                    # without one, widening for it would cost index cells for nothing.
                    if any(
                        g[tid][succ]["dep"].dep_type is DependencyType.SF
                        for succ in g.successors(tid)
                    ):
                        earliest = min(earliest, lo[tid])
            record_link_lo(tid)
            continue
        bound = max(
            _next_working_day(
                _safe_offset(
                    _prev_working_day(_safe_offset(link_lo[pred], -_ONE_DAY), cal_of[pred]),
                    g[pred][tid]["dep"].lag,
                ),
                cal,
            )
            for pred in g.predecessors(tid)
            if g[pred][tid]["dep"].dep_type is DependencyType.SF
        )
        longest = max(
            task.duration.days,
            0 if task.pessimistic_duration is None else task.pessimistic_duration.days,
            _velocity_worst_case_days(task, project),
        )
        lo[tid] = _start_from_finish(bound, longest, cal) if longest > 0 else bound
        record_link_lo(tid)
        earliest = min(earliest, lo[tid])
    return (project.start_date - earliest).days + _MC_PRE_START_PAD_BUFFER_DAYS, sf_linked


def _link_lower_bound(
    g: nx.DiGraph[str], tid: str, lo: dict[str, date], cal_of: dict[str, Calendar]
) -> Iterator[date]:
    """A lower bound on the instant each incoming link proposes to milestone ``tid``.

    From a predecessor that starts (or, as a milestone, sits) no earlier than its
    ``lo``: a start-anchored link's anchor is at least that, and a finish-anchored
    one's at least the working day before it, so the proposal is at least that
    anchor plus the lag (:func:`_edge_anchor`, :func:`_place_milestone`).
    """
    for pred in g.predecessors(tid):
        dep: Dependency = g[pred][tid]["dep"]
        anchor = (
            lo[pred]
            if dep.dep_type in _START_ANCHORED
            else _prev_working_day(_safe_offset(lo[pred], -_ONE_DAY), cal_of[pred])
        )
        yield _safe_offset(anchor, dep.lag)


def _snapped_offsets(
    wd_ord: np.ndarray, last_off: int, anchor_ords: np.ndarray, shift_days: int
) -> np.ndarray:
    """Vectorised ``_offset_after``: offsets of next_working_day(anchor + shift).

    A snap that lands past the index end (``> last_off``) comes back as NaN rather
    than clamped onto the last cell (#4429). The delta table covers every anchor
    cell, including tail cells no run can reach, so producing one is not an error;
    :func:`_build_lag_delta` stores it as :data:`_LAG_DELTA_OVERRUN`, and
    :func:`_lag_term` refuses a run that actually reads it.
    """
    off = np.searchsorted(wd_ord, anchor_ords + shift_days, side="left").astype(np.float64)
    off[off > last_off] = np.nan
    return off


# Lag-delta cell whose snapped successor offset lies past the successor's index end
# (#4429). Real cells are bounded by MAX_LAG_DAYS + MAX_CALENDAR_SCAN_DAYS (~73k), so
# the int32 minimum can never collide with one.
_LAG_DELTA_OVERRUN = int(np.iinfo(np.int32).min)


def _build_lag_delta(
    dt: DependencyType,
    lag: timedelta,
    wd_ord_pred: np.ndarray,
    wd_ord_succ: np.ndarray,
    k_arange: np.ndarray,
    index_size: int,
    last_off_succ: int,
    pred_prev_ord: int,
) -> np.ndarray:
    """Per-anchor-offset lag delta array for one ``(dep_type, lag, pred_cal, succ_cal)`` key.

    Vectorised equivalent of the former per-cell loop (#1205): for each anchor
    offset k the delta is the snapped successor offset minus the plain-add
    baseline. FS/FF anchor on the *previous* working day (wd_index[k-1]), so their
    k=0 cell stays 0 and the array is filled from index 1; SS anchors on
    wd_index[k] over the full range. This reproduces the scalar ``_offset_after``
    arithmetic exactly (asserted byte-for-byte in the tests).

    SF also anchors on wd_index[k-1] (#4145), but unlike FS/FF its k is an
    inclusive *start* offset, so k=0 is reachable: a predecessor starting on the
    index's first working day anchors on the working day before the index begins,
    which ``pred_prev_ord`` supplies as an ordinal. A positive SF lag anchors on
    the calendar day before wd_index[k] instead (#4333, :func:`_edge_anchor`).
    FS/FF cannot reach k=0 — their k is an exclusive-EF offset, which is at least
    1 for any task with duration.

    Per-task calendars (ADR-0120 D3, #1385): the anchor is read in the
    *predecessor's* working-day space (``wd_ord_pred``) and the snap lands in the
    *successor's* (``wd_ord_succ``), because lag is consumed on the successor's
    calendar — the same rule ``_forward_pass`` applies, where the node being
    computed owns the snap of every incoming constraint. The delta therefore
    carries the whole cross-calendar hop, which is what lets the vectorised
    forward pass stay calendar-agnostic: it still evaluates ``anchor +
    delta[round(anchor)]`` and lands in successor space. When both calendars are
    the same object the two arrays are identical and the arithmetic is
    byte-for-byte what it was before per-task calendars existed.
    """
    arr = np.zeros(index_size, dtype=np.float64)
    lag_days = lag.days
    if dt == DependencyType.FS:
        # k = exclusive EF offset; EF date = wd_index[k-1]; shift = 1 + lag.
        off = _snapped_offsets(wd_ord_succ, last_off_succ, wd_ord_pred[:-1], 1 + lag_days)
        arr[1:] = off - k_arange[1:]
    elif dt == DependencyType.FF:
        # Anchor k is the exclusive EF offset (inclusive last day = wd_index[k-1]);
        # the inclusive→exclusive +1 is folded into the -(k-1) baseline.
        off = _snapped_offsets(wd_ord_succ, last_off_succ, wd_ord_pred[:-1], lag_days)
        arr[1:] = off - k_arange[: index_size - 1]
    elif dt == DependencyType.SS:
        # Start-anchored ES constraint; both sides are inclusive starts.
        arr[:] = _snapped_offsets(wd_ord_succ, last_off_succ, wd_ord_pred, lag_days) - k_arange
    else:  # SF
        # Start-anchored EF constraint measured from the working day BEFORE the
        # predecessor's start (#4145 — MS Project / P6 finish the successor at the
        # start of that day). succ.EF (exclusive) must clear the snapped
        # anchor+lag day (inclusive), so +1 converts the inclusive constraint day
        # to the exclusive EF offset. FF gets this +1 for free via its exclusive-EF
        # anchor; SF does not, and dropping it finished SF successors one working
        # day early (#824).
        anchor_ords = np.empty(index_size, dtype=np.int64)
        if lag_days > 0:
            # A positive lag counts from the day the start instant closes,
            # ``start - 1`` itself, not the working day before it (#4333).
            anchor_ords[:] = wd_ord_pred - 1
        else:
            anchor_ords[0] = pred_prev_ord
            anchor_ords[1:] = wd_ord_pred[:-1]
        arr[:] = (
            _snapped_offsets(wd_ord_succ, last_off_succ, anchor_ords, lag_days) + 1.0 - k_arange
        )
    # Every cell is a whole working-day offset difference, bounded by
    # MAX_LAG_DAYS + MAX_CALENDAR_SCAN_DAYS (~73k), so int32 is exact and halves
    # the table's footprint (#4129). The float64 scratch above is one array at a
    # time; only the int32 copy is retained. A cell whose snap ran off the index is
    # NaN (:func:`_snapped_offsets`) and is stored as the overrun sentinel, in place.
    np.nan_to_num(arr, copy=False, nan=float(_LAG_DELTA_OVERRUN))
    return arr.astype(np.int32)


def _build_lag_delta_table(
    g: nx.DiGraph[str],
    wd_ord_by_cal: dict[int, np.ndarray],
    index_size: int,
    cal_key_of: dict[str, int],
    prev_ord_of: Callable[[int], int],
    milestone_ids: frozenset[str] = frozenset(),
    max_cells: int = MAX_LAG_DELTA_CELLS,
) -> dict[tuple[DependencyType, timedelta, int, int], np.ndarray | None]:
    """One shared lag-delta array per *distinct* ``(dep_type, lag, pred_cal, succ_cal)`` key.

    The array content depends ONLY on that key (#1201) — the working-day indices are
    fixed for the whole simulation — so N identical SF/lag-0 edges (or any repeated
    key) cost a single array, not N. ``None`` means "no adjustment" (a plain offset
    add) — used for lag-free FS/SS/FF **within one calendar**. SF always carries a
    delta array even at zero lag (its exclusive-EF-on-inclusive-start +1 conversion,
    issue #824).

    Per-task calendars (#1385): an edge whose endpoints resolve to *different*
    calendars can never take the ``None`` short-circuit, even at zero lag — the
    delta is what converts the predecessor's working-day offset into the
    successor's, and those spaces are not the same ruler. Keying on both calendar
    identities keeps the sharing intact within each calendar pair.

    The remaining cost — distinct keys x ``index_size`` — is capped explicitly
    because ``MAX_PROJECT_SPAN_DAYS`` bounds Σlag but not this product, and an
    SF/lag-0 edge contributes 0 to Σlag. With per-task calendars the number of
    distinct keys is multiplied by the number of calendar *pairs* actually joined
    by an edge, so the same cap now also bounds cross-calendar fan-out.

    An edge out of a live milestone (``milestone_ids``, #4079) needs no array: the
    forward pass carries each run's instant as a date and resolves those edges in
    date space (:func:`_mc_milestone_bounds`).
    """
    k_arange = np.arange(index_size, dtype=np.float64)

    delta_by_key: dict[tuple[DependencyType, timedelta, int, int], np.ndarray | None] = {}

    def ensure(dep_type: DependencyType, lag: timedelta, pred_key: int, succ_key: int) -> None:
        key = (dep_type, lag, pred_key, succ_key)
        if key in delta_by_key:
            return
        same_calendar = pred_key == succ_key
        if same_calendar and lag == timedelta(0) and dep_type != DependencyType.SF:
            delta_by_key[key] = None
            return
        wd_ord_pred = wd_ord_by_cal[pred_key]
        wd_ord_succ = wd_ord_by_cal[succ_key]
        # Reject before materialising the offending array: distinct keys x
        # index_size cells is the cost the span guard does not bound (#1201).
        non_null = sum(1 for arr in delta_by_key.values() if arr is not None) + 1
        if non_null * index_size > max_cells:
            raise InvalidScheduleInput(
                f"Monte Carlo lag-delta table would exceed {max_cells:,} "
                "cells (distinct dependency type/lag combinations x schedule span). "
                "The dependency network has too many distinct lag values for the "
                "span involved — reduce the variety of lags or split the project."
            )
        delta_by_key[key] = _build_lag_delta(
            dep_type,
            lag,
            wd_ord_pred,
            wd_ord_succ,
            k_arange,
            index_size,
            len(wd_ord_succ) - 1,
            # Only SF reads it, and resolving it walks the predecessor's calendar
            # backwards off the index — so it is asked for lazily, per calendar.
            prev_ord_of(pred_key) if dep_type == DependencyType.SF else 0,
        )

    for u, v, data in g.edges(data=True):
        d = data["dep"]
        pred_key = cal_key_of[u]
        succ_key = cal_key_of[v]
        if u not in milestone_ids:
            ensure(d.dep_type, d.lag, pred_key, succ_key)
    return delta_by_key


def _lag_term(delta_arr: np.ndarray, anchor: np.ndarray) -> np.ndarray:
    """Per-run lag delta gathered at each run's (rounded) anchor offset.

    Lag-free edges (``delta_by_key[key] is None``) never reach here: the constraint
    loop uses the anchor directly, skipping a runs-sized zeros allocation plus a
    no-op add per edge (#1860 — adding zeros is exact in float64, so results are
    unchanged).

    An anchor past the index end is refused, not clamped: clamping it to the last
    cell is how an undersized index used to masquerade as a date (#4429). So is an
    anchor whose lagged snap ran off the successor's index (a cell holding
    :data:`_LAG_DELTA_OVERRUN`).
    """
    idx = np.rint(anchor).astype(np.int64)
    if idx.size and int(idx.max()) > len(delta_arr) - 1:
        _raise_mc_index_overrun()
    picked = delta_arr[np.maximum(idx, 0)]
    if (picked == _LAG_DELTA_OVERRUN).any():
        _raise_mc_index_overrun()
    return np.asarray(picked, dtype=np.float64)


def _raise_mc_index_overrun() -> NoReturn:
    """Refuse a Monte Carlo offset past its working-day index end (#4429).

    The index is sized by :func:`_mc_index_size` to hold every offset a run can
    reach, so this is unreachable on a correct bound. It exists because the clamp it
    replaces turned an undersized index into a plausible, silently early finish date.
    It raises the documented :class:`InvalidScheduleInput` rather than a bare error so
    an embedder's exception contract still holds, and the message says it is an
    engine fault rather than a fault in the caller's input.
    """
    raise InvalidScheduleInput(
        "Internal Monte Carlo error: a simulated date ran past the working-day index "
        "built for it. This is an engine bug, not a problem with the project; please "
        "report it with the project that triggered it."
    )


def _completed_dates(
    project: Project,
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    task_calendars: dict[str, Calendar] | None,
) -> tuple[dict[str, tuple[date, date]], dict[str, _Instant]]:
    """The VERBATIM ``(early_start, early_finish)`` ``schedule()`` gives each completed task.

    Rather than *reproducing* ``_forward_pass``'s completed-task branches, this runs
    the deterministic forward pass itself over throwaway copies and reads the answers
    off it. That is the single source of truth both engines' completed-task handling
    reads from, so Monte Carlo cannot drift from ``schedule()`` on the arithmetic
    (#2460/#2461) — and, unlike a transcription, cannot fall behind a later change to
    the deterministic pass (#2572).

    The transcription it replaces reproduced only the actuals-anchored branches
    faithfully. For the third branch — ``percent_complete >= 100`` with no actuals at
    all — it returned the bare project-start anchor and dropped the ``planned_start``
    (SNET) floor, so a completed-by-percent task with an SNET pin simulated *earlier*
    than its deterministic position and the percentiles under-reported risk.

    Every completed task is pinned out of the network (:func:`_pinned_placement`,
    #4343), including one with no actuals, so each *date* read here is a function of
    the task's own fields and the project start alone. A closed milestone's *instant*
    is not quite: which edge of its recorded day it sits on is read off its
    predecessors' positions in this one deterministic pass (#4433,
    :func:`_live_milestone_edge` — an FS or SS predecessor that lands later can flip
    it). It is read once, here, and frozen; no run re-derives it from a sampled
    predecessor duration. That is what makes the pin a true constant across runs,
    the property the Monte Carlo fast path relies on: no run can move a completed
    task. (Before #4343
    the no-actuals task was placed through the network in ``schedule()``, so pinning it
    at its deterministic position here froze a position that in fact depended on its
    predecessors' durations, and the percentiles under-reported risk downstream of it.)

    Scalar ``date`` space also preserves the *non-working* dates the working-day offset
    index cannot represent — a weekend ``actual_finish`` stays verbatim.

    Args:
        project: The project being simulated (supplies the start date, project
            calendar, and data date).
        task_map: Every task by id. Not mutated — the pass runs over shallow copies.
        topo_order: Any valid topological order of ``g``.
        g: The dependency graph.
        task_calendars: Per-task calendar overrides, or ``None`` for one calendar.

    Returns:
        ``({task_id: (early_start, early_finish)}, {task_id: instant})`` for the
        completed tasks only — the second map holds the completed tasks the
        deterministic pass placed as milestone instants (#4079), so their outgoing
        constraints use the same anchors. Both are empty when the project carries
        no completed task, in which case the deterministic pass is skipped entirely.
    """
    completed_ids = [tid for tid, t in task_map.items() if _is_complete(t)]
    if not completed_ids:
        return {}, {}

    # _forward_pass assigns early_start/early_finish in place and monte_carlo()'s
    # task_map holds the *caller's* Task objects, so run it over shallow copies —
    # the same isolation schedule() applies, and safe for the same reason (every
    # Task field is an immutable scalar).
    scratch = {tid: copy.copy(t) for tid, t in task_map.items()}
    # Live successors measure a completed milestone's links from its link instant
    # (#4225), which is what the constraints below are built from.
    instants: dict[str, _Instant] = {}
    _forward_pass(
        scratch,
        topo_order,
        g,
        project.start_date,
        project.calendar,
        project.status_date,
        task_calendars,
        instants,
    )

    dates: dict[str, tuple[date, date]] = {}
    for tid in completed_ids:
        t = scratch[tid]
        # The forward pass sets both on every task it visits.
        assert t.early_start is not None and t.early_finish is not None
        dates[tid] = (t.early_start, t.early_finish)
    return dates, {tid: instants[tid] for tid in completed_ids if tid in instants}


def _index_offset(d: date, offset_of: dict[date, int], wd_index: list[date]) -> float:
    """Working-day offset of ``d``, clamped to the index start when it falls before it.

    A date past the index end raises (#4429): clamping it to the last entry reported
    an undersized index as a plausible, silently early date.
    """
    off = offset_of.get(d)
    if off is not None:
        return float(off)
    if d > wd_index[-1]:
        _raise_mc_index_overrun()
    return 0.0 if d < wd_index[0] else float(len(wd_index) - 1)


def _completed_offsets(
    es_date: date,
    ef_date: date,
    calendar: Calendar,
    offset_of: dict[date, int],
    wd_index: list[date],
) -> tuple[float, float]:
    """Constant (ES, exclusive-EF) offset pin for a completed task's own columns.

    Derived from the verbatim dates :func:`_completed_dates` resolved, so the pin can
    only ever be the offset-space *projection* of what ``schedule()`` computed —
    never independently-derived arithmetic that could disagree with it.

    A non-working verbatim date has no offset (the index holds working days only) and
    snaps to the nearest one here. That loss is deliberate and no longer observable:
    successors of a completed task read a precomputed scalar constraint rather than
    these offsets (:func:`_completed_edge_constraints`), and the terminal project
    finish is floored at the verbatim date by :func:`_offset_to_date`. So the snap
    now affects nothing a caller can see.
    """
    ef_off = _index_offset(_prev_working_day(ef_date, calendar), offset_of, wd_index) + 1.0
    es_off = min(_index_offset(_next_working_day(es_date, calendar), offset_of, wd_index), ef_off)
    return es_off, ef_off


_FixedEdge = tuple[bool, float, int, bool]
"""``(is_ef_constraint, offset, instant_ordinal, start_display)`` of a completed predecessor."""


def _completed_edge_constraints(
    g: nx.DiGraph[str],
    completed_dates: dict[str, tuple[date, date]],
    completed_instants: dict[str, _Instant],
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: dict[int, dict[date, int]],
    wd_index_by_cal: dict[int, list[date]],
    task_map: dict[str, Task] | None = None,
) -> dict[tuple[str, str], _FixedEdge]:
    """The constant bound a completed predecessor, or a recorded start, imposes, per edge.

    A completed task's dates are fixed across every run, so the constraint each of its
    outgoing links imposes is a constant — and computing it here, in scalar ``date``
    space with the *verbatim* dates, is what lets Monte Carlo agree with
    ``_forward_pass`` on a non-working actual (#2461).

    The vectorised path could not: it anchors on the predecessor's working-day offset
    and applies the lag through :func:`_build_lag_delta`, so a weekend
    ``actual_finish`` was silently read as the preceding Friday and any non-zero lag
    (or any SS/SF link, which anchors on the start) landed a working day off. The
    formulas below are ``_forward_pass``'s own (:func:`_edge_anchor`); FF/SF produce
    an *inclusive* constraint date, so ``+ 1`` converts it to the exclusive-EF
    offset space the Monte Carlo pass works in.

    Per-task calendars (#1385): the snap and the resulting offset both belong to the
    **successor**, because lag is consumed on the successor's calendar and the
    successor's column is the one this constraint is compared against. The completed
    predecessor contributes only a raw date — which is precisely why the verbatim
    dates, not its offsets, are what cross the edge. This is the scalar counterpart
    of the same rule :func:`_build_lag_delta` encodes for live predecessors.

    For a milestone successor (#4079) the same link also proposes an *instant*, the
    raw midnight :func:`_place_milestone` would compare, returned as a date ordinal
    with whether it is shown at the start of its day.

    An SS or SF link out of a *started* task (``task_map`` given) is a constant of
    the same kind (#4523): it measures from the recorded ``actual_start``
    (:func:`_link_start`), which no run's sampled duration moves, so it is resolved
    here from the verbatim date too. Reading it off the run's ES offset instead
    measured it from the data-date-floored remaining window, as ``schedule()`` did
    before #4523, and could not hold a non-working actual (#4175).
    """
    constraints: dict[tuple[str, str], _FixedEdge] = {}
    tasks = task_map or {}
    for u, v, data in g.edges(data=True):
        if v in completed_dates:
            # A completed successor is pinned and skips network logic entirely
            # (mirroring _forward_pass), so an edge into one imposes nothing.
            continue
        dep: Dependency = data["dep"]
        if u in completed_dates:
            pred_es, pred_ef = completed_dates[u]
        elif u in tasks and _start_fixed_link(tasks[u], dep):
            started = tasks[u].actual_start
            assert started is not None
            # Only the start is read by an SS/SF anchor (_edge_anchor).
            pred_es = pred_ef = started
        else:
            continue
        succ_cal = cal_of[v]
        succ_key = cal_key_of[v]
        offset_of = offset_of_by_cal[succ_key]
        wd_index = wd_index_by_cal[succ_key]
        pred_instant = completed_instants.get(u)
        anchor = _edge_anchor(
            dep.dep_type,
            pred_es,
            pred_ef,
            None if pred_instant is None else pred_instant[0],
            cal_of[u],
            dep.lag,
        )
        imposed = _next_working_day(_safe_offset(anchor, dep.lag), succ_cal)
        # What the same link proposes to a milestone successor: engine
        # _place_milestone's own rule (#4079, #4272), not re-derived here.
        proposal, start_display = _milestone_proposal(
            dep.dep_type, dep.lag, pred_es, pred_ef, pred_instant, cal_of[u], succ_cal
        )
        finish_bound = dep.dep_type not in _START_ANCHORED
        constraints[(u, v)] = (
            finish_bound,
            _index_offset(imposed, offset_of, wd_index) + (1.0 if finish_bound else 0.0),
            proposal.toordinal(),
            start_display,
        )
    return constraints


def _mc_es_floors(
    project: Project,
    task_map: dict[str, Task],
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: dict[int, dict[date, int]],
    wd_index_by_cal: dict[int, list[date]],
    sf_linked: frozenset[str] = frozenset(),
) -> dict[str, float]:
    """Merge each task's SNET pin, recorded actual start, and the data-date floor.

    The deterministic forward pass builds an in-progress task's ES from a three-way
    maximum — the data date, the ``planned_start`` (SNET) pin, and the recorded
    ``actual_start`` — before folding in network logic. This is the Monte Carlo
    counterpart, and it must apply all three or the simulation samples from a window
    CPM has already excluded.

    ``planned_start`` (SNET) floors mirror the deterministic forward pass (#1068): a
    pinned task may not start before its pin regardless of network logic. A pin at or
    before project start is the 0 floor every task already has, and the index was sized
    to cover the furthest pin, so the lookup is total. The data date floors all
    not-yet-finished work — nothing remaining can be sampled before "as of now".

    ``actual_start`` floors work already underway at where it actually began
    (ADR-0132 §2 / #2621) — actuals are truth and are never smoothed back to an
    earlier network slot. It was missing here for as long as the deterministic floor
    existed, so every percentile on an in-progress project was computed against an
    early window ``schedule()`` had already rejected and P95 could land *before* the
    plain CPM finish — a risk tool under-reporting risk (#2833). Only not-yet-complete
    tasks take it, exactly as in the deterministic pass: a complete task is pinned out
    of network logic entirely (:func:`_completed_dates`) and never reads this floor.

    **A non-working actual is snapped forward here, and the deterministic pass leaves
    it verbatim.** That is a deliberate, one-directional divergence, not an oversight.
    ``_forward_pass`` works in scalar dates and can hold a Saturday actual; this index
    holds working days only, so the date has no offset and *some* neighbour has to
    stand in for it.

    **What that divergence covers shrank with #3963 — do not read the paragraph
    below as still describing the finish.** Until then ``_finish_from_start`` began
    an in-progress task's duration walk *on* the non-working actual, so the
    deterministic pass spent one working day of the duration on a Saturday and
    finished a working day early, while this snap gave the task its full remaining
    duration. The two passes returned different finishes for a fully deterministic
    project, and **this one was right**. The divergence was therefore never
    "unavoidable index rounding" in the finish direction; it was reporting a
    defect in the other pass. That is fixed: both engines now begin the walk at the
    next working day, and for any task with remaining duration >= 1 the finish this
    index produces is exactly ``schedule()``'s.

    Two readers still see the raw date, and **neither reads this floor for it any
    more (#4175)**: a **zero-duration milestone**, whose instant *is* the actual,
    and an **SS successor**, which measures its lag from the predecessor's start.
    Both used to read the snapped day here, and the error was not bounded by one
    working day as this docstring once claimed — a calendar-day lag from Monday
    instead of Sunday re-lands across a weekend, and a chain of them carried a 2-3
    working-day gap to the finish. :func:`_mc_verbatim_actuals` now hands both the
    verbatim date, per run where it binds, the way #2461 did for completed tasks.
    (SF with no lag or a lead needs nothing: its anchor is the working day *before*
    the start, which the snap cannot move. A positive SF lag counts from
    ``start - 1`` itself, #4333, so it reads the verbatim date as SS does.)
    ``tests/test_monte_carlo_live_actual_start.py`` holds the equality over that
    space.

    All three are ES lower bounds on the same task, so they merge here and the forward
    pass reads a single number.

    The project-start floor is the fourth, and the one an ``sf_linked`` task
    (:func:`_sf_linked`, #4218) does not take. Offset 0 is the project start only while
    the index opens there; once :func:`_mc_pre_start_pad_days` opens it earlier, every
    other task carries its project-start offset explicitly, and an SF-linked task keeps
    just its data date, SNET and actual start, each read wherever it falls on the
    index — before the project start included, as ``schedule()`` reads them.
    """

    def _snap_offset(d: date, tid: str) -> float:
        """Offset of the next working day on ``tid``'s own calendar.

        Clamped to the index start below it; past its end it raises (#4429).
        """
        cal_key = cal_key_of[tid]
        snapped = _next_working_day(d, cal_of[tid])
        off = offset_of_by_cal[cal_key].get(snapped)
        if off is not None:
            return float(off)
        index = wd_index_by_cal[cal_key]
        if snapped > index[-1]:
            _raise_mc_index_overrun()
        return 0.0 if snapped < index[0] else float(len(index) - 1)

    es_floor: dict[str, float] = {}
    status_date = project.status_date
    for t in task_map.values():
        if t.id in sf_linked:
            floor = 0.0
            if t.planned_start is not None:
                floor = _snap_offset(t.planned_start, t.id)
            if status_date is not None and not _is_complete(t):
                floor = max(floor, _snap_offset(status_date, t.id))
            if t.actual_start is not None and not _is_complete(t):
                floor = max(floor, _snap_offset(t.actual_start, t.id))
            if floor:
                es_floor[t.id] = floor
            continue
        # 0.0 while the index opens on the project start, i.e. unchanged.
        floor = _snap_offset(project.start_date, t.id)
        if t.planned_start is not None and t.planned_start > project.start_date:
            floor = _snap_offset(t.planned_start, t.id)
        if status_date is not None and status_date > project.start_date:
            floor = max(floor, _snap_offset(status_date, t.id))
        if (
            t.actual_start is not None
            and t.actual_start > project.start_date
            and not _is_complete(t)
        ):
            floor = max(floor, _snap_offset(t.actual_start, t.id))
        if floor:
            es_floor[t.id] = floor
    return es_floor


_MilestoneFloors = tuple[int | None, int | None]
"""``(hard, start)`` floors of a live milestone as date ordinals (#4225).

``hard`` is the latest of its data-date, SNET and recorded-actual-start floors, and
``start`` the project-start floor (``None`` for an SF-linked milestone, #4218): the
split :func:`_place_milestone` makes between what binds its link instant and what
only bounds where it is shown.

An SF-linked milestone's shown day has no Monte Carlo-observable effect of its own:
its successors read its link instant, and a milestone shown before the project start
cannot set the finish, because the SF predecessor that places it there finishes
later (#4220).
"""


def _milestone_hard_floors(task: Task, cal: Calendar, status_date: date | None) -> list[date]:
    """A live milestone's hard floors — the ``hard`` half of :data:`_MilestoneFloors`.

    The data date and SNET snapped to the milestone's own working days, the recorded
    actual start verbatim. One definition, because two readers must agree on it:
    :func:`_mc_milestone_floors` places the link instant from these, and
    :func:`_mc_pre_start_pad_days` bounds that instant from below with them (#4510) —
    a pad bound computed from a different set could sit above the instant it bounds.
    """
    hard: list[date] = []
    if status_date is not None:
        hard.append(_next_working_day(status_date, cal))
    if task.actual_start is not None:
        hard.append(task.actual_start)
    if task.planned_start is not None:
        hard.append(_next_working_day(task.planned_start, cal))
    return hard


def _mc_milestone_floors(
    project: Project,
    task_map: dict[str, Task],
    milestone_ids: frozenset[str],
    cal_of: dict[str, Calendar],
    sf_linked: frozenset[str] = frozenset(),
) -> dict[str, _MilestoneFloors]:
    """Each live milestone's :data:`_MilestoneFloors`, as ``_forward_pass`` builds them.

    Read in date space and never through the offset index, which cannot hold a
    non-working actual (#4175) or a floor before the index opens: the hard floors
    are exactly ``_early_start_floors(..., sf_linked=True)`` — the data date and SNET
    snapped to the milestone's own working days, the actual start verbatim.
    """
    out: dict[str, _MilestoneFloors] = {}
    for tid in milestone_ids:
        cal = cal_of[tid]
        hard = _milestone_hard_floors(task_map[tid], cal, project.status_date)
        out[tid] = (
            max(hard).toordinal() if hard else None,
            None if tid in sf_linked else _next_working_day(project.start_date, cal).toordinal(),
        )
    return out


_VerbatimActual = tuple[int, float, float]
"""``(actual_ordinal, snapped_offset, other_floor)`` of a live non-working actual start.

``snapped_offset`` is the offset :func:`_mc_es_floors` floors the task at, and
``other_floor`` the task's ES floor with the actual start left out (SNET pin and
data date only) — the two :func:`_mc_forward_pass` compares to tell, per run,
whether the verbatim actual is what binds the task's start.
"""


def _mc_verbatim_actuals(
    project: Project,
    task_map: dict[str, Task],
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: dict[int, dict[date, int]],
    wd_index_by_cal: dict[int, list[date]],
    sf_linked: frozenset[str] = frozenset(),
) -> dict[str, _VerbatimActual]:
    """The live tasks whose recorded ``actual_start`` falls on a non-working day (#4175).

    :func:`_mc_es_floors` snaps such an actual forward to a working day because the
    offset index cannot hold it, while ``schedule()`` keeps it verbatim. For a task
    with remaining work that is invisible at the finish (#3963), but a
    **zero-duration milestone** sees the raw date: its instant *is* the actual (Sunday
    00:00, not Monday), and a calendar-day lag from Sunday and from Monday can land a
    full weekend apart downstream — 2-3 working days on a fully deterministic
    project. This map lets it resolve its instant from the verbatim date instead,
    the way #2461 did for completed tasks. The other readers of the raw date, SS and
    SF successors, measure from it unconditionally since #4523 and get it as a
    constant edge (:func:`_completed_edge_constraints`).

    A working-day actual is left out: its snap is the identity and nothing diverges.
    ``other_floor`` mirrors :func:`_mc_es_floors`, project-start floor included for
    every task that is not ``sf_linked`` (#4218).
    """
    out: dict[str, _VerbatimActual] = {}
    status_date = project.status_date
    for t in task_map.values():
        actual = t.actual_start
        if actual is None or actual <= project.start_date or _is_complete(t):
            continue
        cal = cal_of[t.id]
        snapped = _next_working_day(actual, cal)
        if snapped == actual:
            continue
        cal_key = cal_key_of[t.id]
        offset_of = offset_of_by_cal[cal_key]
        last = float(len(wd_index_by_cal[cal_key]) - 1)
        if t.id in sf_linked:
            other = 0.0
            if t.planned_start is not None:
                other = _snapped_offset(t.planned_start, cal, offset_of, last)
            if status_date is not None:
                other = max(other, _snapped_offset(status_date, cal, offset_of, last))
            out[t.id] = (actual.toordinal(), _snapped_offset(actual, cal, offset_of, last), other)
            continue
        other = _snapped_offset(project.start_date, cal, offset_of, last)
        if t.planned_start is not None and t.planned_start > project.start_date:
            other = max(other, _snapped_offset(t.planned_start, cal, offset_of, last))
        if status_date is not None and status_date > project.start_date:
            other = max(other, _snapped_offset(status_date, cal, offset_of, last))
        out[t.id] = (actual.toordinal(), _snapped_offset(actual, cal, offset_of, last), other)
    return out


def _snapped_offset(d: date, cal: Calendar, offset_of: dict[date, int], last: float) -> float:
    """Offset of the next working day at or after ``d``.

    Clamped to the index start below it; past the index end it raises rather than
    clamping to ``last`` (#4429). The same lookup :func:`_mc_es_floors` floors a task
    with, so the offsets :func:`_mc_verbatim_actuals` compares against are the ones the
    forward pass holds.
    """
    snapped = _next_working_day(d, cal)
    off = offset_of.get(snapped)
    if off is not None:
        return float(off)
    # Below the index only for a pre-start date on an SF-linked task (#4218), which
    # the pad was sized to hold; the index's first day is the safe side to clamp to.
    if snapped > max(offset_of, default=snapped):
        _raise_mc_index_overrun()
    return 0.0 if snapped < min(offset_of, default=snapped) else last


def _mc_progress_state(
    project: Project,
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    task_calendars: dict[str, Calendar] | None,
    cal_of: dict[str, Calendar],
    cal_key_of: dict[str, int],
    offset_of_by_cal: dict[int, dict[date, int]],
    wd_index_by_cal: dict[int, list[date]],
    sf_linked: frozenset[str] = frozenset(),
) -> tuple[
    dict[str, float],
    dict[str, tuple[float, float]],
    dict[str, tuple[date, date]],
    dict[str, _Instant],
    dict[str, float],
]:
    """Precompute the per-run-invariant floors and progress pins (ADR-0132/0136).

    Returns ``(es_floor, completed_offsets, completed_dates, completed_instants,
    elapsed_days)``; ``completed_instants`` is :func:`_completed_dates`' milestone map.
    Completed tasks are pinned to a constant offset pair (not re-sampled) and carry
    their verbatim ``(early_start, early_finish)`` dates for the scalar
    constraint/floor paths; in-progress tasks record their fixed elapsed portion so
    only the remaining work carries uncertainty; SNET pins, recorded actual starts,
    and the data date floor every not-yet-finished task. None of these vary across
    runs, so they are computed once.

    Per-task calendars (#1385): every offset here is expressed in the *owning
    task's* working-day space, because that is the space its column of the forward
    pass lives in. ``es_floor`` therefore merges the SNET pin, the actual start,
    and the data-date floor per task rather than carrying a single project-wide
    status floor — with mixed calendars the same data date snaps to a different
    offset in each one.
    ``completed_dates`` is the exception that proves the rule: it is scalar
    ``date`` space precisely so it is calendar-neutral and can cross an edge into
    a successor on a different working week.
    """

    es_floor = _mc_es_floors(
        project, task_map, cal_of, cal_key_of, offset_of_by_cal, wd_index_by_cal, sf_linked
    )

    # The verbatim dates schedule() gives each completed task — read off an actual
    # deterministic forward pass rather than transcribed from it, so the two engines
    # cannot disagree on the completed-task arithmetic (#2460/#2461/#2572). Everything
    # downstream that must agree with schedule() — the successor constraints, the
    # terminal finish floor — is derived from THESE, in scalar date space, rather
    # than re-derived in offset space where a non-working date cannot be represented.
    completed_dates, completed_instants = _completed_dates(
        project, task_map, topo_order, g, task_calendars
    )

    completed_offsets: dict[str, tuple[float, float]] = {
        tid: _completed_offsets(
            es_date,
            ef_date,
            cal_of[tid],
            offset_of_by_cal[cal_key_of[tid]],
            wd_index_by_cal[cal_key_of[tid]],
        )
        for tid, (es_date, ef_date) in completed_dates.items()
    }

    # In-progress tasks have a fixed elapsed portion subtracted from every sampled
    # duration, so only the *remaining* work carries uncertainty (a deterministic
    # in-progress task still simulates to exactly its CPM finish). ``elapsed_days``
    # uses the same integer rule as _effective_duration_days so the engines agree.
    elapsed_days: dict[str, float] = {}
    for t in task_map.values():
        if not _is_complete(t) and t.percent_complete and t.percent_complete > 0:
            elapsed_days[t.id] = float(
                int(t.duration.days * min(t.percent_complete, 100.0) / 100.0)
            )

    return es_floor, completed_offsets, completed_dates, completed_instants, elapsed_days


class _McIndex:
    """Per-column working-day ordinals the milestone arithmetic reads (#4079)."""

    def __init__(self, wd_ord_of_col: list[np.ndarray], cal_of_col: list[Calendar]) -> None:
        self.wd_ord_of_col = wd_ord_of_col
        self.cal_of_col = cal_of_col

    def next_wd_offset(self, col: int, ordinals: np.ndarray) -> np.ndarray:
        """Offset, in ``col``'s space, of the first working day at or after each ordinal."""
        wd = self.wd_ord_of_col[col]
        off = np.searchsorted(wd, ordinals, side="left")
        # Past the index end is an undersized index, not a date: refuse it (#4429).
        if off.size and int(off.max()) > len(wd) - 1:
            _raise_mc_index_overrun()
        return off

    def prev_wd_ordinal(self, col: int, ordinals: np.ndarray) -> np.ndarray:
        """The last working day at or before each ordinal, on ``col``'s calendar.

        The index starts at the project start, but a milestone at the start of the
        project measures SF links, and FF links with no lag or a lead, from the
        working day *before* it (#4273), so a lookup
        that falls off the front is resolved against the calendar itself. An ordinal
        past the index end raises (#4429): the index cannot tell whether a working
        day lies between its last entry and the ordinal, so ``wd[-1]`` would be a guess.
        """
        wd = self.wd_ord_of_col[col]
        if ordinals.size and int(ordinals.max()) > int(wd[-1]):
            _raise_mc_index_overrun()
        raw_idx = np.searchsorted(wd, ordinals, side="right") - 1
        out = np.asarray(wd[np.clip(raw_idx, 0, len(wd) - 1)], dtype=np.int64)
        before = raw_idx < 0
        if before.any():
            cal = self.cal_of_col[col]
            for o in np.unique(ordinals[before]).tolist():
                prev = _prev_working_day(_safe_fromordinal(int(o)), cal).toordinal()
                out[before & (ordinals == o)] = prev
        return out

    def next_wd_ordinal(self, col: int, ordinals: np.ndarray) -> np.ndarray:
        """The first working day at or after each ordinal, on ``col``'s calendar.

        Like :meth:`prev_wd_ordinal`, a date before the index start — an FF/SF
        finish day measured from a project-start milestone — is resolved against
        the calendar rather than clipped to the project start.
        """
        wd = self.wd_ord_of_col[col]
        out = np.asarray(wd[self.next_wd_offset(col, ordinals)], dtype=np.int64)
        before = ordinals < wd[0]
        if before.any():
            cal = self.cal_of_col[col]
            for o in np.unique(ordinals[before]).tolist():
                nxt = _next_working_day(_safe_fromordinal(int(o)), cal).toordinal()
                out[before & (ordinals == o)] = nxt
        return out

    def ordinal_at(self, col: int, offsets: np.ndarray) -> np.ndarray:
        """The working day at each (rounded) offset in ``col``'s space."""
        wd = self.wd_ord_of_col[col]
        idx = np.rint(offsets).astype(np.int64)
        if idx.size and int(idx.max()) > len(wd) - 1:
            _raise_mc_index_overrun()  # #4429: never clamp past the index end
        return np.asarray(wd[np.maximum(idx, 0)], dtype=np.int64)


def _mc_forward_pass(
    topo_order: list[str],
    runs: int,
    g: nx.DiGraph[str],
    task_idx: dict[str, int],
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None],
    dur_matrix: np.ndarray,
    es_floor: dict[str, float],
    completed_offsets: dict[str, tuple[float, float]],
    completed_edge: dict[tuple[str, str], _FixedEdge],
    elapsed_days: dict[str, float],
    milestone_ids: frozenset[str] = frozenset(),
    index: _McIndex | None = None,
    verbatim_actuals: dict[str, _VerbatimActual] | None = None,
    milestone_floors: dict[str, _MilestoneFloors] | None = None,
) -> tuple[np.ndarray, np.ndarray, date | None]:
    """Vectorised forward pass — early-start/early-finish working-day offset matrices.

    ES and EF are floating-point working-day offsets (0 = project start); EF = ES +
    duration on the open interval (exclusive end, so a 5-day task starting at offset
    0 has EF=5, and its FS successor starts at offset 5). Each column is filled in
    ``topo_order`` so every predecessor is resolved before its successors. Returns
    the ``(runs, n_tasks)`` ES and EF matrices.

    Zero-duration milestones (``milestone_ids``, #4079) are instants, and an offset
    cannot say which midnight an instant sits on — the end of Friday and a lag that
    lands on Sunday share a working-time position but are different anchors for the
    next lag. So a milestone column also carries each run's instant as a date
    ordinal and its links are resolved in date space by
    :func:`_mc_milestone_bounds`, replaying :func:`_place_milestone` exactly. Its ES
    is the instant's position; its EF holds the exclusive offset of the day it is
    shown on, which is what the project finish reads. ``milestone_floors``
    (:func:`_mc_milestone_floors`) gives each milestone's floors in date space, the
    project start apart from the rest: the column's ES/EF are the *shown* instant
    and ``instant_mat`` the *link* instant its successors measure from, which the
    project-start floor does not raise (#4225, :func:`_place_milestone`).

    Per-task calendars (#1385) are deliberately invisible here. A task's own column
    is expressed in its own calendar's working-day space, and each edge's delta
    array already carries the hop from the predecessor's space into the
    successor's (see :func:`_build_lag_delta`), so this loop needs no calendar
    argument at all — duration still adds in the successor's own space and every
    constraint arrives pre-converted. The caller reconciles the columns into one
    comparable space before taking the project maximum.

    ``verbatim_actuals`` (:func:`_mc_verbatim_actuals`, #4175) carries each live
    task's non-working ``actual_start`` so a milestone floored at it sits on that
    instant, as ``schedule()`` puts it (an SS/SF successor of started work reads the
    actual from a constant edge instead, #4523). A milestone shown on
    its non-working actual day contributes that date as the returned finish floor
    when it is shown there in *every* run — the offset index cannot hold the day,
    so its column carries the working day before it and the caller floors the
    percentiles at the date, as it does for completed work. Where only some runs
    show it there, the column keeps the next working day (later, never earlier).

    Returns ``(es_mat, ef_mat, finish_floor)``.
    """
    n_tasks = len(topo_order)
    es_mat = np.zeros((runs, n_tasks), dtype=np.float64)
    ef_mat = np.zeros((runs, n_tasks), dtype=np.float64)
    # Milestone instants: date ordinal and start-of-day display, per run.
    instant_mat = np.zeros((runs, n_tasks), dtype=np.int64)
    start_display_mat = np.zeros((runs, n_tasks), dtype=bool)
    verbatim_actuals = verbatim_actuals or {}
    milestone_floors = milestone_floors or {}
    finish_floor: date | None = None
    # Live work whose SS/SF links measure from a derived span start (#4523,
    # _mc_span_link): elapsed working days, by task. A recorded start never reaches
    # those links here — they are constants in ``completed_edge``.
    span_elapsed = {tid: int(days) for tid, days in elapsed_days.items() if days > 0}

    for col, tid in enumerate(topo_order):
        # Completed: pin both offsets to constants across every run and skip the
        # network/sampling logic entirely.
        if tid in completed_offsets:
            es_off, ef_off = completed_offsets[tid]
            es_mat[:, col] = es_off
            ef_mat[:, col] = ef_off
            continue

        if tid in milestone_ids:
            assert index is not None
            (link, link_display), (instant, start_display) = _mc_milestone_bounds(
                tid,
                col,
                g,
                task_idx,
                (es_mat, ef_mat, instant_mat, start_display_mat),
                milestone_floors.get(tid, (None, None)),
                completed_edge,
                milestone_ids,
                index,
                runs,
                span_elapsed,
            )
            instant_mat[:, col] = link
            start_display_mat[:, col] = link_display
            position = index.next_wd_offset(col, instant)
            es_mat[:, col] = position
            # The day it is shown on (engine._instant_day), as an exclusive offset:
            # the first working day at or after the instant for a start-of-day
            # reading, the last one before it otherwise.
            ef_mat[:, col] = position + start_display
            actual = verbatim_actuals.get(tid)
            if actual is not None and bool(np.all(instant == actual[0]) and start_display.all()):
                # _place_milestone shows a milestone its actual-start floor holds on
                # that very (non-working) day. The column carries the working day
                # before it and the date itself floors the finish (#4175).
                ef_mat[:, col] = position
                floor_day = date.fromordinal(actual[0])
                finish_floor = floor_day if finish_floor is None else max(finish_floor, floor_day)
            continue

        actual = verbatim_actuals.get(tid)
        es_constraints, ef_constraints, has_ef_constraint = _mc_edge_constraints(
            tid,
            g,
            task_idx,
            edge_lag_delta,
            es_mat,
            ef_mat,
            es_floor if actual is None else {tid: actual[2]},
            completed_edge,
            runs,
            (milestone_ids, instant_mat, index, col),
            span_elapsed,
        )
        if actual is not None:
            es_constraints = np.maximum(es_constraints, actual[1])

        eff_dur = _mc_effective_duration(dur_matrix[:, col], tid, elapsed_days)
        es = es_constraints
        ef = es + eff_dur

        if has_ef_constraint:
            ef = np.maximum(ef, ef_constraints)
            # Where EF was pushed by FF/SF, ES moves back (but not below es_constraints).
            es = np.maximum(es_constraints, ef - eff_dur)
            ef = es + eff_dur

        es_mat[:, col] = es
        ef_mat[:, col] = ef

    return es_mat, ef_mat, finish_floor


def _mc_span_link(
    dep: Dependency,
    p: int,
    col: int,
    es_mat: np.ndarray,
    elapsed: int,
    index: _McIndex,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-run bound of an SS/SF link out of live work with a *derived* span start (#4523).

    The link measures from the predecessor's span start (:func:`_link_start`),
    ``elapsed`` working days before its remaining-work window — which a run's
    sampled durations move, so unlike a recorded start it is not a constant. It is
    resolved in date space with ``schedule()``'s own helpers, once per distinct
    early start across the runs: the span start can fall before the index (a
    task whose progress reaches back past the project start), where an offset
    anchor would clamp to the first cell and land the bound late.

    Returns ``(offset, proposal, start_display)``: the constraint in column
    ``col``'s offset space (an exclusive EF offset for SF), and the instant and
    reading the same link proposes to a milestone successor
    (:func:`_milestone_proposal`).
    """
    pred_cal = index.cal_of_col[p]
    succ_cal = index.cal_of_col[col]
    es_ord = index.ordinal_at(p, es_mat[:, p])
    uniq, inverse = np.unique(es_ord, return_inverse=True)
    offsets = np.empty(len(uniq), dtype=np.float64)
    proposals = np.empty(len(uniq), dtype=np.int64)
    displays = np.empty(len(uniq), dtype=bool)
    finish_bound = dep.dep_type not in _START_ANCHORED
    for k, o in enumerate(uniq.tolist()):
        span = _start_from_finish(date.fromordinal(int(o)), elapsed + 1, pred_cal)
        anchor = _edge_anchor(dep.dep_type, span, span, None, pred_cal, dep.lag)
        imposed = _next_working_day(_safe_offset(anchor, dep.lag), succ_cal)
        off = index.next_wd_offset(col, np.array([imposed.toordinal()], dtype=np.int64))
        offsets[k] = float(off[0]) + (1.0 if finish_bound else 0.0)
        raw, display = _milestone_proposal(
            dep.dep_type, dep.lag, span, span, None, pred_cal, succ_cal
        )
        proposals[k] = raw.toordinal()
        displays[k] = display
    return offsets[inverse], proposals[inverse], displays[inverse]


def _mc_milestone_bounds(
    tid: str,
    col: int,
    g: nx.DiGraph[str],
    task_idx: dict[str, int],
    mats: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    floors: _MilestoneFloors,
    completed_edge: dict[tuple[str, str], _FixedEdge],
    milestone_ids: frozenset[str],
    index: _McIndex,
    runs: int,
    span_elapsed: dict[str, int] | None = None,
) -> tuple[tuple[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]:
    """Per-run ``(link, shown)`` of a live milestone, each ``(instant ordinal, start_display)``.

    The vectorised :func:`_place_milestone`: every floor and incoming link proposes
    a raw midnight and the latest wins, a start-of-day reading winning a tie. The
    ``key = 2 * ordinal + start_display`` encoding makes that one ``maximum``, and
    :func:`_start_reading` is applied to the winner.
    ``mats`` is ``(es, ef, instant, start_display)`` for the columns filled so far;
    its instant columns hold each earlier milestone's *link* instant.

    ``floors`` is ``(hard, start)`` (:func:`_mc_milestone_floors`), both date
    ordinals in date space. ``hard`` — data date, SNET, the VERBATIM recorded actual
    start (#4175) — binds the link instant; the project-start floor ``start`` only
    the shown one (#4225). A non-working actual therefore proposes its own midnight,
    not the snapped working day the offset floor holds: ``schedule()`` places the
    milestone on Sunday 00:00, and a calendar-day lag measured from Monday instead
    lands a weekend later. An SS or SF link from started work measures from its
    verbatim actual too, and arrives as a constant in ``completed_edge`` (#4523).
    """
    es_mat, ef_mat, instant_mat, start_display_mat = mats
    hard, start = floors
    # The floor of every key: below any ordinal a proposal can produce. An SF-linked
    # milestone with no hard floor always has an SF link that offers a candidate.
    key = np.full(runs, -1 if hard is None else hard * 2 + 1, dtype=np.int64)

    def offer(ordinals: np.ndarray, start_display: np.ndarray | bool) -> None:
        np.maximum(key, ordinals * 2 + np.asarray(start_display, dtype=np.int64), out=key)

    for pred_id in g.predecessors(tid):
        # FF into a milestone is FS (engine._milestone_link, #4272).
        dep: Dependency = _milestone_link(g[pred_id][tid]["dep"])
        lag = dep.lag.days
        fixed = completed_edge.get((pred_id, tid))
        if fixed is not None:
            offer(np.full(runs, fixed[2], dtype=np.int64), fixed[3])
            continue
        p = task_idx[pred_id]
        if pred_id in milestone_ids:
            if dep.dep_type in _START_ANCHORED:
                # Mirrors engine._place_milestone (#4079 fuzz regression): the
                # predecessor's own reading only carries over at zero lag, the
                # same midnight it occupies; a nonzero lag proposes a different
                # midnight and reads fresh, like an ordinary FS/SS predecessor.
                base_display = (
                    start_display_mat[:, p] if lag == 0 else dep.dep_type == DependencyType.SS
                )
                offer(instant_mat[:, p] + lag, base_display)
                continue
            if lag > 0:
                # A positive SF lag counts from the day the instant closes (#4333).
                anchor = instant_mat[:, p] - 1
            else:
                anchor = index.prev_wd_ordinal(p, instant_mat[:, p] - 1)
        elif dep.dep_type == DependencyType.FS:
            offer(index.ordinal_at(p, ef_mat[:, p] - 1.0) + 1 + lag, False)
            continue
        elif (span_elapsed or {}).get(pred_id, 0) > 0 and dep.dep_type in (
            DependencyType.SS,
            DependencyType.SF,
        ):
            # Measured from a derived span start (#4523, _mc_span_link).
            _, proposal, display = _mc_span_link(
                dep, p, col, es_mat, (span_elapsed or {})[pred_id], index
            )
            offer(proposal, display)
            continue
        elif dep.dep_type == DependencyType.SS:
            offer(index.ordinal_at(p, es_mat[:, p]) + lag, True)
            continue
        elif lag > 0:  # SF — the day the start instant closes (#4333)
            anchor = index.ordinal_at(p, es_mat[:, p]) - 1
        else:  # SF — the working day before the predecessor's start (#4145)
            anchor = index.prev_wd_ordinal(p, index.ordinal_at(p, es_mat[:, p]) - 1)
        # SF proposes the raw midnight closing its anchor day, plus the lag (#4272).
        offer(anchor + 1 + lag, False)

    def read(winner: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        # _start_reading (#4173): an end-of-day reading needs a working day before
        # the instant. Applying it once to the winner equals applying it to every
        # proposal, because it only ever raises the flag of a key and never
        # reorders two keys.
        instant = winner // 2
        start_display = (winner % 2).astype(bool)
        # _start_reading short-circuits on a start-of-day reading, so only an
        # end-of-day one probes the day before; at date.min that day does not
        # exist, and a start-of-day winner there must not ask for it (#4265).
        day_before = np.where(start_display, instant, instant - 1)
        after_non_working = ~start_display & (index.next_wd_ordinal(col, day_before) != day_before)
        return instant, start_display | after_non_working

    shown_key = key if start is None else np.maximum(key, start * 2 + 1)
    # Nothing but the project start proposed: the link instant is the shown one.
    return read(np.where(key < 0, shown_key, key)), read(shown_key)


def _mc_edge_constraints(
    tid: str,
    g: nx.DiGraph[str],
    task_idx: dict[str, int],
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None],
    es_mat: np.ndarray,
    ef_mat: np.ndarray,
    es_floor: dict[str, float],
    completed_edge: dict[tuple[str, str], _FixedEdge],
    runs: int,
    milestones: tuple[frozenset[str], np.ndarray, _McIndex | None, int] | None = None,
    span_elapsed: dict[str, int] | None = None,
) -> tuple[np.ndarray, np.ndarray, bool]:
    """Fold every predecessor edge into one task's ES/EF constraint vectors.

    A completed predecessor's constraint is a run-invariant constant already
    resolved in scalar date space from its VERBATIM dates (#2460/#2461), so it is
    taken directly: routing it through the offset anchor + lag-delta path would
    re-derive it from the working-day index, which cannot represent a non-working
    actual and lands a day off.

    A live milestone predecessor (#4079) is read from its per-run instant —
    ``milestones`` is ``(milestone_ids, instant_mat, index, this_col)``: FS/SS
    measure from the instant, an FF or SF with a positive lag from the day it closes
    (#4273, #4333), and an FF or SF with no lag or a lead from the last working day
    before it (:func:`_edge_anchor`), then ``next_wd(anchor + lag)`` on this task's
    calendar.

    An SS or SF link from started work measures from the recorded ``actual_start``
    (:func:`_link_start`, #4523), a run-invariant date, so it arrives in
    ``completed_edge`` as a constant resolved in date space from the verbatim
    actual, like a completed predecessor's. Only an SS/SF link from work that has
    not started reaches the offset anchor below, where the start is a working day.

    Returns ``(es_constraints, ef_constraints, has_ef_constraint)``.
    """
    es_constraints = np.full(runs, es_floor.get(tid, 0.0))
    ef_constraints = np.zeros(runs)
    has_ef_constraint = False
    milestone_ids, instant_mat, index, col = milestones or (frozenset(), es_mat, None, 0)

    for pred_id in g.predecessors(tid):
        fixed = completed_edge.get((pred_id, tid))
        if fixed is not None:
            is_ef_constraint, imposed_off = fixed[0], fixed[1]
            if is_ef_constraint:
                np.maximum(ef_constraints, imposed_off, out=ef_constraints)
                has_ef_constraint = True
            else:
                np.maximum(es_constraints, imposed_off, out=es_constraints)
            continue

        dep: Dependency = g[pred_id][tid]["dep"]
        p = task_idx[pred_id]

        if pred_id in milestone_ids:
            assert index is not None
            start_anchored = dep.dep_type in _START_ANCHORED
            if start_anchored:
                anchor_ord = instant_mat[:, p]
            elif dep.lag > timedelta(0):
                # A positive FF or SF lag counts from the day the instant closes
                # (#4273, #4333); a lead counts back from the zero-lag anchor below.
                anchor_ord = instant_mat[:, p] - 1
            else:
                anchor_ord = index.prev_wd_ordinal(p, instant_mat[:, p] - 1)
            bound = index.next_wd_offset(col, anchor_ord + dep.lag.days).astype(np.float64)
            if start_anchored:
                np.maximum(es_constraints, bound, out=es_constraints)
            else:
                np.maximum(ef_constraints, bound + 1.0, out=ef_constraints)
                has_ef_constraint = True
            continue

        elapsed = (span_elapsed or {}).get(pred_id, 0)
        if elapsed > 0 and dep.dep_type in (DependencyType.SS, DependencyType.SF):
            # Measured from a derived span start (#4523, _mc_span_link).
            assert index is not None
            bound, _, _ = _mc_span_link(dep, p, col, es_mat, elapsed, index)
            if dep.dep_type == DependencyType.SS:
                np.maximum(es_constraints, bound, out=es_constraints)
            else:
                np.maximum(ef_constraints, bound, out=ef_constraints)
                has_ef_constraint = True
            continue

        delta_arr = edge_lag_delta[(pred_id, tid)]

        # Anchor: predecessor finish for FS/FF, predecessor start for SS/SF.
        if dep.dep_type in (DependencyType.FS, DependencyType.FF):
            anchor = ef_mat[:, p]
        else:
            anchor = es_mat[:, p]
        # Lag-free edges (the dominant kind) use the anchor directly instead
        # of allocating a runs-sized zeros vector and adding it — adding
        # zeros is exact in float64, so results are bit-identical (#1860).
        # The in-place maximum removes the remaining temporary; it is safe
        # because es/ef_constraints are freshly allocated owned arrays per
        # task (never views aliasing the anchor's matrix) and both start
        # fully initialized (SNET/status floors and zeros respectively).
        constraint = anchor if delta_arr is None else anchor + _lag_term(delta_arr, anchor)
        if dep.dep_type in (DependencyType.FS, DependencyType.SS):
            np.maximum(es_constraints, constraint, out=es_constraints)
        else:  # FF / SF
            np.maximum(ef_constraints, constraint, out=ef_constraints)
            has_ef_constraint = True

    return es_constraints, ef_constraints, has_ef_constraint


def _mc_effective_duration(
    sampled: np.ndarray, tid: str, elapsed_days: dict[str, float]
) -> np.ndarray:
    """Sampled duration floored at one working day, less any elapsed portion.

    The floor exists because ordinary work occupies at least its start day. It
    no longer applies to milestones (#4079): a live zero-duration task is an
    instant and never reaches this function — :func:`_mc_forward_pass` places it
    with :func:`_mc_milestone_bounds` instead. #1066 had floored milestones at a
    day too, to agree with the deterministic pass's old convention, which gave
    every milestone a whole working day.

    The fixed elapsed portion of an in-progress task is subtracted first so only
    its remaining work is sampled (ADR-0132); the 1.0 floor then applies.
    """
    if tid in elapsed_days:
        sampled = sampled - elapsed_days[tid]
    eff_dur: np.ndarray = np.maximum(sampled, 1.0)
    return eff_dur


def _to_reference_offset(ef: np.ndarray, wd_ord_own: np.ndarray, ref_ord: np.ndarray) -> np.ndarray:
    """Re-express exclusive-EF offsets from one calendar's space in the reference space.

    Working-day offsets are only comparable within the calendar that produced
    them: offset 20 on a Mon-Fri week and offset 20 on a seven-day week are
    different dates. Taking ``max`` across tasks on mixed calendars therefore has
    to happen against a shared ruler, and the finish *date* is the only thing the
    spaces agree on.

    That ruler cannot be the project calendar. A task on a seven-day week can
    finish on a Sunday, which has no offset at all in a Mon-Fri space — mapping
    into it would silently report the previous Friday. The reference is instead the
    **union** of every calendar's working days (see :func:`_build_reference_index`),
    so every reachable finish date has an offset and the conversion is lossless.

    The fractional part of the offset is carried through untouched: sampled PERT
    durations are continuous, and dropping the fraction would quantise the
    distribution the percentiles interpolate over.
    """
    k = np.rint(ef)
    ki = k.astype(np.int64)
    # An exclusive EF past the index end is an undersized index; refuse it rather
    # than clamp it onto the last indexed day (#4429).
    if ki.size and int(ki.max()) > len(wd_ord_own):
        _raise_mc_index_overrun()
    ki = np.maximum(ki, 0)
    # Inclusive last working day of the task, mirroring _offset_to_date's key - 1.
    own_ord = wd_ord_own[np.clip(ki - 1, 0, len(wd_ord_own) - 1)]
    # side="right" counts the reference working days at or before that date, which
    # IS the exclusive-EF offset in the reference space.
    ref = np.searchsorted(ref_ord, own_ord, side="right").astype(np.float64) + (ef - k)
    # A zero offset is a degenerate pin (a completed zero-duration milestone at the
    # project start); it has no "previous working day" to map through, and the
    # generic path would round it up to 1. Keep it where it is.
    return np.where(k <= 0, ef, ref)


def _build_reference_index(wd_ord_by_cal: dict[int, np.ndarray]) -> tuple[np.ndarray, list[date]]:
    """Union every calendar's working days into one ruler for the project maximum.

    A day is a reference working day iff *some* task's calendar treats it as one,
    which is the opposite of :meth:`Calendar.compose` (that unions non-working
    time, for overlaying constraints onto one resource). Here the requirement is
    representability, not constraint: every date any task can finish on must have
    an offset, or converting into the space would move the date.
    """
    ref_ord = np.unique(np.concatenate(list(wd_ord_by_cal.values())))
    return ref_ord, [date.fromordinal(int(o)) for o in ref_ord]


def _offset_to_date(
    offset: float, wd_index: list[date], completed_finish_floor: date | None
) -> date:
    """Map a working-day completion offset back to a calendar date.

    An offset past the final index entry raises rather than clamping to it (#4429):
    the index is sized to hold every reachable offset, and a clamp there reported an
    undersized index as a plausible, silently early finish date.

    ``completed_finish_floor`` is the latest verbatim ``early_finish`` across the
    project's completed tasks, which ``schedule()`` keeps unsnapped even on a
    non-working day (ADR-0136 "actuals are truth"). ``schedule().project_finish`` is
    a ``max`` over *every* task's early finish, so the project can never finish
    before that date — flooring here reproduces it exactly, and the working-day
    index (which can only return a working day) cannot (#1929/#1830).

    This replaces the earlier per-offset override map, which keyed the verbatim date
    by its rounded exclusive-EF offset: a *live* task whose completion offset rounded
    to the same key would then be reported on the completed task's weekend date. A
    floor has no such collision — it is a property of the project, not of whichever
    task happened to land on an offset (#2461).
    """
    # EF offsets are exclusive (EF=5 means working days 0..4). Subtract 1 to get the
    # last working day of the task, matching CPM's inclusive EF.
    idx = round(offset) - 1
    if idx > len(wd_index) - 1:
        _raise_mc_index_overrun()
    idx = max(0, idx)
    resolved = wd_index[idx]
    if completed_finish_floor is not None and completed_finish_floor > resolved:
        return completed_finish_floor
    return resolved


def _mc_percentiles(
    completion_offsets: np.ndarray,
    shown_offsets: np.ndarray,
    wd_index: list[date],
    finish_floor: date | None,
    floor_at_day_start: bool,
) -> list[tuple[date, bool]]:
    """P50/P80/P95 as ``(shown day, at_day_start)`` from per-run finish offsets (#4204).

    ``completion_offsets`` is each run's **working-time** finish position and
    ``shown_offsets`` the exclusive offset of the day that finish is shown on; they
    differ only for a run whose finish is a start-of-day milestone, shown one working
    day past its position.

    Percentile convention (documented for the public surface, #826): numpy.percentile
    — linear interpolation between the two nearest ranks — over the FULL run set,
    mapped to a working-day date. The position ``k`` is taken over working-time
    positions, not shown days: ordering by shown day ranked the start of a Monday
    after the end of the Friday before it, although neither is later in working time.

    Runs at one position can still be shown on different days — some at the end of a
    Friday, some at the start of the Monday. The percentile is shown on the day its
    rank lands on when runs are ordered by ``(position, shown day)``: the earliest
    shown day of a run at ``k`` on or before which at least that share of ALL runs is
    shown. So it is a two-sided quantile of ``distribution`` — at least PXX% of runs
    on or before it, and fewer than PXX% (plus one run) strictly before it — rather
    than following either the earliest or the latest reading at ``k``. It reads as the
    start of its day when that day lies past ``k``. Every candidate day is the same
    working-time position, so a delta measured in working time does not depend on
    the choice, and with no start-of-day finish it is exactly the day the pre-#4204
    shown-day ranking reported. With no run at ``k`` (interpolation between two
    positions) it is the end of the working day before ``k``.

    Limit: on mixed calendars the reference ruler can hold days a milestone's own
    calendar skips, so a start-of-day run may be shown more than one reference day
    past its position; the reading is still start-of-day, and the API reads it
    against the project calendar.
    """
    n = len(completion_offsets)
    shown_rounded = np.rint(shown_offsets)
    rounded_positions = np.rint(completion_offsets)
    out: list[tuple[date, bool]] = []
    for q, pct in zip(
        (50, 80, 95), np.percentile(completion_offsets, [50, 80, 95]).tolist(), strict=True
    ):
        k = round(pct)
        at_k = rounded_positions == k
        if at_k.any():
            candidates = np.unique(shown_rounded[at_k])  # ascending
            shown = float(candidates[-1])
            for d in candidates.tolist():
                # Integer arithmetic: at least q% of ALL runs are shown on or before d.
                if int(np.count_nonzero(shown_rounded <= d)) * 100 >= q * n:
                    shown = float(d)
                    break
            at_start = shown > k
        else:
            shown, at_start = float(k), False
        resolved = _offset_to_date(shown, wd_index, None)
        if finish_floor is not None and finish_floor > resolved:
            out.append((finish_floor, floor_at_day_start))
        else:
            out.append((resolved, at_start))
    return out


def monte_carlo(
    project: Project,
    *,
    runs: int = 1_000,
    seed: int | None = None,
    max_runs: int | None = None,
    max_tasks: int | None = None,
    sensitivity_cap: int = MC_SENSITIVITY_CAP,
    max_lag_delta_cells: int = MAX_LAG_DELTA_CELLS,
) -> MonteCarloResult:
    """Run Monte Carlo probabilistic scheduling on a project.

    Where :func:`schedule` answers "when can this finish?" with one deterministic
    date, this answers "how confident are we in that date?" with a distribution.
    The percentiles are read as: **P50** — half the runs finished by here, close to
    the CPM finish, a midpoint and never a commitment; **P80** — the conventional
    commitment date for internal and stakeholder plans; **P95** — for contractual
    or externally-visible deadlines. A P80 later than the CPM finish is not a
    disagreement between the two passes: it is the risk premium the deterministic
    pass cannot express.

    Each task's per-run duration is sampled by one of three paths, in priority order:

    1. **Agile / velocity** — a task with ``delivery_mode=SCRUM`` and
       ``story_points``, on a project carrying ``velocity_samples`` +
       ``sprint_length_days``, samples sprints-to-completion from the team's
       throughput distribution (see :func:`_sample_velocity_durations`). This is how
       sprint-delivered work contributes real velocity-driven risk to a mixed-mode
       schedule rather than being invisible to the simulation.
    2. **Three-point PERT** — a task with all of (optimistic, most_likely,
       pessimistic) set samples from a PERT-Beta distribution: a Beta fitted by
       method of moments to the classic PERT mean ``(o + 4m + p) / 6`` and
       standard deviation ``(p - o) / 6``, **not** the lambda=4 Beta-PERT of
       @RISK / Vose (ADR-1245, #4133). On a symmetric estimate its band is slightly
       narrower than lambda=4's (see :func:`_sample_pert`).
    3. **Deterministic** — any other task uses its fixed ``duration`` every run.

    A mixed project (scrum subtree + waterfall tasks) therefore produces a single
    finish-date distribution combining both sources of uncertainty.

    .. note::
       Every sampled duration is **floored at the task's own ``duration``** (#3765).
       ``Task.duration`` is the plan; a three-point estimate or a velocity signal is
       the risk band read *upward* from it. Without the floor a task whose estimates
       sat below its planned duration made P50/P80/P95 land before the earliest date
       the deterministic pass considers feasible — the simulation reporting less risk
       than the plan it is meant to stress. The consequence is that the optimistic
       tail below ``duration`` is not expressed: to model finishing ahead of plan,
       lower ``duration``. Ordering the triple does not substitute for this — a
       bracketing but left-skewed triple such as ``(1, 1, 20)`` against
       ``duration=20`` violated the binding just as hard.

    .. note::
       The per-run sprint horizon of the velocity path is capped at
       ``ceil(story_points / mean_velocity) * 4 + 10`` sprints; any run that has
       not burned down by that horizon is clamped to it rather than sampled
       further. This truncates the slow right tail, so for a team with extreme
       throughput variance the velocity-driven P80/P95 is a (very loose) *lower*
       bound on completion, not an unbiased estimate. The cap exists to keep a
       pathological bootstrap path from spinning; it is far beyond any realistic
       sprint count and does not affect typical teams.

    The CPM network is evaluated `runs` times with sampled durations.
    All 4 dependency types are handled, ``planned_start`` is honored as the
    same start-no-earlier-than floor the deterministic pass applies,
    in-progress work is floored at its recorded ``actual_start`` as
    :func:`schedule` floors it (ADR-0132 §2, #2833), and zero-duration
    milestones are instants exactly as in :func:`schedule` (#4079) — a fully
    deterministic project (no estimates, no velocity signal) simulates to
    precisely the CPM finish date. **Never before is the invariant on an FS/SS
    network**, and it holds for an uncertain one too: the early-start floors bind
    the start dates (see :func:`_mc_es_floors`) and the duration floor above binds
    the durations, so every percentile is at or after the deterministic finish for
    any input built only from Finish-to-Start and Start-to-Start dependencies. An
    ``actual_start`` recorded on a *non-working* day is equality too, not an
    exception (#4175): the working-day index cannot represent the date, but the two
    readers of it that could move the finish — a live milestone floored at it and an
    SS successor of the work it starts — resolve from the verbatim date, as
    :func:`schedule` does. (Before #4175 the bound stated here was "at most one
    working day after", and it was false: a calendar-day lag measured from the
    snapped Monday instead of Sunday re-landed across a weekend and the gap reached
    2-3 working days.) The one remaining rounding is on an *uncertain* project, where
    a milestone shown on its non-working actual day in only some runs is reported on
    the next working day in all of them — later, never earlier.

    .. note::
       **The invariant above does not hold on a network carrying a
       Finish-to-Finish or Start-to-Finish edge.** Those pin a task's *finish*, so
       the forward pass places its start back from that finish — a **longer**
       duration therefore starts the task **earlier**, and any SS successor keyed
       on that start inherits the earlier start. CPM itself is non-monotone in
       duration on such a network (the five-task shape in #3806: raising every
       duration to its pessimistic value moves the deterministic finish *back*,
       from 2026-07-09 to 2026-06-05), so no duration floor can bind a simulation
       to a finish that is not a lower bound in the first place. A percentile can
       therefore land before :func:`schedule`'s finish on an FF/SF network while
       ``monte_carlo()`` reproduces :func:`schedule` faithfully on every sampled
       scenario — measured at ~0.5% of random projects, all FF-carrying.
       ``test_monte_carlo_never_precedes_cpm`` in ``tests/test_contract_fuzz.py``
       scopes its finish-level assertion to FS/SS-only networks for exactly this
       reason. This is a **decided convention**, not an open defect (#3806): an
       FF/SF-driven task stays contiguous and right-aligned on its pinned finish,
       as MS Project renders it, in both this engine and the Rust/WASM engine.
       The alternative — start the task early and let the link push only its
       finish — would restore monotonicity at the cost of a start-to-finish span
       longer than the task's duration, which every downstream consumer (bar
       rendering, float, Monte Carlo's offset space) reads as the duration.

    Per-task calendars (ADR-0120 D3) are honored, on the same rule
    :func:`schedule` applies: a task's duration expands on its own calendar, and
    lag is consumed on the **successor's**. Each task's offsets live in its own
    calendar's working-day space; every edge carries the conversion between two
    spaces, and the per-run project maximum is taken after off-calendar columns are
    re-expressed against the project calendar — offsets from different working
    weeks are not otherwise comparable. A program-scoped project whose member
    projects each keep their own working week therefore gets a probabilistic band
    that agrees with its deterministic finish, rather than being refused (#1385).
    Computation is vectorised with numpy: 10 000 runs on a 200-task project
    takes about 60-100 ms on a current laptop CPU (measured on Apple Silicon,
    numpy 2.4, 2026-09: 63 ms for a PERT chain, 88 ms for a network mixing all
    four link types with lag) and more on a shared CI runner or an older server
    — ``tests/test_bench.py`` holds it under a 2 s regression tripwire, not the
    laptop figure (#3859). So the library imposes **no** run or task cap by
    default — ``monte_carlo(project, runs=10_000)`` simulates as written. The
    ``max_runs`` / ``max_tasks`` knobs exist for an *embedding* layer that needs
    to bound work on a synchronous request path (the TruePPM API passes its own caps and returns
    ``SimulationCapExceeded`` as a 402); a standalone caller leaves them ``None``.

    Args:
        project:   The project to simulate. Must have at least one task and
                   no cyclic dependencies.
        runs:      Number of Monte Carlo iterations. Default 1 000.
        seed:      Optional RNG seed for reproducibility. With a fixed seed the
                   sampled durations — and therefore P50/P80/P95 — are
                   deterministic and independent of task insertion order, **for
                   the same numpy version and the same trueppm-scheduler
                   version**. numpy only guarantees a ``Generator``'s stream
                   (``Generator.beta`` included) within one release (NEP 19), so
                   upgrading numpy can move seeded percentiles (#4099).
        max_runs:  Maximum allowed value for ``runs``, or ``None`` for no cap.
                   Default ``None`` — the library does not cap by itself; an
                   embedding layer (e.g. the TruePPM API) passes its own value.
        max_tasks: Maximum number of tasks allowed, or ``None`` for no cap.
                   Default ``None`` (see ``max_runs``).
        sensitivity_cap: Maximum number of tasks returned in the duration
                   sensitivity tornado. Default ``MC_SENSITIVITY_CAP``. The tornado
                   is ranked over the first ``MC_SENSITIVITY_SUBSAMPLE`` runs, so
                   its cost stays flat as ``runs`` grows; P50/P80/P95 always use
                   every run.
        max_lag_delta_cells: Ceiling on the lag-delta precompute, counted as
                   (distinct dependency type/lag/calendar-pair keys) x (working-day
                   index span) cells, each stored as a 4-byte int32. Default
                   ``MAX_LAG_DELTA_CELLS`` (50M cells, ~200 MB), sized for a batch
                   caller that owns the machine. An embedder serving concurrent
                   requests should pass a smaller value; a table above it raises
                   :class:`InvalidScheduleInput` before the offending array is
                   allocated. It does not change any computed value.

    Returns:
        MonteCarloResult with P50, P80, P95 completion dates — each an order
        statistic over working-time finish positions, with its edge-of-day reading
        in ``p50_at_day_start`` etc. (#4204) — the full sorted distribution of shown
        finish days, and the duration-sensitivity tornado (``sensitivity``).

    Raises:
        SimulationCapExceeded: If ``runs`` exceeds ``max_runs`` or the project
            has more tasks than ``max_tasks``.
        CyclicDependencyError: If the dependency graph contains a cycle.
        InvalidScheduleInput: If a calendar has no working day, a duration
            or lag is negative/out of range, the project has no tasks,
            ``runs`` is less than 1 or above the absolute ceiling, ``seed`` is
            not a non-negative int or ``None``, ``max_runs``/``max_tasks`` is
            not an int or ``None``, or ``project`` is not a :class:`Project`.
    """
    _validate_monte_carlo_args(project, runs, seed, max_runs, max_tasks)
    _validate_project(project)

    g = _build_graph(project)
    # Detect cycles via the topological sort itself (#1526), the same happy-path
    # optimization as schedule(): the lexicographic sort raises NetworkXUnfeasible
    # on a cycle in ~3ms, so the ~148ms eager nx.find_cycle runs only on the error
    # path, in _raise_cycle_error.
    #
    # Use a lexicographically-keyed topological sort so the RNG is consumed in a
    # deterministic, version-independent order. Plain ``nx.topological_sort`` only
    # guarantees *a* valid topological order; its tie-breaking is an implementation
    # detail that can shift between networkx versions (dep cap is wide:
    # networkx>=3.0,<4) and with task insertion order. Because durations are sampled
    # column-by-column in this order from a single seeded RNG, any reordering would
    # silently change seeded P50/P80/P95. Keying on the stable task id pins the order.
    try:
        topo_order: list[str] = list(nx.lexicographical_topological_sort(g, key=str))
    except nx.NetworkXUnfeasible:
        _raise_cycle_error(g)
    n_tasks = len(topo_order)
    task_idx = {tid: i for i, tid in enumerate(topo_order)}

    rng = np.random.default_rng(seed)
    calendar = project.calendar

    # --- Sample durations: shape (runs, n_tasks) ---
    task_map = {t.id: t for t in project.tasks}
    dur_matrix = _sample_duration_matrix(project, topo_order, task_map, runs, rng)

    # Pre-compute a working-day index covering the whole simulation so a lag can
    # be converted to working-day offsets against the predecessor's *actual* date
    # in each run — matching deterministic CPM, which snaps ``predecessor date +
    # lag`` to the next working day per task rather than against a single
    # reference date (issue #824). The same index is reused for the offset→date
    # conversion below. It is sized further down, once each task's calendar is known.

    # Per-task calendars (ADR-0120 D3, #1385): one working-day index per *distinct*
    # calendar, keyed by object identity — Calendar holds a mutable exceptions list
    # and is not hashable, and the resolved objects are stable for this call (the
    # same convention _forward_pass uses for its per-calendar snap memo, #1824).
    # A project with no registry resolves every task to the pass-level calendar, so
    # exactly one index is built and every downstream lookup is what it was before.
    task_calendars = _resolve_task_calendars(project)
    cal_of: dict[str, Calendar] = {
        tid: (calendar if task_calendars is None else task_calendars.get(tid, calendar))
        for tid in topo_order
    }
    cal_key_of = {tid: id(cal) for tid, cal in cal_of.items()}
    distinct_cals: dict[int, Calendar] = {id(calendar): calendar}
    distinct_cals.update({key: cal_of[tid] for tid, key in cal_key_of.items()})
    # An SF-linked task can be placed before the project start (#4218); the index then
    # opens early enough to hold it. ``pad_days`` is 0 for a project with no SF-linked
    # task, leaving every index — and so every offset — exactly as before.
    pad_days, sf_linked_ids = _mc_pre_start_pad_days(project, task_map, topo_order, g, cal_of)
    index_origin = _safe_offset(project.start_date, timedelta(days=-pad_days))
    # Every index has the same length: the most working days ANY calendar has between
    # the index origin and a calendar date no run finishes after (#4429). The bound is
    # a date, not a working-day count, because working days are not comparable across
    # calendars — D days on a four-day week span more than D days of a five-day one,
    # so a count summed over task durations undersized every denser calendar's index.
    # Sized by its densest calendar, each index therefore reaches that date.
    index_size = _mc_index_size(
        _mc_horizon(project, task_map, g, topo_order, cal_of),
        index_origin,
        distinct_cals.values(),
        n_tasks,
    )
    wd_index_by_cal = {
        key: _build_working_day_index(index_origin, cal, index_size)
        for key, cal in distinct_cals.items()
    }
    offset_of_by_cal = {
        key: {d: i for i, d in enumerate(idx)} for key, idx in wd_index_by_cal.items()
    }
    # Working-day ordinals per calendar, so each delta array is built with a single
    # vectorised searchsorted instead of an ``index_size``-long pure-Python loop of
    # ``_next_working_day`` snaps (#1205).
    wd_ord_by_cal = {
        key: np.fromiter((d.toordinal() for d in idx), dtype=np.int64, count=len(idx))
        for key, idx in wd_index_by_cal.items()
    }
    proj_cal_key = id(calendar)
    wd_index = wd_index_by_cal[proj_cal_key]

    # The working day *before* a calendar's first indexed day — the SF anchor for a
    # predecessor that starts on it (#4145). Resolved lazily and memoized: it walks
    # the calendar backwards off the index, which a project with no SF edge should
    # neither pay for nor be able to fail on.
    _prev_ord_cache: dict[int, int] = {}

    def prev_ord_of(cal_key: int) -> int:
        if cal_key not in _prev_ord_cache:
            first = wd_index_by_cal[cal_key][0]
            _prev_ord_cache[cal_key] = _prev_working_day(
                _safe_offset(first, -_ONE_DAY), distinct_cals[cal_key]
            ).toordinal()
        return _prev_ord_cache[cal_key]

    # One shared lag-delta array per distinct (dep_type, lag, pred_cal, succ_cal)
    # key, then a per-edge lookup mapping each edge to its (possibly shared,
    # possibly None) array.
    # Live zero-duration tasks whose every run samples zero are milestone instants
    # (#4079); completed ones are pinned like any completed task, and a zero-base
    # task carrying a positive estimate is simulated as the work it samples.
    milestone_ids = frozenset(
        tid
        for col, tid in enumerate(topo_order)
        if task_map[tid].duration.days == 0
        and not _is_complete(task_map[tid])
        and not dur_matrix[:, col].any()
    )
    delta_by_key = _build_lag_delta_table(
        g, wd_ord_by_cal, index_size, cal_key_of, prev_ord_of, milestone_ids, max_lag_delta_cells
    )
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None] = {
        (u, v): delta_by_key[(data["dep"].dep_type, data["dep"].lag, cal_key_of[u], cal_key_of[v])]
        for u, v, data in g.edges(data=True)
        if u not in milestone_ids
    }

    # Per-run-invariant floors and progress pins (SNET, data date, completed pins,
    # in-progress elapsed) — computed once, since none of them vary across runs.
    (
        es_floor,
        completed_offsets,
        completed_dates,
        completed_instants,
        elapsed_days,
    ) = _mc_progress_state(
        project,
        task_map,
        topo_order,
        g,
        task_calendars,
        cal_of,
        cal_key_of,
        offset_of_by_cal,
        wd_index_by_cal,
        sf_linked_ids,
    )

    # A completed task's dates are run-invariant, so both the constraints it imposes
    # on live successors and its own contribution to the project finish are resolved
    # once, in scalar date space, from the verbatim dates schedule() would give it
    # (#2460/#2461). Scalar dates are also what makes this survive mixed calendars:
    # each constraint is snapped into its own successor's space, and the floor below
    # is a date, so neither depends on the offsets being mutually comparable.
    completed_edge = _completed_edge_constraints(
        g,
        completed_dates,
        completed_instants,
        cal_of,
        cal_key_of,
        offset_of_by_cal,
        wd_index_by_cal,
        task_map,
    )
    completed_finish_floor = (
        max(ef_date for _es_date, ef_date in completed_dates.values()) if completed_dates else None
    )

    verbatim_actuals = _mc_verbatim_actuals(
        project, task_map, cal_of, cal_key_of, offset_of_by_cal, wd_index_by_cal, sf_linked_ids
    )
    es_mat, ef_mat, milestone_finish_floor = _mc_forward_pass(
        topo_order,
        runs,
        g,
        task_idx,
        edge_lag_delta,
        dur_matrix,
        es_floor,
        completed_offsets,
        completed_edge,
        elapsed_days,
        milestone_ids,
        _McIndex(
            [wd_ord_by_cal[cal_key_of[tid]] for tid in topo_order],
            [cal_of[tid] for tid in topo_order],
        ),
        verbatim_actuals,
        _mc_milestone_floors(project, task_map, milestone_ids, cal_of, sf_linked_ids),
    )
    # Working-time finish of each column (#4204). Work ends at its EF. A live
    # milestone's EF is the exclusive offset of the day it is *shown* on, one past its
    # instant for a start-of-day reading, so its working-time position is its ES —
    # the end of a Friday and the start of the next Monday are the same position.
    wt_mat = ef_mat
    milestone_cols = [task_idx[tid] for tid in milestone_ids]
    if milestone_cols:
        wt_mat = ef_mat.copy()
        wt_mat[:, milestone_cols] = es_mat[:, milestone_cols]
    # The floor wins over the index only when it is later; it is a start-of-day
    # reading exactly when it comes from a milestone shown at the start of its
    # non-working actual day and no completed work finishes that day or later.
    floor_at_day_start = milestone_finish_floor is not None and (
        completed_finish_floor is None or milestone_finish_floor > completed_finish_floor
    )
    if milestone_finish_floor is not None:
        # A live milestone shown on its non-working actual day is a finish date the
        # working-day index cannot hold; floor at it as at completed work (#4175).
        completed_finish_floor = (
            milestone_finish_floor
            if completed_finish_floor is None
            else max(completed_finish_floor, milestone_finish_floor)
        )

    # --- Project completion offset = max EF across all tasks per run ---
    # With one calendar every column is already on the same ruler and the maximum
    # is taken exactly as it always was. With several, each column is re-expressed
    # against the union-of-working-days reference index first — raw offsets from
    # different working weeks are not comparable, and the larger offset is often
    # the earlier date.
    if len(wd_index_by_cal) > 1:
        ref_ord, wd_index = _build_reference_index(wd_ord_by_cal)

        def _to_reference(mat: np.ndarray) -> np.ndarray:
            return np.column_stack(
                [
                    _to_reference_offset(mat[:, col], wd_ord_by_cal[cal_key_of[tid]], ref_ord)
                    for col, tid in enumerate(topo_order)
                ]
            )

        ef_mat_ref = _to_reference(ef_mat)
        wt_mat = _to_reference(wt_mat) if milestone_cols else ef_mat_ref
        ef_mat = ef_mat_ref
    shown_offsets = ef_mat.max(axis=1)  # shape (runs,): the day each run is shown on
    completion_offsets = wt_mat.max(axis=1)  # shape (runs,): its working-time position
    # Convert offsets back to dates via the working-day index (reused from above).
    all_dates = sorted(
        _offset_to_date(o, wd_index, completed_finish_floor) for o in shown_offsets.tolist()
    )
    percentiles = _mc_percentiles(
        completion_offsets, shown_offsets, wd_index, completed_finish_floor, floor_at_day_start
    )
    (p50, p50_start), (p80, p80_start), (p95, p95_start) = percentiles

    # Duration-sensitivity tornado (ADR-0140) — which tasks' sampled durations
    # most move the finish, from the same sampled matrix (no second pass). Computed
    # over a fixed subsample of the runs (#1525): the tornado ranks tasks by
    # |spearman(duration, finish)|, which converges long before the full run count,
    # so ranking every column over all runs is wasted work at scale. The first
    # ``MC_SENSITIVITY_SUBSAMPLE`` rows are a valid subsample — each run is an
    # i.i.d. iteration with no ordering — and a contiguous slice keeps the choice
    # deterministic and task-order-independent (no RNG, no copy). Slicing past the
    # end returns every row, so runs <= the cap needs no special case. Percentiles
    # above use the FULL distribution; only the ranking is subsampled.
    sensitivity = _duration_sensitivity(
        dur_matrix[:MC_SENSITIVITY_SUBSAMPLE],
        completion_offsets[:MC_SENSITIVITY_SUBSAMPLE],
        topo_order,
        sensitivity_cap,
    )

    return MonteCarloResult(
        project_id=project.id,
        runs=runs,
        p50=p50,
        p80=p80,
        p95=p95,
        distribution=all_dates,
        sensitivity=sensitivity,
        p50_at_day_start=p50_start,
        p80_at_day_start=p80_start,
        p95_at_day_start=p95_start,
    )
