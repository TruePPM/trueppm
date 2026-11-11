"""Read serializers for the operator workflow inspector (#2994)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.workflow_engine.models import (
    WorkflowInstance,
    WorkflowOutboxRow,
    WorkflowStatus,
)

_TERMINAL = (WorkflowStatus.COMPLETED, WorkflowStatus.FAILED, WorkflowStatus.CANCELED)


class WorkflowStepSerializer(serializers.ModelSerializer[WorkflowOutboxRow]):
    """The latest step-dispatch row: where the workflow is and why it stopped."""

    class Meta:
        model = WorkflowOutboxRow
        fields = [
            "step_name",
            "status",
            "attempt_count",
            "next_attempt_at",
            "failure_reason",
            "error_message",
            "created_at",
        ]
        read_only_fields = fields


class WorkflowInstanceSerializer(serializers.ModelSerializer[WorkflowInstance]):
    """Operator view of one workflow.

    ``terminal`` names the give-up condition so no client re-derives it: the
    workflow itself is in a finished status. ``retrying`` is the other half — a
    step failed transiently and the drain will re-queue it at ``next_attempt_at``.
    ``input`` is deliberately omitted; it can carry task args and kwargs.
    """

    terminal = serializers.SerializerMethodField()
    retrying = serializers.SerializerMethodField()
    current_step = serializers.SerializerMethodField()

    class Meta:
        model = WorkflowInstance
        fields = [
            "id",
            "name",
            "status",
            "error",
            "cancel_reason",
            "terminal",
            "retrying",
            "current_step",
            "created_at",
            "updated_at",
            "completed_at",
        ]
        read_only_fields = fields

    def _latest_row(self, obj: WorkflowInstance) -> WorkflowOutboxRow | None:
        rows: list[WorkflowOutboxRow] = list(obj.outbox_rows.all())
        return rows[-1] if rows else None

    def get_terminal(self, obj: WorkflowInstance) -> bool:
        return obj.status in _TERMINAL

    def get_retrying(self, obj: WorkflowInstance) -> bool:
        row = self._latest_row(obj)
        return bool(row is not None and row.next_attempt_at is not None)

    def get_current_step(self, obj: WorkflowInstance) -> dict[str, Any] | None:
        row = self._latest_row(obj)
        return None if row is None else dict(WorkflowStepSerializer(row).data)
