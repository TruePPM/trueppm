"""Persistence layer for the default workflow backend (ADR-0080).

These tables back the outbox-composing default backend. They are deliberately
NOT synced to mobile clients — workflows are internal infrastructure with no
REST or sync surface in 0.4 — so none of them inherit ``VersionedModel`` or
carry ``server_version`` (cf. ``scheduling.ScheduleRequest``).

The state machine composes with the existing transactional outbox (#66):
advancing a workflow step writes a ``WorkflowOutboxRow`` inside the same
``transaction.on_commit()`` boundary as the state transition, so a broker
outage between commit and dispatch cannot drop the step — the drain re-dispatches.
"""

from __future__ import annotations

import uuid

from django.db import models


class WorkflowStatus(models.TextChoices):
    """Lifecycle of a workflow instance."""

    PENDING = "pending", "Pending"
    RUNNING = "running", "Running"
    SLEEPING = "sleeping", "Sleeping"
    COMPLETED = "completed", "Completed"
    FAILED = "failed", "Failed"
    CANCELED = "canceled", "Canceled"


class WorkflowInstance(models.Model):
    """A single workflow execution.

    ``idempotency_key`` is globally unique and is the start-dedup mechanism: a
    retried ``start_workflow`` with the same ``name + input`` produces the same
    default key (a deterministic hash), collides on this constraint, and the
    backend returns the existing instance instead of starting a duplicate
    (once-and-only-once start semantics, ADR-0080 §Implementation Notes 7).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, db_index=True)
    status = models.CharField(
        max_length=16,
        choices=WorkflowStatus.choices,
        default=WorkflowStatus.PENDING,
    )
    input = models.JSONField(default=dict)
    result = models.JSONField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    idempotency_key = models.CharField(max_length=64)
    cancel_reason = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["idempotency_key"],
                name="workflow_idempotency_key_uniq",
            ),
        ]
        indexes = [
            # Drain / dashboard: filter by status, scan oldest-first.
            models.Index(fields=["status", "created_at"], name="workflow_status_idx"),
            # Retention sweep of finished instances.
            models.Index(fields=["completed_at"], name="workflow_completed_idx"),
        ]

    def __str__(self) -> str:
        return f"WorkflowInstance({self.name}, {self.status})"


class WorkflowHistoryEvent(models.Model):
    """Append-only, per-workflow ordered event log.

    Ordered by an explicit monotonic ``seq`` rather than ``created_at``: events
    written in the same transaction share a timestamp to sub-millisecond
    precision, and ``get_history`` must return a deterministic order. ``seq``
    also pre-positions the log for sequence-based replay / gap detection (#321).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(
        WorkflowInstance,
        on_delete=models.CASCADE,
        related_name="history",
    )
    seq = models.BigIntegerField()
    event_type = models.CharField(max_length=32)
    payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["workflow_id", "seq"]
        constraints = [
            # The unique B-tree on (workflow, seq) also serves the ordered
            # get_history lookup and the Max(seq) aggregate in record_history, so
            # no separate (workflow, seq) index is needed — a named one would be
            # pure write amplification on this hot, every-step-written table.
            models.UniqueConstraint(
                fields=["workflow", "seq"],
                name="workflow_history_seq_uniq",
            ),
        ]
        indexes = [
            # Retention sweep (30-day default, configurable).
            models.Index(fields=["created_at"], name="workflow_history_retention_idx"),
        ]

    def __str__(self) -> str:
        return f"WorkflowHistoryEvent({self.workflow_id}, {self.seq}, {self.event_type})"


class WorkflowTimer(models.Model):
    """Backs the first-class ``sleep(workflow_id, duration)`` primitive.

    A Beat task fires due timers (``fired=False, fire_at <= now``) and signals
    the sleeping workflow to resume. The ``(fired, fire_at)`` composite serves
    the drain query directly.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(
        WorkflowInstance,
        on_delete=models.CASCADE,
        related_name="timers",
    )
    fire_at = models.DateTimeField()
    fired = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["fired", "fire_at"], name="workflow_timer_due_idx"),
        ]

    def __str__(self) -> str:
        return f"WorkflowTimer({self.workflow_id}, fire_at={self.fire_at:%Y-%m-%d %H:%M})"


class WorkflowOutboxStatus(models.TextChoices):
    """Lifecycle of a workflow step-dispatch outbox row."""

    PENDING = "pending", "Pending"
    DISPATCHED = "dispatched", "Dispatched"
    DONE = "done", "Done"
    DEAD = "dead", "Dead"


class WorkflowOutboxRow(models.Model):
    """Transactional outbox for advancing a workflow step.

    Distinct from the event outbox (#66): the row schema and dispatch target
    differ — this dispatches a workflow *step*, not an event consumer
    (ADR-0080 §Implementation Notes 2). Written atomically with the workflow
    state transition; the ``workflows_outbox_drain`` Beat task re-dispatches
    ``PENDING`` rows older than the 5-minute orphan window so it never races
    with an in-flight commit. Rows with ``attempt_count > 0`` are inside
    Celery's own retry chain and are skipped by the drain (same rule as
    ``WebhookDelivery``).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(
        WorkflowInstance,
        on_delete=models.CASCADE,
        related_name="outbox_rows",
    )
    step_name = models.CharField(max_length=255)
    step_input = models.JSONField(default=dict)
    status = models.CharField(
        max_length=16,
        choices=WorkflowOutboxStatus.choices,
        default=WorkflowOutboxStatus.PENDING,
    )
    attempt_count = models.PositiveIntegerField(default=0)
    celery_task_id = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"], name="workflow_outbox_drain_idx"),
        ]

    def __str__(self) -> str:
        return f"WorkflowOutboxRow({self.workflow_id}, {self.step_name}, {self.status})"


class WorkflowActivityExecution(models.Model):
    """Once-and-only-once cache for a workflow activity result.

    The unique ``(workflow, activity_name, input_hash)`` constraint
    (ADR-0080 §Implementation Notes 7) makes ``run_activity`` idempotent: a
    replayed activity finds the prior row and returns its stored ``result``
    rather than re-executing the side effect. Storing the result (not merely
    detecting the duplicate) is what lets a replaying workflow get its original
    answer back.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(
        WorkflowInstance,
        on_delete=models.CASCADE,
        related_name="activity_executions",
    )
    activity_name = models.CharField(max_length=255)
    input_hash = models.CharField(max_length=64)
    result = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workflow", "activity_name", "input_hash"],
                name="workflow_activity_oaoo_uniq",
            ),
        ]

    def __str__(self) -> str:
        return f"WorkflowActivityExecution({self.workflow_id}, {self.activity_name})"


class WorkflowSignal(models.Model):
    """Durable inbox for signals delivered to a workflow.

    Signals can arrive before the workflow reaches the point where it waits for
    them, so they must be persisted rather than delivered transiently. The
    backend consumes unconsumed rows (``consumed=False``) in arrival order when
    a workflow reaches a wait point. Kept as a dedicated table rather than
    derived from the history log so consumption is a simple indexed query, not a
    scan-and-reconcile over an append-only stream.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(
        WorkflowInstance,
        on_delete=models.CASCADE,
        related_name="signals",
    )
    signal_name = models.CharField(max_length=255)
    payload = models.JSONField(default=dict)
    consumed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            # Wait-point lookup: unconsumed signals for a workflow, in arrival order.
            models.Index(
                fields=["workflow", "consumed", "created_at"],
                name="workflow_signal_inbox_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"WorkflowSignal({self.workflow_id}, {self.signal_name}, consumed={self.consumed})"
