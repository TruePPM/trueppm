"""Celery tasks for the scheduling app."""

from __future__ import annotations

import logging
import uuid
from datetime import date, timedelta
from typing import Any

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

    A full CPM recompute runs on every dispatch: the engine-level incremental
    recompute designed in ADR-0027 is tracked separately under #235 (0.5). The
    earlier API-layer write-back narrowing was removed in #1528 as unreachable
    dead code — no dispatch site ever supplied the changed-task set.

    Args:
        project_id: UUID string of the project to reschedule.
    """
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    try:
        with TaskRunTracker(
            self,
            project_id=project_id,
            task_name="scheduling.recalculate",
        ) as tracker:
            _run_schedule(project_id, tracker)
        # Stamp the successful CPM completion so the web Schedule view can show
        # the "recalculating" badge until the first post-import pass lands
        # (#1053). A bulk update avoids a save() + history row + server_version
        # bump for a non-domain timestamp.
        from django.utils import timezone

        from trueppm_api.apps.projects.models import Project

        Project.objects.filter(pk=project_id).update(recalculated_at=timezone.now())
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
    #
    # A blanket flip of every stale dispatched row back to pending is unsafe: if
    # the project already has a pending row (a fresh edit arrived after the row was
    # dispatched but before its task finished/died), resurrecting the dead row
    # creates a *second* pending row and violates the
    # schedule_request_one_pending_per_project partial-unique constraint — which
    # aborts the whole UPDATE, so no orphan is recovered and the drain wedges on
    # every tick (#1693). Because CPM is a full recompute, that existing pending
    # row already supersedes the dead dispatched one, so retire the dead row as
    # done rather than resurrecting it. Only stale dispatched rows with no
    # coexisting pending row are flipped back to pending for re-dispatch.
    projects_with_pending = set(
        ScheduleRequest.objects.filter(status=ScheduleRequestStatus.PENDING).values_list(
            "project_id", flat=True
        )
    )
    stale_dispatched = ScheduleRequest.objects.filter(
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at__lt=orphan_cutoff,
    )
    superseded = stale_dispatched.filter(project_id__in=projects_with_pending).update(
        status=ScheduleRequestStatus.DONE
    )
    recovered = stale_dispatched.exclude(project_id__in=projects_with_pending).update(
        status=ScheduleRequestStatus.PENDING, celery_task_id=""
    )
    if recovered:
        logger.warning("drain_schedule_queue: recovered %d orphaned dispatched row(s)", recovered)
    if superseded:
        logger.warning(
            "drain_schedule_queue: retired %d stale dispatched row(s) superseded by a pending row",
            superseded,
        )

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
    lock_key_template="purge_resolved_slip_conflicts",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="scheduling.purge_resolved_slip_conflicts",
)
def purge_resolved_slip_conflicts(self: object) -> None:
    """Delete cross-project slip conflicts 90 days past resolution (ADR-0120 D4).

    Runs nightly at 02:25 UTC. Removes ``CrossProjectSlipConflict`` rows whose
    acknowledgment or auto-resolution is older than 90 days; unresolved and
    unacknowledged rows are kept indefinitely (they are still live conflicts).
    Idempotent: a re-run deletes nothing new.
    """
    _do_purge_resolved_slip_conflicts()


def _do_purge_resolved_slip_conflicts() -> None:
    """Business logic for purge_resolved_slip_conflicts — extracted for testability."""
    from django.db.models import Q
    from django.utils import timezone

    from trueppm_api.apps.projects.models import CrossProjectSlipConflict

    cutoff = timezone.now() - timedelta(days=90)
    deleted, _ = CrossProjectSlipConflict.objects.filter(
        Q(acknowledged_at__lt=cutoff) | Q(resolved_at__lt=cutoff)
    ).delete()
    if deleted:
        logger.info("purge_resolved_slip_conflicts: deleted %d row(s)", deleted)


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

    Runs nightly at 02:20 UTC via Celery Beat. Keeps the most recent N
    ``MonteCarloRun`` rows per project, where N is the per-workspace-effective
    retention cap (ADR-0144, #1232) — no longer the global constant — so
    forecast-drift history stays bounded. No-ops for a project whose effective cap
    is ``None`` (Enterprise unlimited). Idempotent: rank-based delete is safe to run
    repeatedly.
    """
    _do_monte_carlo_run_purge()


def _do_monte_carlo_run_purge() -> None:
    """Business logic for purge_old_monte_carlo_runs — extracted for testability.

    Each project's retention cap is resolved per-workspace-effective (ADR-0144,
    #1232) via ``resolve_effective_mc_history`` rather than the global
    ``MC_HISTORY_CAP`` constant — a workspace/program/project may raise or lower it
    (clamped to MC_HISTORY_HARD_CAP in the resolver). For each project exceeding its
    own cap, delete every run older than its cap-th most recent. The candidate set
    is the projects whose total run count exceeds the global hard cap floor, so the
    common case (projects under the cap) does no delete work; the per-project cap is
    then applied exactly. A project whose effective cap is None (Enterprise
    unlimited) is skipped.
    """
    from django.db.models import Count

    from trueppm_api.apps.scheduling.forecast_history_settings import resolve_effective_mc_history
    from trueppm_api.apps.scheduling.models import MonteCarloRun

    # Candidate projects: any with more than one run. We can't pre-filter by a single
    # global cap because each project's effective cap may differ; resolving per
    # project below is bounded by the (small) set of projects that actually have
    # history.
    project_ids = (
        MonteCarloRun.objects.values("project_id")
        .annotate(n=Count("id"))
        .filter(n__gt=1)
        .values_list("project_id", flat=True)
    )

    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.workspace.models import Workspace

    # Load the workspace singleton once and thread it through every per-project
    # resolve. Workspace.load() is a get_or_create round-trip (not memoized), so
    # passing it in avoids a redundant workspace query per candidate project.
    workspace = Workspace.load()

    total_deleted = 0
    for project_id in list(project_ids):
        project = Project.objects.filter(pk=project_id).select_related("program").first()
        if project is None:
            continue
        cap: int | None = resolve_effective_mc_history(
            project, "mc_history_retention_cap", workspace=workspace
        )
        if cap is None:
            continue  # Enterprise unlimited: nothing to purge for this project.
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


@idempotent_task(
    lock_key_template="capture_daily_forecast_floor",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=110,
    time_limit=150,
    acks_late=True,
    reject_on_worker_lost=True,
    name="scheduling.capture_daily_forecast_floor",
)
def capture_daily_forecast_floor(self: object) -> None:
    """Guarantee ≥1 forecast snapshot per active project per day (ADR-0154, #388).

    Runs nightly at 00:30 UTC via Celery Beat. Captures a ``scheduled`` snapshot
    for every non-deleted, non-archived project that has no snapshot in the last
    24 h — covering quiet days with no recompute, and acting as the durability
    backstop that backfills any ``recompute`` capture missed by a broker blip or a
    worker death between commit and on_commit. Idempotent: a project already
    covered in the window is skipped.
    """
    _do_daily_forecast_floor()


def _do_daily_forecast_floor() -> None:
    """Business logic for capture_daily_forecast_floor — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.scheduling.models import ForecastSnapshotTrigger, ProjectForecastSnapshot
    from trueppm_api.apps.scheduling.services import safe_capture_forecast_snapshot

    cutoff = timezone.now() - timedelta(hours=24)
    # Projects already covered in the window — skip them with a single query rather
    # than letting the capture-path dedup absorb each one (dedup only skips when the
    # forecast is *unchanged*; the floor's intent is one row/day regardless).
    covered = set(
        ProjectForecastSnapshot.objects.filter(captured_at__gte=cutoff)
        .values_list("project_id", flat=True)
        .distinct()
    )
    project_ids = Project.objects.filter(is_deleted=False, is_archived=False).values_list(
        "id", flat=True
    )
    captured = 0
    for project_id in project_ids:
        if project_id in covered:
            continue
        safe_capture_forecast_snapshot(project_id, ForecastSnapshotTrigger.SCHEDULED)
        captured += 1
    if captured:
        logger.info("capture_daily_forecast_floor: captured %d snapshot(s)", captured)


@idempotent_task(
    lock_key_template="prune_forecast_snapshots",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=110,
    time_limit=150,
    acks_late=True,
    reject_on_worker_lost=True,
    name="scheduling.prune_forecast_snapshots",
)
def prune_forecast_snapshots(self: object) -> None:
    """Apply the tiered retention curve to project forecast snapshots (ADR-0154, #388).

    Runs nightly at 04:15 UTC via Celery Beat. Per ``settings.FORECAST_SNAPSHOT_RETENTION``:
    keep all rows younger than ``daily_days`` (default 90); keep one-per-ISO-week up
    to ``weekly_days`` (default 365); keep one-per-calendar-month beyond that (kept
    forever). The same logic is exposed as the ``prune_forecast_snapshots`` management
    command. Idempotent: re-running deletes nothing new.
    """
    _do_prune_forecast_snapshots()


def _do_prune_forecast_snapshots() -> int:
    """Business logic for prune_forecast_snapshots — extracted for testability.

    Returns the number of rows deleted. Scans each project's snapshots newest-first
    and keeps the first (newest) row in each retention bucket, so the freshest
    representative per day/week/month survives.
    """
    from django.conf import settings
    from django.utils import timezone

    from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot

    policy = getattr(settings, "FORECAST_SNAPSHOT_RETENTION", {})
    daily_days = int(policy.get("daily_days", 90))
    weekly_days = int(policy.get("weekly_days", 365))

    now = timezone.now()
    daily_cutoff = now - timedelta(days=daily_days)
    weekly_cutoff = now - timedelta(days=weekly_days)

    project_ids = ProjectForecastSnapshot.objects.values_list("project_id", flat=True).distinct()

    total_deleted = 0
    for project_id in list(project_ids):
        rows = (
            ProjectForecastSnapshot.objects.filter(project_id=project_id)
            .order_by("-captured_at")
            .values_list("id", "captured_at")
        )
        keep: set[uuid.UUID] = set()
        seen_weeks: set[tuple[int, int]] = set()
        seen_months: set[tuple[int, int]] = set()
        for row_id, captured_at in rows:
            if captured_at >= daily_cutoff:
                keep.add(row_id)  # Recent tier: keep every row.
            elif captured_at >= weekly_cutoff:
                iso = captured_at.isocalendar()
                key = (iso[0], iso[1])
                if key not in seen_weeks:
                    seen_weeks.add(key)
                    keep.add(row_id)  # Newest row in this ISO week.
            else:
                key = (captured_at.year, captured_at.month)
                if key not in seen_months:
                    seen_months.add(key)
                    keep.add(row_id)  # Newest row in this calendar month.

        deleted, _ = (
            ProjectForecastSnapshot.objects.filter(project_id=project_id)
            .exclude(id__in=keep)
            .delete()
        )
        total_deleted += deleted

    if total_deleted:
        logger.info("prune_forecast_snapshots: deleted %d row(s)", total_deleted)
    return total_deleted


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


_WRITEBACK_BATCH_SIZE = 500
"""Rows per ``bulk_update`` statement when persisting CPM results (#1529).

On PostgreSQL Django's ``bulk_batch_size`` defaults to ``len(objs)``, so an
unbatched write collapses every task into a single UPDATE built from per-field
``CASE WHEN pk=… THEN …`` chains (~17 params/row → ~85K interpolated values at 5K
tasks). psycopg3's client-side binding keeps this under the 65,535 protocol
ceiling, but the multi-MB SQL string is slow to build, parse, and plan and lands
on the <500 ms schedule-trigger budget. Batching bounds each statement's size
without changing the result — the whole writeback still runs in one transaction."""

CPM_DELTA_BROADCAST_CAP = 500
"""Max moved-task count to ship as per-task ``task_dates_updated`` deltas (ADR-0091).

Above this the WS frame grows large enough that a client-side full re-fetch is cheaper
than splicing, so we emit a ``truncated`` signal instead and let the client invalidate.
A 500-task payload is ≈60 KB. Every recalc is a full write-back, so the truncated
branch is reached whenever a project carries more than ~500 schedulable tasks.
"""


# Per-task schedule-shift activity events (ADR-0207, #1604). The CPM writeback
# persists only the history-excluded early_*/late_* fields via bulk_update, so a
# recompute leaves no per-task audit row; these helpers emit one instead.
def _active_baseline_finishes(project_ids: list[Any]) -> dict[str, tuple[str, date]]:
    """Return ``{task_id: (baseline_id, baseline_finish)}`` for each project's active baseline.

    One entry per snapshotted task with a non-null finish, drawn from the single
    active baseline per project (enforced by a DB unique constraint). Two indexed
    queries; empty and cheap when no project in ``project_ids`` has an active
    baseline, so the drift check adds no cost to the common no-baseline recalc.
    """
    from trueppm_api.apps.projects.models import Baseline, BaselineTask

    baseline_ids = list(
        Baseline.objects.filter(
            project_id__in=project_ids, is_active=True, is_deleted=False
        ).values_list("id", flat=True)
    )
    if not baseline_ids:
        return {}
    finishes: dict[str, tuple[str, date]] = {}
    for row in BaselineTask.objects.filter(
        baseline_id__in=baseline_ids, finish__isnull=False
    ).values("task_id", "finish", "baseline_id"):
        finish = row["finish"]
        if finish is None:  # narrows the nullable DateField for mypy; excluded by the filter
            continue
        finishes[str(row["task_id"])] = (str(row["baseline_id"]), finish)
    return finishes


def _build_schedule_shift_events(
    tasks_to_update: list[Any],
    old_dates: dict[str, tuple[Any, Any, Any, Any]],
    baseline_finishes: dict[str, tuple[str, date]],
) -> list[Any]:
    """Build ``TaskActivityEvent`` rows for CPM recomputes and baseline-drift crossings.

    ``old_dates`` maps a task id to its ``(early_start, early_finish, late_start,
    late_finish)`` captured *before* the writeback loop overwrote the in-memory Task
    fields, so a move is detected by comparing against the now-mutated values. A
    ``cpm_recalculated`` row is emitted for every task whose four CPM dates changed;
    a ``baseline_drift_detected`` row is emitted only on the transition *into* drift
    (was within baseline, now past it) so a persistently-drifted task does not
    re-fire every recalc. Actor is null — CPM runs in Celery with no request user.

    Each ``cpm_recalculated`` row also carries a per-project recalc summary
    (#1948): ``recalc_moved_count`` (how many of the project's tasks moved),
    ``recalc_finish`` (the project's latest early_finish after the pass), and
    ``recalc_finish_delta_days`` (signed slip/pull-in of that finish). These are
    grouped strictly per ``project_id`` because the helper is shared by the
    program-scoped writeback, where a program-wide count would leak cross-project
    scope (see the aggregate block below).
    """
    from trueppm_api.apps.projects.models import TaskActivityEvent

    def _iso(value: Any) -> str | None:
        return value.isoformat() if value is not None else None

    # Per-project aggregates that denormalize a recalc-wide summary onto every
    # moved task's ``cpm_recalculated`` row (#1948): how many tasks moved and
    # where the project's finish landed. WHY grouped per ``project_id`` and not
    # globally: this helper is shared by the program-scoped writeback
    # (``schedule_program_and_writeback`` ~L1240) where ``tasks_to_update`` spans
    # several member projects in one call. A single program-wide count stamped
    # onto every row would leak one project's schedule scope onto another
    # project's activity row and violate the OSS project-isolation boundary
    # (enterprise-check constraint #1) — so each row carries only *its own*
    # project's aggregate. The per-task drawer reads a single task's events, so
    # this recalc-wide count cannot be reconstructed client-side; it must be
    # denormalized here at emit time.
    moved_by_project: dict[Any, int] = {}
    new_finish_by_project: dict[Any, date] = {}
    prior_finish_by_project: dict[Any, date] = {}
    for t in tasks_to_update:
        pid = t.project_id
        # New finish: latest early_finish across every task in this project,
        # moved or not (an unmoved late task still defines where finish sits).
        if t.early_finish is not None:
            cur_new = new_finish_by_project.get(pid)
            if cur_new is None or t.early_finish > cur_new:
                new_finish_by_project[pid] = t.early_finish
        old = old_dates.get(str(t.id))
        if old is None:
            continue
        old_es, old_ef, old_ls, old_lf = old
        if old_ef is not None:
            cur_prior = prior_finish_by_project.get(pid)
            if cur_prior is None or old_ef > cur_prior:
                prior_finish_by_project[pid] = old_ef
        if (
            old_es != t.early_start
            or old_ef != t.early_finish
            or old_ls != t.late_start
            or old_lf != t.late_finish
        ):
            moved_by_project[pid] = moved_by_project.get(pid, 0) + 1

    def _finish_delta(pid: Any) -> int | None:
        """Signed day delta of the project finish (+ = slip later, - = pulled in).

        ``None`` when either side is missing — most importantly the first-ever
        recalc, where no prior early_finish exists for any task.
        """
        new_f = new_finish_by_project.get(pid)
        prior_f = prior_finish_by_project.get(pid)
        if new_f is None or prior_f is None:
            return None
        return (new_f - prior_f).days

    events: list[Any] = []
    for t in tasks_to_update:
        tid = str(t.id)
        old = old_dates.get(tid)
        if old is None:
            continue
        old_es, old_ef, old_ls, old_lf = old
        if (
            old_es != t.early_start
            or old_ef != t.early_finish
            or old_ls != t.late_start
            or old_lf != t.late_finish
        ):
            events.append(
                TaskActivityEvent(
                    task_id=t.id,
                    actor=None,
                    event_type="cpm_recalculated",
                    detail={
                        "early_start": {"from": _iso(old_es), "to": _iso(t.early_start)},
                        "early_finish": {"from": _iso(old_ef), "to": _iso(t.early_finish)},
                        "late_start": {"from": _iso(old_ls), "to": _iso(t.late_start)},
                        "late_finish": {"from": _iso(old_lf), "to": _iso(t.late_finish)},
                        "total_float": t.total_float,
                        "is_critical": t.is_critical,
                        # Per-project recalc summary (#1948) — see aggregate block above.
                        "recalc_moved_count": moved_by_project.get(t.project_id, 0),
                        "recalc_finish": _iso(new_finish_by_project.get(t.project_id)),
                        "recalc_finish_delta_days": _finish_delta(t.project_id),
                    },
                )
            )
        baseline = baseline_finishes.get(tid)
        if baseline is not None:
            baseline_id, baseline_finish = baseline
            was_drifted = old_ef is not None and old_ef > baseline_finish
            is_drifted = t.early_finish is not None and t.early_finish > baseline_finish
            if is_drifted and not was_drifted:
                events.append(
                    TaskActivityEvent(
                        task_id=t.id,
                        actor=None,
                        event_type="baseline_drift_detected",
                        detail={
                            "baseline_id": baseline_id,
                            "baseline_finish": baseline_finish.isoformat(),
                            "early_finish": t.early_finish.isoformat(),
                            "drift_days": (t.early_finish - baseline_finish).days,
                        },
                    )
                )
    return events


def _build_children_map(db_tasks: list[Any]) -> dict[str, list[str]]:
    """Map each summary task's id to its direct children's ids via the WBS hierarchy.

    A task is a *summary* when another task's ``wbs_path`` is a direct child of its
    own (e.g. ``1.2`` is a direct child of ``1``). Tasks are indexed by ``wbs_path``
    in a single pass so each task resolves its parent with one dict lookup — O(N)
    total. The former inline construction scanned ``db_tasks`` for every task to find
    its parent by string equality (O(N^2)), the one superlinear step left in recalc;
    at 5k+ tasks it began to dominate the "Building schedule model" phase (#1011).

    ``setdefault`` makes the first task in ``db_tasks`` order win a duplicate
    ``wbs_path``, exactly mirroring the prior loop's first-match-and-break semantics,
    and children are appended in ``db_tasks`` order — so the result is byte-for-byte
    identical to the O(N^2) version it replaces.
    """
    id_by_wbs_path: dict[str, str] = {}
    for t in db_tasks:
        if t.wbs_path:
            id_by_wbs_path.setdefault(str(t.wbs_path), str(t.id))

    children_map: dict[str, list[str]] = {}
    for t in db_tasks:
        if not t.wbs_path:
            continue
        parts = str(t.wbs_path).rsplit(".", 1)
        if len(parts) < 2:
            continue
        parent_id = id_by_wbs_path.get(parts[0])
        if parent_id is not None:
            children_map.setdefault(parent_id, []).append(str(t.id))
    return children_map


def _run_schedule(
    project_id: str,
    tracker: object = None,
) -> None:
    """Load tasks/dependencies, run CPM, bulk_update results, broadcast completion.

    CPM runs on the full project and every affected task's results are written
    back. The engine-level incremental recompute (recompute only the changed
    subgraph) is tracked under #235 (0.5, ADR-0027).

    Args:
        project_id: UUID string of the project to schedule.
        tracker: Optional TaskRunTracker for progress reporting.
    """
    from trueppm_scheduler.engine import expand_summary_dependencies, schedule
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject

    from trueppm_api.apps.observability.otel import attributes
    from trueppm_api.apps.projects.models import (
        Dependency,
        EstimationMode,
        Project,
        Task,
        TaskActivityEvent,
        TaskStatus,
        TaskType,
    )
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar
    from trueppm_api.apps.scheduling.services import (
        apply_summary_rollups,
        build_sched_tasks,
    )
    from trueppm_api.apps.scheduling.telemetry import cpm_span

    def _update(pct: int, msg: str) -> None:
        if tracker is not None:
            tracker.update(pct, msg)  # type: ignore[attr-defined]

    _update(10, "Loading project data…")

    try:
        db_project = (
            Project.objects.select_related("calendar")
            # tasks__sprint: build_sched_tasks reads each task's sprint.start_date
            # for the ADR-0168 sprint-window floor; prefetch it to avoid an N+1.
            # calendar__exceptions + calendar_layers__calendar__exceptions:
            # compose_project_calendar reads every CalendarException row of the
            # base calendar (#1491) AND of every applied overlay (#906); prefetch
            # both to avoid an N+1.
            .prefetch_related(
                "tasks",
                "tasks__sprint",
                "tasks__predecessors",
                "calendar__exceptions",
                "calendar_layers__calendar__exceptions",
            )
            .get(pk=project_id)
        )
    except Project.DoesNotExist:
        logger.warning("recalculate_schedule: project %s not found, skipping", project_id)
        return

    # ADR-0120 D3: if this project belongs to a program that has ≥1 accepted
    # cross-project edge, a single-project CPM would compute program-FALSE floats
    # and criticality (it cannot see the cross-boundary demand). Escalate to the
    # merged program-scoped pass and stop here, *before* any write — the program
    # run is the sole writer for every member project while escalation holds, so no
    # stale single-project dates are ever persisted. The DISPATCHED outbox row is
    # left for the program run to mark done.
    if _escalate_to_program(project_id, db_project.program_id):
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
    #
    # status=BACKLOG and soft-deleted tombstones are excluded so the deterministic CPM
    # feed matches CommittedTaskManager exactly (#1772). Monte Carlo already reads from
    # Task.committed; feeding CPM from the unfiltered manager let backlog ideas and
    # deleted rows into the network, so grooming the backlog could move the deterministic
    # critical path and the two engines could structurally disagree on the Overview page.
    # Filtered in Python so the prefetch cache from the queryset above is reused.
    db_tasks = [
        t
        for t in db_project.tasks.all()
        if not t.is_recurring
        and t.type != TaskType.EPIC
        and t.status != TaskStatus.BACKLOG
        and not t.is_deleted
    ]
    if not db_tasks:
        logger.info("recalculate_schedule: project %s has no tasks, skipping", project_id)
        return

    _update(25, "Building schedule model…")

    # Build a trueppm_scheduler.Calendar from the OVERLAY of the project's applied
    # calendars — base + holiday/shutdown overlays — as one composed non-working
    # mask (#906, ADR-0251). Routes through the shared composer so the CPM pass,
    # Monte Carlo, and program scheduling can never drift on which calendars apply.
    sched_calendar = compose_project_calendar(db_project)

    # Convert Django Task objects to scheduler dataclasses through the shared
    # converter (ADR-0132), the single source of truth the Monte Carlo endpoint
    # also uses — so progress/actual fields and milestone normalisation can never
    # drift between the two engines (the cause of #1185). The suggest_approve gate
    # is a no-op for the deterministic CPM pass (which ignores PERT) but is passed
    # for parity so both paths run identical code.
    sched_tasks = build_sched_tasks(
        db_tasks,
        suggest_approve=db_project.estimation_mode == EstimationMode.SUGGEST_APPROVE,
    )

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
    children_map = _build_children_map(db_tasks)
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
        # The stored plan honors recorded actuals (completed tasks pin, in-progress
        # tasks use remaining duration) always; it only floors not-started work at
        # the data date when a PM has set one explicitly. Null status_date keeps the
        # deterministic schedule showing earliest-possible dates rather than drifting
        # every recalc — the Monte Carlo forecast is what defaults to "today"
        # (ADR-0132).
        status_date=db_project.status_date,
    )

    _update(50, "Running CPM…")

    # Exceptions propagate to TaskRunTracker.__exit__, which marks the run FAILED
    # and broadcasts task_run_failed to connected clients. The manual CPM span
    # (#709) times the engine call and records the graph shape; it is a no-op span
    # unless OTel export is configured. Runs inside the enqueued Celery task span,
    # so the trace links the recompute back to the request that triggered it.
    with cpm_span(project_id, dependency_count=len(sched_deps)) as _cpm_span:
        result = schedule(sched_project)
        _cpm_span.set_attribute(attributes.SCHEDULE_TASK_COUNT, len(result.tasks))
        _cpm_span.set_attribute(attributes.SCHEDULE_CRITICAL_COUNT, len(result.critical_path))

    _update(80, "Writing results…")

    # Build a map from task id string to computed CPM values.
    result_map = {t.id: t for t in result.tasks}

    # Compute summary task dates by rolling up from their leaf descendants
    # (ADR-0105) via the shared helper, so this single-project write-back and the
    # program-scoped write-back derive summary dates through identical code.
    apply_summary_rollups(result_map, summary_ids, children_map, db_task_by_id)

    # Write CPM results back for every task the engine returned.
    #
    # INTENTIONAL DESIGN: bulk_update bypasses VersionedModel.save(), so
    # server_version is NOT incremented for CPM field writes. This is correct:
    # CPM fields (early_start, is_critical, etc.) are read-only computed values
    # that the mobile client derives locally from the same scheduler. Bumping
    # server_version here would flood every connected mobile client with sync
    # deltas on every schedule recalc — including ones triggered by their own
    # edits. Do NOT change this to save() without understanding that consequence.
    tasks_to_update: list[Task] = []
    # Snapshot each task's CPM dates before the writeback overwrites them, so
    # _build_schedule_shift_events can tell which tasks actually moved (ADR-0207).
    old_cpm_dates: dict[str, tuple[Any, Any, Any, Any]] = {}
    for db_task in db_tasks:
        sched = result_map.get(str(db_task.id))
        if sched is None:
            continue
        old_cpm_dates[str(db_task.id)] = (
            db_task.early_start,
            db_task.early_finish,
            db_task.late_start,
            db_task.late_finish,
        )
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
    # ADR-0120 D3 pre-write guard: a cross-project edge may have been accepted
    # while this single-project CPM was running. Re-check the escalation predicate
    # immediately before the write — if the program now has an accepted cross edge,
    # discard this (now program-FALSE) single-project result and hand off to the
    # program pass rather than persisting stale single-project dates. Cheap EXISTS.
    if _escalate_to_program(project_id, db_project.program_id):
        return

    # Per-task schedule-shift activity events (ADR-0207, #1604), built from the
    # mutated in-memory tasks and the project's active baseline. Written inside the
    # same atomic block as the writeback so they commit or roll back with it.
    schedule_shift_events = _build_schedule_shift_events(
        tasks_to_update, old_cpm_dates, _active_baseline_finishes([project_id])
    )

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
            batch_size=_WRITEBACK_BATCH_SIZE,
        )

        if schedule_shift_events:
            TaskActivityEvent.objects.bulk_create(
                schedule_shift_events, batch_size=_WRITEBACK_BATCH_SIZE
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

        # Capture a project-grain forecast snapshot for drift history (ADR-0154,
        # #388). Strictly post-commit and best-effort: a capture failure must never
        # roll back the CPM write above. Any miss is backfilled by the daily-floor
        # task, so we do not need an outbox here.
        def _capture_forecast(pid: str = project_id) -> None:
            from trueppm_api.apps.scheduling.models import ForecastSnapshotTrigger
            from trueppm_api.apps.scheduling.services import safe_capture_forecast_snapshot

            safe_capture_forecast_snapshot(pid, ForecastSnapshotTrigger.RECOMPUTE)

        transaction.on_commit(_capture_forecast)

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


# ---------------------------------------------------------------------------
# Program-scoped CPM dispatch pass — ADR-0120 D3 (#1117)
# ---------------------------------------------------------------------------


def _escalate_to_program(project_id: str, program_id: object) -> bool:
    """Dispatch the program-scoped pass instead of a single-project one, if needed.

    Returns ``True`` when the project's program has ≥1 accepted cross-project edge
    (ADR-0120 D3) and a ``recalculate_program_schedule`` was dispatched (best
    effort) — the caller must then return *without* writing single-project results,
    because a single-project CPM cannot see the cross-boundary demand and would
    persist program-FALSE floats/criticality. ``False`` keeps today's per-project
    path. If the dispatch itself fails (broker down) the outbox row stays
    DISPATCHED and the 10-minute orphan sweep re-escalates it — so this never
    silently drops the recompute.
    """
    if program_id is None:
        return False
    from trueppm_api.apps.projects.program_schedule import program_has_accepted_cross_edges

    if not program_has_accepted_cross_edges(program_id):
        return False
    try:
        recalculate_program_schedule.delay(str(program_id))
    except Exception:
        logger.exception(
            "recalculate_schedule: could not dispatch program pass for program %s "
            "— orphan recovery will re-escalate within 10 min",
            program_id,
        )
    return True


@idempotent_task(
    lock_key_template="schedule_lock:program:{0}",
    lock_ttl=300,
    on_contention="queue",
    queue_countdown=10,
    max_queue_attempts=30,
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
def recalculate_program_schedule(self: object, program_id: str) -> None:
    """Run the merged, program-true CPM for one program and persist it (ADR-0120 D3).

    Escalated to from ``recalculate_schedule`` whenever a member project's program
    holds ≥1 accepted cross-project edge. It merges every member project's tasks
    and every accepted cross edge into one engine graph (the shared
    ``gather_program_schedule``), runs CPM once, writes program-true CPM fields back
    to every member project, fans the ``cpm_complete`` / ``task_dates_updated``
    broadcasts out to each member project's board channel (there is no program WS
    channel in 0.3 — the program view subscribes per member project), upserts any
    D4 sprint-boundary conflicts, and coalesces every member project's outbox row.

    Idempotent: a pure recompute, safe to run twice. ``schedule_lock:program:{id}``
    serializes program runs; ``max_queue_attempts`` is sized so contenders ride out
    a held lock rather than dropping, and the outbox orphan sweep is the backstop on
    a crash. The lock namespace is disjoint from the per-project ``schedule_lock:{id}``,
    but a per-project task can never *write* while escalation holds (it self-aborts
    at the pre-write guard), so the two never produce a torn write.
    """
    _run_program_schedule(program_id)


def _member_cpm_delta(project_tasks: list[Any]) -> dict[str, object]:
    """Build one project's ``task_dates_updated`` delta payload (ADR-0091 shape).

    Mirrors the single-project delta exactly so a web client can splice program-pass
    results into its task cache the same way; above ``CPM_DELTA_BROADCAST_CAP`` it
    emits a ``truncated`` signal and lets the client re-fetch.
    """
    if len(project_tasks) > CPM_DELTA_BROADCAST_CAP:
        return {"count": len(project_tasks), "truncated": True}
    return {
        "count": len(project_tasks),
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
            for t in project_tasks
        ],
    }


_PROGRAM_WRITE_FIELDS = [
    "early_start",
    "early_finish",
    "late_start",
    "late_finish",
    "total_float",
    "free_float",
    "is_critical",
    "duration",
]


def _run_program_schedule(program_id: str) -> None:
    """Gather, run, and persist the program-true schedule for ``program_id``.

    Extracted from the Celery task for testability — exercised directly by the
    program-pass tests without a broker.
    """
    from django.db import transaction
    from django.utils import timezone

    from trueppm_api.apps.projects.models import Program, Project, Task, TaskActivityEvent
    from trueppm_api.apps.projects.program_schedule import gather_program_schedule
    from trueppm_api.apps.projects.slip_conflict import detect_and_upsert_slip_conflicts
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
    from trueppm_api.apps.scheduling.services import apply_summary_rollups
    from trueppm_api.apps.sync.broadcast import broadcast_board_event
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    try:
        program = Program.objects.get(pk=program_id, is_deleted=False)
    except Program.DoesNotExist:
        logger.warning("recalculate_program_schedule: program %s not found, skipping", program_id)
        return

    member_ids = list(
        Project.objects.filter(program_id=program_id, is_deleted=False).values_list("id", flat=True)
    )
    if not member_ids:
        return

    # CLAIM before reading data: capture exactly the member outbox rows that are
    # already DISPATCHED. Only these row ids are marked DONE at the end, so a row
    # dispatched *after* this point (a concurrent edit while we run) is never
    # swallowed — it lands a fresh row and is serviced by the next pass.
    claimed_ids = list(
        ScheduleRequest.objects.filter(
            project_id__in=member_ids, status=ScheduleRequestStatus.DISPATCHED
        ).values_list("id", flat=True)
    )

    graph = gather_program_schedule(program, enforce_max=False)

    now = timezone.now()
    tasks_to_update: list[Task] = []
    # Snapshot CPM dates before overwrite, for the schedule-shift events (ADR-0207).
    old_cpm_dates: dict[str, tuple[Any, Any, Any, Any]] = {}
    if graph.result is not None:
        result_map = graph.result_map
        # Roll summary dates up from leaves through the shared helper (parity with
        # the single-project write-back).
        summary_ids = graph.summary_ids
        apply_summary_rollups(result_map, summary_ids, graph.children_map, graph.db_task_by_id)
        # Full write-back across every member project (the program pass is coarse;
        # incremental subgraph writes are a later optimization). Field assignment
        # mirrors _run_schedule exactly, including the milestone single-point
        # normalisation and the summary calendar-day duration.
        for db_task in graph.db_task_by_id.values():
            sched = result_map.get(str(db_task.id))
            if sched is None:
                continue
            old_cpm_dates[str(db_task.id)] = (
                db_task.early_start,
                db_task.early_finish,
                db_task.late_start,
                db_task.late_finish,
            )
            db_task.early_start = sched.early_start
            db_task.early_finish = sched.early_finish
            db_task.late_start = sched.late_start
            db_task.late_finish = sched.late_finish
            db_task.total_float = sched.total_float.days if sched.total_float else None
            db_task.free_float = sched.free_float.days if sched.free_float else None
            db_task.is_critical = sched.is_critical
            if db_task.is_milestone:
                db_task.early_finish = db_task.early_start
                db_task.late_finish = db_task.late_start
            if str(db_task.id) in summary_ids and db_task.early_start and db_task.early_finish:
                db_task.duration = max(1, (db_task.early_finish - db_task.early_start).days)
            tasks_to_update.append(db_task)

    # Group moved tasks by project for the per-project broadcasts.
    by_project: dict[object, list[Task]] = {}
    for t in tasks_to_update:
        by_project.setdefault(t.project_id, []).append(t)

    # Program-true critical path restricted to each project (clients consuming a
    # project's cpm_complete expect that project's critical ids).
    crit_order = list(graph.result.critical_path) if graph.result is not None else []

    # Per-task schedule-shift activity events across every member project (ADR-0207),
    # keyed off each project's own active baseline for the drift crossings.
    schedule_shift_events = _build_schedule_shift_events(
        tasks_to_update, old_cpm_dates, _active_baseline_finishes(member_ids)
    )

    with transaction.atomic():
        if tasks_to_update:
            Task.objects.bulk_update(
                tasks_to_update, _PROGRAM_WRITE_FIELDS, batch_size=_WRITEBACK_BATCH_SIZE
            )

        if schedule_shift_events:
            TaskActivityEvent.objects.bulk_create(
                schedule_shift_events, batch_size=_WRITEBACK_BATCH_SIZE
            )

        # Coalesce: mark exactly the claimed member outbox rows done (DISPATCHED →
        # DONE). Filtering on DISPATCHED avoids racing the drain's orphan recovery.
        if claimed_ids:
            ScheduleRequest.objects.filter(
                id__in=claimed_ids, status=ScheduleRequestStatus.DISPATCHED
            ).update(status=ScheduleRequestStatus.DONE)

        # Stamp recalculated_at on every member project so each project's Schedule
        # view clears its "recalculating" badge (#1053), bulk to skip history.
        Project.objects.filter(pk__in=member_ids).update(recalculated_at=now)

        # D4 sprint-boundary firewall: detect and upsert cross-project slip
        # conflicts in the same transaction as the write-back, so a conflict is
        # never visible against dates that did not commit.
        if graph.result is not None:
            detect_and_upsert_slip_conflicts(graph)

        # Per-project broadcasts + forecast capture, deferred to commit (#896) so
        # clients only ever see dates that persisted. Default-arg binding pins each
        # project's payload against late mutation.
        for p in graph.member_projects:
            pid = str(p.id)
            project_tasks = by_project.get(p.id, [])
            # The project's full program-true critical path — every critical task in
            # this project, NOT just the ones whose dates moved this pass (a client
            # that replaces its critical-path state on cpm_complete must get the whole
            # set, matching the single-project _run_schedule which ships the full path).
            project_crit = [
                tid
                for tid in crit_order
                if tid in graph.db_task_by_id and graph.db_task_by_id[tid].project_id == p.id
            ]
            project_finish = max(
                (t.early_finish for t in project_tasks if t.early_finish is not None),
                default=None,
            )
            cpm_payload: dict[str, object] = {
                "project_finish": project_finish.isoformat() if project_finish else None,
                "critical_path": project_crit,
            }
            delta_payload = _member_cpm_delta(project_tasks)

            def _cpm_complete(pid: str = pid, pay: dict[str, object] = cpm_payload) -> None:
                broadcast_board_event(project_id=pid, event_type="cpm_complete", payload=pay)

            def _dates(pid: str = pid, pay: dict[str, object] = delta_payload) -> None:
                broadcast_board_event(project_id=pid, event_type="task_dates_updated", payload=pay)

            def _capture(pid: str = pid) -> None:
                from trueppm_api.apps.scheduling.models import ForecastSnapshotTrigger
                from trueppm_api.apps.scheduling.services import safe_capture_forecast_snapshot

                safe_capture_forecast_snapshot(pid, ForecastSnapshotTrigger.RECOMPUTE)

            transaction.on_commit(_cpm_complete)
            transaction.on_commit(_dates)
            transaction.on_commit(_capture)

    logger.info(
        "recalculate_program_schedule: program %s — %d member project(s), %d task(s) updated",
        program_id,
        len(member_ids),
        len(tasks_to_update),
    )

    # schedule.recalculated webhook per member project, after commit.
    for p in graph.member_projects:
        pid = str(p.id)
        project_tasks = by_project.get(p.id, [])
        project_finish = max(
            (t.early_finish for t in project_tasks if t.early_finish is not None),
            default=None,
        )
        dispatch_webhooks(
            project_id=pid,
            event_type="schedule.recalculated",
            payload={
                "project": pid,
                "project_finish": project_finish.isoformat() if project_finish else None,
            },
        )
