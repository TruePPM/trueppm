"""DRF serializers for the projects app."""

from __future__ import annotations

import os
import re
import uuid
from datetime import date
from typing import Any

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework import serializers
from trueppm_scheduler import find_cycle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    _VALID_EVM_MODES,
    _VALID_SORT_KEYS,
    PROJECT_CUSTOM_FIELD_MAX,
    RESERVED_SCRUM_CEREMONY_NAMES,
    AcceptanceCriterion,
    ApiTokenAuditEntry,
    BacklogItem,
    BacklogItemStatus,
    Baseline,
    BaselineTask,
    BoardSavedView,
    Calendar,
    CalendarException,
    CeremonyCadenceType,
    CeremonyTemplate,
    CommentAcknowledgement,
    CommentReaction,
    CustomFieldType,
    Dependency,
    EstimateStatus,
    EstimationMode,
    InboundTaskLink,
    PhaseGateConfig,
    Program,
    Project,
    ProjectApiToken,
    ProjectCustomField,
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
    TaskRecurrenceRule,
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

    ``member_count`` and ``percent_complete`` are populated only when the
    viewset annotates them — currently just the ``?program__isnull=true``
    (ungrouped) list branch consumed by the Programs directory (ADR-0083).
    They return ``null`` on every other path so the default project list stays
    a single unaggregated query (the list is deliberately lightweight at
    portfolio scale — see ``ProjectViewSet.get_serializer_class``).
    """

    member_count = serializers.SerializerMethodField()
    percent_complete = serializers.SerializerMethodField()

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
            # Product-backlog prioritization model (ADR-0105 §3). Admin+-gated write,
            # enforced in ProjectViewSet alongside estimation_mode.
            "prioritization_model",
            "program",
            "member_count",
            "percent_complete",
            # Lifecycle (#530) — read-only; flipped via /archive/ and /unarchive/.
            "is_archived",
            "archived_at",
            "archived_by",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "is_archived",
            "archived_at",
            "archived_by",
        ]

    def get_member_count(self, obj: Project) -> int | None:
        """Active membership count — only annotated on the ungrouped list
        branch (ADR-0083). ``None`` elsewhere; never triggers a per-row query."""
        return getattr(obj, "member_count", None)

    def get_percent_complete(self, obj: Project) -> float | None:
        """Task-weighted mean progress — annotated only on the ungrouped list
        branch (ADR-0083). ``None`` when unannotated or the project has no
        tasks. Rounded to one decimal for display stability."""
        value = getattr(obj, "percent_complete", None)
        return round(value, 1) if value is not None else None

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

    # Fields a sub-Admin (Scheduler) member may change on an existing project.
    # Everything else under this serializer is a Project Manager concern, so this
    # is an explicit allowlist — any new writable field is Admin-only by default
    # until deliberately added here (#769; ADR-0041 estimation governance).
    _SCHEDULER_WRITABLE_FIELDS = frozenset({"methodology", "estimation_mode"})

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        """Field-level governance for edits below Admin (#769).

        The viewset gates update/partial_update at Scheduler+, so Viewer/Member
        never reach here. A Scheduler may change only the scheduling-governance
        fields (methodology, estimation_mode); attempting to change a general
        project setting (name, dates, calendar, …) is rejected with 400 rather
        than silently dropped. Admin+ bypasses the check. ``program`` carries its
        own ADR-0070 gate in ``validate_program`` and is not re-checked here.
        """
        attrs = super().validate(attrs)
        instance = self.instance
        if instance is None:
            return attrs
        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return attrs

        from trueppm_api.apps.access.permissions import _membership_role

        role = _membership_role(request, instance.pk)
        if role is not None and role >= Role.ADMIN:
            return attrs

        changed_admin_only = sorted(
            field
            for field, value in attrs.items()
            if field not in self._SCHEDULER_WRITABLE_FIELDS
            and field != "program"
            and getattr(instance, field, None) != value
        )
        if changed_admin_only:
            raise serializers.ValidationError(
                "You need at least Project Manager role to change project settings "
                f"({', '.join(changed_admin_only)}). A Scheduler may change only "
                "methodology and estimation_mode."
            )
        return attrs


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
            "color",
            "lead",
            "lead_detail",
            "created_by",
            "created_at",
            "updated_at",
            "my_role",
            "my_role_label",
            "project_count",
            "member_count",
            # Lifecycle (#530) — read-only; flipped via /close/ and /reopen/.
            "is_closed",
            "closed_at",
            "closed_by",
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
            "is_closed",
            "closed_at",
            "closed_by",
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

    def validate_color(self, value: str | None) -> str | None:
        """Normalize the accent color to a #RRGGBB hex or null (#698).

        Empty string collapses to null so the model's "unset" semantics hold
        regardless of whether the client sends ``""`` or omits the field —
        mirrors ``PhaseSerializer.validate_color``.
        """
        if not value:
            return None
        if not _HEX_COLOR_RE.fullmatch(value):
            raise serializers.ValidationError("color must be a #RRGGBB hex string or null.")
        return value

    def get_my_role_label(self, obj: Program) -> str | None:
        role = getattr(obj, "_my_role", None)
        if role is None:
            return None
        return Role(role).label


class ProgramRollupConfigSerializer(serializers.ModelSerializer[Program]):
    """GET/PATCH payload for ``/api/v1/programs/{id}/rollup-config/`` (ADR-0079).

    Both fields are partial-updatable. ``enabled_kpis`` is validated against
    the closed ``RollupKpi`` enum — unknown identifiers raise 400 rather than
    being silently dropped, which would leave the UI and the server in
    different states.
    """

    # Hard caps on shape (security M1): list length is bounded by the closed
    # ``RollupKpi`` enum, and each child string is bounded by the longest
    # identifier with a small slack. Without these, a caller could push a
    # multi-megabyte list of strings — they would all be rejected by
    # ``validate_enabled_kpis`` as unknown, but the validator would still
    # interpolate them into an error string and burn a worker.
    enabled_kpis = serializers.ListField(
        child=serializers.CharField(max_length=64),
        source="rollup_enabled_kpis",
        max_length=64,
    )
    aggregation_policy = serializers.ChoiceField(
        source="rollup_aggregation_policy",
        choices=[],  # populated in __init__ to avoid import-cycle at class build
    )

    class Meta:
        model = Program
        fields = ["enabled_kpis", "aggregation_policy"]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        from trueppm_api.apps.projects.models import AggregationPolicy

        self.fields["aggregation_policy"].choices = AggregationPolicy.choices  # type: ignore[attr-defined]

    def validate_enabled_kpis(self, value: list[str]) -> list[str]:
        from trueppm_api.apps.projects.models import RollupKpi

        valid = {choice.value for choice in RollupKpi}
        unknown = [v for v in value if v not in valid]
        if unknown:
            # Cap the echo at the first few (security L1) so an attacker
            # cannot blow up an error message by sending many bad values —
            # the ``max_length=64`` on the ListField already bounds this, but
            # belt-and-braces.
            preview = ", ".join(sorted(unknown)[:5])
            suffix = f" (+{len(unknown) - 5} more)" if len(unknown) > 5 else ""
            raise serializers.ValidationError(
                f"Unknown KPI identifier(s): {preview}{suffix}. "
                f"Expected one of: {', '.join(sorted(valid))}."
            )
        # De-duplicate while preserving caller order so repeated PATCHes don't
        # accumulate duplicates in the JSONB column.
        seen: set[str] = set()
        deduped: list[str] = []
        for kpi in value:
            if kpi not in seen:
                seen.add(kpi)
                deduped.append(kpi)
        return deduped


class ProgramRiskPolicySerializer(serializers.ModelSerializer[Program]):
    """GET/PATCH payload for ``/api/v1/programs/{id}/risk-policy/`` (#529).

    Wraps the two ``risk_*`` columns on Program. Both fields are partial-
    updatable. Enum and range are enforced server-side so the UI can stay
    thin — DRF's ``ChoiceField`` rejects unknown values; the explicit
    ``min_value``/``max_value`` mirror the model-level validators so a
    well-formed PATCH never reaches the database with an out-of-range int.
    """

    slip_propagation = serializers.ChoiceField(
        source="risk_slip_propagation",
        choices=[],  # populated in __init__ to avoid import-cycle at class build
    )
    escalation_days = serializers.IntegerField(
        source="risk_escalation_days",
        min_value=1,
        max_value=30,
    )

    class Meta:
        model = Program
        fields = ["slip_propagation", "escalation_days"]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        from trueppm_api.apps.projects.models import SlipPropagation

        self.fields["slip_propagation"].choices = SlipPropagation.choices  # type: ignore[attr-defined]


class CeremonyTemplateSerializer(serializers.ModelSerializer[CeremonyTemplate]):
    """Read/write serializer for program ceremony templates (ADR-0079).

    Enforces three rules the API contract requires:

    1. ``name`` is rejected if it matches the Scrum reserved-vocabulary list
       (Sprint Planning, Sprint Review, etc.) — those events belong to the
       per-sprint surface, not program-level cadence. This is a server-side
       guard against silent boundary drift even if the UI is bypassed.
    2. ``cadence_day`` and ``cadence_time`` are required for time-of-day
       cadences (weekly/biweekly/monthly) and forbidden for ``on_milestone``
       (cleared to ``""``/``None`` if supplied).
    3. ``duration_minutes`` is bounded to a sane meeting range (5–1440 min)
       so the UI does not have to defend against pathological values.
    """

    class Meta:
        model = CeremonyTemplate
        fields = [
            "id",
            "server_version",
            "program",
            "name",
            "cadence_type",
            "cadence_day",
            "cadence_time",
            "duration_minutes",
            "owner_role",
            "enabled",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "program",
            "created_by",
            "created_at",
            "updated_at",
        ]

    def validate_name(self, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise serializers.ValidationError("Name is required.")
        if normalized.casefold() in RESERVED_SCRUM_CEREMONY_NAMES:
            raise serializers.ValidationError(
                "Sprint events (Sprint Planning, Review, Retrospective, Daily Scrum) "
                "are configured per-sprint, not as program-level ceremonies. "
                'Try a program-level name like "Program sync" or "Steering committee".'
            )
        return normalized

    def validate_duration_minutes(self, value: int) -> int:
        if value < 5 or value > 1440:
            raise serializers.ValidationError("Duration must be between 5 and 1440 minutes.")
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Resolve effective cadence_type for partial updates.
        cadence_type = attrs.get("cadence_type")
        if cadence_type is None and self.instance is not None:
            cadence_type = self.instance.cadence_type

        if cadence_type == CeremonyCadenceType.ON_MILESTONE:
            # Strip incoming day/time so on-milestone rows can never carry
            # stale wall-clock metadata from a prior cadence_type.
            attrs["cadence_day"] = ""
            attrs["cadence_time"] = None
        else:
            # weekly / biweekly / monthly all need a wall-clock anchor.
            effective_day = attrs.get(
                "cadence_day",
                getattr(self.instance, "cadence_day", "") if self.instance else "",
            )
            effective_time = attrs.get(
                "cadence_time",
                getattr(self.instance, "cadence_time", None) if self.instance else None,
            )
            if not effective_day:
                raise serializers.ValidationError(
                    {"cadence_day": "Day is required for time-of-day cadences."}
                )
            if effective_time is None:
                raise serializers.ValidationError(
                    {"cadence_time": "Time is required for time-of-day cadences."}
                )

        return attrs


class PhaseGateConfigSerializer(serializers.ModelSerializer[PhaseGateConfig]):
    """Read/write serializer for the singleton phase-gate config (ADR-0079).

    No ``program`` write field: the row is bound to its program by URL and
    looked up via ``get_or_create`` in the view layer. ``invite_template`` is
    free text in v1 — variable substitution against ``{{milestone.name}}`` etc.
    is a downstream calendar-integration follow-up.
    """

    class Meta:
        model = PhaseGateConfig
        fields = [
            "id",
            "server_version",
            "program",
            "enabled",
            "invite_template",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "program",
            "updated_at",
        ]


class BacklogItemSerializer(serializers.ModelSerializer[BacklogItem]):
    """Read/write serializer for program backlog items (ADR-0069, #737).

    ``program`` is bound by URL (set in the view's ``perform_create``) and is
    read-only here so a client cannot retarget an item to another program by
    payload. ``pulled_*`` are read-only — they are written only by the ``pull``
    action via ``backlog_services``. ``status`` is writable for archive /
    un-archive (PROPOSED ↔ ARCHIVED) but ``validate_status`` rejects a direct
    set to ``PULLED``: the only PROPOSED→PULLED path is the ``pull`` action.
    ``tags`` is a free-form list of short strings.
    """

    class Meta:
        model = BacklogItem
        fields = [
            "id",
            "server_version",
            "program",
            "title",
            "description",
            "item_type",
            "status",
            "tags",
            "priority_rank",
            "story_points",
            "pulled_task",
            "pulled_at",
            "pulled_by",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "program",
            "pulled_task",
            "pulled_at",
            "pulled_by",
            "created_by",
            "created_at",
            "updated_at",
        ]

    def validate_title(self, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise serializers.ValidationError("Title is required.")
        return normalized

    def validate_status(self, value: str) -> str:
        # PULLED is reachable only through the pull action — it records the
        # created Task and bumps both rows atomically. Allowing a bare PATCH to
        # PULLED would leave pulled_task NULL and desync the lifecycle.
        if value == BacklogItemStatus.PULLED:
            raise serializers.ValidationError(
                "An item becomes 'pulled' only via the pull action, not a direct update."
            )
        return value

    def validate_tags(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            raise serializers.ValidationError("tags must be a list of strings.")
        cleaned: list[str] = []
        for tag in value:
            if not isinstance(tag, str):
                raise serializers.ValidationError("Each tag must be a string.")
            tag = tag.strip()
            if tag and tag not in cleaned:
                cleaned.append(tag)
        return cleaned


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


class AcceptanceCriterionSerializer(serializers.ModelSerializer[AcceptanceCriterion]):
    """Read/write serializer for a story's acceptance criteria (ADR-0105 §2).

    The review trail (``met_by``/``met_at``) is read-only and exposed as the criterion's
    status with attribution; it is never aggregated to a PMO surface and never rendered as
    a per-person column (the VoC privacy guard). ``met`` is set by ticking the criterion;
    the service layer stamps ``met_by``/``met_at`` when that happens.
    """

    met_by_name = serializers.SerializerMethodField()

    class Meta:
        model = AcceptanceCriterion
        fields = [
            "id",
            "task",
            "text",
            "given",
            "when",
            "then",
            "met",
            "position",
            "met_by_name",
            "met_at",
            "server_version",
        ]
        read_only_fields = ["id", "server_version", "met_at", "met_by_name"]

    def get_met_by_name(self, obj: AcceptanceCriterion) -> str | None:
        user = obj.met_by
        if user is None:
            return None
        return user.get_full_name() or user.get_username()

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # A criterion may not be reparented to another task. Without this, the writable
        # ``task`` FK is a cross-project write-IDOR: a member of project A could PATCH a
        # criterion's ``task`` to a project-B task (object perms only check the *existing*
        # task's project). Criteria never legitimately move tasks — split copies them.
        if (
            self.instance is not None
            and "task" in attrs
            and attrs["task"].pk != self.instance.task_id
        ):
            raise serializers.ValidationError(
                {"task": "A criterion cannot be moved to another task."}
            )
        return attrs


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

    # ── Product-backlog / PO grooming (ADR-0105) ────────────────────────────────
    # Read-only nested acceptance criteria (write via the AcceptanceCriterion endpoints).
    acceptance_criteria = AcceptanceCriterionSerializer(many=True, read_only=True)
    # Computed prioritization score under the project's active model (#922). Null when
    # inputs are incomplete — see product_backlog_services.compute_score.
    prioritization_score = serializers.SerializerMethodField()
    # Acceptance-criteria meter (DA-10/DA-14): met / total.
    criteria_met_count = serializers.SerializerMethodField()
    criteria_total = serializers.SerializerMethodField()
    # Definition-of-Ready blocker codes (#731). Empty ⇒ the story may be marked READY.
    dor_blockers = serializers.SerializerMethodField()

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
            "sprint_pending",
            "story_points",
            "remaining_points",
            "is_subtask",
            "sprint_scope_changes",
            "milestone_rollup",
            # ADR-0105 product backlog
            "type",
            "parent_epic",
            "dor",
            "sprint_rank",
            # distinct per-model scoring inputs (writable)
            "business_value",
            "time_criticality",
            "risk_reduction",
            "job_size",
            "reach",
            "impact",
            "confidence",
            "effort",
            "value",
            "effort_estimate",
            # computed / nested reads
            "acceptance_criteria",
            "prioritization_score",
            "criteria_met_count",
            "criteria_total",
            "dor_blockers",
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
            # ADR-0102: only the accept/reject services may change this — never a
            # client PATCH (so a contributor cannot self-accept by writing it).
            "sprint_pending",
            "sprint_scope_changes",
            "milestone_rollup",
            # Computed product-backlog reads (the writable backing fields type /
            # parent_epic / dor / sprint_rank / scoring inputs stay editable; acceptance
            # criteria are written via the AcceptanceCriterion endpoints).
            "acceptance_criteria",
            "prioritization_score",
            "criteria_met_count",
            "criteria_total",
            "dor_blockers",
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

        # ADR-0102 §3: a task pending sprint-acceptance is team-owned. Its sprint
        # link may only change by ACCEPTING (keeps the sprint, clears pending) or
        # REJECTING (removes it) via the dedicated scope-change endpoints — never
        # through a generic task update. Blocking it here closes the bypass where
        # any writer of the `sprint` field (REST PATCH by a member-assignee, or the
        # mobile sync upload — both route through this serializer) could un-gate a
        # pending injection, and it prevents the audit row / sprint_pending flag
        # from being stranded by a write that skips reject_scope_change.
        if (
            self.instance is not None
            and getattr(self.instance, "sprint_pending", False)
            and "sprint" in attrs
            and str(getattr(sprint, "pk", None)) != str(self.instance.sprint_id)
        ):
            raise serializers.ValidationError(
                {
                    "sprint": (
                        "This task is pending sprint acceptance — accept or reject it "
                        "via the scope-change endpoints rather than changing its sprint "
                        "directly."
                    )
                }
            )

        # Sprint/Phase/WBS guardrails (ADR-0101). Only evaluated when a task is being
        # *assigned* to a sprint (sprint set to a non-null value). Tripped rules at
        # WARN are advisory — they ride out as `warnings` on the response and never
        # reject; only a rule the project Owner escalated to BLOCK raises here.
        if "sprint" in attrs and sprint is not None and self.instance is not None:
            self._tripped_guardrails = self._evaluate_task_guardrails(self.instance, sprint)
        else:
            self._tripped_guardrails = []

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

        # Project-start floor guard (#868): a task may not be pinned to start
        # before the project's start_date. The CPM already clamps early_start to
        # the project start, so persisting a sub-start planned_start is a "ghost"
        # value that silently re-activates if the project start later moves
        # earlier. Reject it at the API boundary with a structured code the
        # frontend maps to its snap/move/cancel prompt. No role exemption — the
        # supported escape is moving the project start date (Admin+-gated on the
        # Project serializer), not bypassing the floor per task.
        new_planned_start = attrs.get("planned_start")
        if "planned_start" in attrs and new_planned_start is not None:
            project = self.instance.project if self.instance is not None else attrs.get("project")
            if project is not None:
                # Compare against the first working day >= start_date, not the
                # literal start_date (#884): the CPM forward pass floors
                # early_start there, so a planned_start on a non-working start
                # date (e.g. a Saturday) is a ghost value, and "snap to project
                # start" must target the working-day floor to actually clear.
                from trueppm_api.apps.projects.utilization import first_working_day

                floor = first_working_day(project)
                if new_planned_start < floor:
                    raise PlannedStartBeforeProjectStartError(project.start_date, floor)

        self._validate_product_backlog(attrs)

        return attrs

    def _validate_product_backlog(self, attrs: dict[str, Any]) -> None:
        """Validate ADR-0105 fields: parent-epic membership and the DoR-gated READY move.

        - ``parent_epic`` must be a ``type=EPIC`` task in the same project, not the task
          itself, and not itself nested under another epic (epics don't nest in 0.3).
        - Transitioning ``dor`` to READY is gated (advisory): the story must be estimated
          with at least one acceptance criterion and all criteria met (#731). The gate
          blocks the PO's *Ready* action only — it does not block sprint intake.

        Structural backlog fields (work-item type→EPIC, parent_epic links, and the
        per-model scoring inputs) are PO-owned per ADR-0105 §6 and gated to
        ``can_manage_backlog`` (Admin+ today; the ADR-0078/#927 Product-Owner facet
        slots into the same helper). Story-grooming fields the team shares (``dor``,
        ``sprint_rank``, ``story_points``) and quick-add (``type`` among
        story/task/bug/spike) stay at the normal task-write permission. Acceptance
        criteria are written through the AcceptanceCriterion endpoints.
        """
        from rest_framework.exceptions import PermissionDenied

        from trueppm_api.apps.access.permissions import can_manage_backlog
        from trueppm_api.apps.projects.models import DorState, TaskType

        # Structural-field gate (ADR-0105 §6). Only enforced when a structural field is
        # actually being written, so it never interferes with quick-add (type=STORY) or
        # ordinary story grooming.
        _SCORING_FIELDS = {
            "business_value",
            "time_criticality",
            "risk_reduction",
            "job_size",
            "reach",
            "impact",
            "confidence",
            "effort",
            "value",
            "effort_estimate",
        }
        existing_type = getattr(self.instance, "type", None)
        # Epic (de)classification: becoming an EPIC, or changing an existing EPIC away.
        type_is_structural = "type" in attrs and (
            attrs["type"] == TaskType.EPIC or existing_type == TaskType.EPIC
        )
        touches_structural = (
            "parent_epic" in attrs or type_is_structural or bool(_SCORING_FIELDS & set(attrs))
        )
        if touches_structural:
            project = self.instance.project if self.instance is not None else attrs.get("project")
            if project is not None and not can_manage_backlog(self._get_caller_role(project)):
                raise PermissionDenied(
                    "Managing the product backlog (work-item type, epic links, and "
                    "prioritization scoring) requires Project Manager role or above."
                )

        # parent-epic membership
        parent_epic = attrs.get("parent_epic")
        if "parent_epic" in attrs and parent_epic is not None:
            task_project_id = (
                self.instance.project_id
                if self.instance is not None
                else getattr(attrs.get("project"), "pk", None)
            )
            if parent_epic.type != TaskType.EPIC:
                raise serializers.ValidationError(
                    {"parent_epic": "Referenced task is not an epic."}
                )
            if task_project_id is not None and str(parent_epic.project_id) != str(task_project_id):
                raise serializers.ValidationError(
                    {"parent_epic": "Epic does not belong to this project."}
                )
            if self.instance is not None and parent_epic.pk == self.instance.pk:
                raise serializers.ValidationError({"parent_epic": "A task cannot be its own epic."})
            if parent_epic.parent_epic_id is not None:
                raise serializers.ValidationError(
                    {"parent_epic": "Epics cannot be nested (the parent already has an epic)."}
                )

        # DoR-gated READY transition (advisory). Criteria live on the saved instance (the
        # AcceptanceCriterion child rows); story_points may be changed in the same PATCH.
        if attrs.get("dor") == DorState.READY:
            blockers: list[str] = []
            if self.instance is not None:
                eff_points = attrs.get("story_points", self.instance.story_points)
                criteria = list(self.instance.acceptance_criteria.all())
                met = sum(1 for c in criteria if c.met)
                if eff_points is None:
                    blockers.append("unestimated")
                if not criteria:
                    blockers.append("no_acceptance_criteria")
                elif met < len(criteria):
                    blockers.append("acceptance_criteria_unmet")
            else:
                # A brand-new task has no criteria yet — it cannot start out Ready.
                blockers.append("no_acceptance_criteria")
            if blockers:
                raise serializers.ValidationError(
                    {"dor": f"Cannot mark ready — unresolved: {', '.join(blockers)}."}
                )

    def _evaluate_task_guardrails(self, task: Task, sprint: Any) -> list[str]:
        """Evaluate ADR-0101 guardrails for assigning ``task`` to ``sprint``.

        Returns the list of tripped rule keys (for the WARN response payload). If
        any tripped rule is escalated to BLOCK by the project's effective policy,
        raises :class:`GuardrailBlockedError` for the first such rule instead.

        Summary detection uses a direct ltree child-existence query rather than the
        ``is_summary`` annotation, because ``validate`` may run on an instance loaded
        without that annotation (e.g. a bare PATCH). Recurring tasks are exempt from
        WBS/phase rules by construction (``wbs_path`` is null), but are still caught
        by ``recurring_in_sprint``.
        """
        from trueppm_api.apps.projects.models import (
            COMPOSITION_GUARDRAIL_RULES,
            GuardrailLevel,
            ProjectGuardrailPolicy,
        )
        from trueppm_api.apps.projects.models import (
            Task as TaskModel,
        )

        wbs_path = task.wbs_path
        is_phase = bool(wbs_path) and re.fullmatch(r"\d+", str(wbs_path)) is not None
        has_children = False
        if wbs_path:
            # A task is a summary if any non-deleted task has a wbs_path one or more
            # levels deeper, i.e. starting with "<this path>.". Uses `__regex` (the
            # lookup the codebase already relies on for ltree paths) rather than an
            # ltree-specific descendant operator, so it works without extra lookup
            # registration. The path segments are digits, so escaping is a safety net.
            child_prefix = re.escape(str(wbs_path))
            has_children = (
                TaskModel.objects.filter(
                    project_id=task.project_id,
                    is_deleted=False,
                    wbs_path__regex=rf"^{child_prefix}\.",
                )
                .exclude(pk=task.pk)
                .exists()
            )

        # Effective task window: planned_start (PM commitment) falling back to the
        # CPM early_start; finish via early_finish. A task with no dates can't be
        # "outside" a window, so the window rule simply won't fire.
        task_start = task.planned_start or task.early_start
        task_finish = task.early_finish

        tripped = evaluate_sprint_guardrails(
            has_children=has_children,
            is_phase=is_phase,
            is_recurring=task.is_recurring,
            task_start=task_start,
            task_finish=task_finish,
            sprint_start=getattr(sprint, "start_date", None),
            sprint_finish=getattr(sprint, "finish_date", None),
        )
        if not tripped:
            return []

        policy = ProjectGuardrailPolicy.objects.filter(project_id=task.project_id).first()
        if policy is not None:
            for rule in tripped:
                if (
                    rule in COMPOSITION_GUARDRAIL_RULES
                    and policy.effective_level(rule) == GuardrailLevel.BLOCK
                ):
                    raise GuardrailBlockedError(
                        rule=rule,
                        detail=GUARDRAIL_WARNING_COPY.get(rule, "This assignment is blocked."),
                        suggested_action=GUARDRAIL_SUGGESTED_ACTION.get(rule, "remove_from_sprint"),
                    )
        return tripped

    def _active_prioritization_model(self, obj: Task) -> str:
        """The project's active prioritization model, preferring a context-supplied value.

        The grooming-list view passes ``prioritization_model`` in context so the score for
        every row is computed without a per-row Project query.
        """
        if "prioritization_model" in self.context:
            return str(self.context["prioritization_model"])
        project = getattr(obj, "project", None)
        return getattr(project, "prioritization_model", "none") if project else "none"

    def get_prioritization_score(self, obj: Task) -> float | None:
        from trueppm_api.apps.projects.product_backlog_services import compute_score

        return compute_score(obj, self._active_prioritization_model(obj))

    def get_criteria_met_count(self, obj: Task) -> int:
        from trueppm_api.apps.projects.product_backlog_services import ac_counts

        return ac_counts(obj)[0]

    def get_criteria_total(self, obj: Task) -> int:
        from trueppm_api.apps.projects.product_backlog_services import ac_counts

        return ac_counts(obj)[1]

    def get_dor_blockers(self, obj: Task) -> list[str]:
        from trueppm_api.apps.projects.product_backlog_services import dor_blockers

        return dor_blockers(obj)

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
                # ADR-0102: the row id lets the client target the single
                # accept/reject endpoints (POST /scope-changes/{id}/accept|reject/)
                # for a per-item affordance on the board card and review panel.
                "id": str(r.pk),
                # ADR-0101: `item_name` is the forward-looking key; `subtask_name`
                # is kept as a deprecated alias for one release so existing clients
                # don't break. Both carry the same value.
                "subtask_name": r.subtask_name,
                "item_name": r.item_name,
                "added_by_name": r.added_by.get_full_name() if r.added_by else None,
                "added_at": r.added_at.isoformat(),
                "goal_impact": r.goal_impact,
                # ADR-0102: the accept-gate decision outcome (pending|accepted|rejected).
                "status": r.status,
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


class PlannedStartBeforeProjectStartError(Exception):
    """Raised by ``TaskSerializer.validate`` when ``planned_start`` precedes the
    project's ``start_date`` (#868).

    The CPM forward pass already clamps ``early_start`` to the project start
    (``engine.py`` ``early_start = max([project_start, ...])``), so a persisted
    sub-start ``planned_start`` is a ghost value: invisible while the project
    start sits after it, but silently re-activating if the project start is
    later moved earlier. Rejecting it at the API boundary keeps ``planned_start``
    honest for every consumer, not just the web client (API-first).

    No role exemption — the supported escape is to move the project's
    ``start_date`` (a separate, Admin+-gated ``ProjectSerializer`` write), which
    the frontend offers alongside "snap to project start" when the prompt fires.
    The true relax-the-floor override is tracked separately (#867, ADR-gated).

    Bypasses DRF's :class:`serializers.ValidationError` like
    :class:`CycleDetectedError` so the frontend receives a structured
    ``{"code", "detail", "suggested_action", "project_start_date",
    "effective_floor_date"}`` body it can map to the snap/move/cancel prompt
    (ADR-0055).

    ``effective_floor_date`` is the first working day on or after the project
    start (#884): the CPM engine floors ``early_start`` there, so the guard
    compares against it and the frontend snaps to it. ``project_start_date``
    remains the literal start (for the "project starts on …" copy).
    """

    def __init__(self, project_start_date: date, effective_floor_date: date) -> None:
        self.project_start_date = project_start_date
        self.effective_floor_date = effective_floor_date
        super().__init__("Task cannot be scheduled before the project start date.")


class GuardrailBlockedError(Exception):
    """Raised by ``TaskSerializer.validate`` when a sprint assignment trips a
    guardrail rule the project has escalated to BLOCK (ADR-0101 §3).

    Carries the offending ``rule`` key so the viewset can emit a structured
    ``{"code": "guardrail_blocked", "rule": ..., "detail": ..., "suggested_action": ...}``
    body. A block is overridable only by removing the offending state, never
    silently — so unlike the warn path there is no override token.

    Bypasses DRF's :class:`serializers.ValidationError` for the same reason as the
    sibling errors above (ADR-0055): the frontend maps the stable ``rule`` code to
    its block affordance and fix-it copy without scraping a message string.
    """

    def __init__(self, rule: str, detail: str, suggested_action: str) -> None:
        self.rule = rule
        self.detail = detail
        self.suggested_action = suggested_action
        super().__init__(detail)


# Outcome-language warning copy keyed by rule (ADR-0101 Tier 1). Deliberately phrased
# in terms of the *consequence* ("double-counts in velocity"), never WBS structural
# jargon ("WBS L1 root", "summary task") — the agile personas (Alex/Morgan) reject
# PM vocabulary leaking into their surfaces. The web client mirrors these strings;
# the server returns them so a non-web API caller gets the same guidance.
GUARDRAIL_WARNING_COPY: dict[str, str] = {
    "summary_in_sprint": (
        "This double-counts in velocity — its child tasks already carry the points."
    ),
    "phase_in_sprint": ("Phases group work; assign the tasks inside it to the sprint instead."),
    "task_outside_sprint_window": (
        "This is scheduled outside the sprint's dates — it won't finish in the sprint."
    ),
    "recurring_in_sprint": "Recurring tasks aren't counted in sprint velocity.",
}

GUARDRAIL_SUGGESTED_ACTION: dict[str, str] = {
    "summary_in_sprint": "assign_child_tasks",
    "phase_in_sprint": "assign_child_tasks",
    "task_outside_sprint_window": "align_dates_or_sprint",
    "recurring_in_sprint": "remove_from_sprint",
}


def evaluate_sprint_guardrails(
    *,
    has_children: bool,
    is_phase: bool,
    is_recurring: bool,
    task_start: date | None,
    task_finish: date | None,
    sprint_start: date | None,
    sprint_finish: date | None,
) -> list[str]:
    """Pure guardrail evaluator: return the rule keys a sprint assignment trips.

    Pure function of the supplied state so it can run identically server-side and
    in the offline web/mobile client (ADR-0101: rules must evaluate wherever the
    task data lives, with no network dependency). Returns rule keys in a stable
    order; an empty list means the assignment is clean.

    ``is_phase`` (a WBS L1 root) is a *more specific* case of ``has_children`` — when
    a task is both, we report ``phase_in_sprint`` only, so the user sees one precise
    notice rather than two overlapping ones.
    """
    rules: list[str] = []
    if is_phase:
        rules.append("phase_in_sprint")
    elif has_children:
        rules.append("summary_in_sprint")
    if is_recurring:
        rules.append("recurring_in_sprint")
    if (
        task_start is not None
        and task_finish is not None
        and sprint_start is not None
        and sprint_finish is not None
        and (task_finish < sprint_start or task_start > sprint_finish)
    ):
        rules.append("task_outside_sprint_window")
    return rules


class ProjectGuardrailPolicySerializer(serializers.Serializer[Any]):
    """Read/write serializer for a project's guardrail policy (ADR-0101 §3).

    ``levels`` is a ``{rule_key: "warn"|"block"}`` map; unknown keys are rejected so
    a typo can't silently no-op. ``effective_levels`` is a read-only mirror that
    applies the sovereignty gate (an unacknowledged EXTERNAL composition-block reads
    back as ``warn``), so the client renders what is actually enforced. The view
    enforces that only ``role >= Role.OWNER`` may set a composition rule to BLOCK.
    """

    levels = serializers.DictField(child=serializers.CharField(), required=False)
    # Named `policy_source` (not `source`) to avoid shadowing DRF's reserved
    # ``Field.source`` attribute; mapped to the model's ``source`` column.
    policy_source = serializers.CharField(source="source", read_only=True)
    source_label = serializers.CharField(read_only=True)
    acknowledged_by_team = serializers.BooleanField(required=False)
    effective_levels = serializers.SerializerMethodField()
    server_version = serializers.IntegerField(read_only=True)

    def validate_levels(self, value: dict[str, Any]) -> dict[str, Any]:
        from trueppm_api.apps.projects.models import GuardrailLevel, GuardrailRule

        valid_rules = {r.value for r in GuardrailRule}
        valid_levels = {lvl.value for lvl in GuardrailLevel}
        for rule, level in value.items():
            if rule not in valid_rules:
                raise serializers.ValidationError(f"Unknown guardrail rule: {rule!r}.")
            if level not in valid_levels:
                raise serializers.ValidationError(
                    f"Invalid level {level!r} for {rule!r} (expected warn|block)."
                )
        return value

    def get_effective_levels(self, obj: Any) -> dict[str, str]:
        from trueppm_api.apps.projects.models import GuardrailRule

        return {rule.value: obj.effective_level(rule.value) for rule in GuardrailRule}


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


class TaskRecurrenceRuleSerializer(serializers.ModelSerializer[TaskRecurrenceRule]):
    """Read/write serializer for a task's recurrence rule (ADR-0090).

    One rule per task. The ``task`` FK is settable on create and immutable
    thereafter — a rule cannot be repointed to another task. ``occurrence_count``
    exposes how many occurrences have been materialized so the #738 setup panel can
    show series progress; ``generated_through`` is the internal generation cursor and
    is read-only.
    """

    # Explicit queryset excludes soft-deleted tasks so a rule cannot anchor to a
    # tombstoned template.
    task = serializers.PrimaryKeyRelatedField(queryset=Task.objects.filter(is_deleted=False))
    occurrence_count = serializers.SerializerMethodField()

    class Meta:
        model = TaskRecurrenceRule
        fields = [
            "id",
            "server_version",
            "task",
            "frequency",
            "interval",
            "weekdays",
            "day_of_month",
            "time_of_day",
            "timezone",
            "end_type",
            "end_date",
            "end_count",
            "inherit_assignee",
            "inherit_subtasks",
            "inherit_attachments",
            "inherit_morning_notification",
            "generated_through",
            "occurrence_count",
        ]
        read_only_fields = ["id", "server_version", "generated_through", "occurrence_count"]

    def get_occurrence_count(self, obj: TaskRecurrenceRule) -> int:
        """Count of materialized (non-deleted) occurrences generated so far.

        Prefers the ``_occurrence_count`` annotation set by the viewset's get_queryset
        (avoids a COUNT-per-row N+1 on list); falls back to a live count so the
        serializer stays correct when used outside that queryset.
        """
        cached = getattr(obj, "_occurrence_count", None)
        if cached is not None:
            return int(cached)
        return obj.occurrences.filter(is_deleted=False).count()

    def validate_task(self, value: Task) -> Task:
        # The rule is anchored to one template task for life — reject repointing.
        if self.instance is not None and value != self.instance.task:
            raise serializers.ValidationError("task cannot be changed after creation.")
        return value

    def validate_timezone(self, value: str) -> str:
        # Reject unknown IANA zones at write time so a bad value can't silently break
        # occurrence timing / the future morning-notification slot at generation time.
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise serializers.ValidationError("Unknown IANA timezone.") from exc
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Delegate the conditional-field invariants (weekly⇒weekday, monthly⇒dom,
        # end-type⇒date/count) to the model's clean() so the rules live in one place.
        if self.instance is not None:
            candidate = self.instance
            for key, val in attrs.items():
                setattr(candidate, key, val)
        else:
            candidate = TaskRecurrenceRule(**attrs)
        try:
            candidate.clean()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(serializers.as_serializer_error(exc)) from exc
        return attrs


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
            # task_ids are stringified for the children-map keys above; the FK
            # `_id` lookup is typed to want UUID objects, so convert back here.
            predecessor_id__in=[uuid.UUID(t) for t in task_ids],
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
    pending_count = serializers.SerializerMethodField()

    def get_short_id_display(self, obj: Sprint) -> str:
        """Return the human-facing form ``SP-XXXXXXXX`` of the short id."""
        return f"SP-{obj.short_id}" if obj.short_id else ""

    def get_pending_count(self, obj: Sprint) -> int:
        """Number of tasks pending acceptance in this sprint (ADR-0102 §5).

        Drives the "Forecast reflects accepted scope only — N items pending"
        copy. Prefers the ``pending_count`` annotation set on the list/detail
        queryset (SprintViewSet.get_queryset) to avoid an N+1; falls back to a
        single COUNT for callers that build the sprint outside that queryset
        (the activate/close/cancel actions construct the instance directly).
        """
        annotated = getattr(obj, "pending_count", None)
        if annotated is not None:
            return int(annotated)
        from trueppm_api.apps.projects.models import Task

        return Task.objects.filter(sprint_id=obj.pk, sprint_pending=True, is_deleted=False).count()

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

    def validate_target_milestone(self, value: Task | None) -> Task | None:
        """Bind the FK only to a milestone task in the sprint's own project.

        The provenance-aware promote/unbind endpoints (ADR-0106 §2) are the
        richer binding path, but ADR-0074 still allows setting this FK directly
        at planning time. Without this guard that direct write accepts any
        task pk — including one in another project (an IDOR) or a non-milestone
        task. Scope it to the sprint's project and require ``is_milestone``.
        """
        if value is None:
            return value
        # Project is in attrs on neither create nor update (it is set from the
        # nested URL in perform_create); resolve it from the instance on update
        # and from the view's ``project_pk`` kwarg on create.
        project_id: Any = self.instance.project_id if self.instance is not None else None
        if project_id is None:
            view = self.context.get("view")
            project_id = getattr(view, "kwargs", {}).get("project_pk") if view else None
        if project_id is not None and str(value.project_id) != str(project_id):
            raise serializers.ValidationError("Milestone must belong to the same project.")
        if not value.is_milestone:
            raise serializers.ValidationError("Target must be a milestone task.")
        return value

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
            "milestone_bound_by",
            "milestone_bound_at",
            "binding_committed_snapshot",
            "capacity_points",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
            "completion_ratio_points",
            "completion_ratio_tasks",
            "pending_count",
            "activated_at",
            "closed_at",
            "created_by",
            "created_at",
            "updated_at",
        ]
        # ADR-0106 §1: provenance is written only by the promote/unbind
        # endpoints — never via PATCH — so the FK ⇔ provenance invariant holds.
        read_only_fields = [
            "id",
            "server_version",
            "short_id",
            "short_id_display",
            "project",
            "state",
            "target_milestone_detail",
            "milestone_bound_by",
            "milestone_bound_at",
            "binding_committed_snapshot",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
            "completion_ratio_points",
            "completion_ratio_tasks",
            "pending_count",
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
    # ADR-0102 §7: how to dispose of tasks still pending acceptance at close.
    # 'carry' (default) keeps them pending in the carry-over target; 'reject'
    # removes them from the sprint. Closing is never blocked by pending items.
    pending_disposition = serializers.ChoiceField(choices=["carry", "reject"], default="carry")

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


class SprintScopeChangeSerializer(serializers.Serializer[dict[str, Any]]):
    """Read-only response shape for an accept/reject scope-change action (ADR-0102 §5).

    Mirrors the row dict TaskSerializer.get_sprint_scope_changes emits so the
    frontend has one shape for both the drawer list and the action responses.
    """

    id = serializers.UUIDField(read_only=True)
    task = serializers.UUIDField(source="task_id", read_only=True)
    sprint = serializers.UUIDField(source="sprint_id", read_only=True)
    item_name = serializers.CharField(read_only=True)
    status = serializers.CharField(read_only=True)
    goal_impact = serializers.BooleanField(read_only=True)
    added_at = serializers.DateTimeField(read_only=True)


class ScopeChangeBulkSerializer(serializers.Serializer[dict[str, Any]]):
    """Validate the body for the bulk accept/reject endpoints (ADR-0102 §5).

    ``ids`` is the list of SprintScopeChange UUIDs to act on; omit or pass an
    empty list to act on *all* PENDING scope changes in the sprint.
    """

    ids = serializers.ListField(
        child=serializers.UUIDField(), required=False, default=list, allow_empty=True
    )


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
        # Read the prefetch cache populated by the retro action's .prefetch_related(
        # "action_items") so this does not issue a per-retro COUNT query.
        return sum(1 for item in obj.action_items.all() if not item.is_deleted)

    def get_promoted_count(self, obj: SprintRetro) -> int:
        # Same: iterate the prefetch cache rather than issuing a filtered COUNT.
        return sum(
            1
            for item in obj.action_items.all()
            if not item.is_deleted and item.promoted_task_id is not None
        )

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
    # ADR-0102 §6: a pending injection SHOWS in My Work (the contributor needs to
    # see what is heading their way) with a muted "Pending acceptance" chip. The
    # me tree carries the read-state only — never accept/reject controls.
    sprint_pending = serializers.BooleanField(read_only=True)
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
    start_floor = serializers.SerializerMethodField()

    class Meta(ProjectSerializer.Meta):
        fields = [*ProjectSerializer.Meta.fields, "unresolved_assignee_count", "start_floor"]

    def get_start_floor(self, obj: Project) -> str:
        """First working day on or after ``start_date`` — the effective schedule
        floor (#884).

        The CPM engine floors every task's ``early_start`` here, so the web
        client uses this (not the literal ``start_date``) for its pre-emptive
        before-start prompt and its "snap to project start" target. Equal to
        ``start_date`` when the start is already a working day.
        """
        from trueppm_api.apps.projects.utilization import first_working_day

        return first_working_day(obj).isoformat()

    def get_unresolved_assignee_count(self, obj: Project) -> int:
        # Prefer the queryset annotation (ProjectViewSet.get_queryset on retrieve,
        # #821); fall back to a live COUNT when the serializer is used outside that
        # viewset (e.g. directly in tests or another caller).
        annotated = getattr(obj, "unresolved_assignee_count", None)
        if annotated is not None:
            return int(annotated)
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
            "project",
            "program",
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


# Stored-XSS / header-injection guard for attachment filenames (#892).
# Replicated from trueppm_api.apps.msproject.views._sanitize_filename (#816):
# kept in-app rather than imported to avoid a projects->msproject module-load
# coupling (msproject.views imports projects lazily; the reverse at module load
# would be fragile). Allow-list is [A-Za-z0-9._\- ()]; anything else is replaced.
_ATTACHMENT_FILENAME_BANNED = re.compile(r"[^A-Za-z0-9._\- ()]")


def _sanitize_attachment_filename(raw: str) -> str:
    """Return a safe stored form of an attachment filename.

    ``file_name`` is echoed back verbatim in API responses (and ultimately the
    UI / Content-Disposition headers on download), so an unsanitized value lets
    an uploader smuggle HTML (stored XSS) or CRLF (header injection) through the
    original filename. Strips path components, replaces anything outside the
    printable-ASCII allow-list — which removes ``<>"`` and control characters
    including ``\\r``/``\\n`` — collapses whitespace runs, caps at 255 chars, and
    falls back to ``"upload"`` so the stored value is never empty.
    """
    name = os.path.basename(raw or "")
    name = _ATTACHMENT_FILENAME_BANNED.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = name[:255]
    return name or "upload"


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

        # Sanitize the stored filename regardless of source (#892). file_name is
        # writable and echoed back verbatim, so both the client-supplied value
        # and the file.name fallback above are scrubbed of HTML/control chars
        # before they reach the DB and any download Content-Disposition header.
        if attrs.get("file_name"):
            attrs["file_name"] = _sanitize_attachment_filename(str(attrs["file_name"]))

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
        # Read the prefetch cache populated by TaskCommentViewSet.get_queryset()
        # (.prefetch_related("acknowledgements")) instead of issuing a new COUNT
        # query per comment row.
        return len(obj.acknowledgements.all())

    def get_reaction_count(self, obj: TaskComment) -> int:
        # Same: read the prefetch cache for "reactions".
        return len(obj.reactions.all())

    def get_has_my_acknowledgement(self, obj: TaskComment) -> bool:
        request = self.context.get("request")
        if request is None or not getattr(request.user, "is_authenticated", False):
            return False
        # Iterate the prefetch cache instead of issuing a per-comment
        # filter(user=…).exists() query.
        user_pk = request.user.pk
        return any(a.user_id == user_pk for a in obj.acknowledgements.all())

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


# ---------------------------------------------------------------------------
# Workflow settings — Phases (root tasks) and Custom Fields (#521)
# ---------------------------------------------------------------------------


# Compiled once at import time — the Workflow page edits a small set of phase
# rows, but Boards may issue this validator on every reorder PATCH.
_PHASE_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


class PhaseSerializer(serializers.ModelSerializer[Task]):
    """Read/write serializer for project phases.

    A *phase* in TruePPM is a WBS L1 (root-level) task: ``wbs_path`` matches
    ``^\\d+$``. This serializer exposes the subset of Task fields that the
    Workflow settings page edits (name, color) plus read-only context
    (task count, server_version) — no schedule fields, no status, no
    dependencies. Create/delete are routed through the viewset which also
    assigns ``wbs_path`` and short_id (create) or soft-deletes the row and
    its WBS subtree (delete).
    """

    task_count = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id",
            "name",
            "color",
            "priority_rank",
            "wbs_path",
            "task_count",
            "server_version",
        ]
        read_only_fields = ["id", "priority_rank", "wbs_path", "task_count", "server_version"]

    def get_task_count(self, obj: Task) -> int:
        """Number of non-deleted tasks in this phase, including the phase itself."""
        # ``descendants_count`` is annotated on the queryset by ``PhaseViewSet``.
        return int(getattr(obj, "descendants_count", 0))

    def validate_name(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("name must be a non-empty string.")
        if len(value) > 255:
            raise serializers.ValidationError("name must be ≤ 255 characters.")
        return value

    def validate_color(self, value: str | None) -> str | None:
        if not value:
            return None
        if not _PHASE_COLOR_RE.fullmatch(value):
            raise serializers.ValidationError("color must be a #RRGGBB hex string or null.")
        return value


class ProjectCustomFieldSerializer(serializers.ModelSerializer[ProjectCustomField]):
    """Read/write serializer for project custom field definitions (#521).

    Enforces:
    - per-project case-insensitive name uniqueness (DB-level constraint + a
      friendlier error here on create);
    - ``options`` non-empty list of unique ``{value, label}`` rows for
      SINGLE_SELECT / MULTI_SELECT, empty for every other type;
    - ``PROJECT_CUSTOM_FIELD_MAX`` cap per project (32) on create.

    Field type is immutable after create — switching a select field to text
    would orphan the option list semantically. Recreate the field instead.
    """

    class Meta:
        model = ProjectCustomField
        fields = [
            "id",
            "name",
            "field_type",
            "required",
            "options",
            "order",
            "server_version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "server_version", "created_at", "updated_at"]

    def validate_name(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("name must be a non-empty string.")
        if len(value) > 64:
            raise serializers.ValidationError("name must be ≤ 64 characters.")
        return value

    def validate_options(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            raise serializers.ValidationError("options must be a list.")
        normalized: list[dict[str, Any]] = []
        seen_values: set[str] = set()
        if len(value) > 50:
            raise serializers.ValidationError("options must contain at most 50 entries.")
        for entry in value:
            if not isinstance(entry, dict):
                raise serializers.ValidationError("each option must be an object.")
            opt_value = entry.get("value")
            opt_label = entry.get("label", opt_value)
            opt_color = entry.get("color")
            if not isinstance(opt_value, str) or not opt_value.strip():
                raise serializers.ValidationError("each option must have a non-empty value.")
            if len(opt_value) > 32:
                raise serializers.ValidationError("option value must be ≤ 32 characters.")
            if opt_value in seen_values:
                raise serializers.ValidationError(f"duplicate option value: {opt_value!r}")
            seen_values.add(opt_value)
            if not isinstance(opt_label, str) or len(opt_label) > 64:
                raise serializers.ValidationError("option label must be a string ≤ 64 chars.")
            if opt_color is not None and not (
                isinstance(opt_color, str) and _PHASE_COLOR_RE.fullmatch(opt_color)
            ):
                raise serializers.ValidationError(
                    "option color must be a #RRGGBB hex string or null."
                )
            normalized.append({"value": opt_value, "label": opt_label, "color": opt_color})
        return normalized

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # field_type is immutable after create — the model's PATCH path filters
        # it out, but reject it explicitly here so the API returns a 400 with a
        # clear message instead of silently ignoring the request.
        if self.instance is not None and "field_type" in self.initial_data:
            requested = self.initial_data["field_type"]
            if requested != self.instance.field_type:
                raise serializers.ValidationError(
                    {"field_type": "field_type is immutable after create."}
                )
        field_type = attrs.get(
            "field_type",
            getattr(self.instance, "field_type", None),
        )
        options = attrs.get("options", getattr(self.instance, "options", []))
        select_types = {CustomFieldType.SINGLE_SELECT, CustomFieldType.MULTI_SELECT}
        if field_type in select_types:
            if not options:
                raise serializers.ValidationError(
                    {"options": "options must be a non-empty list for select types."}
                )
        else:
            if options:
                raise serializers.ValidationError(
                    {"options": "options must be empty for non-select field types."}
                )
        return attrs

    def create(self, validated_data: dict[str, Any]) -> ProjectCustomField:
        project = validated_data["project"]
        existing = ProjectCustomField.objects.filter(project=project).count()
        if existing >= PROJECT_CUSTOM_FIELD_MAX:
            raise serializers.ValidationError(
                {
                    "detail": (
                        f"Project already has {PROJECT_CUSTOM_FIELD_MAX} custom fields "
                        "(the per-project cap). Delete or rename one before adding another."
                    )
                }
            )
        # Case-insensitive name uniqueness — surface a friendly error here instead
        # of leaning on the DB UniqueConstraint failure (less helpful message).
        name_ci = validated_data["name"].casefold()
        if any(
            f.name.casefold() == name_ci for f in ProjectCustomField.objects.filter(project=project)
        ):
            raise serializers.ValidationError(
                {"name": f"A custom field named {validated_data['name']!r} already exists."}
            )
        # Append by default — the client may reorder afterwards via PATCH.
        if validated_data.get("order", 0) == 0:
            from django.db.models import Max as _Max

            current_max = (
                ProjectCustomField.objects.filter(project=project).aggregate(m=_Max("order"))["m"]
                or 0
            )
            validated_data["order"] = current_max + 1
        return super().create(validated_data)

    def update(
        self, instance: ProjectCustomField, validated_data: dict[str, Any]
    ) -> ProjectCustomField:
        # Bump server_version on every write so optimistic-lock-aware clients
        # (the Workflow drag-to-reorder hook) can detect concurrent edits.
        instance.server_version = (instance.server_version or 0) + 1
        return super().update(instance, validated_data)
