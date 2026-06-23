"""Decisions-view visibility consent endpoint (ADR-0167 §3, #748).

Surface:
  GET   /api/v1/projects/<project_pk>/decisions-policy/   — read posture (+ can_edit)
  PATCH /api/v1/projects/<project_pk>/decisions-policy/   — set oversight_visible (Admin+)

The single ``oversight_visible`` switch is the team's upward-exposure control for the
project Decisions view. Default-closed; widening to oversight readers is a project-Admin
act (the team-admin authority in the OSS single-project model). The matching read gate is
``decisions_services.can_read_decisions``.
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    IsProjectNotArchived,
    _membership_role,
)
from trueppm_api.apps.projects.decisions_services import get_or_create_decisions_policy
from trueppm_api.apps.projects.models import Project


class DecisionsPolicyReadSerializer(serializers.Serializer[Any]):
    """Read shape: the current posture plus whether the requester may change it."""

    oversight_visible = serializers.BooleanField()
    can_edit = serializers.BooleanField()


class DecisionsPolicyWriteSerializer(serializers.Serializer[Any]):
    """PATCH body — flip the team's single oversight-visibility switch."""

    oversight_visible = serializers.BooleanField()


class ProjectDecisionsPolicyView(APIView):
    """GET the decisions-visibility posture; PATCH ``oversight_visible`` (Admin+)."""

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]  # noqa: RUF012

    def _project(self, project_pk: str) -> Project:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)
        return project

    def _payload(
        self, request: Request, project_id: Any, oversight_visible: bool
    ) -> dict[str, Any]:
        role = _membership_role(request, project_id)
        can_edit = role is not None and role >= Role.ADMIN
        return {"oversight_visible": oversight_visible, "can_edit": can_edit}

    @extend_schema(
        summary="Read the Decisions-view visibility posture",
        responses=DecisionsPolicyReadSerializer,
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        policy = get_or_create_decisions_policy(project)
        return Response(self._payload(request, project.pk, policy.oversight_visible))

    @extend_schema(
        summary="Set whether oversight readers may see the Decisions view (Admin+)",
        request=DecisionsPolicyWriteSerializer,
        responses=DecisionsPolicyReadSerializer,
    )
    def patch(self, request: Request, project_pk: str) -> Response:
        project = self._project(project_pk)
        role = _membership_role(request, project.pk)
        # Team-admin consent (ADR-0167 §3): only a project Admin+ may widen or narrow the
        # team's upward exposure. Read stays any-member; the write is the consent act.
        if role is None or role < Role.ADMIN:
            raise PermissionDenied("Only a project admin can change who sees the Decisions view.")
        body = DecisionsPolicyWriteSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        policy = get_or_create_decisions_policy(project)
        policy.oversight_visible = body.validated_data["oversight_visible"]
        # Plain save (not update_fields) so VersionedModel bumps server_version and
        # HistoricalRecords captures who flipped the switch.
        policy.save()
        return Response(self._payload(request, project.pk, policy.oversight_visible))
