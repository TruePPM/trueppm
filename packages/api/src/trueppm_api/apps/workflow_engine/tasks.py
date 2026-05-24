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

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.workflow_engine.models import (
    WorkflowActivityExecution,
    WorkflowHistoryEvent,
    WorkflowInstance,
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
from trueppm_api.workflows.registry import WORKFLOWS, WorkflowDefinition, WorkflowStep

logger = logging.getLogger(__name__)

_DONE_OR_DEAD = (WorkflowOutboxStatus.DONE, WorkflowOutboxStatus.DEAD)

# Re-dispatch PENDING step rows only once they are older than this, so the drain
# never races an in-flight enqueue_step on_commit dispatch (ADR-0080 §IN 3). A
# DISPATCHED row is considered orphaned past the recovery window (worker died
# before advance_workflow_step's 300 s time_limit), and reset to PENDING.
_OUTBOX_ORPHAN_WINDOW = timedelta(minutes=5)
_OUTBOX_RECOVERY_WINDOW = timedelta(minutes=10)
_OUTBOX_RETENTION = timedelta(days=7)


def _mark_row(row: WorkflowOutboxRow, status: str) -> None:
    WorkflowOutboxRow.objects.filter(id=row.id).update(status=status)


def _complete(instance: WorkflowInstance) -> None:
    """Finalize a workflow whose last step just completed."""
    results = {
        execution.activity_name: execution.result
        for execution in WorkflowActivityExecution.objects.filter(workflow=instance).exclude(
            result=None
        )
    }
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
    """
    context = step_context(instance)
    for index in range(failed_index - 1, -1, -1):
        step = steps[index]
        if step.compensate is None:
            continue
        try:
            step.compensate(context)
            record_history(instance, "step_compensated", {"step": step.name, "index": index})
        except Exception:
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
    if row.status in _DONE_OR_DEAD:
        return

    with transaction.atomic():
        instance = WorkflowInstance.objects.select_for_update().get(id=row.workflow_id)
        # Re-read the row under the instance lock: a concurrent delivery may have
        # finished it between our first read and acquiring the lock.
        row.refresh_from_db()
        if row.status in _DONE_OR_DEAD:
            return
        if instance.status in _TERMINAL_STATUSES:
            _mark_row(row, WorkflowOutboxStatus.DONE)
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
            _mark_row(row, WorkflowOutboxStatus.DONE)
            return

        step = steps[step_index]
        if instance.status != WorkflowStatus.RUNNING:
            instance.status = WorkflowStatus.RUNNING
            instance.save(update_fields=["status", "updated_at"])

        context = step_context(instance)
        try:
            with workflow_context(str(instance.id)):
                result = run_activity_oaoo(instance, step.name, context, step.activity)
        except Exception as exc:
            _handle_failure(instance, steps, step_index, exc)
            _mark_row(row, WorkflowOutboxStatus.DEAD)
            return

        record_history(
            instance,
            "step_completed",
            {"step": step.name, "index": step_index, "result": result},
        )
        _mark_row(row, WorkflowOutboxStatus.DONE)

        if step_index + 1 < len(steps):
            enqueue_step(str(instance.id), step_index + 1)
        else:
            _complete(instance)


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
    recovered = WorkflowOutboxRow.objects.filter(
        status=WorkflowOutboxStatus.DISPATCHED,
        dispatched_at__lt=now - _OUTBOX_RECOVERY_WINDOW,
    ).update(status=WorkflowOutboxStatus.PENDING, celery_task_id="")
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
    if dispatched or recovered:
        logger.info("workflows_outbox_drain: dispatched=%d recovered=%d", dispatched, recovered)


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


def _do_purge_workflow_records() -> None:
    """Delete terminal step rows past 7 days and history past the retention window."""
    now = timezone.now()
    outbox_deleted, _ = WorkflowOutboxRow.objects.filter(
        status__in=[WorkflowOutboxStatus.DONE, WorkflowOutboxStatus.DEAD],
        created_at__lt=now - _OUTBOX_RETENTION,
    ).delete()
    history_days = settings.WORKFLOW_HISTORY_RETENTION_DAYS
    history_deleted = 0
    if history_days:
        history_deleted, _ = WorkflowHistoryEvent.objects.filter(
            created_at__lt=now - timedelta(days=history_days),
        ).delete()
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
