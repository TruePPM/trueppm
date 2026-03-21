"""DRF serializers for the projects app."""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Dependency,
    Project,
    Task,
)


class CalendarExceptionSerializer(serializers.ModelSerializer):
    class Meta:
        model = CalendarException
        fields = ["id", "exc_start", "exc_end", "description"]


class CalendarSerializer(serializers.ModelSerializer):
    exceptions = CalendarExceptionSerializer(many=True, read_only=True)

    class Meta:
        model = Calendar
        fields = [
            "id",
            "server_version",
            "name",
            "working_days",
            "hours_per_day",
            "timezone",
            "exceptions",
        ]
        read_only_fields = ["id", "server_version"]


class ProjectSerializer(serializers.ModelSerializer):
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
        read_only_fields = ["id", "server_version"]


class TaskSerializer(serializers.ModelSerializer):
    # Duration round-trips as integer working days.
    # CPM output fields are read-only — written by the scheduling engine.

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
        read_only_fields = [
            "id",
            "server_version",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
        ]


class DependencySerializer(serializers.ModelSerializer):
    class Meta:
        model = Dependency
        fields = ["id", "predecessor", "successor", "dep_type", "lag"]
        read_only_fields = ["id"]
