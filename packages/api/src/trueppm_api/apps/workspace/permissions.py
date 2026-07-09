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


def workspace_role_for_user(user: Any) -> int | None:
    """Resolve a user's effective workspace role ordinal (ADR-0087 §6).

    The single source of truth for "what workspace role does this user hold". An
    explicit, non-deleted ``WorkspaceMembership`` wins (a ``deactivated`` status
    resolves to ``None`` — no access); absent any row, a Django superuser is the
    implicit OWNER (so the first admin can bootstrap a fresh install before any
    membership exists) and every other authenticated user is the implicit MEMBER
    (every authenticated user is a workspace member). Anonymous/unauthenticated
    resolves to ``None``.

    This is deliberately a pure ``user``-keyed function (not request-keyed) so
    both the request-scoped permission helper *and* the ``/auth/me`` serializer
    can call it: the implicit-OWNER bootstrap previously lived only in the
    permission layer, so ``MeSerializer`` reported ``can_access_admin_settings``
    false for a superuser who could in fact write workspace settings — the web
    Sidebar then routed Settings to ``/me/settings/notifications`` and
    ``RequireAdminSettings`` bounced them off ``/settings``. Keeping one helper
    means the advertised signal can never drift from what RBAC enforces again.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    membership = WorkspaceMembership.objects.filter(user=user, is_deleted=False).first()
    if membership is not None:
        return None if membership.status == MemberStatus.DEACTIVATED else int(membership.role)
    return WorkspaceRole.OWNER if user.is_superuser else WorkspaceRole.MEMBER


def _workspace_membership_role(request: Request) -> int | None:
    """Return the requesting user's workspace role ordinal, or ``None`` if no access.

    Cached on the request for its lifetime to avoid re-querying on list endpoints.
    Delegates the role resolution itself to :func:`workspace_role_for_user`.
    """
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return None

    cached = getattr(request, "_workspace_rbac_role", "unset")
    if cached != "unset":
        return cached  # type: ignore[return-value]

    role = workspace_role_for_user(user)

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


class IsWorkspaceOwner(BasePermission):
    """OWNER required for **every** method, reads included.

    Gates the workspace lifecycle endpoints (transfer ownership, export create /
    status / download), which hand off or expose the entire workspace — so even a
    read (polling export status, downloading the archive) must be owner-only; a
    full-workspace archive must never be reachable by a non-owner member. A Django
    superuser with no explicit row resolves to OWNER (bootstrap), matching
    ``IsWorkspaceAdmin``.
    """

    message = "Only the workspace Owner can perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        role = _workspace_membership_role(request)
        return role is not None and role >= WorkspaceRole.OWNER

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        return self.has_permission(request, view)


class IsWorkspaceAuditViewer(BasePermission):
    """ADMIN+ required for **every** method, reads included (ADR-0157, #859).

    The audit log is Owner/Admin-visible only. ``IsWorkspaceAdmin`` is too loose
    here — it admits any member on safe methods, but a plain Member must not read
    who-did-what operational history. ``IsWorkspaceOwner`` is too strict (the log
    is explicitly Admin-visible). This sits between them: ADMIN on all methods.
    """

    message = "You need workspace Admin access to view the audit log."

    def has_permission(self, request: Request, view: APIView) -> bool:
        role = _workspace_membership_role(request)
        return role is not None and role >= WorkspaceRole.ADMIN

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        return self.has_permission(request, view)


class IsWorkspaceAdminStrict(BasePermission):
    """ADMIN+ required for **every** method, reads included (#1724).

    ``IsWorkspaceAdmin`` admits any member on safe methods, because every
    authenticated user is an *implicit* workspace MEMBER (see
    ``workspace_role_for_user``). That is correct for member-visible resources,
    but wrong for admin-only collections whose GET leaks PII or org structure —
    pending invites (email / role / invited_by) and group rosters. Those reads
    must be gated exactly like their writes: ADMIN on all methods. This is the
    same shape as ``IsWorkspaceAuditViewer`` without the audit-specific message.
    """

    message = "You need workspace Admin access to perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        role = _workspace_membership_role(request)
        return role is not None and role >= WorkspaceRole.ADMIN

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        return self.has_permission(request, view)


def request_is_workspace_owner(request: Request) -> bool:
    """True when the requesting user holds the workspace OWNER role.

    Used by views (e.g. ``WorkspaceSettingsView.delete``) that mix permission
    tiers across methods and so cannot express "Owner-only" as a single
    class-level permission.
    """
    role = _workspace_membership_role(request)
    return role is not None and role >= WorkspaceRole.OWNER
