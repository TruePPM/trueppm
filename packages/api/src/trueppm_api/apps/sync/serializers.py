"""Serializers for the sync pull endpoint.

Sync serializers always include server_version and is_deleted so mobile
clients can track changes precisely. They are intentionally separate from
the CRUD serializers — their contract is with the mobile offline store,
not the REST API consumer.
"""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Risk, Task


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
    """Sync payload for Project — minimal shape consumed by the WatermelonDB Project table."""

    class Meta:
        model = Project
        fields = [
            "id",
            "server_version",
            "name",
            "description",
            "start_date",
            "calendar",
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
