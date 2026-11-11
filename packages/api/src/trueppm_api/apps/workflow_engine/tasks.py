"""Celery tasks for the default workflow backend (ADR-0080 §D).

``advance_workflow_step`` is the work task that executes one step of a workflow
chain: run the step's activity (once-and-only-once), record history, then either
enqueue the next step's outbox row or finish the workflow. It is dispatched by
the backend's ``enqueue_step`` and re-dispatched by ``workflows_outbox_drain``.

This module also owns the engine's Beat tasks: ``workflows_outbox_drain``
(re-dispatch stranded step rows), ``workflows_timer_drain`` (fire due sleep
timers), and ``purge_old_workflow_records`` (retention).

Idempotency under the outbox's at-least-once delivery comes from two guards: the
outbox row's terminal-status check (a re-delivered DONE/DEAD row is a no-op) and
a ``select_for_update`` on the workflow instance that serializes advancement, so
two copies of the same step cannot run the activity concurrently.

This is backend machinery (it may import Celery), not consumer code — it lives
in the app, never under ``workflows/consumers/``.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

if TYPE_CHECKING:
    from django.db.models import QuerySet

from trueppm_api.apps.workflow_engine.models import (
    WorkflowActivityExecution,
    WorkflowHistoryEvent,
    WorkflowInstance,
    WorkflowOutboxFailureReason,
    WorkflowOutboxRow,
    WorkflowOutboxStatus,
    WorkflowStatus,
    WorkflowTimer,
)
from trueppm_api.core.idempotent import idempotent_task
from trueppm_api.workflows.backends.default import (
    _TERMINAL_STATUSES,
    enqueue_step,
    record_history,
    run_activity_oaoo,
    step_context,
    workflow_context,
)
from trueppm_api.workflows.interface import NonRetryableError
from trueppm_api.workflows.registry import WORKFLOWS, WorkflowDefinition, WorkflowStep

logger = logging.getLogger(__name__)

# Re-dispatch PENDING step rows only once they are older than this, so the drain
# never races an in-flight enqueue_step on_commit dispatch (ADR-0080 §IN 3). A
# DISPATCHED row is considered orphaned past the recovery window (worker died
# before advance_workflow_step's 300 s time_limit), and reset to PENDING.
_OUTBOX_ORPHAN_WINDOW = timedelta(minutes=5)
_OUTBOX_RECOVERY_WINDOW = timedelta(minutes=10)
_OUTBOX_RETENTION = timedelta(days=7)

# How many times a step may run before the workflow is abandoned, and how long a
# failed attempt waits before the drain re-queues it (#2994). Enforced by the
# drain rather than the Celery decorator's ``max_retries``: a broker retry
# re-enters ``_do_advance`` and would hit the terminal-row short-circuit without
# running the step, spending the budget for nothing.
_MAX_STEP_ATTEMPTS = 3
_STEP_RETRY_BACKOFF = timedelta(seconds=60)
# Per-sweep cap on retries. Fresh rows and retries draw from separate dispatch
# budgets so a correlated failure cannot fill the budget with retries and strand
# fresh work.
_RETRY_DISPATCH_BUDGET = 10


def _mark_row(row: WorkflowOutboxRow, status: str, **extra: Any) -> None:
    WorkflowOutboxRow.objects.filter(id=row.id).update(status=status, **extra)


def _is_terminal_row(row: WorkflowOutboxRow) -> bool:
    """True when no attempt will ever run for ``row`` again.

    ``DEAD`` is terminal only without a live retry clock: with one it is a
    transient failure the drain will re-queue, and a redelivery may run it.
    """
    if row.status == WorkflowOutboxStatus.DONE:
        return True
    return row.status == WorkflowOutboxStatus.DEAD and row.next_attempt_at is None


def _complete(instance: WorkflowInstance, results: dict[str, Any]) -> None:
    """Finalize a workflow whose last step just completed.

    ``results`` is the already-aggregated activity output, passed in by the
    caller, which holds it from the step context it just built — re-querying
    ``WorkflowActivityExecution`` here would be a redundant scan on the
    completion path of every workflow.
    """
    instance.status = WorkflowStatus.COMPLETED
    instance.result = results
    instance.completed_at = timezone.now()
    instance.save(update_fields=["status", "result", "completed_at", "updated_at"])
    record_history(instance, "workflow_completed", {"result": results})


def _handle_failure(
    instance: WorkflowInstance,
    steps: list[WorkflowStep],
    failed_index: int,
    exc: Exception,
) -> None:
    """Saga rollback: compensate completed steps in reverse, then mark FAILED.

    Compensation is best-effort — a failed rollback is logged but does not stop
    the others, and never masks the original failure recorded on the instance.
    Only steps *before* the failed one are compensated; the failed step did not
    complete its side effect to a recorded result.

    A successfully compensated step's cached execution is deleted with it. That
    cache is what lets a restart (``restart_failed``) skip a completed step, and
    once its side effect is undone the cached result describes nothing. Keeping
    the fact in the cache itself, rather than only in the ``step_compensated``
    history event, matters because history is purged after
    ``WORKFLOW_HISTORY_RETENTION_DAYS`` while the instance and its executions are
    not: a guard reading history alone would stop protecting the restart.
    """
    context = step_context(instance)
    for index in range(failed_index - 1, -1, -1):
        step = steps[index]
        if step.compensate is None:
            continue
        try:
            step.compensate(context)
            WorkflowActivityExecution.objects.filter(
                workflow=instance, activity_name=step.name
            ).delete()
            record_history(instance, "step_compensated", {"step": step.name, "index": index})
        except Exception:  # TODO(#4421): also swallows SoftTimeLimitExceeded
            logger.exception(
                "compensation failed for step %s of workflow %s", step.name, instance.id
            )
    instance.status = WorkflowStatus.FAILED
    instance.error = repr(exc)
    instance.completed_at = timezone.now()
    instance.save(update_fields=["status", "error", "completed_at", "updated_at"])
    record_history(
        instance, "workflow_failed", {"step": steps[failed_index].name, "error": str(exc)}
    )


def _do_advance(outbox_row_id: str) -> None:
    """Execute one workflow step. Extracted from the task body so tests can call
    it directly without a Celery worker (the codebase convention for drains)."""
    try:
        row = WorkflowOutboxRow.objects.select_related("workflow").get(id=outbox_row_id)
    except WorkflowOutboxRow.DoesNotExist:
        logger.warning("advance_workflow_step: outbox row %s no longer exists", outbox_row_id)
        return
    # Any DEAD row is out of this delivery's hands: terminal without a clock, and
    # with one it belongs to the drain, which flips it to PENDING before it
    # dispatches a retry. A DEAD row reaching here is a stray redelivery
    # (acks_late, reject_on_worker_lost, orphan re-dispatch) and must be a no-op —
    # it once cleared the live clock and stranded the workflow RUNNING (#2994).
    if _is_terminal_row(row) or row.status == WorkflowOutboxStatus.DEAD:
        return

    # Count this entry BEFORE the atomic block, and keep it out of it: the budget
    # is the only thing bounding the drain's re-queue loop and it compares
    # attempt_count. Inside the block a failing step rolls the increment back with
    # the work, the budget is never spent, and a permanent failure retries forever.
    # The clock is not touched here: ``_requeue_failed_rows`` already cleared it,
    # and the status filter keeps a row that died meanwhile from being counted.
    WorkflowOutboxRow.objects.filter(id=row.id).exclude(
        status__in=[WorkflowOutboxStatus.DONE, WorkflowOutboxStatus.DEAD]
    ).update(attempt_count=F("attempt_count") + 1)

    with transaction.atomic():
        instance = WorkflowInstance.objects.select_for_update().get(id=row.workflow_id)
        # Re-read the row under the instance lock: a concurrent delivery may have
        # finished it between our first read and acquiring the lock. A DEAD row
        # with a live clock is left exactly as it is, clock included.
        row.refresh_from_db()
        if _is_terminal_row(row) or row.status == WorkflowOutboxStatus.DEAD:
            return
        if instance.status in _TERMINAL_STATUSES:
            _mark_row(row, WorkflowOutboxStatus.DONE, next_attempt_at=None)
            return

        definition: WorkflowDefinition = WORKFLOWS.get(instance.name)
        steps = definition.build_steps(instance.input)
        step_index = int(row.step_input.get("step_index", 0))
        if step_index >= len(steps):
            logger.warning(
                "advance_workflow_step: step_index %s out of range (%s steps) for workflow %s",
                step_index,
                len(steps),
                instance.id,
            )
            _mark_row(row, WorkflowOutboxStatus.DONE, next_attempt_at=None)
            return

        step = steps[step_index]
        if instance.status != WorkflowStatus.RUNNING:
            instance.status = WorkflowStatus.RUNNING
            instance.save(update_fields=["status", "updated_at"])

        context = step_context(instance)
        try:
            # Its own savepoint, so a failed attempt's partial writes roll back
            # before the retry runs; the instance lock and history survive.
            with workflow_context(str(instance.id)), transaction.atomic():
                result = run_activity_oaoo(instance, step.name, context, step.activity)
        except Exception as exc:
            unfixable = isinstance(exc, NonRetryableError)
            if unfixable or row.attempt_count >= _MAX_STEP_ATTEMPTS:
                # Terminal: roll the saga back and clear the retry clock.
                _handle_failure(instance, steps, step_index, exc)
                _mark_row(
                    row,
                    WorkflowOutboxStatus.DEAD,
                    next_attempt_at=None,
                    failure_reason=(
                        WorkflowOutboxFailureReason.UNFIXABLE
                        if unfixable
                        else WorkflowOutboxFailureReason.ERROR
                    ),
                    error_message=repr(exc)[:1000],
                )
            else:
                # Transient: do NOT compensate or fail the workflow yet — the
                # drain re-queues this row and the earlier steps' cached results
                # let the retry resume at the failed step.
                logger.warning(
                    "advance_workflow_step: row %s attempt %d failed — will retry",
                    row.id,
                    row.attempt_count,
                    exc_info=True,
                )
                record_history(
                    instance,
                    "step_retry_scheduled",
                    {"step": step.name, "attempt": row.attempt_count, "error": str(exc)},
                )
                _mark_row(
                    row,
                    WorkflowOutboxStatus.DEAD,
                    next_attempt_at=timezone.now() + _STEP_RETRY_BACKOFF,
                    failure_reason=WorkflowOutboxFailureReason.ERROR,
                    error_message=repr(exc)[:1000],
                )
            return

        record_history(
            instance,
            "step_completed",
            {"step": step.name, "index": step_index, "result": result},
        )
        _mark_row(
            row,
            WorkflowOutboxStatus.DONE,
            next_attempt_at=None,
            failure_reason="",
            error_message="",
        )

        if step_index + 1 < len(steps):
            enqueue_step(str(instance.id), step_index + 1)
        else:
            # The final aggregate is the prior-step results (already fetched into
            # the step context, excluding None) plus this step's result. Holding
            # the instance lock, no other step can have written an execution
            # between step_context() and here, so this reproduces the full scan
            # without re-querying. None results stay excluded, matching get_state.
            results = dict(context["prior"])
            if result is not None:
                results[step.name] = result
            _complete(instance, results)


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    name="workflows.advance_step",
    soft_time_limit=240,
    time_limit=300,
    acks_late=True,
    reject_on_worker_lost=True,
)
def advance_workflow_step(self: object, outbox_row_id: str) -> None:
    """Advance one workflow step. See :func:`_do_advance`.

    ``time_limit`` (300 s) is kept at or below the workflow outbox drain's
    orphan window so a killed step is dead before the drain re-dispatches its row.
    """
    _do_advance(outbox_row_id)


# ---------------------------------------------------------------------------
# Beat tasks: drain, timer fire, retention
# ---------------------------------------------------------------------------


def _do_outbox_drain() -> None:
    """Re-dispatch stranded step rows and recover orphaned dispatched rows.

    Only PENDING rows older than the orphan window are re-dispatched, so the
    drain never races an in-flight ``enqueue_step`` ``on_commit`` dispatch.
    DISPATCHED rows past the recovery window are treated as orphaned (the worker
    died) and reset to PENDING.
    """
    now = timezone.now()
    # Bounded by the same budget as the failure path (#2994): ``_do_advance``
    # counts every entry, so a worker that dies on each attempt (OOM) used to be
    # recovered without limit while the counter climbed forever.
    orphan_cutoff = now - _OUTBOX_RECOVERY_WINDOW
    recovered = WorkflowOutboxRow.objects.filter(
        status=WorkflowOutboxStatus.DISPATCHED,
        dispatched_at__lt=orphan_cutoff,
        attempt_count__lt=_MAX_STEP_ATTEMPTS,
    ).update(status=WorkflowOutboxStatus.PENDING, celery_task_id="")
    _abandon_stalled_rows(orphan_cutoff)
    if recovered:
        logger.warning("workflows_outbox_drain: recovered %d orphaned dispatched row(s)", recovered)

    pending = list(
        WorkflowOutboxRow.objects.filter(
            status=WorkflowOutboxStatus.PENDING,
            created_at__lt=now - _OUTBOX_ORPHAN_WINDOW,
        ).order_by("created_at")[: settings.WORKFLOW_DRAIN_BATCH_SIZE]
    )
    dispatched = 0
    for row in pending:
        try:
            result = advance_workflow_step.delay(str(row.id))
        except SoftTimeLimitExceeded:
            raise
        except Exception:
            logger.warning(
                "workflows_outbox_drain: broker unavailable — row %s stays pending", row.id
            )
            continue
        WorkflowOutboxRow.objects.filter(id=row.id, status=WorkflowOutboxStatus.PENDING).update(
            status=WorkflowOutboxStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
        dispatched += 1
    retried = _requeue_failed_rows(now)
    if dispatched or recovered or retried:
        logger.info(
            "workflows_outbox_drain: dispatched=%d recovered=%d retried=%d",
            dispatched,
            recovered,
            retried,
        )


def _abandon_stalled_rows(orphan_cutoff: Any) -> None:
    """Abandon orphaned DISPATCHED rows whose attempt budget is spent.

    Capping recovery without this would trade an unbounded loop for a row wedged
    in a non-terminal status that no sweep touches and no reader can interpret.
    The workflow is failed without compensation: we cannot know whether the
    stalled step's side effect landed, and undoing earlier steps on that
    uncertainty is worse than reporting the stall.
    """
    stalled = list(
        WorkflowOutboxRow.objects.filter(
            status=WorkflowOutboxStatus.DISPATCHED,
            dispatched_at__lt=orphan_cutoff,
            attempt_count__gte=_MAX_STEP_ATTEMPTS,
        )[: settings.WORKFLOW_DRAIN_BATCH_SIZE]
    )
    message = "The step stopped responding on every attempt and was abandoned."
    for row in stalled:
        with transaction.atomic():
            instance = WorkflowInstance.objects.select_for_update().get(id=row.workflow_id)
            _mark_row(
                row,
                WorkflowOutboxStatus.DEAD,
                next_attempt_at=None,
                failure_reason=WorkflowOutboxFailureReason.STALLED,
                error_message=message,
            )
            if instance.status not in _TERMINAL_STATUSES:
                instance.status = WorkflowStatus.FAILED
                instance.error = message
                instance.completed_at = timezone.now()
                instance.save(update_fields=["status", "error", "completed_at", "updated_at"])
                record_history(
                    instance, "workflow_failed", {"step": row.step_name, "error": message}
                )
    if stalled:
        logger.error(
            "workflows_outbox_drain: abandoned %d stalled step row(s) past the attempt budget",
            len(stalled),
        )


def _requeue_failed_rows(now: Any) -> int:
    """Re-queue transiently failed ``DEAD`` rows whose retry clock has come round.

    Before #2994 the drain recovered only orphaned ``DISPATCHED`` rows, so one
    transient failure stranded the workflow permanently. ``next_attempt_at`` not
    null is the whole guard: unfixable failures and exhausted budgets leave it
    null and are never picked up. Retries get their own dispatch budget, and
    only the rows dispatched this sweep leave ``DEAD``.
    """
    ids = list(
        WorkflowOutboxRow.objects.filter(
            status=WorkflowOutboxStatus.DEAD,
            next_attempt_at__isnull=False,
            next_attempt_at__lte=now,
            attempt_count__lt=_MAX_STEP_ATTEMPTS,
        )
        .order_by("next_attempt_at")
        .values_list("id", flat=True)[:_RETRY_DISPATCH_BUDGET]
    )
    if not ids:
        return 0
    # Flip only what this sweep dispatches. Flipping a wider slice left the
    # undispatched remainder PENDING with an old ``created_at``, where the
    # fresh-row pass picked it up next sweep and bypassed the retry budget.
    WorkflowOutboxRow.objects.filter(id__in=ids, status=WorkflowOutboxStatus.DEAD).update(
        status=WorkflowOutboxStatus.PENDING, next_attempt_at=None, celery_task_id=""
    )
    for row_id in ids:
        try:
            result = advance_workflow_step.delay(str(row_id))
        except SoftTimeLimitExceeded:
            raise
        except Exception:
            logger.warning(
                "workflows_outbox_drain: broker unavailable — retry row %s stays pending", row_id
            )
            continue
        WorkflowOutboxRow.objects.filter(id=row_id, status=WorkflowOutboxStatus.PENDING).update(
            status=WorkflowOutboxStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
    return len(ids)


def _do_timer_drain() -> None:
    """Fire due sleep timers and wake the sleeping workflows.

    v1 records the wake (SLEEPING → RUNNING) durably and marks the timer fired.
    Re-entering the step chain from a mid-chain sleep is a later enhancement —
    v1 linear chains do not sleep — so the timer infra is durable without
    prematurely wiring chain resumption.
    """
    now = timezone.now()
    due = list(
        WorkflowTimer.objects.filter(fired=False, fire_at__lte=now).order_by("fire_at")[
            : settings.WORKFLOW_DRAIN_BATCH_SIZE
        ]
    )
    fired = 0
    for timer in due:
        with transaction.atomic():
            instance = WorkflowInstance.objects.select_for_update().get(id=timer.workflow_id)
            WorkflowTimer.objects.filter(id=timer.id, fired=False).update(fired=True)
            record_history(instance, "timer_fired", {"timer_id": str(timer.id)})
            if instance.status == WorkflowStatus.SLEEPING:
                instance.status = WorkflowStatus.RUNNING
                instance.save(update_fields=["status", "updated_at"])
        fired += 1
    if fired:
        logger.info("workflows_timer_drain: fired=%d", fired)


def _chunked_delete(queryset: QuerySet[Any], batch_size: int) -> int:
    """Delete every row matching ``queryset`` in bounded ``batch_size`` chunks.

    Each chunk is a separate statement, so the purge never holds a single lock
    over an unbounded slice of the table — important on the first run of a mature
    install, where the eligible set can be a large fraction of the table. The
    filter is re-evaluated per pass, so rows deleted (or newly written) between
    passes are naturally excluded.
    """
    model = queryset.model
    total = 0
    while True:
        batch_ids = list(queryset.values_list("pk", flat=True)[:batch_size])
        if not batch_ids:
            break
        deleted, _ = model.objects.filter(pk__in=batch_ids).delete()
        total += deleted
        if len(batch_ids) < batch_size:
            break
    return total


def _do_purge_workflow_records() -> None:
    """Delete terminal step rows past 7 days and history past the retention window."""
    now = timezone.now()
    batch_size = settings.WORKFLOW_PURGE_BATCH_SIZE
    outbox_deleted = _chunked_delete(
        WorkflowOutboxRow.objects.filter(
            status__in=[WorkflowOutboxStatus.DONE, WorkflowOutboxStatus.DEAD],
            created_at__lt=now - _OUTBOX_RETENTION,
        )
        # A DEAD row with a live retry clock is not finished, whatever its status
        # says: the window runs from creation, so a row that waited out an outage
        # is already past the cutoff and its retry could be deleted before it fires.
        .exclude(next_attempt_at__isnull=False),
        batch_size,
    )
    history_days = settings.WORKFLOW_HISTORY_RETENTION_DAYS
    history_deleted = 0
    if history_days:
        history_deleted = _chunked_delete(
            WorkflowHistoryEvent.objects.filter(
                created_at__lt=now - timedelta(days=history_days),
            ),
            batch_size,
        )
    logger.info("purge_old_workflow_records: outbox=%d history=%d", outbox_deleted, history_deleted)


@idempotent_task(
    lock_key_template="workflows_outbox_drain",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workflows.outbox_drain",
)
def workflows_outbox_drain(self: object) -> None:
    """Re-dispatch stranded workflow step rows every 30 s (ADR-0080 §D)."""
    _do_outbox_drain()


@idempotent_task(
    lock_key_template="workflows_timer_drain",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workflows.timer_drain",
)
def workflows_timer_drain(self: object) -> None:
    """Fire due sleep timers and wake their workflows."""
    _do_timer_drain()


@idempotent_task(
    lock_key_template="purge_old_workflow_records",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workflows.purge_old_records",
)
def purge_old_workflow_records(self: object) -> None:
    """Nightly retention sweep: terminal outbox rows >7 d, history past window."""
    _do_purge_workflow_records()
