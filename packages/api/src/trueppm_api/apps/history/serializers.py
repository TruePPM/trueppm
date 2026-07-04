"""Serializers for the object change history API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers


class HistoryUserSerializer(serializers.Serializer[Any]):
    """Minimal user representation in a history record."""

    id = serializers.UUIDField()
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        full = f"{obj.first_name} {obj.last_name}".strip()
        return full or obj.username


class FieldDiffSerializer(serializers.Serializer[Any]):
    """A single field change within a history record."""

    field = serializers.CharField()
    old = serializers.JSONField(allow_null=True)
    new = serializers.JSONField(allow_null=True)


class HistoryRecordSerializer(serializers.Serializer[Any]):
    """Serialised form of a single django-simple-history HistoricalRecord.

    ``history_user`` is exposed only to Owner/Admin callers (role >= Role.ADMIN).  The
    view sets ``hide_user=True`` on the serializer context for lower-privilege
    callers so this field returns null.

    ``diff`` is computed by the view via ``prev_record`` comparison and injected
    into context so the serializer doesn't need ORM access.
    """

    id = serializers.SerializerMethodField()
    history_date = serializers.DateTimeField()
    history_type = serializers.CharField()
    history_change_reason = serializers.CharField(allow_null=True)
    history_user = serializers.SerializerMethodField()
    diff = serializers.SerializerMethodField()

    def get_id(self, obj: Any) -> str:
        return str(obj.history_id)

    def get_history_user(self, obj: Any) -> dict[str, Any] | None:
        if self.context.get("hide_user"):
            return None
        user = obj.history_user
        if user is None:
            return None
        return HistoryUserSerializer(user).data

    def get_diff(self, obj: Any) -> list[dict[str, Any]]:
        diffs: dict[int, list[dict[str, Any]]] = self.context.get("diffs", {})
        return diffs.get(obj.history_id, [])


class ChangelogEntrySerializer(serializers.Serializer[Any]):
    """One row in the unified project changelog (ADR-0201).

    The instance is a plain dict from ``changelog.build_project_changelog`` — the
    aggregator already merged, ordered, and diffed across the historical tables,
    so the serializer only renders. ``user`` is exposed only to Owner/Admin
    callers (``hide_user=True`` in context returns null), reusing the same gate as
    :class:`HistoryRecordSerializer`.
    """

    id = serializers.CharField()
    object_type = serializers.CharField()
    object_id = serializers.CharField()
    object_label = serializers.CharField()
    change_type = serializers.ChoiceField(choices=["created", "updated", "deleted"])
    history_date = serializers.DateTimeField()
    user = serializers.SerializerMethodField()
    changes = FieldDiffSerializer(many=True)

    def get_user(self, obj: dict[str, Any]) -> dict[str, Any] | None:
        if self.context.get("hide_user"):
            return None
        user = obj.get("history_user")
        if user is None:
            return None
        return HistoryUserSerializer(user).data


class ChangelogResponseSerializer(serializers.Serializer[Any]):
    """Response envelope for the unified project changelog (ADR-0201)."""

    results = ChangelogEntrySerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True)
