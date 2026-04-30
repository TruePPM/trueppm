"""Serializers for workshop sessions and participants."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from trueppm_api.apps.workshops.models import WorkshopParticipant, WorkshopSession

User = get_user_model()


class WorkshopParticipantSerializer(serializers.ModelSerializer[WorkshopParticipant]):
    """Read-only serializer for a workshop participant record."""

    user_id = serializers.UUIDField(source="user.pk", read_only=True)
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: WorkshopParticipant) -> str:
        """Return the participant's full name or username."""
        return obj.user.get_full_name() or obj.user.username

    class Meta:
        model = WorkshopParticipant
        fields = ["id", "user_id", "display_name", "joined_at", "left_at", "color_index"]
        read_only_fields = fields


class WorkshopSessionSerializer(serializers.ModelSerializer[WorkshopSession]):
    """Serializer for a workshop session with nested participants."""

    project_id = serializers.UUIDField(source="project.pk", read_only=True)
    started_by_id = serializers.UUIDField(source="started_by.pk", read_only=True, allow_null=True)
    participants = WorkshopParticipantSerializer(many=True, read_only=True)

    class Meta:
        model = WorkshopSession
        fields = [
            "id",
            "project_id",
            "started_by_id",
            "started_at",
            "ended_at",
            "participants",
        ]
        read_only_fields = fields
