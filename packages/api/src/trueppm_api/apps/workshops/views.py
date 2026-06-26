"""Views for the workshops app."""

from __future__ import annotations

from django.db import IntegrityError
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.workshops.models import WorkshopSession
from trueppm_api.apps.workshops.permissions import IsProjectAdminOrSessionOwner
from trueppm_api.apps.workshops.serializers import WorkshopSessionSerializer
from trueppm_api.apps.workshops.services import end_workshop, force_end_workshop, start_workshop


class WorkshopStartView(IdempotencyMixin, APIView):
    """Start a workshop session for a project.

    POST /api/v1/projects/{pk}/workshop/start/

    Only Project Managers (ADMIN+) may start a session.  Returns 409 if an
    active session already exists (enforced by the DB unique constraint).
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]

    @extend_schema(
        responses={201: WorkshopSessionSerializer, 409: None},
        summary="Start a workshop session",
        tags=["workshops"],
    )
    def post(self, request: Request, pk: str) -> Response:
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        try:
            session = start_workshop(project, request.user)  # type: ignore[arg-type]
        except IntegrityError:
            return Response(
                {"detail": "A workshop session is already active for this project."},
                status=status.HTTP_409_CONFLICT,
            )
        # Re-fetch with participants prefetched so the serializer's nested
        # participant list is populated without N+1 queries.
        session = WorkshopSession.objects.prefetch_related("participants__user").get(pk=session.pk)
        return Response(WorkshopSessionSerializer(session).data, status=status.HTTP_201_CREATED)


class WorkshopEndView(IdempotencyMixin, APIView):
    """End the active workshop session for a project.

    POST /api/v1/projects/{pk}/workshop/end/

    Either the Project Manager (ADMIN+) or the user who started the session may
    end it (IsProjectAdminOrSessionOwner).
    """

    permission_classes = [IsAuthenticated, IsProjectAdminOrSessionOwner, IsProjectNotArchived]

    @extend_schema(
        responses={200: WorkshopSessionSerializer, 404: None},
        summary="End the active workshop session",
        tags=["workshops"],
    )
    def post(self, request: Request, pk: str) -> Response:
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        # Check project membership before revealing whether a session exists,
        # preventing non-members from enumerating active workshop sessions.
        if not IsProjectMember().has_object_permission(request, self, project):
            return self.permission_denied(request)
        try:
            session = WorkshopSession.objects.get(project=project, ended_at__isnull=True)
        except WorkshopSession.DoesNotExist:
            return Response(
                {"detail": "No active workshop session found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        self.check_object_permissions(request, session)
        session = end_workshop(session, request.user)  # type: ignore[arg-type]
        # Re-fetch with participants prefetched so the serializer's nested
        # participant list is populated without N+1 queries.
        session = WorkshopSession.objects.prefetch_related("participants__user").get(pk=session.pk)
        return Response(WorkshopSessionSerializer(session).data)


class WorkshopForceEndView(IdempotencyMixin, APIView):
    """Force-end the active workshop session (admin recovery for crashed sessions).

    POST /api/v1/projects/{pk}/workshop/force-end/

    Requires ADMIN+. Returns 404 if no session is active.
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]

    @extend_schema(
        responses={200: WorkshopSessionSerializer, 404: None},
        summary="Force-end the active workshop session",
        tags=["workshops"],
    )
    def post(self, request: Request, pk: str) -> Response:
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        session = force_end_workshop(project)
        if session is None:
            return Response(
                {"detail": "No active workshop session found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        # Re-fetch with participants prefetched so the serializer's nested
        # participant list is populated without N+1 queries.
        session = WorkshopSession.objects.prefetch_related("participants__user").get(pk=session.pk)
        return Response(WorkshopSessionSerializer(session).data)


class WorkshopCurrentView(APIView):
    """Retrieve the current active workshop session for a project.

    GET /api/v1/projects/{pk}/workshop/current/

    Returns the active session with nested participants, or 404 if none active.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        responses={200: WorkshopSessionSerializer, 404: None},
        summary="Get the active workshop session",
        tags=["workshops"],
    )
    def get(self, request: Request, pk: str) -> Response:
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        try:
            session = WorkshopSession.objects.prefetch_related("participants__user").get(
                project=project, ended_at__isnull=True
            )
        except WorkshopSession.DoesNotExist:
            return Response(
                {"detail": "No active workshop session."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(WorkshopSessionSerializer(session).data)
