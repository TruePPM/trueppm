"""Serializers for the access app."""

from __future__ import annotations

from typing import Any

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


class MeSerializer(serializers.Serializer[Any]):
    """Read-only serializer for GET /api/v1/auth/me/."""

    id = serializers.UUIDField()
    username = serializers.CharField()
    display_name = serializers.SerializerMethodField()
    initials = serializers.SerializerMethodField()
    email = serializers.EmailField()

    def get_display_name(self, obj: Any) -> str:
        name = f"{obj.first_name} {obj.last_name}".strip()
        return name if name else obj.username

    def get_initials(self, obj: Any) -> str:
        parts: list[str] = []
        if obj.first_name:
            parts.append(obj.first_name[0].upper())
        if obj.last_name:
            parts.append(obj.last_name[0].upper())
        if parts:
            return "".join(parts[:2])
        return obj.username[:2].upper()
