"""DRF serializers for the projects app."""

from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Any

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework import serializers
from trueppm_scheduler import find_cycle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    _VALID_EVM_MODES,
    _VALID_SORT_KEYS,
    ApiTokenAuditEntry,
    Baseline,
    BaselineTask,
    BoardSavedView,
    Calendar,
    CalendarException,
    CommentAcknowledgement,
    CommentReaction,
    Dependency,
    EstimateStatus,
    EstimationMode,
    InboundTaskLink,
    Program,
    Project,
    ProjectApiToken,
    RetroActionItem,
    Risk,
    RiskComment,
    Sprint,
    SprintBurnSnapshot,
    SprintRetro,
    SprintState,
    Task,
    TaskAttachment,
    TaskComment,
    TaskStatus,
)
from trueppm_api.apps.resources.models import TaskResource

User = get_user_model()


class _UserSummarySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    """Compact user payload nested inside Program/Project responses.

    Kept module-private (leading underscore) by convention — mirrors the same
    pattern in ``access.serializers``. Add a public wrapper if a different
    field set is ever needed.
    """

    class Meta:
        model = User
        fields = ["id", "username", "email"]


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

    program is optional and writable on update (ADR-0070). Cross-permission
    check: assigning or moving requires the caller to hold ADMIN on the
    *new* program AND ADMIN on this project (and ADMIN on the *old* program
    when reassigning away from one). Enforced in ``validate_program``.
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
            "code",
            "health",
            "visibility",
            "timezone",
            "default_view",
            "estimation_mode",
            "agile_features",
            "methodology",
            "program",
        ]
        read_only_fields = ["id", "server_version"]

    def validate_code(self, value: str) -> str:
        """Project code format: uppercase A-Z, 0-9, and hyphen, ≤12 chars.

        Empty string is allowed (the field is optional and the UI shows a
        blank input for projects created before the field existed). When
        non-empty, the format is enforced server-side rather than client-side
        so MS Project / P6 importers and direct API callers cannot bypass it
        by skipping the General page. Hyphen-only or leading/trailing hyphens
        are rejected to avoid ambiguous task-ID prefixes (e.g. "-001").
        """
        if value == "":
            return value
        if len(value) > 12:
            raise serializers.ValidationError("Project code must be 12 characters or fewer.")
        if not re.fullmatch(r"[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?", value):
            raise serializers.ValidationError(
                "Project code must use uppercase letters, digits, and hyphens "
                "only, and may not start or end with a hyphen."
            )
        return value

    def validate_program(self, value: Program | None) -> Program | None:
        """Enforce ADR-0070 cross-permission gates on Project.program changes.

        Rules (let X = the program being added/moved-to, A = the program being
        moved-away-from, P = this project):
          - Set/replace: caller must be ADMIN on P AND ADMIN on X.
          - Unset (program → null): caller must be ADMIN on P AND ADMIN on A.
          - Move (program A → B): caller must be ADMIN on P AND ADMIN on A AND ADMIN on B.

        Why the project-side ADMIN: assigning a project to a program is
        program-shaping, which the project's owners should authorize. Why the
        program-side ADMIN: the program's owners must consent to absorbing the
        project. The combined gate prevents one side unilaterally rearranging
        the other's container.

        Returns ``value`` unchanged on success; raises 400 with an actionable
        message on any failure. On create flows (``instance is None``) the
        project-side and old-program checks are skipped — only the new-program
        ADMIN gate applies, so a caller assigning ``program`` at creation must
        already be ADMIN on the target program.
        """
        from trueppm_api.apps.access.permissions import _membership_role, _program_membership_role

        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return value

        instance: Project | None = self.instance
        old_program = instance.program if instance is not None else None
        new_program = value

        # No change — nothing to enforce.
        if (old_program is None and new_program is None) or (
            old_program is not None and new_program is not None and old_program.pk == new_program.pk
        ):
            return value

        # Project-side ADMIN required for any change.
        if instance is not None:
            project_role = _membership_role(request, instance.pk)
            if project_role is None or project_role < Role.ADMIN:
                raise serializers.ValidationError(
                    "You need at least Project Manager role on this project to change its program."
                )

        # Old program ADMIN required when leaving or moving away.
        if old_program is not None:
            old_role = _program_membership_role(request, old_program.pk)
            if old_role is None or old_role < Role.ADMIN:
                raise serializers.ValidationError(
                    f"You need at least Project Manager role on '{old_program.name}' "
                    "to move this project out of it."
                )

        # New program ADMIN required when assigning to or moving to a program.
        if new_program is not None:
            new_role = _program_membership_role(request, new_program.pk)
            if new_role is None or new_role < Role.ADMIN:
                raise serializers.ValidationError(
                    f"You need at least Project Manager role on '{new_program.name}' "
                    "to add this project to it."
                )

        return value


class ProgramSerializer(serializers.ModelSerializer[Program]):
    """Read/write serializer for Program (ADR-0070).

    ``my_role`` is the requesting user's role on this program — provided here
    so the list endpoint does not require a second per-program call to render
    the role chip. ``project_count`` and ``member_count`` are computed in the
    viewset queryset via annotate() to avoid N+1.
    """

    my_role = serializers.SerializerMethodField()
    my_role_label = serializers.SerializerMethodField()
    project_count = serializers.IntegerField(read_only=True, default=0)
    member_count = serializers.IntegerField(read_only=True, default=0)
    # Read-only nested user payload so the General settings page can render
    # the lead's name + initials without a second per-program user fetch.
    # Null when ``lead`` is unset. The write side stays on the plain ``lead``
    # UUID field — ``lead_detail`` is response-only.
    lead_detail = _UserSummarySerializer(source="lead", read_only=True)

    class Meta:
        model = Program
        fields = [
            "id",
            "server_version",
            "name",
            "description",
            "code",
            "methodology",
            "health",
            "visibility",
            "lead",
            "lead_detail",
            "created_by",
            "created_at",
            "updated_at",
            "my_role",
            "my_role_label",
            "project_count",
            "member_count",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "lead_detail",
            "created_by",
            "created_at",
            "updated_at",
            "my_role",
            "my_role_label",
            "project_count",
            "member_count",
        ]

    def get_my_role(self, obj: Program) -> int | None:
        # The viewset attaches ``_my_role`` to each instance (annotated on the
        # queryset). Falls back to None if absent (e.g. when serializing a
        # freshly-created instance before re-fetch — but the viewset re-fetches
        # via the queryset in those paths, so this branch is defensive only).
        return getattr(obj, "_my_role", None)

    def validate_lead(self, value: Any) -> Any:
        """Lead must hold an active ProgramMembership on this program.

        On create the program does not yet exist, so we skip the check — the
        atomic OWNER membership row created by ``access.services.create_program``
        is added in the same transaction as the Program itself, and the
        ``ProgramViewSet.create`` path does not currently forward the ``lead``
        field through that service (only name/description/methodology). When
        the create path grows lead support, the OWNER row will exist before
        this validator runs because membership creation precedes Program save.

        On partial_update the instance is set and we enforce the membership.
        Unsetting (lead=None) is always permitted.
        """
        if value is None:
            return value
        instance = getattr(self, "instance", None)
        if instance is None:
            return value
        # Lazy import avoids a circular dep — access imports from projects.
        from trueppm_api.apps.access.models import ProgramMembership

        has_membership = ProgramMembership.objects.filter(
            program=instance,
            user=value,
            is_deleted=False,
        ).exists()
        if not has_membership:
            raise serializers.ValidationError(
                "The selected user must be a member of this program before they "
                "can be assigned as lead."
            )
        return value

    def get_my_role_label(self, obj: Program) -> str | None:
        role = getattr(obj, "_my_role", None)
        if role is None:
            return None
        return Role(role).label


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

    # Sprint scope-change audit rows (ADR-0060).  Populated via prefetch_related
    # in TaskViewSet.get_queryset(); defaults to empty list when called outside
    # the viewset so the field is always safe to read.
    sprint_scope_changes = serializers.SerializerMethodField()

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

    # TODO(#73): cpi, actual_cost, and budget_at_completion are intentionally
    # absent from this serializer until the cost model (#73, #74) is
    # implemented.  BoardCard.tsx renders CPI and cost chips that no-op
    # gracefully when these fields are absent.  See ADR-0035 § Q5.

    # Wave 3 (#210) — passive overalloc indicator in the task detail drawer.
    # True when the assignee's TaskResource.units across active tasks in this
    # project sum to > 1.0.  Annotated by TaskViewSet.get_queryset(); defaults
    # to False so the drawer never shows a stale warning when called outside the
    # viewset (e.g. in tests or nested serializers).
    assignee_is_overallocated = serializers.BooleanField(read_only=True, default=False)

    # Sprint → milestone rollup payload (ADR-0074). Populated only on milestone
    # tasks with at least one live targeting sprint; ``None`` otherwise. The
    # web Gantt and the sprint AdvancingToMilestoneCard both consume this as
    # the single source of truth for milestone progress + variance.
    milestone_rollup = serializers.SerializerMethodField()

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
            "remaining_points",
            "is_subtask",
            "sprint_scope_changes",
            "milestone_rollup",
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
            "sprint_scope_changes",
            "milestone_rollup",
        ]

    def _get_caller_role(self, project: Project | None) -> int | None:
        """Resolve the caller's project role, checking context before hitting the DB.

        Bulk operations pass ``caller_role`` in serializer context to avoid one
        ``ProjectMembership`` query per task. Single-object views fall back to a
        fresh query via the request user.
        """
        if "caller_role" in self.context:
            return int(self.context["caller_role"])
        request = self.context.get("request")
        user = getattr(request, "user", None) if request else None
        if user is None or not getattr(user, "is_authenticated", False) or project is None:
            return None
        return (
            ProjectMembership.objects.filter(project=project, user=user)
            .values_list("role", flat=True)
            .first()
        )

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        """Enforce the milestone invariant and progress-anchor gate.

        Milestone invariant: is_milestone=True implies duration=0. Milestones
        are single-point gates (permits, inspections, sprint reviews, contract
        dates). A milestone with a non-zero duration produces a Gantt row whose
        Start and Finish render different dates, which contradicts the diamond
        marker and the "—" duration display. This invariant is enforced here so
        the contradiction can never reach the database from the API.

        On partial updates the resulting state is computed from instance + attrs
        so toggling is_milestone=True without sending duration still zeroes it,
        and editing duration on an existing milestone gets clamped back to zero.

        Sprint cross-project ownership: the sprint assigned to a task must
        belong to the same project as the task. Validated at the serializer
        level because the Sprint FK queryset is intentionally not project-scoped
        at the field level (the viewset scopes access via project membership).

        Progress-anchor gate (ADR-0057 Q5): percent_complete > 0 requires
        either planned_start or a sprint assignment. ADMIN+ users are exempt
        so project managers can correct imported or manually-entered data.
        """
        is_milestone = attrs.get("is_milestone")
        if is_milestone is None and self.instance is not None:
            is_milestone = self.instance.is_milestone
        if is_milestone:
            attrs["duration"] = 0

        # Sprint cross-project ownership check.
        sprint = attrs.get("sprint")
        if "sprint" in attrs and sprint is not None:
            task_project_id = (
                self.instance.project_id
                if self.instance is not None
                else getattr(attrs.get("project"), "pk", None)
            )
            if task_project_id is not None and str(sprint.project_id) != str(task_project_id):
                raise serializers.ValidationError(
                    {"sprint": "Sprint does not belong to this project."}
                )

        # Progress-anchor gate: block percent_complete > 0 when the task has no
        # planned_start and no sprint. For partial updates, merge instance state
        # with the incoming attrs to determine the resulting effective values.
        new_pc = attrs.get("percent_complete")
        if new_pc is not None and new_pc > 0:
            eff_planned_start = attrs.get(
                "planned_start",
                self.instance.planned_start if self.instance is not None else None,
            )
            eff_sprint = (
                attrs.get("sprint")
                if "sprint" in attrs
                else (self.instance.sprint if self.instance is not None else None)
            )
            if eff_planned_start is None and eff_sprint is None:
                project = (
                    self.instance.project if self.instance is not None else attrs.get("project")
                )
                role = self._get_caller_role(project)
                if role is None or role < Role.ADMIN:
                    raise ProgressAnchorError()

        # Milestone-rollup lock (ADR-0074): a milestone task with live targeting
        # sprints has its percent_complete computed from sprint state — manual
        # writes would silently revert on the next rollup recompute, so reject
        # them at validate time with a structured error code the frontend can
        # map to its lock affordance. Carries no role exemption: even admins
        # close or unlink the sprint to override (audit-by-design).
        if "percent_complete" in attrs and self.instance is not None and self.instance.is_milestone:
            from trueppm_api.apps.projects.models import Sprint

            has_live_targeting_sprint = Sprint.objects.filter(
                target_milestone_id=self.instance.pk, is_deleted=False
            ).exists()
            if has_live_targeting_sprint:
                raise MilestoneRollupLockedError()

        return attrs

    def get_schedule_variance_days(self, obj: Task) -> int | None:
        """Compute schedule variance: actual_finish - baseline_finish in calendar days.

        Uses the active-baseline snapshot date, not early_finish (CPM). early_finish
        drifts toward actual_finish on each CPM recompute, making the variance appear
        to shrink even when work is running late. Without an active baseline the
        metric is undefined — returns None rather than a misleading CPM-relative value.
        """
        actual = obj.actual_finish
        baseline: date | None = getattr(obj, "baseline_finish", None)
        if actual and baseline:
            return (actual - baseline).days
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

    def get_sprint_scope_changes(self, obj: Task) -> list[dict[str, Any]]:
        """Return scope-change audit rows for the sprint-scope indicator chip."""
        rows = getattr(obj, "_prefetched_sprint_scope_changes", None)
        if rows is None:
            # Fallback for callers that bypass the viewset (e.g. tests).
            from trueppm_api.apps.projects.models import SprintScopeChange

            rows = SprintScopeChange.objects.filter(task_id=obj.pk).select_related("added_by")
        return [
            {
                "subtask_name": r.subtask_name,
                "added_by_name": r.added_by.get_full_name() if r.added_by else None,
                "added_at": r.added_at.isoformat(),
            }
            for r in rows
        ]

    def get_milestone_rollup(self, obj: Task) -> dict[str, Any] | None:
        """Sprint-driven rollup payload for milestone tasks (ADR-0074).

        Returns ``None`` for non-milestone tasks and for milestones with no
        live targeting sprints — both cases let the manual ``percent_complete``
        apply unchanged. Aggregated only — never includes per-assignee task
        lists or raw point counts (Morgan VoC guardrail, ADR-0074 §Broadcast
        payload shape).
        """
        if not obj.is_milestone:
            return None
        from trueppm_api.apps.projects.services import compute_milestone_rollup_payload

        return compute_milestone_rollup_payload(obj)

    def to_representation(self, instance: Task) -> dict[str, Any]:
        """Override percent_complete for summary tasks with duration-weighted child average.

        Uses the percent_complete_rollup annotation from TaskViewSet.get_queryset()
        to avoid one raw SQL query per summary task on list responses.

        Also overrides ``percent_complete`` on milestone tasks with their
        sprint-driven rollup value (ADR-0074) so the Gantt and the sprint card
        agree on a single number. Falls back to the stored field when the
        rollup is unavailable (basis="none" or no targeting sprints).
        """
        data = super().to_representation(instance)
        rollup = getattr(instance, "percent_complete_rollup", None)
        if rollup is not None:
            data["percent_complete"] = round(float(rollup), 2)
        # Milestone rollup wins over the stored value when available, so the
        # number the user edits via the sprint flows back as the number they
        # see in every surface.
        ms_rollup = data.get("milestone_rollup")
        if ms_rollup and ms_rollup.get("percent_complete") is not None:
            data["percent_complete"] = ms_rollup["percent_complete"]
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

        # Progress 0 → >0 auto-promote: NOT_STARTED → IN_PROGRESS (#362).
        # Only fires for MEMBER+ so Viewers (who cannot write tasks in practice
        # but may arrive via sync paths) do not trigger silent state transitions.
        # Skipped when percent_complete goes straight to 100 — the percent=100
        # block below handles that path (REVIEW or COMPLETE, role-gated).
        new_pc = validated_data.get("percent_complete")
        if (
            new_pc is not None
            and 0 < new_pc < 100
            and instance.percent_complete == 0
            and "status" not in validated_data
            and instance.status == TaskStatus.NOT_STARTED
        ):
            role = self._get_caller_role(instance.project)
            if role is not None and role >= Role.MEMBER:
                validated_data["status"] = TaskStatus.IN_PROGRESS
                if "actual_start" not in validated_data and not instance.actual_start:
                    validated_data["actual_start"] = timezone.localdate()

        # Option E auto-status on percent_complete=100 (#381 follow-up, VoC
        # 2026-05-08).  Contributors (role < ADMIN) drop work into REVIEW so a
        # PM/PMO sign-off step is preserved; PMs and above flip straight to
        # COMPLETE.  The Review *column* is the governance gate — there is no
        # separate "review pending" tag (Priya hard-NO'd that as distrust
        # theater).  Skipped when status is explicitly set in the same
        # payload, when the card is already past sign-off (REVIEW/COMPLETE),
        # or when the card is still BACKLOG (an idea jumping straight to
        # done is an edge case that requires a manual promotion).
        if (
            validated_data.get("percent_complete") == 100
            and "status" not in validated_data
            and instance.status not in (TaskStatus.COMPLETE, TaskStatus.REVIEW, TaskStatus.BACKLOG)
        ):
            role = self._get_caller_role(instance.project)
            if role is not None and role >= Role.ADMIN:
                validated_data["status"] = TaskStatus.COMPLETE
            else:
                validated_data["status"] = TaskStatus.REVIEW

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

            elif new_status == TaskStatus.REVIEW:
                # REVIEW means "work is done, awaiting sign-off."  Set
                # actual_start if missing so capacity reporting reflects when
                # the work was actually performed; do NOT set actual_finish —
                # that's reserved for the COMPLETE transition that follows.
                if "actual_start" not in validated_data and not instance.actual_start:
                    validated_data["actual_start"] = today

            elif new_status == TaskStatus.COMPLETE:
                if "actual_finish" not in validated_data:
                    validated_data["actual_finish"] = today
                if "actual_start" not in validated_data and not instance.actual_start:
                    validated_data["actual_start"] = today
                # Zero out remaining effort when work is done.
                if "remaining_points" not in validated_data:
                    validated_data["remaining_points"] = 0

        # Reopening from COMPLETE restores remaining_points from the commitment baseline.
        if (
            new_status
            and new_status != TaskStatus.COMPLETE
            and old_status == TaskStatus.COMPLETE
            and "remaining_points" not in validated_data
        ):
            validated_data["remaining_points"] = instance.story_points

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


class CycleDetectedError(Exception):
    """Internal signal raised by ``DependencySerializer.validate`` when a proposed
    edge would close a cycle on the expanded leaf graph.

    Caught by ``DependencyViewSet.create`` / ``update`` and converted to a
    structured ``400 {"detail": "cyclic_dependency", "cycle": [...]}`` response.
    Bypasses DRF's :class:`serializers.ValidationError` because that class wraps
    string fields in ``ErrorDetail`` lists, which mangles the shape the
    frontend expects (see ADR-0055).
    """

    def __init__(self, cycle: list[dict[str, str]]) -> None:
        self.cycle = cycle
        super().__init__("Cyclic dependency detected.")


class ProgressAnchorError(Exception):
    """Raised by ``TaskSerializer.validate`` when ``percent_complete > 0`` lacks
    a schedule anchor.

    A task must have either a ``planned_start`` date or a sprint assignment before
    progress can be recorded. Enforces the "no ghost progress" invariant — a task
    cannot have meaningful completion without being scheduled (ADR-0057 Q5).

    ADMIN+ users are exempt so project managers can correct imported data.

    Bypasses DRF's :class:`serializers.ValidationError` for the same reason as
    :class:`CycleDetectedError` — the frontend expects a structured
    ``{"code": ..., "detail": ..., "suggested_action": ...}`` response body
    without ``ErrorDetail`` wrapping (ADR-0055).
    """

    pass


class MilestoneRollupLockedError(Exception):
    """Raised by ``TaskSerializer.validate`` when ``percent_complete`` is written
    on a milestone task that has one or more live targeting sprints.

    A milestone whose progress rolls up from linked sprint(s) cannot be
    edited manually — the rolled-up value is the source of truth. PMs who
    need to override unlink or close the sprint first; subsequent edits
    unlock automatically (ADR-0074).

    Bypasses DRF's :class:`serializers.ValidationError` so the frontend
    receives a stable error code (``milestone_rollup_locked``) the UI can
    map to its lock affordance and toast copy without scraping a message.
    """

    pass


def _load_project_tasks_and_children_map(
    project_id: Any,
) -> tuple[list[str], dict[str, list[str]]]:
    """Load task IDs and the WBS children-map for a project in one query.

    Returns ``(task_ids, children_map)`` where ``task_ids`` is every non-deleted
    task in the project (string UUIDs) and ``children_map`` is the
    ``{parent_task_id: [child_id, ...]}`` mapping derived from ``wbs_path``.
    Combined into one helper because every cycle-check call needs both, and we
    want a single bulk query rather than two scans of the task table.
    """
    rows = list(
        Task.objects.filter(project_id=project_id, is_deleted=False).values("id", "wbs_path")
    )
    task_ids: list[str] = [str(r["id"]) for r in rows]
    path_to_id: dict[str, str] = {}
    for r in rows:
        wbs = r["wbs_path"]
        if wbs:
            path_to_id[str(wbs)] = str(r["id"])
    children_map: dict[str, list[str]] = {}
    for r in rows:
        wbs = r["wbs_path"]
        if not wbs:
            continue
        parent_path, _, _ = str(wbs).rpartition(".")
        if not parent_path:
            continue
        parent_id = path_to_id.get(parent_path)
        if parent_id:
            children_map.setdefault(parent_id, []).append(str(r["id"]))
    return task_ids, children_map


class DependencySerializer(serializers.ModelSerializer[Dependency]):
    """Read/write serializer for task dependencies (FS/SS/FF/SF links with optional lag).

    Cross-project edges are rejected in validate() because the CPM engine
    assumes a single-project DAG. Edges that would close a cycle on the
    expanded leaf graph are also rejected at create/update time with a
    structured 400 ``{"detail": "cyclic_dependency", "cycle": [...]}`` so the
    frontend can surface the offending path to the user; see ADR-0055.
    """

    # Explicit querysets exclude soft-deleted tasks so a caller cannot anchor
    # a new live edge to a tombstoned row — which would corrupt the CPM graph
    # and produce sync conflicts on the orphaned FK.
    predecessor = serializers.PrimaryKeyRelatedField(
        queryset=Task.objects.filter(is_deleted=False),
    )
    successor = serializers.PrimaryKeyRelatedField(
        queryset=Task.objects.filter(is_deleted=False),
    )

    class Meta:
        model = Dependency
        fields = ["id", "predecessor", "successor", "dep_type", "lag"]
        read_only_fields = ["id"]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        predecessor = attrs.get("predecessor") or (
            self.instance.predecessor if self.instance else None
        )
        successor = attrs.get("successor") or (self.instance.successor if self.instance else None)

        # Membership check runs first — before the same-project check — so that
        # a non-member submitting any foreign task UUID always gets 403 regardless
        # of whether the two UUIDs happen to share a project. Running same-project
        # first would let callers distinguish the two cases and infer shared
        # project membership from the error code (ADR-0055 / #359 hardening).
        request = self.context.get("request")
        view = self.context.get("view")
        if request is not None and view is not None:
            if predecessor:
                view.check_object_permissions(request, predecessor)
            if successor:
                view.check_object_permissions(request, successor)

        # Enforce same-project constraint: the CPM engine assumes a single-project
        # DAG. Cross-project edges produce undefined scheduling behaviour.
        if predecessor and successor and predecessor.project_id != successor.project_id:
            raise serializers.ValidationError(
                "Predecessor and successor must belong to the same project."
            )

        if predecessor and successor:
            self._check_no_cycle(predecessor, successor)
        return attrs

    def _check_no_cycle(self, predecessor: Task, successor: Task) -> None:
        """Reject the proposed edge if it would close a logical cycle.

        Builds the project's existing dep graph (excluding the current row on
        update), appends the proposed edge, expands summary→leaf edges, and
        runs cycle detection. On a hit, raises a structured ValidationError
        with the cycle path resolved to ``{id, name, hex_id}`` objects so the
        client can render task names without an extra round trip.
        """
        # Self-loop short-circuits the full graph check — networkx would catch
        # it but doing it here saves a DB roundtrip for the common typo case.
        if predecessor.id == successor.id:
            self._raise_cycle_error([predecessor, predecessor])
            return

        project_id = predecessor.project_id

        # Single bulk pull of the project's tasks gives us both the children_map
        # for summary expansion AND the FK list to scope the dependency edge
        # query. Querying `Dependency.objects.filter(predecessor__project_id=...)`
        # would force a JOIN through the FK and cost more on cold cache; using
        # `predecessor_id__in=task_ids` hits the FK index directly. Perf review
        # for #356.
        task_ids, children_map = _load_project_tasks_and_children_map(project_id)

        existing_qs = Dependency.objects.filter(
            is_deleted=False,
            predecessor_id__in=task_ids,
        ).values_list("predecessor_id", "successor_id")
        if self.instance is not None:
            existing_qs = existing_qs.exclude(pk=self.instance.pk)

        edges: list[tuple[str, str]] = [(str(p), str(s)) for p, s in existing_qs]
        edges.append((str(predecessor.id), str(successor.id)))

        cycle_ids = find_cycle(edges, children_map=children_map)
        if cycle_ids is None:
            return

        # Resolve to rich objects so the toast can render task names without
        # racing the frontend's task cache (a freshly created task may not be
        # there yet); see ADR-0055 §7.
        unique_ids = set(cycle_ids)
        tasks_by_id = {
            str(t.id): t
            for t in Task.objects.filter(project_id=project_id, id__in=unique_ids).only(
                "id", "name", "short_id"
            )
        }
        ordered_tasks = [tasks_by_id.get(tid) for tid in cycle_ids]
        # If any id failed to resolve (deleted concurrently?), fall back to a
        # stub so the response shape stays consistent.
        ordered: list[Task | None] = ordered_tasks
        self._raise_cycle_error(ordered, fallback_ids=cycle_ids)

    def _raise_cycle_error(
        self,
        tasks: list[Task] | list[Task | None],
        fallback_ids: list[str] | None = None,
    ) -> None:
        ids = fallback_ids or [str(t.id) if t is not None else "" for t in tasks]
        cycle_payload = [
            {
                "id": str(t.id) if t is not None else (ids[i] if i < len(ids) else ""),
                "name": t.name if t is not None else "",
                "hex_id": t.short_id if t is not None else "",
            }
            for i, t in enumerate(tasks)
        ]
        raise CycleDetectedError(cycle_payload)


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
            "notes",
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

        Includes ``rollup`` (ADR-0074): the same payload that appears on
        ``TaskSerializer.milestone_rollup`` so the AdvancingToMilestoneCard
        and the Gantt show one number, not two.
        """
        milestone = obj.target_milestone
        if milestone is None:
            return None
        from trueppm_api.apps.projects.services import compute_milestone_rollup_payload

        wbs = milestone.wbs_path
        return {
            "id": str(milestone.pk),
            "name": milestone.name,
            "wbs_path": str(wbs) if wbs else None,
            "finish": milestone.early_finish.isoformat() if milestone.early_finish else None,
            "rollup": compute_milestone_rollup_payload(milestone),
        }

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        start = attrs.get("start_date") or (self.instance.start_date if self.instance else None)
        finish = attrs.get("finish_date") or (self.instance.finish_date if self.instance else None)
        if start and finish and finish <= start:
            raise serializers.ValidationError(
                {"finish_date": "finish_date must be after start_date."}
            )
        # Only PLANNED sprints accept name/goal/date edits via PATCH.
        # capacity_points is intentionally excluded (ADR-0073) — a PM/SM
        # may revise the team's points ceiling mid-sprint as the team
        # changes (PTO, joiners). It is locked only once the sprint is
        # closed or cancelled.
        if self.instance and self.instance.state != SprintState.PLANNED:
            mutating = {k for k in attrs if k in {"name", "goal", "start_date", "finish_date"}}
            if mutating:
                raise serializers.ValidationError(
                    f"Sprint is {self.instance.state}; cannot modify {sorted(mutating)}."
                )
        if (
            self.instance
            and self.instance.state in {SprintState.COMPLETED, SprintState.CANCELLED}
            and "capacity_points" in attrs
        ):
            raise serializers.ValidationError(
                {
                    "capacity_points": (
                        f"Sprint is {self.instance.state}; capacity_points is locked."
                    )
                }
            )
        # capacity_points is the team's planning target, owned by the Scrum
        # Master / lead — not a per-contributor field (ADR-0073 sovereignty
        # rule). Field-level RBAC: SCHEDULER+ writes only. The viewset's
        # IsProjectMemberWrite gate still applies to every other field; this
        # check is layered on top for capacity_points specifically.
        if "capacity_points" in attrs and self.instance is not None:
            from trueppm_api.apps.access.models import ProjectMembership, Role

            request = self.context.get("request")
            user = getattr(request, "user", None) if request else None
            if user is None or not getattr(user, "is_authenticated", False):
                raise serializers.ValidationError({"capacity_points": "Authentication required."})
            membership = ProjectMembership.objects.filter(
                project_id=self.instance.project_id,
                user=user,
            ).first()
            if membership is None or membership.role < Role.SCHEDULER:
                raise serializers.ValidationError(
                    {"capacity_points": ("Only Scheduler+ may set sprint capacity.")}
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
            "notes",
            "start_date",
            "finish_date",
            "state",
            "target_milestone",
            "target_milestone_detail",
            "capacity_points",
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
    # ADR-0065: rolling team_velocity_per_day used by CPM velocity feedback.
    # Null until enough closed sprints exist (see MIN_CLOSED_SPRINTS_FOR_SUGGESTION).
    team_velocity_per_day = serializers.FloatField(allow_null=True)


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
    """Sprint retrospective + nested action items — full content (ADR-0071).

    Returned to MEMBER+ on the project's team when team_visibility=TEAM_ONLY,
    or to VIEWER+ when team_visibility=PROJECT. Below the visibility
    threshold, use ``SprintRetroSummarySerializer`` instead.
    """

    action_items = RetroActionItemSerializer(many=True, read_only=True)
    kind = serializers.SerializerMethodField()

    def get_kind(self, obj: SprintRetro) -> str:
        return "full"

    class Meta:
        model = SprintRetro
        fields = [
            "id",
            "sprint",
            "notes",
            "team_visibility",
            "created_by",
            "created_at",
            "updated_at",
            "action_items",
            "kind",
        ]
        read_only_fields = [
            "id",
            "sprint",
            "created_by",
            "created_at",
            "updated_at",
            "action_items",
            "kind",
        ]


class SprintRetroSummarySerializer(serializers.ModelSerializer[SprintRetro]):
    """Counts-only retro view for callers below the visibility threshold.

    Surfaces ``action_items_count`` and ``promoted_count`` so the UI can
    render a "team only" summary card with shape but never the raw text.
    Enterprise rollups read this serializer (ADR-0071 §6).
    """

    action_items_count = serializers.SerializerMethodField()
    promoted_count = serializers.SerializerMethodField()
    kind = serializers.SerializerMethodField()

    def get_kind(self, obj: SprintRetro) -> str:
        return "summary"

    def get_action_items_count(self, obj: SprintRetro) -> int:
        return obj.action_items.filter(is_deleted=False).count()

    def get_promoted_count(self, obj: SprintRetro) -> int:
        return obj.action_items.filter(
            is_deleted=False,
            promoted_task_id__isnull=False,
        ).count()

    class Meta:
        model = SprintRetro
        fields = [
            "id",
            "sprint",
            "team_visibility",
            "created_at",
            "updated_at",
            "action_items_count",
            "promoted_count",
            "kind",
        ]
        read_only_fields = fields


class RetroCarryoverItemSerializer(serializers.Serializer[Any]):
    """A single carryover row for the Sprint Planning "From last retro" lane.

    Built from a RetroActionItem + its source SprintRetro + Sprint short_id.
    Used by ``GET /projects/{pk}/retrospective/carryover/``.
    """

    action_item_id = serializers.UUIDField()
    text = serializers.CharField()
    from_retro_id = serializers.UUIDField()
    from_sprint_short_id = serializers.CharField(allow_null=True)
    from_sprint_id = serializers.UUIDField()
    promoted_task_id = serializers.UUIDField(allow_null=True)
    promoted_task_status = serializers.CharField(allow_null=True)
    promoted_task_short_id = serializers.CharField(allow_null=True)
    age_days = serializers.IntegerField()
    assignee_id = serializers.IntegerField(allow_null=True)
    assignee_username = serializers.CharField(allow_null=True)
    story_points = serializers.IntegerField(allow_null=True)


class TaskSuggestedAssigneeSerializer(serializers.Serializer[Any]):
    """Read serializer for TaskSuggestedAssignee (ADR-0071 §5).

    Exposed on the My Work surface and on the task detail. Mutations go
    through dedicated accept/decline/revoke endpoints, not this serializer.
    """

    id = serializers.UUIDField(read_only=True)
    task_id = serializers.UUIDField(read_only=True)
    suggested_user_id = serializers.IntegerField(read_only=True)
    suggested_user_username = serializers.SerializerMethodField()
    suggested_by_id = serializers.IntegerField(read_only=True, allow_null=True)
    suggested_by_username = serializers.SerializerMethodField()
    reason = serializers.CharField(read_only=True)
    # ``source`` shadows DRF Field.source at the class level — typed as a
    # CharField at runtime, suppressed for mypy strict.
    source: serializers.CharField = serializers.CharField(read_only=True)  # type: ignore[assignment]
    state = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)
    accepted_at = serializers.DateTimeField(read_only=True, allow_null=True)
    declined_at = serializers.DateTimeField(read_only=True, allow_null=True)

    def get_suggested_user_username(self, obj: Any) -> str | None:
        return getattr(obj.suggested_user, "username", None) if obj.suggested_user_id else None

    def get_suggested_by_username(self, obj: Any) -> str | None:
        return getattr(obj.suggested_by, "username", None) if obj.suggested_by_id else None


# ---------------------------------------------------------------------------
# My Work contributor surface (ADR-0065 Gap 2, issue #499)
# ---------------------------------------------------------------------------


class MeWorkTaskSerializer(serializers.Serializer[Any]):
    """Flat, contributor-facing task row for ``GET /me/work/``.

    Deliberately omits every CPM field (``early_start``, ``late_finish``,
    ``total_float``, ``wbs_path``, ``phase_id``) so the response carries no
    project-management vocabulary into a contributor's surface. ``is_critical``
    is the one CPM-derived signal exposed — but as a single boolean the UI
    renders as an icon with a plain-English tooltip ("delays here delay the
    project end date"), not as the words "critical path".

    ``due`` follows the ADR-0065 cascade:
        actual_finish → planned_start → early_finish → sprint.finish_date.
    ``due_source`` labels which step of the cascade produced the date so the
    UI can render "Due May 30 (planned)" vs "Ends with Sprint 12" — pure dates
    without their provenance erode contributor trust within a sprint.
    """

    id = serializers.UUIDField(read_only=True)
    short_id = serializers.CharField(read_only=True)
    name = serializers.CharField(read_only=True)
    project_id = serializers.UUIDField(read_only=True)
    project_name = serializers.SerializerMethodField()
    sprint_id = serializers.UUIDField(read_only=True, allow_null=True)
    sprint_name = serializers.SerializerMethodField()
    status = serializers.CharField(read_only=True)
    story_points = serializers.IntegerField(read_only=True, allow_null=True)
    remaining_points = serializers.IntegerField(read_only=True, allow_null=True)
    due = serializers.SerializerMethodField()
    due_source = serializers.SerializerMethodField()
    is_critical = serializers.SerializerMethodField()
    server_version = serializers.IntegerField(read_only=True)
    url = serializers.SerializerMethodField()

    def get_project_name(self, obj: Any) -> str:
        return str(obj.project.name)

    def get_sprint_name(self, obj: Any) -> str | None:
        return obj.sprint.name if obj.sprint_id else None

    def get_due(self, obj: Any) -> str | None:
        d, _ = _resolve_due(obj)
        return d.isoformat() if d else None

    def get_due_source(self, obj: Any) -> str | None:
        _, source = _resolve_due(obj)
        return source

    def get_is_critical(self, obj: Any) -> bool:
        # Task.is_critical is nullable (computed by CPM; not all projects run
        # the engine). Coerce to false so the UI never has to handle null.
        return bool(obj.is_critical)

    def get_url(self, obj: Any) -> str:
        return f"/projects/{obj.project_id}/schedule?task={obj.id}"


def _resolve_due(task: Any) -> tuple[date | None, str | None]:
    """Return (date, source) where source is the cascade step that produced it.

    Cascade order matches ADR-0065:
        actual_finish → planned_start → early_finish → sprint.finish_date.

    Returns (None, None) if no candidate is present — surfaced as null in
    both fields so the UI knows there is no due date rather than guessing.
    """
    if getattr(task, "actual_finish", None) is not None:
        return task.actual_finish, "actual"
    if getattr(task, "planned_start", None) is not None:
        return task.planned_start, "planned"
    if getattr(task, "early_finish", None) is not None:
        return task.early_finish, "estimated"
    sprint = getattr(task, "sprint", None)
    if sprint is not None and getattr(sprint, "finish_date", None) is not None:
        return sprint.finish_date, "sprint"
    return None, None


class MeWorkActiveSprintSerializer(serializers.Serializer[Any]):
    """Minimal active-sprint card for the My Work group header.

    Inlined into the ``/me/work/`` response so the page mount needs one
    round trip on mobile. Burndown, velocity, and capacity ratios live on
    the richer ``/me/active-sprints/`` endpoint — this view only carries
    what the section header needs (name, project, days remaining, count).
    """

    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)
    project_id = serializers.UUIDField(read_only=True)
    project_name = serializers.SerializerMethodField()
    finish_date = serializers.DateField(read_only=True)
    days_remaining = serializers.SerializerMethodField()
    task_count = serializers.IntegerField(read_only=True)

    def get_project_name(self, obj: Any) -> str:
        return str(obj.project.name)

    def get_days_remaining(self, obj: Any) -> int:
        today = timezone.localdate()
        return max(0, int((obj.finish_date - today).days))


# ---------------------------------------------------------------------------
# Inbound task-sync — ADR-0068 / issue #500
# ---------------------------------------------------------------------------


class ProjectDetailSerializer(ProjectSerializer):
    """Project detail response with inbound-sync triage fields.

    Adds ``unresolved_assignee_count`` so PMs have a single-number signal that
    inbound pushes are landing in the pending-assignee queue (Sarah's VoC 🟡).
    Backed by the partial index ``inbound_link_pending_idx`` — O(log n) per
    project regardless of total inbound-link count.

    List responses keep the base ``ProjectSerializer`` (no count) so the
    project list stays cheap.
    """

    unresolved_assignee_count = serializers.SerializerMethodField()

    class Meta(ProjectSerializer.Meta):
        fields = [*ProjectSerializer.Meta.fields, "unresolved_assignee_count"]

    def get_unresolved_assignee_count(self, obj: Project) -> int:
        return InboundTaskLink.objects.filter(
            project=obj,
            is_deleted=False,
            pending_assignee_email__isnull=False,
        ).count()


class ProjectApiTokenSerializer(serializers.ModelSerializer[ProjectApiToken]):
    """Read-only serializer for the list/detail token views.

    ``token_hash`` and the raw token are never exposed.  Clients see
    ``token_prefix`` only — enough to identify which token is which without
    revealing the secret.
    """

    is_revoked = serializers.SerializerMethodField()

    class Meta:
        model = ProjectApiToken
        fields = [
            "id",
            "name",
            "token_prefix",
            "status_map",
            "created_by",
            "created_at",
            "last_used_at",
            "revoked_at",
            "is_revoked",
        ]
        read_only_fields = fields

    def get_is_revoked(self, obj: ProjectApiToken) -> bool:
        return obj.revoked_at is not None


class ProjectApiTokenCreateSerializer(serializers.ModelSerializer[ProjectApiToken]):
    """Write serializer for minting a new token.

    Accepts ``name`` and optional ``status_map`` only — the raw token is
    generated server-side and returned to the caller once via a separate
    response shape (see ``ProjectApiTokenViewSet.create``).  ``status_map``
    is immutable after creation by design; this serializer is the only
    code path that writes it.
    """

    class Meta:
        model = ProjectApiToken
        fields = ["name", "status_map"]

    def validate_name(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("name is required.")
        return value

    def validate_status_map(self, value: dict[str, str]) -> dict[str, str]:
        if not isinstance(value, dict):
            raise serializers.ValidationError("status_map must be an object.")
        valid_statuses = set(TaskStatus.values)
        for ext_status, internal in value.items():
            if not isinstance(ext_status, str) or not isinstance(internal, str):
                raise serializers.ValidationError("status_map keys and values must be strings.")
            if internal not in valid_statuses:
                raise serializers.ValidationError(
                    f"status_map value {internal!r} is not a valid TaskStatus.  "
                    f"Valid values: {sorted(valid_statuses)}"
                )
        return value


_INBOUND_SOURCE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


class InboundTaskSyncPayloadSerializer(serializers.Serializer[Any]):
    """Validates the inbound push payload.

    Loose by design: most fields are optional so a wide range of external
    sources can integrate without re-shaping their data.  Strict only on the
    identifiers (``source``, ``external_id``) and on the assignee email
    format.
    """

    # ``source`` collides with the base Field's ``source`` attribute (used for
    # ModelSerializer's model-field mapping); we genuinely want a payload key
    # named "source", so silence mypy here only.
    source = serializers.CharField(max_length=32)  # type: ignore[assignment]
    external_id = serializers.CharField(max_length=255)
    name = serializers.CharField(max_length=512, required=False, allow_blank=True)
    # 100 KB cap matches the practical ceiling Jira/Linear apply to descriptions
    # and prevents an integration with a misconfigured token from inflating
    # storage or response sizes with megabyte-scale bodies.
    description = serializers.CharField(required=False, allow_blank=True, max_length=100_000)
    status = serializers.CharField(max_length=64, required=False, allow_blank=True)
    assignee_email = serializers.EmailField(required=False, allow_blank=True)
    story_points = serializers.IntegerField(required=False, min_value=0, max_value=999)
    external_url = serializers.URLField(max_length=2000, required=False, allow_blank=True)
    parent_external_id = serializers.CharField(
        max_length=255,
        required=False,
        allow_blank=True,
    )

    def validate_source(self, value: str) -> str:
        # Lowercase ASCII letters, digits, underscore; starts with a letter.
        # Matches the ADR-0049 ProviderRegistry CharField shape (max_length=32).
        if not _INBOUND_SOURCE_PATTERN.match(value):
            raise serializers.ValidationError(
                "source must match [a-z][a-z0-9_]{0,31} — "
                "lowercase ASCII letter followed by letters, digits, or underscores."
            )
        return value

    def validate_external_id(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("external_id is required.")
        return value


class ApiTokenAuditEntrySerializer(serializers.ModelSerializer[ApiTokenAuditEntry]):
    """Read-only serializer for the per-project audit log.

    Callers MUST construct this from a queryset with
    ``.select_related("actor", "token")`` — ``get_actor_email`` accesses
    ``obj.actor.email`` and will issue one extra query per row otherwise.
    ``ApiTokenAuditView.get_queryset`` provides this; other call sites must
    match the pattern.
    """

    actor_email = serializers.SerializerMethodField()

    class Meta:
        model = ApiTokenAuditEntry
        fields = [
            "id",
            "token",
            "token_prefix",
            "actor",
            "actor_email",
            "action",
            "source_ip",
            "detail",
            "created_at",
        ]
        read_only_fields = fields

    def get_actor_email(self, obj: ApiTokenAuditEntry) -> str | None:
        if obj.actor is None:
            return None
        return str(obj.actor.email)

    def to_representation(self, instance: ApiTokenAuditEntry) -> dict[str, Any]:
        data = super().to_representation(instance)
        # source_ip reveals integration infrastructure topology (Jira egress IPs,
        # webhook relay addresses). Restrict to Project Manager+ callers only.
        request = self.context.get("request")
        if request is not None:
            from trueppm_api.apps.access.models import Role
            from trueppm_api.apps.access.permissions import _membership_role

            role = _membership_role(request, instance.project_id)
            if role is None or role < Role.ADMIN:
                data["source_ip"] = None
        return data


# ---------------------------------------------------------------------------
# Task collaboration serializers — ADR-0075 (#310 #311)
# ---------------------------------------------------------------------------


# Locked constraints from ADR-0075 threat-model pass.
MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB (constraint #4)
ALLOWED_ATTACHMENT_MIMES = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
)
MAX_COMMENT_BODY_CHARS = 10_000  # constraint #3
COMMENT_EDIT_WINDOW_SECONDS = 15 * 60  # constraint #11
ALLOWED_REACTION_EMOJI = frozenset({"👍"})  # 0.2 allow-list; expands in 0.3


class _MentionAuthorMiniSerializer(serializers.Serializer[Any]):
    """Inline read-only user summary used across attachment + comment serializers."""

    id = serializers.UUIDField(read_only=True)
    username = serializers.CharField(read_only=True)
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        name: str = obj.get_full_name() or obj.username
        return name


class TaskAttachmentSerializer(serializers.ModelSerializer[TaskAttachment]):
    """File-XOR-URL attachment on a task.

    Multipart uploads are accepted via `file`; pinned external links use
    `external_url`. Exactly one must be set per request — the DB CheckConstraint
    matches but this serializer surfaces a friendlier 400 message.
    """

    uploaded_by = _MentionAuthorMiniSerializer(read_only=True)
    deleted_by = _MentionAuthorMiniSerializer(read_only=True)

    class Meta:
        model = TaskAttachment
        fields = [
            "id",
            "file",
            "file_name",
            "file_size",
            "file_mime",
            "external_url",
            "external_title",
            "is_pinned",
            "uploaded_by",
            "deleted_by",
            "created_at",
            "is_deleted",
            "deleted_at",
        ]
        read_only_fields = [
            "id",
            "file_size",
            "file_mime",
            "uploaded_by",
            "deleted_by",
            "created_at",
            "is_deleted",
            "deleted_at",
        ]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # file XOR external_url
        file = attrs.get("file") or getattr(self.instance, "file", None)
        external = attrs.get("external_url") or getattr(self.instance, "external_url", "")
        has_file = bool(file)
        has_url = bool(external)
        if has_file == has_url:
            raise serializers.ValidationError(
                "Provide either a file upload OR an external_url, not both and not neither.",
                code="attachment_file_xor_url",
            )

        # File size + MIME allow-list (ADR-0075 #4, #5)
        if has_file and not self.instance:
            size = getattr(file, "size", None)
            if size is None or size > MAX_ATTACHMENT_SIZE_BYTES:
                raise serializers.ValidationError(
                    f"File exceeds the {MAX_ATTACHMENT_SIZE_BYTES // (1024 * 1024)} MB limit.",
                    code="attachment_too_large",
                )
            mime = getattr(file, "content_type", "") or ""
            # Strip any "; charset=..." trailer
            mime = mime.split(";", 1)[0].strip().lower()
            if mime not in ALLOWED_ATTACHMENT_MIMES:
                raise serializers.ValidationError(
                    f"File type {mime!r} is not allowed. Allowed types: "
                    "PDF, JPG, PNG, WebP, XLSX, CSV, DOCX.",
                    code="attachment_unsupported_mime",
                )
            attrs["file_size"] = size
            attrs["file_mime"] = mime
            if not attrs.get("file_name"):
                attrs["file_name"] = getattr(file, "name", "")

        # External URL must be http(s) — reject javascript:, file://, etc.
        if has_url:
            external_str = str(external)
            scheme = external_str.split(":", 1)[0].lower() if ":" in external_str else ""
            if scheme not in ("http", "https"):
                raise serializers.ValidationError(
                    "Only http(s) URLs are accepted for external attachments.",
                    code="attachment_unsupported_scheme",
                )

        return attrs


class SignedDownloadUrlSerializer(serializers.Serializer[Any]):
    """Response shape for the signed-URL action.

    Storage backends compose the actual URL; the serializer is for OpenAPI docs.
    """

    url = serializers.URLField(read_only=True)
    expires_at = serializers.DateTimeField(read_only=True)


class TaskCommentSerializer(serializers.ModelSerializer[TaskComment]):
    """Append-only task comment with single-level reply nesting.

    `body` is required + length-capped. `parent` must be a top-level comment
    on the same task. Edits are limited to a 15-min window after creation.
    """

    author = _MentionAuthorMiniSerializer(read_only=True)
    deleted_by = _MentionAuthorMiniSerializer(read_only=True)
    acknowledged_count = serializers.SerializerMethodField()
    reaction_count = serializers.SerializerMethodField()
    has_my_acknowledgement = serializers.SerializerMethodField()

    class Meta:
        model = TaskComment
        fields = [
            "id",
            "task",
            "parent",
            "author",
            "body",
            "edited_at",
            "created_at",
            "is_deleted",
            "deleted_at",
            "deleted_by",
            "acknowledged_count",
            "reaction_count",
            "has_my_acknowledgement",
        ]
        read_only_fields = [
            "id",
            "task",
            "author",
            "edited_at",
            "created_at",
            "is_deleted",
            "deleted_at",
            "deleted_by",
            "acknowledged_count",
            "reaction_count",
            "has_my_acknowledgement",
        ]

    def get_acknowledged_count(self, obj: TaskComment) -> int:
        return obj.acknowledgements.count()

    def get_reaction_count(self, obj: TaskComment) -> int:
        return obj.reactions.count()

    def get_has_my_acknowledgement(self, obj: TaskComment) -> bool:
        request = self.context.get("request")
        if request is None or not getattr(request.user, "is_authenticated", False):
            return False
        return obj.acknowledgements.filter(user=request.user).exists()

    def validate_body(self, value: str) -> str:
        if not value or not value.strip():
            raise serializers.ValidationError("Body cannot be blank.")
        if len(value) > MAX_COMMENT_BODY_CHARS:
            raise serializers.ValidationError(
                f"Body exceeds {MAX_COMMENT_BODY_CHARS} character limit.",
                code="comment_body_too_long",
            )
        return value

    def validate_parent(self, value: TaskComment | None) -> TaskComment | None:
        """Enforce single-level reply nesting and same-task scoping."""
        if value is None:
            return value
        if value.parent_id is not None:
            raise serializers.ValidationError(
                "Replies cannot themselves be replied to (one level only).",
                code="comment_reply_depth",
            )
        # The viewset has already established the task from the URL; the view
        # passes `task` into save(), so the parent must match.
        view = self.context.get("view")
        task_pk = getattr(view, "kwargs", {}).get("task_pk") if view else None
        if task_pk and str(value.task_id) != str(task_pk):
            raise serializers.ValidationError(
                "Parent comment must belong to the same task.",
                code="comment_parent_cross_task",
            )
        return value

    def update(self, instance: TaskComment, validated_data: dict[str, Any]) -> TaskComment:
        """Enforce edit window (ADR-0075 locked constraint #11)."""
        from datetime import timedelta

        if (timezone.now() - instance.created_at) > timedelta(seconds=COMMENT_EDIT_WINDOW_SECONDS):
            raise serializers.ValidationError(
                {"detail": "Edits are only allowed within 15 minutes of posting."},
                code="comment_edit_window_closed",
            )
        new_body = validated_data.get("body")
        if new_body is not None and new_body != instance.body:
            instance.edited_at = timezone.now()
        return super().update(instance, validated_data)


class CommentAcknowledgementSerializer(serializers.ModelSerializer[CommentAcknowledgement]):
    """One-shot ack chip. No user-supplied fields — the viewset sets user from request."""

    user = _MentionAuthorMiniSerializer(read_only=True)

    class Meta:
        model = CommentAcknowledgement
        fields = ["id", "user", "created_at"]
        read_only_fields = fields


class CommentReactionSerializer(serializers.ModelSerializer[CommentReaction]):
    """Single-emoji reaction. 0.2 allow-list is {'👍'} only."""

    user = _MentionAuthorMiniSerializer(read_only=True)

    class Meta:
        model = CommentReaction
        fields = ["id", "user", "emoji", "created_at"]
        read_only_fields = ["id", "user", "created_at"]

    def validate_emoji(self, value: str) -> str:
        if value not in ALLOWED_REACTION_EMOJI:
            allowed = ", ".join(repr(e) for e in sorted(ALLOWED_REACTION_EMOJI))
            raise serializers.ValidationError(
                f"Reaction {value!r} not in allow-list ({allowed}).",
                code="reaction_unsupported_emoji",
            )
        return value
