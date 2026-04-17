"""REST API views for MS Project import/export."""

from __future__ import annotations

import base64
import logging

import redis as redis_lib
from kombu.exceptions import (  # type: ignore[import-untyped]
    OperationalError as KombuOperationalError,
)
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role

logger = logging.getLogger(__name__)

# Broker/connection errors that should return 503 — other exceptions bubble
# so programming bugs (serialization, argument mismatch) surface as 500.
_BROKER_ERRORS = (KombuOperationalError, ConnectionError, redis_lib.ConnectionError)

# Maximum upload size: 10 MB.
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

# Allowed file extensions.
_ALLOWED_EXTENSIONS = {"mpp", "xml"}


def _check_project_role(user: object, project_pk: str, min_role: int) -> None:
    """Verify the user has at least min_role on the project.

    Raises PermissionDenied if the membership does not exist or the role
    is below the required minimum.
    """
    membership = (
        ProjectMembership.objects.filter(
            project_id=project_pk,
            user=user,  # type: ignore[misc]
            is_deleted=False,
        )
        .values_list("role", flat=True)
        .first()
    )
    if membership is None or membership < min_role:
        raise PermissionDenied("You need at least Project Manager role for this action.")


def _check_project_member(user: object, project_pk: str) -> None:
    """Verify the user is a project member (any role)."""
    exists = ProjectMembership.objects.filter(
        project_id=project_pk,
        user=user,
        is_deleted=False,  # type: ignore[misc]
    ).exists()
    if not exists:
        raise PermissionDenied("You must be a member of this project.")


class MsProjectImportView(APIView):
    """Upload and import an MS Project file (.mpp or .xml).

    Requires project Admin role. The import runs asynchronously via Celery;
    the response includes the celery_task_id for progress tracking.
    """

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser]

    def post(self, request: Request, project_pk: str) -> Response:
        _check_project_role(request.user, project_pk, Role.ADMIN)

        uploaded_file = request.FILES.get("file")
        if not uploaded_file:
            return Response(
                {"detail": ("No file provided. Send a multipart form with a 'file' field.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        filename = uploaded_file.name or ""
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext not in _ALLOWED_EXTENSIONS:
            return Response(
                {"detail": (f"Unsupported file type: .{ext}. Allowed: .mpp, .xml")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if uploaded_file.size and uploaded_file.size > _MAX_UPLOAD_BYTES:
            size = uploaded_file.size
            return Response(
                {"detail": (f"File too large ({size} bytes). Maximum: 10 MB.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        file_content = uploaded_file.read()
        file_content_b64 = base64.b64encode(file_content).decode("ascii")

        from trueppm_api.apps.msproject.tasks import import_msproject

        try:
            result = import_msproject.delay(
                project_id=project_pk,
                file_content_b64=file_content_b64,
                filename=filename,
                initiated_by_id=request.user.pk,
            )
        except _BROKER_ERRORS:
            logger.exception("msproject import: broker unavailable for project %s", project_pk)
            return Response(
                {"detail": "Import could not be queued — task broker unavailable. Please retry."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(
            {
                "detail": "Import started.",
                "celery_task_id": result.id,
            },
            status=status.HTTP_202_ACCEPTED,
        )


class MsProjectExportView(APIView):
    """Export project schedule as MS Project XML.

    Requires project Member role (viewer or above).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, project_pk: str) -> Response:
        _check_project_member(request.user, project_pk)

        from trueppm_api.apps.projects.models import Project

        if not Project.objects.filter(pk=project_pk).exists():
            return Response(
                {"detail": "Project not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        from trueppm_api.apps.msproject.exporter import export_project_xml

        xml_bytes = export_project_xml(project_pk)

        return Response(
            xml_bytes,
            content_type="application/xml",
            headers={
                "Content-Disposition": (f'attachment; filename="project-{project_pk}.xml"'),
            },
        )
