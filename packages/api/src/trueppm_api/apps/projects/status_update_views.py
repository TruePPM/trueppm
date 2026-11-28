"""API views for project status updates (#4803).

``GET/POST /projects/{project_pk}/status-updates/``,
``GET /projects/{project_pk}/status-updates/{update_id}/`` and its one-page PDF,
``GET /projects/{project_pk}/status-updates/{update_id}/pdf/`` (#4805). There is deliberately no
PUT, PATCH or DELETE: a posted update is immutable and a correction is a new post.
The public, snapshot-only read rides the share-link envelope in ``share_views``.
"""

from __future__ import annotations

import uuid
from typing import Any, ClassVar

from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
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
from trueppm_api.apps.projects import status_update_pdf, status_update_services
from trueppm_api.apps.projects.agent_scope import (
    STATUS_FORECAST_BASELINE_FIELDS,
    STATUS_MILESTONE_BASELINE_FIELDS,
    agent_lacks_read,
)
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


def _strip_baseline_snapshot(data: dict[str, Any], request: Request) -> dict[str, Any]:
    """Withhold the baseline finish and variance from an agent without Baselines read (#5118).

    A status update is a Schedule-area read, but its frozen forecast and milestone rows
    quote the active baseline's finish and the variance against it, and ``live_diff``
    repeats the variance. The seal (``snapshot_sha256``) and its verdict are unaffected:
    they are computed from the stored row, not from this response.
    """
    if not agent_lacks_read(request, "baselines"):
        return data
    snapshot = data.get("snapshot")
    if isinstance(snapshot, dict):
        snapshot = dict(snapshot)
        forecast = snapshot.get("forecast")
        if isinstance(forecast, dict):
            snapshot["forecast"] = {
                k: v for k, v in forecast.items() if k not in STATUS_FORECAST_BASELINE_FIELDS
            }
        milestones = snapshot.get("milestones")
        if isinstance(milestones, list):
            snapshot["milestones"] = [
                {k: v for k, v in m.items() if k not in STATUS_MILESTONE_BASELINE_FIELDS}
                if isinstance(m, dict)
                else m
                for m in milestones
            ]
        data["snapshot"] = snapshot
    diff = data.get("live_diff")
    if isinstance(diff, dict):
        data["live_diff"] = {
            k: v
            for k, v in diff.items()
            if k != "forecast.baseline_finish_variance_days" and not k.endswith(".variance_days")
        }
    return data


_STATUS_BASELINE_STRIPS: dict[str | None, dict[str, tuple[str, ...]]] = {
    None: {
        "baselines": (
            *(f"forecast.{f}" for f in STATUS_FORECAST_BASELINE_FIELDS),
            *(f"milestones[].{f}" for f in STATUS_MILESTONE_BASELINE_FIELDS),
        )
    }
}


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
    agent_strips: ClassVar[dict[str | None, dict[str, tuple[str, ...]]]] = _STATUS_BASELINE_STRIPS
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
        data = [
            _strip_baseline_snapshot(dict(row), request)
            for row in StatusUpdateSerializer(page, many=True, context=context).data
        ]
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
    agent_strips: ClassVar[dict[str | None, dict[str, tuple[str, ...]]]] = _STATUS_BASELINE_STRIPS
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
        return Response(
            _strip_baseline_snapshot(
                dict(StatusUpdateSerializer(update, context=context).data), request
            )
        )


class ProjectStatusUpdatePdfView(McpReadableViewMixin, APIView):
    """GET the one-page PDF of a posted update, Letter or A4 (#4805). Members only.

    The page is drawn from the update's frozen snapshot alone (``status_update_pdf``),
    so it carries nothing the member could not already read on the detail route.
    A row that no longer hashes to its seal is refused with ``409`` rather than
    printed: the page states its facts were frozen at post time, and for an altered
    row that statement would be false.
    """

    # ADR-0678: projects/<project_pk>/status-updates/<update_id>/pdf/
    mcp_scope = McpScope.PATH
    # The page prints the baseline finish and its variance from the frozen snapshot, and
    # a PDF cannot have fields dropped from it, so the whole page needs Baselines read
    # as well as Schedule (#5118).
    agent_area = ("schedule", "baselines")
    permission_classes = [IsAuthenticated, IsProjectMember]  # noqa: RUF012
    http_method_names = ["get", "head", "options"]  # noqa: RUF012

    @extend_schema(
        summary="Download one status update as a one-page PDF (Letter or A4)",
        parameters=[
            OpenApiParameter(
                "size",
                str,
                enum=sorted(status_update_pdf.PAGE_SIZES),
                required=False,
                description="Page size; `letter` (default) or `a4`.",
            )
        ],
        responses={
            (200, "application/pdf"): OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description="A one-page PDF of the update's frozen snapshot.",
            ),
            400: OpenApiResponse(description="Unknown page size."),
            404: OpenApiResponse(description="No such project or update for this member."),
            409: OpenApiResponse(
                description="The stored update no longer matches its seal; not printed."
            ),
        },
    )
    def get(self, request: Request, project_pk: str, update_id: str) -> HttpResponse:
        size = str(request.query_params.get("size", "letter")).lower()
        if size not in status_update_pdf.PAGE_SIZES:
            return Response(
                {"size": [f"Choose one of: {', '.join(sorted(status_update_pdf.PAGE_SIZES))}."]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        update = get_object_or_404(
            StatusUpdate.objects.select_related("author", "project"),
            pk=update_id,
            project=project,
        )
        if not status_update_services.snapshot_verified(update):
            return Response(
                {
                    "detail": "This update no longer matches the record taken when it was "
                    "posted, so it is not printed."
                },
                status=status.HTTP_409_CONFLICT,
            )
        pdf = status_update_pdf.pdf_for_update(update, size)
        code = "".join(c for c in (project.code or "project") if c.isalnum() or c in "-_")
        resp = HttpResponse(pdf, content_type="application/pdf")
        resp["Content-Disposition"] = (
            f'attachment; filename="{code or "project"}-status-update-{update.seq}-{size}.pdf"'
        )
        # A member's PDF names people and risks: never held by a shared cache.
        resp["Cache-Control"] = "private, no-store"
        resp["X-Content-Type-Options"] = "nosniff"
        return resp
