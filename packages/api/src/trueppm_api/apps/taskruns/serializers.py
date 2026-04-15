"""Serializers for TaskRun API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.taskruns.models import TaskRun


class TaskRunSerializer(serializers.ModelSerializer[TaskRun]):
    """Read-only serializer for TaskRun progress records.

    Exposes all fields needed to drive a progress indicator: status,
    progress_pct, progress_msg, and timing fields for duration display.
    All fields are read-only — TaskRun records are created and updated
    by the Celery worker, never directly via the API.
    """

    class Meta:
        model = TaskRun
        fields = [
            "id",
            "task_name",
            "celery_task_id",
            "project",
            "initiated_by",
            "status",
            "progress_pct",
            "progress_msg",
            "result_summary",
            "error_detail",
            "created_at",
            "started_at",
            "completed_at",
        ]
        read_only_fields = fields


class SchedulerRunResultSummarySerializer(serializers.Serializer[Any]):
    """Typed view over TaskRun.result_summary when task_name='scheduling.recalculate'.

    The tracker writes ``{"project_finish": "YYYY-MM-DD", "critical_path": [uuid, ...]}``
    from ``_run_schedule``. Fields are optional because failed runs may never
    reach ``set_result()``.
    """

    project_finish = serializers.DateField(required=False, allow_null=True)
    critical_path = serializers.ListField(
        child=serializers.CharField(), required=False, allow_null=True
    )


class SchedulerRunSerializer(serializers.ModelSerializer[TaskRun]):
    """Typed view over TaskRun records for scheduler recalculation runs.

    Exposes ``initiated_by`` as a username string rather than a user UUID —
    observability audit readers (Marcus/SOC 2) want a human-readable name, and
    this avoids leaking user PKs to non-admin project members.
    """

    initiated_by_username = serializers.SerializerMethodField()
    result_summary = SchedulerRunResultSummarySerializer(allow_null=True, required=False)

    class Meta:
        model = TaskRun
        fields = [
            "id",
            "status",
            "progress_pct",
            "progress_msg",
            "result_summary",
            "error_detail",
            "initiated_by_username",
            "created_at",
            "started_at",
            "completed_at",
        ]
        read_only_fields = fields

    def get_initiated_by_username(self, obj: TaskRun) -> str | None:
        user = obj.initiated_by
        if user is None:
            return None
        return getattr(user, "username", None) or getattr(user, "email", None)
