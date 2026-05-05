"""DRF serializers for the projects app."""

from __future__ import annotations

import re
import uuid
from typing import Any

from django.utils import timezone
from rest_framework import serializers

from trueppm_api.apps.projects.models import (
    _VALID_EVM_MODES,
    _VALID_SORT_KEYS,
    Baseline,
    BaselineTask,
    BoardSavedView,
    Calendar,
    CalendarException,
    Dependency,
    EstimateStatus,
    EstimationMode,
    Project,
    RetroActionItem,
    Risk,
    RiskComment,
    Sprint,
    SprintBurnSnapshot,
    SprintRetro,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.resources.models import TaskResource


class CalendarExceptionSerializer(serializers.ModelSerializer[CalendarException]):
    """Read-only snapshot of a single calendar exception (holiday or non-working span)."""

    class Meta:
        model = CalendarException
        fields = ["id", "exc_start", "exc_end", "description"]


class CalendarSerializer(serializers.ModelSerializer[Calendar]):
    """Read/write serializer for project calendars.

    Nests exceptions as read-only — exceptions are managed through the
    /calendars/{pk}/exceptions/ sub-resource, not via this serializer.
    """

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
    """Read/write serializer for projects.

    calendar is optional on create — the API will use the board's default
    calendar when omitted.

    estimation_mode controls who may write three-point estimates on tasks.
    Defaults to 'open'; writable by IsProjectScheduler+ only (enforced in
    ProjectViewSet.update via permission check on the field).
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
            "estimation_mode",
            "agile_features",
            "methodology",
        ]
        read_only_fields = ["id", "server_version"]


class TaskAssignmentSerializer(serializers.ModelSerializer[TaskResource]):
    """Lightweight read-only serializer for task-resource assignments.

    Nested inside TaskSerializer so the Gantt can display assignee chips
    without a separate API call per task.
    """

    resource_id = serializers.UUIDField(source="resource.id", read_only=True)
    resource_name = serializers.CharField(source="resource.name", read_only=True)

    class Meta:
        model = TaskResource
        fields = ["resource_id", "resource_name", "units"]
        read_only_fields = fields


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

    # Summary task annotations — computed from wbs_path hierarchy, not stored.
    is_summary = serializers.BooleanField(read_only=True, default=False)
    parent_id = serializers.UUIDField(read_only=True, allow_null=True, default=None)

    # Nested resource assignments — read-only, used for Gantt assignee chips.
    assignments = TaskAssignmentSerializer(many=True, read_only=True)

    # Computed readiness state for board cards (issue #179).  Derived from
    # assignee_id, baseline_start annotation, and has_predecessors annotation
    # added by TaskViewSet.get_queryset().
    readiness = serializers.SerializerMethodField()

    # Board batch 3 PPM signal annotations (ADR-0035).  Populated by
    # TaskViewSet.get_queryset(); default to safe zero values for callers that
    # bypass the viewset (e.g. nested serialization in tests).
    predecessor_count = serializers.IntegerField(read_only=True, default=0)
    is_blocked = serializers.BooleanField(read_only=True, default=False)
    linked_risks_count = serializers.IntegerField(read_only=True, default=0)
    linked_risks_max_severity = serializers.IntegerField(
        read_only=True, allow_null=True, default=None
    )

    # TODO(#185): cpi, actual_cost, and budget_at_completion are intentionally
    # absent from this serializer until the cost model (#73, #74) is
    # implemented.  BoardCard.tsx renders CPI and cost chips that no-op
    # gracefully when these fields are absent.  See ADR-0035 § Q5.

    # Wave 3 (#210) — passive overalloc indicator in the task detail drawer.
    # True when the assignee's TaskResource.units across active tasks in this
    # project sum to > 1.0.  Annotated by TaskViewSet.get_queryset(); defaults
    # to False so the drawer never shows a stale warning when called outside the
    # viewset (e.g. in tests or nested serializers).
    assignee_is_overallocated = serializers.BooleanField(read_only=True, default=False)

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
            "estimate_status",
            "baseline_start",
            "baseline_finish",
            "schedule_variance_days",
            "is_summary",
            "parent_id",
            "assignments",
            "readiness",
            "predecessor_count",
            "is_blocked",
            "linked_risks_count",
            "linked_risks_max_severity",
            "status_changed_at",
            "priority_rank",
            "assignee_is_overallocated",
            "sprint",
            "story_points",
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
            "is_summary",
            "parent_id",
            "assignments",
            "readiness",
            "predecessor_count",
            "is_blocked",
            "linked_risks_count",
            "linked_risks_max_severity",
            "status_changed_at",
            "assignee_is_overallocated",
        ]

    def get_schedule_variance_days(self, obj: Task) -> int | None:
        """Compute schedule variance: actual_finish - early_finish in calendar days."""
        if obj.actual_finish and obj.early_finish:
            return (obj.actual_finish - obj.early_finish).days
        return None

    def get_readiness(self, obj: Task) -> str:
        """Derive board-card readiness from available task fields.

        Resolution order (highest specificity first):
        - baselined: task appears in the active baseline (baseline_start is annotated)
        - idea: no assignee AND still in BACKLOG (unrefined, uncommitted)
        - ready: has assignee + at least one predecessor dependency
        - estimated: has assignee without predecessors, OR promoted out of BACKLOG
                     without an assignee (committed but unowned — ADR-0047)

        Semantic boundary: 'idea' only applies while status == BACKLOG. Once a PM
        moves a card to any working column they have made a commitment decision;
        ghost styling is suppressed even if no assignee has been set yet.
        """
        if getattr(obj, "baseline_start", None) is not None:
            return "baselined"
        if obj.assignee_id is None:
            return "idea" if obj.status == TaskStatus.BACKLOG else "estimated"
        if getattr(obj, "has_predecessors", False):
            return "ready"
        return "estimated"

    def to_representation(self, instance: Task) -> dict[str, Any]:
        """Override percent_complete for summary tasks with duration-weighted child average."""
        data = super().to_representation(instance)
        if data.get("is_summary") and instance.wbs_path:
            # Direct children only: ltree ~ 'parent_path.*{1}' matches exactly
            # one level deeper. Uses RawSQL to leverage the GiST index.
            children = Task.objects.raw(
                "SELECT id, duration, percent_complete FROM projects_task"
                " WHERE project_id = %s"
                "   AND is_deleted = false"
                "   AND wbs_path ~ (%s || '.*{1}')::lquery",
                [instance.project_id, str(instance.wbs_path)],
            )
            total_duration = sum(c.duration for c in children)
            if total_duration > 0:
                weighted = sum(c.duration * c.percent_complete for c in children)
                data["percent_complete"] = round(weighted / total_duration, 2)
        return data

    def update(self, instance: Task, validated_data: dict[str, Any]) -> Task:
        """Auto-set actual dates on status transitions and enforce estimate governance.

        Status transition rules:
        - Any → IN_PROGRESS: set actual_start = today if currently null
        - Any → COMPLETE: set actual_finish = today; also set actual_start if null
        - COMPLETE → reopened (any non-COMPLETE status): clear actual_finish
        - NOT_STARTED + planned_start ≤ today (no explicit status): auto-promote
          to IN_PROGRESS. The unified Schedule/Board data-model rule (#336) says
          IN_PROGRESS means "actual work has begun" in both views; setting a
          today-or-past planned_start is the system-wide signal that work has
          started, regardless of which UI affordance the caller used (gutter
          promote, Gantt drag, drawer date edit, integration sync). Past dates
          also pin actual_start to planned_start so the historical start isn't
          overwritten by the auto-`actual_start = today` rule below.
        - Explicit values in the payload always take precedence over auto-set

        Also resets early_start when planned_start changes so the frontend's
        max(planned_start, early_start) logic doesn't snap the Gantt bar back
        to the pre-drag CPM value before the next CPM run completes.
        CPM will re-compute early_start correctly once it runs.

        Estimate governance:
        - If any PERT field is being written and the project is in SUGGEST_APPROVE
          mode, set estimate_status=pending (unless the caller is Scheduler+ — that
          is enforced upstream in the view by calling approve_estimates() instead).
        - In OPEN or PM_ONLY modes estimate_status is left null (not tracked).
        - estimate_status is never set by this method to 'accepted' — that path goes
          through the dedicated approve-estimates action on TaskViewSet.
        """
        if (
            "planned_start" in validated_data
            and validated_data["planned_start"] != instance.planned_start
            and "early_start" not in validated_data
        ):
            validated_data["early_start"] = validated_data["planned_start"]

        # Date-gated NOT_STARTED → IN_PROGRESS auto-transition (#336).
        # Runs before the status-transition block below so the injected status
        # is treated as a normal transition (auto-`actual_start = today` for
        # today's drops; explicit `actual_start = planned_start` for past drops
        # is set here so the IN_PROGRESS block at L317 doesn't overwrite it).
        if (
            "planned_start" in validated_data
            and validated_data["planned_start"] is not None
            and "status" not in validated_data
            and instance.status == TaskStatus.NOT_STARTED
            and validated_data["planned_start"] <= timezone.localdate()
        ):
            validated_data["status"] = TaskStatus.IN_PROGRESS
            if (
                validated_data["planned_start"] < timezone.localdate()
                and "actual_start" not in validated_data
            ):
                validated_data["actual_start"] = validated_data["planned_start"]

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

        # Estimate governance: mark as pending when PERT fields are written in
        # suggest_approve mode. Caller must not pass estimate_status directly;
        # the approve-estimates action is the only path to 'accepted'.
        _pert_fields = {"optimistic_duration", "most_likely_duration", "pessimistic_duration"}
        if _pert_fields & set(validated_data):
            project = instance.project
            if project.estimation_mode == EstimationMode.SUGGEST_APPROVE:
                validated_data["estimate_status"] = EstimateStatus.PENDING
            else:
                # OPEN or PM_ONLY: clear status tracking — not applicable.
                validated_data["estimate_status"] = None

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
    """Read/write serializer for task dependencies (FS/SS/FF/SF links with optional lag).

    Cross-project edges are rejected in validate() because the CPM engine
    assumes a single-project DAG.
    """

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


# 5-column model per Claude Design handoff (issue #178).  Per ADR-0039 the
# default JSON shape now carries optional `color` and `wip_limit` keys so
# new projects render the brand semantic palette without a settings round-trip.
_DEFAULT_COLUMNS = [
    {
        "status": "BACKLOG",
        "label": "Backlog",
        "visible": True,
        "color": "#94A3B8",
        "wip_limit": None,
    },
    {
        "status": "NOT_STARTED",
        "label": "To Do",
        "visible": True,
        "color": "#64748B",
        "wip_limit": None,
    },
    {
        "status": "IN_PROGRESS",
        "label": "In Progress",
        "visible": True,
        "color": "#3B82F6",
        "wip_limit": 5,
    },
    {"status": "REVIEW", "label": "Review", "visible": True, "color": "#A855F7", "wip_limit": 3},
    {"status": "COMPLETE", "label": "Done", "visible": True, "color": "#22C55E", "wip_limit": None},
]

# Canonical statuses that must appear in every board config.  ON_HOLD is
# excluded — it is a legacy value kept for data compatibility only and is
# never required in new board configurations.
_CANONICAL_STATUSES = frozenset({"BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE"})

_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


class BoardColumnConfigSerializer(serializers.Serializer[dict[str, Any]]):
    """Read/write serializer for BoardColumnConfig.

    Validates each column entry: status must be one of the five canonical
    statuses, label ≤ 32 chars, visible is a bool. All five canonical statuses
    must appear exactly once (no duplicates, no missing values).

    Optional per-column metadata (ADR-0039):
        color:      "#RRGGBB" hex string or null
        wip_limit:  positive integer or null

    Unknown keys are dropped silently — the validated payload only contains
    the five recognized keys, preventing forward-compat key smuggling.
    """

    columns = serializers.ListField(child=serializers.DictField(), allow_empty=False)

    def validate_columns(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[str] = set()
        normalized: list[dict[str, Any]] = []
        for entry in value:
            status = entry.get("status")
            label = entry.get("label")
            visible = entry.get("visible")
            color = entry.get("color")
            wip_limit = entry.get("wip_limit")
            if status not in _CANONICAL_STATUSES:
                raise serializers.ValidationError(f"Unknown status: {status!r}")
            if status in seen:
                raise serializers.ValidationError(f"Duplicate status: {status!r}")
            seen.add(status)
            if not isinstance(label, str) or len(label) > 32:
                raise serializers.ValidationError("label must be a string ≤ 32 chars")
            if not isinstance(visible, bool):
                raise serializers.ValidationError("visible must be a boolean")
            if color is not None and not (
                isinstance(color, str) and _HEX_COLOR_RE.fullmatch(color)
            ):
                raise serializers.ValidationError("color must be a #RRGGBB hex string or null")
            # bool is a subclass of int — reject True/False explicitly.
            if wip_limit is not None and (
                isinstance(wip_limit, bool) or not isinstance(wip_limit, int) or wip_limit < 1
            ):
                raise serializers.ValidationError("wip_limit must be a positive integer or null")
            normalized.append(
                {
                    "status": status,
                    "label": label,
                    "visible": visible,
                    "color": color,
                    "wip_limit": wip_limit,
                }
            )
        missing = _CANONICAL_STATUSES - seen
        if missing:
            raise serializers.ValidationError(f"Missing statuses: {missing}")
        return normalized


class BoardSavedViewSerializer(serializers.ModelSerializer[BoardSavedView]):
    """Read/write serializer for BoardSavedView.

    config is validated on write to enforce the known schema keys and value
    ranges. Unknown keys are dropped silently to allow forward-compatible
    extensions without breaking older clients.

    created_by is set automatically from request.user on create and is
    read-only thereafter.
    """

    created_by = serializers.SerializerMethodField()

    def get_created_by(self, obj: BoardSavedView) -> str | None:
        return str(obj.created_by_id) if obj.created_by_id else None

    def validate_config(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise serializers.ValidationError("config must be an object")
        sort = value.get("sort", "priority")
        if sort not in _VALID_SORT_KEYS:
            raise serializers.ValidationError(
                f"config.sort must be one of {sorted(_VALID_SORT_KEYS)}"
            )
        evm_mode = value.get("evm_mode", "off")
        if evm_mode not in _VALID_EVM_MODES:
            raise serializers.ValidationError(
                f"config.evm_mode must be one of {sorted(_VALID_EVM_MODES)}"
            )
        for bool_key in ("show_wip", "show_col_tints", "show_cost", "risk_linked_only"):
            v = value.get(bool_key)
            if v is not None and not isinstance(v, bool):
                raise serializers.ValidationError(f"config.{bool_key} must be a boolean")
        return {
            "sort": sort,
            "show_wip": bool(value.get("show_wip", True)),
            "show_col_tints": bool(value.get("show_col_tints", True)),
            "evm_mode": evm_mode,
            "show_cost": bool(value.get("show_cost", False)),
            "risk_linked_only": bool(value.get("risk_linked_only", False)),
        }

    class Meta:
        model = BoardSavedView
        fields = [
            "id",
            "name",
            "config",
            "created_by",
            "server_version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "created_by",
            "created_at",
            "updated_at",
        ]


class RiskSerializer(serializers.ModelSerializer[Risk]):
    """Read/write serializer for project risks.

    severity is a computed read-only field (probability × impact); it is not
    stored in the database to avoid write-consistency hazards.

    tasks is a writable PrimaryKeyRelatedField that accepts task UUIDs on
    create and update.  The viewset annotates a severity DB expression on the
    queryset so OrderingFilter can sort without round-tripping to Python.
    """

    severity = serializers.SerializerMethodField()
    owner_name = serializers.SerializerMethodField()
    owner_initials = serializers.SerializerMethodField()
    tasks = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Task.objects.filter(is_deleted=False),
        required=False,
    )

    def get_severity(self, obj: Risk) -> int:
        return obj.probability * obj.impact

    def get_owner_name(self, obj: Risk) -> str | None:
        """Display name for the owner — first+last, falling back to username.

        Resolved here instead of via a select_related on the queryset to keep
        the registry list payload small when callers don't need it (mobile).
        """
        owner = obj.owner
        if owner is None:
            return None
        name = f"{owner.first_name} {owner.last_name}".strip()
        return name if name else owner.username

    def get_owner_initials(self, obj: Risk) -> str | None:
        owner = obj.owner
        if owner is None:
            return None
        parts: list[str] = []
        if owner.first_name:
            parts.append(owner.first_name[0].upper())
        if owner.last_name:
            parts.append(owner.last_name[0].upper())
        if parts:
            return "".join(parts[:2])
        return owner.username[:2].upper()

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

    def validate_mitigation_due_date(self, value: Any) -> Any:
        # Non-blocking: accept past dates so PMs can save overdue risks without
        # being blocked. The overdue state is surfaced as a UI badge on the
        # client; blocking here would prevent updating other fields on a risk
        # whose mitigation deadline has already slipped.
        return value

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
            "category",
            "response",
            "mitigation_due_date",
            "trigger",
            "contingency",
            "owner",
            "owner_name",
            "owner_initials",
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
            "owner_name",
            "owner_initials",
            "created_by",
            "created_at",
            "updated_at",
        ]


class RiskCommentAuthorSerializer(serializers.Serializer[Any]):
    """Minimal author representation embedded in RiskCommentSerializer."""

    id = serializers.UUIDField()
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        name: str = obj.get_full_name() or obj.username
        return name


class RiskCommentSerializer(serializers.ModelSerializer[RiskComment]):
    """Read/write serializer for append-only risk comments.

    author is read-only and set from request.user in perform_create.
    message must be non-blank.
    No update or delete operations are exposed.
    """

    author = RiskCommentAuthorSerializer(read_only=True)

    def validate_message(self, value: str) -> str:
        if not value.strip():
            raise serializers.ValidationError("Message cannot be blank.")
        return value

    class Meta:
        model = RiskComment
        fields = ["id", "author", "message", "created_at"]
        read_only_fields = ["id", "author", "created_at"]


# ---------------------------------------------------------------------------
# Sprint serializers (ADR-0037)
# ---------------------------------------------------------------------------


class SprintSerializer(serializers.ModelSerializer[Sprint]):
    """Read/write serializer for sprints.

    State, committed_*, completed_*, activated_at, closed_at are read-only —
    they are written by the dedicated activate/close actions, not by PATCH.

    completion_ratio_* are computed from snapshotted committed/completed
    fields and only become non-null after sprint close.
    """

    short_id_display = serializers.SerializerMethodField()
    completion_ratio_points = serializers.SerializerMethodField()
    completion_ratio_tasks = serializers.SerializerMethodField()
    target_milestone_detail = serializers.SerializerMethodField()

    def get_short_id_display(self, obj: Sprint) -> str:
        """Return the human-facing form ``SP-XXXXXXXX`` of the short id."""
        return f"SP-{obj.short_id}" if obj.short_id else ""

    def get_completion_ratio_points(self, obj: Sprint) -> float | None:
        committed = obj.committed_points or 0
        if not committed:
            return None
        return round((obj.completed_points or 0) / committed, 4)

    def get_completion_ratio_tasks(self, obj: Sprint) -> float | None:
        committed = obj.committed_task_count or 0
        if not committed:
            return None
        return round((obj.completed_task_count or 0) / committed, 4)

    def get_target_milestone_detail(self, obj: Sprint) -> dict[str, Any] | None:
        """Inline the milestone task so the Sprints UI can render the
        "Advancing to milestone" card without a second round-trip.

        Returns ``None`` when no milestone is linked. The nested shape is
        read-only — writes still go through ``target_milestone`` (the FK id).
        """
        milestone = obj.target_milestone
        if milestone is None:
            return None
        wbs = milestone.wbs_path
        return {
            "id": str(milestone.pk),
            "name": milestone.name,
            "wbs_path": str(wbs) if wbs else None,
            "finish": milestone.early_finish.isoformat() if milestone.early_finish else None,
        }

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        start = attrs.get("start_date") or (self.instance.start_date if self.instance else None)
        finish = attrs.get("finish_date") or (self.instance.finish_date if self.instance else None)
        if start and finish and finish <= start:
            raise serializers.ValidationError(
                {"finish_date": "finish_date must be after start_date."}
            )
        # Only PLANNED sprints accept name/goal/date edits via PATCH.
        if self.instance and self.instance.state != SprintState.PLANNED:
            mutating = {k for k in attrs if k in {"name", "goal", "start_date", "finish_date"}}
            if mutating:
                raise serializers.ValidationError(
                    f"Sprint is {self.instance.state}; cannot modify {sorted(mutating)}."
                )
        return attrs

    class Meta:
        model = Sprint
        fields = [
            "id",
            "server_version",
            "short_id",
            "short_id_display",
            "project",
            "name",
            "goal",
            "start_date",
            "finish_date",
            "state",
            "target_milestone",
            "target_milestone_detail",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
            "completion_ratio_points",
            "completion_ratio_tasks",
            "activated_at",
            "closed_at",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "short_id",
            "short_id_display",
            "project",
            "state",
            "target_milestone_detail",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
            "completion_ratio_points",
            "completion_ratio_tasks",
            "activated_at",
            "closed_at",
            "created_by",
            "created_at",
            "updated_at",
        ]


class SprintBurnSnapshotSerializer(serializers.ModelSerializer[SprintBurnSnapshot]):
    """Read-only serializer for a single burn snapshot row."""

    class Meta:
        model = SprintBurnSnapshot
        fields = [
            "snapshot_date",
            "remaining_points",
            "remaining_task_count",
            "completed_points",
            "completed_task_count",
            "scope_change_points",
            "scope_change_task_count",
        ]
        read_only_fields = fields


class SprintBurndownSerializer(serializers.Serializer[dict[str, Any]]):
    """Composite payload for ``GET /api/sprints/{id}/burndown/``.

    Returns the sprint metadata and the list of actual burn snapshots. The
    ideal line is computed client-side from ``committed_points`` and the
    sprint date range — server returns only actual data points (ADR-0037 Q4).
    """

    sprint = SprintSerializer(read_only=True)
    snapshots = SprintBurnSnapshotSerializer(many=True, read_only=True)


class SprintCloseRequestSerializer(serializers.Serializer[dict[str, Any]]):
    """Validate the body for ``POST /api/sprints/{id}/close/``."""

    carry_over_to = serializers.CharField(default="backlog")

    def validate_carry_over_to(self, value: str) -> str:
        if value in {"backlog", "none"}:
            return value
        # Must be a UUID string referencing another sprint in the same project.
        try:
            uuid.UUID(value)
        except (TypeError, ValueError) as exc:
            raise serializers.ValidationError(
                "carry_over_to must be 'backlog', 'none', or a sprint UUID."
            ) from exc
        return value


class ProjectVelocitySerializer(serializers.Serializer[dict[str, Any]]):
    """Response shape for ``GET /api/projects/{id}/velocity/`` (ADR-0037 Q3)."""

    sprints = serializers.ListField(child=serializers.DictField())
    rolling_avg_points = serializers.FloatField(allow_null=True)
    rolling_stdev_points = serializers.FloatField(allow_null=True)
    forecast_range_low = serializers.IntegerField(allow_null=True)
    forecast_range_high = serializers.IntegerField(allow_null=True)
    rolling_avg_tasks = serializers.FloatField(allow_null=True)
    rolling_stdev_tasks = serializers.FloatField(allow_null=True)


# ---------------------------------------------------------------------------
# Sprint retrospective (issue #231)
# ---------------------------------------------------------------------------


class RetroActionItemSerializer(serializers.ModelSerializer[RetroActionItem]):
    """Read serializer for retro action items.

    Includes ``promoted_task_id`` so the frontend can render a `T-XXX`
    link back to the task created by promotion. The assignee FK is
    surfaced as the username (``assignee_username``) for display; writes
    use ``assignee_id``.
    """

    assignee_username = serializers.SerializerMethodField()

    def get_assignee_username(self, obj: RetroActionItem) -> str | None:
        return getattr(obj.assignee, "username", None) if obj.assignee else None

    class Meta:
        model = RetroActionItem
        fields = [
            "id",
            "text",
            "assignee",
            "assignee_username",
            "story_points",
            "promoted_task_id",
            "created_at",
        ]
        read_only_fields = ["id", "promoted_task_id", "created_at", "assignee_username"]


class SprintRetroSerializer(serializers.ModelSerializer[SprintRetro]):
    """Sprint retrospective + nested action items."""

    action_items = RetroActionItemSerializer(many=True, read_only=True)

    class Meta:
        model = SprintRetro
        fields = [
            "id",
            "sprint",
            "notes",
            "created_by",
            "created_at",
            "updated_at",
            "action_items",
        ]
        read_only_fields = [
            "id",
            "sprint",
            "created_by",
            "created_at",
            "updated_at",
            "action_items",
        ]
