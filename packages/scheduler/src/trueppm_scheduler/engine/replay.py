"""Milestone pass state kept on a :class:`ScheduleResult` and replayed for :mod:`derive`."""

from __future__ import annotations

import copy
import weakref
from dataclasses import (
    dataclass,
)
from datetime import (
    date,
)

import networkx as nx

from trueppm_scheduler.engine.backward import (
    _backward_pass,
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
    _Instant,
    _milestone_free_instants,
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
    Task,
)


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
    # An uncached ``project`` never went through schedule()'s guard, so refuse here
    # exactly what schedule() refuses (NaN percent_complete, bad calendars, ...)
    # before any graph pass turns it into a bare ValueError/TypeError (#4836).
    _validate_project(project)
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
    # Reached from derive_value with a caller-supplied result and no validation, so
    # a project that gained a cycle since the result was computed lands here.
    try:
        topo_order: list[str] = list(nx.topological_sort(g))
    except nx.NetworkXUnfeasible:
        _raise_cycle_error(g)
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
