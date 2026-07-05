"""URL routing for the access app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.access.views import (
    MeView,
    ProgramMembershipViewSet,
    ProjectMembershipViewSet,
    UserDefinedMentionGroupViewSet,
    UserSearchView,
)
from trueppm_api.apps.profiles.views import MyProfileView

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
_program_members = ProgramMembershipViewSet.as_view(
    {
        "get": "list",
        "post": "create",
    }
)
_program_member_detail = ProgramMembershipViewSet.as_view(
    {
        "get": "retrieve",
        "patch": "partial_update",
        "delete": "destroy",
    }
)
_mention_groups = UserDefinedMentionGroupViewSet.as_view(
    {
        "get": "list",
        "post": "create",
    }
)
_mention_group_detail = UserDefinedMentionGroupViewSet.as_view(
    {
        "get": "retrieve",
        "patch": "partial_update",
        "delete": "destroy",
    }
)
_mention_group_add_member = UserDefinedMentionGroupViewSet.as_view({"post": "add_member"})
_mention_group_remove_member = UserDefinedMentionGroupViewSet.as_view({"post": "remove_member"})
_mention_group_mute = UserDefinedMentionGroupViewSet.as_view({"post": "mute"})
_mention_group_unmute = UserDefinedMentionGroupViewSet.as_view({"post": "unmute"})

urlpatterns = [
    path("auth/me/", MeView.as_view(), name="auth-me"),
    path("auth/me/profile/", MyProfileView.as_view(), name="auth-me-profile"),
    path("users/search/", UserSearchView.as_view(), name="user-search"),
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
    path(
        "programs/<uuid:program_pk>/members/",
        _program_members,
        name="program-members-list",
    ),
    path(
        "programs/<uuid:program_pk>/members/<uuid:pk>/",
        _program_member_detail,
        name="program-members-detail",
    ),
    path(
        "projects/<uuid:project_pk>/mention-groups/",
        _mention_groups,
        name="project-mention-groups-list",
    ),
    path(
        "projects/<uuid:project_pk>/mention-groups/<uuid:pk>/",
        _mention_group_detail,
        name="project-mention-groups-detail",
    ),
    path(
        "projects/<uuid:project_pk>/mention-groups/<uuid:pk>/add-member/",
        _mention_group_add_member,
        name="project-mention-groups-add-member",
    ),
    path(
        "projects/<uuid:project_pk>/mention-groups/<uuid:pk>/remove-member/",
        _mention_group_remove_member,
        name="project-mention-groups-remove-member",
    ),
    path(
        "projects/<uuid:project_pk>/mention-groups/<uuid:pk>/mute/",
        _mention_group_mute,
        name="project-mention-groups-mute",
    ),
    path(
        "projects/<uuid:project_pk>/mention-groups/<uuid:pk>/unmute/",
        _mention_group_unmute,
        name="project-mention-groups-unmute",
    ),
]
