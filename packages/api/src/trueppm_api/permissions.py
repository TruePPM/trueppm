"""Custom DRF permission classes for TruePPM."""

from __future__ import annotations

from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView


class IsProjectMember(BasePermission):
    """Allow access only to members of the project being accessed.

    Phase 1 stub: permits any authenticated user. The full implementation will
    enforce the 5-role RBAC model (Owner, Admin, Scheduler, Member, Viewer)
    once the ProjectMembership model is introduced in Phase 2.

    Replacing has_object_permission() with membership-scoped logic is the only
    change needed to activate enforcement — all ViewSets are already wired.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: object) -> bool:
        # TODO(phase-2): check request.user has a ProjectMembership row for the
        # project associated with obj before returning True.
        return bool(request.user and request.user.is_authenticated)
