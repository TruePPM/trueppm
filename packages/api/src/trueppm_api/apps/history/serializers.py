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

    ``history_user`` is exposed only to Owner/Admin callers (role >= 3).  The
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
        return HistoryUserSerializer(user).data  # type: ignore[return-value]

    def get_diff(self, obj: Any) -> list[dict[str, Any]]:
        diffs: dict[int, list[dict[str, Any]]] = self.context.get("diffs", {})
        return diffs.get(obj.history_id, [])
