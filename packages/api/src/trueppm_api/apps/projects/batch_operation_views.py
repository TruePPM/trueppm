"""Read + undo endpoints for the schedule outline's batch operation ledgers (ADR-0810, #2756).

Mirrors ``template_views.py``'s ``TemplateApplicationViewSet`` shape exactly:
read-only (these are server-written ledger rows, no client create/update/delete
door), scoped to the caller's project memberships, one ``undo`` POST action per
viewset. See ``task_batch_services.py`` for the actual undo logic — these views
are a thin RBAC + status-guard layer over it, same division of labor as the
template application endpoint.
"""

from __future__ import annotations

from typing import Any, cast

from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.permissions import (
    IsProjectNotArchived,
    _membership_role,
    role_can_undo_batch_operation,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    CascadeClassificationOperation,
    PasteManyOperation,
    SyncBatchOperationStatus,
)
from trueppm_api.apps.projects.task_batch_services import (
    undo_cascade_classification_operation,
    undo_paste_many_operation,
)
from trueppm_api.core.openapi import state_refusal_400


def _caller_project_ids(request: Request) -> QuerySet[Any]:
    from trueppm_api.apps.access.models import ProjectMembership

    return ProjectMembership.objects.filter(
        user=cast("Any", request.user), is_deleted=False
    ).values_list("project_id", flat=True)


def _require_admin(request: Request, project_id: Any) -> None:
    """⌘Z on a batch write is Admin+, the same bar as undoing a template apply
    (ADR-0773's "who may reverse a plan-shaping batch write" matrix). A plain
    Member may have authored the paste/cascade under Author mode, but undoing
    it removes work other collaborators may already be building on top of.

    Defers the comparison to :func:`role_can_undo_batch_operation` rather than
    testing the ordinal here, because the cascade's apply endpoint reports the
    same rule to the client as ``can_undo`` and the two must not drift (#3304).
    """
    if not role_can_undo_batch_operation(_membership_role(request, project_id)):
        raise PermissionDenied("You need at least Project Manager role to undo this.")


class PasteManyOperationSerializer(serializers.ModelSerializer[PasteManyOperation]):
    class Meta:
        model = PasteManyOperation
        fields = [  # noqa: RUF012
            "id",
            "project",
            "applied_by",
            "status",
            "created_task_versions",
            "result_summary",
            "created_at",
            "undone_at",
        ]
        read_only_fields = fields


class PasteManyOperationViewSet(
    IdempotencyMixin, viewsets.ReadOnlyModelViewSet[PasteManyOperation]
):
    serializer_class = PasteManyOperationSerializer
    # `undo` hard-deletes task rows, so this route is a write path and carries the
    # archived floor every sibling in the family carries (`StructuralOperationViewSet`,
    # `CsvImportUndoView`, `TaskBulkView`, `TaskClassificationView`). Reads are
    # unaffected — `IsProjectNotArchived` passes every SAFE_METHOD, so polling a
    # ledger row on an archived project still works (#3354).
    #
    # It resolves the project from the *object*, not a URL kwarg: this viewset is
    # router-registered at the top level, so `has_permission` finds no `project_pk`
    # and returns True, and the real check runs in `has_object_permission` off the
    # operation's `project_id` during `get_object()`. Role authority stays in
    # `_require_admin` below — this class enforces lifecycle state only.
    permission_classes = [IsAuthenticated, IsProjectNotArchived]  # noqa: RUF012

    def get_queryset(self) -> QuerySet[PasteManyOperation]:
        qs = PasteManyOperation.objects.filter(project_id__in=_caller_project_ids(self.request))
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    @extend_schema(
        request=None,
        responses={
            200: PasteManyOperationSerializer,
            400: state_refusal_400(
                "This batch has already been undone. Verified against the status "
                "guard in ``undo`` (#3319)."
            ),
        },
        description=(
            "Undo this paste-many batch — removes the rows it created that nobody has edited."
        ),
    )
    @action(detail=True, methods=["post"], url_path="undo")
    def undo(self, request: Request, pk: str | None = None) -> Response:
        operation = self.get_object()
        _require_admin(request, operation.project_id)
        if operation.status == SyncBatchOperationStatus.UNDONE:
            raise ValidationError({"detail": "This batch has already been undone."})
        summary = undo_paste_many_operation(operation)
        operation.refresh_from_db()
        data: dict[str, Any] = self.get_serializer(operation).data
        data["undo"] = summary
        return Response(data, status=status.HTTP_200_OK)


class CascadeClassificationOperationSerializer(
    serializers.ModelSerializer[CascadeClassificationOperation]
):
    class Meta:
        model = CascadeClassificationOperation
        fields = [  # noqa: RUF012
            "id",
            "project",
            "applied_by",
            "subtree_id",
            "status",
            "task_snapshots",
            "result_summary",
            "created_at",
            "undone_at",
        ]
        read_only_fields = fields


class CascadeClassificationOperationViewSet(
    IdempotencyMixin, viewsets.ReadOnlyModelViewSet[CascadeClassificationOperation]
):
    serializer_class = CascadeClassificationOperationSerializer
    # Same reasoning as `PasteManyOperationViewSet` above — `undo` writes
    # classification fields back onto existing rows, so it is a write path and takes
    # the archived floor (#3354).
    permission_classes = [IsAuthenticated, IsProjectNotArchived]  # noqa: RUF012

    def get_queryset(self) -> QuerySet[CascadeClassificationOperation]:
        qs = CascadeClassificationOperation.objects.filter(
            project_id__in=_caller_project_ids(self.request)
        )
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    @extend_schema(
        request=None,
        responses={
            200: CascadeClassificationOperationSerializer,
            400: state_refusal_400(
                "This cascade has already been undone. Verified against the status "
                "guard in ``undo`` (#3319)."
            ),
        },
        description="Undo this cascade — restores each untouched row's prior classification.",
    )
    @action(detail=True, methods=["post"], url_path="undo")
    def undo(self, request: Request, pk: str | None = None) -> Response:
        operation = self.get_object()
        _require_admin(request, operation.project_id)
        if operation.status == SyncBatchOperationStatus.UNDONE:
            raise ValidationError({"detail": "This cascade has already been undone."})
        summary = undo_cascade_classification_operation(operation)
        operation.refresh_from_db()
        data: dict[str, Any] = self.get_serializer(operation).data
        data["undo"] = summary
        return Response(data, status=status.HTTP_200_OK)
