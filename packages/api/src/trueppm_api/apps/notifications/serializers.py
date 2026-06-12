"""DRF serializers for the notifications app (ADR-0075)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from .models import (
    Mention,
    Notification,
    NotificationPreference,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
)


class MentionAuthorSerializer(serializers.Serializer[Any]):
    """Nested read-only user summary for Mention.mentioner / mentioned_user."""

    id = serializers.UUIDField(read_only=True)
    username = serializers.CharField(read_only=True)
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        name: str = obj.get_full_name() or obj.username
        return name


class MentionSerializer(serializers.ModelSerializer[Mention]):
    """Read-only serializer for Mention.

    Mentions are append-only — no write path through this serializer. Created
    indirectly via TaskCommentSerializer.create + services.create_mention_notifications.
    """

    mentioner = MentionAuthorSerializer(read_only=True)
    mentioned_user = MentionAuthorSerializer(read_only=True)

    class Meta:
        model = Mention
        fields = [
            "id",
            "mentioner",
            "mentioned_user",
            "mentioned_group_key",
            "scope",
            "task_comment",
            "created_at",
        ]
        read_only_fields = fields


class NotificationSerializer(serializers.ModelSerializer[Notification]):
    """Per-recipient inbox row.

    Writes are limited to is_read / is_archived (PATCH-only on the viewset).
    All other fields are read-only.
    """

    mention = MentionSerializer(read_only=True)
    snippet = serializers.SerializerMethodField()
    task_id = serializers.SerializerMethodField()

    def get_snippet(self, obj: Notification) -> str:
        """Short preview of the source mention's body.

        Truncated to 200 chars. Returns empty string if the source is
        unavailable (e.g. comment soft-deleted).

        NOTE (ADR-0075 §A.5, MentionScope): only PROJECT_VISIBLE scope is in
        play in 0.2, so any recipient (who was a project member at mention
        time) can see the body via this snippet — historical-record semantics.
        When #476 lands TEAM_ONLY scope this method MUST re-check current
        project membership at read time and return "" if the user is no
        longer a member of the source project. See N-1 in RBAC audit.
        """
        mention = obj.mention
        if mention is None:
            return ""
        comment = mention.task_comment
        if comment is None or comment.is_deleted:
            return ""
        body = comment.body or ""
        return body[:200]

    def get_task_id(self, obj: Notification) -> str | None:
        # Event-sourced rows (#497/#861) carry a direct deep-link FK; mention
        # rows resolve their task through the source comment. Prefer the explicit
        # FK so the inbox row links to the affected task/milestone either way.
        if obj.task_id is not None:
            return str(obj.task_id)
        mention = obj.mention
        if mention is None or mention.task_comment is None:
            return None
        return str(mention.task_comment.task_id)

    class Meta:
        model = Notification
        fields = [
            "id",
            "recipient",
            "mention",
            "project",
            "is_read",
            "is_archived",
            "created_at",
            "read_at",
            "snippet",
            "task_id",
        ]
        read_only_fields = [
            "id",
            "recipient",
            "mention",
            "project",
            "created_at",
            "read_at",
            "snippet",
            "task_id",
        ]


class NotificationPreferenceSerializer(serializers.ModelSerializer[NotificationPreference]):
    """Per-user (event_type, channel) toggle.

    PATCH on the viewset only modifies `enabled` — event_type / channel /
    user are immutable.
    """

    class Meta:
        model = NotificationPreference
        fields = ["id", "event_type", "channel", "enabled", "updated_at"]
        read_only_fields = ["id", "event_type", "channel", "updated_at"]


# ---------------------------------------------------------------------------
# Project-scoped preferences (#522)
# ---------------------------------------------------------------------------


_VALID_EVENT_TYPES = {choice.value for choice in ProjectNotificationEventType}
_VALID_CHANNELS = {choice.value for choice in ProjectNotificationChannel}


class _ProjectNotificationMatrixField(serializers.JSONField):
    """JSON matrix `{event_type: {channel: bool}}` with strict key validation.

    Rejects unknown event types and channels at the serializer layer so a
    typo in the client doesn't silently corrupt the stored matrix. Non-bool
    leaves are also rejected — there is no "tri-state" toggle.
    """

    def to_internal_value(self, data: Any) -> dict[str, dict[str, bool]]:
        value = super().to_internal_value(data)
        if not isinstance(value, dict):
            raise serializers.ValidationError("matrix must be a JSON object")
        validated: dict[str, dict[str, bool]] = {}
        for event_type, channels in value.items():
            if event_type not in _VALID_EVENT_TYPES:
                raise serializers.ValidationError(f"Unknown event_type: {event_type!r}")
            if not isinstance(channels, dict):
                raise serializers.ValidationError(
                    f"matrix[{event_type!r}] must be an object of channel→bool"
                )
            row: dict[str, bool] = {}
            for channel, enabled in channels.items():
                if channel not in _VALID_CHANNELS:
                    raise serializers.ValidationError(f"Unknown channel: {channel!r}")
                if not isinstance(enabled, bool):
                    raise serializers.ValidationError(
                        f"matrix[{event_type!r}][{channel!r}] must be a boolean"
                    )
                row[channel] = enabled
            validated[event_type] = row
        return validated


class ProjectNotificationPreferenceSerializer(
    serializers.ModelSerializer[ProjectNotificationPreference]
):
    """Per-(project, user) notification preferences.

    The full matrix and quiet-hours window are returned in one document; the
    PATCH path merges the supplied matrix onto the stored one so a partial
    toggle does not have to repost the full 9×4 grid.
    """

    matrix = _ProjectNotificationMatrixField()

    class Meta:
        model = ProjectNotificationPreference
        fields = [
            "matrix",
            "paused",
            "quiet_hours_enabled",
            "quiet_hours_from",
            "quiet_hours_until",
            "updated_at",
        ]
        read_only_fields = ["updated_at"]
