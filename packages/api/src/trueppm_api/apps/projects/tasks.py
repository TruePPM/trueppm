"""Celery tasks for the projects app — sprint close drain + burndown beat.

The transactional outbox pattern from ``apps/scheduling`` is mirrored here
for sprint close: the API endpoint inserts a ``SprintCloseRequest`` row in
the same DB transaction as the state change and returns 202 Accepted; this
drain task picks up PENDING rows and applies the actual close transition
under ``select_for_update`` (so concurrent drains never double-close).

See ADR-0037 for the full spec.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# close_sprint — applies a single SprintCloseRequest
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="sprint_close_lock:{0}",
    lock_ttl=120,
    on_contention="skip",
    max_retries=3,
    retry_backoff=10,
    retry_backoff_max=60,
    retry_jitter=True,
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
)
def close_sprint(self: object, request_id: str) -> None:
    """Apply a queued sprint close transition.

    Idempotency: if the SprintCloseRequest is already COMPLETED or FAILED, the
    task is a no-op. If the sprint is already COMPLETED for any reason, the
    request is short-circuited to COMPLETED. Re-entry under broker retry
    therefore never produces duplicate close side-effects.

    On success the function:
      1. Snapshots ``completed_*`` from current task state
      2. Transitions sprint state to COMPLETED + sets closed_at
      3. Applies carry-over (FK move on incomplete tasks)
      4. Marks the SprintCloseRequest COMPLETED
      5. Enqueues a ScheduleRequest with ``reason=SPRINT_CLOSED`` for CPM recompute
      6. Broadcasts a ``sprint_closed`` board event to connected clients

    Args:
        request_id: SprintCloseRequest UUID string.
    """
    from trueppm_api.apps.projects.models import (
        SprintCloseRequest,
        SprintCloseRequestStatus,
        SprintState,
    )
    from trueppm_api.apps.projects.services import (
        apply_carry_over,
        snapshot_completed_metrics,
    )
    from trueppm_api.apps.scheduling.models import (
        ScheduleRequest,
        ScheduleRequestReason,
    )
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    try:
        req = SprintCloseRequest.objects.select_related("sprint", "sprint__project").get(
            pk=request_id
        )
    except SprintCloseRequest.DoesNotExist:
        logger.warning("close_sprint: request %s not found, skipping", request_id)
        return

    if req.status in (SprintCloseRequestStatus.COMPLETED, SprintCloseRequestStatus.FAILED):
        logger.info("close_sprint: request %s already %s — short-circuit", request_id, req.status)
        return

    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=timezone.now(),
        attempt_count=req.attempt_count + 1,
    )

    try:
        with transaction.atomic():
            # Lock the sprint row: prevents two concurrent close attempts from
            # double-snapshotting completed_* or applying carry-over twice.
            from trueppm_api.apps.projects.models import Sprint

            sprint = Sprint.objects.select_for_update().get(pk=req.sprint_id)

            if sprint.state == SprintState.COMPLETED:
                # Already closed by an earlier dispatch; mark request done.
                SprintCloseRequest.objects.filter(pk=req.pk).update(
                    status=SprintCloseRequestStatus.COMPLETED,
                    completed_at=timezone.now(),
                )
                return

            if sprint.state == SprintState.CANCELLED:
                SprintCloseRequest.objects.filter(pk=req.pk).update(
                    status=SprintCloseRequestStatus.FAILED,
                    completed_at=timezone.now(),
                    error_message="Sprint was cancelled before close could complete.",
                )
                return

            if sprint.state != SprintState.ACTIVE:
                SprintCloseRequest.objects.filter(pk=req.pk).update(
                    status=SprintCloseRequestStatus.FAILED,
                    completed_at=timezone.now(),
                    error_message=f"Sprint state {sprint.state} is not closable.",
                )
                return

            snapshot_completed_metrics(sprint)
            sprint.state = SprintState.COMPLETED
            sprint.closed_at = timezone.now()
            sprint.save(
                update_fields=[
                    "completed_points",
                    "completed_task_count",
                    "state",
                    "closed_at",
                ]
            )

            carried_task_ids = apply_carry_over(sprint, req.carry_over_to)

            # ADR-0074: recompute the milestone rollup with the final
            # completed_* snapshot. Runs here (inside the drain transaction,
            # after carry-over) so the milestone reflects the closed sprint's
            # final contribution before the sprint_closed broadcast goes out.
            if sprint.target_milestone_id is not None:
                from trueppm_api.apps.projects.services import recompute_milestone_rollup

                recompute_milestone_rollup(sprint.target_milestone_id)

            SprintCloseRequest.objects.filter(pk=req.pk).update(
                status=SprintCloseRequestStatus.COMPLETED,
                completed_at=timezone.now(),
                error_message="",
            )

            # Enqueue downstream CPM recompute with the SPRINT_CLOSED reason
            # so the audit trail records why the recalculation fired.
            project_id = sprint.project_id
            ScheduleRequest.objects.create(
                project_id=project_id,
                reason=ScheduleRequestReason.SPRINT_CLOSED,
            )

            # Compute velocity-calibration suggestions (ADR-0065). Non-blocking
            # on failure: any error logs and is swallowed so a calibration bug
            # cannot strand a sprint close.
            try:
                from trueppm_api.apps.scheduling.services import (
                    compute_velocity_suggestions,
                )

                compute_velocity_suggestions(sprint.pk)
            except Exception:
                logger.exception(
                    "close_sprint: velocity calibration failed for sprint %s — continuing close",
                    sprint.pk,
                )

            sprint_id_str = str(sprint.pk)
            project_id_str = str(project_id)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id_str,
                    "sprint_closed",
                    {"id": sprint_id_str},
                )
            )
            # The carried-over tasks changed sprint (and possibly status). Without
            # a broadcast, connected clients keep rendering them under the closed
            # sprint until a manual refetch. Emit one bulk event for the batch.
            # Bind the ids via a default arg (matches the backlog_services pattern)
            # so closure late-binding can't swap them if this grows more branches.
            if carried_task_ids:

                def _broadcast_carry_over(
                    pid: str = project_id_str, ids: list[str] = carried_task_ids
                ) -> None:
                    broadcast_board_event(pid, "tasks_bulk_mutated", {"task_ids": ids})

                transaction.on_commit(_broadcast_carry_over)

    except Exception as exc:
        logger.exception("close_sprint: failed for request %s", request_id)
        SprintCloseRequest.objects.filter(pk=req.pk).update(
            status=SprintCloseRequestStatus.FAILED,
            completed_at=timezone.now(),
            error_message=str(exc)[:1000],
        )


# ---------------------------------------------------------------------------
# Drain — every 30 seconds via Beat
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="drain_sprint_close_requests",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.drain_sprint_close_requests",
)
def drain_sprint_close_requests(self: object) -> None:
    """Dispatch any pending or stranded SprintCloseRequest rows.

    Beat: every 30 s. Like the scheduling drain, this also recovers IN_FLIGHT
    rows that have aged past the 5-minute orphan window (worker died mid-close).
    """
    _do_drain()


@idempotent_task(
    lock_key_template="update_sprint_burndown_snapshots",
    lock_ttl=300,
    on_contention="skip",
    soft_time_limit=120,
    time_limit=180,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.update_sprint_burndown_snapshots",
)
def update_sprint_burndown_snapshots(self: object) -> None:
    """Write yesterday's burndown row for every ACTIVE sprint.

    Beat: 01:00 UTC daily. Real-time UPSERTs from the task_status_changed
    signal cover today's row; this Beat task fills in days where no status
    changed (and therefore no signal fired).
    """
    from trueppm_api.apps.projects.models import Sprint, SprintState
    from trueppm_api.apps.projects.services import upsert_burndown_for_sprint

    yesterday = timezone.localdate() - timedelta(days=1)
    for sprint in Sprint.objects.filter(state=SprintState.ACTIVE, is_deleted=False):
        try:
            upsert_burndown_for_sprint(sprint, snapshot_date=yesterday)
        except Exception:
            logger.exception("update_sprint_burndown_snapshots: failed for sprint %s", sprint.pk)


@idempotent_task(
    lock_key_template="purge_sprint_close_requests",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.purge_sprint_close_requests",
)
def purge_sprint_close_requests(self: object) -> None:
    """Delete COMPLETED / FAILED SprintCloseRequest rows older than 7 days."""
    from trueppm_api.apps.projects.models import (
        SprintCloseRequest,
        SprintCloseRequestStatus,
    )

    cutoff = timezone.now() - timedelta(days=7)
    deleted, _ = SprintCloseRequest.objects.filter(
        status__in=[
            SprintCloseRequestStatus.COMPLETED,
            SprintCloseRequestStatus.FAILED,
        ],
        requested_at__lt=cutoff,
    ).delete()
    logger.info("purge_sprint_close_requests: deleted %d row(s)", deleted)


# ---------------------------------------------------------------------------
# Drain implementation — extracted for testability
# ---------------------------------------------------------------------------


_ORPHAN_WINDOW = timedelta(minutes=5)


def _do_drain() -> None:
    from trueppm_api.apps.projects.models import (
        SprintCloseRequest,
        SprintCloseRequestStatus,
    )

    now = timezone.now()
    orphan_cutoff = now - _ORPHAN_WINDOW

    # Recover IN_FLIGHT rows that have stalled past the orphan window — the
    # task_id may not match anything live, so we reset and let the next
    # dispatch attempt acquire the per-request lock fresh.
    recovered = SprintCloseRequest.objects.filter(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at__lt=orphan_cutoff,
    ).update(status=SprintCloseRequestStatus.PENDING)
    if recovered:
        logger.warning(
            "drain_sprint_close_requests: recovered %d orphaned IN_FLIGHT row(s)",
            recovered,
        )

    pending = list(
        SprintCloseRequest.objects.filter(
            status=SprintCloseRequestStatus.PENDING,
            requested_at__lt=now - timedelta(seconds=2),
        ).order_by("requested_at")[:50]
    )
    dispatched = 0
    for req in pending:
        try:
            close_sprint.delay(str(req.id))
        except Exception:
            logger.warning(
                "drain_sprint_close_requests: broker unavailable — request %s stays pending",
                req.id,
            )
            continue
        dispatched += 1
    if dispatched or recovered:
        logger.info(
            "drain_sprint_close_requests: dispatched=%d recovered=%d", dispatched, recovered
        )
