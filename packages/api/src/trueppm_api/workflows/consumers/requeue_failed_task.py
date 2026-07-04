"""Requeue-failed-task workflow — the first consumer of the durable backend (ADR-0210).

An operator requeue of a dead-lettered Celery task must round-trip through the
#652 outbox-composing workflow backend (ADR-0080), *not* the raw
``current_app.send_task`` side channel it replaces. This single-step workflow is
how it does so: starting it via ``workflows.services.start_workflow`` writes a
``WorkflowOutboxRow`` inside the request transaction and dispatches on
``transaction.on_commit``; if the broker is down the ``workflows_outbox_drain``
Beat task re-dispatches it, so the re-enqueue is durable.

The one step, ``redispatch``, re-enqueues the original task. Per ADR-0080 §E this
consumer module never imports Celery directly — it delegates the actual
``send_task`` to ``scheduling.services.redispatch_dead_lettered_task``, the domain
service that owns the engine boundary. The operator-chosen backoff is applied there
as a Celery ``countdown`` (ADR-0210 §2: v1 has no chain-resuming durable ``sleep``,
so the *delay* is best-effort while the *re-enqueue* is durable via the outbox).

The activity is executed once-and-only-once by the engine (unique
``(workflow, activity_name, input_hash)``), so an at-least-once outbox redelivery
cannot double-dispatch the original task.
"""

from __future__ import annotations

from typing import Any

from trueppm_api.workflows.registry import WorkflowDefinition, WorkflowStep

WORKFLOW_NAME = "scheduling.requeue_failed_task"


def _redispatch_activity(ctx: dict[str, Any]) -> dict[str, Any] | None:
    """Re-enqueue the original Celery task with the operator's backoff.

    ``ctx`` is the engine-supplied step context: ``ctx["workflow_input"]`` holds the
    requeue input assembled by the viewset. Delegates to the scheduling service so
    this consumer stays free of a direct Celery import (ADR-0080 §E).
    """
    # Imported lazily and from the service layer (not `celery`) to honour the
    # consumer import discipline; the service owns the `send_task` boundary.
    from trueppm_api.apps.scheduling.services import redispatch_dead_lettered_task

    wf_input = ctx["workflow_input"]
    dispatched_task_id = redispatch_dead_lettered_task(
        task_name=wf_input["task_name"],
        args=wf_input.get("args", []),
        kwargs=wf_input.get("kwargs", {}),
        countdown=int(wf_input.get("backoff_seconds", 0) or 0),
    )
    return {
        "failed_task_id": wf_input.get("failed_task_id"),
        "dispatched_task_id": dispatched_task_id,
    }


class RequeueFailedTaskWorkflow(WorkflowDefinition):
    """One-step workflow that durably re-dispatches a dead-lettered Celery task."""

    name = WORKFLOW_NAME

    def build_steps(self, workflow_input: dict[str, Any]) -> list[WorkflowStep]:
        # Single step, no compensation: re-enqueueing is the terminal side effect and
        # there is nothing to undo — if the re-dispatched task fails again it simply
        # dead-letters back into FailedTask (ADR-0210 §Durable Execution 8).
        return [WorkflowStep(name="redispatch", activity=_redispatch_activity)]
