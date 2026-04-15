"""DRF ViewSets for the resources app."""

from __future__ import annotations

from decimal import Decimal

from django.db import connection, transaction
from django.db.models import QuerySet, Sum
from rest_framework import filters, status, viewsets
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    IsProjectMember,
    ProjectScopedViewSet,
    _membership_role,
)
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.serializers import ResourceSerializer, TaskResourceSerializer
from trueppm_api.apps.scheduling.services import enqueue_recalculate as _enqueue_recalculate


class ResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Resource]):
    """CRUD for resources (people, teams, materials).

    Resources are org-level objects and are not filtered by project membership —
    any authenticated user can read and create resources. The ProjectScopedViewSet
    mixin's fallthrough path handles this correctly.
    """

    permission_classes = [IsAuthenticated, IsProjectMember]
    queryset = Resource.objects.select_related("calendar").order_by("name")
    serializer_class = ResourceSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name", "email"]
    ordering_fields = ["name"]

    def get_queryset(self) -> QuerySet[Resource]:
        # Resources are org-level, not project-scoped; return full set.
        return Resource.objects.select_related("calendar").order_by("name")


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
    total: Decimal = TaskResource.objects.filter(
        resource=resource,
        task__project_id=project_id,
        task__is_deleted=False,
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
        member_project_ids = ProjectMembership.objects.filter(
            user_id=self.request.user.pk,
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
        """Create a task-resource assignment and return any overallocation warnings.

        The assignment is always saved regardless of warnings — this is a soft
        alert, not a hard block. After commit, broadcasts ``assignment_created``
        to all clients subscribed to the project's WebSocket channel so the
        resource utilisation grid updates in real time (ADR-0028).
        """
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        obj: TaskResource = serializer.instance  # type: ignore[assignment]
        warnings = _check_overallocation(obj.resource, str(obj.task.project_id))
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
