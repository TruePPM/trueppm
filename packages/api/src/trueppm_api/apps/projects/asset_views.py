"""Unified Assets endpoints — project, program, and workspace scope (ADR-0215; ADR-0428).

Read-only aggregation of every task's files (``TaskAttachment``) and external
links (``TaskLink``) into one paginated, filterable ``AssetItem`` feed:

- ``GET /api/v1/projects/{project_pk}/assets/`` — any project member (Viewer+).
- ``GET /api/v1/programs/{program_pk}/assets/`` — any program member, narrowed to
  the caller's *readable* member projects (the audited ``task_search`` pattern),
  so a program member with no readable child projects gets an empty list, never a
  403 leak.
- ``GET /api/v1/assets/`` — the workspace tier (ADR-0428): the caller's *own*
  visible-assets collection across **every** project they can read, narrowed by
  the same ``ProjectMembership`` pattern extended from program- to instance-scope.
  Adds a ``mine`` filter (assets on the caller's assigned tasks) and a ``program``
  filter. Strictly RBAC-identical — it returns nothing the caller cannot already
  read per-project, so it is OSS convenience aggregation, **not** portfolio
  governance (no health/comparison analytics, no actor dimension, no audit trail —
  those remain the Enterprise asset register; see ADR-0428).

The two nested views are dedicated ``APIView``\\s (not ``@action``\\s) — matching the
closest precedent, the unified changelog (``history/views.py``): both are read-only
cross-table keyset merges wired under a ``{scope}_pk`` nested path. The nested-path
kwarg lets ``IsProjectMember`` / ``IsProgramMember`` gate membership at
``has_permission`` (a non-member gets 403 before the query runs), and
``check_object_permissions`` re-enforces it on the resolved object for defense in
depth. The workspace view has no path pk, so RBAC lives entirely in the readable-
projects narrowing rather than an object permission.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import (
    IsProgramMember,
    IsProjectMember,
    McpReadableViewMixin,
)
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
    """Unified Assets feed for a single project (ADR-0215).

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
    """Unified Assets feed across a program's member projects (ADR-0215).

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


_TRUE_VALUES = frozenset({"true", "1", "yes"})
_FALSE_VALUES = frozenset({"false", "0", "no", ""})

_WORKSPACE_ASSET_PARAMS = [
    *_ASSET_PARAMS,
    OpenApiParameter(
        "mine",
        bool,
        description=(
            "When true, restrict to assets on tasks assigned to the requesting user "
            "(the 'My Assets' view). Scoped to the caller only — there is no way to "
            "query another user's assets. Default: false (all readable assets)."
        ),
    ),
    OpenApiParameter(
        "program",
        str,
        description=(
            "Restrict to assets in one program's projects (UUID). Still narrowed to "
            "the caller's readable projects, so an unknown or unreadable program "
            "yields an empty page, never a 403."
        ),
    ),
]


def _parse_mine(request: Request) -> bool:
    """Parse the ``mine`` flag; reject anything that is not an explicit boolean."""
    raw = request.query_params.get("mine")
    if raw is None:
        return False
    lowered = raw.strip().lower()
    if lowered in _TRUE_VALUES:
        return True
    if lowered in _FALSE_VALUES:
        return False
    raise DRFValidationError({"mine": "Must be a boolean ('true' or 'false')."})


def _parse_program(request: Request) -> uuid.UUID | None:
    """Parse the optional ``program`` UUID filter; 400 on a malformed value."""
    raw = request.query_params.get("program")
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except (TypeError, ValueError) as err:
        raise DRFValidationError({"program": "Must be a valid UUID."}) from err


class WorkspaceAssetsView(McpReadableViewMixin, APIView):
    """Unified Assets feed across every project the caller can read (ADR-0428).

    ``GET /api/v1/assets/?mine=&program=&kind=&label=&provider=&q=&cursor=&page_size=``

    The workspace tier of the Assets surface. Any authenticated user reaches the
    endpoint; results are narrowed to the caller's **readable** projects via the
    same ``ProjectMembership`` pattern the program view uses, extended from a single
    program to the whole instance. A user with no readable projects gets an empty
    list, never a 403 — and the feed can never surface an asset from a project the
    caller cannot already open, so it grants **no new reach** (this is what keeps it
    OSS rather than portfolio governance; ADR-0428).

    **RBAC contract (mirrors ``MeWorkView``)**: with ``mine=true`` the feed is
    hard-scoped to ``task.assignee = request.user``; there is no ``?user=`` escape
    hatch, so it can never be used as a cross-team surveillance surface (Morgan's
    boundary). ``McpReadableViewMixin`` additionally exposes the read to ``mcp:read``
    tokens with a per-token throttle (the agent asset-index use case) while leaving
    human traffic on the default ``user`` throttle.
    """

    permission_classes = [IsAuthenticated]  # noqa: RUF012

    @extend_schema(
        summary="Unified Assets feed across all readable projects (workspace scope)",
        parameters=_WORKSPACE_ASSET_PARAMS,
        responses={200: OpenApiResponse(AssetFeedResponseSerializer)},
    )
    def get(self, request: Request) -> Response:
        mine = _parse_mine(request)
        program_id = _parse_program(request)

        # Readable projects across the whole instance (the program view's narrowing
        # with the ``project__program=`` clause dropped). ``program`` re-applies a
        # single-program narrowing on top when present. IsAuthenticated guarantees a
        # concrete user; filter on ``user.pk`` so mypy sees a concrete id.
        user_pk = request.user.pk or -1
        memberships = ProjectMembership.objects.filter(
            user_id=user_pk,
            is_deleted=False,
            project__is_deleted=False,
        )
        if program_id is not None:
            memberships = memberships.filter(project__program_id=program_id)
        readable_ids = list(memberships.values_list("project_id", flat=True))

        params = _parse_asset_params(request)
        if mine:
            params["assignee_id"] = user_pk
        entries, next_cursor = build_asset_feed(readable_ids, **params)
        return _asset_response(entries, next_cursor)
