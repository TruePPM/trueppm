"""DRF serializers for the projects app."""

from __future__ import annotations

import uuid
from typing import Any

from django.utils import timezone
from rest_framework import serializers

from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    CalendarException,
    Dependency,
    Project,
    Risk,
    Task,
    TaskStatus,
)


class CalendarExceptionSerializer(serializers.ModelSerializer[CalendarException]):
    class Meta:
        model = CalendarException
        fields = ["id", "exc_start", "exc_end", "description"]


class CalendarSerializer(serializers.ModelSerializer[Calendar]):
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


class ProjectSerializer(serializers.ModelSerializer[Project]):
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


class TaskSerializer(serializers.ModelSerializer[Task]):
    # Duration round-trips as integer working days.
    # CPM output fields are read-only — written by the scheduling engine.
    #
    # Baseline overlay fields: populated when the queryset is annotated with
    # an active or explicit baseline (TaskViewSet.get_queryset).  Null when no
    # baseline is active for the project.
    baseline_start = serializers.DateField(read_only=True, allow_null=True, default=None)
    baseline_finish = serializers.DateField(read_only=True, allow_null=True, default=None)

    # Computed: actual_finish - early_finish in days.  Positive = late, negative = early.
    schedule_variance_days = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "name",
            "assignee",
            "wbs_path",
            "status",
            "duration",
            "percent_complete",
            "notes",
            "planned_start",
            "actual_start",
            "actual_finish",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
            "is_milestone",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "baseline_start",
            "baseline_finish",
            "schedule_variance_days",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "short_id",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
            "baseline_start",
            "baseline_finish",
            "schedule_variance_days",
        ]

    def get_schedule_variance_days(self, obj: Task) -> int | None:
        """Compute schedule variance: actual_finish - early_finish in calendar days."""
        if obj.actual_finish and obj.early_finish:
            return (obj.actual_finish - obj.early_finish).days
        return None

    def update(self, instance: Task, validated_data: dict[str, Any]) -> Task:
        """Auto-set actual dates on status transitions.

        Rules:
        - Any → IN_PROGRESS: set actual_start = today if currently null
        - Any → COMPLETE: set actual_finish = today; also set actual_start if null
        - COMPLETE → reopened (any non-COMPLETE status): clear actual_finish
        - Explicit values in the payload always take precedence over auto-set
        """
        new_status = validated_data.get("status")
        old_status = instance.status

        if new_status and new_status != old_status:
            today = timezone.localdate()

            # Reopening from COMPLETE: clear actual_finish unless explicitly provided.
            # Checked first so it applies regardless of the target status.
            if old_status == TaskStatus.COMPLETE and "actual_finish" not in validated_data:
                validated_data["actual_finish"] = None

            if new_status == TaskStatus.IN_PROGRESS:
                if "actual_start" not in validated_data and not instance.actual_start:
                    validated_data["actual_start"] = today

            elif new_status == TaskStatus.COMPLETE:
                if "actual_finish" not in validated_data:
                    validated_data["actual_finish"] = today
                if "actual_start" not in validated_data and not instance.actual_start:
                    validated_data["actual_start"] = today

        return super().update(instance, validated_data)


class TaskReorderSerializer(serializers.Serializer[Any]):
    """Validate the body for POST /api/v1/projects/{pk}/tasks/reorder/.

    Accepts the sibling list for a single WBS parent level and returns the new
    wbs_path for every repositioned task so the frontend can update its cache
    without a full refetch.

    parent_path: ltree string of the parent task (e.g. "1.2") or empty string
        for the root level.  The server validates that all ordered_ids are
        live siblings under this parent.
    ordered_ids: UUIDs of the siblings in the desired order.  Every live sibling
        under parent_path must appear — partial lists are rejected to prevent
        ambiguous gaps in the WBS sequence.
    """

    parent_path = serializers.CharField(allow_blank=True, default="")
    ordered_ids = serializers.ListField(
        child=serializers.UUIDField(),
        min_length=1,
    )


class TaskBulkItemSerializer(serializers.Serializer[Any]):
    """A single operation within a bulk task request.

    op: "create" | "update" | "delete"
    id: required for update/delete; omitted (or null) for create.
    data: task fields — all optional for update, required fields apply for create.
    """

    OP_CHOICES = ("create", "update", "delete")

    op = serializers.ChoiceField(choices=OP_CHOICES)
    id = serializers.UUIDField(required=False, allow_null=True)
    data = serializers.DictField(required=False, default=dict)  # type: ignore[assignment]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        op = attrs["op"]
        if op in ("update", "delete") and not attrs.get("id"):
            raise serializers.ValidationError({"id": f"'id' is required for op='{op}'."})
        return attrs


class TaskBulkSerializer(serializers.Serializer[Any]):
    """Validate the body for POST /api/v1/projects/{pk}/tasks/bulk/.

    Accepts a list of create/update/delete operations and executes them in a
    single atomic transaction.  Returns separate lists of affected task IDs so
    the client can invalidate the correct cache keys.
    """

    operations = serializers.ListField(
        child=TaskBulkItemSerializer(),
        min_length=1,
    )

    def validate_operations(self, ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Catch duplicate IDs within a single bulk request — the ordering of
        # concurrent updates to the same row is undefined so we reject it early.
        ids_seen: set[uuid.UUID] = set()
        for op in ops:
            task_id = op.get("id")
            if task_id is not None:
                if task_id in ids_seen:
                    raise serializers.ValidationError(f"Duplicate id {task_id} in operations list.")
                ids_seen.add(task_id)
        return ops


class BaselineTaskSerializer(serializers.ModelSerializer[BaselineTask]):
    """Read-only snapshot of a single task within a baseline."""

    class Meta:
        model = BaselineTask
        fields = [
            "task_id",
            "task_name",
            "start",
            "finish",
            "duration",
            "actual_start",
            "actual_finish",
        ]
        read_only_fields = fields


class BaselineSerializer(serializers.ModelSerializer[Baseline]):
    """List / create response shape for Baseline.

    task_count is annotated by BaselineViewSet.get_queryset() and is read-only.
    name is optional on create — the view supplies an auto-generated default.
    """

    task_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Baseline
        fields = [
            "id",
            "project",
            "name",
            "created_by",
            "created_at",
            "is_active",
            "has_cpm_dates",
            "task_count",
        ]
        read_only_fields = ["id", "project", "created_by", "created_at", "has_cpm_dates"]
        # name is optional on create — the view auto-generates "Baseline N" when omitted.
        extra_kwargs = {"name": {"required": False, "allow_blank": True}}


class BaselineDetailSerializer(BaselineSerializer):
    """Retrieve response — includes the full task snapshot."""

    tasks = BaselineTaskSerializer(many=True, read_only=True)

    class Meta(BaselineSerializer.Meta):
        fields = [*BaselineSerializer.Meta.fields, "tasks"]


class DependencySerializer(serializers.ModelSerializer[Dependency]):
    class Meta:
        model = Dependency
        fields = ["id", "predecessor", "successor", "dep_type", "lag"]
        read_only_fields = ["id"]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Enforce same-project constraint: the CPM engine assumes a single-project
        # DAG. Cross-project edges produce undefined scheduling behaviour.
        predecessor = attrs.get("predecessor") or (
            self.instance.predecessor if self.instance else None
        )
        successor = attrs.get("successor") or (self.instance.successor if self.instance else None)
        if predecessor and successor and predecessor.project_id != successor.project_id:
            raise serializers.ValidationError(
                "Predecessor and successor must belong to the same project."
            )
        return attrs


class RiskSerializer(serializers.ModelSerializer[Risk]):
    """Read/write serializer for project risks.

    severity is a computed read-only field (probability × impact); it is not
    stored in the database to avoid write-consistency hazards.

    tasks is a writable PrimaryKeyRelatedField that accepts task UUIDs on
    create and update.  The viewset annotates a severity DB expression on the
    queryset so OrderingFilter can sort without round-tripping to Python.
    """

    severity = serializers.SerializerMethodField()
    tasks = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Task.objects.filter(is_deleted=False),
        required=False,
    )

    def get_severity(self, obj: Risk) -> int:
        return obj.probability * obj.impact

    def validate_probability(self, value: int) -> int:
        if not 1 <= value <= 5:
            raise serializers.ValidationError("probability must be between 1 and 5.")
        return value

    def validate_impact(self, value: int) -> int:
        if not 1 <= value <= 5:
            raise serializers.ValidationError("impact must be between 1 and 5.")
        return value

    def validate_tasks(self, tasks: list[Task]) -> list[Task]:
        if len(tasks) > 10:
            raise serializers.ValidationError("A risk may link to at most 10 tasks.")
        return tasks

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # All linked tasks must belong to the same project as the risk.
        # project is read-only, so resolve from URL kwargs on create or from
        # the existing instance on update.
        request = self.context.get("request")
        if self.instance:
            project_pk = str(self.instance.project_id)
        elif request is not None:
            project_pk = str(request.parser_context["kwargs"].get("project_pk", ""))
        else:
            project_pk = ""
        tasks = attrs.get("tasks", [])
        if project_pk and tasks:
            bad = [t for t in tasks if str(t.project_id) != project_pk]
            if bad:
                raise serializers.ValidationError(
                    {"tasks": "All linked tasks must belong to the same project as this risk."}
                )
        return attrs

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
            "severity",
            "owner",
            "created_by",
            "created_at",
            "updated_at",
            "tasks",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "severity",
            "created_by",
            "created_at",
            "updated_at",
        ]
