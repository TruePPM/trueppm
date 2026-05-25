"""Workspace RBAC permission classes (ADR-0087 §6).

Mirrors the access app's ``_membership_role`` + per-request-cache pattern. The
key difference from project RBAC: every authenticated user has an *implicit*
workspace role even without a ``WorkspaceMembership`` row — Django superusers are
implicit OWNER (so the first admin can bootstrap the workspace), everyone else is
MEMBER. An explicit row overrides the implicit default; a ``deactivated`` status
revokes all access (role resolves to ``None``).
"""

from __future__ import annotations

from typing import Any

from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView

from trueppm_api.apps.workspace.models import MemberStatus, WorkspaceMembership, WorkspaceRole


def _workspace_membership_role(request: Request) -> int | None:
    """Return the requesting user's workspace role ordinal, or ``None`` if no access.

    Cached on the request for its lifetime to avoid re-querying on list endpoints.
    A ``deactivated`` membership returns ``None`` (no access). Users with no
    explicit membership row default to OWNER (superuser) or MEMBER.
    """
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return None

    cached = getattr(request, "_workspace_rbac_role", "unset")
    if cached != "unset":
        return cached  # type: ignore[return-value]

    membership = WorkspaceMembership.objects.filter(user=user, is_deleted=False).first()
    if membership is not None:
        role: int | None = (
            None if membership.status == MemberStatus.DEACTIVATED else membership.role
        )
    else:
        # Implicit default — superusers bootstrap as OWNER so a fresh install
        # has an admin who can manage the workspace before any row exists.
        role = WorkspaceRole.OWNER if user.is_superuser else WorkspaceRole.MEMBER

    request._workspace_rbac_role = role  # type: ignore[attr-defined]
    return role


class IsWorkspaceMember(BasePermission):
    """Any authenticated, non-deactivated user is a workspace member."""

    message = "You must be an active member of this workspace."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return _workspace_membership_role(request) is not None


class IsWorkspaceAdmin(BasePermission):
    """Read for any member; write (unsafe methods) requires ADMIN or above."""

    message = "You need workspace Admin access to perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        role = _workspace_membership_role(request)
        if role is None:
            return False
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        return role >= WorkspaceRole.ADMIN

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        return self.has_permission(request, view)
