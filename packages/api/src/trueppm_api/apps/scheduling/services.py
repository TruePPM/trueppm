"""Service layer for scheduling outbox operations.

This module is the canonical home for ``enqueue_recalculate`` — the function
that writes a ``ScheduleRequest`` outbox row and attempts an immediate
best-effort Celery dispatch.  It lives in the ``scheduling`` app because it
directly manages ``ScheduleRequest``, which is owned by that app.

It also owns ``compute_velocity_suggestions`` — the sprint-close hook that
generates ``VelocitySuggestion`` rows from rolling team velocity (ADR-0065).

Call sites:
  - ``projects.views`` — task/dependency mutations (via ``transaction.on_commit``)
  - ``scheduling.views`` — manual trigger endpoint (direct call, inside
    ``ATOMIC_REQUESTS`` transaction)
  - ``msproject.tasks`` — post-import recalculation (direct call, Celery task
    has already committed its writes)
  - ``projects.tasks.close_sprint`` — calls ``compute_velocity_suggestions``
    inside the same atomic block as the SPRINT_CLOSED ScheduleRequest.
"""

from __future__ import annotations

import logging
import statistics
import uuid
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import IntegrityError, transaction

from trueppm_api.apps.scheduling.models import ScheduleRequestReason

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Calendar, Sprint
    from trueppm_api.apps.scheduling.models import MonteCarloRun

logger = logging.getLogger(__name__)

# Minimum number of prior closed sprints required before any velocity
# suggestion is generated. Three sprints is the smallest sample that yields a
# stable rolling average; below that the suggestion is noise and would erode
# PM trust in the surface.
MIN_CLOSED_SPRINTS_FOR_SUGGESTION = 3

# Rolling window for team_velocity_per_day. ADR-0065 picks six sprints as the
# balance between responsiveness to a real velocity shift and smoothing of
# one-off scope churn.
VELOCITY_ROLLING_WINDOW = 6


def enqueue_recalculate(
    project_id: str,
    reason: ScheduleRequestReason = ScheduleRequestReason.TASK_CHANGE,
) -> None:
    """Insert a ScheduleRequest outbox row and attempt immediate dispatch.

    Safe to call from:
      - ``transaction.on_commit()`` callbacks (HTTP request context)
      - Celery task bodies (no ambient transaction; ``atomic()`` opens its own)

    The ``reason`` is recorded on the outbox row purely for forensics — it does
    not change dispatch behavior. When the same project already has a PENDING
    row, the existing row's reason is preserved (whatever triggered the queue
    first wins) so debugging "why did this recalc fire?" still points at the
    initial cause rather than the last edit to pile on.

    If a pending row already exists for the project we adopt it — coalescing
    every edit that happened while it was waiting into a single CPM run — and
    still attempt the immediate dispatch.  Without this, a stranded pending
    row (e.g. from an earlier broker outage) would silently swallow every
    subsequent edit until ``drain_schedule_queue`` ran, which is the failure
    mode that produced #314.

    If the broker is unavailable the row is left PENDING and
    ``drain_schedule_queue`` picks it up within 30 seconds.
    """
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus

    req: ScheduleRequest
    try:
        with transaction.atomic():
            req = ScheduleRequest.objects.create(project_id=project_id, reason=reason)
    except IntegrityError:
        # A pending row already exists. Adopt it instead of returning — the
        # existing row may be stranded (the request that created it failed to
        # dispatch, e.g. broker outage) and every subsequent edit will pile up
        # on it. Re-dispatching it now coalesces all those edits into a single
        # CPM run with the latest data.
        existing = ScheduleRequest.objects.filter(
            project_id=project_id,
            status=ScheduleRequestStatus.PENDING,
        ).first()
        if existing is None:
            # Race: row transitioned out of PENDING between insert + lookup.
            # The other writer already dispatched it; nothing to do.
            return
        req = existing

    # Best-effort immediate dispatch — reduces recalculation latency when the
    # broker is healthy.  Failure here is not fatal; the row stays PENDING.
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    try:
        result = recalculate_schedule.delay(project_id)
    except Exception:
        # Use logger.exception so the broker error and stack trace are visible.
        # A previous regression (#314) silently swallowed `OperationalError:
        # Connection refused` here for weeks because logger.warning hid the
        # cause — the cascade quietly stopped firing for every dependency edit.
        logger.exception(
            "enqueue_recalculate: could not immediately dispatch for project %s "
            "— drain task will pick it up within 30 s",
            project_id,
        )
        return

    from django.utils import timezone

    # Guard the PENDING→DISPATCHED transition with a savepoint: another row for
    # this project may already be DISPATCHED (stranded by a missing worker — the
    # CI integration env, or a Celery outage in prod) and the partial unique
    # index `schedule_request_one_dispatched_per_project` will reject the
    # update. Treat that as the same situation as a broker outage: leave the
    # row PENDING and let `drain_schedule_queue` coalesce on the next tick.
    try:
        with transaction.atomic():
            ScheduleRequest.objects.filter(id=req.id, status=ScheduleRequestStatus.PENDING).update(
                status=ScheduleRequestStatus.DISPATCHED,
                celery_task_id=result.id,
                dispatched_at=timezone.now(),
            )
    except IntegrityError:
        logger.warning(
            "enqueue_recalculate: project %s already has a DISPATCHED outbox row "
            "— leaving new request PENDING for drain_schedule_queue to coalesce",
            project_id,
        )


def redispatch_dead_lettered_task(
    task_name: str,
    args: list[Any] | tuple[Any, ...],
    kwargs: dict[str, Any],
    countdown: int = 0,
) -> str:
    """Re-enqueue a dead-lettered Celery task, optionally after a backoff.

    The engine boundary for the requeue workflow (ADR-0210): the
    ``scheduling.requeue_failed_task`` consumer activity calls this rather than
    importing ``celery`` itself (ADR-0080 §E consumer import discipline). By the
    time execution reaches here the requeue has already round-tripped through the
    durable workflow outbox, so this is the final best-effort hop that puts the
    original task back on the broker.

    ``countdown`` is the operator-chosen backoff in seconds, applied as a Celery
    ``countdown`` (best-effort, broker-side — ADR-0210 §2). ``0`` means dispatch
    immediately. Returns the Celery ``AsyncResult`` id of the re-dispatched task so
    the workflow can record it in history.
    """
    from celery import current_app

    async_result = current_app.send_task(
        task_name,
        args=list(args) if args else [],
        kwargs=dict(kwargs) if kwargs else {},
        countdown=countdown or None,
    )
    logger.info(
        "redispatch_dead_lettered_task: re-enqueued %s (countdown=%ss) as %s",
        task_name,
        countdown,
        async_result.id,
    )
    return str(async_result.id)


# ---------------------------------------------------------------------------
# Monte Carlo run history — ADR-0175 (#961)
# ---------------------------------------------------------------------------


def record_monte_carlo_run(
    project_id: str | uuid.UUID,
    *,
    p50: date | None,
    p80: date | None,
    p95: date | None,
    n_simulations: int,
    cpm_finish: date | None = None,
    task_count: int | None = None,
    user: Any = None,
    distribution: dict[str, Any] | None = None,
) -> MonteCarloRun | None:
    """Persist one project-level Monte Carlo run for the forecast history (ADR-0175).

    Called synchronously from ``run_monte_carlo`` after the simulation returns.
    Persistence is **best-effort**: the simulation result is the primary
    deliverable, so a write failure is logged and swallowed (the caller still
    returns the computed result; the history simply misses that row). Returns the
    created ``MonteCarloRun`` or ``None`` on failure.

    ``user`` is stored as ``triggered_by`` and is serialized only to the resolved
    attribution audience (ADR-0144 / VoC): forecast drift must not become a
    named-individual signal at the team level. An ``AnonymousUser`` (never expected
    here behind IsAuthenticated) is normalized to ``None``.

    ``distribution`` is the size-bounded ``{histogram_buckets, confidence_curve,
    sensitivity}`` payload (#1231) persisted so the histogram survives cache expiry;
    ``None`` (legacy / no distribution) renders the empty-state prose on read.
    """
    from trueppm_api.apps.scheduling.models import MonteCarloRun

    triggered_by = user if getattr(user, "is_authenticated", False) else None
    try:
        return MonteCarloRun.objects.create(
            project_id=project_id,
            p50=p50,
            p80=p80,
            p95=p95,
            cpm_finish=cpm_finish,
            n_simulations=n_simulations,
            task_count=task_count,
            triggered_by=triggered_by,
            distribution=distribution,
        )
    except Exception:
        logger.exception(
            "record_monte_carlo_run: failed to persist run for project %s "
            "— returning computed result without history row",
            project_id,
        )
        return None


# ---------------------------------------------------------------------------
# Velocity calibration — ADR-0065
# ---------------------------------------------------------------------------


def _sprint_working_days(sprint: Sprint) -> int:
    """Count Mon–Fri days in the sprint window, inclusive of both endpoints."""
    from trueppm_api.apps.projects.services import _working_days

    return _working_days(sprint.start_date, sprint.finish_date)


def compute_team_velocity_per_day(
    project_id: str | uuid.UUID,
    *,
    exclude_sprint_id: str | uuid.UUID | None = None,
) -> Decimal | None:
    """Return rolling team_velocity_per_day for the project, or None if undefined.

    Uses the last ``VELOCITY_ROLLING_WINDOW`` completed sprints excluding the
    optional ``exclude_sprint_id`` (typically the sprint that just closed —
    its velocity is what we're calibrating *toward*, so feeding it back into
    the rolling window would double-weight it on the very first run).

    Draws from ``velocity_eligible_sprints`` (ADR-0113) so a sprint flagged
    ``exclude_from_velocity`` — a setup/ramp-up "Sprint 0" — never contaminates
    the calibration the CPM duration suggestions are derived from. This is the
    single source of truth for "counts toward velocity"; do not re-filter here.

    Returns ``None`` when fewer than ``MIN_CLOSED_SPRINTS_FOR_SUGGESTION``
    prior sprints have completed; callers must treat this as "not enough
    history to suggest" rather than "velocity is zero".
    """
    from trueppm_api.apps.projects.services import velocity_eligible_sprints

    qs = velocity_eligible_sprints(project_id)
    if exclude_sprint_id is not None:
        qs = qs.exclude(pk=exclude_sprint_id)
    closed = list(qs[:VELOCITY_ROLLING_WINDOW])

    if len(closed) < MIN_CLOSED_SPRINTS_FOR_SUGGESTION:
        return None

    per_day_samples: list[float] = []
    for s in closed:
        if s.completed_points is None:
            continue
        working_days = _sprint_working_days(s)
        if working_days <= 0:
            continue
        per_day_samples.append(s.completed_points / working_days)

    if len(per_day_samples) < MIN_CLOSED_SPRINTS_FOR_SUGGESTION:
        return None
    avg = statistics.fmean(per_day_samples)
    if avg <= 0:
        # Zero-velocity team produces an infinite suggested_duration — refuse.
        return None
    # Quantize to three decimal places to match the model's DecimalField scale.
    return Decimal(f"{avg:.3f}")


def compute_velocity_suggestions(sprint_id: str | uuid.UUID) -> int:
    """Generate VelocitySuggestion rows for tasks in a just-closed sprint.

    Called synchronously from ``projects.tasks.close_sprint`` after the
    SPRINT_CLOSED ``ScheduleRequest`` has been inserted, inside the same
    atomic block so the suggestions commit (or roll back) together with the
    sprint close itself.

    Behavior:

    - Requires the sprint to be COMPLETED. A non-completed sprint is treated
      as a no-op (defensive — the drain only calls this after the state
      transition succeeds).
    - Skips when team_velocity_per_day is undefined (fewer than three prior
      completed sprints, or zero/negative average). The PM will simply not
      see a prompt until enough history accumulates.
    - For each non-deleted task in the closing sprint with ``story_points``
      set, computes ``suggested_duration = round(story_points / velocity)``,
      clamped to at least 1 working day.
    - Skips tasks whose current ``most_likely_duration`` already equals the
      suggestion (no point prompting the PM to accept a value already in
      place).
    - Idempotent: a duplicate run upserts the suggestion row via the unique
      constraint on (task, sprint); the PM's accept/dismiss decision on a
      prior row is preserved (we only refresh truly pending rows).

    Returns the number of suggestion rows touched (created or refreshed).
    """
    from trueppm_api.apps.projects.models import (
        EstimationMode,
        Sprint,
        SprintState,
        Task,
    )
    from trueppm_api.apps.scheduling.models import VelocitySuggestion

    try:
        sprint = Sprint.objects.select_related("project").get(pk=sprint_id)
    except Sprint.DoesNotExist:
        logger.warning("compute_velocity_suggestions: sprint %s not found", sprint_id)
        return 0

    if sprint.state != SprintState.COMPLETED:
        return 0

    velocity = compute_team_velocity_per_day(
        sprint.project_id,
        exclude_sprint_id=sprint.pk,
    )
    if velocity is None:
        logger.info(
            "compute_velocity_suggestions: project %s lacks enough closed sprints "
            "for a stable rolling average — skipping",
            sprint.project_id,
        )
        return 0

    flag_for_review = sprint.project.estimation_mode == EstimationMode.SUGGEST_APPROVE

    tasks = list(
        Task.objects.filter(
            sprint_id=sprint.pk,
            is_deleted=False,
            story_points__isnull=False,
            story_points__gt=0,
        )
    )

    # Pre-load existing suggestions for the (sprint, task ∈ tasks) set in a
    # single query rather than issuing one .filter().first() per task — for a
    # sprint with many tasks the drain is the hot path and N+1 would slow
    # sprint close noticeably.
    existing_by_task = {
        sugg.task_id: sugg
        for sugg in VelocitySuggestion.objects.filter(
            sprint=sprint,
            task_id__in=[t.pk for t in tasks],
        )
    }

    touched = 0
    for task in tasks:
        # story_points is narrowed by the filter above (isnull=False, gt=0);
        # the explicit cast satisfies mypy without an assert in a hot loop.
        story_points = task.story_points or 0
        suggested = max(1, round(float(story_points) / float(velocity)))
        if task.most_likely_duration == suggested:
            # Already in place — no point creating a suggestion the PM would
            # have to dismiss.
            continue
        # Preserve a prior accept/dismiss decision: only the pending row is
        # refreshed. update_or_create with a where-pending filter expressed as
        # a get-then-update keeps the audit trail correct.
        existing = existing_by_task.get(task.pk)
        if existing is None:
            VelocitySuggestion.objects.create(
                task=task,
                sprint=sprint,
                suggested_duration=suggested,
                team_velocity_per_day=velocity,
                flag_for_review=flag_for_review,
            )
            touched += 1
            continue
        if existing.is_pending:
            VelocitySuggestion.objects.filter(pk=existing.pk).update(
                suggested_duration=suggested,
                team_velocity_per_day=velocity,
                flag_for_review=flag_for_review,
            )
            touched += 1
    if touched:
        logger.info(
            "compute_velocity_suggestions: wrote %d suggestion(s) for sprint %s",
            touched,
            sprint_id,
        )
    return touched


def build_sched_tasks(db_tasks: list[Any], *, suggest_approve: bool) -> list[Any]:
    """Convert Django ``Task`` rows into scheduler ``Task`` dataclasses.

    Single source of truth for the API → engine task mapping, shared by the
    deterministic CPM pass (``scheduling.tasks``) and the Monte Carlo endpoint
    (``scheduling.views``). Keeping one converter is what stops the CPM and MC
    inputs from drifting — the exact failure mode of #1185, where Monte Carlo
    silently dropped ``planned_start``. Every progress/actual field (ADR-0132) is
    mapped here, so it reaches both engines or neither.

    Args:
        db_tasks: Django ``Task`` rows, already filtered to the committed set.
        suggest_approve: When True (``project.estimation_mode`` is
            ``SUGGEST_APPROVE``) a task's three-point estimate is withheld unless
            its ``estimate_status`` is ACCEPTED. The scheduler's all-or-none rule
            means a single ``None`` falls back to the deterministic duration.
            (No-op for the deterministic CPM pass, which ignores PERT, but applied
            uniformly so the two paths share one code path.)
    """
    from datetime import timedelta

    from trueppm_scheduler.models import DeliveryMode as SchedDeliveryMode
    from trueppm_scheduler.models import Task as SchedTask

    from trueppm_api.apps.projects.models import DeliveryMode, EstimateStatus

    def _pert(value: int | None, estimate_status: str | None) -> timedelta | None:
        if value is None:
            return None
        if suggest_approve and estimate_status != EstimateStatus.ACCEPTED:
            return None
        return timedelta(days=value)

    return [
        SchedTask(
            id=str(t.id),
            name=t.name,
            # Milestones are zero-duration gates regardless of any stored duration
            # (MS Project allows non-zero milestone durations); the engine operates
            # on duration only, so normalise at the boundary.
            duration=timedelta(days=0) if t.is_milestone else timedelta(days=t.duration),
            # planned_start is the engine's SNET floor (ADR-0014). An explicit value
            # always wins; otherwise a sprint-assigned, schedulable task inherits its
            # sprint's start_date as a *synthetic* floor (ADR-0168) so agile work
            # positions in its sprint window instead of the project origin. Engine
            # input only — never written back, so the stored row stays null; applying
            # it in this one converter keeps CPM and Monte Carlo in sync (#1185).
            # Milestones are excluded — a sprint review/demo gate sits at the sprint
            # end, not its start (ADR-0106).
            planned_start=(
                t.planned_start
                if t.planned_start is not None
                else (t.sprint.start_date if (t.sprint_id and not t.is_milestone) else None)
            ),
            percent_complete=t.percent_complete,
            actual_start=t.actual_start,
            actual_finish=t.actual_finish,
            optimistic_duration=_pert(t.optimistic_duration, t.estimate_status),
            most_likely_duration=_pert(t.most_likely_duration, t.estimate_status),
            pessimistic_duration=_pert(t.pessimistic_duration, t.estimate_status),
            # Agile-aware Monte Carlo (#411): only SCRUM tasks sample from team
            # velocity, so map just that mode (the scheduler enum has no KANBAN /
            # MILESTONE — those stay None == WATERFALL, deterministic/PERT, exactly
            # as before). story_points is the velocity path's burn-down target. Both
            # are inert for the deterministic CPM pass, which reads neither — the
            # shared converter (ADR-0132) simply carries them for the MC path.
            delivery_mode=(
                SchedDeliveryMode.SCRUM if t.delivery_mode == DeliveryMode.SCRUM else None
            ),
            story_points=(float(t.story_points) if t.story_points is not None else None),
        )
        for t in db_tasks
    ]


def build_sched_calendar(cal: Calendar | None) -> Any:
    """Convert a Django ``Calendar`` (plus its ``CalendarException`` rows) into a
    scheduler ``Calendar`` dataclass.

    Single source of truth for the API → engine calendar mapping (issue #1491).
    Every call site that feeds a project's calendar to the CPM pass or Monte
    Carlo previously constructed ``trueppm_scheduler.models.Calendar`` inline
    with only ``working_days``/``hours_per_day``/``timezone`` — never
    ``exceptions`` — so a configured holiday or shutdown (``CalendarException``)
    was silently scheduled straight through: early/late dates, float, the
    critical path, and Monte Carlo P50/P80/P95 all ignored it. Routing every
    caller through this one converter is what stops that field from being
    forgotten again at a fourth call site.

    Args:
        cal: The project's Django ``Calendar``, or ``None`` if the project has
            no calendar assigned (falls back to the Mon-Fri/8h/UTC default).
            When not ``None``, callers should have prefetched ``cal.exceptions``
            (e.g. via ``prefetch_related("calendar__exceptions")``) to avoid an
            N+1 query per project.

    Returns:
        A ``trueppm_scheduler.models.Calendar`` with ``exceptions`` populated
        from the calendar's ``CalendarException`` rows.
    """
    from trueppm_scheduler.models import Calendar as SchedCalendar
    from trueppm_scheduler.models import DateRange

    if cal is None:
        return SchedCalendar(working_days=31, hours_per_day=8.0, timezone="UTC")

    return SchedCalendar(
        working_days=cal.working_days,
        hours_per_day=cal.hours_per_day,
        timezone=cal.timezone,
        exceptions=[
            DateRange(start=exc.exc_start, end=exc.exc_end) for exc in cal.exceptions.all()
        ],
    )


# Reason codes for a flat (deterministic) Monte Carlo forecast, in precedence order.
# Exposed so the API contract and tests reference one source rather than literals.
FORECAST_NO_COMMITTED_TASKS = "no_committed_tasks"
FORECAST_ALL_COMPLETE = "all_complete"
FORECAST_ESTIMATES_OFF_CRITICAL_PATH = "estimates_off_critical_path"
FORECAST_ESTIMATES_PENDING_APPROVAL = "estimates_pending_approval"
FORECAST_NO_VELOCITY_HISTORY = "no_velocity_history"
FORECAST_NO_ESTIMATES = "no_estimates"


def forecast_diagnostic(
    db_tasks: list[Any],
    *,
    suggest_approve: bool,
    has_velocity_signal: bool,
    deterministic: bool,
) -> dict[str, Any]:
    """Explain why a Monte Carlo forecast carries — or lacks — an uncertainty band.

    A flat forecast (``P50 == P80 == P95``) is *correct* whenever no committed task
    can contribute duration variance, but the bare percentiles give the user no clue
    *why*. The UI historically hard-coded "add PERT estimates", which is wrong when
    the estimates already exist but are withheld (``SUGGEST_APPROVE`` pending
    approval), when the work is agile (its uncertainty comes from velocity history,
    not a three-point range), or when the estimated work simply sits off the critical
    path. This derives the single most-actionable reason from the committed task set,
    mirroring the exact sampling gate the engine applies — ``build_sched_tasks._pert``
    plus the velocity condition in ``trueppm_scheduler.engine.monte_carlo`` — so the
    message the UI shows matches what the forecast actually did.

    Args:
        db_tasks: the committed ``Task`` rows fed to the simulation (already
            BACKLOG-filtered by ``Task.committed``).
        suggest_approve: whether the project withholds un-accepted estimates
            (``estimation_mode == SUGGEST_APPROVE``) — the same flag passed to
            :func:`build_sched_tasks`.
        has_velocity_signal: whether the project has usable completed-sprint velocity
            (a non-empty ``scheduler_velocity_inputs`` sample set).
        deterministic: whether the simulation collapsed to a single date.

    Returns:
        A diagnostic dict with ``deterministic``, a ``reason`` code (``None`` when the
        forecast has a real band), and supporting counts (``tasks_total``,
        ``tasks_with_variance``, ``tasks_pending_approval``,
        ``agile_tasks_without_velocity``). ``reason`` is one of the ``FORECAST_*``
        codes above.
    """
    from trueppm_api.apps.projects.models import DeliveryMode, EstimateStatus

    total = len(db_tasks)
    incomplete = 0
    with_variance = 0
    pending_approval = 0
    agile_without_velocity = 0

    for t in db_tasks:
        # Completion mirrors trueppm_scheduler.engine._is_complete (ADR-0136): a
        # finished task is laid out at fixed duration and contributes no variance.
        is_complete = t.actual_finish is not None or (t.percent_complete or 0) >= 100
        if not is_complete:
            incomplete += 1

        has_triple = (
            t.optimistic_duration is not None
            and t.most_likely_duration is not None
            and t.pessimistic_duration is not None
        )
        # Mirror build_sched_tasks._pert: SUGGEST_APPROVE withholds a triple from the
        # engine until it is ACCEPTED — a withheld triple is "pending", not variance.
        withheld = suggest_approve and t.estimate_status != EstimateStatus.ACCEPTED
        # A real spread needs opt != pess; a degenerate triple samples to a constant.
        pert_variance = (
            has_triple and not withheld and t.optimistic_duration != t.pessimistic_duration
        )
        is_scrum_pointed = t.delivery_mode == DeliveryMode.SCRUM and t.story_points is not None
        velocity_variance = is_scrum_pointed and has_velocity_signal

        if pert_variance or velocity_variance:
            with_variance += 1
        if has_triple and withheld:
            pending_approval += 1
        if is_scrum_pointed and not has_velocity_signal:
            agile_without_velocity += 1

    reason: str | None = None
    if deterministic:
        if total == 0:
            reason = FORECAST_NO_COMMITTED_TASKS
        elif incomplete == 0:
            reason = FORECAST_ALL_COMPLETE
        elif with_variance > 0:
            # Variance exists but never reaches the project finish: the estimated work
            # sits off the critical path (the sensitivity tornado's own empty case).
            # Surfacing this stops the UI telling a user with estimates to add some.
            reason = FORECAST_ESTIMATES_OFF_CRITICAL_PATH
        elif pending_approval > 0:
            reason = FORECAST_ESTIMATES_PENDING_APPROVAL
        elif agile_without_velocity > 0:
            reason = FORECAST_NO_VELOCITY_HISTORY
        else:
            reason = FORECAST_NO_ESTIMATES

    return {
        "deterministic": deterministic,
        "reason": reason,
        "tasks_total": total,
        "tasks_with_variance": with_variance,
        "tasks_pending_approval": pending_approval,
        "agile_tasks_without_velocity": agile_without_velocity,
    }


def apply_summary_rollups(
    result_map: dict[str, Any],
    summary_ids: set[str],
    children_map: dict[str, list[str]],
    db_task_by_id: dict[str, Any],
) -> None:
    """Add synthetic CPM rows for summary tasks to ``result_map`` in place (ADR-0105).

    Summary tasks are excluded from the leaf CPM pass (they are grouping nodes, not
    schedulable work), so their dates are *derived* from their leaf descendants:
    ``early_start = min(leaf early_start)``, ``early_finish = max(leaf early_finish)``,
    tightest float, critical if any leaf is critical. Shared by the single-project
    write-back (``scheduling.tasks._run_schedule``) and the program-scoped write-back
    (``recalculate_program_schedule``) so the two never drift (the #1185 class). The
    merged ``children_map`` keys are globally-unique task ids, so this works
    unchanged across the per-project and program graphs.
    """
    from datetime import timedelta

    from trueppm_scheduler.engine import _collect_leaves
    from trueppm_scheduler.models import Task as SchedTask

    for sid in summary_ids:
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


# Capture-path dedup window (ADR-0154 §3): a recompute that produces an
# unchanged forecast within this window of the previous snapshot is a no-op, so
# a project recomputed many times during a heavy edit session does not write a
# row per recompute. This window also makes a duplicate recompute (broker retry,
# manual re-queue) idempotent.
FORECAST_DEDUP_WINDOW_SECONDS = 3600

# The fields compared for the dedup no-op decision — the forecast itself plus the
# schedule-shape context. captured_at/triggered_by are intentionally excluded.
_FORECAST_DEDUP_FIELDS = (
    "cpm_finish",
    "total_float_days",
    "mc_p50_finish",
    "mc_p80_finish",
    "mc_p95_finish",
    "mc_iterations",
    "task_count",
    "completed_task_count",
)


def capture_forecast_snapshot(project_id: str | uuid.UUID, trigger: str) -> Any | None:
    """Capture a project-grain ``ProjectForecastSnapshot`` (ADR-0154, #388).

    Derives every field from already-committed state — the just-recomputed
    ``Task`` rows (CPM spine) plus the project's most-recent ``MonteCarloRun``
    (probabilistic band, best-effort, may be absent or stale). Idempotent within
    ``FORECAST_DEDUP_WINDOW_SECONDS``: if the latest snapshot is newer than the
    window and every forecast field is unchanged, this no-ops and returns ``None``.

    Returns the created row, or ``None`` when the capture was deduped.
    """
    from datetime import timedelta

    from django.db.models import Count, Max, Min, Q
    from django.utils import timezone

    from trueppm_api.apps.projects.models import Task, TaskStatus
    from trueppm_api.apps.scheduling.models import MonteCarloRun, ProjectForecastSnapshot

    # One aggregate query for the whole-project schedule shape. cpm_finish is the
    # latest task finish; total_float_days is the tightest slack across the project
    # (negative = a constraint is breached). Counts are over non-deleted tasks.
    agg = Task.objects.filter(project_id=project_id, is_deleted=False).aggregate(
        cpm_finish=Max("early_finish"),
        total_float_days=Min("total_float"),
        task_count=Count("id"),
        completed=Count("id", filter=Q(status=TaskStatus.COMPLETE)),
    )

    latest_mc = (
        MonteCarloRun.objects.filter(project_id=project_id)
        .order_by("-taken_at")
        .values("p50", "p80", "p95", "n_simulations")
        .first()
    )

    fields = {
        "cpm_finish": agg["cpm_finish"],
        "total_float_days": agg["total_float_days"],
        "mc_p50_finish": latest_mc["p50"] if latest_mc else None,
        "mc_p80_finish": latest_mc["p80"] if latest_mc else None,
        "mc_p95_finish": latest_mc["p95"] if latest_mc else None,
        "mc_iterations": latest_mc["n_simulations"] if latest_mc else None,
        "task_count": agg["task_count"] or 0,
        "completed_task_count": agg["completed"] or 0,
    }

    # Capture-path dedup: no-op if the latest snapshot is within the window AND
    # every tracked field matches. The latest-row read is the idempotency guard.
    latest = (
        ProjectForecastSnapshot.objects.filter(project_id=project_id)
        .order_by("-captured_at")
        .first()
    )
    if latest is not None:
        within_window = (timezone.now() - latest.captured_at) < timedelta(
            seconds=FORECAST_DEDUP_WINDOW_SECONDS
        )
        unchanged = all(getattr(latest, name) == fields[name] for name in _FORECAST_DEDUP_FIELDS)
        if within_window and unchanged:
            return None

    return ProjectForecastSnapshot.objects.create(
        project_id=project_id, triggered_by=trigger, **fields
    )


def notify_project_end_date_shift(snapshot: Any) -> None:
    """Notify the project's PM/Owner cohort when the CPM finish moves by more
    than the project's configurable threshold (#1911, the third #82 schedule-
    notification rule — companion to #1668's dependency-slip / became-critical
    pair, and the ``ProjectForecastSnapshot`` analog of
    ``projects.services.notify_milestone_forecast_shift`` (#861)).

    Compares ``snapshot`` (the just-captured row) against the immediately-prior
    ``ProjectForecastSnapshot`` for the same project. Material shift = the
    absolute day delta between the two ``cpm_finish`` values is strictly
    greater than ``Project.end_date_shift_threshold_days``. A project with no
    prior snapshot (or no cpm_finish on either side) has nothing to compare
    against and is skipped — the first-ever finish is not a "shift".

    Debounce (issue AC) is structural, not a separate guard here: this is
    called once per *newly created* snapshot, and ``capture_forecast_snapshot``
    already no-ops (creates no row) when the forecast is unchanged within
    ``FORECAST_DEDUP_WINDOW_SECONDS`` — so a recompute that doesn't move the
    finish produces no new snapshot and therefore no repeat notification for
    the same shift.

    Role targeting mirrors ``notify_milestone_forecast_shift``: PM/Owner cohort
    is ``role >= Role.ADMIN``, ``is_deleted=False``. The ``is_deleted=False``
    filter is load-bearing for privacy — member removal is a soft delete that
    leaves the row (with its role) intact, so without it a revoked PM would
    keep receiving end-date-shift digests for a project they no longer belong
    to (rbac-check).
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot

    if snapshot.cpm_finish is None:
        return

    prior = (
        ProjectForecastSnapshot.objects.filter(project_id=snapshot.project_id)
        .exclude(pk=snapshot.pk)
        .order_by("-captured_at")
        .first()
    )
    if prior is None or prior.cpm_finish is None:
        return  # no prior finish to compare against — not a "shift"

    delta_days = abs((snapshot.cpm_finish - prior.cpm_finish).days)

    project_row = (
        Project.objects.filter(pk=snapshot.project_id)
        .values("name", "end_date_shift_threshold_days")
        .first()
    )
    if project_row is None or delta_days <= project_row["end_date_shift_threshold_days"]:
        return

    # rbac-check: recipients are computed server-side from role, never taken from
    # request input or filtered client-side — a plain member can never end up in
    # this list regardless of what the caller passes.
    recipient_ids = list(
        ProjectMembership.objects.filter(
            project_id=snapshot.project_id, role__gte=Role.ADMIN, is_deleted=False
        ).values_list("user_id", flat=True)
    )
    if not recipient_ids:
        return

    direction = "pushed out" if snapshot.cpm_finish > prior.cpm_finish else "pulled in"
    day_word = "day" if delta_days == 1 else "days"
    subject = f"Project end date shifted — {project_row['name']}"
    body = (
        f"The project finish {direction} by {delta_days} {day_word}: "
        f"{prior.cpm_finish.isoformat()} → {snapshot.cpm_finish.isoformat()}."
    )

    project_id_str = str(snapshot.project_id)
    # Deferred like every other event-notification write in this codebase
    # (notify_milestone_forecast_shift, notify_carryover_assignees): on_commit
    # is safe to call even with no active transaction (runs immediately), and
    # protects a future caller that invokes this from inside an open one.
    transaction.on_commit(
        lambda: create_event_notifications(
            event_type=NotificationEventType.PROJECT_END_DATE_SHIFTED,
            recipient_ids=recipient_ids,
            subject=subject,
            body=body,
            project_id=project_id_str,
        )
    )


def safe_capture_forecast_snapshot(project_id: str | uuid.UUID, trigger: str) -> None:
    """Best-effort wrapper around :func:`capture_forecast_snapshot` (ADR-0154 §3).

    Used by the recompute ``on_commit`` hook: a capture failure must never roll
    back or block the CPM write (we are strictly post-commit), and the data is
    fully reconstructable, so any exception is logged and discarded — the daily
    floor task backfills the miss.

    Also fires the project end-date shift notification (#1911) whenever a new
    snapshot is actually captured. Wiring it here — rather than at each of the
    three call sites (recompute, program recompute, daily floor) — is the
    single hook point that covers every trigger uniformly. Wrapped in its own
    try/except so a notification bug can never surface as (or mask) a snapshot
    capture failure.
    """
    try:
        snapshot = capture_forecast_snapshot(project_id, trigger)
    except Exception:
        logger.warning("forecast snapshot capture failed for project %s", project_id, exc_info=True)
        return

    if snapshot is not None:
        try:
            notify_project_end_date_shift(snapshot)
        except Exception:
            logger.warning(
                "project end-date shift notification failed for project %s",
                project_id,
                exc_info=True,
            )
