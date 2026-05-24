"""Default workflow backend — outbox-composing, Celery-driven (ADR-0080 §A, §D).

Executes a declarative :class:`~trueppm_api.workflows.registry.WorkflowDefinition`
step-by-step. Each step-advance writes a ``WorkflowOutboxRow`` in the same
transaction as the state change and dispatches it via ``transaction.on_commit``,
so a broker outage between commit and dispatch cannot drop a step — the
``workflows_outbox_drain`` Beat task re-dispatches stranded rows. Activities are
once-and-only-once at ``(workflow, activity_name, input_hash)``, which makes the
backend safe under the outbox's at-least-once delivery.

This module is a backend implementation, not consumer code — it may import
Django and (lazily) Celery. The shared engine helpers live here so the step task
(:mod:`trueppm_api.apps.workflow_engine.tasks`) can reuse them without a circular import.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
from collections.abc import Iterator
from contextvars import ContextVar
from datetime import timedelta
from typing import Any

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from trueppm_api.apps.workflow_engine.models import (
    WorkflowActivityExecution,
    WorkflowHistoryEvent,
    WorkflowInstance,
    WorkflowOutboxRow,
    WorkflowOutboxStatus,
    WorkflowSignal,
    WorkflowStatus,
    WorkflowTimer,
)
from trueppm_api.workflows.interface import (
    HistoryEvent,
    RetryPolicy,
    WorkflowBackend,
    WorkflowState,
)
from trueppm_api.workflows.interface import (
    WorkflowStatus as IWorkflowStatus,
)
from trueppm_api.workflows.registry import WORKFLOWS, Activity, WorkflowDefinition

logger = logging.getLogger(__name__)

_TERMINAL_STATUSES = frozenset(
    {WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELED}
)

# Ambient "currently-executing workflow" id, set by the step task while an
# activity runs so that run_activity() (called from within an activity) can
# resolve its workflow without an explicit id. The codebase otherwise threads
# context explicitly; this is the one place an implicit handle is warranted, and
# it is confined to the default backend's execution window.
_current_workflow_id: ContextVar[str | None] = ContextVar(
    "trueppm_current_workflow_id", default=None
)


# ---------------------------------------------------------------------------
# Shared engine helpers (used here and by the step task)
# ---------------------------------------------------------------------------


def canonical_hash(obj: Any) -> str:
    """Stable SHA-256 of a JSON-able object — order-independent for dicts."""
    encoded = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def default_idempotency_key(name: str, workflow_input: dict[str, Any]) -> str:
    """Deterministic start-dedup key: a retried start of the same name+input
    collides on ``WorkflowInstance.idempotency_key`` and returns the original."""
    return canonical_hash({"name": name, "input": workflow_input})


def record_history(
    instance: WorkflowInstance, event_type: str, payload: dict[str, Any]
) -> WorkflowHistoryEvent:
    """Append an ordered history event. Must be called while holding the
    instance row lock so the per-workflow ``seq`` is allocated race-free."""
    last_seq = WorkflowHistoryEvent.objects.filter(workflow=instance).aggregate(m=Max("seq"))["m"]
    seq = 0 if last_seq is None else last_seq + 1
    return WorkflowHistoryEvent.objects.create(
        workflow=instance, seq=seq, event_type=event_type, payload=payload
    )


@contextlib.contextmanager
def workflow_context(workflow_id: str) -> Iterator[None]:
    """Bind the ambient workflow id for the duration of a step execution."""
    token = _current_workflow_id.set(workflow_id)
    try:
        yield
    finally:
        _current_workflow_id.reset(token)


def step_context(instance: WorkflowInstance) -> dict[str, Any]:
    """The dict every step activity receives: the workflow input plus the
    results of all previously-completed activities, keyed by activity name."""
    prior = {
        execution.activity_name: execution.result
        for execution in WorkflowActivityExecution.objects.filter(workflow=instance).exclude(
            result=None
        )
    }
    return {"workflow_input": instance.input, "prior": prior}


def run_activity_oaoo(
    instance: WorkflowInstance,
    activity_name: str,
    activity_input: dict[str, Any],
    activity: Activity,
) -> dict[str, Any] | None:
    """Execute an activity once-and-only-once.

    A prior successful execution (matching ``(workflow, activity_name,
    input_hash)``) returns its recorded result without re-running the side
    effect. Callers must hold the instance row lock so two redelivered copies of
    the same step cannot both execute the activity.
    """
    input_hash = canonical_hash(activity_input)
    execution, created = WorkflowActivityExecution.objects.get_or_create(
        workflow=instance, activity_name=activity_name, input_hash=input_hash
    )
    if not created and execution.result is not None:
        cached: dict[str, Any] | None = execution.result
        return cached
    result = activity(activity_input)
    execution.result = result
    execution.save(update_fields=["result"])
    return result


def enqueue_step(instance_id: str, step_index: int) -> None:
    """Write a step-advance outbox row and best-effort dispatch it.

    Mirrors ``scheduling.services.enqueue_recalculate``: the row is the durable
    record, the immediate ``.delay()`` is best-effort, and ``workflows_outbox_drain``
    re-dispatches if the broker is down. Dispatch is deferred to
    ``transaction.on_commit`` so the row is committed before the task reads it.
    """
    row = WorkflowOutboxRow.objects.create(
        workflow_id=instance_id,
        step_name=str(step_index),
        step_input={"step_index": step_index},
    )

    def _dispatch() -> None:
        from trueppm_api.apps.workflow_engine.tasks import advance_workflow_step

        try:
            result = advance_workflow_step.delay(str(row.id))
        except Exception:
            logger.exception(
                "enqueue_step: immediate dispatch failed for outbox row %s "
                "— workflows_outbox_drain will retry",
                row.id,
            )
            return
        WorkflowOutboxRow.objects.filter(id=row.id, status=WorkflowOutboxStatus.PENDING).update(
            status=WorkflowOutboxStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=timezone.now(),
        )

    transaction.on_commit(_dispatch)


def resolve_activity(
    definition: WorkflowDefinition, instance: WorkflowInstance, activity_name: str
) -> Activity:
    """Find the activity callable for ``activity_name`` in the workflow's chain."""
    for step in definition.build_steps(instance.input):
        if step.name == activity_name:
            return step.activity
    raise KeyError(f"workflow {instance.name!r} has no activity named {activity_name!r}")


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------


class DefaultWorkflowBackend(WorkflowBackend):
    """The v1 OSS workflow backend: declarative chains over outbox + Celery."""

    def start_workflow(
        self,
        name: str,
        input: dict[str, Any],
        *,
        idempotency_key: str | None = None,
        wait_for_completion: bool = False,
    ) -> str:
        if wait_for_completion:
            raise NotImplementedError(
                "the default backend is fire-and-forget; wait_for_completion is not "
                "supported. Poll get_workflow_state() instead."
            )
        # Fail fast if the workflow name is not registered, before creating state.
        WORKFLOWS.get(name)
        key = idempotency_key or default_idempotency_key(name, input)
        with transaction.atomic():
            instance, created = WorkflowInstance.objects.get_or_create(
                idempotency_key=key,
                defaults={"name": name, "input": input, "status": WorkflowStatus.RUNNING},
            )
            if created:
                record_history(instance, "workflow_started", {"input": input})
                enqueue_step(str(instance.id), 0)
        return str(instance.id)

    def signal_workflow(self, workflow_id: str, signal: str, payload: dict[str, Any]) -> None:
        # Durably record the signal in the inbox and history. v1 chains do not
        # yet gate steps on signals; the inbox is what makes that a later,
        # non-breaking addition (a step can drain unconsumed signals).
        with transaction.atomic():
            instance = WorkflowInstance.objects.select_for_update().get(id=workflow_id)
            WorkflowSignal.objects.create(workflow=instance, signal_name=signal, payload=payload)
            record_history(instance, "signal_received", {"signal": signal, "payload": payload})

    def query_workflow(self, workflow_id: str, query: str, args: dict[str, Any]) -> Any:
        instance = WorkflowInstance.objects.get(id=workflow_id)
        return WORKFLOWS.get(instance.name).on_query(query, args)

    def get_workflow_state(self, workflow_id: str) -> WorkflowState:
        instance = WorkflowInstance.objects.get(id=workflow_id)
        return WorkflowState(
            workflow_id=str(instance.id),
            name=instance.name,
            status=IWorkflowStatus(instance.status),
            result=instance.result,
            error=instance.error,
            created_at=instance.created_at,
            updated_at=instance.updated_at,
            completed_at=instance.completed_at,
        )

    def cancel_workflow(self, workflow_id: str, reason: str = "") -> None:
        with transaction.atomic():
            instance = WorkflowInstance.objects.select_for_update().get(id=workflow_id)
            if instance.status in _TERMINAL_STATUSES:
                return  # already finished — cancellation is a no-op
            instance.status = WorkflowStatus.CANCELED
            instance.cancel_reason = reason
            instance.completed_at = timezone.now()
            instance.save(update_fields=["status", "cancel_reason", "completed_at", "updated_at"])
            record_history(instance, "workflow_canceled", {"reason": reason})

    def sleep(self, workflow_id: str, duration: timedelta) -> None:
        with transaction.atomic():
            instance = WorkflowInstance.objects.select_for_update().get(id=workflow_id)
            fire_at = timezone.now() + duration
            WorkflowTimer.objects.create(workflow=instance, fire_at=fire_at)
            if instance.status == WorkflowStatus.RUNNING:
                instance.status = WorkflowStatus.SLEEPING
                instance.save(update_fields=["status", "updated_at"])
            record_history(instance, "sleep_started", {"fire_at": fire_at.isoformat()})

    def run_activity(
        self, name: str, input: dict[str, Any], retry_policy: RetryPolicy | None = None
    ) -> Any:
        # retry_policy is reserved: v1 derives retry from at-least-once outbox
        # redelivery plus OAOO idempotency, not from a per-activity policy.
        workflow_id = _current_workflow_id.get()
        if workflow_id is None:
            raise RuntimeError(
                "run_activity() must be called within a workflow step execution; "
                "no ambient workflow context is set."
            )
        instance = WorkflowInstance.objects.get(id=workflow_id)
        activity = resolve_activity(WORKFLOWS.get(instance.name), instance, name)
        return run_activity_oaoo(instance, name, input, activity)

    def get_history(self, workflow_id: str) -> list[HistoryEvent]:
        return [
            HistoryEvent(
                seq=event.seq,
                event_type=event.event_type,
                payload=event.payload,
                occurred_at=event.created_at,
            )
            for event in WorkflowHistoryEvent.objects.filter(workflow__id=workflow_id).order_by(
                "seq"
            )
        ]
