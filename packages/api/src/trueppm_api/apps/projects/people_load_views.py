"""``GET /api/v1/me/people-load/`` — a person's load across projects (#4777, ADR-1314).

The owner of the cross-project load figure the Resource Manager home and the shell
v2 People destination render. The per-project owner is ``/projects/{id}/utilization/``;
this endpoint extends the same daily engine (:func:`utilization.compute_people_load`)
over the viewer's scope instead of summing per-project loads in the browser.
"""

from __future__ import annotations

import datetime
import uuid
from typing import Any, cast

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.projects.metric_provenance import (
    PEOPLE_LOAD_DEFINED,
    definitions_by_field,
    definitions_field_by_field,
)
from trueppm_api.apps.projects.utilization import (
    PEOPLE_LOAD_CELL_REASON_CHOICES,
    PEOPLE_LOAD_REASON_CHOICES,
    compute_people_load,
)

#: Default and ceiling for the ``weeks`` parameter. The ceiling bounds the per-day
#: engine walk (``O(assignments × days)``) the same way ``/utilization/``'s ±8-week
#: cap does; half a year is the longest horizon a load heat map is read over.
DEFAULT_WEEKS = 8
MAX_WEEKS = 26


class _PeopleLoadCellSerializer(serializers.Serializer[dict[str, Any]]):
    week_start = serializers.DateField(help_text="The Monday that starts the week.")
    load_pct = serializers.IntegerField(
        allow_null=True, help_text="Whole-number percent; null when `reason` is set."
    )
    overallocated = serializers.BooleanField(help_text="`load_pct` is over 100.")
    reason = serializers.ChoiceField(
        choices=PEOPLE_LOAD_CELL_REASON_CHOICES,
        allow_null=True,
        help_text=(
            "Why `load_pct` is null (rule 119): `no_capacity` when the person has no "
            "working time that week (all of it time off, or zero units). Null when computed."
        ),
    )


class _PeopleLoadPersonSerializer(serializers.Serializer[dict[str, Any]]):
    resource_id = serializers.UUIDField()
    name = serializers.CharField()
    initials = serializers.CharField()
    job_role = serializers.CharField()
    overallocated = serializers.BooleanField(help_text="Over 100% in at least one week.")
    peak_load_pct = serializers.IntegerField(
        allow_null=True, help_text="The highest weekly `load_pct`; null when no week is computable."
    )
    project_count = serializers.IntegerField(
        help_text="Projects in scope that book this person in the range."
    )
    cells = _PeopleLoadCellSerializer(many=True, help_text="One per entry of `weeks`, in order.")


class _PeopleLoadWindowSerializer(serializers.Serializer[dict[str, Any]]):
    start = serializers.DateField()
    end = serializers.DateField()


class _PeopleLoadScopeSerializer(serializers.Serializer[dict[str, Any]]):
    project_count = serializers.IntegerField(help_text="Projects whose bookings are counted.")
    withheld_project_count = serializers.IntegerField(
        help_text=(
            "Projects you have a role in but whose per-person load you may not read "
            "(below Scheduler, the gate on /projects/{id}/utilization/, or outside "
            "the ADR-0104 `capacity` signal audience); their bookings are not counted."
        )
    )
    program_id = serializers.UUIDField(allow_null=True)


class PeopleLoadSerializer(serializers.Serializer[dict[str, Any]]):
    """Response for ``GET /api/v1/me/people-load/`` (#4777)."""

    as_of = serializers.DateTimeField(help_text="When the server computed this payload.")
    window = _PeopleLoadWindowSerializer(help_text="The range covered, inclusive.")
    weeks = serializers.ListField(child=serializers.DateField(), help_text="Week-start Mondays.")
    scope = _PeopleLoadScopeSerializer()
    people = _PeopleLoadPersonSerializer(
        many=True, help_text="Most loaded first (peak load, then name)."
    )
    over_allocated_count = serializers.IntegerField()
    reason = serializers.ChoiceField(
        choices=PEOPLE_LOAD_REASON_CHOICES,
        allow_null=True,
        help_text=(
            "Why `people` is empty (rule 119): `no_projects` when no project is in "
            "scope, `no_people` when the scoped projects have nobody on their roster "
            "and nobody booked in the range. Null otherwise."
        ),
    )
    definitions = definitions_field_by_field("PeopleLoadDefinitions", PEOPLE_LOAD_DEFINED)


def _parse_params(request: Request) -> tuple[datetime.date, int, uuid.UUID | None] | Response:
    """Validate ``week_start`` / ``weeks`` / ``program``; a 400 ``Response`` on bad input."""
    errors: dict[str, list[str]] = {}
    today = timezone.localdate()
    raw_start = request.query_params.get("week_start")
    start = today
    if raw_start:
        try:
            start = datetime.date.fromisoformat(raw_start)
        except ValueError:
            errors["week_start"] = ["Expected a date, YYYY-MM-DD."]
    # Snap to the Monday of that week, so every caller sees the same week buckets.
    start -= datetime.timedelta(days=start.weekday())

    weeks = DEFAULT_WEEKS
    raw_weeks = request.query_params.get("weeks")
    if raw_weeks:
        try:
            weeks = int(raw_weeks)
        except ValueError:
            weeks = 0
        if not 1 <= weeks <= MAX_WEEKS:
            errors["weeks"] = [f"Expected a whole number from 1 to {MAX_WEEKS}."]

    program: uuid.UUID | None = None
    raw_program = request.query_params.get("program")
    if raw_program:
        try:
            program = uuid.UUID(raw_program)
        except ValueError:
            errors["program"] = ["Expected a program id (UUID)."]

    if errors:
        return Response(errors, status=status.HTTP_400_BAD_REQUEST)
    return start, weeks, program


class MePeopleLoadView(APIView):
    """``GET /api/v1/me/people-load/`` — weekly load per person across your projects.

    **Scope is the viewer's own project roles, and nothing wider.** The projects
    counted are the live, non-draft projects the requester holds a live
    ``ProjectMembership`` on, narrowed to one program with ``?program=``. A program
    role alone adds no projects: program membership does not grant project access
    (ADR-0070 "explicit grants only"), and a load figure is project data. Nothing
    here is org-wide or cross-portfolio; that heat map is Enterprise.

    **A project counts only where the viewer may already read per-person load on
    it**: Scheduler or above, the gate on ``/projects/{id}/utilization/``. And **the
    per-person breakdown is the ADR-0104 ``capacity`` signal**, the same one
    the sprint capacity panel's member rows sit behind. A project whose policy keeps
    per-person capacity from this reader is dropped from the scope before anything
    is computed, and counted in ``scope.withheld_project_count`` so the figure says
    what it leaves out. Gating at every sink keeps this lens from being a side
    channel around the panel's suppression.

    Drafts are excluded for the reason the My Work aggregates exclude them: a
    half-built plan's bookings would put someone over capacity on paper.
    """

    permission_classes = [IsAuthenticated]  # noqa: RUF012

    @extend_schema(
        summary="A person's weekly load across the projects you have a role in",
        parameters=[
            OpenApiParameter(
                "week_start",
                OpenApiTypes.DATE,
                description=(
                    "Any date in the first week; snapped to its Monday. Default: this week."
                ),
            ),
            OpenApiParameter(
                "weeks",
                OpenApiTypes.INT,
                description=f"Number of weeks, 1 to {MAX_WEEKS}. Default {DEFAULT_WEEKS}.",
            ),
            OpenApiParameter(
                "program",
                OpenApiTypes.UUID,
                description="Count only your projects in this program.",
            ),
        ],
        responses={
            200: OpenApiResponse(response=PeopleLoadSerializer),
            400: OpenApiResponse(
                response=OpenApiTypes.OBJECT, description="A parameter failed validation."
            ),
        },
    )
    def get(self, request: Request) -> Response:
        from trueppm_api.apps.access.models import ProjectMembership, Role
        from trueppm_api.apps.projects.lifecycle import exclude_draft_projects
        from trueppm_api.apps.projects.signal_privacy_services import (
            can_read_signal_for_projects,
        )

        parsed = _parse_params(request)
        if isinstance(parsed, Response):
            return parsed
        week_start, weeks, program = parsed

        memberships = ProjectMembership.objects.filter(
            # IsAuthenticated has resolved the caller; narrow django-stubs' ``int | None``.
            user_id=cast("int", request.user.pk),
            is_deleted=False,
            project__is_deleted=False,
        )
        if program is not None:
            memberships = memberships.filter(project__program_id=program)
        roles = {
            str(pid): role
            for pid, role in exclude_draft_projects(memberships).values_list("project_id", "role")
        }
        candidate_ids = list(roles)
        # Gate 1, the per-project owner's own gate: ``/projects/{id}/utilization/``
        # is Scheduler+ (the Resource Manager band), so a Member or Viewer of a
        # project must not read its per-person load through this lens either.
        schedulable = [pid for pid in candidate_ids if roles[pid] >= Role.SCHEDULER]
        # Gate 2, the ADR-0104 ``capacity`` signal the sprint panel's member rows
        # sit behind, so the two sinks of per-person capacity agree.
        readable = can_read_signal_for_projects(request, schedulable, "capacity")
        project_ids = [pid for pid in schedulable if readable.get(pid)]

        payload = compute_people_load(project_ids, week_start, weeks)
        return Response(
            {
                "as_of": timezone.now().isoformat(),
                **payload,
                "scope": {
                    "project_count": len(project_ids),
                    "withheld_project_count": len(candidate_ids) - len(project_ids),
                    "program_id": str(program) if program else None,
                },
                "definitions": definitions_by_field(PEOPLE_LOAD_DEFINED),
            },
            status=status.HTTP_200_OK,
        )
