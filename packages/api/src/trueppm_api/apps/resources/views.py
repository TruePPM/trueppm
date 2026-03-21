"""DRF ViewSets for the resources app."""

from __future__ import annotations

from django.db.models import QuerySet
from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from trueppm_api.apps.access.permissions import IsProjectMember, ProjectScopedViewSet
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.serializers import ResourceSerializer, TaskResourceSerializer


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


class TaskResourceViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[TaskResource]):
    """CRUD for task-resource assignments."""

    permission_classes = [IsAuthenticated, IsProjectMember]
    serializer_class = TaskResourceSerializer
    filter_backends = [filters.OrderingFilter]
    queryset = TaskResource.objects.select_related("task", "resource")

    def get_queryset(self) -> QuerySet[TaskResource]:
        qs = super().get_queryset()
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)
        resource_id = self.request.query_params.get("resource")
        if resource_id:
            qs = qs.filter(resource_id=resource_id)
        return qs
