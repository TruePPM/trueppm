"""CPM scheduling engine and Monte Carlo simulation for trueppm-scheduler."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import networkx as nx
import numpy as np

from trueppm_scheduler.models import Calendar, Dependency, DependencyType, Project, Task

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


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ScheduleResult:
    """Output of a CPM schedule calculation.

    Each task in ``tasks`` carries early/late start and finish, total float, free
    float, and an ``is_critical`` flag. ``free_float``, ``total_float``, and
    ``is_critical`` all account for every dependency type (FS/SS/FF/SF) per the
    PMI definitions.
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
        d += timedelta(days=1)
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
        d -= timedelta(days=1)
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
        current += step
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
    return _next_working_day(d + lag, calendar)


def _retreat_calendar_days(d: date, lag: timedelta, calendar: Calendar) -> date:
    """Retreat d by lag calendar days and snap to the previous working day."""
    return _prev_working_day(d - lag, calendar)


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
            raise ValueError(
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
        InvalidScheduleInput: If ``children_map`` itself contains a cycle
            (a summary that is its own ancestor) — distinct from a cycle in the
            ``edges`` being validated, which is returned, not raised.
    """
    if children_map:
        edges = _expand_edges_for_cycle_check(edges, children_map)
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from(edges)
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
    seen: set[tuple[str, str]] = set()
    expanded: list[tuple[str, str]] = []
    for pred_id, succ_id in edges:
        preds = _collect_leaves(pred_id, children_map) if pred_id in summary_ids else [pred_id]
        succs = _collect_leaves(succ_id, children_map) if succ_id in summary_ids else [succ_id]
        for p in preds:
            for s in succs:
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
) -> None:
    """Compute early_start and early_finish for every task (in-place)."""
    start = _next_working_day(project_start, calendar)

    for node_id in topo_order:
        task = task_map[node_id]
        duration_days = task.duration.days

        # Collect ES and EF constraints from all predecessor dependencies.
        # planned_start (SNET) is an additional ES lower-bound: the task may
        # not start before this date regardless of network logic.
        es_constraints: list[date] = [start]
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
                    _next_working_day(pred.early_finish + timedelta(days=1) + lag, calendar)
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
    """Compute late_start and late_finish for every task (in-place)."""
    for node_id in reversed(topo_order):
        task = task_map[node_id]
        duration_days = task.duration.days

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
                    _prev_working_day(succ.late_start - timedelta(days=1) - lag, calendar)
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
    its successors — the PMI definition of free float (PMBOK® Guide, "Critical
    Path Method"), evaluated across **all four** dependency types. For each
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
                imposed = _next_working_day(task.early_finish + timedelta(days=1) + lag, calendar)
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

    summary_ids = set(children_map.keys())
    leaf_tasks = [t for t in tasks if t.id not in summary_ids]

    seen: set[tuple[str, str]] = set()
    expanded: list[Dependency] = []

    for dep in deps:
        pred_id = dep.predecessor_id
        succ_id = dep.successor_id

        # Resolve to leaves
        preds = _collect_leaves(pred_id, children_map) if pred_id in summary_ids else [pred_id]
        succs = _collect_leaves(succ_id, children_map) if succ_id in summary_ids else [succ_id]

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

    if project.calendar.working_days & 0b111_1111 == 0:
        raise InvalidScheduleInput(
            "Calendar has no working weekday set (working_days bitmask is empty); "
            "at least one of Mon-Sun must be a working day."
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

    for t in project.tasks:
        _check_duration(t.duration, f"Task {t.id!r} duration")
        for field_name, value in (
            ("optimistic_duration", t.optimistic_duration),
            ("most_likely_duration", t.most_likely_duration),
            ("pessimistic_duration", t.pessimistic_duration),
        ):
            if value is not None:
                _check_duration(value, f"Task {t.id!r} {field_name}")
    for dep in project.dependencies:
        if abs(dep.lag.days) > MAX_LAG_DAYS:
            raise InvalidScheduleInput(
                f"Dependency {dep.predecessor_id!r} → {dep.successor_id!r} lag exceeds "
                f"the maximum of ±{MAX_LAG_DAYS} days (got {dep.lag.days})."
            )

    # Cumulative span: an upper bound on the longest path (and on the Monte Carlo
    # completion offset, which can sample each task up to its pessimistic
    # duration). Bounding the sum keeps the day-by-day walk and the working-day
    # index build from spinning — or overflowing the date range — no matter how
    # many tasks are chained.
    total_span = 0
    for t in project.tasks:
        # Worst case across the deterministic duration AND every PERT estimate:
        # Monte Carlo samples within [optimistic, pessimistic] but falls back to
        # most_likely when the range is degenerate, so most_likely (which may
        # exceed pessimistic) must count too.
        task_max_days = t.duration.days
        for est in (t.optimistic_duration, t.most_likely_duration, t.pessimistic_duration):
            if est is not None:
                task_max_days = max(task_max_days, est.days)
        total_span += max(0, task_max_days)
    total_span += sum(abs(dep.lag.days) for dep in project.dependencies)
    if total_span > MAX_PROJECT_SPAN_DAYS:
        raise InvalidScheduleInput(
            f"Total project span ({total_span} days across all task durations and lags) "
            f"exceeds the maximum of {MAX_PROJECT_SPAN_DAYS} days; the schedule cannot be "
            "computed within a representable date range."
        )


# ---------------------------------------------------------------------------
# Public API: schedule()
# ---------------------------------------------------------------------------


def schedule(project: Project) -> ScheduleResult:
    """Run CPM on a project and return a ScheduleResult.

    The original project is not mutated; a deep copy is made for computation.

    Args:
        project: The project to schedule. Must have at least one task.

    Returns:
        ScheduleResult with ES/EF/LS/LF/float computed for every task
        and the critical path identified.

        Note: ``free_float``, ``total_float``, and ``is_critical`` are all
        dependency-type complete — each accounts for FS/SS/FF/SF links per the
        PMI free-/total-float definitions.

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

    _forward_pass(task_map, topo_order, g, project.start_date, project.calendar)

    # Project finish = latest early_finish across all tasks.
    # Forward pass guarantees every task has early_finish set.
    project_finish: date = max(t.early_finish for t in tasks if t.early_finish is not None)

    _backward_pass(task_map, topo_order, g, project_finish, project.calendar)
    _compute_floats(task_map, topo_order, g, project.calendar)

    # Order the critical path by (early_start, id). ``topo_order`` is only *a*
    # valid topological order — its tie-break among parallel tasks is a networkx
    # implementation detail (the dep cap is wide: networkx>=3,<4) and the Rust
    # engine's petgraph tie-break differs again, so filtering topo_order directly
    # would make ``critical_path`` ordering non-deterministic and cross-engine
    # divergent (#909). Sorting by (early_start, id) is deterministic, engine-
    # agnostic, and a valid topological order for the parallel critical tasks
    # this disambiguates (they share no edge). The Rust engine sorts identically.
    critical_path = sorted(
        (tid for tid in topo_order if task_map[tid].is_critical),
        key=lambda tid: (task_map[tid].early_start, tid),
    )

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

    For each task that has three-point PERT estimates (optimistic, most_likely,
    pessimistic), duration is sampled from a PERT-Beta distribution. Tasks
    without three-point estimates use their deterministic duration every run.

    The CPM network is evaluated `runs` times with sampled durations.
    All 4 dependency types are handled. Computation is vectorised with numpy:
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
        if (
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
    for t in task_map.values():
        d_days = t.duration.days
        if t.pessimistic_duration is not None:
            d_days = max(d_days, t.pessimistic_duration.days)
        dur_upper += max(0, d_days)
    lag_upper = sum(
        data["dep"].lag.days for _, _, data in g.edges(data=True) if data["dep"].lag.days > 0
    )
    index_size = dur_upper + lag_upper + n_tasks + 30
    wd_index = _build_working_day_index(project.start_date, calendar, index_size)
    offset_of = {d: i for i, d in enumerate(wd_index)}

    def _offset_after(anchor_date: date, shift: timedelta) -> int:
        """Working-day offset of ``next_working_day(anchor_date + shift)``."""
        target = _next_working_day(anchor_date + shift, calendar)
        off = offset_of.get(target)
        if off is not None:
            return off
        # Target fell outside the index: a lead before project start floors to 0;
        # a date past the end is clamped to the last representable offset.
        return 0 if target < wd_index[0] else len(wd_index) - 1

    # Per-edge lag delta arrays. ``edge_lag_delta[(u, v)]`` is indexed by the
    # rounded working-day offset of the predecessor's anchor (exclusive EF for
    # FS/FF, ES for SS/SF) and holds the *extra* working-day offset the lag adds
    # relative to the lag-free baseline at that anchor. ``None`` means lag == 0,
    # leaving the constraint as a plain offset add — so lag-free projects are
    # byte-for-byte identical to the previous behaviour.
    one_day = timedelta(days=1)
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None] = {}
    for u, v, data in g.edges(data=True):
        d = data["dep"]
        lag = d.lag
        if lag == timedelta(0):
            edge_lag_delta[(u, v)] = None
            continue
        arr = np.zeros(index_size, dtype=np.float64)
        dt = d.dep_type
        for k in range(index_size):
            if dt == DependencyType.FS:
                # k = exclusive EF offset; EF date = wd_index[k-1]; baseline = k.
                if k == 0:
                    continue
                arr[k] = _offset_after(wd_index[k - 1], one_day + lag) - k
            elif dt == DependencyType.FF:
                if k == 0:
                    continue
                arr[k] = _offset_after(wd_index[k - 1], lag) - (k - 1)
            else:  # SS / SF anchor on the predecessor's ES (offset k); baseline = k.
                arr[k] = _offset_after(wd_index[k], lag) - k
        edge_lag_delta[(u, v)] = arr

    def _lag_term(delta_arr: np.ndarray | None, anchor: np.ndarray) -> np.ndarray:
        """Per-run lag delta gathered at each run's (rounded) anchor offset.

        Returns an all-zero vector for lag-free edges so the caller's offset add
        is unchanged."""
        if delta_arr is None:
            return np.zeros_like(anchor)
        idx = np.clip(np.rint(anchor).astype(np.int64), 0, len(delta_arr) - 1)
        return np.asarray(delta_arr[idx], dtype=np.float64)

    for col, tid in enumerate(topo_order):
        es_constraints = np.zeros(runs)  # project start = offset 0
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

        es = es_constraints
        ef = es + dur_matrix[:, col]

        if has_ef_constraint:
            ef = np.maximum(ef, ef_constraints)
            # Where EF was pushed by FF/SF, ES moves back (but not below es_constraints).
            es = np.maximum(es_constraints, ef - dur_matrix[:, col])
            ef = es + dur_matrix[:, col]

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
