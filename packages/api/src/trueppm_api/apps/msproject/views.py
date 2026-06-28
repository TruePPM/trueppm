"""REST API views for MS Project import/export."""

from __future__ import annotations

import base64
import logging
import os
import re
from typing import Any

from django.conf import settings
from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiExample, OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

logger = logging.getLogger(__name__)

# Allowed file extensions. The web format picker only offers .xml today and grays
# .mpp/.mpx (#128/#120); the server stays authoritative and still accepts .mpp when
# MPXJ is installed, matching the existing import-into-existing-project endpoint.
_ALLOWED_EXTENSIONS = {"mpp", "xml"}

# Sanitize uploaded filenames (#816) before persistence. UploadedFile.name is
# attacker-controlled via Content-Disposition: filenames may contain control
# chars, path components ("../../etc/passwd"), HTML metacharacters, or
# header-injection sequences. The provenance list endpoint surfaces this field
# (#799 / MR !429) and any downstream consumer that interpolates it into HTML
# or a Content-Disposition header becomes a stored-XSS / header-injection sink
# without this filter. Reject everything but printable ASCII excluding the
# small set of metacharacters; cap to 255 chars; fall back to "upload.xml" so
# we never store an empty string after sanitization.
_FILENAME_BANNED = re.compile(r"[^A-Za-z0-9._\- ()]")


def _sanitize_filename(raw: str) -> str:
    """Return a safe stored form of ``raw``.

    Strips path components (``os.path.basename``), substitutes anything outside
    the printable-ASCII allow-list with ``_``, collapses runs of whitespace,
    caps length at 255 characters, and falls back to ``upload.xml`` if the
    filtered result is empty.
    """
    name = os.path.basename(raw or "")
    name = _FILENAME_BANNED.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = name[:255]
    return name or "upload.xml"


def _read_validated_upload(request: Request) -> tuple[str, str] | Response:
    """Read the multipart ``file`` field and validate extension + size.

    Returns ``(filename, file_content_b64)`` on success, or a 400 ``Response``
    describing the rejection (no file / unsupported type / too large). Shared by
    the import-into-existing-project and create-from-import views so both enforce
    the same authoritative limits. The returned ``filename`` is sanitized via
    :func:`_sanitize_filename` (#816).
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
            {"detail": f"Unsupported file type: .{ext}. Allowed: .mpp, .xml"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    max_bytes = settings.MSPROJECT_MAX_UPLOAD_MB * 1024 * 1024
    if uploaded_file.size and uploaded_file.size > max_bytes:
        return Response(
            {
                "detail": (
                    f"File too large ({uploaded_file.size} bytes). "
                    f"Maximum: {settings.MSPROJECT_MAX_UPLOAD_MB} MB."
                )
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    file_content_b64 = base64.b64encode(uploaded_file.read()).decode("ascii")
    return filename, file_content_b64


def _project_name_from_filename(filename: str) -> str:
    """Derive a provisional project name from the upload filename (ADR-0092).

    The worker overwrites this with the file's ``<Name>`` header once the file
    parses, so this only has to be a sensible placeholder while the import runs.
    """
    stem = filename.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    cleaned = stem.replace("_", " ").replace("-", " ").strip()
    return cleaned[:255] or "Imported project"


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


class MsProjectImportView(IdempotencyMixin, APIView):
    """Upload and import an MS Project file (.mpp or .xml).

    Requires project Admin role. The import runs asynchronously via Celery;
    the response includes the celery_task_id for progress tracking.
    """

    # Exempt from the generic Idempotency-Key path (ADR-0170): this is a multipart
    # upload, and the import is already deduped at the table level via ImportRequest.
    idempotency_exempt = True
    # IsProjectAdmin makes the Admin requirement declarative at the DRF layer
    # (OpenAPI-visible, enforced before the body runs); the in-body
    # _check_project_role(..., Role.ADMIN) below remains authoritative as
    # defense-in-depth (#1374, mirrors the #1351 additive-DRF-class pattern).
    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Import an MS Project file into an existing project",
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
        _check_project_role(request.user, project_pk, Role.ADMIN)

        validated = _read_validated_upload(request)
        if isinstance(validated, Response):
            return validated
        filename, file_content_b64 = validated

        from trueppm_api.apps.msproject.models import ImportRequest
        from trueppm_api.apps.msproject.services import enqueue_import

        # Write the outbox row inside an atomic block so the file content is
        # durably committed before any dispatch attempt.  If the broker is
        # down, the row stays PENDING and drain_import_queue picks it up
        # within 30 seconds — the caller never sees a 503.
        with transaction.atomic():
            req = ImportRequest.objects.create(
                project_id=project_pk,
                filename=filename,
                file_content_b64=file_content_b64,
                initiated_by_id=request.user.pk,
            )

        req_id = str(req.pk)
        transaction.on_commit(lambda: enqueue_import(req_id))

        return Response(
            {
                "detail": "Import queued.",
                "import_request_id": req_id,
            },
            status=status.HTTP_202_ACCEPTED,
        )


class CreateProjectFromMsProjectView(IdempotencyMixin, APIView):
    """Create a NEW project by importing an MS Project file (ADR-0092, #797).

    Distinct from ``MsProjectImportView``, which imports into an existing project.
    The project shell is created synchronously (named from the filename, dated
    today, optionally assigned to a program); tasks import asynchronously via the
    ``ImportRequest`` outbox, and the worker overwrites the name/start_date from
    the file header once it parses.

    RBAC: any authenticated user may create a standalone project (becomes Owner) —
    identical to ``POST /projects/``. Assigning a ``program`` requires program
    Admin, enforced by ``ProjectSerializer.validate_program`` (ADR-0070).
    """

    # Multipart upload; deduped at the table level. Each upload is a distinct
    # creation by design, so the generic Idempotency-Key path does not apply.
    idempotency_exempt = True
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Create a new project by importing an MS Project file",
        request=OpenApiTypes.BINARY,
        responses={
            202: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Project shell created; import queued. Body is "
                '{"queued", "project_id", "import_request_id"}.',
            ),
            400: OpenApiResponse(
                description="Missing/invalid upload, or program-admin gate failed."
            ),
        },
    )
    def post(self, request: Request) -> Response:
        from datetime import date

        from trueppm_api.apps.msproject.models import ImportRequest
        from trueppm_api.apps.msproject.services import enqueue_import
        from trueppm_api.apps.projects.serializers import ProjectSerializer
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        validated = _read_validated_upload(request)
        if isinstance(validated, Response):
            return validated
        filename, file_content_b64 = validated

        # Build the shell via ProjectSerializer so calendar defaulting and the
        # ADR-0070 program-admin gate apply exactly as on POST /projects/.
        project_payload: dict[str, object] = {
            "name": _project_name_from_filename(filename),
            "start_date": date.today().isoformat(),
        }
        program_id = request.data.get("program")
        if program_id:
            project_payload["program"] = program_id

        serializer = ProjectSerializer(data=project_payload, context={"request": request})
        serializer.is_valid(raise_exception=True)

        # Shell + Owner membership + outbox row commit atomically, so a broker
        # hiccup never leaves an ownerless project or an unreferenced import.
        with transaction.atomic():
            project = serializer.save()
            ProjectMembership.objects.create(
                project=project,
                user=request.user,  # type: ignore[misc]
                role=Role.OWNER,
            )
            req = ImportRequest.objects.create(
                project=project,
                filename=filename,
                file_content_b64=file_content_b64,
                initiated_by_id=request.user.pk,
                creates_project=True,
            )

        project_id = str(project.pk)
        req_id = str(req.pk)
        transaction.on_commit(lambda: enqueue_import(req_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_created", {"id": project_id})
        )

        return Response(
            {"queued": True, "project_id": project_id, "import_request_id": req_id},
            status=status.HTTP_202_ACCEPTED,
        )


class ImportProvenancePagination(PageNumberPagination):
    """Page-number pagination for the import-provenance list (#1317).

    Replaces the previous hard ``[:100]`` slice: a workspace that skipped the
    7-day purge job could accumulate far more, and the slice silently dropped
    the overflow with no way to reach it. ``results`` stays the row key so the
    existing client read is unchanged; ``count``/``next``/``previous`` are added.
    """

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


class ImportRequestProvenanceListView(APIView):
    """List ImportRequest rows for a project — the audit / provenance surface (#799).

    Read-only at Member+ (any role). Returns the recent imports newest first
    with filename, who initiated it, when, status, and task count from the
    linked TaskRun summary. Powers the "Imported from … on … by …" affordance
    on the project Overview and gives Marcus's PMO audit trail a starting
    point without spinning up the enterprise audit overlay.

    Rows are purged after 7 days by `purge_old_import_requests`, so this is
    a recent-activity view, not durable audit history. Page-paginated (#1317).
    """

    # IsProjectMember makes the membership gate declarative (was in-body only).
    # IsProjectNotArchived is deliberately omitted: this is a read-only audit /
    # provenance surface that must remain readable after a project is archived
    # (mirrors the History views' archived-read policy).
    permission_classes = [IsAuthenticated, IsProjectMember]

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Recent import-request provenance rows for the project, newest "
                    "first: {results: [{id, filename, initiated_by, requested_at, "
                    "status, task_count}]}. Rows are purged after 7 days."
                ),
                examples=[
                    OpenApiExample(
                        "imports",
                        value={
                            "results": [
                                {
                                    "id": "…",
                                    "filename": "plan.xml",
                                    "initiated_by": "sarah",
                                    "requested_at": "2026-05-28T14:03:00Z",
                                    "status": "succeeded",
                                    "task_count": 142,
                                }
                            ]
                        },
                    ),
                ],
            ),
            404: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Project not found.",
            ),
        },
    )
    def get(self, request: Request, project_pk: str) -> Response:
        from trueppm_api.apps.msproject.models import ImportRequest
        from trueppm_api.apps.msproject.serializers import ImportRequestProvenanceSerializer
        from trueppm_api.apps.projects.models import Project

        if not Project.objects.filter(pk=project_pk).exists():
            return Response({"detail": "Project not found."}, status=status.HTTP_404_NOT_FOUND)
        _check_project_member(request.user, project_pk)

        # Newest first — matches the project-history affordance UX. select_related
        # the user FK so the serializer's username display doesn't trigger an
        # N+1 across the page's row count. The paginator bounds the page; rows
        # are also purged after 7 days, so this stays a recent-activity view.
        qs = (
            ImportRequest.objects.filter(project_id=project_pk)
            .select_related("initiated_by")
            .order_by("-requested_at")
        )
        from trueppm_api.apps.taskruns.models import TaskRun

        paginator = ImportProvenancePagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        page_rows = list(page) if page is not None else []
        # Batch-load every linked TaskRun for the page in one IN query and fully
        # pre-seed the serializer's memoization cache. The per-row cache only
        # dedups *repeated* celery_task_ids within a response, but each import
        # has a distinct id, so without this seed the serializer would issue one
        # TaskRun SELECT per row. Seed missing ids to None as well so a "no
        # TaskRun yet" row is also a cache hit rather than a fallthrough query.
        task_ids = [r.celery_task_id for r in page_rows if r.celery_task_id]
        # Order oldest-first so the dict's last-write-wins keeps the *newest* run
        # for a duplicate celery_task_id — matching the per-row `.first()` the
        # serializer falls back to (TaskRun.Meta.ordering is `-created_at`). A
        # Celery retry reuses the task id, so duplicates are structurally possible.
        runs_by_id = {
            run.celery_task_id: run
            for run in TaskRun.objects.filter(celery_task_id__in=task_ids).order_by("created_at")
        }
        cache: dict[str, TaskRun | None] = {tid: runs_by_id.get(tid) for tid in task_ids}
        context: dict[str, Any] = {"_taskrun_cache": cache}
        serializer = ImportRequestProvenanceSerializer(page_rows, many=True, context=context)
        return paginator.get_paginated_response(serializer.data)


class MsProjectExportView(APIView):
    """Export project schedule as MS Project XML.

    Requires project Member role (viewer or above).
    """

    # IsProjectMember gates membership declaratively; the in-body
    # _check_project_member below stays as defense-in-depth.
    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        summary="Export the project schedule as MS Project XML",
        # The response is an XML file attachment, not JSON. drf-spectacular emits
        # an empty `content` for the 200 unless the media type is declared via a
        # (status, media_type) response key, leaving codegen/MCP with no media
        # type to bind (#1381).
        responses={
            (200, "application/xml"): OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description="MS Project XML document as a file attachment.",
            )
        },
    )
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
