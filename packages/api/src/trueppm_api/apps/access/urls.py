"""URL routing for the access app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.access.views import ProjectMembershipViewSet

_members = ProjectMembershipViewSet.as_view(
    {
        "get": "list",
        "post": "create",
    }
)
_member_detail = ProjectMembershipViewSet.as_view(
    {
        "get": "retrieve",
        "patch": "partial_update",
        "delete": "destroy",
    }
)

urlpatterns = [
    path(
        "projects/<uuid:project_pk>/members/",
        _members,
        name="project-members-list",
    ),
    path(
        "projects/<uuid:project_pk>/members/<uuid:pk>/",
        _member_detail,
        name="project-members-detail",
    ),
]
