"""REST API views for CSV / Excel import (#743, ADR-0632)."""

from __future__ import annotations

import base64
import logging
import os
import re
from typing import Any, cast

from django.conf import settings
from django.db import transaction
from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsProjectNotArchived,
    IsProjectScheduler,
    can_user_undo_batch_operation,
    role_can_undo_batch_operation,
)
from trueppm_api.apps.csvimport.mapping import field_choices
from trueppm_api.apps.csvimport.parser import (
    DATE_ORDERS,
    REVIEW_BRANCH_NAME,
    SUPPORTED_EXTENSIONS,
    CsvImportError,
    parse_spreadsheet,
)
from trueppm_api.apps.csvimport.template import CSV_TEMPLATE, TEMPLATE_FILENAME
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

logger = logging.getLogger(__name__)

# Allow-list (mirrors the hardened MS Project sanitizer, #816): substitute
# anything outside a conservative safe set so an attacker-controlled
# UploadedFile.name can never carry an HTML/Content-Disposition-injection
# payload into the provenance surface. os.path.basename blocks path traversal.
_FILENAME_ALLOWED = re.compile(r"[^A-Za-z0-9._\- ()]")


def _sanitize_filename(raw: str) -> str:
    name = os.path.basename(raw or "")
    name = _FILENAME_ALLOWED.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:255] or "upload.csv"


def _require_project_scheduler(user: object, project_pk: str) -> None:
    """Authoritative in-body role check (defense-in-depth behind IsProjectScheduler).

    Import creates tasks, dependencies and resources wholesale, so it sits at the
    Scheduler line rather than Member: Owner / Admin / Scheduler may import,
    Member and Viewer may not.
    """
    role = (
        ProjectMembership.objects.filter(
            project_id=project_pk,
            user=user,  # type: ignore[misc]
            is_deleted=False,
        )
        .values_list("role", flat=True)
        .first()
    )
    if role is None or role < Role.SCHEDULER:
        raise PermissionDenied("You need at least the Scheduler role to import a spreadsheet.")


def _require_project_admin(user: object, project_pk: str) -> None:
    """Authoritative in-body role check for undoing an import (ADR-0810, #2756).

    Admin+, not Scheduler — the same bar as undoing a template apply or a
    cascade (``batch_operation_views._require_admin``). A Scheduler may have run
    the import and still not clear this floor.

    **Open at #3355, and not for the reason once given here.** This docstring used
    to say the undo "removes rows other collaborators may already be building on
    top of". ``undo_import_fix_operation`` partitions on ``server_version`` via
    ``task_batch_services._partition_touched`` and reverts only untouched rows,
    counting the rest as ``kept`` — so it removes nothing anyone else has changed.

    Defers the comparison to :func:`role_can_undo_batch_operation` rather than
    testing the ordinal here (#3353). ``CsvImportStatusView`` reports the same rule
    to the wizard as ``can_undo`` so it can withhold an Undo this endpoint would
    refuse, and a second copy of the comparison is exactly how the two drift —
    especially while the floor itself is open at #3355.
    """
    role = (
        ProjectMembership.objects.filter(
            project_id=project_pk,
            user=user,  # type: ignore[misc]
            is_deleted=False,
        )
        .values_list("role", flat=True)
        .first()
    )
    if not role_can_undo_batch_operation(role):
        raise PermissionDenied("You need at least Project Manager role to undo an import.")


def _read_validated_upload(request: Request) -> tuple[str, bytes] | Response:
    """Read the multipart ``file`` field; validate extension + size.

    Returns ``(filename, raw_bytes)`` or a 400 ``Response``.
    """
    uploaded_file = request.FILES.get("file")
    if not uploaded_file:
        return Response(
            {"detail": "No file provided. Send a multipart form with a 'file' field."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    filename = _sanitize_filename(uploaded_file.name or "")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in SUPPORTED_EXTENSIONS:
        return Response(
            {"detail": f"Unsupported file type: .{ext}. Upload a .csv or .xlsx file."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    max_bytes = settings.CSV_IMPORT_MAX_UPLOAD_MB * 1024 * 1024
    if uploaded_file.size and uploaded_file.size > max_bytes:
        return Response(
            {
                "detail": (
                    f"File too large ({uploaded_file.size} bytes). "
                    f"Maximum: {settings.CSV_IMPORT_MAX_UPLOAD_MB} MB."
                )
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    return filename, uploaded_file.read()


def _parse_column_map(request: Request) -> dict[str, str]:
    """Read the optional ``column_map`` multipart field as ``{header: field}``.

    Accepts a JSON object, either as a real dict (test client) or a JSON string
    (what a browser's FormData sends). A malformed value is ignored rather than
    rejected: auto-detection is a safe fallback, and failing the whole upload
    over a mapping hint would be a worse outcome than importing the detected
    columns and letting the operator see the result.
    """
    # Both callers set `parser_classes = [MultiPartParser]`, so the body is always
    # a QueryDict — a JSON list is rejected as 415 before this runs. Narrowed
    # rather than guarded: a branch that cannot be reached cannot be tested.
    raw = cast("dict[str, Any]", request.data).get("column_map")
    if not raw:
        return {}
    if isinstance(raw, dict):
        parsed: Any = raw
    else:
        import json

        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            logger.info("csv import: ignoring unparseable column_map")
            return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items() if isinstance(k, str)}


def _parse_date_order(request: Request) -> str:
    """Read the optional ``date_order`` multipart field (#2926).

    Rejected rather than ignored, unlike ``column_map``: a bad mapping hint
    degrades to auto-detection and the operator sees the result, but a
    misspelled date order that silently fell back to ``auto`` would import
    03/04 as March 4 while the caller believed they had asserted day-first —
    which is precisely the silent-corruption failure this endpoint exists to
    close. A scripted caller must hear that its parameter did nothing.

    Non-string input is caught here too: ``request.data`` is attacker-shaped,
    and a JSON list reaching a membership test against strings is the #2795
    container-type-confusion class.
    """
    # Both callers set `parser_classes = [MultiPartParser]`, so the body is always
    # a QueryDict — a JSON list is rejected as 415 before this runs. Narrowed
    # rather than guarded: a branch that cannot be reached cannot be tested.
    raw = cast("dict[str, Any]", request.data).get("date_order")
    if raw is None or raw == "":
        return "auto"
    if not isinstance(raw, str) or raw not in DATE_ORDERS:
        raise ValidationError({"date_order": f"Must be one of {', '.join(DATE_ORDERS)}."})
    return raw


#: Multipart request schema shared by preview and commit.
#:
#: Declared rather than left as bare ``BINARY`` so ``date_order`` is visible to
#: SDK codegen — a parameter a caller cannot discover from the schema is a
#: parameter that does not exist for them (the #2942 class, one endpoint over).
_IMPORT_REQUEST_SCHEMA = {
    "multipart/form-data": {
        "type": "object",
        "properties": {
            "file": {"type": "string", "format": "binary"},
            "column_map": {
                "type": "string",
                "description": "JSON object of {header: field} overrides from the wizard.",
            },
            "date_order": {
                "type": "string",
                "enum": list(DATE_ORDERS),
                "default": "auto",
                "description": (
                    "How to read slash dates. `auto` scans the file and settles the order "
                    "from the first self-identifying value; the other three assert a "
                    "convention. An unknown value is a 400, never a silent fallback."
                ),
            },
        },
        "required": ["file"],
    }
}


class CsvImportStatusResponseSerializer(serializers.Serializer[Any]):
    """The 200 body of ``GET …/import/csv/{id}/`` — declared, not prose (#3353).

    This payload used to be typed ``OpenApiTypes.OBJECT`` with the key names listed
    in a sentence, which is not a contract anyone can generate an SDK against. It
    matters most for ``can_undo``: a field whose entire purpose is to be read by a
    client, reaching ``docs/api/openapi.json`` as an undiscoverable member of a free
    object, is a field that does not exist for a non-browser caller (the #2942 class).

    Response-only — nothing deserializes it; the view builds the dict itself.
    """

    id = serializers.UUIDField()
    status = serializers.CharField(
        help_text="Outbox lifecycle: `pending` → `dispatched` → `done` | `dead`."
    )
    filename = serializers.CharField()
    summary = serializers.DictField(
        help_text=(
            "The importer's own result summary — counts, parked rows, row errors. "
            "**Empty (`{}`), never null**, until the job has run: `result_summary` is a "
            "`JSONField(default=dict)` with `null=False` and nothing writes `None` to it. "
            "Branch on `status`, not on this being absent."
        )
    )
    requested_at = serializers.DateTimeField()
    date_order = serializers.CharField(
        help_text=(
            "The slash-date convention this import actually ran under, read back so "
            '"why does this task say 62 days" stays answerable afterwards (#2926).'
        )
    )
    date_order_confirmed = serializers.BooleanField(
        help_text="Whether a human accepted that convention rather than letting `auto` decide."
    )
    can_undo = serializers.BooleanField(
        help_text=(
            "May THIS caller undo the import? (#3353) Committing is the Scheduler band "
            "and `POST …/import/csv/{id}/undo/` is Admin+, so reaching this endpoint at "
            "all says nothing about the undo's gate. **Authority only** — a `true` is "
            "not a promise the undo will succeed: it additionally requires the project "
            "to be unarchived, and the import to still be in `done` state. Orthogonal "
            "to `status`, which answers whether there is anything to undo."
        )
    )


class CsvImportPreviewView(IdempotencyMixin, APIView):
    """Parse a spreadsheet and return the detected mapping — persisting nothing.

    Synchronous and stateless by design (ADR-0632 decision 5): the wizard holds
    the mapping in client state, so a retry after a failed commit replays it
    without any server-side draft to resume or expire.
    """

    # Nothing is persisted, so a replay has no resource to dedup.
    idempotency_exempt = True
    # Gated identically to the commit path: preview parses attacker-supplied
    # files, so it is not a lighter-privilege surface just because it does not
    # persist.
    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Preview a CSV/Excel import: detected column mapping and sample rows",
        request=_IMPORT_REQUEST_SCHEMA,
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Detected mapping, first 10 parsed rows, row-level warnings and the "
                    "field catalog for the wizard's dropdown. Nothing is persisted. "
                    "Also carries how the date order was settled and the evidence for "
                    "it: `date_order_resolved`, `date_order_auto`, "
                    "`date_order_ambiguous`, `date_order_evidence` "
                    "({row, column, value, reason}), `date_order_has_columns`, "
                    "`values_matched`/`values_failed`, `date_preview` (per-row raw cell, "
                    "reading and duration), and — only when the file identifies no "
                    "convention — `date_order_readings`, both conventions with the "
                    "duration each produces for one sample row."
                ),
            ),
            400: OpenApiResponse(
                description="Missing, oversized, or unreadable upload, or an unknown `date_order`."
            ),
            403: OpenApiResponse(description="Caller lacks the Scheduler role on the project."),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        _require_project_scheduler(request.user, project_pk)

        date_order = _parse_date_order(request)

        validated = _read_validated_upload(request)
        if isinstance(validated, Response):
            return validated
        filename, content = validated

        try:
            parsed = parse_spreadsheet(
                content,
                filename,
                column_map=_parse_column_map(request) or None,
                date_order=date_order,
                max_rows=settings.CSV_IMPORT_MAX_ROWS,
                max_uncompressed_bytes=settings.CSV_IMPORT_MAX_UNCOMPRESSED_MB * 1024 * 1024,
            )
        except CsvImportError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "filename": filename,
                "headers": parsed.headers,
                "columns": [
                    {
                        "index": m.index,
                        "header": m.header,
                        "field": m.field,
                        "confidence": m.confidence,
                    }
                    for m in parsed.mapping
                ],
                "sample_rows": parsed.sample_rows,
                "row_count": parsed.total_rows,
                "truncated_rows": parsed.truncated_rows,
                # The plan, not the plan plus its Import review branch (#2732):
                # this number answers "how much of my file arrives as schedule",
                # and the parked rows are counted on their own line below.
                "task_count": parsed.plan_task_count,
                "resource_count": len(parsed.project_data.resources),
                # Rows that cannot become plan tasks and will be parked in the
                # Import review branch instead of dropped.
                "parked_row_count": len(parsed.unresolved_rows),
                "review_branch_name": REVIEW_BRANCH_NAME,
                "row_errors": [e.as_dict() for e in parsed.row_errors],
                # Split counts, not just a total: an operator deciding whether to
                # commit needs to know how many rows would be *lost* separately
                # from how many would land with a field defaulted.
                "error_count": parsed.error_count,
                "warning_count": parsed.warning_count,
                "warnings": parsed.warnings,
                # How the date order was settled, and the evidence for it
                # (#2926). Flattened onto the response rather than nested so the
                # wizard's Dates block reads one shape whether it is confirming
                # an inference or reporting an override. `readings` is populated
                # only for the ambiguous file, which is the state that needs both
                # conventions' durations side by side to be decidable at all.
                "date_order": parsed.date_order.requested,
                "date_order_resolved": parsed.date_order.resolved,
                "date_order_auto": parsed.date_order.auto_resolved,
                "date_order_ambiguous": parsed.date_order.ambiguous,
                "date_order_evidence": parsed.date_order.evidence,
                "date_order_has_columns": parsed.date_order.has_date_columns,
                "date_order_readings": [r.as_dict() for r in parsed.date_order.readings],
                "values_matched": parsed.date_order.values_matched,
                "values_failed": parsed.date_order.values_failed,
                "date_preview": parsed.date_preview,
                "available_fields": field_choices(),
            },
            status=status.HTTP_200_OK,
        )


class CsvImportView(IdempotencyMixin, APIView):
    """Upload and import a CSV/Excel spreadsheet into an existing project.

    Requires the Scheduler role. The import runs asynchronously through the
    transactional outbox; the 202 response carries ``import_request_id`` — not a
    Celery task id, which does not exist until the on_commit dispatch fires
    (ADR-0632 decision 6).
    """

    # Multipart upload, deduped at the table level via CsvImportRequest.
    idempotency_exempt = True
    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Import a CSV/Excel spreadsheet into an existing project",
        request=_IMPORT_REQUEST_SCHEMA,
        responses={
            202: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description='Import queued; body is {"detail", "queued", "import_request_id"}.',
            ),
            400: OpenApiResponse(
                description=(
                    "Missing or invalid upload (wrong type/too large), or an unknown "
                    "`date_order`. The order is persisted on the import request so a "
                    "drain re-dispatch replays the convention the operator confirmed."
                )
            ),
            403: OpenApiResponse(description="Caller lacks the Scheduler role on the project."),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        _require_project_scheduler(request.user, project_pk)
        date_order = _parse_date_order(request)
        # True when the operator explicitly accepted a convention rather than
        # letting auto decide. Kept for support archaeology only — nothing
        # branches on it (#2926).
        # `parser_classes = [MultiPartParser]` — see `_parse_column_map`.
        date_order_confirmed = str(
            cast("dict[str, Any]", request.data).get("date_order_confirmed", "")
        ).lower() in {
            "true",
            "1",
        }

        validated = _read_validated_upload(request)
        if isinstance(validated, Response):
            return validated
        filename, content = validated

        from trueppm_api.apps.csvimport.models import CsvImportRequest
        from trueppm_api.apps.csvimport.services import enqueue_csv_import

        # Commit the outbox row before any dispatch attempt so a broker outage
        # cannot lose the import — the row stays PENDING and the drain retries.
        with transaction.atomic():
            req = CsvImportRequest.objects.create(
                project_id=project_pk,
                filename=filename,
                file_content_b64=base64.b64encode(content).decode("ascii"),
                column_map=_parse_column_map(request),
                date_order=date_order,
                date_order_confirmed=date_order_confirmed,
                initiated_by_id=request.user.pk,
            )

        req_id = str(req.pk)
        transaction.on_commit(lambda: enqueue_csv_import(req_id))

        return Response(
            {"detail": "Import queued.", "queued": True, "import_request_id": req_id},
            status=status.HTTP_202_ACCEPTED,
        )


class CsvImportStatusView(APIView):
    """Poll one import's outbox row for its terminal state and summary.

    This is what makes an async failure visible on the Schedule that launched it
    (#2151): the wizard polls here after its 202 rather than for a Celery task
    id that the outbox never produces synchronously.
    """

    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]

    @extend_schema(
        summary="Status and result summary of one CSV/Excel import",
        responses={
            200: OpenApiResponse(
                response=CsvImportStatusResponseSerializer,
                description=(
                    "The import's outbox row: lifecycle state, result summary, the date "
                    "convention it ran under, and the caller's authority over the undo."
                ),
            ),
            403: OpenApiResponse(description="Caller lacks the Scheduler role on the project."),
            404: OpenApiResponse(description="No such import for this project."),
        },
    )
    def get(self, request: Request, project_pk: str, pk: str) -> Response:
        _require_project_scheduler(request.user, project_pk)

        from trueppm_api.apps.csvimport.models import CsvImportRequest

        # Scope by project as well as pk so an id leaked from another project
        # cannot be read here (IDOR).
        req = CsvImportRequest.objects.filter(id=pk, project_id=project_pk).first()
        if req is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        return Response(
            {
                "id": str(req.id),
                "status": req.status,
                "filename": req.filename,
                "summary": req.result_summary,
                "requested_at": req.requested_at,
                # The convention this import actually ran under, and whether a
                # human accepted it (#2926). Read back here rather than only
                # persisted: "why does this task say 62 days" is answerable only
                # if the convention is legible after the fact, and a field
                # nothing can read is a field that does not exist for a headless
                # client. `date_order_confirmed` had no reader at all until this.
                "date_order": req.date_order,
                "date_order_confirmed": req.date_order_confirmed,
                # #3353: committing an import is `IsProjectScheduler` (200) and
                # `CsvImportUndoView` is Admin+ (300), so a Scheduler runs an import
                # and is refused the Undo the wizard used to offer regardless. The
                # status payload is where the wizard learns which of the two floors
                # the caller cleared — a 202 on the commit says nothing about the
                # undo's gate (web rule 373(a)).
                #
                # Pure authority, deliberately orthogonal to `status`: `status ==
                # "done"` answers "is there anything to undo", this answers "may
                # you". Folding them into one boolean would make a `false` mean
                # either, with no way for a client to tell them apart.
                "can_undo": can_user_undo_batch_operation(request, project_pk),
            },
            status=status.HTTP_200_OK,
        )


class CsvImportUndoView(IdempotencyMixin, APIView):
    """⌘Z one completed import (ADR-0810, #2756, #2732).

    Project-nested like ``CsvImportStatusView`` rather than a router-registered
    ``import-fix-operations`` collection: this app has no router, and every
    other endpoint here is a plain ``path()`` under ``projects/<project_pk>/
    import/csv/...`` — matching that convention beats forcing in a different
    app's routing style for one endpoint.

    No separate ``ImportFixOperation`` model backs this — ``CsvImportRequest``
    already is the outbox row for the import (see ``task_batch_services.py``'s
    import-fix section for why a parallel table would have duplicated it).
    """

    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]

    @extend_schema(
        summary="Undo one completed CSV/Excel import",
        request=None,
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description='{"status", "undo": {"deleted", "kept"}}.',
            ),
            400: OpenApiResponse(description="Import is not in a completed (done) state."),
            403: OpenApiResponse(description="Caller lacks the Admin role on the project."),
            404: OpenApiResponse(description="No such import for this project."),
        },
    )
    def post(self, request: Request, project_pk: str, pk: str) -> Response:
        _require_project_admin(request.user, project_pk)

        from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
        from trueppm_api.apps.projects.task_batch_services import undo_import_fix_operation

        req = CsvImportRequest.objects.filter(id=pk, project_id=project_pk).first()
        if req is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        if req.status != CsvImportStatus.DONE:
            return Response(
                {"detail": f"Only a completed import can be undone (this one is {req.status})."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        summary = undo_import_fix_operation(req)
        req.refresh_from_db()
        return Response(
            {"id": str(req.id), "status": req.status, "undo": summary},
            status=status.HTTP_200_OK,
        )


class CsvImportTemplateView(APIView):
    """Download the known-good CSV template.

    Authenticated but not project-scoped: the template is static content with no
    customer data in it, and the wizard links it from step 1 before a project
    context necessarily exists.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Download a known-good CSV import template",
        responses={200: OpenApiResponse(description="text/csv template file.")},
    )
    def get(self, request: Request) -> HttpResponse:
        response = HttpResponse(CSV_TEMPLATE, content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{TEMPLATE_FILENAME}"'
        return response
