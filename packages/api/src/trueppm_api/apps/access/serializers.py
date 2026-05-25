"""Serializers for the access app."""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from rest_framework import serializers

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role

User = get_user_model()


class _UserSummarySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    class Meta:
        model = User
        fields = ["id", "username", "email"]


class ProjectMembershipReadSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Response serializer — includes user_detail and role_label for list/retrieve.

    role                       — integer ordinal (canonical wire format; use for comparisons)
    role_label                 — human-readable label e.g. "Project Manager" (display only)
    joined_at                  — when this membership row was created (per-project access evidence)
    role_changed_at            — when the role last changed, or null if unchanged since joining
    other_active_project_count — how many OTHER active (non-archived, non-deleted) projects this
                                 user belongs to, excluding the current one. A resource-load
                                 signal for the assigner (#598). The full count is shown; it is a
                                 number only and leaks no project identities.
    other_active_project_names — names of those other projects, but ONLY the ones the *requesting*
                                 user is OWNER of (visibility gate — never reveal the name of a
                                 project the requester cannot already see). Empty for non-OWNERs.
    """

    user_detail = _UserSummarySerializer(source="user", read_only=True)
    role_label = serializers.SerializerMethodField()
    other_active_project_count = serializers.SerializerMethodField()
    other_active_project_names = serializers.SerializerMethodField()

    def get_role_label(self, obj: ProjectMembership) -> str:
        return Role(obj.role).label

    def get_other_active_project_count(self, obj: ProjectMembership) -> int:
        # list/retrieve annotate this on the queryset (one Subquery, no N+1). create/
        # partial_update serialize a fresh, un-annotated instance — fall back to a
        # single count query there (rare, one row).
        annotated = getattr(obj, "other_active_count", None)
        if annotated is not None:
            return int(annotated)
        return (
            ProjectMembership.objects.filter(
                user_id=obj.user_id,
                is_deleted=False,
                project__is_deleted=False,
                project__is_archived=False,
            )
            .exclude(project_id=obj.project_id)
            .values("project_id")
            .distinct()
            .count()
        )

    def get_other_active_project_names(self, obj: ProjectMembership) -> list[str]:
        # Names are visibility-gated and prebuilt once per request by the viewset
        # (see ProjectMembershipViewSet._build_other_project_names_map). When the map
        # is absent (create/partial_update responses) return [] — the client re-fetches
        # the list, which carries the gated names.
        names_map: dict[Any, list[str]] = self.context.get("other_project_names_map") or {}
        return names_map.get(obj.user_id, [])

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
            "joined_at",
            "role_changed_at",
            "other_active_project_count",
            "other_active_project_names",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "project",
            "user",
            "user_detail",
            "role_label",
            "joined_at",
            "role_changed_at",
            "other_active_project_count",
            "other_active_project_names",
        ]


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


class ProgramMembershipReadSerializer(serializers.ModelSerializer[ProgramMembership]):
    """Response serializer for ProgramMembership — mirrors the project version."""

    user_detail = _UserSummarySerializer(source="user", read_only=True)
    role_label = serializers.SerializerMethodField()

    def get_role_label(self, obj: ProgramMembership) -> str:
        return Role(obj.role).label

    class Meta:
        model = ProgramMembership
        fields = [
            "id",
            "server_version",
            "program",
            "user",
            "user_detail",
            "role",
            "role_label",
        ]
        read_only_fields = ["id", "server_version", "program", "user", "user_detail", "role_label"]


class ProgramMembershipWriteSerializer(serializers.ModelSerializer[ProgramMembership]):
    """Write serializer — accepts user (UUID) and role; program is injected from URL."""

    class Meta:
        model = ProgramMembership
        fields = ["user", "role"]

    def validate_role(self, value: int) -> int:
        valid = {r.value for r in Role}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value


class UserSearchResultSerializer(serializers.Serializer[Any]):
    """Read-only serializer for GET /api/v1/users/search/ results (ADR-0061)."""

    id = serializers.CharField()
    username = serializers.CharField()
    email = serializers.EmailField()
    display_name = serializers.SerializerMethodField()
    initials = serializers.SerializerMethodField()

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
        return str(obj.username[:2].upper())


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
        return str(obj.username[:2].upper())
