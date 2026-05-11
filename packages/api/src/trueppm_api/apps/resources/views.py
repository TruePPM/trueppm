"""DRF ViewSets for the resources app."""

from __future__ import annotations

from decimal import Decimal

from django.db import connection, transaction
from django.db.models import QuerySet, Sum
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    IsOrgAdmin,
    IsOrgScheduler,
    IsProjectMember,
    ProjectScopedViewSet,
    _membership_role,
)
from trueppm_api.apps.projects.models import Task
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
    ResourceSerializer,
    ResourceSkillSerializer,
    SkillSerializer,
    TaskResourceSerializer,
    TaskSkillRequirementSerializer,
)
from trueppm_api.apps.resources.services import ensure_project_resource
from trueppm_api.apps.scheduling.services import enqueue_recalculate as _enqueue_recalculate

# ---------------------------------------------------------------------------
# Skill catalog
# ---------------------------------------------------------------------------


class SkillViewSet(viewsets.ModelViewSet[Skill]):
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

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        """Create or return existing skill — de-dup by normalized_name."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        skill = serializer.save()
        # Return 200 if skill already existed, 201 if newly created.
        created = not Skill.objects.filter(pk=skill.pk, server_version=0).exists()
        http_status = status.HTTP_201_CREATED if not created else status.HTTP_200_OK
        return Response(
            self.get_serializer(skill).data,
            status=http_status,
            headers=self.get_success_headers(serializer.data),
        )


# ---------------------------------------------------------------------------
# Resource skills
# ---------------------------------------------------------------------------


class ResourceSkillViewSet(viewsets.ModelViewSet[ResourceSkill]):
    """CRUD for skill tags on resources.

    Read: any authenticated user (resource catalog is org-shared).
    Write: org admins (PM/Owner on any project). The route is not project-nested
    so IsProjectMember alone would not gate writes; IsOrgAdmin enforces the
    intended ADMIN+ floor.
    """

    serializer_class = ResourceSkillSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = ResourceSkill.objects.select_related("skill").filter(is_deleted=False)

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgScheduler()]

    def get_queryset(self) -> QuerySet[ResourceSkill]:
        qs = ResourceSkill.objects.select_related("skill").filter(is_deleted=False)
        resource_id = self.request.query_params.get("resource")
        if resource_id:
            qs = qs.filter(resource_id=resource_id)
        return qs


# ---------------------------------------------------------------------------
# Project roster
# ---------------------------------------------------------------------------


class ProjectResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[ProjectResource]):
    """CRUD for a project's resource roster.

    Read: any project member (VIEWER+).
    Write: SCHEDULER+ on the project.
    Delete: SCHEDULER+; with ?force=true cascades to TaskResource rows and
    triggers CPM recalculation (ADR-0027). Without force=true returns 409 if
    live task assignments exist.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, CanAssignResource]
    serializer_class = ProjectResourceSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = (
        ProjectResource.objects.select_related("resource", "resource__calendar")
        .prefetch_related("resource__skills__skill")
        .filter(is_deleted=False)
    )

    def get_queryset(self) -> QuerySet[ProjectResource]:
        user_pk = self.request.user.pk
        assert user_pk is not None
        member_project_ids = ProjectMembership.objects.filter(
            user_id=user_pk, is_deleted=False
        ).values_list("project_id", flat=True)
        qs = (
            ProjectResource.objects.select_related("resource", "resource__calendar")
            .prefetch_related("resource__skills__skill")
            .filter(project_id__in=member_project_ids, is_deleted=False)
            .order_by("resource__name")
        )
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    def perform_create(self, serializer: BaseSerializer[ProjectResource]) -> None:
        """Verify SCHEDULER+ role on the project before adding to roster."""
        project = serializer.validated_data.get("project")
        if project:
            role = _membership_role(self.request, str(project.pk))
            if role is None or role < Role.SCHEDULER:
                raise PermissionDenied(
                    "You need at least Resource Manager role to manage the roster."
                )
        serializer.save()

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
        TaskResource.objects.filter(
            resource_id=resource_id,
            task__project_id=project_id,
        ).delete()
        instance.delete()

        if affected_task_ids:

            def _on_commit() -> None:
                from trueppm_api.apps.sync.broadcast import broadcast_board_event

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


class TaskSkillRequirementViewSet(viewsets.ModelViewSet[TaskSkillRequirement]):
    """CRUD for skill requirements on tasks.

    Read: authenticated users scoped to their member projects.
    Write: SCHEDULER+ (IsOrgScheduler — SCHEDULER role on at least one project).
    """

    serializer_class = TaskSkillRequirementSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = TaskSkillRequirement.objects.select_related("skill").filter(is_deleted=False)

    def get_permissions(self) -> list[BasePermission]:
        from rest_framework.permissions import SAFE_METHODS

        if self.request.method in SAFE_METHODS:
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgScheduler()]

    def get_queryset(self) -> QuerySet[TaskSkillRequirement]:
        # Scope to tasks in projects where the requesting user is a member.
        member_project_ids = ProjectMembership.objects.filter(
            user=self.request.user, is_deleted=False
        ).values_list("project_id", flat=True)
        qs = TaskSkillRequirement.objects.select_related("skill").filter(
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


def _check_overallocation(resource: Resource, project_id: str) -> list[dict[str, str]]:
    """Return a warnings list if the resource is overallocated on active tasks.

    Sums ``units`` across all non-COMPLETE TaskResource rows for the resource
    within the given project. If the total exceeds ``resource.max_units``, a
    single warning entry is returned so the caller can include it in the 201
    response without blocking the save (ADR-0028 — soft warning, not a hard error).

    Args:
        resource: The Resource being assigned.
        project_id: The project UUID to scope the utilisation sum.

    Returns:
        A list containing at most one warning dict, or an empty list.
    """
    # Capacity check counts only committed delivery — BACKLOG and COMPLETE are
    # excluded. BACKLOG via Task.committed (ADR-0057), COMPLETE via the
    # historical exclude (units are no longer demanding capacity).
    committed_task_ids = Task.committed.filter(project_id=project_id).values_list("pk", flat=True)
    total: Decimal = TaskResource.objects.filter(
        resource=resource,
        task_id__in=committed_task_ids,
    ).exclude(task__status="COMPLETE").aggregate(total=Sum("units"))["total"] or Decimal("0")
    if total > resource.max_units:
        return [
            {
                "code": "resource_overallocated",
                "resource_id": str(resource.pk),
                "resource_name": resource.name,
                "detail": (
                    f"{resource.name} is allocated {total:.0%} across active tasks "
                    f"(capacity: {resource.max_units:.0%})."
                ),
            }
        ]
    return []


class ResourceViewSet(viewsets.ModelViewSet[Resource]):
    """CRUD for the org-level resource catalog (issue #155).

    Permission model (ADR-0034):
      Read (GET/HEAD/OPTIONS): any authenticated user — supports self-view
        for team members and the AddToRosterCombobox picker.
      Write (POST/PATCH/PUT/DELETE): IsOrgAdmin — any user with PM (ADMIN)
        or Owner role on at least one project.

    DELETE is a soft-delete: sets is_deleted=True and enqueues a schedule
    recalculation for every project that has open TaskResource rows for the
    deactivated resource. The resource record is never hard-deleted.

    Query params:
      ?search=             — filter by name/email (DRF SearchFilter)
      ?exclude_project=    — exclude resources already in a project's roster
      ?task=               — annotate with skill_fit against the task's skill
                             requirements; groups results into exact/partial/missing
      ?include_deleted=true — include soft-deleted (deactivated) resources;
                             only honoured for org admin users
    """

    queryset = (
        Resource.objects.select_related("calendar")
        .prefetch_related("skills__skill")
        .order_by("name")
    )
    serializer_class = ResourceSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name", "email"]
    ordering_fields = ["name"]

    def get_permissions(self) -> list[BasePermission]:
        """Split read vs write permissions.

        Safe HTTP methods open to any authenticated user; writes restricted
        to org admins (PM or Owner role on any project). The restore custom
        action uses POST so it correctly receives the IsOrgAdmin gate.
        """
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgAdmin()]

    def get_queryset(self) -> QuerySet[Resource]:
        qs = (
            Resource.objects.select_related("calendar")
            .prefetch_related("skills__skill")
            .order_by("name")
        )

        # Deactivated resources are hidden by default. Org admins may opt-in
        # via ?include_deleted=true to manage the deactivated pool.
        include_deleted = self.request.query_params.get("include_deleted", "").lower() == "true"
        if not include_deleted:
            qs = qs.filter(is_deleted=False)

        exclude_project = self.request.query_params.get("exclude_project")
        if exclude_project:
            already_in = ProjectResource.objects.filter(
                project_id=exclude_project, is_deleted=False
            ).values_list("resource_id", flat=True)
            qs = qs.exclude(pk__in=already_in)

        return qs

    def perform_destroy(self, instance: Resource) -> None:
        """Soft-delete: set is_deleted=True and recalc affected project schedules.

        Hard delete is intentionally unavailable from this endpoint. Historical
        task assignments and capacity data reference this resource and must
        remain intact for audit trails and utilization reports.
        """
        instance.is_deleted = True
        instance.server_version = (instance.server_version or 0) + 1
        instance.deleted_version = instance.server_version
        instance.save(update_fields=["is_deleted", "server_version", "deleted_version"])

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

    @action(detail=True, methods=["post"], url_path="restore")
    def restore(self, request: Request, pk: str | None = None) -> Response:
        """Restore a soft-deleted resource back to active status.

        Requires IsOrgAdmin (checked in get_permissions since this is a write
        action). Fetches from the unfiltered queryset so soft-deleted records
        are reachable; the standard get_object() path excludes them.
        """
        if pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            resource = Resource.objects.get(pk=pk)
        except Resource.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        if not resource.is_deleted:
            return Response(
                {"detail": "Resource is not deactivated."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        resource.is_deleted = False
        resource.deleted_version = None
        resource.server_version = (resource.server_version or 0) + 1
        resource.save(update_fields=["is_deleted", "deleted_version", "server_version"])
        serializer = self.get_serializer(resource)
        return Response(serializer.data)

    def list(self, request: Request, *args: object, **kwargs: object) -> Response:
        """List resources, optionally annotated with skill_fit for a task."""
        task_id = request.query_params.get("task")
        requirements: list[TaskSkillRequirement] = []
        if task_id:
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

    permission_classes = [IsAuthenticated, IsProjectMember, CanAssignResource]
    serializer_class = TaskResourceSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = TaskResource.objects.select_related("task", "resource")

    def get_queryset(self) -> QuerySet[TaskResource]:
        # IsAuthenticated guarantees pk is set; assert narrows the type for mypy.
        user_pk = self.request.user.pk
        assert user_pk is not None
        member_project_ids = ProjectMembership.objects.filter(
            user_id=user_pk,
            is_deleted=False,
        ).values_list("project_id", flat=True)
        qs = (
            TaskResource.objects.select_related("task", "resource")
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
        warnings: list[dict[str, object]] = [
            dict(w) for w in _check_overallocation(obj.resource, project_id)
        ]

        # Skill mismatch check — only when the task has requirements.
        requirements = list(
            TaskSkillRequirement.objects.filter(
                task_id=obj.task_id, is_deleted=False
            ).select_related("skill")
        )
        resource_with_skills = Resource.objects.prefetch_related("skills__skill").get(
            pk=obj.resource_id
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
        if task and task.wbs_path:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT EXISTS("
                    "  SELECT 1 FROM projects_task c"
                    "  WHERE c.project_id = %s"
                    "    AND c.is_deleted = false"
                    "    AND c.id != %s"
                    "    AND c.wbs_path IS NOT NULL"
                    "    AND c.wbs_path ~ (%s || '.*{1}')::lquery"
                    ")",
                    [task.project_id, task.pk, str(task.wbs_path)],
                )
                is_summary = cursor.fetchone()[0]
                if is_summary:
                    raise ValidationError({"task": "Cannot assign resources to a summary task."})
        obj = serializer.save()
        project_id = str(obj.task.project_id)
        task_id = str(obj.task.pk)
        assignment_id = str(obj.pk)

        # Auto-roster: assigning a resource to a task implicitly adds them to
        # the project roster so they appear in Team → Roster / Heatmap.
        ensure_project_resource(obj.task.project, obj.resource)

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
        obj = serializer.save()
        project_id = str(obj.task.project_id)
        task_id = str(obj.task.pk)
        assignment_id = str(obj.pk)

        # Re-pointing an assignment to a different resource must roster the new
        # one — otherwise editing assignee leaves them invisible in Team views (#241).
        ensure_project_resource(obj.task.project, obj.resource)

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
