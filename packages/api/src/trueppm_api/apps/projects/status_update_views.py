"""API views for project status updates (#4803).

``GET/POST /projects/{project_pk}/status-updates/`` and
``GET /projects/{project_pk}/status-updates/{update_id}/``. There is deliberately no
PUT, PATCH or DELETE: a posted update is immutable and a correction is a new post.
The public, snapshot-only read rides the share-link envelope in ``share_views``.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import (
    OpenApiResponse,
    extend_schema,
    extend_schema_field,
    inline_serializer,
)
from rest_framework import serializers, status
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle, SimpleRateThrottle, UserRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsNotTokenAuthenticated,
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
    McpReadableViewMixin,
    McpScope,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects import status_update_services
from trueppm_api.apps.projects.models import Project, StatusUpdate, StatusUpdateRag
from trueppm_api.apps.workspace.serializers import display_name_for


class StatusUpdatePostThrottle(UserRateThrottle):
    """Caps how fast one account can post status updates."""

    scope = "status_update_post"


class StatusUpdateProjectPostThrottle(SimpleRateThrottle):
    """Caps how fast one project can receive status updates, whoever posts them.

    The per-user bucket alone lets several Project Managers on one project (or one
    person holding several accounts) post a run of immutable updates between them;
    every post is permanent history, so the project is the unit the cap protects.
    """

    scope = "status_update_post_project"

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        """Key on the canonical UUID, not the URL text.

        The route takes ``project_pk`` as a string and the lookup accepts every
        spelling ``uuid.UUID`` parses (upper case, bare hex, braces), so keying on
        the raw text would give each spelling of one project its own bucket. An
        unparsable value is not throttled here; the view 404s it.
        """
        project_pk = getattr(view, "kwargs", {}).get("project_pk")
        if project_pk is None:
            return None
        try:
            ident = str(uuid.UUID(str(project_pk)))
        except ValueError:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}


#: The 403 an API token gets on a post. ``IsNotTokenAuthenticated``'s own message
#: speaks of credentials and memberships, which misdiagnoses this route; it is set on
#: the instance so the class (which the route-table inventory matches by name) is
#: unchanged everywhere else.
_POST_TOKEN_REFUSED_MESSAGE = (
    "API tokens cannot post a status update: it is the Project Manager's own signed "
    "call. Sign in to post one."
)


class StatusUpdateCreateSerializer(serializers.Serializer[Any]):
    """Write serializer: the PM's call. Everything else is server-computed."""

    rag = serializers.ChoiceField(choices=StatusUpdateRag.choices)
    narrative = serializers.CharField(max_length=600, required=False, allow_blank=True, default="")


class StatusUpdateSerializer(serializers.ModelSerializer[StatusUpdate]):
    """Read serializer for one posted update, with its frozen snapshot and live diff.

    ``snapshot`` is returned exactly as stored at ``posted_at``. ``live_diff`` maps
    a dotted snapshot key to the current value, present only where the plan has
    moved since; the client prints it beside the frozen value and computes nothing.
    ``snapshot_verified`` is False when the stored row (the call, narrative, number,
    time, health band or snapshot) no longer hashes to the digest recorded at post
    time: a row altered outside the application.
    """

    author: serializers.PrimaryKeyRelatedField[Any] = serializers.PrimaryKeyRelatedField(
        read_only=True, allow_null=True
    )
    author_name = serializers.SerializerMethodField()
    snapshot_verified = serializers.SerializerMethodField()
    live_diff = serializers.SerializerMethodField()

    class Meta:
        model = StatusUpdate
        fields = [  # noqa: RUF012
            "id",
            "project",
            "seq",
            "rag",
            "narrative",
            "author",
            "author_name",
            "posted_at",
            "computed_health",
            "snapshot",
            "snapshot_sha256",
            "snapshot_verified",
            "live_diff",
        ]
        read_only_fields = fields

    def get_author_name(self, obj: StatusUpdate) -> str | None:
        user = obj.author
        if user is None:
            return None
        return display_name_for(user.first_name, user.last_name, user.username)

    def get_snapshot_verified(self, obj: StatusUpdate) -> bool:
        return status_update_services.snapshot_verified(obj)

    @extend_schema_field(serializers.DictField())
    def get_live_diff(self, obj: StatusUpdate) -> dict[str, Any]:
        current = self.context.get("current")
        if current is None:
            return {}
        return status_update_services.live_diff(obj, current)


class StatusUpdatePagination(PageNumberPagination):
    page_size = 20
    max_page_size = 100
    page_size_query_param = "page_size"


class ProjectStatusUpdateListCreateView(McpReadableViewMixin, IdempotencyMixin, APIView):
    """GET (project members) / POST (Project Manager and above) a project's status updates.

    POST allocates the next ``seq`` and freezes the snapshot in one transaction
    (``status_update_services.post_status_update``). It is refused to an agent
    credential of any kind and on an archived project. GET lists the history newest first; the
    live diff is computed against one current reading built once per request.
    """

    # ADR-0678: projects/<project_pk>/status-updates/
    mcp_scope = McpScope.PATH
    permission_classes = [IsAuthenticated, IsProjectMember]  # noqa: RUF012
    # A status update is the PM's own signed call: posting needs the person present
    # (a session or JWT). Every API token is refused, an agent's included, even one
    # acting for the PM; reading the history stays token-reachable (``mcp:read``)
    # so an agent can read it. Read by the OpenAPI hook, which cannot see
    # get_permissions().
    token_refused_methods = frozenset({"POST"})

    def get_permissions(self) -> list[BasePermission]:
        # This override replaces the mixin's get_permissions, so the MCP token
        # guards are re-appended on both branches (the conformance test in
        # test_mcp_team_opt_out.py asserts it).
        if self.request.method in self.token_refused_methods:
            token_refused = IsNotTokenAuthenticated()
            token_refused.message = _POST_TOKEN_REFUSED_MESSAGE
            rbac: list[BasePermission] = [
                IsAuthenticated(),
                IsProjectAdmin(),
                IsProjectNotArchived(),
                token_refused,
            ]
        else:
            rbac = [IsAuthenticated(), IsProjectMember()]
        return [*rbac, *self.mcp_token_guards()]

    def get_throttles(self) -> list[BaseThrottle]:
        if self.request.method == "POST":
            return [StatusUpdatePostThrottle(), StatusUpdateProjectPostThrottle()]
        return super().get_throttles()

    @extend_schema(
        summary="List a project's status updates, newest first",
        responses={
            200: inline_serializer(
                name="PaginatedStatusUpdateList",
                fields={
                    "count": serializers.IntegerField(),
                    "next": serializers.URLField(allow_null=True),
                    "previous": serializers.URLField(allow_null=True),
                    "results": StatusUpdateSerializer(many=True),
                },
            )
        },
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        qs = StatusUpdate.objects.filter(project=project).select_related("author").order_by("-seq")
        paginator = StatusUpdatePagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        context = {"current": status_update_services.current_values(project) if page else None}
        data = StatusUpdateSerializer(page, many=True, context=context).data
        return paginator.get_paginated_response(data)

    @extend_schema(
        summary="Post a project status update (immutable; a correction is a new post)",
        request=StatusUpdateCreateSerializer,
        responses={
            201: StatusUpdateSerializer,
            403: OpenApiResponse(description="Below Project Manager, an agent, or archived."),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        write = StatusUpdateCreateSerializer(data=request.data)
        write.is_valid(raise_exception=True)
        update = status_update_services.post_status_update(
            project,
            request.user,
            rag=write.validated_data["rag"],
            narrative=write.validated_data["narrative"],
        )
        # A fresh post has no diff against itself.
        body = StatusUpdateSerializer(update, context={"current": None}).data
        return Response(body, status=status.HTTP_201_CREATED)


class ProjectStatusUpdateDetailView(McpReadableViewMixin, APIView):
    """GET one posted status update (project members, and ``mcp:read`` tokens). Read-only."""

    # ADR-0678: projects/<project_pk>/status-updates/<update_id>/
    mcp_scope = McpScope.PATH
    permission_classes = [IsAuthenticated, IsProjectMember]  # noqa: RUF012
    http_method_names = ["get", "head", "options"]  # noqa: RUF012

    @extend_schema(
        summary="Retrieve one status update with its frozen snapshot and live diff",
        responses={200: StatusUpdateSerializer},
    )
    def get(self, request: Request, project_pk: str, update_id: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        update = get_object_or_404(
            StatusUpdate.objects.select_related("author"), pk=update_id, project=project
        )
        context = {"current": status_update_services.current_values(project)}
        return Response(StatusUpdateSerializer(update, context=context).data)
