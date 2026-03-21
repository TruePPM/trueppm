"""DRF serializers for the resources app."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.resources.models import Resource, TaskResource


class ResourceSerializer(serializers.ModelSerializer):
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


class TaskResourceSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskResource
        fields = ["id", "task", "resource", "units"]
        read_only_fields = ["id"]
