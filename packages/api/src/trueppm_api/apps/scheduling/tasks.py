"""Celery tasks for the scheduling app."""

from __future__ import annotations

import logging
from datetime import timedelta

import redis as redis_lib
from celery.exceptions import SoftTimeLimitExceeded
from django.db import OperationalError

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# Exceptions that are transient and should trigger Celery's built-in retry.
_RETRIABLE = (ConnectionError, redis_lib.ConnectionError, OperationalError)


@idempotent_task(
    lock_key_template="schedule_lock:{0}",
    lock_ttl=300,
    on_contention="queue",
    queue_countdown=10,
    max_queue_attempts=5,
    autoretry_for=_RETRIABLE,
    retry_backoff=30,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    soft_time_limit=480,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
)
def recalculate_schedule(
    self: object,
    project_id: str,
    changed_task_ids: list[str] | None = None,
) -> None:
    """Run CPM on a project and persist the results.

    Idempotency is enforced by the ``@idempotent_task`` decorator which
    acquires a Redis SET NX lock keyed by project_id and auto-extends it
    for long-running schedules. On lock contention the task is re-queued
    with a 10-second countdown (up to 5 attempts).

    Progress is tracked via TaskRunTracker, which persists status to the
    TaskRun model and broadcasts task_run_* WebSocket events. The frontend
    subscribes to these events instead of the old cpm_queued/complete/error
    events (replaced by ADR-0020).

    Args:
        project_id: UUID string of the project to reschedule.
        changed_task_ids: Optional list of task UUID strings that were mutated.
            When provided, CPM results are only written back to the database for
            tasks in the affected subgraph (changed tasks + their descendants).
            Falls back to a full recompute when the affected set exceeds 25% of
            all project tasks or when this argument is None.
    """
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    try:
        with TaskRunTracker(
            self,
            project_id=project_id,
            task_name="scheduling.recalculate",
        ) as tracker:
            _run_schedule(project_id, tracker, changed_task_ids=changed_task_ids)
    except SoftTimeLimitExceeded:
        logger.error(
            "recalculate_schedule: soft time limit exceeded for project %s",
            project_id,
        )
        from django.db import transaction

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Record the failure first, then broadcast cpm_error only after that row
        # commits (#896): clients should not be told a recompute failed unless the
        # dead-letter record actually persisted. Default-arg binding pins the id.
        with transaction.atomic():
            _dead_letter_current(
                self, project_id, SoftTimeLimitExceeded("CPM computation timed out")
            )

            def _broadcast_error(pid: str = project_id) -> None:
                broadcast_board_event(
                    project_id=pid, event_type="cpm_error", payload={"error": "timeout"}
                )

            transaction.on_commit(_broadcast_error)


@idempotent_task(
    lock_key_template="drain_schedule_queue",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="scheduling.drain_schedule_queue",
)
def drain_schedule_queue(self: object) -> None:
    """Dispatch any pending ScheduleRequest outbox rows.

    Runs every 30 seconds via Celery Beat. For each project with a pending
    row, calls recalculate_schedule.delay() and marks the row as dispatched.

    Also recovers orphaned dispatched rows older than 10 minutes — the
    recalculate_schedule soft_time_limit is 480 s (8 min), so 10 min ensures
    any prior task invocation has either completed or timed out before we
    re-dispatch.

    The @idempotent_task singleton lock ensures at most one drain runs at a
    time; on_contention="skip" drops any concurrent trigger rather than
    queuing, because the next Beat tick will cover it.
    """
    _do_drain()


@idempotent_task(
    lock_key_template="purge_old_schedule_requests",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="scheduling.purge_old_schedule_requests",
)
def purge_old_schedule_requests(self: object) -> None:
    """Delete done/dead ScheduleRequest rows older than 7 days.

    Runs nightly at 02:15 UTC via Celery Beat. Keeps the outbox table small
    so index scans on (status, requested_at) stay fast.
    """
    _do_purge()


def _do_drain() -> None:
    """Business logic for drain_schedule_queue — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=10)

    # Recover orphaned rows: dispatched but not completed within 10 minutes.
    recovered = ScheduleRequest.objects.filter(
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at__lt=orphan_cutoff,
    ).update(status=ScheduleRequestStatus.PENDING, celery_task_id="")
    if recovered:
        logger.warning("drain_schedule_queue: recovered %d orphaned dispatched row(s)", recovered)

    # Dispatch all currently pending rows (one Celery task per project).
    pending = list(ScheduleRequest.objects.filter(status=ScheduleRequestStatus.PENDING))
    dispatched = 0
    for req in pending:
        try:
            result = recalculate_schedule.delay(str(req.project_id))
        except Exception:
            logger.warning(
                "drain_schedule_queue: broker unavailable — project %s stays pending",
                req.project_id,
            )
            continue
        # Conditional update: only flip to dispatched if it's still pending
        # (guards against a concurrent on_commit _enqueue_recalculate call).
        ScheduleRequest.objects.filter(id=req.id, status=ScheduleRequestStatus.PENDING).update(
            status=ScheduleRequestStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
        dispatched += 1

    if dispatched or recovered:
        logger.info("drain_schedule_queue: dispatched=%d recovered=%d", dispatched, recovered)


def _do_purge() -> None:
    """Business logic for purge_old_schedule_requests — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus

    cutoff = timezone.now() - timedelta(days=7)
    deleted, _ = ScheduleRequest.objects.filter(
        status__in=[ScheduleRequestStatus.DONE, ScheduleRequestStatus.DEAD],
        requested_at__lt=cutoff,
    ).delete()
    logger.info("purge_old_schedule_requests: deleted %d row(s)", deleted)


@idempotent_task(
    lock_key_template="purge_old_monte_carlo_runs",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="scheduling.purge_old_monte_carlo_runs",
)
def purge_old_monte_carlo_runs(self: object) -> None:
    """Trim project Monte Carlo run history to the newest cap per project.

    Runs nightly at 02:20 UTC via Celery Beat. Keeps the most recent
    ``settings.MC_HISTORY_CAP`` ``MonteCarloRun`` rows per project (ADR-0109,
    #961) so forecast-drift history stays bounded. No-ops when the cap is
    ``None`` (Enterprise unlimited). Idempotent: rank-based delete is safe to
    run repeatedly.
    """
    _do_monte_carlo_run_purge()


def _do_monte_carlo_run_purge() -> None:
    """Business logic for purge_old_monte_carlo_runs — extracted for testability.

    For each project that exceeds the cap, delete every run older than its
    cap-th most recent. Iterates only over projects above the cap so the common
    case (most projects under 100 runs) does no delete work.
    """
    from django.conf import settings
    from django.db.models import Count

    from trueppm_api.apps.scheduling.models import MonteCarloRun

    cap: int | None = settings.MC_HISTORY_CAP
    if cap is None:
        return  # Enterprise: unlimited history, nothing to purge.

    over_cap = (
        MonteCarloRun.objects.values("project_id")
        .annotate(n=Count("id"))
        .filter(n__gt=cap)
        .values_list("project_id", flat=True)
    )

    total_deleted = 0
    for project_id in list(over_cap):
        # Find the taken_at of the cap-th most recent run; everything strictly
        # older is surplus. Ordered by -taken_at so [cap - 1] is the boundary row.
        boundary = list(
            MonteCarloRun.objects.filter(project_id=project_id)
            .order_by("-taken_at")
            .values_list("taken_at", flat=True)[cap - 1 : cap]
        )
        if not boundary:
            continue
        deleted, _ = MonteCarloRun.objects.filter(
            project_id=project_id, taken_at__lt=boundary[0]
        ).delete()
        total_deleted += deleted

    if total_deleted:
        logger.info("purge_old_monte_carlo_runs: deleted %d row(s)", total_deleted)


def _dead_letter_current(task: object, project_id: str, exc: BaseException) -> None:
    """Write a FailedTask record for the current task invocation."""
    from trueppm_api.apps.scheduling.deadletter import record_failed_task

    request = task.request  # type: ignore[attr-defined]
    record_failed_task(
        task_name=getattr(task, "name", "unknown"),
        task_id=request.id or "unknown",
        args=[project_id],
        kwargs={},
        exception=exc,
        project_id=project_id,
    )


_INCREMENTAL_THRESHOLD = 0.25
"""Fall back to full-write if the affected subgraph exceeds this fraction of all tasks."""

CPM_DELTA_BROADCAST_CAP = 500
"""Max moved-task count to ship as per-task ``task_dates_updated`` deltas (ADR-0091).

Above this the WS frame grows large enough that a client-side full re-fetch is cheaper
than splicing, so we emit a ``truncated`` signal instead and let the client invalidate.
A 500-task payload is ≈60 KB; the incremental-CPM path (ADR-0027) already keeps most
recomputes well under the cap, so the truncated branch is reached only on genuine
large/full recomputes — the same case that re-fetched everything before this ADR.
"""


def _downstream_task_ids(project_id: str, seed_ids: list[str]) -> frozenset[str]:
    """Return seed_ids plus all task IDs reachable from them via dependency edges.

    Uses a lightweight query of just (predecessor_id, successor_id) pairs — no
    full Task rows are loaded.  The graph is traversed BFS-style using Python sets
    so the cost is O(E) where E is the number of dependencies in the project.

    Args:
        project_id: Only edges within this project are considered.
        seed_ids: Task IDs from which BFS starts (the mutated tasks).

    Returns:
        A frozenset of task ID strings (seeds included).
    """
    from trueppm_api.apps.projects.models import Dependency

    edges = list(
        Dependency.objects.filter(predecessor__project_id=project_id).values_list(
            "predecessor_id", "successor_id"
        )
    )
    # Build adjacency map (forward edges only — we want downstream tasks).
    adj: dict[str, list[str]] = {}
    for pred_id, succ_id in edges:
        adj.setdefault(str(pred_id), []).append(str(succ_id))

    visited: set[str] = set(seed_ids)
    queue = list(seed_ids)
    while queue:
        node = queue.pop()
        for neighbour in adj.get(node, []):
            if neighbour not in visited:
                visited.add(neighbour)
                queue.append(neighbour)
    return frozenset(visited)


def _run_schedule(
    project_id: str,
    tracker: object = None,
    changed_task_ids: list[str] | None = None,
) -> None:
    """Load tasks/dependencies, run CPM, bulk_update results, broadcast completion.

    When *changed_task_ids* is provided the function attempts an incremental write:
    CPM still runs on the full project (correctness requirement) but DB writes are
    limited to the changed tasks and their downstream descendants.  If the affected
    subgraph exceeds ``_INCREMENTAL_THRESHOLD`` (25%) of all tasks, a full write is
    performed instead.

    Args:
        project_id: UUID string of the project to schedule.
        tracker: Optional TaskRunTracker for progress reporting.
        changed_task_ids: Optional list of mutated task UUID strings used to narrow
            the bulk_update set.  None → always perform a full write.
    """
    from trueppm_scheduler.engine import expand_summary_dependencies, schedule
    from trueppm_scheduler.models import Calendar as SchedCalendar
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject
    from trueppm_scheduler.models import Task as SchedTask

    from trueppm_api.apps.projects.models import Dependency, Project, Task, TaskType

    def _update(pct: int, msg: str) -> None:
        if tracker is not None:
            tracker.update(pct, msg)  # type: ignore[attr-defined]

    _update(10, "Loading project data…")

    try:
        db_project = (
            Project.objects.select_related("calendar")
            .prefetch_related("tasks", "tasks__predecessors")
            .get(pk=project_id)
        )
    except Project.DoesNotExist:
        logger.warning("recalculate_schedule: project %s not found, skipping", project_id)
        return

    # Exclude recurrence templates and their generated occurrences from the CPM feed.
    # Recurring tasks are parallel, calendar-driven activities — admitting them to the
    # scheduling engine would corrupt float, the critical path, and Monte Carlo
    # P50/P80/P95. is_recurring is the single load-bearing exclusion key (ADR-0090);
    # CommittedTaskManager applies the same filter for Monte Carlo / capacity / PDF.
    #
    # type=EPIC is excluded for the same reason (ADR-0105): an epic is a grouping
    # node, not schedulable work — its rollup dates are computed from child stories, not
    # fed to CPM. CommittedTaskManager applies the matching exclusion at its boundary.
    # Filtered in Python so the prefetch cache from the queryset above is reused.
    db_tasks = [t for t in db_project.tasks.all() if not t.is_recurring and t.type != TaskType.EPIC]
    if not db_tasks:
        logger.info("recalculate_schedule: project %s has no tasks, skipping", project_id)
        return

    _update(25, "Building schedule model…")

    # Build a trueppm_scheduler.Calendar from the project's calendar (or default).
    cal = db_project.calendar
    sched_calendar = SchedCalendar(
        working_days=cal.working_days if cal else 31,
        hours_per_day=cal.hours_per_day if cal else 8.0,
        timezone=cal.timezone if cal else "UTC",
    )

    # Convert Django Task objects to scheduler dataclasses.
    # Milestones are zero-duration single-point gates regardless of any non-zero
    # duration that may have been imported (MS Project allows non-zero milestone
    # durations) or persisted before the serializer invariant was enforced. The
    # scheduler engine "operates on duration only" (see Task.is_milestone docstring)
    # so we normalise here at the boundary.
    sched_tasks = [
        SchedTask(
            id=str(t.id),
            name=t.name,
            duration=timedelta(days=0) if t.is_milestone else timedelta(days=t.duration),
            planned_start=t.planned_start,
            percent_complete=t.percent_complete,
            optimistic_duration=timedelta(days=t.optimistic_duration)
            if t.optimistic_duration is not None
            else None,
            most_likely_duration=timedelta(days=t.most_likely_duration)
            if t.most_likely_duration is not None
            else None,
            pessimistic_duration=timedelta(days=t.pessimistic_duration)
            if t.pessimistic_duration is not None
            else None,
        )
        for t in db_tasks
    ]

    # Convert Django Dependency objects to scheduler dataclasses. Drop any edge that
    # touches an excluded (recurring) task — its endpoint is absent from sched_tasks,
    # so handing it to the engine would create a dangling dependency. See ADR-0090.
    included_ids = {str(t.id) for t in db_tasks}
    db_deps = list(
        Dependency.objects.filter(predecessor__project_id=project_id).select_related(
            "predecessor", "successor"
        )
    )
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

    # Build children_map from wbs_path hierarchy for summary expansion.
    # A task is a summary if any other task's wbs_path is a direct child of it.
    db_task_by_id = {str(t.id): t for t in db_tasks}
    children_map: dict[str, list[str]] = {}
    for t in db_tasks:
        if not t.wbs_path:
            continue
        parts = str(t.wbs_path).rsplit(".", 1)
        if len(parts) < 2:
            continue
        parent_path = parts[0]
        # Find the task with this parent wbs_path
        for candidate in db_tasks:
            if candidate.wbs_path and str(candidate.wbs_path) == parent_path:
                parent_id = str(candidate.id)
                children_map.setdefault(parent_id, []).append(str(t.id))
                break

    summary_ids = set(children_map.keys())

    # Expand summary dependencies into leaf-level edges before CPM.
    leaf_tasks, expanded_deps = expand_summary_dependencies(sched_tasks, sched_deps, children_map)

    sched_project = SchedProject(
        id=project_id,
        name=db_project.name,
        start_date=db_project.start_date,
        tasks=leaf_tasks,
        dependencies=expanded_deps,
        calendar=sched_calendar,
    )

    _update(50, "Running CPM…")

    # Exceptions propagate to TaskRunTracker.__exit__, which marks the run FAILED
    # and broadcasts task_run_failed to connected clients.
    result = schedule(sched_project)

    _update(80, "Writing results…")

    # Build a map from task id string to computed CPM values.
    result_map = {t.id: t for t in result.tasks}

    # Compute summary task dates by rolling up from their leaf descendants.
    # Summary tasks are excluded from the CPM run, so we derive their dates
    # from min(early_start) and max(early_finish) of all descendant leaves.
    for sid in summary_ids:
        from trueppm_scheduler.engine import _collect_leaves

        leaves = _collect_leaves(sid, children_map)
        leaf_results = [result_map[lid] for lid in leaves if lid in result_map]
        if not leaf_results:
            continue

        es_dates = [t.early_start for t in leaf_results if t.early_start is not None]
        ef_dates = [t.early_finish for t in leaf_results if t.early_finish is not None]
        ls_dates = [t.late_start for t in leaf_results if t.late_start is not None]
        lf_dates = [t.late_finish for t in leaf_results if t.late_finish is not None]
        floats = [t.total_float for t in leaf_results if t.total_float is not None]

        if not es_dates or not ef_dates:
            continue

        # Create a synthetic result entry for the summary task
        summary_sched = SchedTask(
            id=sid,
            name=db_task_by_id[sid].name if sid in db_task_by_id else sid,
            duration=timedelta(days=0),
        )
        summary_sched.early_start = min(es_dates)
        summary_sched.early_finish = max(ef_dates)
        summary_sched.late_start = min(ls_dates) if ls_dates else summary_sched.early_start
        summary_sched.late_finish = max(lf_dates) if lf_dates else summary_sched.early_finish
        summary_sched.total_float = min(floats) if floats else timedelta(days=0)
        summary_sched.free_float = timedelta(days=0)
        summary_sched.is_critical = any(t.is_critical for t in leaf_results)
        result_map[sid] = summary_sched

    # Determine which tasks need their CPM results written back to the DB.
    #
    # When changed_task_ids is provided we attempt an incremental write: only
    # tasks in the affected subgraph (changed + downstream descendants) are
    # updated.  If the affected set exceeds _INCREMENTAL_THRESHOLD of all tasks
    # we fall back to a full write — the subgraph savings no longer justify the
    # BFS overhead.
    #
    # INTENTIONAL DESIGN: bulk_update bypasses VersionedModel.save(), so
    # server_version is NOT incremented for CPM field writes. This is correct:
    # CPM fields (early_start, is_critical, etc.) are read-only computed values
    # that the mobile client derives locally from the same scheduler. Bumping
    # server_version here would flood every connected mobile client with sync
    # deltas on every schedule recalc — including ones triggered by their own
    # edits. Do NOT change this to save() without understanding that consequence.
    write_all = True
    affected_ids: frozenset[str] = frozenset()
    if changed_task_ids is not None:
        affected_ids = _downstream_task_ids(project_id, changed_task_ids)
        ratio = len(affected_ids) / max(len(db_tasks), 1)
        if ratio <= _INCREMENTAL_THRESHOLD:
            write_all = False
            logger.info(
                "recalculate_schedule: incremental write — %d/%d tasks affected (%.0f%%)",
                len(affected_ids),
                len(db_tasks),
                ratio * 100,
            )
        else:
            logger.info(
                "recalculate_schedule: incremental threshold exceeded (%.0f%%) — full write",
                ratio * 100,
            )

    tasks_to_update: list[Task] = []
    for db_task in db_tasks:
        if not write_all and str(db_task.id) not in affected_ids:
            continue
        sched = result_map.get(str(db_task.id))
        if sched is None:
            continue
        db_task.early_start = sched.early_start
        db_task.early_finish = sched.early_finish
        db_task.late_start = sched.late_start
        db_task.late_finish = sched.late_finish
        db_task.total_float = sched.total_float.days if sched.total_float else None
        db_task.free_float = sched.free_float.days if sched.free_float else None
        db_task.is_critical = sched.is_critical
        # Belt-and-suspenders: milestones are single-point gates. Even if the
        # boundary normalisation above is bypassed (e.g. future direct CPM calls),
        # a milestone's finish must equal its start so client-facing rows never
        # render a date range.
        if db_task.is_milestone:
            db_task.early_finish = db_task.early_start
            db_task.late_finish = db_task.late_start
        # For summary tasks, overwrite duration with the calendar-day span so the
        # API returns a meaningful value for the Gantt duration column. The CPM
        # engine never reads duration on summary tasks (they are excluded from the
        # leaf pass), so updating this field has no effect on schedule correctness.
        if str(db_task.id) in summary_ids and db_task.early_start and db_task.early_finish:
            db_task.duration = max(1, (db_task.early_finish - db_task.early_start).days)
        tasks_to_update.append(db_task)

    from django.db import transaction

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    cpm_payload: dict[str, object] = {
        "project_finish": result.project_finish.isoformat(),
        "critical_path": result.critical_path,
    }

    # Per-task CPM date deltas (ADR-0091). Broadcast the tasks whose dates just moved so
    # collaborators' Gantt bars slide in real time, with no full re-fetch. Built from
    # tasks_to_update (already in scope, fields mutated in-memory) so it costs no query.
    # Best-effort, same tier as cpm_complete. Field names mirror SyncTaskSerializer so the
    # web client can splice the payload straight into its task cache (and a future mobile
    # client could too); the server_version carve-out above is preserved — this is an
    # optimization layer over the sync protocol, not a replacement for it. server_version
    # is intentionally NOT in the payload: clients splice these as optimistic CPM updates,
    # they are not a sync anchor (bulk_update bypasses VersionedModel.save(), ADR-0091).
    if len(tasks_to_update) <= CPM_DELTA_BROADCAST_CAP:
        delta_payload: dict[str, object] = {
            "count": len(tasks_to_update),
            "tasks": [
                {
                    "id": str(t.id),
                    "early_start": t.early_start.isoformat() if t.early_start else None,
                    "early_finish": t.early_finish.isoformat() if t.early_finish else None,
                    "late_start": t.late_start.isoformat() if t.late_start else None,
                    "late_finish": t.late_finish.isoformat() if t.late_finish else None,
                    "total_float": t.total_float,
                    "free_float": t.free_float,
                    "is_critical": t.is_critical,
                    "planned_start": t.planned_start.isoformat() if t.planned_start else None,
                    "duration": t.duration,
                }
                for t in tasks_to_update
            ],
        }
    else:
        # Too many moved tasks to ship economically — tell the client to re-fetch.
        delta_payload = {"count": len(tasks_to_update), "truncated": True}

    # Persist results and mark the outbox row done in a single transaction, and
    # defer the board broadcasts to on_commit (#896). Previously the bulk_update
    # and the two broadcasts ran in autocommit, *before* the ScheduleRequest
    # status update — a failure on that update (e.g. a lost DB connection) left
    # clients showing CPM dates that were never committed. Wrapping the writes in
    # one atomic block and registering the broadcasts with transaction.on_commit
    # means clients only ever see dates that actually persisted; a rollback
    # broadcasts nothing. Default-arg binding pins the payloads so the deferred
    # callbacks can't late-bind a mutated value.
    with transaction.atomic():
        Task.objects.bulk_update(
            tasks_to_update,
            [
                "early_start",
                "early_finish",
                "late_start",
                "late_finish",
                "total_float",
                "free_float",
                "is_critical",
                "duration",
            ],
        )

        # Mark the outbox row done so the drain task knows this project is clean.
        # Filter on status=dispatched to avoid racing with the drain during orphan
        # recovery (which resets rows back to pending).
        ScheduleRequest.objects.filter(
            project_id=project_id, status=ScheduleRequestStatus.DISPATCHED
        ).update(status=ScheduleRequestStatus.DONE)

        # Backwards-compat cpm_complete event for clients not yet on
        # task_run_completed, deferred to commit.
        def _broadcast_cpm_complete(
            pid: str = project_id, pay: dict[str, object] = cpm_payload
        ) -> None:
            broadcast_board_event(project_id=pid, event_type="cpm_complete", payload=pay)

        def _broadcast_dates(pid: str = project_id, pay: dict[str, object] = delta_payload) -> None:
            broadcast_board_event(project_id=pid, event_type="task_dates_updated", payload=pay)

        transaction.on_commit(_broadcast_cpm_complete)
        transaction.on_commit(_broadcast_dates)

    logger.info(
        "recalculate_schedule: updated %d tasks for project %s (finish=%s)",
        len(tasks_to_update),
        project_id,
        result.project_finish,
    )

    # Store CPM result summary for audit / frontend access.
    if tracker is not None:
        tracker.set_result(cpm_payload)  # type: ignore[attr-defined]

    # Dispatch schedule.recalculated webhook to external subscribers. Fired after
    # the transaction so subscribers are only notified of committed results.
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    dispatch_webhooks(
        project_id=project_id,
        event_type="schedule.recalculated",
        payload={"project": project_id, **cpm_payload},
    )
