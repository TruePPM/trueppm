"""API views for public read-only board share links (#283, ADR-0245).

Three authenticated management routes (Admin+, project-scoped) plus one public,
unauthenticated, read-only board endpoint. The public view mirrors
``InviteAcceptView``: ``AllowAny`` + no authentication + a dedicated anon throttle
+ enumeration-safe generic errors.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from django.conf import settings
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, BaseThrottle, UserRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsProjectAdmin, IsProjectNotArchived
from trueppm_api.apps.projects import share_services
from trueppm_api.apps.projects.models import Project, ShareContentKind, ShareLink
from trueppm_api.apps.projects.share_serializers import (
    ShareLinkCreateResponseSerializer,
    ShareLinkCreateSerializer,
    ShareLinkSerializer,
)
from trueppm_api.apps.projects.sharing_settings import resolve_effective_sharing


class ShareLinkMintThrottle(UserRateThrottle):
    """Caps how fast one account can mint share links (bounds link-spraying)."""

    scope = "share_mint"


class ShareLinkAccessThrottle(AnonRateThrottle):
    """Defense-in-depth rate limit on the unauthenticated public board endpoint.

    The 256-bit token is already non-enumerable; this bounds scraping/abuse of a
    legitimately-shared (or leaked) link so it can't become an unauthenticated,
    unthrottled load source on a self-hosted box (Omar's VoC concern).
    """

    scope = "share_access"


def _sharing_enabled() -> bool:
    """Instance kill switch (ADR-0245). Operators disable public sharing org-wide."""
    return bool(getattr(settings, "TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED", True))


def _public_sharing_allowed(project: Project) -> bool:
    """Effective public-sharing policy (ADR-0135) for ``project`` — resolved through
    workspace → program → project inheritance, honoring any Enterprise org-wide
    enforcement lock. This is the admin-level "Public sharing" toggle on the General
    settings page; both minting and serving a public board link require it to be on,
    layered on top of the operator-level instance kill switch above. Turning it off
    therefore blocks new links AND immediately stops existing ones from resolving.
    """
    return resolve_effective_sharing(project, "public_sharing")


class ProjectShareLinkListCreateView(APIView):
    """GET/POST ``/api/v1/projects/{project_pk}/share-links/`` — Admin+ only.

    GET lists the project's *active* links (revoked links drop out). POST mints a
    new link and returns the raw token exactly once.
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin]  # noqa: RUF012

    def get_permissions(self) -> list[BasePermission]:
        # Minting a new public link is a write, so block it on an archived
        # (hard read-only) project — matching the ProjectApiToken convention.
        # Listing stays allowed on an archived project (it is a read).
        perms: list[BasePermission] = [IsAuthenticated(), IsProjectAdmin()]
        if self.request.method == "POST":
            perms.append(IsProjectNotArchived())
        return perms

    def get_throttles(self) -> list[BaseThrottle]:
        # Only the mint (POST) is rate-limited; listing rides the default user rate.
        if self.request.method == "POST":
            return [ShareLinkMintThrottle()]
        return super().get_throttles()

    @extend_schema(
        summary="List active board share links for a project",
        responses={200: ShareLinkSerializer(many=True)},
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk)
        self.check_object_permissions(request, project)
        links = project.share_links.filter(revoked_at__isnull=True)
        return Response(ShareLinkSerializer(links, many=True).data)

    @extend_schema(
        summary="Create a board share link (returns the raw token once)",
        request=ShareLinkCreateSerializer,
        responses={
            201: ShareLinkCreateResponseSerializer,
            403: OpenApiResponse(description="Public board sharing is disabled on this instance."),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk)
        self.check_object_permissions(request, project)
        if not _sharing_enabled():
            return Response(
                {"detail": "Public board sharing is disabled on this instance."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if not _public_sharing_allowed(project):
            # The admin-level "Public sharing" policy (ADR-0135) is off for this
            # project (or an ancestor / an Enterprise org-wide lock) — respect it.
            return Response(
                {"detail": "Public sharing is turned off for this project."},
                status=status.HTTP_403_FORBIDDEN,
            )
        write = ShareLinkCreateSerializer(data=request.data)
        write.is_valid(raise_exception=True)
        link, raw = share_services.mint_share_link(
            project,
            request.user,
            label=write.validated_data["label"],
            show_assignees=write.validated_data["show_assignees"],
        )
        data: dict[str, Any] = dict(ShareLinkSerializer(link).data)
        # One-time reveal: the raw token and its relative path exist only here. The
        # web client composes the absolute URL from its own origin.
        data["token"] = raw
        data["share_path"] = f"/share/board/{raw}"
        return Response(data, status=status.HTTP_201_CREATED)


class ProjectShareLinkRevokeView(APIView):
    """POST ``/api/v1/projects/{project_pk}/share-links/{link_id}/revoke/`` — Admin+.

    Idempotent soft-revoke. Works regardless of the instance kill switch (an
    operator disabling sharing should not strand an Admin from revoking an old link).
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin]  # noqa: RUF012

    @extend_schema(
        summary="Revoke a board share link",
        request=None,
        responses={
            200: ShareLinkSerializer,
            404: OpenApiResponse(description="No such share link on this project."),
        },
    )
    def post(self, request: Request, project_pk: str, link_id: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk)
        self.check_object_permissions(request, project)
        link = get_object_or_404(ShareLink, pk=link_id, project=project)
        share_services.revoke_share_link(link, request.user)
        link.refresh_from_db()
        return Response(ShareLinkSerializer(link).data)


class PublicBoardShareView(APIView):
    """GET ``/api/v1/share/board/{token}/`` — public, unauthenticated, read-only.

    Returns a minimized board snapshot. ``410`` for a revoked link, ``404`` for an
    unknown/invalid token or when the instance kill switch is off (uniform 404 hides
    whether the feature or a given link exists). A weak ``ETag`` + short
    ``Cache-Control`` lets embeds re-poll cheaply.
    """

    permission_classes = [AllowAny]  # noqa: RUF012
    authentication_classes: list[Any] = []  # noqa: RUF012
    throttle_classes = [ShareLinkAccessThrottle]  # noqa: RUF012
    http_method_names = ["get"]  # noqa: RUF012

    @extend_schema(
        summary="Public read-only board snapshot for a share token",
        responses={
            200: OpenApiResponse(
                description="Minimized board snapshot (columns + whitelisted cards)."
            ),
            404: OpenApiResponse(description="Unknown/invalid token, or sharing disabled."),
            410: OpenApiResponse(description="This share link has been revoked."),
        },
    )
    def get(self, request: Request, token: str) -> Response:
        # Kill switch → uniform 404 (do not reveal the feature exists, and
        # retroactively disable every existing link while off).
        if not _sharing_enabled():
            return Response(
                {"detail": "This share link isn't available."},
                status=status.HTTP_404_NOT_FOUND,
            )

        link = share_services.resolve_share_link(token, ShareContentKind.BOARD)
        if link is None:
            return Response(
                {"detail": "This share link isn't available."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if link.revoked_at is not None:
            return Response(
                {"detail": "This share link has been revoked."},
                status=status.HTTP_410_GONE,
            )
        if not _public_sharing_allowed(link.project):
            # The "Public sharing" policy (ADR-0135) was turned off for this project
            # (or an ancestor) after the link was minted — stop resolving it, uniform
            # 404 like the instance kill switch.
            return Response(
                {"detail": "This share link isn't available."},
                status=status.HTTP_404_NOT_FOUND,
            )

        payload = share_services.serialize_public_board(link)
        body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        etag = 'W/"' + hashlib.sha1(body.encode()).hexdigest()[:32] + '"'

        if request.headers.get("If-None-Match") == etag:
            resp = Response(status=status.HTTP_304_NOT_MODIFIED)
        else:
            resp = Response(payload)
            # Count a fresh delivery only; 304 re-polls of unchanged content don't
            # inflate the "viewed N times" meter.
            share_services.record_access(link)
        resp["ETag"] = etag
        # `private` (not `public`): a revoked link must stop resolving promptly, so a
        # shared/CDN cache must never serve a since-revoked board to another viewer.
        # The per-viewer browser cache + ETag still make re-polls cheap.
        resp["Cache-Control"] = "private, max-age=30"
        return resp
