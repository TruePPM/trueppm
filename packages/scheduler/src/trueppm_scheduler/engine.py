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


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ScheduleResult:
    """Output of a CPM schedule calculation."""

    project_id: str
    project_start: date
    project_finish: date
    tasks: list[Task]  # copies with all CPM fields populated
    critical_path: list[str]  # task IDs in topological order along the critical path

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
    """Return d if it is a working day, otherwise the next working day."""
    while not calendar.is_working_day(d):
        d += timedelta(days=1)
    return d


def _prev_working_day(d: date, calendar: Calendar) -> date:
    """Return d if it is a working day, otherwise the previous working day."""
    while not calendar.is_working_day(d):
        d -= timedelta(days=1)
    return d


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
        current += timedelta(days=1)
        if calendar.is_working_day(current):
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
        current -= timedelta(days=1)
        if calendar.is_working_day(current):
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
    """Compute total_float, free_float, and is_critical for every task (in-place)."""
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

        # Free float: how much a task can slip before delaying any immediate successor.
        # For FS successors: gap between this task's EF and the successor's ES.
        ff_days = tf_days  # upper bound; for tasks with no successors this is tf
        for succ_id in g.successors(node_id):
            succ = task_map[succ_id]
            dep: Dependency = g[node_id][succ_id]["dep"]
            if dep.dep_type == DependencyType.FS:
                assert succ.early_start is not None
                gap = _working_days_between(task.early_finish, succ.early_start, calendar)
                # FS gap is the day after EF to succ.ES — subtract 1 because EF is inclusive.
                # If EF = Friday and succ.ES = Monday: gap = 0 (no slack between them).
                ff_days = min(ff_days, max(0, gap - 1))

        task.free_float = timedelta(days=max(0, ff_days))


# ---------------------------------------------------------------------------
# Summary task dependency expansion
# ---------------------------------------------------------------------------


def _collect_leaves(
    task_id: str,
    children_map: dict[str, list[str]],
) -> list[str]:
    """Recursively collect leaf task IDs under a summary task.

    A leaf is a task that has no children in children_map.
    """
    children = children_map.get(task_id)
    if not children:
        return [task_id]
    leaves: list[str] = []
    for child_id in children:
        leaves.extend(_collect_leaves(child_id, children_map))
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

    Raises:
        CyclicDependencyError: If the dependency graph contains a cycle.
        ValueError: If a dependency references an unknown task ID.
    """
    if not project.tasks:
        raise ValueError("Project must have at least one task.")

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

    critical_path = [tid for tid in topo_order if task_map[tid].is_critical]

    first_task_es = task_map[topo_order[0]].early_start
    assert first_task_es is not None

    return ScheduleResult(
        project_id=project.id,
        project_start=first_task_es,
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
    """
    result: list[date] = []
    current = start
    while len(result) < n_working_days:
        if calendar.is_working_day(current):
            result.append(current)
        current += timedelta(days=1)
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
    All 4 dependency types are handled. Computation is vectorised with numpy
    so 10 000 runs on a 200-task project completes in well under 100 ms.

    Args:
        project:   The project to simulate. Must have at least one task and
                   no cyclic dependencies.
        runs:      Number of Monte Carlo iterations. Default 1 000 (OSS cap).
        seed:      Optional RNG seed for reproducibility.
        max_runs:  Maximum allowed value for ``runs``. Pass ``None`` to disable
                   the cap (Team tier). Default 1 000.
        max_tasks: Maximum number of tasks allowed. Pass ``None`` to disable
                   the cap (Team tier). Default 500.

    Returns:
        MonteCarloResult with P50, P80, P95 completion dates and the full
        sorted distribution.

    Raises:
        SimulationCapExceeded: If ``runs`` exceeds ``max_runs`` or the project
            has more tasks than ``max_tasks``.
        CyclicDependencyError: If the dependency graph contains a cycle.
        ValueError: If the project has no tasks.
    """
    if max_tasks is not None and len(project.tasks) > max_tasks:
        raise SimulationCapExceeded(
            f"This project has {len(project.tasks)} tasks. "
            f"OSS tier supports up to {max_tasks} tasks for Monte Carlo simulation. "
            "Upgrade to Team tier for unlimited simulations."
        )
    if max_runs is not None and runs > max_runs:
        raise SimulationCapExceeded(
            f"OSS tier supports up to {max_runs} simulations per run. "
            "Upgrade to Team tier for unlimited simulations."
        )
    if not project.tasks:
        raise ValueError("Project must have at least one task.")

    g = _build_graph(project)
    _check_cycles(g)
    topo_order: list[str] = list(nx.topological_sort(g))
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

    # Pre-compute lag in working days for each edge (approximate: lag.days treated
    # as working days for the MC simulation, consistent with the CPM engine).
    for col, tid in enumerate(topo_order):
        es_constraints = np.zeros(runs)  # project start = offset 0
        ef_constraints = np.zeros(runs)
        has_ef_constraint = False

        for pred_id in g.predecessors(tid):
            dep: Dependency = g[pred_id][tid]["dep"]
            lag_wd = float(dep.lag.days)  # treat lag as working days for MC
            p = task_idx[pred_id]

            if dep.dep_type == DependencyType.FS:
                es_constraints = np.maximum(es_constraints, ef_mat[:, p] + lag_wd)
            elif dep.dep_type == DependencyType.SS:
                es_constraints = np.maximum(es_constraints, es_mat[:, p] + lag_wd)
            elif dep.dep_type == DependencyType.FF:
                ef_constraints = np.maximum(ef_constraints, ef_mat[:, p] + lag_wd)
                has_ef_constraint = True
            elif dep.dep_type == DependencyType.SF:
                ef_constraints = np.maximum(ef_constraints, es_mat[:, p] + lag_wd)
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

    # --- Convert offsets back to dates using a working-day index ---
    max_offset = int(np.ceil(completion_offsets.max())) + 1
    # Add a safety buffer in case rounding pushes past the index.
    wd_index = _build_working_day_index(project.start_date, calendar, max_offset + 30)

    def _offset_to_date(offset: float) -> date:
        idx = max(0, min(round(offset), len(wd_index) - 1))
        return wd_index[idx]

    all_dates = sorted(_offset_to_date(o) for o in completion_offsets.tolist())

    p50 = all_dates[int(0.50 * runs) - 1]
    p80 = all_dates[int(0.80 * runs) - 1]
    p95 = all_dates[int(0.95 * runs) - 1]

    return MonteCarloResult(
        project_id=project.id,
        runs=runs,
        p50=p50,
        p80=p80,
        p95=p95,
        distribution=all_dates,
    )
