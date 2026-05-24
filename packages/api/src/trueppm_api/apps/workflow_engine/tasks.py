"""Celery tasks for the default workflow backend (ADR-0080 §D).

``advance_workflow_step`` is the work task that executes one step of a workflow
chain: run the step's activity (once-and-only-once), record history, then either
enqueue the next step's outbox row or finish the workflow. It is dispatched by
the backend's ``enqueue_step`` and re-dispatched by ``workflows_outbox_drain``
(the Beat drain lands in a later commit).

Idempotency under the outbox's at-least-once delivery comes from two guards: the
outbox row's terminal-status check (a re-delivered DONE/DEAD row is a no-op) and
a ``select_for_update`` on the workflow instance that serializes advancement, so
two copies of the same step cannot run the activity concurrently.

This is backend machinery (it may import Celery), not consumer code — it lives
in the app, never under ``workflows/consumers/``.
"""

from __future__ import annotations

import logging

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.workflow_engine.models import (
    WorkflowActivityExecution,
    WorkflowInstance,
    WorkflowOutboxRow,
    WorkflowOutboxStatus,
    WorkflowStatus,
)
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
