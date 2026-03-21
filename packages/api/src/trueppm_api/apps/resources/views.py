"""DRF ViewSets for the resources app."""

from __future__ import annotations

from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.serializers import ResourceSerializer, TaskResourceSerializer
from trueppm_api.permissions import IsProjectMember


class ResourceViewSet(viewsets.ModelViewSet):
    """CRUD for resources (people, teams, materials)."""

    permission_classes = [IsAuthenticated, IsProjectMember]
    queryset = Resource.objects.select_related("calendar").order_by("name")
    serializer_class = ResourceSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name", "email"]
    ordering_fields = ["name"]


class TaskResourceViewSet(viewsets.ModelViewSet):
    """CRUD for task-resource assignments."""

    permission_classes = [IsAuthenticated, IsProjectMember]
    serializer_class = TaskResourceSerializer
    filter_backends = [filters.OrderingFilter]

    def get_queryset(self):  # type: ignore[override]
        qs = TaskResource.objects.select_related("task", "resource")
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)
        resource_id = self.request.query_params.get("resource")
        if resource_id:
            qs = qs.filter(resource_id=resource_id)
        return qs
