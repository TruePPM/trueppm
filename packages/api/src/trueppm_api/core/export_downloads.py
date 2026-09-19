"""Shared response for a completed-or-not async export bundle download.

The project, program, and workspace export-download endpoints each queue a
``.tar.gz`` bundle asynchronously (ADR-0219/ADR-0174) and poll it here. Once
the caller has fetched and object-scoped its own job row (each app's own
``get_object_or_404`` — left to the caller, since the query differs per
scope), the status check and file stream that follow are identical (#3903).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.http import FileResponse, Http404
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

if TYPE_CHECKING:
    from datetime import datetime


def stream_export_job_or_error(
    job: Any,
    *,
    success_status: str,
    filename: str,
) -> Response | FileResponse:
    """Stream ``job``'s archive, or the not-ready/expired refusal.

    ``success_status`` is the caller's own ``ExportJobStatus.SUCCESS`` value —
    each app keeps its own copy of that four-value enum by design (see
    ``apps.projects.models.ExportJobStatus``'s docstring on the one-way
    ``workspace -> projects`` import direction), so this takes the resolved
    string rather than importing either.
    """
    if job.status != success_status or not job.file_path:
        return Response({"detail": "Export is not ready yet."}, status=status.HTTP_409_CONFLICT)
    expires_at: datetime | None = job.expires_at
    if expires_at is not None and expires_at < timezone.now():
        return Response(
            {"detail": "This export has expired. Request a new one."},
            status=status.HTTP_410_GONE,
        )
    from django.core.files.storage import default_storage

    try:
        handle = default_storage.open(job.file_path, "rb")
    except (FileNotFoundError, OSError) as exc:
        raise Http404("Export archive is no longer available.") from exc
    return FileResponse(
        handle,
        as_attachment=True,
        filename=filename,
        content_type="application/gzip",
    )
