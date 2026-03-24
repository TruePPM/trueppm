"""Serializers for the access app."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from trueppm_api.apps.access.models import ProjectMembership, Role

User = get_user_model()


class _UserSummarySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    class Meta:
        model = User
        fields = ["id", "username", "email"]


class ProjectMembershipReadSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Response serializer — includes user_detail and role_label for list/retrieve.

    role       — integer ordinal (canonical wire format; use for comparisons)
    role_label — human-readable label e.g. "Project Manager" (display only)
    """

    user_detail = _UserSummarySerializer(source="user", read_only=True)
    role_label = serializers.SerializerMethodField()

    def get_role_label(self, obj: ProjectMembership) -> str:
        return Role(obj.role).label

    class Meta:
        model = ProjectMembership
        fields = [
            "id",
            "server_version",
            "project",
            "user",
            "user_detail",
            "role",
            "role_label",
        ]
        read_only_fields = ["id", "server_version", "project", "user", "user_detail", "role_label"]


class ProjectMembershipWriteSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Write serializer — accepts user (UUID) and role; project is injected from URL."""

    class Meta:
        model = ProjectMembership
        fields = ["user", "role"]

    def validate_role(self, value: int) -> int:
        # Role must be a valid Role ordinal.
        valid = {r.value for r in Role}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value
