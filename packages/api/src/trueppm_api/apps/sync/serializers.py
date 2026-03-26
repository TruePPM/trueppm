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
    class Meta:
        model = Task
        fields = [
            "id",
            "server_version",
            "project",
            "name",
            "wbs_path",
            "duration",
            "percent_complete",
            "notes",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
        ]


class SyncDependencySerializer(serializers.ModelSerializer[Dependency]):
    class Meta:
        model = Dependency
        fields = ["id", "server_version", "predecessor", "successor", "dep_type", "lag"]


class SyncMembershipSerializer(serializers.ModelSerializer[ProjectMembership]):
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
        return [str(pk) for pk in obj.tasks.values_list("id", flat=True)]

    class Meta:
        model = Risk
        fields = [
            "id",
            "server_version",
            "project",
            "title",
            "description",
            "status",
            "probability",
            "impact",
            "owner",
            "task_ids",
        ]
