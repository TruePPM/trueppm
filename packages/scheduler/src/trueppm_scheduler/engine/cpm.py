"""Public API: :func:`schedule`, the deterministic CPM entry point."""

from __future__ import annotations

import copy
import weakref
from datetime import (
    date,
)

import networkx as nx

from trueppm_scheduler.engine.backward import (
    _backward_pass,
    _compute_floats,
)
from trueppm_scheduler.engine.calendar_math import (
    _WorkingDayCounter,
)
from trueppm_scheduler.engine.errors import (
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.forward import (
    _forward_pass,
)
from trueppm_scheduler.engine.graph import (
    _build_graph,
    _raise_cycle_error,
    _resolve_task_calendars,
)
from trueppm_scheduler.engine.milestones import (
    _finish_instant,
    _float_late_instant,
    _Instant,
)
from trueppm_scheduler.engine.replay import (
    _MilestoneReplay,
)
from trueppm_scheduler.engine.results import (
    _MILESTONE_REPLAY_ATTR,
    ScheduleResult,
)
from trueppm_scheduler.engine.validate import (
    _validate_project,
)
from trueppm_scheduler.models import (
    Project,
)

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
    commitment date — on a network of FS/SS links it is the earliest any
    :func:`monte_carlo` run can finish (samples are clamped up to ``duration``),
    so the odds of hitting it are low and fall as more tasks carry an estimate. Callers
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
    # on a cycle in ~3ms, versus ~148ms for an eager cycle search on every
    # happy-path call at 5K tasks (#1526). The SCC + BFS in _canonical_cycle
    # runs only on the error path, inside _raise_cycle_error.
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
    # computation is O(log E) per span instead of O(span) (#822, ADR-0142). Every
    # date _compute_floats measures lies within [earliest early start,
    # project_finish]; the earliest early start is start_date or earlier, since an
    # SF-linked task can be placed before the project start (#4218). The counter is
    # built over the default calendar; per-task-calendar spans fall back to the
    # direct count inside _compute_floats.
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
