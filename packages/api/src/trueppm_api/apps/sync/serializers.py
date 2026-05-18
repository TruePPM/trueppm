"""Serializers for the sync pull endpoint.

Sync serializers always include server_version and is_deleted so mobile
clients can track changes precisely. They are intentionally separate from
the CRUD serializers — their contract is with the mobile offline store,
not the REST API consumer.
"""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    RetroActionItem,
    Risk,
    Sprint,
    SprintRetro,
    Task,
    TaskSuggestedAssignee,
)


class SyncCalendarSerializer(serializers.ModelSerializer[Calendar]):
    """Sync payload for Calendar — excludes exceptions (synced separately via SyncView)."""

    class Meta:
        model = Calendar
        fields = [
            "id",
            "server_version",
            "name",
            "working_days",
            "hours_per_day",
            "timezone",
        ]


class SyncProjectSerializer(serializers.ModelSerializer[Project]):
    """Sync payload for Project — minimal shape consumed by the WatermelonDB Project table.

    ``program`` (ADR-0070) is included so mobile can render the program badge
    on project rows offline. Program and ProgramMembership tables themselves
    are not yet wired into mobile sync — the existing endpoint is project-scoped
    and cannot reach user-scoped Program rows. Mobile-side Program sync is
    tracked as a follow-up; for now mobile uses the REST endpoints online and
    falls back to the cached project rows (with their ``program`` FK) offline.
    """

    class Meta:
        model = Project
        fields = [
            "id",
            "server_version",
            "name",
            "description",
            "start_date",
            "calendar",
            "program",
        ]


class SyncTaskSerializer(serializers.ModelSerializer[Task]):
    """Sync payload for Task — full CPM and baseline fields for offline scheduling previews."""

    class Meta:
        model = Task
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "name",
            "wbs_path",
            "status",
            "duration",
            "percent_complete",
            "notes",
            "planned_start",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
            "is_milestone",
            "actual_start",
            "actual_finish",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "is_subtask",
            "sprint",
            "assignee",
        ]


class SyncDependencySerializer(serializers.ModelSerializer[Dependency]):
    """Sync payload for Dependency links — includes server_version for delta tracking."""

    class Meta:
        model = Dependency
        fields = ["id", "server_version", "predecessor", "successor", "dep_type", "lag"]


class SyncMembershipSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Sync payload for ProjectMembership — lets mobile clients enforce offline RBAC."""

    class Meta:
        model = ProjectMembership
        fields = ["id", "server_version", "project", "user", "role"]


class SyncSprintSerializer(serializers.ModelSerializer[Sprint]):
    """Sync payload for Sprint — enables offline sprint context for retros (ADR-0071)."""

    class Meta:
        model = Sprint
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "name",
            "goal",
            "start_date",
            "finish_date",
            "state",
        ]


class SyncSprintRetroSerializer(serializers.ModelSerializer[SprintRetro]):
    """Sync payload for SprintRetro (ADR-0071).

    Mobile receives the raw notes only when the caller's role meets the
    retro's team_visibility threshold; the sync view is responsible for
    filtering retros the caller cannot see. WatermelonDB stores what it
    receives — the server-side visibility gate is the only check.
    """

    class Meta:
        model = SprintRetro
        fields = [
            "id",
            "server_version",
            "sprint",
            "notes",
            "team_visibility",
            "created_by",
            "created_at",
            "updated_at",
        ]


class SyncRetroActionItemSerializer(serializers.ModelSerializer[RetroActionItem]):
    """Sync payload for RetroActionItem (ADR-0071)."""

    class Meta:
        model = RetroActionItem
        fields = [
            "id",
            "server_version",
            "retro",
            "text",
            "assignee",
            "story_points",
            "promoted_task_id",
            "created_at",
        ]


class SyncTaskSuggestedAssigneeSerializer(serializers.ModelSerializer[TaskSuggestedAssignee]):
    """Sync payload for TaskSuggestedAssignee (ADR-0071 §5)."""

    class Meta:
        model = TaskSuggestedAssignee
        fields = [
            "id",
            "server_version",
            "task",
            "suggested_user",
            "suggested_by",
            "reason",
            "source",
            "state",
            "created_at",
            "accepted_at",
            "declined_at",
        ]


class SyncRiskSerializer(serializers.ModelSerializer[Risk]):
    """Sync serializer for the Risk model.

    task_ids is serialized as a flat list of task UUIDs (string) rather than
    a nested M2M sync table. Expected cardinality is 1–10 tasks per risk, so
    a JSON column on the WatermelonDB Risk record is simpler and sufficient.
    The queryset in ProjectSyncView prefetches tasks to avoid N+1.
    """

    task_ids = serializers.SerializerMethodField()

    def get_task_ids(self, obj: Risk) -> list[str]:
        # Iterate the prefetched cache; values_list() bypasses it and fires an extra SELECT.
        return [str(t.pk) for t in obj.tasks.all()]

    class Meta:
        model = Risk
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "title",
            "description",
            "status",
            "probability",
            "impact",
            "owner",
            "task_ids",
        ]
