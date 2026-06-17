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
    from trueppm_api.apps.projects.models import Sprint
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


# ---------------------------------------------------------------------------
# Monte Carlo run history — ADR-0109 (#961)
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
    """Persist one project-level Monte Carlo run for the forecast history (ADR-0109).

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

    from trueppm_scheduler.models import Task as SchedTask

    from trueppm_api.apps.projects.models import EstimateStatus

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
            planned_start=t.planned_start,
            percent_complete=t.percent_complete,
            actual_start=t.actual_start,
            actual_finish=t.actual_finish,
            optimistic_duration=_pert(t.optimistic_duration, t.estimate_status),
            most_likely_duration=_pert(t.most_likely_duration, t.estimate_status),
            pessimistic_duration=_pert(t.pessimistic_duration, t.estimate_status),
        )
        for t in db_tasks
    ]
