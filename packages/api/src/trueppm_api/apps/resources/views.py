"""DRF ViewSets for the resources app."""

from __future__ import annotations

from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from trueppm_api.apps.access.permissions import IsProjectMember, ProjectScopedViewSet
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.serializers import ResourceSerializer, TaskResourceSerializer


class ResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet):
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

    def get_queryset(self) -> object:  # type: ignore[override]
        # Resources are org-level, not project-scoped; return full set.
        return Resource.objects.select_related("calendar").order_by("name")


class TaskResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet):
    """CRUD for task-resource assignments."""

    permission_classes = [IsAuthenticated, IsProjectMember]
    serializer_class = TaskResourceSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = TaskResource.objects.select_related("task", "resource")

    def get_queryset(self) -> object:  # type: ignore[override]
        qs = super().get_queryset()  # type: ignore[misc]
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)  # type: ignore[union-attr]
        resource_id = self.request.query_params.get("resource")
        if resource_id:
            qs = qs.filter(resource_id=resource_id)  # type: ignore[union-attr]
        return qs
