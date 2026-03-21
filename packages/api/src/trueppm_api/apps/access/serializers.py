"""Serializers for the access app."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.access.models import ProjectMembership


class ProjectMembershipSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProjectMembership
        fields = [
            "id",
            "server_version",
            "project",
            "user",
            "role",
        ]
        read_only_fields = ["id", "server_version"]
