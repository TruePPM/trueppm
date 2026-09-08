"""DRF serializers for the resources app."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_email
from rest_framework import serializers

from trueppm_api.apps.resources.models import (
    ProjectResource,
    Resource,
    ResourceSkill,
    Skill,
    TaskResource,
    TaskSkillRequirement,
)
from trueppm_api.apps.resources.services import MAX_ASSIGNMENT_UNITS, MIN_ASSIGNMENT_UNITS
from trueppm_api.apps.workspace.permissions import is_workspace_admin


class SkillSerializer(serializers.ModelSerializer[Skill]):
    """Read/write serializer for the org-level skill catalog.

    Normalises name to lower-case + stripped on write to prevent duplicate
    entries ("React" vs "react"). Returns the existing row (not a 201) when
    the normalized_name already exists — callers should handle 200 vs 201.
    """

    class Meta:
        model = Skill
        fields = ["id", "server_version", "name", "normalized_name", "category"]
        read_only_fields = ["id", "server_version", "normalized_name"]

    def validate_name(self, value: str) -> str:
        return value.strip()

    def create(self, validated_data: dict[str, str]) -> Skill:
        normalized = validated_data["name"].casefold()
        validated_data["normalized_name"] = normalized
        skill, _ = Skill.objects.get_or_create(
            normalized_name=normalized,
            defaults={
                "name": validated_data["name"],
                "category": validated_data.get("category", ""),
            },
        )
        return skill


class ResourceSkillSerializer(serializers.ModelSerializer[ResourceSkill]):
    """Read/write serializer for skill tags on a resource."""

    skill_name = serializers.CharField(source="skill.name", read_only=True)

    class Meta:
        model = ResourceSkill
        fields = ["id", "server_version", "resource", "skill", "skill_name", "proficiency"]
        read_only_fields = ["id", "server_version", "skill_name"]


class _BlankableEmailField(serializers.CharField):
    """Optional email field whose OpenAPI schema is a plain string.

    ``Resource.email`` is ``EmailField(blank=True)``: an un-emailed resource
    serializes as ``""``, which is not a valid ``email``-format value and fails
    response-schema conformance (#2127). A stock ``EmailField`` carries an
    ``EmailValidator`` that drf-spectacular reads to stamp ``format: email`` on
    the schema (via ``_insert_field_validators``), so subclassing it — or
    overriding the schema — cannot drop the format. This is a ``CharField`` (no
    validator to enrich from) that instead validates the address inline for
    non-blank input, so real emails are still rejected when malformed while a
    blank value stays a conformant plain string.
    """

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("max_length", 254)
        super().__init__(**kwargs)

    def to_internal_value(self, data: Any) -> str:
        value: str = super().to_internal_value(data)
        if value:
            try:
                validate_email(value)
            except DjangoValidationError as exc:
                raise serializers.ValidationError("Enter a valid email address.") from exc
        return value


class ResourceSerializer(serializers.ModelSerializer[Resource]):
    """Read/write serializer for named resources (people, equipment, or material).

    calendar is optional — when null the resource inherits the project's calendar
    for utilization calculations. skills is read-only nested; writes use
    /api/v1/resource-skills/ directly (ADR-0033, mirrors the assignments pattern).
    is_me is a request-scoped boolean — true when the resource is linked to the
    current user (Resource.user FK or, for legacy rows, an exact email match).
    Drives the "My tasks" Board filter (#198) without leaking other users' IDs.

    Email exposure is gated on the workspace ADMIN role (#891, mirrors #815's
    UserSearchView fix; raised from org-admin in #3569): the resource catalog is
    readable by any authenticated user, so echoing ``email`` on every row let a
    single low-privilege account paginate the catalog to harvest the whole org's
    email list. ``to_representation`` strips ``email`` for every caller below
    workspace ADMIN, while still letting the caller see their own email (is_me) so
    self-view is unaffected.
    """

    skills = ResourceSkillSerializer(many=True, read_only=True)
    is_me = serializers.SerializerMethodField()
    # ``Resource.email`` is ``EmailField(blank=True)``: an un-emailed resource
    # serializes as ``""``, which is not a valid ``email``-format string and fails
    # response-schema conformance (#2127). Advertise a plain string schema (the
    # write-side ``EmailField`` still validates real input) so a blank email is a
    # valid response (see _BlankableEmailField for why a stock EmailField cannot
    # drop the format).
    email = _BlankableEmailField(required=False, allow_blank=True)

    class Meta:
        model = Resource
        fields = [
            "id",
            "server_version",
            "name",
            "email",
            "job_role",
            "calendar",
            "max_units",
            "skills",
            "is_me",
        ]
        read_only_fields = ["id", "server_version", "skills", "is_me"]

    def get_is_me(self, obj: Resource) -> bool:
        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return False
        if obj.user_id is not None and obj.user_id == request.user.pk:
            return True
        # Email fallback for legacy resources whose user FK has not been set.
        # iexact-style comparison via casefold to match the queryset filter.
        if obj.user_id is None and obj.email:
            user_email = (getattr(request.user, "email", "") or "").strip().lower()
            return bool(user_email) and obj.email.strip().lower() == user_email
        return False

    def _caller_is_workspace_admin(self) -> bool:
        """Return True if the requesting user holds workspace ADMIN or above.

        Mirrors :class:`~trueppm_api.apps.workspace.permissions.IsWorkspaceAdminStrict`,
        the gate on this viewset's sibling actions, via the shared
        :func:`~trueppm_api.apps.workspace.permissions.is_workspace_admin`. Used to
        gate email exposure in ``to_representation`` (#891).

        **Raised from the org-admin derivation in #3569.** This used to ask
        ``IsOrgAdmin``'s question — ADMIN+ on at least one project — which any
        authenticated account satisfies after a single ``POST /projects/``, since
        nothing gates project creation and the creator is made Owner. That made the
        #891 org-wide email-harvest control decorative: two requests bought every
        address in the catalog. ``WorkspaceMembership`` is a **stored** grant, handed
        out only by an existing workspace admin or by SSO provisioning, so it is not
        reachable that way. Self-view is unaffected — ``to_representation``
        short-circuits on ``is_me`` before reaching this check, so a contributor
        still sees their own address.

        The result is memoized on the serializer instance: the role is request-scoped
        and constant across rows, so a list serialization must not re-derive it per
        row (N+1, #perf). The cache lives for the lifetime of one serializer instance
        (one request).
        """
        cached: bool | None = getattr(self, "_workspace_admin_cache", None)
        if cached is not None:
            return cached
        request = self.context.get("request")
        result = is_workspace_admin(getattr(request, "user", None))
        self._workspace_admin_cache = result
        return result

    def to_representation(self, instance: Resource) -> dict[str, object]:
        """Strip ``email`` below workspace ADMIN to prevent org-wide harvest (#891).

        The catalog is readable by any authenticated user; only a workspace admin
        (#3569 — previously any org admin) and the resource's own user (self-view)
        should see email. For everyone else the field is dropped from the payload
        entirely rather than nulled, so it cannot be reconstructed.

        Self-rows (``is_me``) short-circuit before the role check, so a contributor
        viewing their own row still sees their own address and never pays for the
        check (#perf); the role is otherwise memoized across rows.
        """
        data = super().to_representation(instance)
        if "email" not in data:
            return data
        if data.get("is_me") or self._caller_is_workspace_admin():
            return data
        data.pop("email", None)
        return data


class ProjectResourceSerializer(serializers.ModelSerializer[ProjectResource]):
    """Read/write serializer for project roster membership.

    resource_detail is read-only expanded; writes use the resource UUID FK.
    effective_max_units is computed: units_override if set, else resource.max_units.
    """

    resource_detail = ResourceSerializer(source="resource", read_only=True)
    effective_max_units = serializers.SerializerMethodField()

    class Meta:
        model = ProjectResource
        fields = [
            "id",
            "server_version",
            "project",
            "resource",
            "resource_detail",
            "role_title",
            "units_override",
            "effective_max_units",
            "notes",
        ]
        read_only_fields = ["id", "server_version", "resource_detail", "effective_max_units"]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # #1711 BOLA guard: the writable ``project`` FK must not relocate an
        # existing roster row to another project. ``perform_update`` enforces the
        # SCHEDULER+ floor only against the row's *current* project, so without
        # this a Scheduler on project A could PATCH ``project`` to a project B
        # they cannot manage (a cross-project write-IDOR). A roster row never
        # legitimately changes project — mirrors AcceptanceCriterionSerializer.
        if (
            self.instance is not None
            and "project" in attrs
            and attrs["project"].pk != self.instance.project_id
        ):
            raise serializers.ValidationError(
                {"project": "A roster entry cannot be moved to another project."}
            )
        return attrs

    def get_effective_max_units(self, obj: ProjectResource) -> str:
        value = obj.units_override if obj.units_override is not None else obj.resource.max_units
        return f"{value:.2f}"


class TaskSkillRequirementSerializer(serializers.ModelSerializer[TaskSkillRequirement]):
    """Read/write serializer for skill requirements on a task."""

    skill_name = serializers.CharField(source="skill.name", read_only=True)

    class Meta:
        model = TaskSkillRequirement
        fields = ["id", "server_version", "task", "skill", "skill_name", "min_proficiency"]
        read_only_fields = ["id", "server_version", "skill_name"]


class TaskResourceSerializer(serializers.ModelSerializer[TaskResource]):
    """Read/write serializer for task-resource assignments.

    units is a decimal fraction of full capacity (e.g. 0.5 = 50%). Validated
    to the range [0.01, 2.0] so accidental 0 or runaway values are caught early.
    """

    resource_name = serializers.CharField(source="resource.name", read_only=True)

    class Meta:
        model = TaskResource
        fields = ["id", "task", "resource", "resource_name", "units"]
        read_only_fields = ["id", "resource_name"]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # #1711 BOLA guard: the writable ``task`` FK must not relocate an existing
        # assignment to another task. ``perform_update`` enforces the SCHEDULER+
        # floor only against the assignment's *current* task/project, so without
        # this a Scheduler on project A could PATCH ``task`` to a project-B task
        # they cannot manage (a cross-project write-IDOR). An assignment never
        # legitimately moves tasks — mirrors AcceptanceCriterionSerializer.
        if (
            self.instance is not None
            and "task" in attrs
            and attrs["task"].pk != self.instance.task_id
        ):
            raise serializers.ValidationError(
                {"task": "An assignment cannot be moved to another task."}
            )
        return attrs

    def validate_units(self, value: Decimal) -> Decimal:
        """Enforce that units stay within the valid assignment range.

        0.01 (1%) is the minimum meaningful allocation; 2.0 (200%) is the
        maximum to catch data-entry errors while still allowing overtime.

        The bounds live in ``resources.services`` because a second assignment-write
        path now exists — the inline ``owners`` field on task writes (ADR-0774) — and
        two allocation ranges that could drift apart is exactly the kind of split this
        field was added to avoid.
        """
        if value < MIN_ASSIGNMENT_UNITS or value > MAX_ASSIGNMENT_UNITS:
            raise serializers.ValidationError("units must be between 0.01 and 2.0 (1% to 200%)")
        return value


class ResourceAssignmentSerializer(serializers.ModelSerializer[TaskResource]):
    """Read-only projection of one resource's task assignments across all projects.

    Backs the org catalog's "Assignments" panel (#2047, ADR-0499): it answers the
    resource manager's daily question "what is this person working on / are they
    overloaded?". Purely read-only — assignment *writes* still go through
    ``TaskResourceSerializer`` on the project-nested route. It carries the task and
    project *names* (which ``TaskResourceSerializer`` deliberately omits), so the
    action that serves it is gated on ``IsWorkspaceAdminStrict`` rather than the base
    catalog read gate — those names are project-scoped confidential data.

    ADR-0499 chose ``IsOrgAdmin`` for that gate and said it "is what makes this
    safe". It was not: the org-admin derivation is reachable by any account that
    creates a throwaway project, so the gate admitted everyone (#3569). Raised to
    workspace admin; a member who needs only their *own* projects' view reads
    ``/task-resources/?resource=``, which is membership-scoped and unchanged.
    """

    task = serializers.UUIDField(source="task_id", read_only=True)
    task_name = serializers.CharField(source="task.name", read_only=True)
    project = serializers.UUIDField(source="task.project_id", read_only=True)
    project_name = serializers.CharField(source="task.project.name", read_only=True)
    status = serializers.CharField(source="task.status", read_only=True)
    percent_complete = serializers.FloatField(source="task.percent_complete", read_only=True)

    class Meta:
        model = TaskResource
        fields = [
            "id",
            "task",
            "task_name",
            "project",
            "project_name",
            "status",
            "percent_complete",
            "units",
        ]
        read_only_fields = fields
