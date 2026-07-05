"""Unified Assets endpoints — project and program scope (ADR-0212, #971).

Read-only aggregation of every task's files (``TaskAttachment``) and external
links (``TaskLink``) into one paginated, filterable ``AssetItem`` feed:

- ``GET /api/v1/projects/{project_pk}/assets/`` — any project member (Viewer+).
- ``GET /api/v1/programs/{program_pk}/assets/`` — any program member, narrowed to
  the caller's *readable* member projects (the audited ``task_search`` pattern),
  so a program member with no readable child projects gets an empty list, never a
  403 leak.

Dedicated ``APIView``\\s (not ``@action``\\s) — matching the closest precedent, the
unified changelog (``history/views.py``): both are read-only cross-table keyset
merges wired under a ``{scope}_pk`` nested path. The nested-path kwarg lets
``IsProjectMember`` / ``IsProgramMember`` gate membership at ``has_permission``
(a non-member gets 403 before the query runs), and ``check_object_permissions``
re-enforces it on the resolved object for defense in depth.
"""

from __future__ import annotations

from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import IsProgramMember, IsProjectMember
from trueppm_api.apps.projects import asset_feed
from trueppm_api.apps.projects.asset_feed import AssetFeedResponseSerializer, build_asset_feed
from trueppm_api.apps.projects.models import Program, Project

_ASSET_PARAMS = [
    OpenApiParameter(
        "kind", str, description="Restrict to a single kind: 'file' or 'link'. Default: both."
    ),
    OpenApiParameter(
        "label", str, description="Restrict to links carrying this exact label (link-only)."
    ),
    OpenApiParameter(
        "provider", str, description="Restrict to links from this provider (link-only)."
    ),
    OpenApiParameter(
        "q",
        str,
        description="Case-insensitive substring matched against title/url on both sources.",
    ),
    OpenApiParameter(
        "cursor",
        str,
        description=(
            "Opaque keyset cursor from a prior response's next_cursor. Stable across "
            "concurrent writes; persistable; 400 if malformed."
        ),
    ),
    OpenApiParameter("page_size", int, description="Page size (1..100, default 50)."),
]


def _parse_asset_params(request: Request) -> dict[str, Any]:
    """Validate + normalize the shared Assets query params into feed kwargs."""
    params = request.query_params

    kind = params.get("kind")
    if kind is not None and kind not in asset_feed.KINDS:
        raise DRFValidationError({"kind": "Must be 'file' or 'link'."})

    page_size_raw = params.get("page_size")
    if page_size_raw:
        try:
            page_size = int(page_size_raw)
        except (TypeError, ValueError) as err:
            raise DRFValidationError({"page_size": "Must be an integer."}) from err
    else:
        page_size = asset_feed.DEFAULT_PAGE_SIZE

    cursor_raw = params.get("cursor")
    cursor = asset_feed.AssetCursor.decode(cursor_raw) if cursor_raw else None

    return {
        "kind": kind,
        "label": params.get("label"),
        "provider": params.get("provider"),
        "q": params.get("q"),
        "cursor": cursor,
        "page_size": page_size,
    }


def _asset_response(entries: list[dict[str, Any]], next_cursor: Any) -> Response:
    serializer = AssetFeedResponseSerializer(
        {
            "results": entries,
            "next_cursor": next_cursor.encode() if next_cursor is not None else None,
        }
    )
    return Response(serializer.data)


class ProjectAssetsView(APIView):
    """Unified Assets feed for a single project (ADR-0212).

    ``GET /api/v1/projects/{project_pk}/assets/?kind=&label=&provider=&q=&cursor=&page_size=``

    Any project member (Viewer+) may read; a non-member gets 403 (membership is
    checked at ``has_permission`` via the ``project_pk`` kwarg). Archived projects
    stay readable — this is a read-only browse surface (``IsProjectNotArchived`` is
    deliberately omitted, matching the history/changelog reads).
    """

    permission_classes = [IsAuthenticated, IsProjectMember]  # noqa: RUF012

    @extend_schema(
        summary="Unified Assets feed for a project (files + external links, cursor-paginated)",
        parameters=_ASSET_PARAMS,
        responses={200: OpenApiResponse(AssetFeedResponseSerializer)},
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        params = _parse_asset_params(request)
        entries, next_cursor = build_asset_feed([project.pk], **params)
        return _asset_response(entries, next_cursor)


class ProgramAssetsView(APIView):
    """Unified Assets feed across a program's member projects (ADR-0212).

    ``GET /api/v1/programs/{program_pk}/assets/?kind=&label=&provider=&q=&cursor=&page_size=``

    Any program member reaches the endpoint; results are narrowed to the caller's
    **readable** member projects (the audited ``ProgramViewSet.task_search``
    pattern) so no asset from a project the caller cannot read leaks through. A
    program member with no readable child projects gets an empty list, never a
    403. Cross-program / portfolio rollups are Enterprise and out of scope.
    """

    permission_classes = [IsAuthenticated, IsProgramMember]  # noqa: RUF012

    @extend_schema(
        summary="Unified Assets feed for a program (files + external links across member projects)",
        parameters=_ASSET_PARAMS,
        responses={200: OpenApiResponse(AssetFeedResponseSerializer)},
    )
    def get(self, request: Request, program_pk: str) -> Response:
        program = get_object_or_404(Program, pk=program_pk, is_deleted=False)
        self.check_object_permissions(request, program)

        # Readable member projects only (ADR-0120 D5 / task_search): a single
        # ProjectMembership query resolves the whole program's readable set; a
        # member project the caller cannot read is simply not aggregated.
        readable_ids = list(
            ProjectMembership.objects.filter(
                project__program=program,
                project__is_deleted=False,
                # IsProgramMember has already established an authenticated user.
                user=request.user,  # type: ignore[misc]
                is_deleted=False,
            ).values_list("project_id", flat=True)
        )
        params = _parse_asset_params(request)
        entries, next_cursor = build_asset_feed(readable_ids, **params)
        return _asset_response(entries, next_cursor)
