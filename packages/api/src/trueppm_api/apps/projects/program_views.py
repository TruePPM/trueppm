"""ViewSets for the Program entity (ADR-0070).

Programs are top-level (not project-scoped), so they live in their own viewset
rather than under the ProjectViewSet nesting. Membership is nested separately
in the access app, mirroring how :class:`ProjectMembershipViewSet` lives next
to :class:`ProjectViewSet`.

This module is intentionally thin — the heavy lifting (atomic creation, cascade
delete, role checks) is in :mod:`trueppm_api.apps.access.services` and
:mod:`trueppm_api.apps.access.permissions`.
"""

from __future__ import annotations

from typing import Any

from django.db.models import Count, OuterRef, Q, QuerySet, Subquery
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.models import ProgramMembership
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramOwner,
)
from trueppm_api.apps.access.services import create_program, delete_program_cascade
from trueppm_api.apps.projects.models import Methodology, Program, Project
from trueppm_api.apps.projects.serializers import ProgramSerializer, ProjectSerializer


class ProgramViewSet(viewsets.ModelViewSet[Program]):
    """CRUD for programs.

    URL: ``/api/v1/programs/``

    Permission matrix (ADR-0070 §RBAC):
      list      — IsAuthenticated; queryset filtered to programs the caller is a member of
      retrieve  — IsProgramMember (Viewer+)
      create    — IsAuthenticated; caller auto-becomes OWNER via ``create_program``
      update    — IsProgramAdmin
      destroy   — IsProgramOwner; cascade-removes memberships in one transaction
    """

    serializer_class = ProgramSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("update", "partial_update"):
            return [IsAuthenticated(), IsProgramAdmin()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProgramOwner()]
        if self.action in ("retrieve", "projects", "integrations_summary"):
            return [IsAuthenticated(), IsProgramMember()]
        return [IsAuthenticated()]

    def get_queryset(self) -> QuerySet[Program]:
        """Programs visible to the current user (those they have membership on).

        Annotates ``_my_role`` (caller's role on each program), ``project_count``,
        and ``member_count`` so the serializer can render the role chip and
        counts without N+1 queries.
        """
        user = self.request.user
        if not (user and user.is_authenticated):
            return Program.objects.none()

        my_role_sq = ProgramMembership.objects.filter(
            program=OuterRef("pk"),
            user=user,
            is_deleted=False,
        ).values("role")[:1]

        qs = (
            Program.objects.filter(
                is_deleted=False,
                memberships__user=user,
                memberships__is_deleted=False,
            )
            # select_related on ``lead`` so ProgramSerializer.lead_detail does not
            # incur one extra User query per program on list responses (#523).
            .select_related("lead")
            .annotate(
                _my_role=Subquery(my_role_sq),
                project_count=Count(
                    "projects",
                    distinct=True,
                    filter=Q(projects__is_deleted=False),
                ),
                member_count=Count(
                    "memberships",
                    distinct=True,
                    filter=Q(memberships__is_deleted=False),
                ),
            )
            .order_by("name")
        )
        return qs

    # -----------------------------------------------------------------------
    # CRUD
    # -----------------------------------------------------------------------

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        write = ProgramSerializer(data=request.data)
        write.is_valid(raise_exception=True)

        # Service-layer call wraps the Program + OWNER membership in a single
        # transaction — see ADR-0070 §Durable Execution.
        program = create_program(
            name=write.validated_data["name"],
            description=write.validated_data.get("description", ""),
            methodology=write.validated_data.get("methodology", Methodology.HYBRID),
            created_by=request.user,
        )

        # Re-fetch through the get_queryset so the response includes my_role
        # and the count annotations.
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_201_CREATED)

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        instance = self.get_object()
        delete_program_cascade(instance.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -----------------------------------------------------------------------
    # Custom actions
    # -----------------------------------------------------------------------

    @action(detail=True, methods=["get"], url_path="projects")
    def projects(self, request: Request, pk: str | None = None) -> Response:
        """List projects in this program.

        URL: ``GET /api/v1/programs/{pk}/projects/``

        Permission: IsProgramMember (any program role can see the project list,
        but the project itself only opens if the user also has project membership
        — that gate is enforced by the project's own viewset on click-through).
        """
        program = self.get_object()
        qs = Project.objects.filter(program=program, is_deleted=False).order_by(
            "start_date", "name"
        )
        return Response(ProjectSerializer(qs, many=True).data)

    @action(detail=True, methods=["get"], url_path="integrations-summary")
    def integrations_summary(self, request: Request, pk: str | None = None) -> Response:
        """Program-scoped integrations summary (ADR-0076).

        URL: ``GET /api/v1/programs/{pk}/integrations-summary/``

        Returns the program's outbound webhooks and inbound API tokens that
        are scoped to the program itself — does NOT bubble up resources from
        child projects (those have their own per-project summaries).

        Same shape and per-section 503 fallback semantics as the project
        endpoint so the frontend can re-use the hook contract.
        """
        import logging

        from django.db.models import Q
        from rest_framework import status as drf_status

        from trueppm_api.apps.projects.views import (
            _summarize_api_tokens,
            _summarize_webhooks,
        )

        logger = logging.getLogger(__name__)

        program = self.get_object()
        sections: dict[str, Any] = {}

        try:
            sections["webhooks"] = _summarize_webhooks(Q(program_id=program.id))
        except Exception:
            logger.exception("program integrations-summary webhooks subservice failed")
            return Response(
                {"failed": "webhooks"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            sections["api_tokens"] = _summarize_api_tokens(Q(program_id=program.id))
        except Exception:
            logger.exception("program integrations-summary api_tokens subservice failed")
            return Response(
                {"failed": "api_tokens"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(sections, status=drf_status.HTTP_200_OK)
