"""Serializers for TaskRun API."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.taskruns.models import TaskRun


class TaskRunSerializer(serializers.ModelSerializer[TaskRun]):
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
