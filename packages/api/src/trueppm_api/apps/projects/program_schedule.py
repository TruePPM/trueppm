"""Program-scoped CPM read surface (#1117 / ADR-0120 D3 read side, enables D6).

Computes the **program-true** critical path across a program's member projects
*on read*: every member project's tasks and every accepted cross-project edge are
merged into one engine graph and the deterministic CPM runs once, so an upstream
task gating another project's milestone reports ``is_critical`` and floats against
the whole program — the honest cross-project critical path. This is the
render-don't-derive (ADR-0115) source the #1118 ``ProgramSchedulePage`` consumes;
no client-side program math.

It deliberately does **not** persist. There is no write-back to per-project
tasks, no ``schedule_lock:program:{id}``, and no outbox coalescing — those belong
to the deferred D3 *dispatch* pass (ADR-0120). Until that lands, per-project
surfaces keep their per-project CPM and this endpoint is the only program-true
view. Computing on read avoids the lock/coalesce/fan-out machinery entirely at
the cost of one CPM per request, which the ``MAX_PROGRAM_TASKS`` guard bounds.

Visibility (ADR-0120 D5): a requester gated in by ``IsProgramMember`` sees full
schedule rows for member projects they belong to and the redacted
``ExternalTaskCard`` shape (title + CPM dates only, no description/assignee/
status) for member projects they cannot read — never a bare "blocked by
[redacted]".
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from rest_framework.exceptions import APIException

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program

# Soft upper bound on the merged leaf-task count for an on-read CPM. A
# compute-on-read pass is O(tasks + edges); for a pathologically large program
# the persisted D3 dispatch pass (with caching) is the right path, so we fail
# loud with a 422 rather than serving a slow request. Chosen far above any
# realistic single program so it only fires on degenerate input.
MAX_PROGRAM_TASKS = 5000


class ProgramScheduleTooLarge(APIException):
    """Raised when a program exceeds ``MAX_PROGRAM_TASKS`` for an on-read CPM."""

    status_code = 422
    default_detail = (
        "This program has too many tasks for an on-read schedule computation; "
        "the persisted program-schedule pass is required for programs this large."
    )
    default_code = "program_schedule_too_large"


def compute_program_schedule(
    program: Program,
    *,
    can_access_project: Callable[[Any], bool],
) -> dict[str, Any]:
    """Compute the merged, program-true schedule for ``program`` on read.

    Args:
        program: The program whose member projects are merged into one CPM graph.
        can_access_project: Predicate ``project_id -> bool`` deciding whether the
            requester may read a member project's tasks in full. Tasks of projects
            for which this returns ``False`` are redacted to the ExternalTaskCard
            shape. Injected by the view so this service stays request-agnostic.

    Returns:
        A JSON-serializable dict: ``program_id``, ``start_date``, ``finish_date``,
        ``projects`` (lane metadata with per-project ``accessible``), ``tasks``
        (full or redacted, discriminated by ``is_external``), ``links`` (leaf-level
        edges with ``is_cross_project``), ``critical_path`` (program-true task-id
        order), and ``cross_project_edge_count``.

    Raises:
        ProgramScheduleTooLarge: When the merged leaf-task count exceeds the guard.
    """
    from trueppm_scheduler.engine import expand_summary_dependencies, schedule
    from trueppm_scheduler.models import Calendar as SchedCalendar
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject

    from trueppm_api.apps.projects.models import (
        Dependency,
        EstimationMode,
        Project,
        TaskType,
    )
    from trueppm_api.apps.scheduling.services import build_sched_tasks

    member_projects = list(
        Project.objects.filter(program=program, is_deleted=False)
        .select_related("calendar")
        .prefetch_related("tasks", "tasks__sprint")
        .order_by("start_date", "name")
    )
    project_by_id = {p.id: p for p in member_projects}

    # Lane metadata is independent of whether the program has any schedulable
    # work, so build it up front and return it even on the empty path.
    # Project has no accent color (only Program/Task do), so lane colors are
    # assigned client-side by the #1118 Gantt; the lane metadata carries identity
    # and the per-project access flag only.
    lanes = [
        {
            "id": str(p.id),
            "name": p.name,
            "accessible": bool(can_access_project(p.id)),
        }
        for p in member_projects
    ]

    # --- Per-project conversion, replicating the single-project _run_schedule
    # filter (drop recurring + EPIC grouping nodes) and tagging each task with its
    # own project's calendar so the merged pass uses per-task calendars (ADR-0120
    # D3 engine substrate). Task ids are globally-unique UUIDs, so merging the
    # per-project task lists needs no namespacing.
    all_sched_tasks: list[Any] = []
    all_children_map: dict[str, list[str]] = {}
    calendars: dict[str, SchedCalendar] = {}
    db_task_by_id: dict[str, Any] = {}
    total_tasks = 0

    for p in member_projects:
        db_tasks = [t for t in p.tasks.all() if not t.is_recurring and t.type != TaskType.EPIC]
        if not db_tasks:
            continue
        total_tasks += len(db_tasks)
        if total_tasks > MAX_PROGRAM_TASKS:
            raise ProgramScheduleTooLarge

        cal = p.calendar
        calendars[str(p.id)] = SchedCalendar(
            working_days=cal.working_days if cal else 31,
            hours_per_day=cal.hours_per_day if cal else 8.0,
            timezone=cal.timezone if cal else "UTC",
        )

        sched_tasks = build_sched_tasks(
            db_tasks,
            suggest_approve=p.estimation_mode == EstimationMode.SUGGEST_APPROVE,
        )
        for st in sched_tasks:
            # Point each task at its project's calendar in the merged registry;
            # the engine falls back to the project-level default for any unknown
            # id (it never will here).
            st.calendar_id = str(p.id)
        all_sched_tasks.extend(sched_tasks)

        for t in db_tasks:
            db_task_by_id[str(t.id)] = t

        # children_map for summary expansion — built per project from wbs_path,
        # then merged (keys are unique task ids). Mirrors _run_schedule exactly.
        for t in db_tasks:
            if not t.wbs_path:
                continue
            parent_path = str(t.wbs_path).rsplit(".", 1)
            if len(parent_path) < 2:
                continue
            for candidate in db_tasks:
                if candidate.wbs_path and str(candidate.wbs_path) == parent_path[0]:
                    all_children_map.setdefault(str(candidate.id), []).append(str(t.id))
                    break

    if not all_sched_tasks:
        return {
            "program_id": str(program.pk),
            "start_date": None,
            "finish_date": None,
            "projects": lanes,
            "tasks": [],
            "links": [],
            "critical_path": [],
            "cross_project_edge_count": 0,
        }

    # --- Dependencies: every within-project edge plus every ACCEPTED cross-project
    # edge whose endpoints both sit in member projects. Pending (unaccepted) cross
    # edges are excluded — an unconsented edge is not yet a modeled constraint
    # (ADR-0120 D2). Within-project edges are never pending, so the single
    # ``exclude(pending_acceptance=True)`` keeps them all.
    member_ids = list(project_by_id.keys())
    db_deps = list(
        Dependency.objects.filter(
            is_deleted=False,
            predecessor__project_id__in=member_ids,
            successor__project_id__in=member_ids,
        )
        .exclude(pending_acceptance=True)
        .select_related("predecessor", "successor")
    )

    included_ids = set(db_task_by_id.keys())
    sched_deps = [
        SchedDependency(
            predecessor_id=str(d.predecessor_id),
            successor_id=str(d.successor_id),
            dep_type=DependencyType(d.dep_type),
            lag=timedelta(days=d.lag),
        )
        for d in db_deps
        if str(d.predecessor_id) in included_ids and str(d.successor_id) in included_ids
    ]

    leaf_tasks, expanded_deps = expand_summary_dependencies(
        all_sched_tasks, sched_deps, all_children_map
    )

    start_date = min(p.start_date for p in member_projects)
    merged = SchedProject(
        id=str(program.pk),
        name=program.name,
        start_date=start_date,
        tasks=leaf_tasks,
        dependencies=expanded_deps,
        # Per-task calendar_id drives each task's working-day math; this default
        # is only a fallback for tasks with no calendar_id (none here).
        calendar=SchedCalendar(),
        calendars=calendars,
        # Earliest-possible dates: per-project status_dates differ across the
        # program, so a single merged data date would be arbitrary. The program
        # forecast view shows the earliest honest schedule (ADR-0132 parity with a
        # null status_date), not a data-date floor.
        status_date=None,
    )

    result = schedule(merged)
    result_by_id = {st.id: st for st in result.tasks}
    leaf_ids = set(result_by_id.keys())

    tasks_payload = [
        _task_payload(tid, st, db_task_by_id[tid], project_by_id, can_access_project)
        for tid, st in result_by_id.items()
        if tid in db_task_by_id
    ]

    links_payload = []
    cross_count = 0
    for d in db_deps:
        pid = str(d.predecessor_id)
        sid = str(d.successor_id)
        if pid not in leaf_ids or sid not in leaf_ids:
            # Edge touches a summary task (expanded away) or an excluded task —
            # not a renderable leaf-level link.
            continue
        is_cross = d.predecessor.project_id != d.successor.project_id
        if is_cross:
            cross_count += 1
        links_payload.append(
            {
                "predecessor_id": pid,
                "successor_id": sid,
                "dep_type": d.dep_type,
                "lag_days": d.lag,
                "is_cross_project": is_cross,
            }
        )

    return {
        "program_id": str(program.pk),
        "start_date": result.project_start,
        "finish_date": result.project_finish,
        "projects": lanes,
        "tasks": tasks_payload,
        "links": links_payload,
        "critical_path": list(result.critical_path),
        "cross_project_edge_count": cross_count,
    }


def _task_payload(
    tid: str,
    sched_task: Any,
    db_task: Any,
    project_by_id: dict[Any, Any],
    can_access_project: Callable[[Any], bool],
) -> dict[str, Any]:
    """Build one task row — full when the requester can read the project, else the
    ADR-0120 D5 ExternalTaskCard shape (title + CPM dates only). The CPM values
    come from the *merged* result, so a redacted card still shows program-true
    early dates and criticality, never the stale per-project numbers.
    """
    project = project_by_id.get(db_task.project_id)
    if can_access_project(db_task.project_id):
        return {
            "id": tid,
            "name": db_task.name,
            "hex_id": db_task.short_id,
            "project_id": str(db_task.project_id),
            "is_milestone": db_task.is_milestone,
            "is_external": False,
            "wbs_path": str(db_task.wbs_path) if db_task.wbs_path else None,
            "early_start": sched_task.early_start,
            "early_finish": sched_task.early_finish,
            "late_start": sched_task.late_start,
            "late_finish": sched_task.late_finish,
            "total_float_days": sched_task.total_float.days,
            "is_critical": sched_task.is_critical,
        }
    # Redacted — mirrors ExternalTaskCardSerializer's field set exactly so the two
    # cross-project read surfaces stay in lockstep. The text key here is ``title``
    # (NOT ``name`` as in the full branch above) deliberately: that is the
    # ExternalTaskCard contract D5 already ships. Do not "align" the two branches
    # to a single key — the client discriminates the redacted shape by it, and the
    # divergence is the contract, not an oversight.
    return {
        "id": tid,
        "title": db_task.name,
        "hex_id": db_task.short_id,
        "project_id": str(db_task.project_id),
        "project_name": project.name if project else "",
        "is_milestone": db_task.is_milestone,
        "is_external": True,
        "early_start": sched_task.early_start,
        "early_finish": sched_task.early_finish,
        "is_critical": sched_task.is_critical,
    }
