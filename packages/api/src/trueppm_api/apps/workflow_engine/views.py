"""Operator read path for workflow instances (#2994).

Before this, a failed workflow was visible only as an aggregate count on the ops
health card: an operator could see *that* something failed but never *which*
workflow or *why*.
"""

from __future__ import annotations

from typing import Any

from django.db.models import Prefetch, QuerySet
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import IsWorkspaceOperator
from trueppm_api.apps.workflow_engine.models import WorkflowInstance, WorkflowOutboxRow
from trueppm_api.apps.workflow_engine.serializers import WorkflowInstanceSerializer


@extend_schema_view(
    list=extend_schema(
        summary="List workflow instances (operator)",
        parameters=[
            OpenApiParameter("status", str, description="Filter by workflow status."),
            OpenApiParameter("name", str, description="Exact workflow name."),
        ],
    ),
    retrieve=extend_schema(summary="Retrieve one workflow instance (operator)"),
)
class WorkflowInstanceViewSet(ListModelMixin, RetrieveModelMixin, GenericViewSet):  # type: ignore[type-arg]
    """Read-only, install-operator-only inspector for workflow instances.

    Gated on :class:`IsWorkspaceOperator` like the dead-letter inspector it sits
    beside: the error text and step internals are operator material.
    """

    serializer_class = WorkflowInstanceSerializer
    permission_classes = [IsWorkspaceOperator]
    queryset = WorkflowInstance.objects.all()

    def get_queryset(self) -> QuerySet[WorkflowInstance]:
        qs = (
            WorkflowInstance.objects.all()
            .order_by("-created_at")
            # Ordered by Meta (created_at), so the serializer reads the latest row
            # as the last element without a per-instance query.
            .prefetch_related(Prefetch("outbox_rows", queryset=WorkflowOutboxRow.objects.all()))
        )
        params: Any = self.request.query_params
        if status_filter := params.get("status"):
            qs = qs.filter(status=status_filter)
        if name := params.get("name"):
            qs = qs.filter(name=name)
        return qs
