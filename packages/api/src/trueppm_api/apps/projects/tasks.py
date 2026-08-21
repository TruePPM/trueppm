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
from typing import Any

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

EXPORT_MAX_RETRIES = 3  # ADR-0219 §Durable Execution item 8
EXPORT_ORPHAN_WINDOW_MINUTES = 5  # ADR-0219 §Durable Execution item 3
EXPORT_DRAIN_BATCH_SIZE = 10
DEFAULT_EXPORT_RETENTION_DAYS = 7  # ADR-0219 §Durable Execution item 6 (shared with ADR-0174)


# ---------------------------------------------------------------------------
# close_sprint — applies a single SprintCloseRequest
# ---------------------------------------------------------------------------


# How many times a close may be attempted before the request is abandoned, and
# how long a failed one waits before the drain re-queues it (#2894). The budget
# is enforced by the drain rather than by the Celery decorator's ``max_retries``
# — see the exception handler in close_sprint for why a broker-level retry
# cannot work here.
_MAX_CLOSE_ATTEMPTS = 3
_CLOSE_RETRY_BACKOFF = timedelta(seconds=60)
# Per-sweep caps. Fresh closes and retries draw from separate dispatch budgets so
# neither can starve the other — see the drain for why one shared, ordered slice
# stopped being safe once failed rows could re-enter the pool.
_DISPATCH_BUDGET = 50
_RETRY_DISPATCH_BUDGET = 10
_RETRY_REQUEUE_BUDGET = 200


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

    Recovery from a failure runs through the **drain**, not through the broker
    (#2894). A failure rolls the transaction back and marks the row FAILED with
    a ``next_attempt_at``; ``drain_sprint_close_requests`` resets it to PENDING
    once that time passes and re-dispatches, up to ``_MAX_CLOSE_ATTEMPTS``. The
    decorator's ``max_retries`` cannot serve this: its retry re-enters here and
    hits the FAILED short-circuit above, so it would spend the budget without
    running the close. When the budget is spent ``next_attempt_at`` stays null,
    the row is abandoned, and the sprint remains ACTIVE — recoverable only by
    issuing a fresh close request.

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
        SprintCloseRequestFailureReason,
        SprintCloseRequestStatus,
        SprintState,
    )
    from trueppm_api.apps.projects.services import (
        apply_carry_over,
        apply_pending_disposition,
        notify_carryover_assignees,
        snapshot_completed_metrics,
        snapshot_sprint_task_outcomes,
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

    # This increment MUST stay outside the `transaction.atomic()` below, and that
    # placement is load-bearing rather than incidental (#2894): the retry budget
    # is the only thing bounding the drain's re-queue loop, and it is enforced by
    # comparing attempt_count. Wrapping close_sprint in @transaction.atomic — or
    # moving this inside the block — rolls the increment back together with the
    # failed close, so attempt_count never advances, the budget is never spent,
    # and a permanently failing close is re-queued forever.
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

            if _finalize_non_closable_sprint(req, sprint):
                return

            snapshot_completed_metrics(sprint)
            sprint.state = SprintState.COMPLETED
            sprint.closed_at = timezone.now()
            sprint.save(
                update_fields=[
                    "completed_points",
                    "completed_task_count",
                    "goal_outcome",
                    "state",
                    "closed_at",
                ]
            )

            # ADR-0176 §2 (#982): snapshot the closing task membership BEFORE
            # apply_carry_over mutates Task.sprint — otherwise "what didn't ship"
            # is destroyed (carried tasks move to the next sprint, dropped tasks
            # to the backlog). NOT wrapped in try/except: the audit is part of the
            # close's definition of done, so a failure rolls the whole close back
            # and the drain re-queues the request.
            #
            # That second clause was false when written (#2894) — the handler
            # marked the row FAILED and nothing ever picked a FAILED row up. It
            # is true now, but bounded: _MAX_CLOSE_ATTEMPTS tries, then the
            # request is abandoned and the sprint stays ACTIVE. An audit failure
            # that reproduces will still strand the close; it just no longer does
            # so on the first try, silently.
            snapshot_sprint_task_outcomes(sprint, carry_over_to=req.carry_over_to)

            _clear_sprint_ranks(sprint)

            carried_task_ids = apply_carry_over(sprint, req.carry_over_to)

            # ADR-0102 §7: dispose of tasks still pending acceptance at close.
            # Runs AFTER carry-over (so a carried task's new sprint_id is set) and
            # never blocks the close. 'carry' re-flags pending tasks in the
            # incoming sprint; 'reject' removes them from the sprint.
            apply_pending_disposition(sprint, req.pending_disposition, by=req.requested_by)

            # ADR-0232 (#1470): tell each carried task's assignee their committed
            # work crossed the close→plan seam. Sourced from the faithful moved-id
            # set; defers create_event_notifications to on_commit inside the
            # service. Non-blocking like the reforecast digest below: a
            # notification bug must never strand or revert a sprint close.
            try:
                notify_carryover_assignees(
                    sprint,
                    req.carry_over_to,
                    carried_task_ids,
                    actor_id=req.requested_by_id,
                )
            except Exception:
                logger.exception(
                    "close_sprint: carryover notification failed for sprint %s — continuing close",
                    sprint.pk,
                )

            _recompute_and_reforecast_milestone(sprint, req)

            SprintCloseRequest.objects.filter(pk=req.pk).update(
                status=SprintCloseRequestStatus.COMPLETED,
                completed_at=timezone.now(),
                error_message="",
                failure_reason="",
                # Structural, not incidental: every terminal writer clears the
                # retry clock, so "null means no further attempt" holds by
                # construction rather than because no live path happens to leave
                # a stale value behind.
                next_attempt_at=None,
            )

            # Enqueue downstream CPM recompute with the SPRINT_CLOSED reason
            # so the audit trail records why the recalculation fired.
            project_id = sprint.project_id
            ScheduleRequest.objects.create(
                project_id=project_id,
                reason=ScheduleRequestReason.SPRINT_CLOSED,
            )

            _compute_velocity_suggestions_safe(sprint)

            sprint_id_str = str(sprint.pk)
            project_id_str = str(project_id)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id_str,
                    "sprint_closed",
                    {"id": sprint_id_str},
                )
            )
            # ADR-0147: emit the sprint.closed webhook. The completion snapshot in
            # the payload is team velocity and is privacy-gated by the builder
            # (ADR-0104) — built now, inside the close transaction, so the gate reads
            # the committed policy and the on_commit callback does no DB work.
            from trueppm_api.apps.projects.views import (
                _dispatch_webhooks,
                _sprint_closed_webhook_payload,
            )

            closed_payload = _sprint_closed_webhook_payload(sprint, source="sprint_close")
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id_str, "sprint.closed", closed_payload)
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
        # The whole close rolled back, so the sprint is still ACTIVE and the row
        # is safe to run again from the top. Schedule a retry until the budget is
        # spent; ``next_attempt_at=None`` on the last one is what makes it
        # terminal (#2894).
        #
        # Deliberately NOT re-raised to drive the decorator's max_retries. A
        # retry there re-enters close_sprint, which short-circuits on a FAILED
        # row and returns immediately — the retry would burn the budget without
        # ever reaching the work. The drain is the recovery path because it is
        # the thing that can reset status back to PENDING first.
        attempts = req.attempt_count + 1  # this run, already applied above
        exhausted = attempts >= _MAX_CLOSE_ATTEMPTS
        SprintCloseRequest.objects.filter(pk=req.pk).update(
            status=SprintCloseRequestStatus.FAILED,
            completed_at=timezone.now(),
            error_message=str(exc)[:1000],
            failure_reason=SprintCloseRequestFailureReason.ERROR,
            next_attempt_at=None if exhausted else timezone.now() + _CLOSE_RETRY_BACKOFF,
        )
        if exhausted:
            logger.error(
                "close_sprint: request %s exhausted %d attempts — sprint %s stays ACTIVE",
                request_id,
                attempts,
                req.sprint_id,
            )


def _finalize_non_closable_sprint(req: Any, sprint: Any) -> bool:
    """Finalize the close request if the locked sprint can't be closed; return handled.

    Returns True (and updates the ``SprintCloseRequest``) when the sprint is already
    COMPLETED (mark the request COMPLETED — an earlier dispatch closed it), CANCELLED,
    or otherwise not ACTIVE (mark the request FAILED). Returns False when the sprint is
    ACTIVE and the close should proceed.
    """
    from trueppm_api.apps.projects.models import (
        SprintCloseRequest,
        SprintCloseRequestFailureReason,
        SprintCloseRequestStatus,
        SprintState,
    )

    if sprint.state == SprintState.COMPLETED:
        # Already closed by an earlier dispatch; mark request done.
        SprintCloseRequest.objects.filter(pk=req.pk).update(
            status=SprintCloseRequestStatus.COMPLETED,
            completed_at=timezone.now(),
            next_attempt_at=None,
        )
        return True

    if sprint.state == SprintState.CANCELLED:
        SprintCloseRequest.objects.filter(pk=req.pk).update(
            status=SprintCloseRequestStatus.FAILED,
            completed_at=timezone.now(),
            error_message="Sprint was cancelled before close could complete.",
            failure_reason=SprintCloseRequestFailureReason.CANCELLED,
            # Terminal by nature: no retry can un-cancel a sprint. Leaving the
            # clock null is what keeps the drain's retry sweep off this row.
            next_attempt_at=None,
        )
        return True

    if sprint.state != SprintState.ACTIVE:
        SprintCloseRequest.objects.filter(pk=req.pk).update(
            status=SprintCloseRequestStatus.FAILED,
            completed_at=timezone.now(),
            error_message=f"Sprint state {sprint.state} is not closable.",
            failure_reason=SprintCloseRequestFailureReason.NOT_CLOSABLE,
            next_attempt_at=None,
        )
        return True

    return False


def _clear_sprint_ranks(sprint: Any) -> None:
    """Clear the within-sprint execution order on close (#365, ADR-0105 §5).

    A task returns to the product backlog ordered by ``priority_rank``; its
    closed-sprint ``sprint_rank`` stays queryable on the HistoricalTask rows (the
    pre-clear value on the create-time row, the null on the row the save() below
    writes). Runs BEFORE apply_carry_over so a carried task re-enters its next sprint
    un-ranked (re-seeded from priority_rank on that sprint's activate), never
    inheriting a stale rank. save() (not bulk_update) so server_version bumps +
    history is written.
    """
    from trueppm_api.apps.projects.models import Task

    for task in Task.objects.filter(sprint_id=sprint.pk, is_deleted=False):
        if task.sprint_rank is not None:
            task.sprint_rank = None
            task.save(update_fields=["sprint_rank", "server_version"])


def _recompute_and_reforecast_milestone(sprint: Any, req: Any) -> None:
    """Recompute the bound milestone rollup and reforecast its finish (ADR-0074/0106).

    ADR-0074: recompute the milestone rollup with the final ``completed_*`` snapshot.
    Runs inside the drain transaction, after carry-over, so the milestone reflects the
    closed sprint's final contribution before the sprint_closed broadcast goes out.

    ADR-0106 §3 (#860) — the bridge WOW: reforecast the bound milestone's finish as a
    range from the just-closed sprint's velocity. The snapshot write is synchronous
    (durable with the close); the milestone_forecast_updated broadcast + Enterprise-seam
    signal defer to on_commit inside the service. Wrapped non-blocking: a reforecast bug
    must never strand or revert a sprint close (ADR-0106 §Durable 8).
    """
    if sprint.target_milestone_id is None:
        return

    from trueppm_api.apps.projects.services import recompute_milestone_rollup

    recompute_milestone_rollup(sprint.target_milestone_id)

    try:
        from trueppm_api.apps.projects.services import (
            notify_milestone_forecast_shift,
            reforecast_bound_milestone,
        )

        forecast = reforecast_bound_milestone(sprint.target_milestone_id)
        # #861 — push the PM cohort the milestone-confidence shift so the bridge
        # reforecast isn't silent when the team closes the sprint outside the PM's
        # session. Non-blocking with the reforecast itself: a digest failure must
        # never strand close.
        if forecast is not None:
            notify_milestone_forecast_shift(forecast, sprint, actor_id=req.requested_by_id)
    except Exception:
        logger.exception(
            "close_sprint: reforecast failed for milestone %s — continuing close",
            sprint.target_milestone_id,
        )


def _compute_velocity_suggestions_safe(sprint: Any) -> None:
    """Compute velocity-calibration suggestions (ADR-0065), non-blocking on failure.

    Any error logs and is swallowed so a calibration bug cannot strand a sprint close.
    """
    try:
        from trueppm_api.apps.scheduling.services import compute_velocity_suggestions

        compute_velocity_suggestions(sprint.pk)
    except Exception:
        logger.exception(
            "close_sprint: velocity calibration failed for sprint %s — continuing close",
            sprint.pk,
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
    lock_key_template="generate_recurring_occurrences",
    lock_ttl=300,
    on_contention="skip",
    soft_time_limit=120,
    time_limit=180,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.generate_recurring_occurrences",
)
def generate_recurring_occurrences(self: object) -> None:
    """Lazily materialize upcoming occurrences for every active recurrence rule.

    Beat: hourly. Generates only occurrences due within
    ``settings.TRUEPPM_RECURRENCE_HORIZON_DAYS`` (a bounded look-ahead — never the
    full series) that do not already exist, honoring each rule's end condition.
    Idempotent via the (rule, date) unique constraint and the skip-on-contention
    lock; per-rule try/except so one malformed rule cannot starve the sweep (ADR-0090).
    """
    from django.conf import settings as dj_settings

    from trueppm_api.apps.projects.models import TaskRecurrenceRule
    from trueppm_api.apps.projects.services import _generate_due_occurrences
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    horizon = getattr(dj_settings, "TRUEPPM_RECURRENCE_HORIZON_DAYS", 14)
    total = 0
    # Collect new occurrence ids per project so each project's open boards get a
    # single bulk event rather than one per task.
    created_by_project: dict[str, list[str]] = {}
    rules = TaskRecurrenceRule.objects.filter(is_deleted=False).select_related(
        "task", "task__assignee"
    )
    for rule in rules:
        try:
            created = _generate_due_occurrences(rule, horizon_days=horizon)
        except Exception:
            logger.exception("generate_recurring_occurrences: failed for rule %s", rule.pk)
            continue
        for task in created:
            created_by_project.setdefault(str(task.project_id), []).append(str(task.id))
        total += len(created)
    if total:
        logger.info("generate_recurring_occurrences: created %d occurrence(s)", total)

    # Materialized occurrences are board-scoped tasks that show up on the project
    # board; without a broadcast a connected client only sees them on its next manual
    # refresh or delta pull (#1008). Emit one bulk event per project so open boards
    # live-update. Deferred via on_commit to honor the broadcast contract (broadcast
    # only after the rows are durably committed); this Beat task runs in autocommit,
    # where the occurrences are already committed and the callback fires immediately.
    for pid, task_ids in created_by_project.items():

        def _broadcast(pid: str = pid, ids: list[str] = task_ids) -> None:
            broadcast_board_event(pid, "tasks_bulk_mutated", {"task_ids": ids})

        transaction.on_commit(_broadcast)


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
    """Delete COMPLETED / *terminally* FAILED SprintCloseRequest rows older than 7 days.

    The retention window is measured from ``requested_at``, so a request that sat
    PENDING for longer than the window — a drain or broker outage, which the purge
    survives because it excludes PENDING — is already older than the cutoff the
    moment it finally runs. Without the ``next_attempt_at`` guard below, a
    transient failure on that first attempt would schedule a 60-second retry and
    the nightly purge could delete the row before the retry ever fired: the sprint
    stays ACTIVE *and* the record of why is gone, which is strictly worse than the
    stranding #2894 exists to fix. A row with a live retry clock is not finished,
    whatever its status says, so it is not eligible for retention purging.
    """
    from trueppm_api.apps.projects.models import (
        SprintCloseRequest,
        SprintCloseRequestStatus,
    )

    cutoff = timezone.now() - timedelta(days=7)
    deleted, _ = (
        SprintCloseRequest.objects.filter(
            status__in=[
                SprintCloseRequestStatus.COMPLETED,
                SprintCloseRequestStatus.FAILED,
            ],
            requested_at__lt=cutoff,
        )
        .exclude(
            status=SprintCloseRequestStatus.FAILED,
            next_attempt_at__isnull=False,
        )
        .delete()
    )
    logger.info("purge_sprint_close_requests: deleted %d row(s)", deleted)


# ---------------------------------------------------------------------------
# Soft-deleted project retention purge (#1114, ADR-0173)
# ---------------------------------------------------------------------------

# Projects hard-deleted per transaction. Each project's DB-level CASCADE loads
# its whole child subtree (tasks, edges, sprints, risks, baselines, …) into the
# collector, so — unlike the flat single-table purges (webhook/taskrun/sync) — the
# delete is bounded into batches to cap collector memory and lock-hold time. A
# soft-deleted project is already invisible to every reader (#1112), so spreading
# the hard-delete across several transactions has no user-visible effect.
_PROJECT_PURGE_BATCH_SIZE = 50


def _do_project_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_soft_deleted_projects — extracted for testability.

    Hard-deletes (row + DB CASCADE children) projects whose soft-delete age exceeds
    the window resolved by ``resolve_retention`` (operator override → the
    ``TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS`` default, ADR-0173); ``None``
    disables the purge (unbounded retention). Returns the number of ``Project`` rows
    deleted, or — when ``dry_run`` — the number eligible. ``override_value`` forces a
    hypothetical window (used by the System Health impact estimate).

    Eligibility is ``is_deleted=True AND deleted_at <= now - window``. A NULL
    ``deleted_at`` is deliberately **excluded**: a project soft-deleted before the
    ``deleted_at`` column existed has an unknown age and must never be silently
    hard-deleted — the safe default is to retain it (an operator can still remove it
    via ``?force=true``).

    Several FKs to Project are ``on_delete=PROTECT`` and would block a bare
    ``Project.delete()``, so the delete is delegated to ``hard_delete_projects``,
    which resolves those children reflectively from ``_meta`` and purges them first —
    the same helper the ``?force=true`` hard-delete path uses. This used to be a
    hand-written ``ProjectMembership`` pre-delete asserting it was the *only* PROTECT
    FK; that enumeration went stale when mention groups landed and a single project
    that had ever carried one aborted the whole batch (#2372).

    HistoricalProject rows are intentionally not touched here; they age out via the
    separate history retention purge.
    """
    from trueppm_api.apps.access.services import hard_delete_projects
    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.projects.models import Project

    retention_days = (
        override_value
        if override_value is not None
        else resolve_retention("TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS")
    )
    if retention_days is None:
        return 0

    cutoff = timezone.now() - timedelta(days=retention_days)
    eligible = Project.objects.filter(
        is_deleted=True,
        deleted_at__isnull=False,
        deleted_at__lte=cutoff,
    )
    if dry_run:
        return eligible.count()

    project_ids = list(eligible.values_list("pk", flat=True))
    deleted_projects = 0
    for start in range(0, len(project_ids), _PROJECT_PURGE_BATCH_SIZE):
        batch = project_ids[start : start + _PROJECT_PURGE_BATCH_SIZE]
        # hard_delete_projects is itself @transaction.atomic, so each batch remains a
        # single transaction — the batching still caps collector memory and lock-hold
        # time without one failure rolling back previously purged batches.
        deleted_projects += hard_delete_projects(batch)
    if deleted_projects:
        logger.info(
            "purge_soft_deleted_projects: hard-deleted %d soft-deleted project(s)",
            deleted_projects,
        )
    return deleted_projects


@idempotent_task(
    lock_key_template="purge_soft_deleted_projects",
    lock_ttl=600,
    on_contention="skip",
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.purge_soft_deleted_projects",
)
def purge_soft_deleted_projects(self: object) -> None:
    """Hard-delete soft-deleted projects past the retention window.

    Dispatchable directly, but not on its own Beat schedule — the consolidated
    retention coordinator (``retention.run_purge``) owns scheduled purging and picks
    this up via the ``purge_registry`` binding (ADR-0173 §C), running it alongside
    the other retention purges in one unified ``PurgeRun``.
    """
    _do_project_purge()


# ---------------------------------------------------------------------------
# Drain implementation — extracted for testability
# ---------------------------------------------------------------------------


_ORPHAN_WINDOW = timedelta(minutes=5)


def _do_drain() -> None:
    from trueppm_api.apps.projects.models import (
        SprintCloseRequest,
        SprintCloseRequestFailureReason,
        SprintCloseRequestStatus,
    )

    now = timezone.now()
    orphan_cutoff = now - _ORPHAN_WINDOW

    # Recover IN_FLIGHT rows that have stalled past the orphan window — the
    # task_id may not match anything live, so we reset and let the next
    # dispatch attempt acquire the per-request lock fresh.
    #
    # Bounded by the same budget as the failure path (#2894). ``close_sprint``
    # increments ``attempt_count`` on every entry, so a close that orphans rather
    # than raising — a worker OOM-killed on each attempt — was recovered here
    # without limit while the counter climbed forever. A constant named as *the*
    # close attempt budget that only one of the two recovery paths honors is a
    # guard narrower than the class it names, which is how this bug survived in
    # the failure path to begin with.
    recovered = SprintCloseRequest.objects.filter(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at__lt=orphan_cutoff,
        attempt_count__lt=_MAX_CLOSE_ATTEMPTS,
    ).update(status=SprintCloseRequestStatus.PENDING)

    # An orphan whose budget is spent must be *abandoned*, not left IN_FLIGHT.
    # Capping the recovery above without this would trade an unbounded loop for a
    # row wedged in a non-terminal state that no sweep touches and no reader can
    # interpret — the same silent stranding in a different status.
    abandoned = SprintCloseRequest.objects.filter(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at__lt=orphan_cutoff,
        attempt_count__gte=_MAX_CLOSE_ATTEMPTS,
    ).update(
        status=SprintCloseRequestStatus.FAILED,
        completed_at=now,
        next_attempt_at=None,
        error_message=(
            "The close stopped responding on every attempt and was abandoned. "
            "The sprint is still open."
        ),
        failure_reason=SprintCloseRequestFailureReason.STALLED,
    )
    if abandoned:
        logger.error(
            "drain_sprint_close_requests: abandoned %d close request(s) stalled past "
            "the attempt budget",
            abandoned,
        )
    if recovered:
        logger.warning(
            "drain_sprint_close_requests: recovered %d orphaned IN_FLIGHT row(s)",
            recovered,
        )

    # Re-queue FAILED rows whose retry clock has come round (#2894). Before this
    # the drain recovered IN_FLIGHT only, so a single unsnapshottable task left
    # the sprint ACTIVE indefinitely behind a terminally-FAILED request, with no
    # path back except manual DB intervention.
    #
    # `next_attempt_at__isnull=False` is the whole guard: a failure nothing can
    # fix (sprint cancelled, sprint not closable) and an exhausted budget both
    # leave it null, so neither is picked up here. `completed_at` is cleared so
    # the row does not read as finished while it waits to run again.
    # Capped like the dispatch slices below: a correlated failure could otherwise
    # flip an unbounded number of rows, and hold their locks, in one statement
    # inside a task that has a soft time limit.
    retry_ids = SprintCloseRequest.objects.filter(
        status=SprintCloseRequestStatus.FAILED,
        next_attempt_at__isnull=False,
        next_attempt_at__lte=now,
        attempt_count__lt=_MAX_CLOSE_ATTEMPTS,
    ).values("pk")[:_RETRY_REQUEUE_BUDGET]
    requeued = SprintCloseRequest.objects.filter(pk__in=retry_ids).update(
        status=SprintCloseRequestStatus.PENDING,
        next_attempt_at=None,
        completed_at=None,
        # Cleared alongside completed_at: a row waiting to run again has not
        # started, and a stale started_at would both misread on the API and feed
        # the orphan sweep above a start time from a previous attempt.
        started_at=None,
    )
    if requeued:
        logger.warning(
            "drain_sprint_close_requests: re-queued %d failed close request(s) for retry",
            requeued,
        )

    pending = list(
        SprintCloseRequest.objects.filter(
            status=SprintCloseRequestStatus.PENDING,
            requested_at__lt=now - timedelta(seconds=2),
            attempt_count=0,
        ).order_by("requested_at")[:_DISPATCH_BUDGET]
    )
    # Retries draw from their own budget rather than competing for the slice
    # above (#2894). A re-queued row keeps its original ``requested_at`` — that
    # field answers "when did the user ask", and the read route shows it — so it
    # sorts ahead of every newer close. Before the retry sweep existed nothing
    # old could re-enter the PENDING pool, so a single ordered slice was safe;
    # now a correlated failure would let the retry cohort fill the whole budget
    # and strand fresh user closes behind it. Two budgets, neither starving.
    pending += list(
        SprintCloseRequest.objects.filter(
            status=SprintCloseRequestStatus.PENDING,
            requested_at__lt=now - timedelta(seconds=2),
            attempt_count__gt=0,
        ).order_by("requested_at")[:_RETRY_DISPATCH_BUDGET]
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
    if dispatched or recovered or requeued:
        logger.info(
            "drain_sprint_close_requests: dispatched=%d recovered=%d requeued=%d",
            dispatched,
            recovered,
            requeued,
        )


# ---------------------------------------------------------------------------
# cascade_project_soft_delete — offloaded child tombstone cascade (#1112)
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="project_cascade_soft_delete:{0}",
    lock_ttl=600,
    on_contention="skip",
    max_retries=3,
    retry_backoff=10,
    retry_backoff_max=120,
    retry_jitter=True,
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.cascade_project_soft_delete",
)
def cascade_project_soft_delete(self: object, project_id: str) -> None:
    """Tombstone a soft-deleted project's children off the request path (#1112).

    ``ProjectViewSet.perform_destroy`` tombstones the project row synchronously
    (instant, so the project reads as gone) and enqueues this task to drain the
    potentially huge child cascade — tasks, dependency edges, sprints, risks, and
    baselines — that #1111 previously ran inline inside the request transaction.

    Idempotency: the cascade only touches rows still ``is_deleted=False``, so a
    broker-retry, a duplicate dispatch, or the ``on_contention="skip"`` lock all
    resolve to a safe no-op. A vanished project (hard-deleted in the meantime, so
    its children are gone via DB CASCADE) is simply skipped.

    No broadcast here: the ``project_deleted`` board event already fired from
    ``perform_destroy`` on commit, and child tombstones reach mobile clients via
    the sync delta pull (the ``sync_seq`` cursor this cascade stamps, ADR-0686),
    not over WebSocket — so there is nothing to re-broadcast and no double-fire
    risk.
    """
    from trueppm_api.apps.projects.models import (
        Project,
        cascade_project_children_soft_delete,
    )

    if not Project.objects.filter(pk=project_id).exists():
        logger.info(
            "cascade_project_soft_delete: project %s gone (hard-deleted?) — skipping",
            project_id,
        )
        return

    with transaction.atomic():
        cascade_project_children_soft_delete(project_id)
    logger.info("cascade_project_soft_delete: cascaded children for project %s", project_id)


# ---------------------------------------------------------------------------
# Async project export bundle (ADR-0219, #1266) — mirrors workspace export (ADR-0174)
# ---------------------------------------------------------------------------


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    max_retries=EXPORT_MAX_RETRIES,
    soft_time_limit=600,
    time_limit=660,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.run_project_export",
)
def run_project_export(self: object, job_id: str) -> None:
    """Build the project export bundle for ``job_id`` (ADR-0219).

    Idempotent: claims the job under ``select_for_update`` and no-ops unless it is
    ``pending``/``running``, so a duplicate delivery (broker retry, drain re-dispatch)
    cannot produce two archives. Transient failures retry up to ``EXPORT_MAX_RETRIES``
    (the job stays ``running`` so a retry is allowed); on exhaustion the job is marked
    ``failed`` and the Admin can request a fresh export.
    """
    from trueppm_api.apps.projects.export_bundle import build_and_store_project_archive
    from trueppm_api.apps.projects.models import ExportJobStatus, ProjectExportJob

    with transaction.atomic():
        job = ProjectExportJob.objects.select_for_update().filter(pk=job_id).first()
        if job is None:
            logger.warning("run_project_export: job %s not found", job_id)
            return
        if job.status not in (ExportJobStatus.PENDING, ExportJobStatus.RUNNING):
            logger.info("run_project_export: job %s already %s, skipping", job_id, job.status)
            return
        job.status = ExportJobStatus.RUNNING
        job.started_at = timezone.now()
        job.celery_task_id = getattr(getattr(self, "request", None), "id", "") or ""
        job.save(update_fields=["status", "started_at", "celery_task_id"])

    try:
        storage_path, size = build_and_store_project_archive(job_id)
    except Exception as exc:
        retries = getattr(getattr(self, "request", None), "retries", 0)
        if retries < EXPORT_MAX_RETRIES:
            logger.warning("run_project_export: job %s failed, retrying", job_id, exc_info=True)
            raise self.retry(exc=exc, countdown=10 * (2**retries)) from exc  # type: ignore[attr-defined]
        logger.exception("run_project_export: job %s failed permanently", job_id)
        ProjectExportJob.objects.filter(pk=job_id).update(
            status=ExportJobStatus.FAILED,
            error_detail=str(exc)[:2000],
            completed_at=timezone.now(),
        )
        return

    retention = _export_retention_days()
    expires_at = timezone.now() + timedelta(days=retention) if retention is not None else None
    ProjectExportJob.objects.filter(pk=job_id).update(
        status=ExportJobStatus.SUCCESS,
        file_path=storage_path,
        file_size=size,
        expires_at=expires_at,
        completed_at=timezone.now(),
        error_detail="",
    )


@idempotent_task(
    lock_key_template="drain_project_exports",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.drain_project_exports",
)
def drain_project_exports(self: object) -> None:
    """Re-dispatch project export jobs stuck in ``pending`` (broker down at on_commit)."""
    _do_drain_project_exports()


@idempotent_task(
    lock_key_template="purge_expired_project_exports",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.purge_expired_project_exports",
)
def purge_expired_project_exports(self: object) -> None:
    """Delete project export jobs past their link expiry, and their stored archives."""
    _do_purge_expired_project_exports()


def _export_retention_days() -> int | None:
    from django.conf import settings

    return getattr(settings, "TRUEPPM_EXPORT_RETENTION_DAYS", DEFAULT_EXPORT_RETENTION_DAYS)


def _do_drain_project_exports() -> None:
    from trueppm_api.apps.projects.models import ExportJobStatus, ProjectExportJob

    orphan_cutoff = timezone.now() - timedelta(minutes=EXPORT_ORPHAN_WINDOW_MINUTES)
    stuck = list(
        ProjectExportJob.objects.filter(
            status=ExportJobStatus.PENDING,
            celery_task_id="",
            created_at__lt=orphan_cutoff,
        ).order_by("created_at")[:EXPORT_DRAIN_BATCH_SIZE]
    )
    if not stuck:
        return
    for job in stuck:
        try:
            run_project_export.delay(str(job.id))
        except Exception:  # pragma: no cover - broker still down, next tick retries
            logger.warning("drain_project_exports: broker still unavailable for %s", job.id)
            break
    logger.info("drain_project_exports: re-dispatched %d job(s)", len(stuck))


def _do_purge_expired_project_exports() -> None:
    from django.core.files.storage import default_storage

    from trueppm_api.apps.projects.models import ProjectExportJob

    retention = _export_retention_days()
    if retention is None:  # retention disabled — keep archives indefinitely
        return
    expired = ProjectExportJob.objects.filter(expires_at__lt=timezone.now())
    count = 0
    for job in expired.iterator():
        if job.file_path:
            try:
                default_storage.delete(job.file_path)
            except OSError:  # pragma: no cover - storage drift, still drop the row
                logger.warning(
                    "purge_expired_project_exports: could not delete file for %s", job.id
                )
        job.delete()
        count += 1
    if count:
        logger.info("purge_expired_project_exports: deleted %d expired export(s)", count)


# ---------------------------------------------------------------------------
# Async program export bundle (ADR-0219, #1958) — the program-grain sibling of
# the project export tasks above; identical durable-execution shape.
# ---------------------------------------------------------------------------


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    max_retries=EXPORT_MAX_RETRIES,
    soft_time_limit=600,
    time_limit=660,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.run_program_export",
)
def run_program_export(self: object, job_id: str) -> None:
    """Build the program export bundle for ``job_id`` (ADR-0219, #1958).

    Idempotent: claims the job under ``select_for_update`` and no-ops unless it is
    ``pending``/``running``, so a duplicate delivery (broker retry, drain re-dispatch)
    cannot produce two archives. Transient failures retry up to ``EXPORT_MAX_RETRIES``;
    on exhaustion the job is marked ``failed`` and the Admin can request a fresh export.
    """
    from trueppm_api.apps.projects.export_bundle import build_and_store_program_archive
    from trueppm_api.apps.projects.models import ExportJobStatus, ProgramExportJob

    with transaction.atomic():
        job = ProgramExportJob.objects.select_for_update().filter(pk=job_id).first()
        if job is None:
            logger.warning("run_program_export: job %s not found", job_id)
            return
        if job.status not in (ExportJobStatus.PENDING, ExportJobStatus.RUNNING):
            logger.info("run_program_export: job %s already %s, skipping", job_id, job.status)
            return
        job.status = ExportJobStatus.RUNNING
        job.started_at = timezone.now()
        job.celery_task_id = getattr(getattr(self, "request", None), "id", "") or ""
        job.save(update_fields=["status", "started_at", "celery_task_id"])

    try:
        storage_path, size = build_and_store_program_archive(job_id)
    except Exception as exc:
        retries = getattr(getattr(self, "request", None), "retries", 0)
        if retries < EXPORT_MAX_RETRIES:
            logger.warning("run_program_export: job %s failed, retrying", job_id, exc_info=True)
            raise self.retry(exc=exc, countdown=10 * (2**retries)) from exc  # type: ignore[attr-defined]
        logger.exception("run_program_export: job %s failed permanently", job_id)
        ProgramExportJob.objects.filter(pk=job_id).update(
            status=ExportJobStatus.FAILED,
            error_detail=str(exc)[:2000],
            completed_at=timezone.now(),
        )
        return

    retention = _export_retention_days()
    expires_at = timezone.now() + timedelta(days=retention) if retention is not None else None
    ProgramExportJob.objects.filter(pk=job_id).update(
        status=ExportJobStatus.SUCCESS,
        file_path=storage_path,
        file_size=size,
        expires_at=expires_at,
        completed_at=timezone.now(),
        error_detail="",
    )


@idempotent_task(
    lock_key_template="drain_program_exports",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.drain_program_exports",
)
def drain_program_exports(self: object) -> None:
    """Re-dispatch program export jobs stuck in ``pending`` (broker down at on_commit)."""
    _do_drain_program_exports()


@idempotent_task(
    lock_key_template="purge_expired_program_exports",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.purge_expired_program_exports",
)
def purge_expired_program_exports(self: object) -> None:
    """Delete program export jobs past their link expiry, and their stored archives."""
    _do_purge_expired_program_exports()


def _do_drain_program_exports() -> None:
    from trueppm_api.apps.projects.models import ExportJobStatus, ProgramExportJob

    orphan_cutoff = timezone.now() - timedelta(minutes=EXPORT_ORPHAN_WINDOW_MINUTES)
    stuck = list(
        ProgramExportJob.objects.filter(
            status=ExportJobStatus.PENDING,
            celery_task_id="",
            created_at__lt=orphan_cutoff,
        ).order_by("created_at")[:EXPORT_DRAIN_BATCH_SIZE]
    )
    if not stuck:
        return
    for job in stuck:
        try:
            run_program_export.delay(str(job.id))
        except Exception:  # pragma: no cover - broker still down, next tick retries
            logger.warning("drain_program_exports: broker still unavailable for %s", job.id)
            break
    logger.info("drain_program_exports: re-dispatched %d job(s)", len(stuck))


def _do_purge_expired_program_exports() -> None:
    from django.core.files.storage import default_storage

    from trueppm_api.apps.projects.models import ProgramExportJob

    retention = _export_retention_days()
    if retention is None:  # retention disabled — keep archives indefinitely
        return
    expired = ProgramExportJob.objects.filter(expires_at__lt=timezone.now())
    count = 0
    for job in expired.iterator():
        if job.file_path:
            try:
                default_storage.delete(job.file_path)
            except OSError:  # pragma: no cover - storage drift, still drop the row
                logger.warning(
                    "purge_expired_program_exports: could not delete file for %s", job.id
                )
        job.delete()
        count += 1
    if count:
        logger.info("purge_expired_program_exports: deleted %d expired export(s)", count)


# ---------------------------------------------------------------------------
# Async program seed import (ADR-0726, #2574) — the mirror of the export tasks
# above. Same durable-execution shape; the payload travels through storage.
# ---------------------------------------------------------------------------

IMPORT_MAX_RETRIES = 3  # ADR-0726 §Durable Execution item 8
IMPORT_ORPHAN_WINDOW_MINUTES = 10  # ADR-0726 §Durable Execution item 3
IMPORT_DRAIN_BATCH_SIZE = 10


def _import_retention_days() -> int | None:
    """Days a terminal import job (and its stored payload) is kept; ``None`` disables."""
    from django.conf import settings

    value = getattr(settings, "TRUEPPM_IMPORT_RETENTION_DAYS", 7)
    return None if value in (None, 0) else int(value)


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    max_retries=IMPORT_MAX_RETRIES,
    soft_time_limit=1800,
    time_limit=1860,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.run_program_import",
)
def run_program_import(self: object, job_id: str) -> None:
    """Build the subtree for a queued seed import (ADR-0726, #2574).

    The request already did the parts that must be synchronous: it validated the
    document, resolved and performed any confirmed replacement, and created the
    program shell. This task only fills that shell, which is why it is *purely
    additive* — and why the claim below is load-bearing rather than decorative.
    A duplicate delivery (drain re-dispatch, ``acks_late`` redelivery after a
    worker loss) would otherwise run the whole build a second time into the same
    program and double every task, dependency, and sprint; ``Task`` carries no
    ``(project, wbs_path)`` unique constraint to catch it.

    Only transient faults retry. A validation or referential failure is
    deterministic — and the request already rejected those synchronously — so it
    goes straight to ``failed`` with the diagnostics on the row.

    A failed job deliberately leaves the empty program shell in place rather than
    cleaning it up: the replaced subtree is in Trash, and the Owner needs both the
    shell and the failed job row to reason about what happened.
    """
    import json

    from django.core.files.storage import default_storage

    from trueppm_api.apps.projects.models import ImportJobStatus, ProgramImportJob
    from trueppm_api.apps.projects.seed import SeedValidationError
    from trueppm_api.apps.projects.seed import import_seed as run_import

    with transaction.atomic():
        job = ProgramImportJob.objects.select_for_update().filter(pk=job_id).first()
        if job is None:
            logger.warning("run_program_import: job %s not found", job_id)
            return
        if job.status not in (ImportJobStatus.PENDING, ImportJobStatus.RUNNING):
            logger.info("run_program_import: job %s already %s, skipping", job_id, job.status)
            return
        job.status = ImportJobStatus.RUNNING
        job.started_at = timezone.now()
        job.celery_task_id = getattr(getattr(self, "request", None), "id", "") or ""
        job.save(update_fields=["status", "started_at", "celery_task_id"])

    program = job.program
    try:
        with default_storage.open(job.file_path, "rb") as handle:
            payload = json.loads(handle.read().decode("utf-8"))
    except Exception:
        # The payload is gone or unreadable: deterministic, so never retry. The
        # reason is logged, not persisted — a storage exception renders the
        # absolute key path, and ``error_detail`` is served verbatim to any
        # program Admin while ``file_path`` is deliberately withheld from the
        # same serializer.
        logger.exception("run_program_import: payload unreadable for job %s", job_id)
        _fail_import_job(job_id, "The uploaded seed could no longer be read. Re-import the file.")
        return

    try:
        # ``target_program`` adopts the shell the request created, which also
        # tells the importer to skip its own replace pass entirely — the
        # replacement, if any, already happened inside the request the operator
        # authorized (ADR-0726 §4).
        run_import(
            payload,
            owner=job.requested_by,
            create_users=False,
            target_program=program,
        )
    except SeedValidationError as exc:
        _fail_import_job(job_id, "; ".join(exc.errors)[:2000])
        return
    except Exception as exc:
        retries = getattr(getattr(self, "request", None), "retries", 0)
        if retries < IMPORT_MAX_RETRIES:
            logger.warning("run_program_import: job %s failed, retrying", job_id, exc_info=True)
            raise self.retry(exc=exc, countdown=10 * (2**retries)) from exc  # type: ignore[attr-defined]
        logger.exception("run_program_import: job %s failed permanently", job_id)
        _fail_import_job(job_id, str(exc)[:2000])
        return

    retention = _import_retention_days()
    expires_at = timezone.now() + timedelta(days=retention) if retention is not None else None
    ProgramImportJob.objects.filter(pk=job_id).update(
        status=ImportJobStatus.SUCCESS,
        result_summary=_import_summary(program),
        expires_at=expires_at,
        completed_at=timezone.now(),
        error_detail="",
    )


def _import_summary(program: Any) -> dict[str, int]:
    """Entity counts the polling client renders once the job reaches ``success``."""
    from trueppm_api.apps.projects.models import Dependency, Project, Sprint, Task

    project_ids = list(
        Project.objects.filter(program=program, is_deleted=False).values_list("pk", flat=True)
    )
    return {
        "projects": len(project_ids),
        "tasks": Task.objects.filter(project_id__in=project_ids, is_deleted=False).count(),
        "sprints": Sprint.objects.filter(project_id__in=project_ids, is_deleted=False).count(),
        "dependencies": Dependency.objects.filter(
            predecessor__project_id__in=project_ids, is_deleted=False
        ).count(),
    }


def _fail_import_job(job_id: str, detail: str) -> None:
    """Mark a job ``failed`` with a reason the polling client can render.

    Persisted rather than only logged: an async import failure has to be visible
    on the surface that launched it, which is the whole point of returning a job
    handle instead of a 504.
    """
    from trueppm_api.apps.projects.models import ImportJobStatus, ProgramImportJob

    retention = _import_retention_days()
    expires_at = timezone.now() + timedelta(days=retention) if retention is not None else None
    ProgramImportJob.objects.filter(pk=job_id).update(
        status=ImportJobStatus.FAILED,
        error_detail=detail or "The seed could not be imported.",
        expires_at=expires_at,
        completed_at=timezone.now(),
    )


@idempotent_task(
    lock_key_template="drain_program_imports",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.drain_program_imports",
)
def drain_program_imports(self: object) -> None:
    """Re-dispatch seed import jobs stuck in ``pending`` (broker down at on_commit)."""
    _do_drain_program_imports()


@idempotent_task(
    lock_key_template="purge_expired_program_imports",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.purge_expired_program_imports",
)
def purge_expired_program_imports(self: object) -> None:
    """Delete terminal seed import jobs past retention, and their stored payloads."""
    _do_purge_expired_program_imports()


def _do_drain_program_imports() -> None:
    from trueppm_api.apps.projects.models import ImportJobStatus, ProgramImportJob

    # Only rows whose on_commit dispatch demonstrably never landed: still
    # pending, never assigned a task id, and older than the window. A row inside
    # an open on_commit callback is invisible until commit, so the age floor is
    # what stops the drain racing an in-flight upload it would double-dispatch.
    orphan_cutoff = timezone.now() - timedelta(minutes=IMPORT_ORPHAN_WINDOW_MINUTES)
    stuck = list(
        ProgramImportJob.objects.filter(
            status=ImportJobStatus.PENDING,
            celery_task_id="",
            created_at__lt=orphan_cutoff,
        ).order_by("created_at")[:IMPORT_DRAIN_BATCH_SIZE]
    )
    if not stuck:
        return
    for job in stuck:
        try:
            run_program_import.delay(str(job.id))
        except Exception:  # pragma: no cover - broker still down, next tick retries
            logger.warning("drain_program_imports: broker still unavailable for %s", job.id)
            break
    logger.info("drain_program_imports: re-dispatched %d job(s)", len(stuck))


def _do_purge_expired_program_imports() -> None:
    from django.core.files.storage import default_storage

    from trueppm_api.apps.projects.models import ProgramImportJob

    retention = _import_retention_days()
    if retention is None:  # retention disabled — keep rows indefinitely
        return
    expired = ProgramImportJob.objects.filter(expires_at__lt=timezone.now())
    count = 0
    for job in expired.iterator():
        if job.file_path:
            try:
                default_storage.delete(job.file_path)
            except OSError:  # pragma: no cover - storage drift, still drop the row
                logger.warning(
                    "purge_expired_program_imports: could not delete payload for %s", job.id
                )
        job.delete()
        count += 1
    if count:
        logger.info("purge_expired_program_imports: deleted %d expired import(s)", count)


# ---------------------------------------------------------------------------
# Schedule outline batch operation undo ledgers (ADR-0810, #2756)
# ---------------------------------------------------------------------------
# PasteManyOperation and CascadeClassificationOperation, not CsvImportRequest —
# that table already has its own retention story (task_batch_services.py's
# import-fix section). Shaped like purge_expired_project_exports above, not the
# consolidated ADR-0173 retention coordinator (apps/observability): that
# coordinator's RETENTION_SPECS is a deliberately curated, count-asserted set of
# six tables surfaced in an operator-facing editor, and folding a seventh in
# would be scope beyond what #2756 asked for. A plain settings-driven purge,
# same shape as the export/import job purges already in this file, is
# consistent with the (lighter) precedent those set.


def _batch_operation_retention_days() -> int | None:
    from django.conf import settings

    return getattr(settings, "TRUEPPM_BATCH_OPERATION_RETENTION_DAYS", 30)


@idempotent_task(
    lock_key_template="purge_expired_batch_operations",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="projects.purge_expired_batch_operations",
)
def purge_expired_batch_operations(self: object) -> None:
    """Delete paste-many/cascade undo ledger rows past retention, undone or not."""
    _do_purge_expired_batch_operations()


def _do_purge_expired_batch_operations() -> None:
    from trueppm_api.apps.projects.models import CascadeClassificationOperation, PasteManyOperation

    retention = _batch_operation_retention_days()
    if retention is None:  # retention disabled — keep rows indefinitely
        return
    cutoff = timezone.now() - timedelta(days=retention)
    paste_deleted, _ = PasteManyOperation.objects.filter(created_at__lt=cutoff).delete()
    cascade_deleted, _ = CascadeClassificationOperation.objects.filter(
        created_at__lt=cutoff
    ).delete()
    total = paste_deleted + cascade_deleted
    if total:
        logger.info(
            "purge_expired_batch_operations: deleted %d paste-many + %d cascade row(s)",
            paste_deleted,
            cascade_deleted,
        )


# ---------------------------------------------------------------------------
# Template application (ADR-0789, #2729)
# ---------------------------------------------------------------------------
# Celery's autodiscover_tasks() only imports ``<app>/tasks.py``, so a task defined
# in a sibling module never registers and its Beat entry silently resolves to
# nothing — the drain would appear scheduled and never run. Re-exported here so
# the two template tasks are discovered, while their implementation stays in
# ``template_tasks.py`` next to the rest of the template code.
from trueppm_api.apps.projects.template_tasks import (  # noqa: E402
    apply_template,
    drain_template_apply_queue,
)

__all__ = ["apply_template", "drain_template_apply_queue"]
