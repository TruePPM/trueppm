"""DRF permission classes and ProjectScopedViewSet mixin for RBAC."""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet
from rest_framework import viewsets
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role

# NOTE(issue-11): When BaselineViewSet is implemented, its create/update/destroy
# actions must use IsProjectScheduler (Resource Manager+). See role matrix §5.

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_project_id_from_obj(obj: Any) -> Any | None:
    """Extract the project PK from a model instance.

    Supports direct Project instances as well as any model with a project_id
    or project attribute (Task, Dependency, etc.).

    Uses isinstance to identify Project to avoid false-positives from future
    models that happen to have a 'memberships' attribute (M3 fix).
    """
    # Import here to avoid a module-level circular import (access → projects).
    from trueppm_api.apps.projects.models import Project

    if isinstance(obj, Project):
        return obj.pk
    if hasattr(obj, "project_id"):
        return obj.project_id
    if hasattr(obj, "project"):
        return obj.project_id
    # Dependency — look through predecessor__project_id
    if hasattr(obj, "predecessor_id"):
        predecessor = getattr(obj, "predecessor", None)
        if predecessor is not None:
            return predecessor.project_id
        return None
    return None


def _membership_role(request: Request, project_id: Any) -> int | None:
    """Return the requesting user's role ordinal for a project, or None if absent.

    Results are cached on the request object to prevent N+1 queries on list
    endpoints where has_object_permission is called once per row (L1 fix).
    The cache is keyed by str(project_id) and lives only for the request lifetime.

    Only active (non-soft-deleted) memberships are considered (M1 fix).
    """
    if not request.user or not request.user.is_authenticated:
        return None

    # Per-request cache: initialise lazily on the DRF request object.
    cache: dict[str, int | None] | None = getattr(request, "_rbac_role_cache", None)
    if cache is None:
        cache = {}
        request._rbac_role_cache = cache  # type: ignore[attr-defined]

    cache_key = str(project_id)
    if cache_key in cache:
        return cache[cache_key]

    try:
        membership = ProjectMembership.objects.get(
            project_id=project_id,
            user=request.user,
            is_deleted=False,  # M1: exclude soft-deleted memberships
        )
        role: int | None = membership.role
    except ProjectMembership.DoesNotExist:
        role = None

    cache[cache_key] = role
    return role


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
            # Org-level object (Calendar) — authentication is sufficient.
            return bool(request.user and request.user.is_authenticated)
        return _membership_role(request, project_id) is not None


class IsProjectMemberWrite(BasePermission):
    """Allow Team Member (1) or above to perform write operations.

    On safe methods falls back to IsProjectMember (Viewer+ may read).
    """

    message = "You need at least Team Member role to modify this project."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        if role is None:
            return False

        safe = request.method in ("GET", "HEAD", "OPTIONS")
        if safe:
            return True
        return role >= Role.MEMBER


class IsProjectMemberWriteOrOwn(BasePermission):
    """Assignee-scoped write permission for TaskViewSet update/destroy actions.

    Role matrix (issue #11):
      Viewer (0)           — read only
      Team Member (1)      — edit tasks where task.assignee == request.user
      Resource Manager (2) — read only (cannot edit task content, only assign)
      Project Manager (3+) — edit any task

    Safe methods (GET/HEAD/OPTIONS) allow any project member (Viewer+).

    Unassigned tasks (assignee=None) may only be edited by Project Manager+;
    a Team Member cannot claim or edit a task that has no assignee yet.
    """

    message = "You do not have permission to edit this task."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        if role is None:
            return False

        # Safe methods: any project member may read
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return True

        # Project Manager (3) and Project Admin (4): full write on any task
        if role >= Role.ADMIN:
            return True

        # Resource Manager (2): cannot edit task content (only resource assignment)
        if role == Role.SCHEDULER:
            return False

        # Team Member (1): may only edit their own assigned tasks
        if role == Role.MEMBER:
            assignee_id = getattr(obj, "assignee_id", None)
            return assignee_id is not None and assignee_id == request.user.pk

        # Viewer (0): no writes
        return False


class IsProjectScheduler(BasePermission):
    """Allow Resource Manager (2) or above.

    Used on: dependency creation/edit, future baseline creation (see module note).
    """

    message = "You need at least Resource Manager role for this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.SCHEDULER


class IsProjectAdmin(BasePermission):
    """Allow Project Manager (3) or above."""

    message = "You need at least Project Manager role for this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.ADMIN


class IsProjectOwner(BasePermission):
    """Allow only Project Admin (Owner, 4).

    Used for: ProjectViewSet.destroy (only Project Admin may delete a project).
    """

    message = "Only the Project Admin can perform this action."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role == Role.OWNER


class CanAssignResource(BasePermission):
    """Allow Resource Manager (2) or above to assign resources to tasks.

    Stub — used by a future ResourceAssignment viewset (issue #14).
    """

    message = "You need at least Resource Manager role to assign resources."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = _get_project_id_from_obj(obj)
        if project_id is None:
            return False
        role = _membership_role(request, project_id)
        return role is not None and role >= Role.SCHEDULER


# ---------------------------------------------------------------------------
# ProjectScopedViewSet mixin
# ---------------------------------------------------------------------------


class ProjectScopedViewSet(viewsets.GenericViewSet):  # type: ignore[type-arg]
    """Mixin that restricts every queryset to projects the user is a member of.

    Prevents IDOR: an unauthenticated or non-member request will receive an
    empty queryset rather than all objects in the database.

    Only active (non-soft-deleted) memberships grant queryset access (M1 fix).

    Subclasses should call super().get_queryset() and then apply additional
    filters on top of the membership-scoped queryset.
    """

    def get_queryset(self) -> QuerySet[Any]:
        qs = super().get_queryset()
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return qs.none()

        member_project_ids = ProjectMembership.objects.filter(
            user=user,
            is_deleted=False,  # M1: exclude soft-deleted memberships
        ).values_list("project_id", flat=True)

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
        # Calendar and other non-project-scoped models: fall through unfiltered.
        # Calendars are org-level shared resources; scoping is documented as
        # intentional for the OSS single-tenant model (M2 decision: accept).
        return qs
