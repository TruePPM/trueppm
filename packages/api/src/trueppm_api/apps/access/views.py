"""ViewSets for the access app."""

from __future__ import annotations

from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import IsProjectAdmin
from trueppm_api.apps.access.serializers import ProjectMembershipSerializer


class ProjectMembershipViewSet(viewsets.ModelViewSet):
    """CRUD for project memberships.

    Creating, updating, and deleting memberships requires Admin role on the
    project. Reading the membership list requires at least membership existence
    (enforced by queryset scoping — non-members see an empty list).
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin]
    serializer_class = ProjectMembershipSerializer

    def get_queryset(self) -> object:
        qs = ProjectMembership.objects.select_related("project", "user")
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs
