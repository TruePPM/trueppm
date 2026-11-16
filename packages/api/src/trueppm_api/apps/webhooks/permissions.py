"""Permission classes specific to the webhook viewsets."""

from __future__ import annotations

from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import _mark_policy_refusal


class IsNotNarrowScopedToken(BasePermission):
    """Refuse a token that does not carry the full scope (``webhooks:manage`` etc.).

    Guards the webhook delivery log (#2414): its rows carry task notes, comment
    snippets and assignee emails (#903), so a narrow ``webhooks:manage`` token must
    not read it even though it can manage the webhook. Sessions, JWTs and
    full-access tokens pass, exactly as before the scope existed.
    """

    message = "This token's scope does not permit reading the webhook delivery log."

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.agents.models import RefusalConstraint
        from trueppm_api.apps.projects.models import ApiToken, has_full_scope

        token = getattr(request, "auth", None)
        if not isinstance(token, ApiToken) or has_full_scope(token.scopes):
            return True
        _mark_policy_refusal(request, RefusalConstraint.CAPABILITY_SCOPE)
        return False
