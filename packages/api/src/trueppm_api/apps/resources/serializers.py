"""DRF serializers for the resources app."""

from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers

from trueppm_api.apps.resources.models import Resource, TaskResource


class ResourceSerializer(serializers.ModelSerializer[Resource]):
    class Meta:
        model = Resource
        fields = [
            "id",
            "server_version",
            "name",
            "email",
            "calendar",
            "max_units",
        ]
        read_only_fields = ["id", "server_version"]


class TaskResourceSerializer(serializers.ModelSerializer[TaskResource]):
    class Meta:
        model = TaskResource
        fields = ["id", "task", "resource", "units"]
        read_only_fields = ["id"]

    def validate_units(self, value: Decimal) -> Decimal:
        """Enforce that units stay within the valid assignment range.

        0.01 (1%) is the minimum meaningful allocation; 2.0 (200%) is the
        maximum to catch data-entry errors while still allowing overtime.
        """
        if value < Decimal("0.01") or value > Decimal("2.0"):
            raise serializers.ValidationError(
                "units must be between 0.01 and 2.0 (1% to 200%)"
            )
        return value
