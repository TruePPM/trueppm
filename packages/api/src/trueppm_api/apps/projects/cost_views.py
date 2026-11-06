"""Project cost summary endpoint (ADR-1324 §6, #754).

``GET /api/v1/projects/{pk}/cost/`` — budget, actual cost, earned value, and the two
EVM KPIs for one project, with the per-person lines and one-sentence definitions that
let a PM or an agent explain every number. Project ADMIN+ only: a Member or Viewer
never receives a cost value (ADR-1324 §4). Pure read; nothing is written, dispatched,
or broadcast.
"""

from __future__ import annotations

from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectNotArchived,
    McpReadableViewMixin,
    McpScope,
)
from trueppm_api.apps.projects.models import Project


def _money(*, allow_null: bool = False) -> serializers.DecimalField:
    """A read-only amount (or hour count): a decimal string with two places."""
    return serializers.DecimalField(
        max_digits=18, decimal_places=2, read_only=True, allow_null=allow_null
    )


class CostKpiSerializer(serializers.Serializer[dict[str, Any]]):
    """``{available, value | reason}`` for one cost KPI (ADR-1324 §3)."""

    available = serializers.BooleanField(read_only=True)
    value = serializers.JSONField(
        read_only=True,
        required=False,
        allow_null=True,
        help_text=(
            "cost_variance: a decimal string in the workspace currency. "
            "budget_utilization: a number, 1.0 = whole budget spent."
        ),
    )
    reason = serializers.ChoiceField(
        choices=["no_budget", "missing_rates", "cost_restricted"],
        read_only=True,
        required=False,
        help_text="Why there is no value: no_budget, missing_rates, or cost_restricted.",
    )


class MissingRateSerializer(serializers.Serializer[dict[str, Any]]):
    """A person in scope who has no rate — named so the PM can fix it, never priced."""

    resource_id = serializers.UUIDField(read_only=True, allow_null=True)
    user_id = serializers.IntegerField(read_only=True, allow_null=True)
    name = serializers.CharField(read_only=True)


class CostLineSerializer(serializers.Serializer[dict[str, Any]]):
    """One person's hours x rate on this project; ``cost`` is null when unrated."""

    resource_id = serializers.UUIDField(read_only=True, allow_null=True)
    name = serializers.CharField(read_only=True)
    hours = _money()
    rate = serializers.DecimalField(
        max_digits=12, decimal_places=2, read_only=True, allow_null=True
    )
    cost = _money(allow_null=True)


class ProjectCostSerializer(serializers.Serializer[dict[str, Any]]):
    """Response for ``GET /api/v1/projects/{id}/cost/`` (ADR-1324 §6).

    Amounts are decimal strings in ``currency`` (one workspace currency, no FX).
    ``actual`` sums each line's rounded ``cost``, so the lines add up to it exactly.
    ``cost_computable`` is false when anyone in scope lacks a rate, in which case
    ``actual`` is the priced part only and the KPIs report ``missing_rates``.
    """

    project_id = serializers.UUIDField(read_only=True)
    currency = serializers.CharField(read_only=True)
    as_of = serializers.DateTimeField(read_only=True)
    budget = _money(allow_null=True)
    actual = _money()
    # Never null: a project with no live tasks reports 0 (cost.project_cost_facts).
    percent_complete = serializers.DecimalField(max_digits=5, decimal_places=2, read_only=True)
    earned_value = _money(allow_null=True)
    cost_variance = CostKpiSerializer(read_only=True)
    budget_utilization = CostKpiSerializer(read_only=True)
    cost_computable = serializers.BooleanField(read_only=True)
    missing_rate_count = serializers.IntegerField(read_only=True)
    missing_rate_resources = MissingRateSerializer(many=True, read_only=True)
    logged_hours = _money()
    priced_hours = _money()
    unpriced_hours = _money()
    lines = CostLineSerializer(many=True, read_only=True)
    definitions = serializers.DictField(child=serializers.CharField(), read_only=True)


class ProjectCostView(McpReadableViewMixin, APIView):
    """Budget, actual cost and earned value for one project (ADR-1324).

    Permission: project ADMIN+ (Project Manager). Rates appear on ``lines`` only for
    people who logged time on this project — and logging time requires Member+ here
    — so a self-created project exposes no one's rate (ADR-1324 §4). MCP-readable on
    the PATH scope; a token is judged by its user's role.
    """

    mcp_scope = McpScope.PATH
    project_url_kwarg = "pk"
    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]  # noqa: RUF012

    @extend_schema(
        summary="Project cost: budget, actual cost, earned value",
        responses={200: ProjectCostSerializer},
    )
    def get(self, request: Request, pk: str) -> Response:
        """Return the project's cost facts. Pure read, recomputed on every GET."""
        from trueppm_api.apps.projects.cost import project_cost_facts, project_cost_payload
        from trueppm_api.apps.workspace.models import Workspace

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        cost = project_cost_facts([project.pk])[project.pk]
        payload = project_cost_payload(cost, Workspace.load().currency)
        return Response(ProjectCostSerializer(payload).data)
