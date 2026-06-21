"""URL routing for the workspace app (#517/#518/#519, ADR-0087)."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.workspace.views import (
    GroupDetailView,
    GroupListView,
    GroupMemberView,
    GroupProjectView,
    InviteAcceptView,
    TransferOwnershipView,
    WorkspaceAuditEventListView,
    WorkspaceExportDetailView,
    WorkspaceExportDownloadView,
    WorkspaceExportView,
    WorkspaceInviteDetailView,
    WorkspaceInviteListView,
    WorkspaceInviteResendAllView,
    WorkspaceInviteResendView,
    WorkspaceLogoView,
    WorkspaceMemberDetailView,
    WorkspaceMemberListView,
    WorkspaceSettingsView,
)

urlpatterns = [
    # #517 — General settings (singleton); DELETE = hard delete (#641, ADR-0092)
    path("workspace/", WorkspaceSettingsView.as_view(), name="workspace-settings"),
    # #969 — Workspace logo (ADR-0149); GET public, POST/DELETE admin
    path("workspace/logo/", WorkspaceLogoView.as_view(), name="workspace-logo"),
    # #641 — Lifecycle (ADR-0092)
    path(
        "workspace/transfer-ownership/",
        TransferOwnershipView.as_view(),
        name="workspace-transfer-ownership",
    ),
    path("workspace/export/", WorkspaceExportView.as_view(), name="workspace-export"),
    path(
        "workspace/export/<uuid:job_id>/",
        WorkspaceExportDetailView.as_view(),
        name="workspace-export-detail",
    ),
    path(
        "workspace/export/<uuid:job_id>/download/",
        WorkspaceExportDownloadView.as_view(),
        name="workspace-export-download",
    ),
    # #859 — Operational audit log (ADR-0157); Owner/Admin read-only
    path(
        "workspace/audit-events/",
        WorkspaceAuditEventListView.as_view(),
        name="workspace-audit-events",
    ),
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
    # #969 — Resend invite emails (ADR-0149); bulk route before the uuid detail route
    path(
        "workspace/invites/resend-all/",
        WorkspaceInviteResendAllView.as_view(),
        name="workspace-invite-resend-all",
    ),
    path(
        "workspace/invites/<uuid:invite_id>/resend/",
        WorkspaceInviteResendView.as_view(),
        name="workspace-invite-resend",
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
