"""Serializers for the scheduling app admin API."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.scheduling.models import FailedTask, VelocitySuggestion


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


class VelocitySuggestionSerializer(serializers.ModelSerializer[VelocitySuggestion]):
    """Read serializer for a velocity-calibration suggestion (ADR-0065).

    Surfaces the sprint that triggered the suggestion (name + id) so the Task
    Detail Drawer can render "Suggested from Sprint 12 close" without a second
    fetch.  The accept/dismiss audit fields are exposed so the drawer can also
    render a quiet history row once a decision is made.
    """

    sprint_name = serializers.CharField(source="sprint.name", read_only=True)
    sprint_id = serializers.UUIDField(source="sprint.id", read_only=True)
    is_pending = serializers.BooleanField(read_only=True)

    class Meta:
        model = VelocitySuggestion
        fields = [
            "id",
            "task",
            "sprint_id",
            "sprint_name",
            "suggested_duration",
            "team_velocity_per_day",
            "flag_for_review",
            "is_pending",
            "created_at",
            "accepted_at",
            "accepted_by",
            "dismissed_at",
            "dismissed_by",
        ]
        read_only_fields = fields
