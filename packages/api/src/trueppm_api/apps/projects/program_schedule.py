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

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from rest_framework.exceptions import APIException

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program

# Engine ``SchedulerError`` messages embed the offending task as ``Task '<uuid>'``
# (e.g. the #1069 three-point-ordering check). Extract the id to attribute the
# failure back to its member project for the #1981 structured 422; unmatched
# messages fall back to a project-less "some task" response.
_TASK_ID_RE = re.compile(
    r"Task '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'"
)

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


class ProgramScheduleInvalidInput(APIException):
    """Raised when a member project's task data makes the merged CPM unschedulable.

    The program schedule is compute-on-read, so a single degenerate task in *any*
    member project (invalid three-point estimate #1069, unknown-task dependency,
    unresolvable calendar, cycle) would otherwise surface as an unhandled 500 that
    blanks the whole cross-project view for every member (#1981). We instead map
    the engine's ``SchedulerError`` to a structured, non-500 response that names
    the offending project (and task where identifiable), so the frontend can point
    the user at the project to fix rather than dead-ending on a retry that can
    never succeed. The body carries ``code`` so the client distinguishes this from
    the sibling 422 (``program_schedule_too_large``).
    """

    status_code = 422
    default_code = "program_schedule_invalid_input"

    def __init__(
        self,
        *,
        reason: str | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        task_id: str | None = None,
        task_name: str | None = None,
    ) -> None:
        if project_name:
            detail_msg = (
                f"A task in “{project_name}” has data the schedule engine "
                "cannot compute. Open that project's schedule to fix it."
            )
        else:
            detail_msg = (
                "A task in one of this program's projects has data the schedule "
                "engine cannot compute. Open the offending project's schedule to "
                "fix it."
            )
        # Only non-null keys are included: DRF coerces every scalar leaf of an
        # APIException detail into an ``ErrorDetail`` string, so a literal ``None``
        # would serialize as the string ``"None"`` rather than JSON ``null``.
        # Omitting the key instead gives the client a clean "absent" (undefined).
        body: dict[str, Any] = {"code": self.default_code, "detail": detail_msg}
        if reason is not None:
            # Carries the offending task's estimate values; present only for an
            # accessible offending project (ADR-0120 D5 — see the raise site).
            body["reason"] = reason
        if project_id:
            body["project"] = {"id": project_id, "name": project_name}
        if task_id:
            body["task"] = {"id": task_id, "name": task_name}
        super().__init__(body)


@dataclass
class ProgramScheduleGraph:
    """The merged program graph plus its program-true CPM result (ADR-0120 D3).

    The single output of :func:`gather_program_schedule`, shared by the on-read
    endpoint (:func:`compute_program_schedule`) and the persisted dispatch pass
    (``scheduling.tasks.recalculate_program_schedule``) so the gather + merged CPM
    runs through one code path and the two surfaces can never drift (the #1185
    failure class). ``result``/``result_map`` are ``None``/empty when the program
    has no schedulable work.

    ``result_map`` holds the *leaf* CPM rows only (summary tasks are excluded from
    the pass, exactly as the single-project engine does); the persisted write-back
    rolls summary dates up separately via ``apply_summary_rollups``.
    """

    member_projects: list[Any]
    project_by_id: dict[Any, Any]
    db_task_by_id: dict[str, Any]
    children_map: dict[str, list[str]]
    db_deps: list[Any]
    # The expanded *leaf-level* dependency edges the CPM actually ran on (summary
    # edges resolved to their leaves). The D4 firewall walks this adjacency to
    # attribute downstream slips to a cross-project edge. Empty on the no-work path.
    expanded_deps: list[Any]
    start_date: Any
    result: Any | None
    result_map: dict[str, Any]
    leaf_ids: set[str]

    @property
    def summary_ids(self) -> set[str]:
        """Task ids that have ≥1 child in the merged WBS — the summary nodes."""
        return set(self.children_map.keys())


def gather_program_schedule(
    program: Program,
    *,
    enforce_max: bool = True,
    can_access_project: Callable[[Any], bool] | None = None,
) -> ProgramScheduleGraph:
    """Merge every member project's tasks + accepted cross edges and run CPM once.

    The shared substrate of ADR-0120 D3: every member project's committed tasks
    and every ACCEPTED cross-project dependency (both endpoints in member projects)
    are merged into one engine ``Project`` — each task tagged with its own
    project's calendar (the per-task-calendar substrate) — and the deterministic
    CPM runs a single time, so floats and criticality are program-true across the
    boundary.

    Args:
        program: The program whose member projects are merged.
        enforce_max: When True (the on-read path), raise ``ProgramScheduleTooLarge``
            above ``MAX_PROGRAM_TASKS`` rather than serving a slow request. The
            persisted background pass passes False — it is allowed to be slow and a
            422 has no caller there.
        can_access_project: Optional ``project_id -> bool`` predicate used only when
            attributing a ``ProgramScheduleInvalidInput`` (#1981). The raw engine
            ``reason`` string embeds the offending task's estimate day-values, which
            ADR-0120 D5 withholds for member projects the requester cannot read; the
            ``reason`` is therefore included only when the offending project is
            accessible. Absent (the background path never raises the 422), the
            reason is omitted.

    Raises:
        ProgramScheduleTooLarge: When ``enforce_max`` and the merged leaf-task
            count exceeds ``MAX_PROGRAM_TASKS``.
        ProgramScheduleInvalidInput: When ``enforce_max`` and a member project's
            task data makes the merged CPM unschedulable.
    """
    from trueppm_scheduler.engine import (
        CyclicDependencyError,
        SchedulerError,
        expand_summary_dependencies,
        schedule,
    )
    from trueppm_scheduler.models import Calendar as SchedCalendar
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject

    from trueppm_api.apps.projects.models import (
        Dependency,
        EstimationMode,
        Project,
        TaskStatus,
        TaskType,
    )
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar
    from trueppm_api.apps.scheduling.services import build_sched_tasks

    member_projects = list(
        Project.objects.filter(program=program, is_deleted=False)
        .select_related("calendar", "program__calendar")
        # calendar__exceptions + calendar_layers__calendar__exceptions:
        # compose_project_calendar reads each member project's base calendar
        # exceptions (#1491) AND its applied overlays (#906); prefetch both to
        # avoid an N+1 across the whole program (this loop iterates every member).
        # program__calendar__exceptions: a member project that sets no calendar of
        # its own inherits the program calendar (ADR-0441), whose exceptions the
        # resolver reads — prefetch to keep the whole-program pass N+1-free.
        .prefetch_related(
            "tasks",
            "tasks__sprint",
            "calendar__exceptions",
            "calendar_layers__calendar__exceptions",
            "program__calendar__exceptions",
        )
        .order_by("start_date", "name")
    )
    project_by_id = {p.id: p for p in member_projects}

    # --- Per-project conversion, replicating the single-project _run_schedule
    # filter (drop recurring, EPIC grouping nodes, BACKLOG cards, and soft-deleted
    # tombstones — matching CommittedTaskManager, #1772) and tagging each task with
    # its own project's calendar so the merged pass uses per-task calendars
    # (ADR-0120 D3 engine substrate). Task ids are globally-unique UUIDs, so
    # merging the per-project task lists needs no namespacing.
    all_sched_tasks: list[Any] = []
    all_children_map: dict[str, list[str]] = {}
    calendars: dict[str, SchedCalendar] = {}
    db_task_by_id: dict[str, Any] = {}
    total_tasks = 0

    for p in member_projects:
        db_tasks = [
            t
            for t in p.tasks.all()
            if not t.is_recurring
            and t.type != TaskType.EPIC
            and t.status != TaskStatus.BACKLOG
            and not t.is_deleted
        ]
        if not db_tasks:
            continue
        total_tasks += len(db_tasks)
        if enforce_max and total_tasks > MAX_PROGRAM_TASKS:
            raise ProgramScheduleTooLarge

        # Shared composer (#906/#1491): overlays each member project's base +
        # applied calendars into one non-working mask, including every
        # CalendarException holiday/shutdown range — so the merged program-scoped
        # CPM pass honors the same composed calendar as the single-project pass.
        calendars[str(p.id)] = compose_project_calendar(p)

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

    # --- Dependencies: every within-project edge plus every ACCEPTED cross-project
    # edge whose endpoints both sit in member projects. Pending (unaccepted) cross
    # edges are excluded — an unconsented edge is not yet a modeled constraint
    # (ADR-0120 D2). Within-project edges are never pending, so the single
    # ``exclude(pending_acceptance=True)`` keeps them all. Computed even on the
    # empty path so the (cheap) query result is uniform; the empty graph carries it.
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

    if not all_sched_tasks:
        return ProgramScheduleGraph(
            member_projects=member_projects,
            project_by_id=project_by_id,
            db_task_by_id=db_task_by_id,
            children_map=all_children_map,
            db_deps=db_deps,
            expanded_deps=[],
            start_date=None,
            result=None,
            result_map={},
            leaf_ids=set(),
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

    try:
        result = schedule(merged)
    except SchedulerError as exc:
        # Only the on-read HTTP path (``enforce_max``) converts a degenerate-data
        # failure into a structured response. The persisted background pass
        # (``enforce_max=False``) must let the original ``SchedulerError``
        # propagate to its ``TaskRunTracker``, which marks the run FAILED — a DRF
        # ``APIException`` has no meaning in a Celery context and would corrupt
        # that telemetry.
        if not enforce_max:
            raise
        # Compute-on-read means a single degenerate task in any member project
        # would otherwise become an unhandled 500 that blanks the whole program
        # view (#1981). Map it to a structured 422 that names the offending
        # project/task so the client can render an actionable state instead of a
        # dead retry loop. Best-effort attribution: a cycle carries its task ids
        # directly; other inputs embed the offending id in the message.
        offending_ids: list[str] = []
        if isinstance(exc, CyclicDependencyError):
            offending_ids = [tid for tid in exc.cycle if tid in db_task_by_id]
        else:
            offending_ids = [tid for tid in _TASK_ID_RE.findall(str(exc)) if tid in db_task_by_id]
        db_task = db_task_by_id.get(offending_ids[0]) if offending_ids else None
        project = project_by_id.get(db_task.project_id) if db_task is not None else None
        # The raw ``reason`` embeds the offending task's estimate day-values, which
        # ADR-0120 D5 withholds for member projects the requester cannot fully read
        # (the redacted ExternalTaskCard ships title + CPM dates only). Include it
        # only when the offending project is attributable AND accessible; otherwise
        # the client still gets the project/task identity (already public via lane
        # metadata + ExternalTaskCard) but not the withheld estimate values.
        reason_visible = (
            project is not None
            and can_access_project is not None
            and can_access_project(project.id)
        )
        raise ProgramScheduleInvalidInput(
            reason=str(exc) if reason_visible else None,
            project_id=str(project.id) if project is not None else None,
            project_name=project.name if project is not None else None,
            task_id=str(db_task.id) if db_task is not None else None,
            task_name=db_task.name if db_task is not None else None,
        ) from exc
    result_map = {st.id: st for st in result.tasks}
    leaf_ids = set(result_map.keys())

    return ProgramScheduleGraph(
        member_projects=member_projects,
        project_by_id=project_by_id,
        db_task_by_id=db_task_by_id,
        children_map=all_children_map,
        db_deps=db_deps,
        expanded_deps=expanded_deps,
        start_date=start_date,
        result=result,
        result_map=result_map,
        leaf_ids=leaf_ids,
    )


def program_has_accepted_cross_edges(program_id: Any) -> bool:
    """Whether ``program_id`` has ≥1 accepted cross-project dependency (ADR-0120 D3).

    The escalation predicate: a project's CPM recompute escalates to a merged,
    program-scoped pass only when this is True. Cheap and index-friendly — an
    EXISTS over the program's accepted (non-pending, non-deleted) edges whose two
    endpoints sit in two *different* member projects. Cross-PROGRAM edges can't
    match (both endpoints are required to share this ``program_id``), so the
    ADR-0070 boundary is preserved here too.
    """
    from django.db.models import F

    from trueppm_api.apps.projects.models import Dependency

    return (
        Dependency.objects.filter(
            is_deleted=False,
            pending_acceptance=False,
            predecessor__project__program_id=program_id,
            successor__project__program_id=program_id,
        )
        .exclude(predecessor__project_id=F("successor__project_id"))
        .exists()
    )


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
        ProgramScheduleInvalidInput: When a member project's task data makes the
            merged CPM unschedulable (#1981); the engine ``reason`` is included only
            for an accessible offending project (ADR-0120 D5).
    """
    graph = gather_program_schedule(
        program, enforce_max=True, can_access_project=can_access_project
    )

    # Lane metadata is independent of whether the program has any schedulable
    # work, so build it from the member set and return it even on the empty path.
    # Project has no accent color (only Program/Task do), so lane colors are
    # assigned client-side by the #1118 Gantt; the lane metadata carries identity
    # and the per-project access flag only.
    lanes = [
        {
            "id": str(p.id),
            "name": p.name,
            "accessible": bool(can_access_project(p.id)),
        }
        for p in graph.member_projects
    ]

    if graph.result is None:
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

    result = graph.result
    result_by_id = graph.result_map
    leaf_ids = graph.leaf_ids
    db_task_by_id = graph.db_task_by_id
    project_by_id = graph.project_by_id

    tasks_payload = [
        _task_payload(tid, st, db_task_by_id[tid], project_by_id, can_access_project)
        for tid, st in result_by_id.items()
        if tid in db_task_by_id
    ]

    links_payload = []
    cross_count = 0
    for d in graph.db_deps:
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
