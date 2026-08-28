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
from drf_spectacular.utils import extend_schema, extend_schema_field
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    IsProjectMemberWrite,
    IsProjectNotArchived,
    IsProjectPlanAuthor,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Project, StructuralOperation
from trueppm_api.apps.projects.refusal_codes import StructuralUndoBlockedReason
from trueppm_api.apps.projects.structural_operation_services import (
    StructuralUndoRejected,
    require_structural_undo_authority,
    undo_blocked_reason,
    undo_structural_operation,
)
from trueppm_api.apps.projects.structural_operation_services import (
    may_undo as _may_undo,
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

    #: Per-serialization memo. DRF calls both method fields for every row, and the
    #: underlying check costs up to five queries — one of which reads the whole
    #: project's live task set on a root-level gesture. Keyed on pk and scoped to this
    #: serializer instance, so it lives exactly as long as one request's page.
    _reason_cache: dict[Any, str]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._reason_cache = {}

    def _reason(self, obj: StructuralOperation) -> str:
        """The blocked-reason for this row, computed at most once.

        Memoized on the instance because DRF calls both method fields, and the
        underlying check costs up to five queries — one of which (`capture_shape` on
        a root-level gesture) reads every live task in the project. Unmemoized, a
        50-row page paid that twice per row.

        `shape_changed` is deliberately NOT evaluated in a list. It is the expensive
        arm, and it is racy by construction: it can flip between the client reading
        the list and clicking Undo, and the 409 on the write is the authoritative
        answer either way. `retrieve` asks the full question; the list reports the
        three cheap, stable reasons.
        """
        cached = self._reason_cache.get(obj.pk)
        if cached is None:
            request = self.context.get("request")
            if request is not None and not _may_undo(request, obj):
                cached = StructuralUndoBlockedReason.FORBIDDEN.value
            else:
                cached = undo_blocked_reason(obj, check_shape=bool(self.context.get("detail")))
            self._reason_cache[obj.pk] = cached
        return cached

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
        return not self._reason(obj)

    @extend_schema_field(
        serializers.ChoiceField(
            choices=StructuralUndoBlockedReason.choices,
            help_text=(
                "Why this operation cannot be undone, from a closed set (#3037). The "
                "empty string means it can. `shape_changed` is evaluated only on the "
                "detail read — it is racy by construction, and the 409 on the write is "
                "authoritative either way."
            ),
        )
    )
    def get_undo_blocked_reason(self, obj: StructuralOperation) -> str:
        return self._reason(obj)


class StructuralOperationViewSet(
    IdempotencyMixin, viewsets.ReadOnlyModelViewSet[StructuralOperation]
):
    serializer_class = StructuralOperationSerializer
    # Parity with the six forward endpoints this reverses. `IsProjectNotArchived` is
    # the load-bearing one: it is the ONLY place `Project.is_archived` is enforced in
    # the codebase, so without it a Member who indented before archival could still
    # rewrite an archived plan's WBS, resurrect its tombstoned rows and restore its
    # dependency edges — a write no role can otherwise make without unarchiving.
    # `IsProjectPlanAuthor` matches group/ungroup, keeping the resource-management
    # band excluded from reversing a plan-shaping write as well as making one.
    permission_classes = [  # noqa: RUF012
        IsAuthenticated,
        IsProjectMemberWrite,
        IsProjectPlanAuthor,
        IsProjectNotArchived,
    ]

    def get_serializer_context(self) -> dict[str, Any]:
        context: dict[str, Any] = dict(super().get_serializer_context())
        # Only the detail read pays for the drift comparison (see `undo_blocked_reason`).
        context["detail"] = self.action in {"retrieve", "undo"}
        return context

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
        # get_object() runs has_object_permission against the *operation*; the
        # archived/member gates resolve the project off it. Explicit rather than
        # implicit because `_project_pk_from_view` cannot resolve a project from this
        # route's kwargs (there is no `project_pk` segment), so the declarative
        # has_permission pass is non-load-bearing here — the in-body call is what
        # actually enforces it (#2745).
        project = Project.objects.filter(pk=operation.project_id, is_deleted=False).first()
        if project is None:
            raise NotFound("Project not found.")
        self.check_object_permissions(request, project)
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

    ``restore_rows`` — rows the act soft-deleted, which undo brings back — are checked
    at DELETE grade, matching what ``perform_ungroup`` uses on the container. The
    default PATCH form admits the Product Owner facet on EPIC/STORY rows regardless of
    assignment; the delete-grade form does not, and deleting is what the forward act
    did to those rows.

    Rows the act **minted** are deliberately absent. `perform_group` creates its
    container unassigned and requires no delete authority to create it, so requiring
    delete authority to remove it again would deny a Member the reversal of their own
    group. They are covered by ``move_rows``.
    """
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.access.permissions import can_user_edit_task
    from trueppm_api.apps.projects.views import _require_wbs_restructure_permission

    def authorize(*, move_rows: list[Any], restore_rows: list[Any]) -> None:
        for task in move_rows:
            _require_wbs_restructure_permission(request, task)
        for task in restore_rows:
            if not can_user_edit_task(request, task, method="DELETE"):
                raise PermissionDenied(
                    "You do not have permission to reverse this change on this row."
                )

    return authorize
