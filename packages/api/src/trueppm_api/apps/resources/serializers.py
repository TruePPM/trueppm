"""DRF serializers for the resources app."""

from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers

from trueppm_api.apps.resources.models import (
    ProjectResource,
    Resource,
    ResourceSkill,
    Skill,
    TaskResource,
    TaskSkillRequirement,
)


class SkillSerializer(serializers.ModelSerializer[Skill]):
    """Read/write serializer for the org-level skill catalog.

    Normalises name to lower-case + stripped on write to prevent duplicate
    entries ("React" vs "react"). Returns the existing row (not a 201) when
    the normalized_name already exists — callers should handle 200 vs 201.
    """

    class Meta:
        model = Skill
        fields = ["id", "server_version", "name", "normalized_name", "category"]
        read_only_fields = ["id", "server_version", "normalized_name"]

    def validate_name(self, value: str) -> str:
        return value.strip()

    def create(self, validated_data: dict[str, str]) -> Skill:
        normalized = validated_data["name"].casefold()
        validated_data["normalized_name"] = normalized
        skill, _ = Skill.objects.get_or_create(
            normalized_name=normalized,
            defaults={
                "name": validated_data["name"],
                "category": validated_data.get("category", ""),
            },
        )
        return skill


class ResourceSkillSerializer(serializers.ModelSerializer[ResourceSkill]):
    """Read/write serializer for skill tags on a resource."""

    skill_name = serializers.CharField(source="skill.name", read_only=True)

    class Meta:
        model = ResourceSkill
        fields = ["id", "server_version", "resource", "skill", "skill_name", "proficiency"]
        read_only_fields = ["id", "server_version", "skill_name"]


class ResourceSerializer(serializers.ModelSerializer[Resource]):
    """Read/write serializer for named resources (people, equipment, or material).

    calendar is optional — when null the resource inherits the project's calendar
    for utilization calculations. skills is read-only nested; writes use
    /api/v1/resource-skills/ directly (ADR-0033, mirrors the assignments pattern).
    is_me is a request-scoped boolean — true when the resource is linked to the
    current user (Resource.user FK or, for legacy rows, an exact email match).
    Drives the "My tasks" Board filter (#198) without leaking other users' IDs.
    """

    skills = ResourceSkillSerializer(many=True, read_only=True)
    is_me = serializers.SerializerMethodField()

    class Meta:
        model = Resource
        fields = [
            "id",
            "server_version",
            "name",
            "email",
            "job_role",
            "calendar",
            "max_units",
            "skills",
            "is_me",
        ]
        read_only_fields = ["id", "server_version", "skills", "is_me"]

    def get_is_me(self, obj: Resource) -> bool:
        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return False
        if obj.user_id is not None and obj.user_id == request.user.pk:
            return True
        # Email fallback for legacy resources whose user FK has not been set.
        # iexact-style comparison via casefold to match the queryset filter.
        if obj.user_id is None and obj.email:
            user_email = (getattr(request.user, "email", "") or "").strip().lower()
            return bool(user_email) and obj.email.strip().lower() == user_email
        return False


class ProjectResourceSerializer(serializers.ModelSerializer[ProjectResource]):
    """Read/write serializer for project roster membership.

    resource_detail is read-only expanded; writes use the resource UUID FK.
    effective_max_units is computed: units_override if set, else resource.max_units.
    """

    resource_detail = ResourceSerializer(source="resource", read_only=True)
    effective_max_units = serializers.SerializerMethodField()

    class Meta:
        model = ProjectResource
        fields = [
            "id",
            "server_version",
            "project",
            "resource",
            "resource_detail",
            "role_title",
            "units_override",
            "effective_max_units",
            "notes",
        ]
        read_only_fields = ["id", "server_version", "resource_detail", "effective_max_units"]

    def get_effective_max_units(self, obj: ProjectResource) -> str:
        value = obj.units_override if obj.units_override is not None else obj.resource.max_units
        return f"{value:.2f}"


class TaskSkillRequirementSerializer(serializers.ModelSerializer[TaskSkillRequirement]):
    """Read/write serializer for skill requirements on a task."""

    skill_name = serializers.CharField(source="skill.name", read_only=True)

    class Meta:
        model = TaskSkillRequirement
        fields = ["id", "server_version", "task", "skill", "skill_name", "min_proficiency"]
        read_only_fields = ["id", "server_version", "skill_name"]


class TaskResourceSerializer(serializers.ModelSerializer[TaskResource]):
    """Read/write serializer for task-resource assignments.

    units is a decimal fraction of full capacity (e.g. 0.5 = 50%). Validated
    to the range [0.01, 2.0] so accidental 0 or runaway values are caught early.
    """

    resource_name = serializers.CharField(source="resource.name", read_only=True)

    class Meta:
        model = TaskResource
        fields = ["id", "task", "resource", "resource_name", "units"]
        read_only_fields = ["id", "resource_name"]

    def validate_units(self, value: Decimal) -> Decimal:
        """Enforce that units stay within the valid assignment range.

        0.01 (1%) is the minimum meaningful allocation; 2.0 (200%) is the
        maximum to catch data-entry errors while still allowing overtime.
        """
        if value < Decimal("0.01") or value > Decimal("2.0"):
            raise serializers.ValidationError("units must be between 0.01 and 2.0 (1% to 200%)")
        return value
