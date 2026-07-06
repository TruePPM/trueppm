"""REST API view for offline Jira XML import."""

from __future__ import annotations

import base64
import logging
import os
import re

from django.conf import settings
from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import IsProjectAdmin, IsProjectNotArchived
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

logger = logging.getLogger(__name__)

# Only XML is accepted: it is the sole Jira export that carries <issuelinks>
# (CSV does not), and links are what make the network CPM-computable (ADR-0259).
_ALLOWED_EXTENSIONS = {"xml"}
# Allow-list (mirrors the hardened MS Project sanitizer, #816): substitute
# anything outside a conservative safe set so an attacker-controlled
# UploadedFile.name can never carry an HTML/Content-Disposition-injection
# payload into a future provenance/list surface. os.path.basename below blocks
# path traversal.
_FILENAME_ALLOWED = re.compile(r"[^A-Za-z0-9._\- ()]")


def _sanitize_filename(raw: str) -> str:
    name = os.path.basename(raw or "")
    name = _FILENAME_ALLOWED.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:255] or "upload.xml"


def _require_project_admin(user: object, project_pk: str) -> None:
    """Authoritative in-body Admin check (defense-in-depth behind IsProjectAdmin)."""
    role = (
        ProjectMembership.objects.filter(
            project_id=project_pk,
            user=user,  # type: ignore[misc]
            is_deleted=False,
        )
        .values_list("role", flat=True)
        .first()
    )
    if role is None or role < Role.ADMIN:
        raise PermissionDenied("You need at least Project Admin role to import.")


def _read_validated_upload(request: Request) -> tuple[str, str] | Response:
    """Read the multipart ``file`` field; validate extension + size.

    Returns ``(filename, file_content_b64)`` or a 400 ``Response``.
    """
    uploaded_file = request.FILES.get("file")
    if not uploaded_file:
        return Response(
            {"detail": "No file provided. Send a multipart form with a 'file' field."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    filename = _sanitize_filename(uploaded_file.name or "")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in _ALLOWED_EXTENSIONS:
        return Response(
            {"detail": f"Unsupported file type: .{ext}. Export your Jira issues as XML."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    max_bytes = settings.JIRA_IMPORT_MAX_UPLOAD_MB * 1024 * 1024
    if uploaded_file.size and uploaded_file.size > max_bytes:
        return Response(
            {
                "detail": (
                    f"File too large ({uploaded_file.size} bytes). "
                    f"Maximum: {settings.JIRA_IMPORT_MAX_UPLOAD_MB} MB."
                )
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    file_content_b64 = base64.b64encode(uploaded_file.read()).decode("ascii")
    return filename, file_content_b64


class JiraImportView(IdempotencyMixin, APIView):
    """Upload and import a Jira XML export into an existing project.

    Requires project Admin role. The import runs asynchronously via Celery; the
    202 response carries the ``import_request_id`` for progress tracking.
    """

    # Multipart upload, deduped at the table level via JiraImportRequest.
    idempotency_exempt = True
    # IsProjectAdmin gates at the DRF layer (OpenAPI-visible, enforced before the
    # body); the in-body _require_project_admin below stays authoritative.
    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Import a Jira XML export into an existing project",
        request=OpenApiTypes.BINARY,
        responses={
            202: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description='Import queued; body is {"detail", "import_request_id"}.',
            ),
            400: OpenApiResponse(description="Missing or invalid upload (wrong type/too large)."),
            403: OpenApiResponse(description="Caller lacks the Admin role on the project."),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        _require_project_admin(request.user, project_pk)

        validated = _read_validated_upload(request)
        if isinstance(validated, Response):
            return validated
        filename, file_content_b64 = validated

        from trueppm_api.apps.jiraimport.models import JiraImportRequest
        from trueppm_api.apps.jiraimport.services import enqueue_jira_import

        # Commit the outbox row before any dispatch attempt so a broker outage
        # cannot lose the import — the row stays PENDING and the drain retries.
        with transaction.atomic():
            req = JiraImportRequest.objects.create(
                project_id=project_pk,
                filename=filename,
                file_content_b64=file_content_b64,
                initiated_by_id=request.user.pk,
            )

        req_id = str(req.pk)
        transaction.on_commit(lambda: enqueue_jira_import(req_id))

        return Response(
            {"detail": "Import queued.", "import_request_id": req_id},
            status=status.HTTP_202_ACCEPTED,
        )
