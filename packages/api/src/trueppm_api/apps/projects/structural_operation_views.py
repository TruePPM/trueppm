"""Read + undo endpoints for the structural operation ledger (ADR-0880, #2974, #3006).

Follows ``batch_operation_views.py``'s shape — read-only over a server-written ledger,
one ``undo`` POST action — with two deliberate divergences, both argued in ADR-0880:

**The list is scoped tighter than its ADR-0810 siblings.** ``PasteManyOperationViewSet``
scopes to project membership with no role floor, so a Viewer reads it. For the *move*
dimension that leaks nothing (a Viewer already reads ``GET /tasks/``), but this ledger is
a *historical* record: ``shape_before`` preserves how the plan was organized before a
reorg the live tree no longer shows, ``deleted_task_ids`` names tombstoned rows, and
``applied_by`` + ``created_at`` is a per-member restructure timeline at a finer grain than
anything a Viewer has today. Scoped to actor-or-Admin, mirroring who can act on it.

**Undo is not Admin-gated.** See ``require_structural_undo_authority``.
"""

from __future__ import annotations

from typing import Any, cast

from django.db.models import Q, QuerySet
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import StructuralOperation
from trueppm_api.apps.projects.structural_operation_services import (
    StructuralUndoRejected,
    require_structural_undo_authority,
    undo_blocked_reason,
    undo_structural_operation,
)


class StructuralOperationSerializer(serializers.ModelSerializer[StructuralOperation]):
    """The ledger row plus the two computed facts a client needs to render an Undo.

    ``is_undoable`` is a server fact rather than a client derivation on purpose:
    ``status`` only answers whether the row has *already* been undone, while undoability
    also varies with live shape, stack position and region size. Without it, an API
    client listing operations sees N rows all reading ``active``, at most one of which is
    actually reversible — and the web trail and that client would each guess separately.
    """

    is_undoable = serializers.SerializerMethodField()
    undo_blocked_reason = serializers.SerializerMethodField()

    class Meta:
        model = StructuralOperation
        fields = [  # noqa: RUF012
            "id",
            "project",
            "applied_by",
            "undone_by",
            "kind",
            "status",
            "undoable",
            "is_undoable",
            "undo_blocked_reason",
            "result_summary",
            "created_at",
            "undone_at",
        ]
        read_only_fields = fields

    def get_is_undoable(self, obj: StructuralOperation) -> bool:
        return not undo_blocked_reason(obj)

    def get_undo_blocked_reason(self, obj: StructuralOperation) -> str:
        return undo_blocked_reason(obj)


class StructuralOperationViewSet(
    IdempotencyMixin, viewsets.ReadOnlyModelViewSet[StructuralOperation]
):
    serializer_class = StructuralOperationSerializer
    permission_classes = [IsAuthenticated]  # noqa: RUF012

    def get_queryset(self) -> QuerySet[StructuralOperation]:
        from trueppm_api.apps.access.models import ProjectMembership

        memberships = ProjectMembership.objects.filter(
            user=cast("Any", self.request.user), is_deleted=False
        )
        admin_project_ids = list(
            memberships.filter(role__gte=Role.ADMIN).values_list("project_id", flat=True)
        )
        member_project_ids = list(memberships.values_list("project_id", flat=True))
        # Your own acts anywhere you are a member; anyone's acts where you are Admin+.
        # A caller who can neither undo a row nor see it in their own trail has no use
        # for it, and the row is a durable record of structure the live tree no longer
        # shows.
        qs = StructuralOperation.objects.filter(
            Q(project_id__in=member_project_ids, applied_by=cast("Any", self.request.user))
            | Q(project_id__in=admin_project_ids)
        )
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    @extend_schema(
        request=None,
        responses={200: StructuralOperationSerializer},
        description=(
            "Reverse this structural act. All-or-nothing: if anything the undo would "
            "write has moved since, it refuses with 409 rather than reverting partially. "
            "Undoing an act you performed needs the same authority the act needed; "
            "undoing someone else's needs Project Manager."
        ),
    )
    @action(detail=True, methods=["post"], url_path="undo")
    def undo(self, request: Request, pk: str | None = None) -> Response:
        operation = self.get_object()
        require_structural_undo_authority(request, operation)
        try:
            summary = undo_structural_operation(
                operation,
                undone_by=request.user,
                authorize=_build_authorizer(request),
            )
        except StructuralUndoRejected as rejected:
            return Response(rejected.body, status=status.HTTP_409_CONFLICT)
        operation.refresh_from_db()
        data: dict[str, Any] = self.get_serializer(operation).data
        data["undo"] = summary
        return Response(data, status=status.HTTP_200_OK)


def _build_authorizer(request: Request) -> Any:
    """Re-check write authority the way the *forward* act did, not more strictly.

    Two different bars, matching the two things an undo does:

    ``move_rows`` are the rows the forward endpoint itself gated on — the *named* task,
    not the whole region. ``TaskIndentView`` checks the indented row only; its
    descendants and renumbered siblings move unchecked. Gating the region here would be
    stricter than the act being reversed, so a Member who legally indented their own
    assigned task under a phase of colleague-assigned rows could not undo it — exactly
    the asymmetry this design exists to remove, one layer down. Since undo is only
    reachable when the region is byte-identical to what the actor produced, re-checking
    rows the actor never needed authority over buys nothing.

    ``delete_rows`` are checked at DELETE grade, matching what ``perform_ungroup`` uses
    on the container. The default PATCH form admits the Product Owner facet on
    EPIC/STORY rows regardless of assignment, and a delete is what undo performs on that
    dimension.
    """
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.access.permissions import can_user_edit_task
    from trueppm_api.apps.projects.views import _require_wbs_restructure_permission

    def authorize(*, move_rows: list[Any], delete_rows: list[Any]) -> None:
        for task in move_rows:
            _require_wbs_restructure_permission(request, task)
        for task in delete_rows:
            if not can_user_edit_task(request, task, method="DELETE"):
                raise PermissionDenied(
                    "You do not have permission to reverse this change on this row."
                )

    return authorize
