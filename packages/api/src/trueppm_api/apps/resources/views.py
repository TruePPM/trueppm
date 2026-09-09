"""DRF ViewSets for the resources app."""

from __future__ import annotations

from collections.abc import Callable
from decimal import Decimal
from typing import Any, cast

from django.db import models, transaction
from django.db.models import DateField, ProtectedError, QuerySet
from django.db.models.functions import Coalesce
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
)
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.throttling import UserRateThrottle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    IsOrgAdmin,
    IsOrgScheduler,
    IsProjectMember,
    IsProjectNotArchived,
    ProjectScopedViewSet,
    _membership_role,
    assert_project_not_archived,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Project, Task, TaskActivityEventType
from trueppm_api.apps.projects.utilization import (
    Allocation,
    peak_concurrent_units,
    resolve_working_calendar,
)
from trueppm_api.apps.resources.capacity import resource_effective_units
from trueppm_api.apps.resources.models import (
    Proficiency,
    ProjectResource,
    Resource,
    ResourceSkill,
    Skill,
    TaskResource,
    TaskSkillRequirement,
)
from trueppm_api.apps.resources.serializers import (
    ProjectResourceSerializer,
    ResourceAssignmentSerializer,
    ResourceSerializer,
    ResourceSkillSerializer,
    SkillSerializer,
    TaskResourceSerializer,
    TaskSkillRequirementSerializer,
)
from trueppm_api.apps.resources.services import (
    ensure_project_resource,
    record_assignment_event,
    task_is_summary,
)
from trueppm_api.apps.scheduling.services import enqueue_recalculate as _enqueue_recalculate
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdminStrict, is_workspace_admin
from trueppm_api.core.protect_conflict import protected_error_response

# Shared 404 detail — matches DRF's default NotFound detail so a missing or
# soft-deleted lookup reads identically across the resource actions below.
_NOT_FOUND_DETAIL = "Not found."

#: Refusal shipped when a skill is still tagged on a resource or required by a task.
#: Both FKs into ``Skill`` are ``on_delete=PROTECT`` (``ResourceSkill.skill``,
#: ``TaskSkillRequirement.skill``) so deleting a catalog entry cannot silently strip
#: the skill from every resource that carries it or every task that requires it.
#: Django reports the refusal as ``ProtectedError``, which is not an ``APIException``
#: and escaped as an unhandled 500 until #2364.
_SKILL_IN_USE_DETAIL = "This skill is still in use and cannot be deleted."

# ---------------------------------------------------------------------------
# Skill catalog
# ---------------------------------------------------------------------------


def _skill_reference_describer(user: Any) -> Callable[[models.Model], dict[str, str]]:
    """Build a describer that names a skill's blockers without leaking task names.

    ``ResourceSkill`` and ``TaskSkillRequirement`` are join tables the user never
    sees and which have no ``name`` of their own; echoing them back would produce a
    list of opaque UUIDs. What the caller can act on is the resource to retag or the
    task whose requirement to drop.

    **Task names are membership-scoped, and this endpoint's gate is not.**
    ``IsOrgScheduler`` only proves the caller holds SCHEDULER+ on *some* project, so
    a naive describer would let anyone with one project turn repeated delete attempts
    into an oracle for task names across every project in the install — and a task
    name describes actual work, unlike a resource name. Tasks in projects the caller
    is not a member of are therefore reported by type and id only, with the name
    withheld; ``reference_count`` still reflects the true total, so the refusal stays
    honest about how much is blocking even when it cannot say what.

    Resource names are *not* filtered: the resource catalog is org-shared and already
    readable by any authenticated user (see :class:`ResourceViewSet`), so naming one
    here discloses nothing the caller could not list directly.
    """
    visible_project_ids = set(
        ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
            "project_id", flat=True
        )
    )

    def describe(obj: models.Model) -> dict[str, str]:
        if isinstance(obj, ResourceSkill):
            return {"type": "resource", "id": str(obj.resource_id), "name": obj.resource.name}
        if isinstance(obj, TaskSkillRequirement):
            entry = {"type": "task", "id": str(obj.task_id)}
            if obj.task.project_id in visible_project_ids:
                entry["name"] = obj.task.name
            return entry
        return {"type": obj._meta.model_name or "", "id": str(obj.pk), "name": str(obj)}

    return describe


@extend_schema_view(
    create=extend_schema(
        summary="Create a skill, or return the existing one",
        description=(
            "Adds a skill to the org-level catalog.\n\n"
            "Names are de-duplicated case-insensitively on `normalized_name`, so "
            "posting a name that already exists is not an error: the existing row is "
            "returned with `200` instead of `201`. Callers that need to know whether "
            "they added the skill must read the status code — the body is identical "
            "either way."
        ),
        responses={
            200: OpenApiResponse(
                response=SkillSerializer,
                description=(
                    "A skill with this normalized name already existed; it is returned unchanged."
                ),
            ),
            201: OpenApiResponse(
                response=SkillSerializer,
                description="Skill created.",
            ),
        },
    ),
    destroy=extend_schema(
        summary="Delete a skill",
        description=(
            "Deletes a skill from the org-level catalog.\n\n"
            "A skill that is still tagged on a resource or required by a task cannot "
            "be deleted — removing it would silently strip the tag from every resource "
            "that carries it and drop the requirement from every task that needs it. "
            "That is refused with `409`, and the body names the resources and tasks "
            "still using it so the caller can detach them first."
        ),
        responses={
            204: OpenApiResponse(description="Skill deleted."),
            409: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Skill is still tagged on a resource or required by a task. Body "
                    "carries `reference_count` and a `references` sample naming the "
                    "resources and tasks to detach first."
                ),
            ),
        },
    ),
)
class SkillViewSet(IdempotencyMixin, viewsets.ModelViewSet[Skill]):
    """CRUD for the org-level skill catalog.

    Any authenticated user may read. Writes require ``SCHEDULER+`` on at least
    one project (#254 — IsProjectMember alone would not gate writes here
    because the route is not project-nested). Skill creation normalises the
    name and returns the existing row if the normalised name already exists
    (de-dup by normalized_name unique constraint).
    """

    queryset = Skill.objects.filter(is_deleted=False).order_by("name")
    serializer_class = SkillSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name", "category"]
    ordering_fields = ["name"]

    def get_permissions(self) -> list[BasePermission]:
        """Read open to any authenticated user; writes require SCHEDULER+ on any project."""
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgScheduler()]

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Delete the skill, or 409 when a resource or task still uses it.

        Overrides ``destroy`` rather than ``perform_destroy`` because the refusal body
        carries an integer ``reference_count``, and DRF coerces every value in an
        ``APIException`` detail to ``ErrorDetail`` (a ``str`` subclass) — raising would
        ship the count as ``"3"``. Returning is safe: ``ProtectedError`` is raised
        while the collector walks the FKs, *before* any DELETE is issued, so there is
        no partial state for ``ATOMIC_REQUESTS`` to roll back.
        """
        instance = self.get_object()
        try:
            instance.delete()
        except ProtectedError as exc:
            return protected_error_response(
                exc.protected_objects,
                detail=_SKILL_IN_USE_DETAIL,
                code="skill_in_use",
                describe=_skill_reference_describer(request.user),
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        """Create the skill (201), or return the existing row on a de-dup hit (200).

        The status comes from the ``get_or_create`` flag the serializer records,
        not from an inspection of the saved row. Nothing on a saved ``Skill``
        distinguishes a fresh insert from a de-dup hit, so any re-derived flag is
        a guess: this used to probe ``server_version=0``, which
        ``VersionedModel.save`` never leaves behind (it stamps 1 on insert), so
        the endpoint answered 200 for every create (#3573).
        """
        # ``get_serializer`` is typed as ``BaseSerializer[Skill]``; this viewset
        # never swaps ``serializer_class``, so the concrete type is exact.
        serializer = cast("SkillSerializer", self.get_serializer(data=request.data))
        serializer.is_valid(raise_exception=True)
        skill = serializer.save()
        http_status = status.HTTP_201_CREATED if serializer.created else status.HTTP_200_OK
        return Response(
            self.get_serializer(skill).data,
            status=http_status,
            headers=self.get_success_headers(serializer.data),
        )


# ---------------------------------------------------------------------------
# Resource skills
# ---------------------------------------------------------------------------


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="resource",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to skill tags for this resource.",
            ),
        ],
    ),
)
class ResourceSkillViewSet(IdempotencyMixin, viewsets.ModelViewSet[ResourceSkill]):
    """CRUD for skill tags on resources.

    Read: any authenticated user (resource catalog is org-shared).
    Write: SCHEDULER+ on at least one active project (``IsOrgScheduler``). The
    route is not project-nested so ``IsProjectMember`` alone would not gate writes.
    The docstring here claimed an ADMIN+ floor via ``IsOrgAdmin``; the code has
    returned ``IsOrgScheduler`` since #254. Corrected to the code, not the reverse
    — skill tagging is curation, which is what the SCHEDULER floor is for.
    """

    serializer_class = ResourceSkillSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = ResourceSkill.objects.active().select_related("skill").filter(is_deleted=False)

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgScheduler()]

    def get_queryset(self) -> QuerySet[ResourceSkill]:
        # ``.active()`` (#3572): the resource row itself is admin-only once
        # deactivated (``?include_deleted=true`` on the catalog), so listing its
        # skill tags to every authenticated user leaked the tail of a record the
        # catalog had already withdrawn. Admins reach a deactivated resource's
        # skills through the catalog's expanded ``skills`` instead.
        qs = ResourceSkill.objects.active().select_related("skill").filter(is_deleted=False)
        resource_id = self.request.query_params.get("resource")
        if resource_id:
            qs = qs.filter(resource_id=resource_id)
        return qs


# ---------------------------------------------------------------------------
# Project roster
# ---------------------------------------------------------------------------


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="project",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter the roster to this project.",
            ),
        ],
    ),
    create=extend_schema(
        responses={
            201: ProjectResourceSerializer,
            403: OpenApiResponse(
                description=(
                    "Caller lacks the Resource Manager role on the target project, or that "
                    "project is archived (#3414). The project is named only in the request "
                    "body here, so the refusal comes from the view rather than a permission "
                    "class — the status and body are the same either way."
                )
            ),
        },
    ),
    destroy=extend_schema(
        parameters=[
            OpenApiParameter(
                name="force",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When 'true', cascade-delete the resource's TaskResource rows on "
                    "this project and trigger a CPM recalculation. Without it, a 409 "
                    "is returned if the resource has live task assignments."
                ),
            ),
        ],
    ),
)
class ProjectResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[ProjectResource]):
    """CRUD for a project's resource roster.

    Read: any project member (VIEWER+).
    Write: SCHEDULER+ on the project.
    Delete: SCHEDULER+; with ?force=true cascades to TaskResource rows and
    triggers CPM recalculation (ADR-0027). Without force=true returns 409 if
    live task assignments exist.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, CanAssignResource, IsProjectNotArchived]
    serializer_class = ProjectResourceSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = (
        ProjectResource.objects.active()
        .select_related("resource", "resource__calendar")
        .prefetch_related("resource__skills__skill")
    )

    def get_queryset(self) -> QuerySet[ProjectResource]:
        user_pk = self.request.user.pk
        assert user_pk is not None
        member_project_ids = ProjectMembership.objects.filter(
            user_id=user_pk, is_deleted=False
        ).values_list("project_id", flat=True)
        # ``.active()`` (#3572) is ``is_deleted=False`` on the roster row AND on the
        # resource behind it. The roster row is the surface an off-boarding is
        # measured on: a deactivated person left the catalog but kept a full
        # ``resource_detail`` on every project's Team tab.
        qs = (
            ProjectResource.objects.active()
            .select_related("resource", "resource__calendar")
            .prefetch_related("resource__skills__skill")
            .filter(project_id__in=member_project_ids)
            .order_by("resource__name")
        )
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    def perform_create(self, serializer: BaseSerializer[ProjectResource]) -> None:
        """Verify SCHEDULER+ role and a live project before adding to roster.

        The archived check is here, not left to ``IsProjectNotArchived`` on the class,
        because this route is top-level (``POST /api/v1/project-resources/``) and names
        the project only in the request BODY (#3414). ``has_permission`` finds no
        ``project_pk`` kwarg and stands down, and DRF never calls
        ``has_object_permission`` on a create — there is no object yet. The declared
        permission class therefore reads as gating in review and enforces nothing on
        exactly the request that creates a row, which is how roster adds (and the CPM
        recalculation they enqueue) reached archived projects.
        """
        project = serializer.validated_data.get("project")
        if project:
            role = _membership_role(self.request, str(project.pk))
            if role is None or role < Role.SCHEDULER:
                raise PermissionDenied(
                    "You need at least Resource Manager role to manage the roster."
                )
            assert_project_not_archived(project.pk)
        instance = serializer.save()

        # Mirror the destroy() path: a roster add is invisible to connected
        # clients until a refetch without this broadcast.
        project_id = str(instance.project_id)
        resource_id = str(instance.resource_id)

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            broadcast_board_event(
                project_id,
                "roster_changed",
                {"resource_id": resource_id},
            )

        transaction.on_commit(_on_commit)

    def perform_update(self, serializer: BaseSerializer[ProjectResource]) -> None:
        """Persist an allocation/notes edit and broadcast the roster change.

        The SCHEDULER+ floor for detail mutations is enforced declaratively by
        ``CanAssignResource.has_object_permission``; this hook only adds the
        missing real-time signal (#1359) so peers see an allocation or note
        change without a manual refetch — mirroring perform_create/destroy.
        """
        instance = serializer.save()

        project_id = str(instance.project_id)
        resource_id = str(instance.resource_id)

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            broadcast_board_event(
                project_id,
                "roster_changed",
                {"resource_id": resource_id},
            )

        transaction.on_commit(_on_commit)

    def destroy(self, request: Request, *args: object, **kwargs: object) -> Response:
        """Remove a resource from the roster.

        If the resource has live TaskResource rows on this project and
        force=true is not passed, returns 409. With force=true, cascades the
        deletion and triggers CPM recalculation for affected tasks.
        """
        instance: ProjectResource = self.get_object()
        project_id = str(instance.project_id)
        resource_id = instance.resource_id

        live_assignments = list(
            TaskResource.objects.filter(
                resource_id=resource_id,
                task__project_id=project_id,
                task__is_deleted=False,
            ).select_related("task")
        )

        if live_assignments and request.query_params.get("force") != "true":
            task_names = [a.task.name for a in live_assignments[:5]]
            return Response(
                {
                    "code": "has_assignments",
                    "detail": (
                        f"{instance.resource.name} is assigned to "
                        f"{len(live_assignments)} task(s) in this project. "
                        f"Pass ?force=true to remove and unassign."
                    ),
                    "affected_tasks": [
                        {"id": str(a.task_id), "name": a.task.name} for a in live_assignments[:10]
                    ],
                    "task_names": task_names,
                    "assignment_count": len(live_assignments),
                },
                status=status.HTTP_409_CONFLICT,
            )

        affected_task_ids = [str(a.task_id) for a in live_assignments]

        # Cascade: delete TaskResource rows, then the ProjectResource row.
        # Wrapped in atomic() so a mid-sequence failure cannot leave orphaned
        # TaskResource rows without a corresponding ProjectResource (🔴-8).
        with transaction.atomic():
            TaskResource.objects.filter(
                resource_id=resource_id,
                task__project_id=project_id,
            ).delete()
            instance.delete()

        # The roster shrank regardless of whether the removed resource had any
        # live assignments — a zero-assignment removal is the most common case
        # (#1359). Broadcast roster_changed unconditionally so connected clients
        # refetch the roster; only enqueue a CPM recalc when assignments were
        # actually severed (no schedule input changed otherwise).
        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            if affected_task_ids:
                _enqueue_recalculate(project_id)
            broadcast_board_event(
                project_id,
                "roster_changed",
                {"resource_id": str(resource_id)},
            )

        transaction.on_commit(_on_commit)

        return Response(
            {
                "detail": "Resource removed from project.",
                "cascaded_assignment_count": len(live_assignments),
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# Task skill requirements
# ---------------------------------------------------------------------------


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="task",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to skill requirements for this task.",
            ),
        ],
    ),
    create=extend_schema(
        responses={
            201: TaskSkillRequirementSerializer,
            403: OpenApiResponse(
                description=(
                    "Caller lacks the Resource Manager role on the target task's project, "
                    "or that project is archived (#3570). The project is reached only "
                    "through the body's task here, so the refusal comes from the view "
                    "rather than a permission class — the status and body are the same "
                    "either way."
                )
            ),
        },
    ),
)
class TaskSkillRequirementViewSet(IdempotencyMixin, viewsets.ModelViewSet[TaskSkillRequirement]):
    """CRUD for skill requirements on tasks.

    Read: authenticated users scoped to their member projects.
    Write: SCHEDULER+ **on the target task's own project**, and the target task's
    project must not be archived — both enforced per-write by
    :meth:`_require_scheduler_on_task`.

    This surface is project-scoped, not org-global: every row belongs to exactly
    one task, which belongs to exactly one project. It carried ``IsOrgScheduler``
    as a class gate, which was strictly redundant — anyone passing the real
    per-target check necessarily holds SCHEDULER+ on some project and so passed
    the org gate too. Redundant is not free: it kept a project-scoped endpoint
    inside the blast radius of the self-grantable org derivation (#3569), and it
    made the endpoint's true rule harder to read. Dropped in favour of the check
    that was already doing the work. The archived-project floor (#3570) is the
    same story: enforced inline against the *target* task's project, not via a
    class-level ``IsProjectNotArchived`` that could only ever check the object
    DRF already resolved.
    """

    serializer_class = TaskSkillRequirementSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = TaskSkillRequirement.objects.select_related("skill", "task").filter(is_deleted=False)

    def get_permissions(self) -> list[BasePermission]:
        # Writes are authorized against the *target task's* project — both role
        # and archived-state — in perform_create / perform_update /
        # perform_destroy; see _require_scheduler_on_task. No class-level org or
        # archived gate: either could only ever admit a superset of what that
        # check admits.
        return [IsAuthenticated()]

    def _require_scheduler_on_task(self, task: Task) -> None:
        # This is the *only* authorization on writes (#3569 removed the redundant
        # IsOrgScheduler class gate above it). DRF never runs
        # has_object_permission on create, so without a per-target check a
        # SCHEDULER on project A could annotate a task in project B they've never
        # joined (IDOR, #995). The membership-scoped get_queryset closes the
        # non-member case on update/delete, but a low-role (Member/Viewer) member
        # of the target project would still be a member — so the SCHEDULER floor
        # is enforced on every write, against the *target task's* project.
        role = _membership_role(self.request, str(task.project_id))
        if role is None or role < Role.SCHEDULER:
            # "Resource Manager" is the label for ``Role.SCHEDULER``; "Scheduler"
            # is the code name and appears on no surface, so a refusal naming it
            # sends the reader looking for a role that does not exist (#3503).
            # Matches ``IsProjectScheduler.message``.
            raise PermissionDenied(
                "You need at least Resource Manager role on the target task's project."
            )
        # Archived is lifecycle state, not authority, so it is checked after the role
        # floor and against the same target project. There is no class-level
        # ``IsProjectNotArchived`` here (#3569 dropped the class-level org gate this
        # method sits beside, for the same reason): this route is top-level, so on a
        # create there is no object for ``has_object_permission`` to resolve, and on an
        # update that repoints ``task`` the object DRF would check is the OLD row,
        # whose project may be live while the destination is archived (#3570).
        assert_project_not_archived(task.project_id)

    def perform_create(self, serializer: BaseSerializer[TaskSkillRequirement]) -> None:
        self._require_scheduler_on_task(serializer.validated_data["task"])
        super().perform_create(serializer)

    def perform_update(self, serializer: BaseSerializer[TaskSkillRequirement]) -> None:
        # Guard both the current row's project and any repointed ``task`` so an
        # update can neither mutate a row on a project the actor lacks SCHEDULER
        # on, nor move a requirement onto a task in such a project.
        instance = serializer.instance
        if instance is not None:
            self._require_scheduler_on_task(instance.task)
        new_task = serializer.validated_data.get("task")
        if new_task is not None:
            self._require_scheduler_on_task(new_task)
        super().perform_update(serializer)

    def perform_destroy(self, instance: TaskSkillRequirement) -> None:
        self._require_scheduler_on_task(instance.task)
        super().perform_destroy(instance)

    def get_queryset(self) -> QuerySet[TaskSkillRequirement]:
        # Scope to tasks in projects where the requesting user is a member.
        from typing import cast

        from django.contrib.auth.models import User

        user = cast(User, self.request.user)
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        # select_related("task") avoids N+1 queries in perform_update and
        # perform_destroy, both of which call _require_scheduler_on_task(instance.task)
        # and therefore load task.project_id (R1).
        qs = TaskSkillRequirement.objects.select_related("skill", "task").filter(
            is_deleted=False,
            task__project_id__in=member_project_ids,
        )
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)
        return qs


# ---------------------------------------------------------------------------
# Resource with skill-fit annotation
# ---------------------------------------------------------------------------


class _WorkspaceAdminEmailSearchFilter(filters.SearchFilter):
    """SearchFilter that only lets a workspace admin search the catalog by email (#892).

    The catalog is readable by any authenticated user, and email is stripped from
    payloads below workspace ADMIN (#891). But a static
    ``search_fields = ["name", "email"]`` still let anyone else probe email existence
    via ``?search=<email-substring>`` (a hit narrows the candidate set even though the
    value is never echoed). This backend gates the searchable fields on the same check
    the serializer uses: workspace admins search name + email; everyone else searches
    name only.

    Raised from the org-admin derivation to the stored workspace role in #3569 — the
    org-admin check it used to call was reachable by any account that created a
    throwaway project, which made the #891 harvest control decorative.
    """

    def get_search_fields(self, view: object, request: Request) -> list[str]:
        if _request_is_workspace_admin(request):
            return ["name", "email"]
        return ["name"]


def _request_is_workspace_admin(request: Request) -> bool:
    """Return True if the requesting user holds workspace ADMIN or above.

    A request-shaped wrapper over
    :func:`~trueppm_api.apps.workspace.permissions.is_workspace_admin`, which is the
    single definition — do not re-derive the role test here. This one exists because
    a ``SearchFilter`` backend has no permission class to hang the check on. Gates
    email visibility in search (#892) and the ``?include_deleted=true`` deactivated
    pool (#1374), matching :class:`IsWorkspaceAdminStrict` on the sibling actions.

    This used to derive admin authority from holding ADMIN+ on any project, in
    lockstep with ``IsOrgAdmin``. That derivation is self-grantable in two requests
    (#3569): nothing gates ``POST /projects/`` and ``perform_create`` makes the caller
    Owner. ``WorkspaceMembership`` is granted only by an existing workspace admin or
    by SSO provisioning, so it is not reachable that way.
    """
    return is_workspace_admin(getattr(request, "user", None))


def _caller_is_project_member(request: Request, project_id: Any) -> bool:
    """Return True when the caller holds an active membership on ``project_id``.

    Gates the catalog list's project-scoped query parameters (#3571). The resource
    catalog is readable by any authenticated user (ADR-0034), so a parameter that
    reaches *through* that open read into one project's data — its roster, its
    tasks' skill requirements — has to carry its own membership check; the
    endpoint's permission class cannot supply one, because the endpoint is not
    project-scoped.

    A malformed id is deliberately *not* pre-validated here: letting it reach the
    UUID column keeps the install-wide malformed-uuid contract
    (``core.exception_handlers`` maps it to 400 for a query param), rather than
    quietly downgrading a typo to an ignored parameter.
    """
    return _membership_role(request, project_id) is not None


def _caller_may_read_task(request: Request, task_id: Any) -> bool:
    """Return True when the caller is a member of the project owning ``task_id``.

    The ``?task=`` skill-fit annotation echoes a task's full requirement set back
    through the open catalog read, so those rows need the same project scoping
    :meth:`TaskSkillRequirementViewSet.get_queryset` already applies to them
    (#3571). An unknown task id and a foreign one are equally un-annotated, so the
    parameter cannot be used to confirm that a task id exists. A malformed id is
    left to the install-wide malformed-uuid contract (400), as above.
    """
    project_id = Task.objects.filter(pk=task_id).values_list("project_id", flat=True).first()
    if project_id is None:
        return False
    return _membership_role(request, project_id) is not None


class ResourceCatalogThrottle(UserRateThrottle):
    """Per-user rate limit on the org-wide resource catalog (#891).

    Mirrors the ``user_search`` throttle added for UserSearchView in #815: the
    catalog is readable by any authenticated user, so even with email stripped a
    single account could still page through it to enumerate the workforce. A
    per-user 60/min cap bounds bulk scraping while staying well above any
    interactive picker (AddToRosterCombobox) usage. The rate is set inline so no
    settings entry is required.
    """

    scope = "resource_catalog"
    rate = "60/min"


def _compute_skill_fit(
    resource: Resource, requirements: list[TaskSkillRequirement]
) -> tuple[str, list[dict[str, object]]]:
    """Return (skill_fit, missing_skills) for a resource against task requirements.

    skill_fit is 'exact' | 'partial' | 'missing'.
    missing_skills is a list of dicts with skill_id, skill_name, required, actual.
    """
    if not requirements:
        return "exact", []

    resource_skills: dict[str, int] = {
        str(rs.skill_id): rs.proficiency for rs in resource.skills.all()
    }

    matched = 0
    missing = []
    for req in requirements:
        sid = str(req.skill_id)
        actual = resource_skills.get(sid, 0)
        if actual >= req.min_proficiency:
            matched += 1
        else:
            missing.append(
                {
                    "skill_id": sid,
                    "skill_name": req.skill.name,
                    "required": req.min_proficiency,
                    "required_label": req.get_min_proficiency_display(),
                    "actual": actual,
                    "actual_label": Proficiency(actual).label if actual else "not tagged",
                }
            )

    if not missing:
        return "exact", []
    if matched > 0:
        return "partial", missing
    return "missing", missing


# Default fractional allocation assumed for a bare-assignee task with no
# TaskResource row (see the fallback in _check_overallocation below). Mirrors
# TaskResource.units' own model default — "assigned" without a tracked
# fraction is treated as full-time, the same assumption Task.assignee already
# encodes everywhere else it is read as a "who owns this" signal.
_BARE_ASSIGNEE_DEFAULT_UNITS = Decimal("1.0")


def _check_overallocation(resource: Resource, project_id: str) -> list[dict[str, str]]:
    """Return a warnings list if the resource is overallocated on active tasks.

    Overallocation is the **peak units the resource holds on any single working
    day** across non-COMPLETE, committed tasks in the project, compared against the
    resource's capacity **on this project** — the roster's ``units_override`` when
    one is set, else ``resource.max_units`` (#3574). Comparing against the raw
    default told a half-time person they were fine at 80% while the heat map one
    click away read 160%. If the peak exceeds capacity a single warning entry is
    returned so the caller can include it in the 201 response without blocking the
    save (ADR-0028 — soft warning, not a hard error).

    This was previously a project-lifetime ``Sum(units)`` with no date window at
    all, so three 0.8-unit tasks that never share a calendar day reported as 240%
    allocated — 18 of 41 real (resource, project) pairs on the seeded workspace
    produced a warning with no calendar-day conflict anywhere (#3534). Every
    sibling read — the heat map (``projects.utilization``), the board badge, the
    weekly digest — already windows by day, so the write-time warning was the one
    place in the product that did not ask whether the work overlaps. It now shares
    the engine's own calendar resolution and ``peak_concurrent_units``, which means
    "resource calendar wins" and non-working days are not conflicts here either.

    A task whose only assignment signal is a bare ``Task.assignee`` (no
    TaskResource row) previously contributed **zero** load here, silently
    understating this resource's real allocation (#3047 — the read-side half
    of the #2718/#2900 write/seed fixes). When ``resource.user`` links the
    Resource to the User account ``Task.assignee`` points at, those tasks are
    now folded in at ``_BARE_ASSIGNEE_DEFAULT_UNITS`` over their own span and
    flagged with a separate ``assignment_not_unit_tracked`` warning, so the caller
    knows the peak includes an estimate rather than a real ``TaskResource.units``
    figure. Resources with no linked user account (teams, equipment, or legacy
    rows predating the FK) cannot be correlated to ``Task.assignee`` and are
    unaffected — same as before this fix.

    Args:
        resource: The Resource being assigned.
        project_id: The project UUID to scope the utilisation peak.

    Returns:
        A list of warning dicts (overallocation and/or unit-tracking caveat),
        or an empty list.
    """
    # Capacity check counts only committed delivery — BACKLOG and COMPLETE are
    # excluded. BACKLOG via Task.committed (ADR-0057), COMPLETE via the
    # historical exclude (units are no longer demanding capacity).
    committed_tasks = Task.committed.filter(project_id=project_id).exclude(status="COMPLETE")

    # Span, not remaining-work window: Coalesce(scheduled_start, early_start)
    # .. early_finish, identical to the utilization engine (ADR-0752 / #2623).
    # A task the CPM has never dated comes back as (None, None) and is folded in
    # by peak_concurrent_units as an every-day baseline rather than dropped.
    assignment_rows = list(
        TaskResource.objects.filter(
            resource=resource,
            task_id__in=committed_tasks.values_list("pk", flat=True),
        )
        .annotate(
            _span_start=Coalesce(
                "task__scheduled_start", "task__early_start", output_field=DateField()
            )
        )
        .values_list("task_id", "units", "_span_start", "task__early_finish")
    )
    allocations = [
        Allocation(units=units, start=span_start, end=span_end)
        for _task_id, units, span_start, span_end in assignment_rows
    ]

    warnings: list[dict[str, str]] = []

    # Bare-assignee fallback: only resources linked to a user account can be
    # correlated to Task.assignee at all.
    bare_assignee_rows: list[tuple[object, object, object]] = []
    if resource.user_id is not None:
        unit_tracked_task_ids = {row[0] for row in assignment_rows}
        bare_assignee_rows = list(
            committed_tasks.filter(assignee_id=resource.user_id)
            .exclude(pk__in=unit_tracked_task_ids)
            .annotate(
                _span_start=Coalesce("scheduled_start", "early_start", output_field=DateField())
            )
            .values_list("pk", "_span_start", "early_finish")
        )

    if bare_assignee_rows:
        allocations.extend(
            Allocation(
                units=_BARE_ASSIGNEE_DEFAULT_UNITS,
                start=span_start,  # type: ignore[arg-type]
                end=span_end,  # type: ignore[arg-type]
            )
            for _pk, span_start, span_end in bare_assignee_rows
        )
        warnings.append(
            {
                "code": "assignment_not_unit_tracked",
                "resource_id": str(resource.pk),
                "resource_name": resource.name,
                "detail": (
                    f"{resource.name} is assigned to {len(bare_assignee_rows)} "
                    "task(s) with no tracked allocation units; the capacity "
                    "figures below assume full-time allocation for those tasks."
                ),
                "task_ids": ",".join(str(pk) for pk, _s, _e in bare_assignee_rows),
            }
        )

    project = (
        Project.objects.select_related("calendar")
        .prefetch_related("calendar__exceptions")
        .filter(pk=project_id)
        .first()
    )
    mask, exception_ranges = resolve_working_calendar(resource, project)
    peak, peak_day = peak_concurrent_units(allocations, mask, exception_ranges)

    capacity = resource_effective_units(project_id, resource)

    if peak > capacity:
        # Name the day when there is one. A peak carried entirely by undated
        # tasks has no day to point at, only a floor that applies to every day.
        when = f"on {peak_day.isoformat()}" if peak_day is not None else "on their busiest day"
        warnings.append(
            {
                "code": "resource_overallocated",
                "resource_id": str(resource.pk),
                "resource_name": resource.name,
                "detail": (
                    f"{resource.name} is allocated {peak:.0%} {when} (capacity: {capacity:.0%})."
                ),
            }
        )
    return warnings


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="exclude_project",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Exclude resources already in this project's roster. Only "
                    "honoured for members of that project; ignored otherwise."
                ),
            ),
            OpenApiParameter(
                name="task",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Annotate each resource with skill_fit (exact/partial/missing) "
                    "against this task's skill requirements and group results "
                    "accordingly. Only honoured for members of the task's project; "
                    "ignored otherwise."
                ),
            ),
            OpenApiParameter(
                name="include_deleted",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When 'true', include soft-deleted (deactivated) resources. Only "
                    "honoured for callers holding workspace Admin or above; silently ignored "
                    "for everyone else."
                ),
            ),
        ],
    ),
)
class ResourceViewSet(IdempotencyMixin, viewsets.ModelViewSet[Resource]):
    """CRUD for the org-level resource catalog (issue #155).

    Permission model (ADR-0034):
      Read (GET/HEAD/OPTIONS): any authenticated user — supports self-view
        for team members and the AddToRosterCombobox picker.
      Write (POST/PATCH/PUT): IsOrgAdmin — any user with PM (ADMIN) or Owner
        role on at least one *active* project (#3569). ``email`` is an exception:
        ``ResourceSerializer.validate`` rejects it below the stored workspace ADMIN
        role (#3625) — this view-level gate alone was self-grantable and left
        writing the field wide open even after #3569 raised reading it.
      DELETE, ``restore``, ``assignments``, and ``?include_deleted=true``:
        IsWorkspaceAdminStrict (stored workspace ADMIN role). Raised in #3569 —
        these reach across every project in the install, and the org-admin
        derivation they used to sit behind is self-grantable by creating a
        throwaway project.

    DELETE is a soft-delete ("deactivate"): it sets is_deleted=True, soft-deletes
    the resource's live ProjectResource roster row in every project, and enqueues a
    schedule recalculation for every project that has open TaskResource rows for the
    deactivated resource. TaskResource assignment rows are deliberately retained so
    assignment history survives an off-boarding; every roster, capacity, and skill
    read filters the deactivated resource out instead. The resource record is never
    hard-deleted, and POST /resources/{id}/restore/ reverses both halves — including
    the roster rows, but not a membership that was already removed by hand.

    Query params:
      ?search=             — filter by name/email (DRF SearchFilter); email is
                             searchable only for org admins (#892)
      ?exclude_project=    — exclude resources already in a project's roster;
                             only honoured for members of that project (#3571)
      ?task=               — annotate with skill_fit against the task's skill
                             requirements; groups results into exact/partial/missing.
                             Only honoured for members of the task's project (#3571)
      ?include_deleted=true — include soft-deleted (deactivated) resources;
                             only honoured for workspace Admin or above
      ?ordering=           — order by name (DRF OrderingFilter)

    Every parameter that names a project- or task-scoped id is gated on the
    caller's membership of that project. The catalog read itself is open, so a
    parameter is the only place a project boundary can be crossed here; an
    unauthorized id is treated as absent rather than refused, so no parameter
    doubles as an existence oracle.
    """

    queryset = (
        Resource.objects.select_related("calendar")
        .prefetch_related("skills__skill")
        .order_by("name")
    )
    serializer_class = ResourceSerializer
    # Email search is gated on the stored workspace ADMIN role via the custom backend
    # (#892, raised from org-admin in #3569): everyone else searches by name only, so
    # they cannot probe email existence with ?search=.
    filter_backends = [_WorkspaceAdminEmailSearchFilter, filters.OrderingFilter]
    search_fields = ["name", "email"]  # workspace admins; backend narrows to ["name"]
    ordering_fields = ["name"]
    # Per-user cap on the harvest-prone read path (#891, mirrors #815).
    throttle_classes = [ResourceCatalogThrottle]

    #: Actions that reach past the catalog's own row data — into other projects'
    #: task names, or into the deactivated pool — and therefore take the **stored**
    #: workspace ADMIN role rather than the self-grantable org-admin derivation
    #: (#3569).
    #:
    #: * ``assignments`` — task and project names for one person across every
    #:   project in the install (ADR-0499). Exfiltration.
    #: * ``destroy`` — soft-deletes a shared resource and fans a CPM recalc plus a
    #:   ``roster_changed`` broadcast to every project holding an assignment,
    #:   including projects the caller cannot see. Destruction.
    #: * ``restore`` — the inverse of ``destroy``, kept on the same floor so the
    #:   deactivation lifecycle has one principal. Splitting it would leave an
    #:   admin able to reactivate rows they can neither list
    #:   (``?include_deleted=true`` is on the same floor) nor deactivate.
    _WORKSPACE_ADMIN_ACTIONS: frozenset[str] = frozenset({"assignments", "destroy", "restore"})

    def get_permissions(self) -> list[BasePermission]:
        """Split read vs write permissions.

        Safe HTTP methods open to any authenticated user; ordinary catalog writes
        (create, update) restricted to org admins (PM or Owner role on any *active*
        project). The deactivation lifecycle and the cross-project ``assignments``
        view require workspace ADMIN — see :attr:`_WORKSPACE_ADMIN_ACTIONS`.

        ``IsWorkspaceAdminStrict`` rather than ``IsWorkspaceOperator``: the defect in
        #3569 is that org authority was read out of a *self-grantable* project role,
        and the fix is a **stored** principal, not necessarily the install superuser.
        ``WorkspaceMembership`` is granted only by an existing workspace admin or by
        SSO provisioning — creating a project grants none — so ADMIN is unreachable
        by the exploit path while staying an in-app role a workspace owner can hand
        out. Superusers keep access through ``workspace_role_for_user``'s implicit
        OWNER bootstrap. ``IsWorkspaceAdminStrict`` (#1724) gates ADMIN on reads as
        well as writes, which is what ``assignments`` needs.
        """
        # `assignments` is a GET that must NOT inherit the base catalog read's open
        # IsAuthenticated gate: it carries task/project names across project
        # boundaries, so an open gate is a cross-project IDOR. It sits in the
        # workspace-admin set rather than being special-cased here.
        if getattr(self, "action", None) in self._WORKSPACE_ADMIN_ACTIONS:
            return [IsAuthenticated(), IsWorkspaceAdminStrict()]
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgAdmin()]

    def get_queryset(self) -> QuerySet[Resource]:
        qs = (
            Resource.objects.select_related("calendar")
            .prefetch_related("skills__skill")
            .order_by("name")
        )

        # Deactivated resources are hidden by default. A workspace admin may opt in
        # via ?include_deleted=true to manage the deactivated pool. The param is
        # honored only at that floor (#1374, raised from org-admin in #3569):
        # anyone else passing it is silently ignored so soft-deleted resource
        # records stay hidden — defense-in-depth for the deactivated-pool contract
        # the docstring already claimed, and it keeps the pool's three verbs
        # (list/delete/restore) on one principal.
        include_deleted = self.request.query_params.get(
            "include_deleted", ""
        ).lower() == "true" and _request_is_workspace_admin(self.request)
        if not include_deleted:
            qs = qs.filter(is_deleted=False)

        # ?exclude_project= reaches through the open catalog read into one
        # project's roster: diffing the filtered list against the bare one names
        # every resource on that roster. Honour it only for members of that
        # project (#3571). A non-member's parameter is ignored rather than
        # refused, which is exactly the response they get by omitting it, so the
        # parameter confirms nothing about the project id either — the same
        # treatment ?include_deleted= gets for non-admins above.
        exclude_project = self.request.query_params.get("exclude_project")
        if exclude_project and _caller_is_project_member(self.request, exclude_project):
            already_in = ProjectResource.objects.filter(
                project_id=exclude_project, is_deleted=False
            ).values_list("resource_id", flat=True)
            qs = qs.exclude(pk__in=already_in)

        return qs

    def perform_destroy(self, instance: Resource) -> None:
        """Soft-delete: hide from the catalog, drop off every roster, recalc schedules.

        Deactivation is **catalog-only on the assignment rows** (#3572). Hard delete is
        intentionally unavailable from this endpoint, and the ``TaskResource`` rows are
        deliberately left in place: historical task assignments and capacity data
        reference this resource and must remain intact for audit trails — an
        off-boarding is precisely the moment that record matters most.

        What deactivation *does* end is the person's presence in the team:

        1. Every live ``ProjectResource`` roster row is soft-deleted and stamped
           ``deactivated_with_resource`` so :meth:`restore` can put back exactly these
           and not a membership someone ended by hand.
        2. Every capacity, roster, and skill read filters the resource out through
           ``ResourceScopedManager.active()`` — the retained assignment rows stop
           contributing load and stop contributing capacity to the denominator.

        The CPM recalculation fan-out below stays coherent under (2): it is not
        undoing the assignments (they still hold their tasks and their units), it is
        re-running the schedule for projects whose *reported* team just changed, so the
        heat map, the allocation timeline, and the Overview utilization card agree with
        the roster on the very next read rather than on the next unrelated write.
        """
        # Wrap the soft-delete save, the roster cascade, and the per-project
        # recalculation fan-out in a single atomic block so a crash partway through
        # cannot leave the resource deactivated without the roster cascade or the CPM
        # recalcs (R3). The _enqueue_recalculate calls use the transactional outbox
        # pattern (ADR-0027), so they are durable against broker failures.
        with transaction.atomic():
            instance.is_deleted = True
            instance.server_version = (instance.server_version or 0) + 1
            instance.deleted_version = instance.server_version
            instance.save(update_fields=["is_deleted", "server_version", "deleted_version"])

            # Roster cascade. Only rows that are live *right now* are stamped, so any
            # roster row soft-deleted by some other path keeps
            # deactivated_with_resource=False and restore leaves it alone — see the
            # field's own comment for why that matters. Bulk ``update()`` rather than per-row
            # ``soft_delete()``: ProjectResource is outside the sync union (nothing
            # reads its sync_seq), so there is no tombstone to publish and no reason
            # to spend a query per roster row on an off-boarding.
            #
            # The F() version bump replicates what VersionedModel.soft_delete would
            # have recorded, following cascade_project_children_soft_delete's
            # precedent: within one UPDATE every F() reads the pre-update column, so
            # deleted_version lands equal to the new server_version. It is not
            # decorative — server_version is the X-Base-Version optimistic-lock token
            # ProjectResourceSerializer publishes, so skipping it would let a client
            # holding a pre-deactivation copy pass the lock check on a row that had
            # since been deactivated and restored.
            #
            # Deliberately NOT excluding archived projects: deactivation is an
            # org-wide off-boarding and must not be left partially applied because
            # one project happens to be archived. The roster row of an archived
            # project is a historical record either way, and restore's symmetric
            # filter keeps the two halves reversible.
            cascade_rows = ProjectResource.objects.filter(resource_id=instance.pk, is_deleted=False)
            # Snapshot the project ids before the UPDATE clears the predicate that
            # selects them, so the broadcast set is exactly the rows this call
            # cascaded — not every row a previous, never-restored deactivation left
            # stamped.
            cascaded_project_ids = list(cascade_rows.values_list("project_id", flat=True))
            cascade_rows.update(
                is_deleted=True,
                deactivated_with_resource=True,
                server_version=models.F("server_version") + 1,
                deleted_version=models.F("server_version") + 1,
            )

            # Fan out a schedule recalculation to every project with open
            # task assignments for this resource. Uses the transactional outbox
            # pattern (ADR-0027) so a broker-down event doesn't lose the request.
            affected_project_ids = list(
                TaskResource.objects.filter(resource_id=instance.pk)
                .values_list("task__project_id", flat=True)
                .distinct()
            )
            for project_id in affected_project_ids:
                _enqueue_recalculate(str(project_id))

        # The roster cascade above reaches projects the assignment fan-out does not:
        # a resource can sit on a roster carrying no tasks at all, which is exactly
        # the person an off-boarding is most likely to leave behind. So the broadcast
        # set is the union of both, not just the projects that carried assignments.
        #
        # Fan a roster_changed broadcast out to every affected project so peers
        # viewing the roster see the deactivation live, not on the next poll
        # (#1359). Deferred to commit and snapshotted to plain strings; mirrors
        # the per-project recalc fan-out above.
        resource_id = str(instance.pk)
        broadcast_project_ids = sorted(
            {str(p) for p in affected_project_ids} | {str(p) for p in cascaded_project_ids}
        )

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            for project_id in broadcast_project_ids:
                broadcast_board_event(
                    project_id,
                    "roster_changed",
                    {"resource_id": resource_id},
                )

        transaction.on_commit(_on_commit)

    # Reactivation is carried by the URL alone — the body is never read. Without
    # ``request=None`` the schema fell back to serializer_class and published a
    # *required* ResourceRequest body (the full write shape) on this no-body
    # endpoint, so a generated client demanded a whole resource payload to
    # un-deactivate one (#2840). Sibling restore actions on Task/Project already
    # publish no body; this one was the outlier.
    @extend_schema(
        summary="Restore a deactivated resource",
        request=None,
        responses={
            200: ResourceSerializer,
            400: OpenApiResponse(description="Resource is not deactivated."),
            404: OpenApiResponse(description="Resource not found."),
        },
    )
    @action(detail=True, methods=["post"], url_path="restore")
    def restore(self, request: Request, pk: str | None = None) -> Response:
        """Restore a soft-deleted resource back to active status.

        Requires IsWorkspaceAdminStrict (checked in get_permissions since this is a
        write action; raised from IsOrgAdmin in #3569 so the whole deactivation
        lifecycle sits on one principal). Fetches from the unfiltered queryset so
        soft-deleted records are reachable; the standard get_object() path
        excludes them.

        Reverses **both** halves of :meth:`perform_destroy` (#3572). The catalog flag
        alone is not enough: deactivation also soft-deleted the resource's roster
        rows, and a one-way cascade would leave a reactivated person visible in the
        catalog but silently absent from every team they were on — a second bug in
        the shape of the first.

        Only rows stamped ``deactivated_with_resource`` come back — restore states
        what it reverses rather than inferring it from ``is_deleted``. Roster removal
        through the API is a hard delete, so the cascade is currently the only
        product path that leaves a soft-deleted roster row; the stamp is what keeps
        that an assertion rather than an assumption, so a row soft-deleted by an
        import, a management command, or a data repair is never silently adopted
        into somebody's reactivation. See ``ProjectResource.deactivated_with_resource``.
        """
        if pk is None:
            return Response({"detail": _NOT_FOUND_DETAIL}, status=status.HTTP_404_NOT_FOUND)
        try:
            resource = Resource.objects.get(pk=pk)
        except Resource.DoesNotExist:
            return Response({"detail": _NOT_FOUND_DETAIL}, status=status.HTTP_404_NOT_FOUND)
        if not resource.is_deleted:
            return Response(
                {"detail": "Resource is not deactivated."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Atomic so the catalog flag and the roster rows cannot disagree: a crash
        # between them would leave the resource selectable but off every roster,
        # which is the exact asymmetry this action exists to prevent.
        with transaction.atomic():
            resource.is_deleted = False
            resource.deleted_version = None
            resource.server_version = (resource.server_version or 0) + 1
            resource.save(update_fields=["is_deleted", "deleted_version", "server_version"])

            # Read the project ids before the update clears the stamp.
            restored_project_ids = list(
                ProjectResource.objects.filter(
                    resource_id=resource.pk, deactivated_with_resource=True
                ).values_list("project_id", flat=True)
            )
            # Symmetric to the cascade: same F() version bump, so a client holding
            # a pre-deactivation copy of a restored roster row cannot pass the
            # X-Base-Version optimistic-lock check on it.
            ProjectResource.objects.filter(
                resource_id=resource.pk, deactivated_with_resource=True
            ).update(
                is_deleted=False,
                deleted_version=None,
                deactivated_with_resource=False,
                server_version=models.F("server_version") + 1,
            )

        # Reactivation puts the resource back on every roster the deactivation took
        # it off, plus every project it still has assignments on — broadcast
        # roster_changed so those projects' clients refetch the roster live (#1359),
        # mirroring the soft-delete fan-out.
        affected_project_ids = sorted(
            {
                str(p)
                for p in TaskResource.objects.filter(resource_id=resource.pk)
                .values_list("task__project_id", flat=True)
                .distinct()
            }
            | {str(p) for p in restored_project_ids}
        )
        resource_id = str(resource.pk)

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            for project_id in affected_project_ids:
                broadcast_board_event(
                    project_id,
                    "roster_changed",
                    {"resource_id": resource_id},
                )

        transaction.on_commit(_on_commit)

        serializer = self.get_serializer(resource)
        return Response(serializer.data)

    @extend_schema(
        responses=ResourceAssignmentSerializer(many=True),
        description=(
            "Cross-project task assignments for one resource — the org catalog's "
            "'what is this person working on' view (#2047). Requires the workspace "
            "Admin role because it carries task/project names across "
            "project boundaries. "
            "Soft-deleted tasks are excluded; a deactivated resource still returns "
            "its assignments. Ordered by project then task."
        ),
    )
    @action(detail=True, methods=["get"], url_path="assignments")
    def assignments(self, request: Request, pk: str | None = None) -> Response:
        """Return every task the resource is assigned to, across all projects.

        Gated on ``IsWorkspaceAdminStrict`` in ``get_permissions`` (this GET must not
        inherit the base catalog read's open gate — see the note there). Unlike
        ``/task-resources/?resource=`` this is NOT scoped to the caller's member
        projects: it returns the full cross-project set.

        ADR-0499 gated it on ``IsOrgAdmin`` and reasoned that "the RBAC gate is
        what makes that safe". It did not — that gate is self-grantable in two
        requests (#3569), so the complete picture was readable by any account. The
        stored workspace ADMIN role is not reachable that way. A resource manager who
        needs their own projects' view uses ``/task-resources/?resource=``, which is
        membership-scoped.

        The resource is looked up from the unfiltered manager so a deactivated
        resource's detail panel still resolves (mirrors ``restore``). Soft-deleted
        tasks are filtered out; completed tasks are included and sectioned client
        side. ``select_related('task__project')`` keeps this a single query
        regardless of assignment count (no N+1).
        """
        if pk is None or not Resource.objects.filter(pk=pk).exists():
            return Response({"detail": _NOT_FOUND_DETAIL}, status=status.HTTP_404_NOT_FOUND)

        assignments_qs = (
            TaskResource.objects.filter(resource_id=pk, task__is_deleted=False)
            .select_related("task__project")
            .order_by("task__project__name", "task__name")
        )

        # Use the paginator directly rather than self.paginate_queryset(): the
        # latter is typed to the viewset's Resource model, but this action returns
        # TaskResource rows. The set is intrinsically bounded (one person's
        # assignments) — pagination is a belt-and-suspenders guard.
        paginator = self.paginator
        if paginator is not None:
            page = paginator.paginate_queryset(assignments_qs, request, view=self)
            if page is not None:
                serializer = ResourceAssignmentSerializer(page, many=True)
                return paginator.get_paginated_response(serializer.data)
        serializer = ResourceAssignmentSerializer(assignments_qs, many=True)
        return Response(serializer.data)

    def list(self, request: Request, *args: object, **kwargs: object) -> Response:
        """List resources, optionally annotated with skill_fit for a task."""
        task_id = request.query_params.get("task")
        requirements: list[TaskSkillRequirement] = []
        # missing_skills[] echoes skill_name/required/required_label for every
        # requirement on the task, so an unscoped ?task= published a foreign
        # project's requirement set through a read any authenticated user may
        # make. Annotate only for members of the task's project (#3571) — the
        # same scoping TaskSkillRequirementViewSet.get_queryset applies to these
        # rows. A non-member gets the plain, un-annotated catalog.
        if task_id and _caller_may_read_task(request, task_id):
            requirements = list(
                TaskSkillRequirement.objects.filter(
                    task_id=task_id, is_deleted=False
                ).select_related("skill")
            )

        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        resources = page if page is not None else queryset

        serializer = self.get_serializer(resources, many=True)
        data = serializer.data

        if requirements:
            resource_map = {str(r.pk): r for r in resources}
            fit_order = {"exact": 0, "partial": 1, "missing": 2}
            annotated = []
            for item in data:
                resource = resource_map.get(item["id"])
                if resource is not None:
                    fit, missing = _compute_skill_fit(resource, requirements)
                    item = dict(item)
                    item["skill_fit"] = fit
                    item["missing_skills"] = missing
                annotated.append(item)
            annotated.sort(key=lambda x: fit_order.get(x.get("skill_fit", "missing"), 2))
            data = annotated

        if page is not None:
            return self.get_paginated_response(data)
        return Response(data)


# ---------------------------------------------------------------------------
# Task-resource assignments (extended with skill_mismatch warning)
# ---------------------------------------------------------------------------


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="task",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to assignments for this task.",
            ),
            OpenApiParameter(
                name="resource",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to assignments for this resource.",
            ),
        ],
    ),
    create=extend_schema(
        responses={
            201: TaskResourceSerializer,
            403: OpenApiResponse(
                description=(
                    "Caller lacks the Resource Manager role on the target project, or that "
                    "project is archived (#3414). The project is named only in the request "
                    "body here, so the refusal comes from the view rather than a permission "
                    "class — the status and body are the same either way."
                )
            ),
        },
    ),
)
class TaskResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[TaskResource]):
    """CRUD for task-resource assignments.

    Permission model:
    - Read (GET/HEAD/OPTIONS): any project member (Viewer+) via IsProjectMember.
    - Write (POST/PATCH/DELETE): Resource Manager (2) or above via CanAssignResource.
      The create path additionally checks role in perform_create because has_object_permission
      is not called before the object exists.

    IDOR protection:
    ProjectScopedViewSet does not recognise the task→project FK path on TaskResource,
    so get_queryset explicitly scopes to the user's member projects rather than relying
    on the mixin fallthrough.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, CanAssignResource, IsProjectNotArchived]
    serializer_class = TaskResourceSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = TaskResource.objects.select_related("task__project", "resource")

    def get_queryset(self) -> QuerySet[TaskResource]:
        # IsAuthenticated guarantees pk is set; assert narrows the type for mypy.
        user_pk = self.request.user.pk
        assert user_pk is not None
        member_project_ids = ProjectMembership.objects.filter(
            user_id=user_pk,
            is_deleted=False,
        ).values_list("project_id", flat=True)
        # select_related("task__project") avoids N+1 queries in perform_create
        # and perform_update, both of which call ensure_project_resource(obj.task.project, ...)
        # and therefore load the full Project object (R2).
        #
        # Deliberately NOT ``.active()`` (#3572), unlike its two siblings in this
        # file. This is the assignment list, not a capacity read: when somebody is
        # deactivated their assignment rows are kept precisely so a PM can still see
        # the orphaned work and reassign it. Hiding them here would make the tasks
        # look unowned with no way to find out who had them. The rows carry no load
        # anywhere else — every capacity surface filters them out.
        qs = (
            TaskResource.objects.select_related("task__project", "resource")
            .filter(task__project_id__in=member_project_ids)
            .order_by("task__project_id", "task_id", "resource__name")
        )
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)
        resource_id = self.request.query_params.get("resource")
        if resource_id:
            qs = qs.filter(resource_id=resource_id)
        return qs

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        """Create a task-resource assignment and return any warnings.

        Returns overallocation and skill_mismatch warnings in the 201 response.
        The assignment is always saved regardless of warnings — these are soft
        alerts, not hard blocks (ADR-0028, ADR-0033).
        """
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        obj: TaskResource = serializer.instance  # type: ignore[assignment]
        project_id = str(obj.task.project_id)
        # Fetch the resource (with skills prefetched) once and reuse it for both
        # the overallocation check and the skill-fit check, instead of lazy-loading
        # obj.resource and then re-fetching the same row with prefetch (#821).
        # select_related/prefetch the resource calendar too: _check_overallocation
        # resolves the resource's working days (ADR-0031 "resource calendar wins"),
        # which would otherwise be two lazy queries per POST.
        resource_with_skills = (
            Resource.objects.select_related("calendar")
            .prefetch_related("skills__skill", "calendar__exceptions")
            .get(pk=obj.resource_id)
        )
        warnings: list[dict[str, object]] = [
            dict(w) for w in _check_overallocation(resource_with_skills, project_id)
        ]

        # Skill mismatch check — only when the task has requirements.
        requirements = list(
            TaskSkillRequirement.objects.filter(
                task_id=obj.task_id, is_deleted=False
            ).select_related("skill")
        )
        _fit, missing = _compute_skill_fit(resource_with_skills, requirements)
        if missing:
            missing_labels = ", ".join(
                f"{m['skill_name']} ({m['required_label']})" for m in missing[:3]
            )
            warnings.append(
                {
                    "code": "skill_mismatch",
                    "detail": f"Task requires: {missing_labels}.",
                    "missing_skills": missing,
                }
            )

        data = dict(serializer.data)
        data["warnings"] = warnings
        return Response(data, status=status.HTTP_201_CREATED, headers=headers)

    def perform_create(self, serializer: BaseSerializer[TaskResource]) -> None:
        """Block assignment creation for summary tasks, then trigger CPM and broadcast.

        Role check: Resource Manager (2) or above is required. has_object_permission is
        not called for create (no object exists yet), so the role is verified here against
        the task's project before the row is written.

        Summary tasks roll up from children — direct resource assignments on
        them create ambiguous scheduling semantics (ADR-0024).
        """
        task = serializer.validated_data.get("task")
        if task:
            role = _membership_role(self.request, str(task.project_id))
            if role is None or role < Role.SCHEDULER:
                raise PermissionDenied(
                    "You need at least Resource Manager role to assign resources."
                )
            # Same shape as the role check above, and for the same structural reason
            # (#3414): the route is top-level, the project is reached only through the
            # body's ``task``, and ``has_object_permission`` does not run on a create —
            # so the class-level ``IsProjectNotArchived`` cannot see this write.
            assert_project_not_archived(task.project_id)
        if task and task_is_summary(task):
            raise ValidationError({"task": "Cannot assign resources to a summary task."})
        obj = serializer.save()
        project_id = str(obj.task.project_id)
        task_id = str(obj.task.pk)
        assignment_id = str(obj.pk)

        # Auto-roster: assigning a resource to a task implicitly adds them to
        # the project roster so they appear in Team → Roster / Heatmap.
        ensure_project_resource(obj.task.project, obj.resource)

        # Task-activity audit row (ADR-0394, #1886): written synchronously in the
        # request transaction so it commits/rolls back with the assignment itself.
        record_assignment_event(
            task_id=obj.task_id,
            event_type=TaskActivityEventType.ASSIGNEE_ADDED,
            resource=obj.resource,
            actor=self.request.user,
            units_to=obj.units,
        )

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            _enqueue_recalculate(project_id)
            broadcast_board_event(
                project_id,
                "assignment_created",
                {"id": assignment_id, "task_id": task_id},
            )

        transaction.on_commit(_on_commit)

    def perform_update(self, serializer: BaseSerializer[TaskResource]) -> None:
        """Save the updated assignment and trigger CPM recalculation and broadcast."""
        # Capture pre-save state so the audit row can distinguish a resource re-point
        # (remove old + add new) from an allocation-only change (ADR-0394, #1886).
        pre = serializer.instance
        old_resource = pre.resource if pre is not None else None
        old_units = pre.units if pre is not None else None

        obj = serializer.save()
        project_id = str(obj.task.project_id)
        task_id = str(obj.task.pk)
        assignment_id = str(obj.pk)

        # Re-pointing an assignment to a different resource must roster the new
        # one — otherwise editing assignee leaves them invisible in Team views (#241).
        ensure_project_resource(obj.task.project, obj.resource)

        # Task-activity audit (ADR-0394, #1886), synchronous in-transaction:
        # a resource swap is an unassign+reassign; a units-only edit is a re-allocation.
        if old_resource is not None and old_resource.pk != obj.resource_id:
            record_assignment_event(
                task_id=obj.task_id,
                event_type=TaskActivityEventType.ASSIGNEE_REMOVED,
                resource=old_resource,
                actor=self.request.user,
                units_to=old_units,
            )
            record_assignment_event(
                task_id=obj.task_id,
                event_type=TaskActivityEventType.ASSIGNEE_ADDED,
                resource=obj.resource,
                actor=self.request.user,
                units_to=obj.units,
            )
        elif old_units != obj.units:
            record_assignment_event(
                task_id=obj.task_id,
                event_type=TaskActivityEventType.ASSIGNEE_UNITS_CHANGED,
                resource=obj.resource,
                actor=self.request.user,
                units_from=old_units,
                units_to=obj.units,
            )

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            _enqueue_recalculate(project_id)
            broadcast_board_event(
                project_id,
                "assignment_updated",
                {"id": assignment_id, "task_id": task_id},
            )

        transaction.on_commit(_on_commit)

    def perform_destroy(self, instance: TaskResource) -> None:
        """Delete the assignment and trigger CPM recalculation and broadcast."""
        project_id = str(instance.task.project_id)
        task_id = str(instance.task.pk)
        assignment_id = str(instance.pk)

        # Task-activity audit row (ADR-0394, #1886) before the hard delete, while the
        # resource/units are still readable; the task FK survives (only the assignment
        # row is removed). Synchronous in-transaction, like the risk-link precedent.
        record_assignment_event(
            task_id=instance.task_id,
            event_type=TaskActivityEventType.ASSIGNEE_REMOVED,
            resource=instance.resource,
            actor=self.request.user,
            units_to=instance.units,
        )
        instance.delete()

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            _enqueue_recalculate(project_id)
            broadcast_board_event(
                project_id,
                "assignment_deleted",
                {"id": assignment_id, "task_id": task_id},
            )

        transaction.on_commit(_on_commit)
