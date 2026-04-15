"""Serializers for the scheduling app admin API."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.scheduling.models import FailedTask


class FailedTaskSerializer(serializers.ModelSerializer[FailedTask]):
    """Read-only serializer for the failed-task dead-letter queue.

    Exposed by the admin API so operators can inspect and requeue or discard
    tasks that exceeded their retry budget.
    """

    class Meta:
        model = FailedTask
        fields = [
            "id",
            "task_name",
            "task_id",
            "args",
            "kwargs",
            "exception_type",
            "exception_message",
            "traceback",
            "failure_count",
            "first_failed_at",
            "last_failed_at",
            "status",
        ]
        read_only_fields = fields
