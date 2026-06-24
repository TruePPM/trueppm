"""Serializers for the retention policy editor + purge runs (ADR-0173)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.observability.models import PurgeRun, RetentionSchedule
from trueppm_api.apps.observability.retention import RETENTION_KEYS


class RetentionPolicyReadSerializer(serializers.Serializer[Any]):
    """One table's policy row + estimated stats (read side; serializes a dict)."""

    key = serializers.CharField()
    # `label` shadows Field.label (str | None) under drf-stubs — expected for a
    # field of that name; same pattern as the `source` field elsewhere.
    label = serializers.CharField()  # type: ignore[assignment]
    note = serializers.CharField()
    unit = serializers.ChoiceField(choices=["days", "hours"])
    value = serializers.IntegerField()
    enabled = serializers.BooleanField()
    row_count = serializers.IntegerField()
    bytes = serializers.IntegerField(allow_null=True)


class RetentionScheduleSerializer(serializers.ModelSerializer[RetentionSchedule]):
    """The purge-schedule singleton (read + write)."""

    class Meta:
        model = RetentionSchedule
        fields = ["frequency", "time_of_day_utc", "day_of_week", "on_failure"]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if (
            attrs.get("frequency") == RetentionSchedule.Frequency.WEEKLY
            and attrs.get("day_of_week") is None
        ):
            raise serializers.ValidationError({"day_of_week": "Required when frequency is weekly."})
        day = attrs.get("day_of_week")
        if day is not None and not (0 <= day <= 6):
            raise serializers.ValidationError({"day_of_week": "Must be 0 (Mon) to 6 (Sun)."})
        return attrs


class PurgeRunSerializer(serializers.ModelSerializer[PurgeRun]):
    """A recorded purge run with a computed duration."""

    duration_ms = serializers.SerializerMethodField()

    class Meta:
        model = PurgeRun
        fields = [
            "id",
            "started_at",
            "finished_at",
            "trigger",
            "state",
            "tables",
            "rows_deleted",
            "bytes_freed",
            "error",
            "duration_ms",
        ]

    def get_duration_ms(self, obj: PurgeRun) -> int | None:
        if obj.finished_at is None:
            return None
        return int((obj.finished_at - obj.started_at).total_seconds() * 1000)


class RetentionStateSerializer(serializers.Serializer[Any]):
    """Full editor payload (serializes the dict from ``get_retention_state``)."""

    policies = RetentionPolicyReadSerializer(many=True)
    schedule = RetentionScheduleSerializer()
    runs = PurgeRunSerializer(many=True)


class RetentionPolicyWriteSerializer(serializers.Serializer[Any]):
    """One policy override in a save-bar PATCH."""

    key = serializers.ChoiceField(choices=RETENTION_KEYS)
    value = serializers.IntegerField(min_value=1)
    enabled = serializers.BooleanField()


class RetentionUpdateSerializer(serializers.Serializer[Any]):
    """The save-bar payload: any subset of policy overrides + the schedule."""

    policies = RetentionPolicyWriteSerializer(many=True, required=False)
    schedule = RetentionScheduleSerializer(required=False)


class RetentionImpactQuerySerializer(serializers.Serializer[Any]):
    """Query params for the lower-value impact estimate. ``value`` is in the
    window's native unit (days for four tables, hours for sync batches)."""

    key = serializers.ChoiceField(choices=RETENTION_KEYS)
    value = serializers.IntegerField(min_value=0)


class RetentionImpactSerializer(serializers.Serializer[Any]):
    eligible_rows = serializers.IntegerField()
    eligible_bytes = serializers.IntegerField(allow_null=True)


class PurgeRunRequestSerializer(serializers.Serializer[Any]):
    dry_run = serializers.BooleanField(default=False)


class PurgeRunQueuedSerializer(serializers.Serializer[Any]):
    queued = serializers.BooleanField()
    run_id = serializers.UUIDField()
