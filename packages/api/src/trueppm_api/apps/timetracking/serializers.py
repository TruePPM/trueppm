"""Serializers for the time-tracking REST surface (ADR-0185 §4)."""

from __future__ import annotations

from datetime import date, timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework import serializers

from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry


def _backdate_window_days() -> int:
    """Manual-entry backdate window (settings ``TIMETRACKING_BACKDATE_DAYS``, default 60)."""
    return int(getattr(settings, "TIMETRACKING_BACKDATE_DAYS", 60))


def _timer_max_minutes() -> int:
    return int(getattr(settings, "TIMETRACKING_TIMER_MAX_MINUTES", 600))


class TimeEntrySerializer(serializers.ModelSerializer[TimeEntry]):
    """Read/write serializer for a single :class:`TimeEntry` (create + author-only PATCH).

    ``task``, ``user``, ``source``, ``server_version`` and ``created_at`` are read-only:
    the task comes from the nested route (not the body), the owner is server-set
    (IDOR-safe), and provenance is server-decided. Only ``minutes``/``entry_date``/
    ``note`` are writable. ``validate_entry_date`` enforces the no-future / backdate-
    window rule (ADR-0185 §Consequences) — it applies only to manual writes, since timer
    entries set ``entry_date`` in the service and never pass through this serializer.
    """

    class Meta:
        model = TimeEntry
        fields = [
            "id",
            "task",
            "user",
            "minutes",
            "entry_date",
            "note",
            "source",
            "server_version",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "task",
            "user",
            "source",
            "server_version",
            "created_at",
        ]

    def validate_entry_date(self, value: date) -> date:
        today = timezone.localdate()
        if value > today:
            raise serializers.ValidationError("Entry date cannot be in the future.")
        window = _backdate_window_days()
        if value < today - timedelta(days=window):
            raise serializers.ValidationError(
                f"Entry date cannot be more than {window} days in the past."
            )
        return value


class TimeEntryWeeklySerializer(serializers.ModelSerializer[TimeEntry]):
    """Enriched read serializer for the weekly cross-project grid (ADR-0185 §4).

    Carries the task and project labels the grid renders so the client needs no second
    round-trip. The viewset ``select_related("task", "task__project")``, so these nested
    reads add no per-row query (N+1-safe — asserted by ``assertNumQueries``).
    """

    task_short_id = serializers.CharField(source="task.short_id", read_only=True)
    task_name = serializers.CharField(source="task.name", read_only=True)
    project = serializers.UUIDField(source="task.project_id", read_only=True)
    project_code = serializers.CharField(source="task.project.code", read_only=True)
    project_name = serializers.CharField(source="task.project.name", read_only=True)

    class Meta:
        model = TimeEntry
        fields = [
            "id",
            "task",
            "task_short_id",
            "task_name",
            "project",
            "project_code",
            "project_name",
            "minutes",
            "entry_date",
            "note",
            "source",
            "server_version",
            "created_at",
        ]


class ActiveTimerSerializer(serializers.ModelSerializer[ActiveTimer]):
    """Read serializer for the running timer (``GET /me/timer/`` active branch).

    ``elapsed_seconds`` and ``stale`` are server-computed from the authoritative
    ``started_at`` clock so every device agrees regardless of when it last polled.
    ``stale`` flips once elapsed exceeds the ceiling, prompting the UI rather than
    silently logging a weekend (ADR-0185 §2).
    """

    task_short_id = serializers.CharField(source="task.short_id", read_only=True)
    task_name = serializers.CharField(source="task.name", read_only=True)
    project = serializers.UUIDField(source="task.project_id", read_only=True)
    elapsed_seconds = serializers.SerializerMethodField()
    stale = serializers.SerializerMethodField()

    class Meta:
        model = ActiveTimer
        fields = [
            "id",
            "task",
            "task_short_id",
            "task_name",
            "project",
            "started_at",
            "elapsed_seconds",
            "note",
            "stale",
        ]

    def get_elapsed_seconds(self, obj: ActiveTimer) -> int:
        return int((timezone.now() - obj.started_at).total_seconds())

    def get_stale(self, obj: ActiveTimer) -> bool:
        return self.get_elapsed_seconds(obj) > _timer_max_minutes() * 60


class TimerStartSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Validate the ``POST /me/timer/start`` body (ADR-0185 §4).

    Only ``task`` (uuid) and an optional ``note`` are accepted. Task resolution,
    membership scoping (404), and the ``can_log_time`` role gate (403) are enforced in
    the view against a membership-scoped queryset so existence is never leaked.
    """

    task = serializers.UUIDField()
    note = serializers.CharField(required=False, allow_blank=True, max_length=500, default="")
