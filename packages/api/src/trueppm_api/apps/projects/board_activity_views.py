"""Board-level activity feed endpoint (ADR-0160, #325).

  GET /api/v1/projects/<project_pk>/board/activity?until=&since=&actor=&type=&limit=

A read-only, board-scoped, filterable feed of card mutations (status/assignee/points
changes, sprint entries/exits, comments) aggregated from existing change-history
sources — see :mod:`board_activity`. Any project member (Viewer+) may read it; the
keyset cursor is ``until`` (pass the response's ``next_until`` back to page).
"""

from __future__ import annotations

from typing import Any

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    _membership_role,
)
from trueppm_api.apps.projects.board_activity import (
    EVENT_TYPES,
    MAX_LIMIT,
    build_board_activity,
)
from trueppm_api.apps.projects.models import Project

# ---------------------------------------------------------------------------
# Serializers (response schema for drf-spectacular)
# ---------------------------------------------------------------------------


class BoardActivityChangeSerializer(serializers.Serializer[Any]):
    field = serializers.CharField()
    old = serializers.CharField(allow_null=True)
    new = serializers.CharField(allow_null=True)


class BoardActivityEventSerializer(serializers.Serializer[Any]):
    id = serializers.CharField()
    # CharField (not ChoiceField) deliberately: a ChoiceField over EVENT_TYPES emits a
    # second `event_type` enum component that collides with the existing one and renames
    # the canonical `EventTypeEnum` in the schema (the #859 schema-drift trap). The valid
    # values are documented on the `type` query parameter instead.
    event_type = serializers.CharField()
    actor = serializers.CharField(allow_null=True)
    actor_id = serializers.CharField(allow_null=True)
    timestamp = serializers.DateTimeField()
    task_id = serializers.CharField()
    task_name = serializers.CharField()
    sprint_id = serializers.CharField(allow_null=True)
    # SprintScopeChange accept-gate status (pending/accepted/rejected) on `entered_sprint`
    # events, else null (ADR-0160 Amendment B3, #1264). CharField not ChoiceField for the
    # same #859 enum-collision reason as `event_type` above.
    scope_change_status = serializers.CharField(allow_null=True)
    changes = BoardActivityChangeSerializer(many=True)


class BoardActivityResponseSerializer(serializers.Serializer[Any]):
    results = BoardActivityEventSerializer(many=True)
    next_until = serializers.DateTimeField(allow_null=True)


def _parse_dt(raw: str | None, field: str) -> Any:
    """Parse an ISO datetime query param into an aware datetime, or 400 on garbage."""
    if raw is None:
        return None
    parsed = parse_datetime(raw)
    if parsed is None:
        from rest_framework.exceptions import ValidationError

        raise ValidationError({field: f"Invalid datetime '{raw}' (expected ISO 8601)."})
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


class BoardActivityView(APIView):
    """GET the board's filterable, time-ordered activity feed (Viewer+)."""

    # IsProjectNotArchived is deliberately omitted: history/activity is a read-only
    # audit surface that must stay accessible after a project is archived. (It was
    # also a no-op here — the permission passes all SAFE_METHODS and this view is
    # GET-only — so listing it only misdocumented the RBAC contract; #1890.)
    permission_classes = [IsAuthenticated, IsProjectMember]  # noqa: RUF012

    @extend_schema(
        summary="Board-level activity feed (filterable, board-scoped)",
        parameters=[
            OpenApiParameter(
                "until",
                str,
                description="Keyset cursor — events older than this ISO datetime (default now).",
            ),
            OpenApiParameter(
                "since", str, description="Lower time bound (inclusive ISO datetime)."
            ),
            OpenApiParameter("actor", str, description="Filter to one actor (user id)."),
            OpenApiParameter(
                "type",
                str,
                description=f"Comma-separated event types: {', '.join(sorted(EVENT_TYPES))}.",
            ),
            OpenApiParameter("limit", int, description=f"Page size (1..{MAX_LIMIT}, default 50)."),
        ],
        responses={200: OpenApiResponse(BoardActivityResponseSerializer)},
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        until = _parse_dt(request.query_params.get("until"), "until")
        since = _parse_dt(request.query_params.get("since"), "since")
        # actor is an opaque user-id string (integer PKs); an unknown/garbage value
        # simply matches nothing, which is standard REST for a filter param.
        actor_id = request.query_params.get("actor") or None

        types_raw = request.query_params.get("type")
        event_types: set[str] | None = None
        if types_raw:
            requested = {t.strip() for t in types_raw.split(",") if t.strip()}
            unknown = requested - EVENT_TYPES
            if unknown:
                return Response(
                    {"type": f"Unknown event type(s): {', '.join(sorted(unknown))}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            event_types = requested

        try:
            limit = int(request.query_params.get("limit", 50))
        except (TypeError, ValueError):
            return Response({"limit": "Must be an integer."}, status=status.HTTP_400_BAD_REQUEST)

        payload = build_board_activity(
            project,
            until=until,
            since=since,
            actor_id=actor_id,
            event_types=event_types,
            limit=limit,
            role=_membership_role(request, project.pk),
        )
        return Response(payload)
