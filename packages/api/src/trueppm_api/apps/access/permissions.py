"""DRF permission classes and ProjectScopedViewSet mixin for RBAC."""

from __future__ import annotations

import uuid
from typing import Any

from rest_framework import viewsets
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_project_id_from_obj(obj: Any) -> uuid.UUID | str | None:
    """Extract the project PK from a model instance.

    Supports direct Project instances (where the PK is the project id) as
    well as any model with a project_id attribute (Task, Dependency, etc.).
    """
    # Direct Project instance
    if hasattr(obj, "memberships"):
        # Project model — its own PK is the project id
        return obj.pk  # type: ignore[no-any-return]
    if hasattr(obj, "project_id"):
        return obj.project_id  # type: ignore[no-any-return]
    if hasattr(obj, "project"):
        return obj.project_id  # type: ignore[no-any-return]
    # Dependency — look through predecessor__project_id
    if hasattr(obj, "predecessor_id"):
        return getattr(obj, "predecessor__project_id", None) or (
            obj.predecessor.project_id if obj.predecessor_id else None  # type: ignore[union-attr]
        )
    return None


def _membership_role(request: Request, project_id: Any) -> int | None:
    """Return the requesting user's role ordinal for a project, or None if absent."""
    if not request.user or not request.user.is_authenticated:
        return None
    try:
        membership = ProjectMembership.objects.get(project_id=project_id, user=request.user)
        return membership.role
    except ProjectMembership.DoesNotExist:
        return None


# ---------------------------------------------------------------------------
# Permission classes
# ---------------------------------------------------------------------------


class IsProjectMember(BasePermission):
    """Allow any project member (Viewer or above) to read; enforce membership on objects.

    List/create endpoints: user must be authenticated.
    Object endpoints: user must have a ProjectMembership row (any role ≥ Viewer).
    """

    message = "You must be a member of this project."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        return _membership_role(request, project_id) is not None


class IsProjectMemberWrite(BasePermission):
    """Allow Member (1) or above to perform write operations.

    On safe methods falls back to IsProjectMember (Viewer+ may read).
    """

    message = "You need at least Member role to modify this project."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        if role is None:
            return False
        from rest_framework.request import Request as DRFRequest

        safe = request.method in ("GET", "HEAD", "OPTIONS")
        if safe:
            return True
        return role >= Role.MEMBER


class IsProjectScheduler(BasePermission):
    """Allow Scheduler (2) or above."""

    message = "You need at least Scheduler role for this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.SCHEDULER


class IsProjectAdmin(BasePermission):
    """Allow Admin (3) or above."""

    message = "You need at least Admin role for this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.ADMIN


class IsProjectOwner(BasePermission):
    """Allow only Owner (4)."""

    message = "Only the project Owner can perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role == Role.OWNER


# ---------------------------------------------------------------------------
# ProjectScopedViewSet mixin
# ---------------------------------------------------------------------------


class ProjectScopedViewSet(viewsets.GenericViewSet):
    """Mixin that restricts every queryset to projects the user is a member of.

    Prevents IDOR: an unauthenticated or non-member request will receive an
    empty queryset rather than all objects in the database.

    Subclasses should call super().get_queryset() and then apply additional
    filters on top of the membership-scoped queryset.
    """

    def get_queryset(self) -> Any:
        qs = super().get_queryset()  # type: ignore[misc]
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return qs.none()  # type: ignore[union-attr]

        member_project_ids = ProjectMembership.objects.filter(user=user).values_list(
            "project_id", flat=True
        )

        # Determine the project FK path. Projects are their own primary key.
        # Tasks, Dependencies, and other models have project_id or
        # predecessor__project_id.
        model = qs.model
        field_names = {f.name for f in model._meta.get_fields()}

        if "project" in field_names:
            return qs.filter(project_id__in=member_project_ids)
        if "predecessor" in field_names:
            # Dependency: filter through predecessor's project
            return qs.filter(predecessor__project_id__in=member_project_ids)
        # Project itself — filter by PK membership
        if model.__name__ == "Project":
            return qs.filter(pk__in=member_project_ids)
        # Resource and other non-project-scoped models: fall through unfiltered
        # (resources are org-level, not project-scoped).
        return qs
