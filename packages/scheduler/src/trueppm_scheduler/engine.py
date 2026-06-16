"""CPM scheduling engine and Monte Carlo simulation for trueppm-scheduler."""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

import networkx as nx
import numpy as np

from trueppm_scheduler.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    Task,
)

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class CyclicDependencyError(ValueError):
    """Raised when the dependency graph contains a cycle.

    The offending cycle is provided so callers can surface it to users
    without parsing a raw networkx exception.
    """

    def __init__(self, cycle: list[str]) -> None:
        self.cycle = cycle
        ids = " → ".join(cycle)
        super().__init__(f"Cyclic dependency detected: {ids}")


class SimulationCapExceeded(ValueError):
    """Raised when n_simulations or task count exceeds the configured cap.

    The message is user-facing and suitable for inclusion in an API response
    body without further processing.
    """


class InvalidScheduleInput(ValueError):
    """Raised when a project's input is structurally valid but out of range.

    Covers the degenerate inputs that would otherwise drive the day-by-day
    calendar walk into a multi-million-iteration spin and an uncaught
    ``OverflowError`` (a calendar with no working day, an absurd duration or
    lag), plus malformed ``children_map`` cycles. Subclasses :class:`ValueError`
    so existing ``except ValueError`` callers keep working; raised eagerly at
    the public entry points so a single hostile project can never tie up a
    worker. The message is user-facing.
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
# float64 — generous for any real network (a handful of distinct lags over a span
# of tens of thousands of days) and far below the multi-GB blowup a hostile graph
# would otherwise force. Checked incrementally as keys are discovered, before the
# offending array is materialised.
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


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ScheduleResult:
    """Output of a CPM schedule calculation.

    Each task in ``tasks`` carries early/late start and finish, total float, free
    float, and an ``is_critical`` flag. ``free_float``, ``total_float``, and
    ``is_critical`` all account for every dependency type (FS/SS/FF/SF) per the
    standard critical-path float definitions.
    """

    project_id: str
    project_start: date
    project_finish: date
    tasks: list[Task]  # copies with all CPM fields populated
    critical_path: list[str]  # task IDs in topological order along the critical path

    def __post_init__(self) -> None:
        # Defensive copy of the sequence containers (#826): the result owns its
        # lists, so a caller mutating the list it passed in — or the engine
        # reusing its internal working list — can't retroactively alter a returned
        # ScheduleResult. The Task objects are already CPM-field copies.
        self.tasks = list(self.tasks)
        self.critical_path = list(self.critical_path)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "project_start": self.project_start.isoformat(),
            "project_finish": self.project_finish.isoformat(),
            "tasks": [t.to_dict() for t in self.tasks],
            "critical_path": self.critical_path,
        }


@dataclass
class MonteCarloResult:
    """Output of a Monte Carlo probabilistic schedule simulation."""

    project_id: str
    runs: int
    p50: date
    p80: date
    p95: date
    # Full sorted distribution of simulated completion dates.
    # Useful for rendering histogram tooltips in the UI.
    distribution: list[date] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "runs": self.runs,
            "p50": self.p50.isoformat(),
            "p80": self.p80.isoformat(),
            "p95": self.p95.isoformat(),
            "distribution": [d.isoformat() for d in self.distribution],
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
            "The schedule span pushed a date past the representable range; use an "
            "earlier project start date or reduce durations/lags."
        ) from err


def _next_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the next working day.

    Guarded against a degenerate calendar (no working day, or exceptions
    blanketing the search window): rather than spin to the ``date`` ceiling and
    raise an opaque ``OverflowError``, it bails out with an actionable
    :class:`InvalidScheduleInput` after :data:`MAX_CALENDAR_SCAN_DAYS`.
    """
    scanned = 0
    while not calendar.is_working_day(d):
        if scanned >= MAX_CALENDAR_SCAN_DAYS:
            raise InvalidScheduleInput(
                f"Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days "
                "of the requested date; check the working_days bitmask and exceptions."
            )
        d = _safe_offset(d, timedelta(days=1))
        scanned += 1
    return d


def _prev_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the previous working day.

    Guarded symmetrically to :func:`_next_working_day`.
    """
    scanned = 0
    while not calendar.is_working_day(d):
        if scanned >= MAX_CALENDAR_SCAN_DAYS:
            raise InvalidScheduleInput(
                f"Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days "
                "of the requested date; check the working_days bitmask and exceptions."
            )
        d = _safe_offset(d, timedelta(days=-1))
        scanned += 1
    return d


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
    """
    step = timedelta(days=1) if forward else timedelta(days=-1)
    scanned = 0
    while True:
        current = _safe_offset(current, step)
        scanned += 1
        if calendar.is_working_day(current):
            return current
        if scanned >= MAX_CALENDAR_SCAN_DAYS:
            raise InvalidScheduleInput(
                f"Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days "
                "of the requested date; check the working_days bitmask and exceptions."
            )


def _finish_from_start(start: date, duration_days: int, calendar: Calendar) -> date:
    """Return the last working day of a task given its start and working-day duration.

    A duration of 1 means the task occupies only the start day.
    A duration of 0 is treated as a milestone: returns the start day.
    """
    if duration_days <= 0:
        return start
    remaining = duration_days - 1
    current = start
    while remaining > 0:
        current = _scan_for_working_day(current, calendar, forward=True)
        remaining -= 1
    return current


def _start_from_finish(finish: date, duration_days: int, calendar: Calendar) -> date:
    """Return the first working day of a task given its finish and working-day duration.

    Inverse of _finish_from_start.
    """
    if duration_days <= 0:
        return finish
    remaining = duration_days - 1
    current = finish
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
    """
    if end <= start:
        return 0
    count = 0
    current = start
    while current < end:
        if calendar.is_working_day(current):
            count += 1
        current += timedelta(days=1)
    return count


def _advance_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Advance d by lag calendar days and snap to the next working day."""
    return _next_working_day(_safe_offset(d, lag), calendar)


def _retreat_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Retreat d by lag calendar days and snap to the previous working day."""
    return _prev_working_day(_safe_offset(d, -lag), calendar)


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


def _check_cycles(g: nx.DiGraph[str]) -> None:
    """Raise CyclicDependencyError if the graph contains a cycle."""
    try:
        cycle = nx.find_cycle(g)
        raise CyclicDependencyError([u for u, _ in cycle] + [cycle[-1][1]])
    except nx.NetworkXNoCycle:
        pass


def find_cycle(
    edges: list[tuple[str, str]],
    children_map: dict[str, list[str]] | None = None,
) -> list[str] | None:
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
        The cycle as an ordered list of task IDs with the first repeated at
        the end (e.g. ``['A', 'B', 'C', 'A']``) so callers can render an
        unambiguous path. Returns ``None`` if the graph is acyclic.

    Raises:
        InvalidScheduleInput: If ``children_map`` itself is malformed — it
            contains a cycle (a summary that is its own ancestor) or a summary
            with an empty children list — distinct from a cycle in the
            ``edges`` being validated, which is returned, not raised. Also
            raised if expanding summary→summary edges would exceed
            :data:`MAX_EXPANDED_EDGES` leaf-level tuples (a pathological cross
            product); the graph is rejected rather than allowed to spin.
    """
    # Validate the raw input shape up front so a malformed call to this public API
    # raises the documented InvalidScheduleInput rather than a bare NetworkXError /
    # TypeError from deep inside networkx or _collect_leaves (#1209).
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
    if children_map is not None:
        for sid, kids in children_map.items():
            if not isinstance(kids, list):
                raise InvalidScheduleInput(
                    f"children_map[{sid!r}] must be a list of child ids (got {kids!r})."
                )

    if children_map:
        edge_list = _expand_edges_for_cycle_check(edge_list, children_map)
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from(edge_list)
    try:
        cycle = nx.find_cycle(g)
    except nx.NetworkXNoCycle:
        return None
    return [u for u, _ in cycle] + [cycle[-1][1]]


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

    # Resolve each endpoint to its leaves once and cache it: an endpoint id can
    # recur across many edges, and _collect_leaves walks the subtree each call.
    leaves_cache: dict[str, list[str]] = {}

    def _leaves(node_id: str) -> list[str]:
        if node_id not in summary_ids:
            return [node_id]
        cached = leaves_cache.get(node_id)
        if cached is None:
            cached = _collect_leaves(node_id, children_map)
            leaves_cache[node_id] = cached
        return cached

    # Bound the cross product from leaf *counts* before materialising a single
    # tuple (#357). The worst case — a wide summary→summary edge — is O(P*S) per
    # edge; summing the per-edge products up front lets us reject a pathological
    # graph in O(edges + leaves) instead of after building millions of tuples (or
    # timing out). The estimate is an upper bound (it ignores cross-edge dedup),
    # which is the safe direction: we never under-count and let a blowup through.
    estimated = 0
    for pred_id, succ_id in edges:
        estimated += len(_leaves(pred_id)) * len(_leaves(succ_id))
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
        for p in _leaves(pred_id):
            for s in _leaves(succ_id):
                key = (p, s)
                if key in seen:
                    continue
                seen.add(key)
                expanded.append(key)
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
) -> None:
    """Compute early_start and early_finish for every task (in-place).

    Progress-aware (ADR-0132): a completed task (``actual_finish`` set) is pinned
    to its recorded dates and removed from network logic; an in-progress task
    contributes only its remaining duration; and when ``status_date`` (the data
    date) is given, remaining/not-started work is floored at it — future work is
    never scheduled in the past. With no actuals and no status date the result is
    byte-identical to a pure planning pass.
    """
    start_base = _next_working_day(project_start, calendar)
    # The data date floors all not-yet-finished work: nothing remaining can be
    # scheduled before "as of now". A status date at or before project start is
    # already covered by the project-start floor. Completed work is historical and
    # is deliberately *not* floored at the data date (handled below).
    start = start_base
    if status_date is not None:
        start = max(start_base, _next_working_day(status_date, calendar))

    for node_id in topo_order:
        task = task_map[node_id]

        # Completed (actual_finish set, or percent_complete >= 100): laid out at its
        # FULL duration so the bar keeps its shape (ADR-0136). Whatever actuals exist
        # anchor the span; a missing endpoint is derived from full duration. Actuals
        # are truth, so a pinned task is taken out of network logic entirely (it may
        # even sit before a predecessor — out-of-sequence reality is surfaced).
        if _is_complete(task):
            full_days = task.duration.days
            if task.actual_finish is not None:
                # Finish is known; start is the recorded actual, else a full
                # duration back from the finish (the actual_finish drives FS
                # successors, the resolved start drives SS/SF successors).
                task.early_finish = task.actual_finish
                task.early_start = (
                    task.actual_start
                    if task.actual_start is not None
                    else _start_from_finish(task.actual_finish, full_days, calendar)
                )
                continue
            if task.actual_start is not None:
                # Start is known (e.g. a REVIEW task: done, awaiting sign-off);
                # lay the full duration forward from it.
                task.early_start = task.actual_start
                task.early_finish = _finish_from_start(task.actual_start, full_days, calendar)
                continue
            # No actuals recorded: a full-duration CPM planning position, anchored at
            # the un-floored project start rather than the data date.
            duration_days = full_days
            es_constraints: list[date] = [start_base]
        else:
            # In-progress work contributes only what is left, laid forward from the
            # data date; not-started work uses its full estimate.
            duration_days = _effective_duration_days(task)
            es_constraints = [start]

        # Collect ES and EF constraints from all predecessor dependencies.
        # planned_start (SNET) is an additional ES lower-bound: the task may
        # not start before this date regardless of network logic.
        if task.planned_start is not None:
            es_constraints.append(_next_working_day(task.planned_start, calendar))
        ef_constraints: list[date] = []

        for pred_id in g.predecessors(node_id):
            pred = task_map[pred_id]
            dep: Dependency = g[pred_id][node_id]["dep"]
            lag = dep.lag  # timedelta (calendar days)
            # Predecessors are visited first in topological order, so these are always set.
            assert pred.early_start is not None and pred.early_finish is not None

            if dep.dep_type == DependencyType.FS:
                # Successor cannot start until the day after predecessor finishes + lag.
                # EF is inclusive, so add 1 day to move past it, then add lag.
                es_constraints.append(
                    _next_working_day(
                        _safe_offset(pred.early_finish, timedelta(days=1) + lag), calendar
                    )
                )
            elif dep.dep_type == DependencyType.SS:
                # Successor cannot start before predecessor starts + lag.
                es_constraints.append(_advance_calendar_days(pred.early_start, lag, calendar))
            elif dep.dep_type == DependencyType.FF:
                # Successor cannot finish before predecessor finishes + lag.
                ef_constraints.append(_advance_calendar_days(pred.early_finish, lag, calendar))
            elif dep.dep_type == DependencyType.SF:
                # Successor cannot finish before predecessor starts + lag.
                ef_constraints.append(_advance_calendar_days(pred.early_start, lag, calendar))

        # ES = latest of all ES constraints.
        task.early_start = max(es_constraints)
        task.early_finish = _finish_from_start(task.early_start, duration_days, calendar)

        # Apply EF constraints (from FF/SF dependencies).
        if ef_constraints:
            min_ef = max(ef_constraints)
            if min_ef > task.early_finish:
                task.early_finish = min_ef
                # Pull ES back to match: task must start early enough to hit EF.
                back_start = _start_from_finish(task.early_finish, duration_days, calendar)
                # ES cannot go below its own constraints.
                task.early_start = max(back_start, max(es_constraints))
                # Recompute EF from the (possibly adjusted) ES.
                task.early_finish = max(
                    _finish_from_start(task.early_start, duration_days, calendar),
                    min_ef,
                )


def _backward_pass(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    project_finish: date,
    calendar: Calendar,
) -> None:
    """Compute late_start and late_finish for every task (in-place).

    Progress-aware (ADR-0132/0136): a completed task carries zero float (late ==
    early — it is done, it has no slack), reusing the full-duration span the forward
    pass resolved, and an in-progress task's late dates span only its remaining
    duration, matching the forward pass so total/free float stay internally
    consistent.
    """
    for node_id in reversed(topo_order):
        task = task_map[node_id]

        # Completed (actual_finish set, or percent_complete >= 100): late == early,
        # so the task carries zero float and never distorts the critical path. The
        # forward pass already resolved its full-duration span (ADR-0136).
        if _is_complete(task):
            assert task.early_start is not None and task.early_finish is not None
            task.late_finish = task.early_finish
            task.late_start = task.early_start
            continue

        duration_days = _effective_duration_days(task)

        # Collect LF and LS constraints from all successor dependencies.
        lf_constraints: list[date] = [project_finish]
        ls_constraints: list[date] = []

        for succ_id in g.successors(node_id):
            succ = task_map[succ_id]
            dep: Dependency = g[node_id][succ_id]["dep"]
            lag = dep.lag
            # Successors are visited first in reverse topo order, so these are always set.
            assert succ.late_start is not None and succ.late_finish is not None

            if dep.dep_type == DependencyType.FS:
                # Predecessor must finish the day before successor's late start minus lag.
                lf_constraints.append(
                    _prev_working_day(
                        _safe_offset(succ.late_start, -timedelta(days=1) - lag), calendar
                    )
                )
            elif dep.dep_type == DependencyType.SS:
                # Predecessor must start no later than successor's late start minus lag.
                ls_constraints.append(_retreat_calendar_days(succ.late_start, lag, calendar))
            elif dep.dep_type == DependencyType.FF:
                # Predecessor must finish no later than successor's late finish minus lag.
                lf_constraints.append(_retreat_calendar_days(succ.late_finish, lag, calendar))
            elif dep.dep_type == DependencyType.SF:
                # Predecessor must start no later than successor's late finish minus lag.
                ls_constraints.append(_retreat_calendar_days(succ.late_finish, lag, calendar))

        # LF = earliest of all LF constraints (binding constraint).
        task.late_finish = min(lf_constraints)
        task.late_start = _start_from_finish(task.late_finish, duration_days, calendar)

        # Apply LS constraints (from SS/SF dependencies).
        if ls_constraints:
            max_ls = min(ls_constraints)
            if max_ls < task.late_start:
                task.late_start = max_ls
                # Push LF forward to match.
                fwd_finish = _finish_from_start(task.late_start, duration_days, calendar)
                task.late_finish = min(
                    fwd_finish,
                    min(lf_constraints),
                )


def _compute_floats(
    task_map: dict[str, Task],
    topo_order: list[str],
    g: nx.DiGraph[str],
    calendar: Calendar,
) -> None:
    """Compute total_float, free_float, and is_critical for every task (in-place).

    ``total_float`` is the working-day span between a task's early and late start;
    a task is ``is_critical`` when it is zero.

    ``free_float`` is the number of working days a task can slip without delaying
    the early start (FS/SS links) or the early finish (FF/SF links) of *any* of
    its successors — the standard critical-path-method definition of free float,
    evaluated across **all four** dependency types. For each
    successor link we take the early date this task imposes on the successor —
    the *same* constraint the forward pass applies (see :func:`_forward_pass`) —
    and measure the working-day slack to the successor's actual early date. Free
    float is the minimum of those slacks, capped at total float; a task with no
    successors falls back to its total float. (Earlier versions inspected FS
    successors only and let SS/FF/SF tasks report ``free_float == total_float``;
    that FS-only caveat is now removed — see issue #825.)
    """
    for node_id in topo_order:
        task = task_map[node_id]

        # Total float: working days between early_start and late_start.
        # A task is critical when this is zero (cannot be delayed at all).
        # All passes have run by now, so these fields are always set.
        assert task.early_start is not None and task.late_start is not None
        assert task.early_finish is not None
        tf_days = _working_days_between(task.early_start, task.late_start, calendar)
        task.total_float = timedelta(days=tf_days)
        task.is_critical = tf_days == 0

        # Free float: the smallest slack to any successor, across every dependency
        # type. ``imposed`` is the early date this task forces on the successor
        # through the link (mirroring _forward_pass so the two can never disagree
        # about when this task begins to push a successor); ``succ_date`` is the
        # successor's matching early date. For a lag-free FS link with EF=Fri and
        # succ.ES=Mon the slack is 0 (no room to slip). The upper bound is total
        # float, which is also the value when a task has no successors.
        ff_days = tf_days
        for succ_id in g.successors(node_id):
            succ = task_map[succ_id]
            dep: Dependency = g[node_id][succ_id]["dep"]
            lag = dep.lag
            assert succ.early_start is not None and succ.early_finish is not None
            if dep.dep_type == DependencyType.FS:
                imposed = _next_working_day(
                    _safe_offset(task.early_finish, timedelta(days=1) + lag), calendar
                )
                succ_date = succ.early_start
            elif dep.dep_type == DependencyType.SS:
                imposed = _advance_calendar_days(task.early_start, lag, calendar)
                succ_date = succ.early_start
            elif dep.dep_type == DependencyType.FF:
                imposed = _advance_calendar_days(task.early_finish, lag, calendar)
                succ_date = succ.early_finish
            else:  # SF: successor finish is bounded by this task's start + lag
                imposed = _advance_calendar_days(task.early_start, lag, calendar)
                succ_date = succ.early_finish
            slack = _working_days_between(imposed, succ_date, calendar)
            ff_days = min(ff_days, max(0, slack))

        task.free_float = timedelta(days=max(0, ff_days))


# ---------------------------------------------------------------------------
# Summary task dependency expansion
# ---------------------------------------------------------------------------


def _check_children_map(children_map: dict[str, list[str]]) -> None:
    """Reject a summary entry with an empty child list (#1070).

    ``_collect_leaves`` treats a node with no children as a leaf, so an empty
    entry made the summary id *itself* survive expansion as a leaf — while
    ``expand_summary_dependencies`` removed it from the task list, leaving a
    dangling edge that later failed with a generic "unknown task" ValueError
    far from the actual mistake.
    """
    for sid, kids in children_map.items():
        if not kids:
            raise InvalidScheduleInput(
                f"Summary task {sid!r} has an empty children list; remove it from "
                "children_map or give it children."
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
) -> tuple[list[Task], list[Dependency]]:
    """Expand summary task dependencies into leaf-level edges.

    Summary tasks (those with entries in children_map) are removed from the
    task list. Dependencies involving summary tasks are fanned out to all
    their leaf descendants, producing a cross-product of edges. Self-referencing
    edges (where predecessor == successor after expansion) are skipped.
    Duplicate edges are deduplicated.

    Args:
        tasks: All tasks including summaries.
        deps: Dependencies that may reference summary tasks.
        children_map: Mapping of summary task ID to list of direct child IDs.

    Returns:
        (leaf_tasks, expanded_deps): Tasks with summaries removed, and
        dependencies expanded to leaf-level edges.
    """
    if not children_map:
        return tasks, deps
    _check_children_map(children_map)

    summary_ids = set(children_map.keys())
    leaf_tasks = [t for t in tasks if t.id not in summary_ids]

    # Resolve each endpoint to its leaves once and cache it (#1208): an endpoint id
    # recurs across many edges and _collect_leaves walks the subtree on each call.
    # Mirrors the caching the cycle-check twin (_expand_edges_for_cycle_check)
    # already does — the asymmetry was a missed optimization here.
    leaves_cache: dict[str, list[str]] = {}

    def _leaves(node_id: str) -> list[str]:
        if node_id not in summary_ids:
            return [node_id]
        cached = leaves_cache.get(node_id)
        if cached is None:
            cached = _collect_leaves(node_id, children_map)
            leaves_cache[node_id] = cached
        return cached

    # Bound the cross product from leaf *counts* before materialising a single
    # Dependency (#1208). A summary→summary edge fans out to len(L(pred)) *
    # len(L(succ)) objects, so without this a wide top-of-WBS edge produces millions
    # of Dependency objects (and a graph that then chokes schedule()). The
    # cheap cycle-check path already enforces MAX_EXPANDED_EDGES the same way; the
    # expensive real-expansion path was the one missing the guard.
    estimated = 0
    for dep in deps:
        estimated += len(_leaves(dep.predecessor_id)) * len(_leaves(dep.successor_id))
        if estimated > MAX_EXPANDED_EDGES:
            raise InvalidScheduleInput(
                f"Expanding summary dependencies to leaf level would exceed "
                f"{MAX_EXPANDED_EDGES:,} edges. A summary→summary dependency is fanning "
                "out to the cross product of both summaries' leaves — depend on specific "
                "leaf tasks, or split the wide summary edge, and retry."
            )

    seen: set[tuple[str, str]] = set()
    expanded: list[Dependency] = []

    for dep in deps:
        preds = _leaves(dep.predecessor_id)
        succs = _leaves(dep.successor_id)

        for p in preds:
            for s in succs:
                if p == s:
                    continue
                key = (p, s)
                if key in seen:
                    continue
                seen.add(key)
                expanded.append(
                    Dependency(
                        predecessor_id=p,
                        successor_id=s,
                        dep_type=dep.dep_type,
                        lag=dep.lag,
                    )
                )

    return leaf_tasks, expanded


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def _check_duration(td: timedelta, label: str) -> None:
    """Reject a negative or absurdly large working-day duration."""
    days = td.days
    if days < 0:
        raise InvalidScheduleInput(f"{label} must not be negative (got {days} days).")
    if days > MAX_DURATION_DAYS:
        raise InvalidScheduleInput(
            f"{label} exceeds the maximum of {MAX_DURATION_DAYS} days (got {days})."
        )


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
    positive = [s for s in project.velocity_samples if s is not None and s > 0]
    if not positive:
        return 0
    mean = sum(positive) / len(positive)
    # Deliberately the *uncapped* horizon — not clamped to MAX_VELOCITY_SPRINTS like
    # the sampler (#1202). This term must remain a safe upper bound for its two
    # callers: it sizes the MC working-day index (an under-estimate would undersize
    # the index and silently clamp a sampled completion, #1067) and it counts the
    # task against MAX_PROJECT_SPAN_DAYS (the eager span-guard rejection of a hostile
    # ``story_points`` depends on this staying unclamped — clamp it and a 1e12-point
    # task slips the guard and is silently mis-forecast instead of rejected). The
    # sampler's absolute cap only ever makes the real horizon *smaller* than this,
    # so it stays an upper bound; it is exact whenever the cap does not bind.
    max_sprints = math.ceil(task.story_points / mean) * 4 + 10
    return int(max_sprints) * project.sprint_length_days


def _validate_project(project: Project) -> None:
    """Reject degenerate input before any calendar walk runs.

    A pure-Python CPM pass walks the calendar one day at a time, so an empty
    working-day mask or a century-long duration/lag turns into a multi-million-
    iteration spin. Validating here keeps a single hostile or fat-fingered
    project from tying up the caller (notably the synchronous Monte Carlo
    request path in the TruePPM API).
    """
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

    # Reachability probe: a working day must exist within MAX_CALENDAR_SCAN_DAYS
    # of the project start. Catches a valid weekday mask whose `exceptions`
    # blanket the schedule — the common degenerate case — eagerly and with the
    # same message on every entry point, rather than relying on whichever pass
    # happens to hit a snap helper first. schedule()'s forward pass snaps the
    # start anyway, but monte_carlo() builds its working-day index without a prior
    # snap, so before this probe a blanket-exceptions calendar drove the MC path
    # into an uncaught OverflowError. Mirrors the Rust engine's validate_project
    # (#749) so both engines reject identically at the validation layer.
    _next_working_day(project.start_date, project.calendar)

    # Non-finite agile inputs crash deep inside the velocity sampler (NaN/inf
    # story_points hit ``int(np.ceil(...))``; an inf velocity sample passes the
    # ``> 0`` filter and poisons the bootstrap mean), so reject them eagerly
    # with the documented exception type (#1070).
    if project.velocity_samples is not None:
        for s in project.velocity_samples:
            if s is None:
                continue
            # isinstance gate before math.isfinite (#1209): a string sample would
            # otherwise raise a bare TypeError from isfinite. bool is an int subclass
            # but never a meaningful velocity, so reject it explicitly.
            if isinstance(s, bool) or not isinstance(s, (int, float)) or not math.isfinite(s):
                raise InvalidScheduleInput(
                    f"velocity_samples must contain only finite numbers (got {s!r})."
                )

    for t in project.tasks:
        # Type guards for the direct-object API (#1209): the from_dict/from_json path
        # already coerces these, but a caller building Task objects by hand can pass
        # the wrong type, which otherwise leaks AttributeError/TypeError from deep in
        # a pass instead of the documented InvalidScheduleInput. datetime is a date
        # subclass but mixes badly with date arithmetic, so reject it for planned_start.
        if not isinstance(t.duration, timedelta):
            raise InvalidScheduleInput(
                f"Task {t.id!r} duration must be a timedelta (got {t.duration!r})."
            )
        if t.planned_start is not None and (
            not isinstance(t.planned_start, date) or isinstance(t.planned_start, datetime)
        ):
            raise InvalidScheduleInput(
                f"Task {t.id!r} planned_start must be a date, not {type(t.planned_start).__name__}."
            )
        _check_duration(t.duration, f"Task {t.id!r} duration")
        for field_name, value in (
            ("optimistic_duration", t.optimistic_duration),
            ("most_likely_duration", t.most_likely_duration),
            ("pessimistic_duration", t.pessimistic_duration),
        ):
            if value is not None:
                _check_duration(value, f"Task {t.id!r} {field_name}")
        # A complete three-point estimate must be ordered. An inconsistent one
        # (most_likely outside [optimistic, pessimistic], or optimistic above
        # pessimistic) used to be silently "handled" by _sample_pert's degenerate
        # fallback — every run sampling the constant most_likely, possibly beyond
        # the user's own pessimistic bound (#1069). Partial estimates are not
        # validated: Monte Carlo only samples when all three are present.
        if (
            t.optimistic_duration is not None
            and t.most_likely_duration is not None
            and t.pessimistic_duration is not None
        ):
            o = t.optimistic_duration.days
            m = t.most_likely_duration.days
            pe = t.pessimistic_duration.days
            if not o <= m <= pe:
                raise InvalidScheduleInput(
                    f"Task {t.id!r} three-point estimates must satisfy "
                    f"optimistic <= most_likely <= pessimistic "
                    f"(got {o} <= {m} <= {pe} days)."
                )
        if t.story_points is not None and (
            isinstance(t.story_points, bool)
            or not isinstance(t.story_points, (int, float))
            or not math.isfinite(t.story_points)
        ):
            raise InvalidScheduleInput(
                f"Task {t.id!r} story_points must be a finite number (got {t.story_points!r})."
            )
        # planned_start (SNET) extends the schedule directly, so it is bounded by
        # the same span cap as durations and lags — otherwise a pin in year 9999
        # is accepted and drives the Monte Carlo working-day index build into a
        # multi-million-entry walk (#1068).
        if (
            t.planned_start is not None
            and (t.planned_start - project.start_date).days > MAX_PROJECT_SPAN_DAYS
        ):
            raise InvalidScheduleInput(
                f"Task {t.id!r} planned_start is more than {MAX_PROJECT_SPAN_DAYS} days "
                "after the project start; the schedule cannot be computed within a "
                "representable date range."
            )
    for dep in project.dependencies:
        # Type guard for the direct-object API (#1209): a non-timedelta lag would
        # otherwise leak AttributeError from ``.days`` here and in both passes.
        if not isinstance(dep.lag, timedelta):
            raise InvalidScheduleInput(
                f"Dependency {dep.predecessor_id!r} → {dep.successor_id!r} lag must be a "
                f"timedelta (got {dep.lag!r})."
            )
        if abs(dep.lag.days) > MAX_LAG_DAYS:
            raise InvalidScheduleInput(
                f"Dependency {dep.predecessor_id!r} → {dep.successor_id!r} lag exceeds "
                f"the maximum of ±{MAX_LAG_DAYS} days (got {dep.lag.days})."
            )

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
    total_span = 0
    max_snet_days = 0
    max_actual_days = 0
    for t in project.tasks:
        # Worst case across the deterministic duration AND every PERT estimate:
        # Monte Carlo samples within [optimistic, pessimistic] but falls back to
        # most_likely when the range is degenerate, so most_likely (which a
        # partial estimate may set above the deterministic duration) must count
        # too. Scrum tasks count their velocity-sampling worst case — without it
        # an oversized story_points bypassed this guard entirely (#1067).
        task_max_days = t.duration.days
        for est in (t.optimistic_duration, t.most_likely_duration, t.pessimistic_duration):
            if est is not None:
                task_max_days = max(task_max_days, est.days)
        task_max_days = max(task_max_days, _velocity_worst_case_days(t, project))
        total_span += max(0, task_max_days)
        if t.planned_start is not None:
            max_snet_days = max(max_snet_days, (t.planned_start - project.start_date).days)
        # Recorded actuals (ADR-0132/0136) anchor a completed task's full-duration
        # span and feed the same calendar walk (_start_from_finish / _finish_from_start)
        # as a planned_start pin, so an actual far from the project start must be
        # bounded the same way — otherwise a year-9999 actual_finish drives the
        # working-day scan past the representable range (the #951 precedent). abs()
        # bounds both a far-future and a far-past actual.
        for actual in (t.actual_start, t.actual_finish):
            if actual is not None:
                max_actual_days = max(max_actual_days, abs((actual - project.start_date).days))
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
    # underflow is unreachable — the backward pass never retreats below the forward
    # pass's earliest date, which is >= start_date.)
    max_calendar_reach = total_span * 7 + MAX_CALENDAR_SCAN_DAYS
    if (date.max - project.start_date).days < max_calendar_reach:
        raise InvalidScheduleInput(
            f"Project start date {project.start_date.isoformat()} is too close to the "
            f"maximum representable date for a span of {total_span} working days; the "
            "schedule would overflow the date range. Use an earlier start date."
        )


# ---------------------------------------------------------------------------
# Public API: schedule()
# ---------------------------------------------------------------------------


def schedule(project: Project) -> ScheduleResult:
    """Run CPM on a project and return a ScheduleResult.

    The original project is not mutated; a deep copy is made for computation.

    Every task in ``project.tasks`` is placed in the network and scheduled. The
    engine has no concept of a recurring or template task: recurrence is a domain
    concern filtered out one layer up, at the API (per ADR-0090). Callers must
    therefore exclude any task that should not occupy the schedule (e.g. a
    recurring-task template) *before* calling — passing one in is not an error,
    it is simply scheduled like any other task. Keeping this boundary explicit
    stops a future contributor from "helpfully" teaching the engine about
    recurrence and breaking the separation.

    Args:
        project: The project to schedule. Must have at least one task.

    Returns:
        ScheduleResult with ES/EF/LS/LF/float computed for every task
        and the critical path identified.

        Note: ``free_float``, ``total_float``, and ``is_critical`` are all
        dependency-type complete — each accounts for FS/SS/FF/SF links per the
        standard free-/total-float definitions.

    Raises:
        CyclicDependencyError: If the dependency graph contains a cycle.
        InvalidScheduleInput: If the calendar has no working day, or a duration
            or lag is negative/out of range.
        ValueError: If a dependency references an unknown task ID.
    """
    if not project.tasks:
        raise ValueError("Project must have at least one task.")
    _validate_project(project)

    g = _build_graph(project)
    _check_cycles(g)

    topo_order: list[str] = list(nx.topological_sort(g))
    tasks = [copy.deepcopy(t) for t in project.tasks]
    task_map = {t.id: t for t in tasks}

    _forward_pass(
        task_map, topo_order, g, project.start_date, project.calendar, project.status_date
    )

    # Project finish = latest early_finish across all tasks.
    # Forward pass guarantees every task has early_finish set.
    project_finish: date = max(t.early_finish for t in tasks if t.early_finish is not None)

    _backward_pass(task_map, topo_order, g, project_finish, project.calendar)
    _compute_floats(task_map, topo_order, g, project.calendar)

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

    return ScheduleResult(
        project_id=project.id,
        project_start=project_start_date,
        project_finish=project_finish,
        tasks=tasks,
        critical_path=critical_path,
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

    The PERT distribution is a Beta distribution scaled to [opt, pess].
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


def monte_carlo(
    project: Project,
    runs: int = 1_000,
    seed: int | None = None,
    max_runs: int | None = 1_000,
    max_tasks: int | None = 500,
) -> MonteCarloResult:
    """Run Monte Carlo probabilistic scheduling on a project.

    Each task's per-run duration is sampled by one of three paths, in priority order:

    1. **Agile / velocity (#411)** — a task with ``delivery_mode=SCRUM`` and
       ``story_points``, on a project carrying ``velocity_samples`` +
       ``sprint_length_days``, samples sprints-to-completion from the team's
       throughput distribution (see :func:`_sample_velocity_durations`). This is how
       sprint-delivered work contributes real velocity-driven risk to a mixed-mode
       schedule rather than being invisible to the simulation.
    2. **Three-point PERT** — a task with all of (optimistic, most_likely,
       pessimistic) set samples from a PERT-Beta distribution.
    3. **Deterministic** — any other task uses its fixed ``duration`` every run.

    A mixed project (scrum subtree + waterfall tasks) therefore produces a single
    finish-date distribution combining both sources of uncertainty.

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
    same start-no-earlier-than floor the deterministic pass applies (#1068),
    and zero-duration milestones occupy their start day exactly as in
    :func:`schedule` (#1066) — a fully deterministic project (no estimates,
    no velocity signal) simulates to precisely the CPM finish date.
    Computation is vectorised with numpy:
    10 000 runs on a 200-task project completes in well under 100 ms — but note
    the ``max_runs`` cap defaults to 1 000, so a 10 000-run call must raise it
    (e.g. ``monte_carlo(project, runs=10_000, max_runs=10_000)``) or it raises
    SimulationCapExceeded.

    Args:
        project:   The project to simulate. Must have at least one task and
                   no cyclic dependencies.
        runs:      Number of Monte Carlo iterations. Default 1 000.
        seed:      Optional RNG seed for reproducibility. With a fixed seed the
                   sampled durations — and therefore P50/P80/P95 — are
                   deterministic and independent of task insertion order.
        max_runs:  Maximum allowed value for ``runs``. Pass ``None`` to disable
                   the cap. Default 1 000.
        max_tasks: Maximum number of tasks allowed. Pass ``None`` to disable
                   the cap. Default 500.

    Returns:
        MonteCarloResult with P50, P80, P95 completion dates and the full
        sorted distribution.

    Raises:
        SimulationCapExceeded: If ``runs`` exceeds ``max_runs`` or the project
            has more tasks than ``max_tasks``.
        CyclicDependencyError: If the dependency graph contains a cycle.
        InvalidScheduleInput: If the calendar has no working day, or a duration
            or lag is negative/out of range.
        ValueError: If the project has no tasks or ``runs`` is less than 1.
    """
    if runs < 1:
        raise ValueError(f"runs must be a positive integer (got {runs}).")
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
        raise ValueError("Project must have at least one task.")
    _validate_project(project)

    g = _build_graph(project)
    _check_cycles(g)
    # Use a lexicographically-keyed topological sort so the RNG is consumed in a
    # deterministic, version-independent order. Plain ``nx.topological_sort`` only
    # guarantees *a* valid topological order; its tie-breaking is an implementation
    # detail that can shift between networkx versions (dep cap is wide:
    # networkx>=3.0,<4) and with task insertion order. Because durations are sampled
    # column-by-column in this order from a single seeded RNG, any reordering would
    # silently change seeded P50/P80/P95. Keying on the stable task id pins the order.
    topo_order: list[str] = list(nx.lexicographical_topological_sort(g, key=str))
    n_tasks = len(topo_order)
    task_idx = {tid: i for i, tid in enumerate(topo_order)}

    rng = np.random.default_rng(seed)
    calendar = project.calendar

    # --- Sample durations: shape (runs, n_tasks) ---
    task_map = {t.id: t for t in project.tasks}
    dur_matrix = np.empty((runs, n_tasks), dtype=np.float64)

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

    # --- Vectorised forward pass (working-day offsets from project start) ---
    # ES and EF are floating-point working-day offsets (0 = project start).
    # EF = ES + duration (open-interval: exclusive end, so a 5-day task starting
    # on offset 0 has EF=5, and its FS successor starts at offset 5).
    es_mat = np.zeros((runs, n_tasks), dtype=np.float64)
    ef_mat = np.zeros((runs, n_tasks), dtype=np.float64)

    # Pre-compute a working-day index covering the whole simulation so a lag can
    # be converted to working-day offsets against the predecessor's *actual* date
    # in each run — matching deterministic CPM, which snaps ``predecessor date +
    # lag`` to the next working day per task rather than against a single
    # reference date (issue #824). Sizing: the longest possible completion offset
    # is bounded by the sum of the largest per-task durations plus all positive
    # lags; pad by the task count and a small buffer. The same index is reused for
    # the offset→date conversion below.
    dur_upper = 0
    snet_upper = 0
    for t in task_map.values():
        d_days = t.duration.days
        if t.pessimistic_duration is not None:
            d_days = max(d_days, t.pessimistic_duration.days)
        # Velocity-sampled scrum durations are bounded by the sampler's
        # max_sprints clamp, not by duration/pessimistic — without this term a
        # scrum task's completion offsets ran past the index end and were
        # silently clamped to its last entry, reporting finish dates months
        # early (#1067).
        d_days = max(d_days, _velocity_worst_case_days(t, project))
        dur_upper += max(0, d_days)
        # A planned_start pin (SNET, #1068) can push a task past every
        # duration-derived bound; cover the furthest pin (calendar days are a
        # safe over-estimate of working-day offsets).
        if t.planned_start is not None:
            snet_upper = max(snet_upper, (t.planned_start - project.start_date).days)
    lag_upper = sum(
        data["dep"].lag.days for _, _, data in g.edges(data=True) if data["dep"].lag.days > 0
    )
    # The data date (ADR-0132) floors remaining/not-started work, so a not-started
    # task can finish as late as status_date + its duration. Cover the status date
    # like a planned-start pin (calendar days over-estimate working-day offsets).
    status_upper = 0
    if project.status_date is not None:
        status_upper = max(0, (project.status_date - project.start_date).days)
    index_size = dur_upper + lag_upper + snet_upper + status_upper + n_tasks + 30
    wd_index = _build_working_day_index(project.start_date, calendar, index_size)
    offset_of = {d: i for i, d in enumerate(wd_index)}

    # Working-day ordinals for the whole index, so each per-(dep_type, lag) delta
    # array is built with a single vectorised searchsorted instead of an
    # ``index_size``-long pure-Python loop of ``_next_working_day`` snaps (#1205).
    # ``wd_index`` is sorted ascending and holds exactly the working days, so
    # ``searchsorted(wd_ord, target, "left")`` reproduces ``_next_working_day``'s
    # snap — the first working-day offset >= target — including the former clamps
    # (a target before the index floors to 0; one past the end clamps to the last
    # offset). Ordinal arithmetic also can't hit the ``date.max`` overflow the
    # scalar path now guards, because the index was already built within range.
    wd_ord = np.fromiter((d.toordinal() for d in wd_index), dtype=np.int64, count=len(wd_index))
    last_off = len(wd_index) - 1
    k_arange = np.arange(index_size, dtype=np.float64)

    def _snapped_offsets(anchor_ords: np.ndarray, shift_days: int) -> np.ndarray:
        """Vectorised ``_offset_after``: offsets of next_working_day(anchor + shift)."""
        off = np.searchsorted(wd_ord, anchor_ords + shift_days, side="left")
        return np.clip(off, 0, last_off).astype(np.float64)

    # Lag delta arrays, indexed by the rounded working-day offset of the
    # predecessor's anchor (exclusive EF for FS/FF, ES for SS/SF); each holds the
    # *extra* working-day offset the constraint adds relative to a plain offset add
    # at that anchor. ``None`` means "no adjustment" (a plain offset add) — used for
    # lag-free FS/SS/FF, byte-for-byte identical to a plain add. SF is the
    # exception: it imposes an *exclusive* EF constraint anchored on the
    # predecessor's *inclusive* start, so it needs a +1 interval conversion even at
    # zero lag and therefore always carries a delta array (issue #824 — SF
    # previously dropped that +1 and finished one working day early).
    #
    # The array content depends ONLY on ``(dep_type, lag)`` — ``wd_index`` and the
    # calendar are fixed for the whole simulation — so build one array per *distinct*
    # ``(dep_type, lag)`` key and share it across every edge carrying that key,
    # rather than one array per edge (#1201). N identical SF/lag-0 edges (or any
    # repeated key) now cost a single array, not N. The remaining cost — distinct
    # keys x ``index_size`` — is capped explicitly: ``MAX_PROJECT_SPAN_DAYS`` bounds
    # Σlag but not this product, and an SF/lag-0 edge contributes 0 to Σlag, so
    # without the cap a wide fan-out of such edges slips the span guard entirely.
    def _build_delta(dt: DependencyType, lag: timedelta) -> np.ndarray:
        # Vectorised equivalent of the former per-cell loop (#1205): for each anchor
        # offset k the delta is the snapped successor offset minus the plain-add
        # baseline. FS/FF anchor on the *previous* working day (wd_index[k-1]), so
        # their k=0 cell stays 0 and the array is filled from index 1; SS/SF anchor
        # on wd_index[k] over the full range. This reproduces the scalar
        # ``_offset_after`` arithmetic exactly (asserted byte-for-byte in the tests).
        arr = np.zeros(index_size, dtype=np.float64)
        lag_days = lag.days
        if dt == DependencyType.FS:
            # k = exclusive EF offset; EF date = wd_index[k-1]; shift = 1 + lag.
            off = _snapped_offsets(wd_ord[:-1], 1 + lag_days)
            arr[1:] = off - k_arange[1:]
        elif dt == DependencyType.FF:
            # Anchor k is the exclusive EF offset (inclusive last day = wd_index[k-1]);
            # the inclusive→exclusive +1 is folded into the -(k-1) baseline.
            off = _snapped_offsets(wd_ord[:-1], lag_days)
            arr[1:] = off - k_arange[: index_size - 1]
        elif dt == DependencyType.SS:
            # Start-anchored ES constraint; both sides are inclusive starts.
            arr[:] = _snapped_offsets(wd_ord, lag_days) - k_arange
        else:  # SF
            # Start-anchored EF constraint: succ.EF (exclusive) must clear the snapped
            # predecessor-start+lag day (inclusive), so +1 converts the inclusive
            # constraint day to the exclusive EF offset. FF gets this +1 for free via
            # its exclusive-EF anchor; SF does not, and dropping it finished SF
            # successors one working day early (#824).
            arr[:] = _snapped_offsets(wd_ord, lag_days) + 1.0 - k_arange
        return arr

    delta_by_key: dict[tuple[DependencyType, timedelta], np.ndarray | None] = {}
    for _u, _v, data in g.edges(data=True):
        d = data["dep"]
        key = (d.dep_type, d.lag)
        if key in delta_by_key:
            continue
        if d.lag == timedelta(0) and d.dep_type != DependencyType.SF:
            delta_by_key[key] = None
            continue
        # Reject before materialising the offending array: distinct keys x
        # index_size cells is the cost the span guard does not bound (#1201).
        non_null = sum(1 for arr in delta_by_key.values() if arr is not None) + 1
        if non_null * index_size > MAX_LAG_DELTA_CELLS:
            raise InvalidScheduleInput(
                f"Monte Carlo lag-delta table would exceed {MAX_LAG_DELTA_CELLS:,} "
                "cells (distinct dependency type/lag combinations x schedule span). "
                "The dependency network has too many distinct lag values for the "
                "span involved — reduce the variety of lags or split the project."
            )
        delta_by_key[key] = _build_delta(d.dep_type, d.lag)

    edge_lag_delta: dict[tuple[str, str], np.ndarray | None] = {
        (u, v): delta_by_key[(data["dep"].dep_type, data["dep"].lag)]
        for u, v, data in g.edges(data=True)
    }

    def _lag_term(delta_arr: np.ndarray | None, anchor: np.ndarray) -> np.ndarray:
        """Per-run lag delta gathered at each run's (rounded) anchor offset.

        Returns an all-zero vector for lag-free edges so the caller's offset add
        is unchanged."""
        if delta_arr is None:
            return np.zeros_like(anchor)
        idx = np.clip(np.rint(anchor).astype(np.int64), 0, len(delta_arr) - 1)
        return np.asarray(delta_arr[idx], dtype=np.float64)

    # planned_start (SNET) floors, mirroring the deterministic forward pass
    # (#1068): a pinned task may not start before its pin regardless of network
    # logic. A pin at or before project start is the 0 floor every task already
    # has. The index was sized to cover the furthest pin, so the lookup is total.
    snet_floor: dict[str, float] = {}
    for t in task_map.values():
        if t.planned_start is not None and t.planned_start > project.start_date:
            snapped = _next_working_day(t.planned_start, calendar)
            off = offset_of.get(snapped)
            snet_floor[t.id] = float(off) if off is not None else float(len(wd_index) - 1)

    # --- Progress-aware inputs (ADR-0132) ---
    # The data date floors all not-yet-finished work: nothing remaining can be
    # sampled before "as of now". Mirrors the deterministic forward pass.
    status_floor = 0.0
    if project.status_date is not None and project.status_date > project.start_date:
        snapped_sd = _next_working_day(project.status_date, calendar)
        sd_off = offset_of.get(snapped_sd)
        status_floor = float(sd_off) if sd_off is not None else float(len(wd_index) - 1)

    def _completed_offsets(t: Task) -> tuple[float, float]:
        """Constant (ES, exclusive-EF) offset pair for a completed task."""
        assert t.actual_finish is not None
        fin_wd = _prev_working_day(t.actual_finish, calendar)
        fin_off = offset_of.get(fin_wd)
        if fin_off is None:
            ef_off = 0.0 if fin_wd < wd_index[0] else float(len(wd_index) - 1)
        else:
            ef_off = float(fin_off + 1)  # exclusive EF: one past the inclusive last day
        if t.actual_start is not None:
            st_wd = _next_working_day(t.actual_start, calendar)
            st_off = offset_of.get(st_wd)
            es_off = (
                float(st_off)
                if st_off is not None
                else (0.0 if st_wd < wd_index[0] else float(len(wd_index) - 1))
            )
            es_off = min(es_off, ef_off)
        else:
            es_off = max(0.0, ef_off - 1.0)
        return es_off, ef_off

    # Completed tasks are pinned to their actuals with zero variance — not
    # re-sampled. In-progress tasks have a fixed elapsed portion subtracted from
    # every sampled duration, so only the *remaining* work carries uncertainty
    # (and a deterministic in-progress task still simulates to exactly its CPM
    # finish, preserving that invariant). ``elapsed_days`` uses the same integer
    # rule as _effective_duration_days so the two engines agree.
    completed_offsets: dict[str, tuple[float, float]] = {
        t.id: _completed_offsets(t) for t in task_map.values() if t.actual_finish is not None
    }
    elapsed_days: dict[str, float] = {}
    for t in task_map.values():
        if t.actual_finish is None and t.percent_complete and t.percent_complete > 0:
            elapsed_days[t.id] = float(
                int(t.duration.days * min(t.percent_complete, 100.0) / 100.0)
            )

    for col, tid in enumerate(topo_order):
        # Completed: pin both offsets to constants across every run and skip the
        # network/sampling logic entirely.
        if tid in completed_offsets:
            es_off, ef_off = completed_offsets[tid]
            es_mat[:, col] = es_off
            ef_mat[:, col] = ef_off
            continue

        es_constraints = np.full(runs, max(snet_floor.get(tid, 0.0), status_floor))
        ef_constraints = np.zeros(runs)
        has_ef_constraint = False

        for pred_id in g.predecessors(tid):
            dep: Dependency = g[pred_id][tid]["dep"]
            delta_arr = edge_lag_delta[(pred_id, tid)]
            p = task_idx[pred_id]

            if dep.dep_type == DependencyType.FS:
                anchor = ef_mat[:, p]
                es_constraints = np.maximum(es_constraints, anchor + _lag_term(delta_arr, anchor))
            elif dep.dep_type == DependencyType.SS:
                anchor = es_mat[:, p]
                es_constraints = np.maximum(es_constraints, anchor + _lag_term(delta_arr, anchor))
            elif dep.dep_type == DependencyType.FF:
                anchor = ef_mat[:, p]
                ef_constraints = np.maximum(ef_constraints, anchor + _lag_term(delta_arr, anchor))
                has_ef_constraint = True
            elif dep.dep_type == DependencyType.SF:
                anchor = es_mat[:, p]
                ef_constraints = np.maximum(ef_constraints, anchor + _lag_term(delta_arr, anchor))
                has_ef_constraint = True

        # Effective duration floors at one working day: a task occupies at least
        # its start day, exactly as _finish_from_start returns the start day for
        # a zero-duration milestone. With the raw duration, a milestone's
        # exclusive EF collapsed onto its ES — FS successors started a working
        # day early, lag anchors indexed the day *before* the milestone, and a
        # terminal milestone's completion date converted one day early (#1066).
        # Subtract the fixed elapsed portion of an in-progress task so only its
        # remaining work is sampled (ADR-0132); the 1.0 floor then applies, so a
        # fully-burned-down task behaves like a zero-remaining milestone.
        sampled = dur_matrix[:, col]
        if tid in elapsed_days:
            sampled = sampled - elapsed_days[tid]
        eff_dur = np.maximum(sampled, 1.0)
        es = es_constraints
        ef = es + eff_dur

        if has_ef_constraint:
            ef = np.maximum(ef, ef_constraints)
            # Where EF was pushed by FF/SF, ES moves back (but not below es_constraints).
            es = np.maximum(es_constraints, ef - eff_dur)
            ef = es + eff_dur

        es_mat[:, col] = es
        ef_mat[:, col] = ef

    # --- Project completion offset = max EF across all tasks per run ---
    completion_offsets = ef_mat.max(axis=1)  # shape (runs,)

    # --- Convert offsets back to dates using the working-day index ---
    # ``wd_index`` was built above (sized to bound the longest completion offset
    # plus all lags); reuse it rather than rebuilding. ``_offset_to_date`` clamps
    # to the final index entry, so an offset at the very edge is still safe.
    def _offset_to_date(offset: float) -> date:
        # EF offsets are exclusive (EF=5 means working days 0..4). Subtract 1
        # to get the last working day of the task, matching CPM's inclusive EF.
        idx = max(0, min(round(offset) - 1, len(wd_index) - 1))
        return wd_index[idx]

    all_dates = sorted(_offset_to_date(o) for o in completion_offsets.tolist())

    # Percentile convention (documented for the public surface, #826): use
    # numpy.percentile — the de-facto Python standard (linear interpolation
    # between the two nearest ranks) — on the completion-offset distribution,
    # then map the resulting offset to a working-day date. The previous
    # lower-median nearest-rank with a -1 offset (all_dates[int(0.50*runs)-1])
    # was an undocumented in-house convention; numpy.percentile is what PyPI
    # consumers expect and stays reproducible under the same seed.
    pct_offsets = np.percentile(completion_offsets, [50, 80, 95])
    p50 = _offset_to_date(float(pct_offsets[0]))
    p80 = _offset_to_date(float(pct_offsets[1]))
    p95 = _offset_to_date(float(pct_offsets[2]))

    return MonteCarloResult(
        project_id=project.id,
        runs=runs,
        p50=p50,
        p80=p80,
        p95=p95,
        distribution=all_dates,
    )
