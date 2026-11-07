"""DRF serializers for the resources app."""

from __future__ import annotations

from collections.abc import Mapping
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


def _active_resource_field() -> serializers.PrimaryKeyRelatedField[Resource]:
    """A writable ``resource`` FK that refuses a deactivated resource (#3572).

    The read side of deactivation is ``ResourceScopedManager.active()``; this is
    its write-side counterpart, and without it the two halves disagree in a way
    the roster cascade made newly reachable.

    Two distinct problems, only one of which the database catches. Deactivation
    now leaves ``ProjectResource`` rows soft-deleted rather than absent, and
    ``uniq_project_resource_project_resource`` is unconditional, so a POST
    re-adding a deactivated person to a roster collides with a row the caller's
    own ``.active()`` read cannot show them. DRF's auto-generated
    ``UniqueTogetherValidator`` resolves through the still-unfiltered
    ``_default_manager``, so that lands as a 400 rather than a 500 — but a
    "must make a unique set" complaint about an invisible row is not a usable
    answer. **Nothing at all** catches the other two: an assignment or a skill
    tag written onto a deactivated resource persists happily and is then
    invisible to every read, including its own author's.

    Refusing the resource outright is both the correct semantics (a deactivated
    person is off the team) and the narrower fix — one error, on the field that
    is actually wrong.

    Restoring the resource is what makes these writes available again.
    """
    return serializers.PrimaryKeyRelatedField(queryset=Resource.objects.filter(is_deleted=False))


class SkillSerializer(serializers.ModelSerializer[Skill]):
    """Read/write serializer for the org-level skill catalog.

    Normalises name to lower-case + stripped on write to prevent duplicate
    entries ("React" vs "react"). Returns the existing row (not a 201) when
    the normalized_name already exists — the status code, not the body,
    distinguishes the two (200 vs 201).
    """

    # This docstring is published verbatim as the ``Skill`` component description in
    # docs/api/openapi.json, so it stays client-facing: ``created`` below is a
    # server-side attribute an API consumer can never observe.

    #: Whether the last ``create()`` inserted (True) or de-duplicated (False).
    #: The flag has to travel out of ``create()`` because it cannot be recovered
    #: from the saved row afterwards: an inserted skill and a de-dup hit are
    #: indistinguishable by inspection (#3573 — the caller used to probe
    #: ``server_version=0``, which ``VersionedModel.save`` never leaves behind).
    #: Only meaningful after a ``save()`` that went through ``create()``: bound with
    #: an ``instance``, ``save()`` takes the ``update()`` branch and this keeps the
    #: ``False`` default, which would read as a de-dup hit.
    created: bool = False

    class Meta:
        model = Skill
        fields = ["id", "server_version", "name", "normalized_name", "category"]
        read_only_fields = ["id", "server_version", "normalized_name"]

    def validate_name(self, value: str) -> str:
        return value.strip()

    def create(self, validated_data: dict[str, str]) -> Skill:
        normalized = validated_data["name"].casefold()
        validated_data["normalized_name"] = normalized
        skill, created = Skill.objects.get_or_create(
            normalized_name=normalized,
            defaults={
                "name": validated_data["name"],
                "category": validated_data.get("category", ""),
            },
        )
        self.created = created
        return skill


class ResourceSkillSerializer(serializers.ModelSerializer[ResourceSkill]):
    """Read/write serializer for skill tags on a resource."""

    resource = _active_resource_field()
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
    self-view is unaffected. ``validate`` mirrors the same floor on the write side
    (#3625): setting ``email`` below workspace ADMIN is rejected outright, closing
    the asymmetry where a fresh account could overwrite an address it could not
    read back.
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
    # Hourly cost rate in the workspace currency (ADR-1324, #754). Read-only here: the
    # one write path is ``POST /resources/{id}/rate/``, whose dry-run preview and save
    # share one computation. A salary proxy — present only for a workspace ADMIN+
    # caller (to_representation); there is deliberately no ``is_me`` carve-out.
    cost_rate = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        read_only=True,
        allow_null=True,
        required=False,
        help_text=(
            "Hourly cost in the workspace currency, or null when unrated. Present only "
            "for workspace Admins; set it with POST /resources/{id}/rate/."
        ),
    )

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
            "cost_rate",
            "skills",
            "is_me",
        ]
        read_only_fields = ["id", "server_version", "skills", "is_me", "cost_rate"]

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
        # ``cost_rate`` (ADR-1324 §4, leak paths L1/L2): workspace ADMIN only, and no
        # self-view exception — a rate is the organisation's cost of a person, not
        # the person's own data, and a stored workspace role is the only principal
        # that is not self-grantable (#3569). Nested ``resource_detail`` on the roster
        # serializer inherits this because it reuses this class with the same context.
        if "cost_rate" in data and not self._caller_is_workspace_admin():
            data.pop("cost_rate")
        if "email" not in data:
            return data
        if data.get("is_me") or self._caller_is_workspace_admin():
            return data
        data.pop("email", None)
        return data

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        """Reject writing ``email`` below workspace ADMIN (#3625).

        #3569 raised *reading* ``email`` to the stored workspace ADMIN role (see
        ``to_representation`` above), but left *writing* it on ``IsOrgAdmin`` —
        ``ResourceViewSet.get_permissions`` falls through to that for
        create/update, and the org-admin derivation is self-grantable: project
        creation is ungated and ``perform_create`` makes the caller Owner. That let
        a fresh account overwrite any catalog row's email in two requests while
        being unable to read the value it replaced — silent corruption, self-view
        spoofing via ``get_is_me``'s legacy email fallback, and "My Work"
        attribution transfer via ``_filter_tasks_mine``
        (``trueppm_api.apps.projects.views``).

        Reuses ``_caller_is_workspace_admin`` — the same check ``to_representation``
        gates on — so the read and write floors for this field cannot drift apart
        again. Deliberately no ``is_me`` carve-out here (unlike the read side):
        that fallback is exactly the mechanism this gate closes for a writer below
        ADMIN, so exempting a caller's own address would reopen it.
        """
        # A read-only field is silently ignored by DRF; for a rate that would read as
        # a saved change. Refuse it and name the endpoint that does write it.
        initial = getattr(self, "initial_data", None)
        if isinstance(initial, Mapping) and "cost_rate" in initial:
            raise serializers.ValidationError(
                {"cost_rate": "Set a resource's rate with POST /api/v1/resources/{id}/rate/."}
            )
        if "email" in attrs and not self._caller_is_workspace_admin():
            raise serializers.ValidationError(
                {"email": "Only a workspace admin may set a resource's email address."}
            )
        return attrs


class ProjectResourceSerializer(serializers.ModelSerializer[ProjectResource]):
    """Read/write serializer for project roster membership.

    resource_detail is read-only expanded; writes use the resource UUID FK.
    effective_max_units is computed: units_override if set, else resource.max_units.
    """

    resource = _active_resource_field()
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
        """This resource's capacity on this project.

        The roster's ``units_override`` when one is set — including ``0``, which
        means rostered here and holding no capacity here — otherwise the resource's
        catalog-wide ``max_units``. Rendered to two decimal places. This is the
        figure every per-project capacity read measures against (#3574).
        """
        return f"{obj.effective_max_units:.2f}"


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

    resource = _active_resource_field()
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


class ResourceRateSerializer(serializers.Serializer[dict[str, Any]]):
    """Body for ``POST /resources/{id}/rate/`` (ADR-1324 §5)."""

    cost_rate = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        min_value=Decimal("0"),
        allow_null=True,
        help_text="New hourly rate in the workspace currency; null clears it (unrated).",
    )
    dry_run = serializers.BooleanField(
        default=True,
        help_text=(
            "true (default) previews the re-cost without saving; false saves the rate. "
            "Both return the same shape, computed the same way."
        ),
    )


class ResourceRateProjectSerializer(serializers.Serializer[dict[str, Any]]):
    """How one project's actual cost moves under the new rate."""

    project_id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)
    hours = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    actual_before = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    actual_after = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    delta = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    cost_computable_before = serializers.BooleanField(read_only=True)
    cost_computable_after = serializers.BooleanField(read_only=True)


class ResourceRateResponseSerializer(serializers.Serializer[dict[str, Any]]):
    """Response for ``POST /resources/{id}/rate/`` — identical for preview and save.

    Changing a rate re-costs every past time entry for the resource (one current rate,
    no history), so ``projects`` lists each project whose actual cost moves. The
    preview's numbers equal the save's by construction (ADR-1324 §5).
    """

    resource_id = serializers.UUIDField(read_only=True)
    currency = serializers.CharField(read_only=True)
    cost_rate_before = serializers.DecimalField(
        max_digits=12, decimal_places=2, read_only=True, allow_null=True
    )
    cost_rate_after = serializers.DecimalField(
        max_digits=12, decimal_places=2, read_only=True, allow_null=True
    )
    dry_run = serializers.BooleanField(read_only=True)
    as_of = serializers.DateTimeField(read_only=True)
    projects = ResourceRateProjectSerializer(many=True, read_only=True)
    total_hours = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    total_delta = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
