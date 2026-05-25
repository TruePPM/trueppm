"""URL routing for the workspace app (#517/#518/#519, ADR-0087)."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.workspace.views import (
    GroupDetailView,
    GroupListView,
    GroupMemberView,
    GroupProjectView,
    InviteAcceptView,
    WorkspaceInviteDetailView,
    WorkspaceInviteListView,
    WorkspaceMemberDetailView,
    WorkspaceMemberListView,
    WorkspaceSettingsView,
)

urlpatterns = [
    # #517 — General settings (singleton)
    path("workspace/", WorkspaceSettingsView.as_view(), name="workspace-settings"),
    # #518 — Members
    path("workspace/members/", WorkspaceMemberListView.as_view(), name="workspace-members"),
    path(
        "workspace/members/<int:user_id>/",
        WorkspaceMemberDetailView.as_view(),
        name="workspace-member-detail",
    ),
    # #518 — Invites
    path("workspace/invites/", WorkspaceInviteListView.as_view(), name="workspace-invites"),
    path(
        "workspace/invites/accept/",
        InviteAcceptView.as_view(),
        name="workspace-invite-accept",
    ),
    path(
        "workspace/invites/<uuid:invite_id>/",
        WorkspaceInviteDetailView.as_view(),
        name="workspace-invite-detail",
    ),
    # #519 — Groups & teams
    path("workspace/groups/", GroupListView.as_view(), name="workspace-groups"),
    path(
        "workspace/groups/<uuid:group_id>/",
        GroupDetailView.as_view(),
        name="workspace-group-detail",
    ),
    path(
        "workspace/groups/<uuid:group_id>/members/",
        GroupMemberView.as_view(),
        name="workspace-group-members",
    ),
    path(
        "workspace/groups/<uuid:group_id>/members/<int:user_id>/",
        GroupMemberView.as_view(),
        name="workspace-group-member-detail",
    ),
    path(
        "workspace/groups/<uuid:group_id>/projects/",
        GroupProjectView.as_view(),
        name="workspace-group-projects",
    ),
    path(
        "workspace/groups/<uuid:group_id>/projects/<uuid:project_id>/",
        GroupProjectView.as_view(),
        name="workspace-group-project-detail",
    ),
]
