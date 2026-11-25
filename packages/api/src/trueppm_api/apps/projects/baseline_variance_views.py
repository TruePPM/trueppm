"""``GET /projects/<project_pk>/baselines/<baseline_pk>/variance/`` (ADR-1485 D3, #5129)."""

from __future__ import annotations

from typing import Any

from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    IsProjectNotArchived,
    McpReadableViewMixin,
    McpScope,
)
from trueppm_api.apps.scheduling.calendars import project_sched_calendars
from trueppm_api.apps.scheduling.derivation_summary import finish_causes

from .baseline_variance import baseline_variance
from .models import Baseline, Project

#: ADR-1485 D7: the published contract for an experimental read.
EXPERIMENTAL_EXTENSIONS = {
    "x-experimental": True,
    "x-stability-window": "At least two minor releases of notice before a breaking change.",
}


class DerivationRefSerializer(serializers.Serializer[dict[str, Any]]):
    """The arguments of ``get_schedule_derivation`` that explain a row's current finish."""

    task_id = serializers.UUIDField()
    quantity = serializers.ChoiceField(choices=["early_finish"])


class BaselineVarianceRowSerializer(serializers.Serializer[dict[str, Any]]):
    """One task's movement against the baseline. Positive deltas mean later."""

    task_id = serializers.UUIDField()
    task_name = serializers.CharField()
    is_milestone = serializers.BooleanField()
    baseline_start = serializers.DateField(allow_null=True)
    baseline_finish = serializers.DateField(allow_null=True)
    current_start = serializers.DateField(allow_null=True)
    current_finish = serializers.DateField(allow_null=True)
    start_delta_working_days = serializers.IntegerField(allow_null=True)
    finish_delta_working_days = serializers.IntegerField(allow_null=True)
    cause = serializers.CharField(allow_null=True)
    derivation_ref = DerivationRefSerializer(allow_null=True)


class TopSlipSerializer(serializers.Serializer[dict[str, Any]]):
    """The leaf task whose finish slipped most, with the provenance of its current finish."""

    task_id = serializers.UUIDField()
    task_name = serializers.CharField()
    baseline_finish = serializers.DateField(allow_null=True)
    current_finish = serializers.DateField(allow_null=True)
    finish_delta_working_days = serializers.IntegerField()
    cause = serializers.CharField(allow_null=True)
    derivation_ref = DerivationRefSerializer(allow_null=True)


class ProjectFinishVarianceSerializer(serializers.Serializer[dict[str, Any]]):
    """The project finish (latest task finish) in the baseline and now."""

    baseline_finish = serializers.DateField(
        allow_null=True, help_text="Latest finish in the snapshot, deleted tasks included."
    )
    current_finish = serializers.DateField(
        allow_null=True, help_text="Latest finish of the live tasks, added tasks included."
    )
    delta_working_days = serializers.IntegerField(
        allow_null=True,
        help_text="Signed working days the project finish moved; positive is later.",
    )


class BaselineVarianceSummarySerializer(serializers.Serializer[dict[str, Any]]):
    """The "what moved" rollup over every row, not just this page.

    Summary tasks are left out of the counts so a slip is counted once. A task
    moved when its start or finish moved by at least ``max(min_days, 1)`` working days.
    """

    tasks_moved = serializers.IntegerField()
    tasks_finishing_later = serializers.IntegerField()
    tasks_finishing_earlier = serializers.IntegerField()
    finish_slip_working_days_total = serializers.IntegerField(
        help_text="Sum of the finish slips of the tasks finishing later, in working days."
    )
    top_slip = TopSlipSerializer(allow_null=True)
    project_finish = ProjectFinishVarianceSerializer()


class BaselineVarianceSerializer(serializers.Serializer[dict[str, Any]]):
    """The paginated variance envelope."""

    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = BaselineVarianceRowSerializer(many=True)
    baseline_id = serializers.UUIDField()
    baseline_name = serializers.CharField()
    has_cpm_dates = serializers.BooleanField()
    min_days = serializers.IntegerField()
    added = serializers.IntegerField()
    removed = serializers.IntegerField()
    summary = BaselineVarianceSummarySerializer()
    as_of = serializers.DateTimeField()


def _min_days(raw: str | None) -> int:
    if raw is None or raw == "":
        return 1
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value < 0:
        raise serializers.ValidationError({"min_days": "Must be a whole number of 0 or more."})
    return value


class BaselineVarianceView(McpReadableViewMixin, APIView):
    """Signed working-day variance per task against one baseline.

    Same audience as the baseline reads: any project member. Read-only.
    """

    # ADR-0678: projects/<project_pk>/… — an opted-out project is a 403.
    mcp_scope = McpScope.PATH
    # One CPM pass per page to derive each row's cause, so it shares the
    # derivation read's cost class and budget.
    mcp_compute_heavy = True
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "cpm_on_read"
    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]  # noqa: RUF012

    @extend_schema(
        operation_id="project_baseline_variance",
        summary="Project-wide variance against a baseline",
        parameters=[
            OpenApiParameter(
                name="min_days",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "List a task when its start or finish moved by at least this many "
                    "working days. Default 1; 0 lists every task on both sides."
                ),
            ),
            OpenApiParameter(
                name="page",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
            ),
        ],
        responses={
            200: BaselineVarianceSerializer,
            400: OpenApiResponse(description="`min_days` is not a whole number of 0 or more."),
            404: OpenApiResponse(description="Unknown project or baseline."),
        },
        extensions=EXPERIMENTAL_EXTENSIONS,
    )
    def get(self, request: Request, project_pk: str, baseline_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        baseline = get_object_or_404(
            Baseline, pk=baseline_pk, project_id=project.pk, is_deleted=False
        )
        min_days = _min_days(request.query_params.get("min_days"))
        calendar = project_sched_calendars([project.pk])[str(project.pk)]
        variance = baseline_variance(baseline, calendar, min_days=min_days)

        paginator = PageNumberPagination()
        page = paginator.paginate_queryset(variance.rows, request, view=self)
        assert page is not None  # PAGE_SIZE is set globally
        expected = {r["task_id"]: r["current_finish"] for r in page}
        top = variance.summary["top_slip"]
        if top is not None:
            # The top slip is usually on page 1 already; on any other page it joins
            # the same single CPM pass rather than costing a second one.
            expected.setdefault(top["task_id"], top["current_finish"])
        causes = finish_causes(project, expected)
        results = [{**row, **causes[row["task_id"]]} for row in page]
        summary = {
            **variance.summary,
            "top_slip": None if top is None else {**top, **causes[top["task_id"]]},
        }
        envelope = paginator.get_paginated_response(results).data
        body = {
            **envelope,
            "baseline_id": baseline.pk,
            "baseline_name": baseline.name,
            "has_cpm_dates": baseline.has_cpm_dates,
            "min_days": min_days,
            "added": variance.added,
            "removed": variance.removed,
            "summary": summary,
            "as_of": timezone.now(),
        }
        return Response(BaselineVarianceSerializer(body).data, status=status.HTTP_200_OK)
