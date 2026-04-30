"""Permission classes for the workshops app."""

from __future__ import annotations

from typing import Any

from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import _membership_role


class IsProjectAdminOrSessionOwner(BasePermission):
    """Allow Project Manager (3+) or the user who started the session.

    Used on WorkshopEndView so the session initiator can always end their own
    session even if their role has been downgraded since the session started.
    """

    message = "Only the Project Manager or the session owner can end this workshop."

    def has_permission(self, request: Request, view: APIView) -> bool:
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        # obj is a WorkshopSession instance
        project_id = str(obj.project_id)
        role = _membership_role(request, project_id)
        if role is not None and role >= Role.ADMIN:
            return True
        # Session owner may also end their own session
        return obj.started_by_id is not None and obj.started_by_id == request.user.pk
