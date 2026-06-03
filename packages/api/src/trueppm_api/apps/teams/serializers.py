"""Serializers for the teams app (ADR-0078 §E)."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()


class _TeamUserSummarySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    class Meta:
        model = User
        fields = ["id", "username", "email"]


class TeamSerializer(serializers.ModelSerializer[Team]):
    """Read serializer for a team. ``member_count`` drives the roster header."""

    member_count = serializers.SerializerMethodField()

    class Meta:
        model = Team
        fields = [
            "id",
            "project",
            "name",
            "short_id",
            "description",
            "is_default",
            "member_count",
            "server_version",
        ]
        read_only_fields = fields

    def get_member_count(self, obj: Team) -> int:
        # Prefer a prefetched/annotated count when present to avoid an N+1 on lists.
        annotated = getattr(obj, "member_count_annotated", None)
        if annotated is not None:
            return int(annotated)
        return obj.memberships.filter(is_deleted=False).count()


class TeamMembershipReadSerializer(serializers.ModelSerializer[TeamMembership]):
    """Roster row: identity plus the role and the two facet flags."""

    user_detail = _TeamUserSummarySerializer(source="user", read_only=True)
    role_label = serializers.CharField(source="get_role_display", read_only=True)

    class Meta:
        model = TeamMembership
        fields = [
            "id",
            "team",
            "user",
            "user_detail",
            "role",
            "role_label",
            "is_scrum_master",
            "is_product_owner",
            "created_at",
            "server_version",
        ]
        read_only_fields = fields


class TeamMembershipWriteSerializer(serializers.ModelSerializer[TeamMembership]):
    """Write serializer for role and facet assignment (PATCH only in 0.3).

    All three fields are optional so a partial update can flip a single facet
    without re-sending the role. The single-holder reassignment for the facets is
    applied in the viewset inside the write transaction, not here, because it
    mutates *other* rows.
    """

    role = serializers.ChoiceField(choices=TeamRole.choices, required=False)
    is_scrum_master = serializers.BooleanField(required=False)
    is_product_owner = serializers.BooleanField(required=False)

    class Meta:
        model = TeamMembership
        fields = ["role", "is_scrum_master", "is_product_owner"]
