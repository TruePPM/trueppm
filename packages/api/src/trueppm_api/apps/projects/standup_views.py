"""Daily standup walk-the-board endpoint (ADR-0166, #1278).

  GET /api/v1/projects/<project_pk>/standup/

A read-only, project-scoped assembly of the active sprint's *per-person walk* — for
each teammate, the cards they finished since the last working day, the cards in flight
today, and their current blockers — that a Scrum Master drives the Daily Scrum from.
See :mod:`standup`. Any project member (Viewer+) may read it; membership *is* the
boundary (a non-member PMO role gets 403), and the private ``blocked_reason`` free text
is never serialized.
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsProjectMember, IsProjectNotArchived
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.standup import standup_walk

# ---------------------------------------------------------------------------
# Serializers (response schema for drf-spectacular)
# ---------------------------------------------------------------------------


class StandupAssigneeSerializer(serializers.Serializer[Any]):
    id = serializers.CharField()
    name = serializers.CharField(allow_blank=True)


class StandupCardSerializer(serializers.Serializer[Any]):
    id = serializers.CharField()
    name = serializers.CharField()
    # CharField (not ChoiceField) for the raw TaskStatus value: a ChoiceField would emit
    # a second status enum component that collides with the canonical one (the #859
    # schema-drift trap that board_activity also documents).
    status = serializers.CharField()
    story_points = serializers.IntegerField(allow_null=True)
    dwell_days = serializers.IntegerField(allow_null=True)
    aging = serializers.BooleanField()
    blocker_type = serializers.CharField(allow_null=True)
    blocked_since = serializers.DateTimeField(allow_null=True)


class StandupBucketSerializer(serializers.Serializer[Any]):
    assignee = StandupAssigneeSerializer(allow_null=True)
    done = StandupCardSerializer(many=True)
    in_progress = StandupCardSerializer(many=True)
    blockers = StandupCardSerializer(many=True)


class StandupSprintSerializer(serializers.Serializer[Any]):
    id = serializers.CharField()
    name = serializers.CharField()
    goal = serializers.CharField(allow_blank=True)
    start_date = serializers.DateField()
    finish_date = serializers.DateField()


class StandupResponseSerializer(serializers.Serializer[Any]):
    active = serializers.BooleanField()
    # "continuous_cadence" | "no_active_sprint" on an inactive payload, else null.
    reason = serializers.CharField(allow_null=True)
    sprint = StandupSprintSerializer(allow_null=True)
    generated_at = serializers.DateTimeField()
    window_since = serializers.DateTimeField(allow_null=True)
    walk = StandupBucketSerializer(many=True)


class StandupView(APIView):
    """GET the active sprint's daily-standup walk (Viewer+, project members only)."""

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]  # noqa: RUF012

    @extend_schema(
        summary="Daily standup walk-the-board (active sprint, per-assignee buckets)",
        responses={200: OpenApiResponse(StandupResponseSerializer)},
    )
    def get(self, request: Request, project_pk: str) -> Response:
        # Pull the project's calendar (working-day window), its exceptions, and the
        # board column config (aging thresholds) up front — standup_walk reads all
        # three, so without this they cost +3 lazy round-trips per request (perf gate).
        project = get_object_or_404(
            Project.objects.select_related("calendar", "board_column_config").prefetch_related(
                "calendar__exceptions"
            ),
            pk=project_pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, project)
        return Response(standup_walk(project))
