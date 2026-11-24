"""Views for the profiles app (ADR-0129).

Exposes the caller's own app preferences at ``/auth/me/profile/``. There is no
``:id`` in the path and the view only ever touches ``request.user``'s row, so
there is no IDOR surface — a user can read and write only their own profile.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, cast

from django.contrib.auth.models import User
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsProjectMember, McpReadableViewMixin, McpScope
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.profiles import services
from trueppm_api.apps.profiles.models import UserPin, UserProfile
from trueppm_api.apps.profiles.serializers import (
    ApplySeedRequestSerializer,
    PinnedItemSerializer,
    ProjectViewsErrorSerializer,
    ProjectViewSetSerializer,
    ProjectViewsPatchSerializer,
    SeedDiffSerializer,
    UserProfileSerializer,
)
from trueppm_api.apps.projects.models import Project, is_agent_token

#: ``hidden_views`` deprecation (ADR-1478 §6.2, RFC 9745 / RFC 8594). The field is removed
#: one minor release after 0.5; the Sunset date is that release's planning date.
HIDDEN_VIEWS_DEPRECATION = "@1795478400"  # 2026-11-24T00:00:00Z
HIDDEN_VIEWS_SUNSET = "Thu, 01 Jul 2027 00:00:00 GMT"
HIDDEN_VIEWS_DEPRECATION_LINK = (
    '<https://docs.trueppm.com/features/customize-views/>; rel="deprecation"; type="text/html"'
)


def with_hidden_views_deprecation(response: Response) -> Response:
    """Mark a response that carries the deprecated ``hidden_views`` field."""

    response["Deprecation"] = HIDDEN_VIEWS_DEPRECATION
    response["Sunset"] = HIDDEN_VIEWS_SUNSET
    response["Link"] = HIDDEN_VIEWS_DEPRECATION_LINK
    return response


class MyProfileView(APIView):
    """GET/PATCH ``/api/v1/auth/me/profile/`` — the caller's own app preferences.

    The profile row is created lazily, so a user who has never set a preference
    reads the default (``default_landing="auto"``) without a backfill.
    """

    permission_classes = [IsAuthenticated]

    def _get_profile(self, request: Request) -> UserProfile:
        # IsAuthenticated guarantees a concrete user here; narrow off the
        # User | AnonymousUser union for the FK lookup.
        user = cast(User, request.user)
        profile, _ = UserProfile.objects.get_or_create(user=user)
        return profile

    @extend_schema(responses={200: UserProfileSerializer})
    def get(self, request: Request) -> Response:
        return with_hidden_views_deprecation(
            Response(UserProfileSerializer(self._get_profile(request)).data)
        )

    @extend_schema(request=UserProfileSerializer, responses={200: UserProfileSerializer})
    def patch(self, request: Request) -> Response:
        serializer = UserProfileSerializer(
            self._get_profile(request), data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return with_hidden_views_deprecation(Response(serializer.data))


class MyPinnedView(APIView):
    """GET ``/api/v1/auth/me/pinned/`` — the caller's own pinned items (#2390).

    Returns projects and programs in one merged, most-recently-pinned-first list
    so the rail can render its single flat jump group without two round-trips.

    **Self-scoped by construction.** The queryset filters on ``request.user`` and
    takes no user parameter, so there is no shape of this request that returns
    another person's pins (ADR-0627 §D5). ``pinned_at`` is exposed here and
    *only* here — never on a shared Project/Program payload — because a recency
    timestamp visible to a teammate is precisely what would let a pin be read as
    an engagement metric.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="List the requesting user's pinned projects and programs",
        description=(
            "Returns **only the requesting user's own** pins, most recently "
            "pinned first. There is no parameter that selects another user, and "
            "no endpoint anywhere reports who pinned an item or how many users "
            "pinned it. A pin is a private wayfinding preference."
        ),
        responses={200: PinnedItemSerializer(many=True)},
    )
    def get(self, request: Request) -> Response:
        user = cast(User, request.user)
        pins = (
            UserPin.objects.filter(user=user)
            .select_related("project", "project__program", "program")
            .order_by("-pinned_at")
        )
        items = [item for pin in pins if (item := _pinned_item(pin)) is not None]
        return Response(PinnedItemSerializer(items, many=True).data)


def _pinned_item(pin: UserPin) -> dict[str, Any] | None:
    """Flatten one UserPin row into the merged wire shape.

    Projects carry their parent program's id/name so the rail can render the
    "Program › Project" breadcrumb without a second lookup; programs leave both
    null.

    Returns ``None`` for a row with neither target. The XOR CheckConstraint makes
    that unreachable, but the constraint is invisible to the type checker and a
    silently skipped row is a better failure than a 500 on the whole rail.
    """
    project = pin.project
    if project is not None:
        program = project.program
        return {
            "kind": "project",
            "id": str(project.pk),
            "name": project.name,
            "code": None,
            "program_id": str(program.pk) if program is not None else None,
            "program_name": program.name if program is not None else None,
            "pinned_at": pin.pinned_at,
        }
    owning_program = pin.program
    if owning_program is None:
        return None
    return {
        "kind": "program",
        "id": str(owning_program.pk),
        "name": owning_program.name,
        "code": owning_program.code,
        "program_id": None,
        "program_name": None,
        "pinned_at": pin.pinned_at,
    }


_LAST_PLAN_LAYOUT = OpenApiResponse(
    response=ProjectViewsErrorSerializer,
    description=(
        "`code: last_plan_layout`: the write would leave Plan with no layout. A body "
        "that fails validation returns the standard field-error shape instead."
    ),
)


def _last_plan_layout_response() -> Response:
    return Response(
        {
            "code": "last_plan_layout",
            "detail": "Plan needs at least one layout. Show another layout first.",
        },
        status=400,
    )


class _ProjectViewsBase(APIView):
    """Shared scope for ``/projects/{id}/views/`` (ADR-1478 §5).

    **Self-scoped by construction.** Every read and write targets the requesting
    user's own ``ProjectViewState`` row; no parameter names another user, so there is
    no IDOR surface. ``IsProjectMember`` gates the route on live membership: any role
    (Viewer and up) may read and change *their own* navigation preference, which is not
    project data and writes nothing another member sees.
    """

    permission_classes = [IsAuthenticated, IsProjectMember]
    project_url_kwarg = "pk"

    #: An archived project is still opened and read, so its tabs must stay
    #: customizable. These writes touch only the caller's own navigation row, never
    #: project data, which is what archiving freezes.
    archived_write_exempt = (
        "Per-user navigation preference on the caller's own row; archiving freezes "
        "project data, not how a member arranges their tabs."
    )

    def _project(self, pk: Any) -> Project:
        return get_object_or_404(Project.objects.only("id", "methodology"), pk=pk, is_deleted=False)


class ProjectViewsView(McpReadableViewMixin, IdempotencyMixin, _ProjectViewsBase):
    """GET/PATCH ``/projects/{id}/views/`` — the caller's resolved view set.

    GET seeds on the first read for this ``(user, project)`` and fails open (ADR-1478
    §4). The web renders the result and never resolves precedence itself. Readable by
    MCP as ``get_project_views``: the "why can't I see Sprints?" fact.
    """

    # ADR-0678: projects/<pk>/views/ declares project_url_kwarg, so PATH scope.
    mcp_scope = McpScope.PATH

    @extend_schema(
        summary="Get my resolved view set for a project",
        responses={200: ProjectViewSetSerializer},
    )
    def get(self, request: Request, pk: Any) -> Response:
        # An agent read never seeds (ai-review): see resolve_project_views(persist=).
        resolved = services.resolve_project_views(
            request.user, self._project(pk), persist=not is_agent_token(request.auth)
        )
        return Response(ProjectViewSetSerializer(asdict(resolved)).data)

    @extend_schema(
        summary="Change my view state for a project",
        request=ProjectViewsPatchSerializer,
        responses={200: ProjectViewSetSerializer, 400: _LAST_PLAN_LAYOUT},
    )
    def patch(self, request: Request, pk: Any) -> Response:
        project = self._project(pk)
        body = ProjectViewsPatchSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        if "key" in data:
            try:
                services.set_view_hidden(request.user, project, data["key"], data["hidden"])
            except services.LastPlanLayoutError:
                return _last_plan_layout_response()
        services.update_view_state_flags(
            request.user,
            project,
            seed_line_dismissed=bool(data.get("seed_line_dismissed")),
            lens_offer_dismissed=data.get("lens_offer_dismissed"),
            last_layouts=data.get("last_layouts"),
            clear_seed=bool(data.get("clear_seed")),
        )
        resolved = services.resolve_project_views(request.user, project)
        return Response(ProjectViewSetSerializer(asdict(resolved)).data)


class ProjectViewsApplySeedView(IdempotencyMixin, _ProjectViewsBase):
    """POST ``/projects/{id}/views/apply-seed/`` — preview or apply a lens's seed (1C).

    Rewrites only ``seed`` entries; the caller's own choices come back as ``kept``.
    ``dry_run`` defaults to true so a bare POST never changes anything.
    """

    @extend_schema(
        summary="Preview or apply a lens's view suggestions",
        request=ApplySeedRequestSerializer,
        responses={200: SeedDiffSerializer, 400: _LAST_PLAN_LAYOUT},
    )
    def post(self, request: Request, pk: Any) -> Response:
        project = self._project(pk)
        body = ApplySeedRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            diff = services.apply_lens_seed(
                request.user,
                project,
                body.validated_data["lens"],
                dry_run=body.validated_data["dry_run"],
            )
        except services.LastPlanLayoutError:
            return _last_plan_layout_response()
        return Response(SeedDiffSerializer(diff).data)


class ProjectViewsResetView(IdempotencyMixin, _ProjectViewsBase):
    """POST ``/projects/{id}/views/reset/`` — restore the current lens's suggestions.

    Rewrites ``seed`` entries only; the caller's own choices are left alone.
    """

    @extend_schema(
        summary="Reset my views to my lens's suggestions",
        request=None,
        responses={200: SeedDiffSerializer, 400: _LAST_PLAN_LAYOUT},
    )
    def post(self, request: Request, pk: Any) -> Response:
        try:
            diff = services.reset_project_views(request.user, self._project(pk))
        except services.LastPlanLayoutError:
            return _last_plan_layout_response()
        return Response(SeedDiffSerializer(diff).data)
