"""Views for the program backlog (ADR-0069 Erratum, #737 / #739).

``BacklogItem`` is a program-scoped CRUD resource nested under a program, plus a
``pull`` action that converts a PROPOSED item into a project-backlog Task. The
project-backlog *read* (Task with ``status=BACKLOG``, ``sprint=NULL``) is served
by the existing ``TaskViewSet`` filters (``?status=BACKLOG&sprint=none``) — no
separate endpoint is added here.

Permission matrix (ADR-0069 Erratum §4):
  list / retrieve         — IsProgramMember (Viewer+)
  create / update / destroy — IsProgramEditor (Team Member+)
  pull                    — IsProgramEditor **and** write role on the target project
"""

from __future__ import annotations

from django.contrib.postgres.search import TrigramSimilarity
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    IsProgramEditor,
    IsProgramMember,
    IsProgramNotClosed,
    _membership_role,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.backlog_services import (
    BacklogItemNotPullable,
    CrossProgramPullError,
    pull_to_project_backlog,
)
from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemStatus,
    Program,
    Project,
)
from trueppm_api.apps.projects.serializers import BacklogItemSerializer, TaskSerializer


class BacklogItemViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[BacklogItem],
):
    """CRUD + pull for program backlog items.

    URL: ``/api/v1/programs/<program_pk>/backlog-items/[<pk>/]``
         ``/api/v1/programs/<program_pk>/backlog-items/<pk>/pull/``
    """

    serializer_class = BacklogItemSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProgramMember(), IsProgramNotClosed()]
        # create / update / partial_update / destroy / pull all require program
        # write (Team Member+). The pull action additionally checks project-write
        # on the resolved target inside the handler.
        return [IsAuthenticated(), IsProgramEditor(), IsProgramNotClosed()]

    def get_queryset(self) -> QuerySet[BacklogItem]:
        """Program-scoped backlog.

        The list view layers on item_type / status / tags / ``?q=`` filters and
        defaults ``status`` to PROPOSED (the active pool). Those filters are
        **list-only** — detail operations (retrieve / update / destroy) must be
        able to reach an item in *any* status (e.g. PATCH an item to ARCHIVED,
        or fetch a PULLED item), so they get the unfiltered program-scoped set.
        """
        program_pk = str(self.kwargs["program_pk"])
        qs = BacklogItem.objects.filter(program_id=program_pk, is_deleted=False).select_related(
            "pulled_task", "created_by", "pulled_by"
        )

        if self.action != "list":
            return qs

        item_type = self.request.query_params.get("item_type")
        if item_type:
            qs = qs.filter(item_type=item_type)

        # status: explicit value filters; a present-but-empty value means "all";
        # absent means the default active pool (PROPOSED).
        if "status" in self.request.query_params:
            status_filter = self.request.query_params.get("status")
            if status_filter:
                qs = qs.filter(status=status_filter)
        else:
            qs = qs.filter(status=BacklogItemStatus.PROPOSED)

        # tags: repeatable ?tags=foo&tags=bar — match items carrying ALL given tags.
        tags = self.request.query_params.getlist("tags")
        for tag in tags:
            if tag:
                qs = qs.filter(tags__contains=[tag])

        # Trigram fuzzy search on title (#739). Combines with the filters above;
        # an empty/absent q is a no-op (other filters + default ordering apply).
        #
        # The FILTER uses the ``%`` operator (``__trigram_similar``) — this is the
        # form the ``gin_trgm_ops`` GIN index (backlogitem_title_trgm) accelerates,
        # so search scales as the ADR intends rather than seq-scanning a computed
        # similarity per row. The ``%`` operator honours pg_trgm's
        # ``similarity_threshold`` (default 0.3). We additionally annotate the
        # whole-string similarity and order by it desc so the closest title ranks
        # first, overriding the model's default priority_rank ordering for searches.
        q = (self.request.query_params.get("q") or "").strip()
        if q:
            qs = (
                qs.annotate(similarity=TrigramSimilarity("title", q))
                .filter(title__trigram_similar=q)
                .order_by("-similarity")
            )

        return qs

    def _resolve_program(self) -> Program:
        program = get_object_or_404(Program, pk=self.kwargs["program_pk"], is_deleted=False)
        # DRF skips has_object_permission on create/custom actions — enforce the
        # program role gate against the resolved program before any write.
        self.check_object_permissions(self.request, program)
        return program

    def perform_create(self, serializer: BaseSerializer[BacklogItem]) -> None:
        program = self._resolve_program()
        # status is forced to PROPOSED on create regardless of payload — a new
        # item always enters the active pool; PULLED/ARCHIVED are reached later
        # via the pull action / archive PATCH.
        serializer.save(
            program=program,
            created_by=self.request.user,
            status=BacklogItemStatus.PROPOSED,
        )

    def perform_destroy(self, instance: BacklogItem) -> None:
        # Soft-delete so the sync protocol ships a tombstone rather than the row
        # vanishing silently (VersionedModel contract).
        instance.soft_delete()

    @action(detail=True, methods=["post"], url_path="pull")
    def pull(self, request: Request, program_pk: str, pk: str) -> Response:
        """Pull a PROPOSED item into a project's backlog (ADR-0069 Erratum §5).

        Body: ``{"project_id": "<uuid>"}``. Creates a Task (status=BACKLOG,
        sprint=NULL) in the target project and transitions the item to PULLED.
        Requires program-write (gated by ``get_permissions``) **and** write role
        on the target project (checked here). Never assigns a sprint.

        Returns ``201`` with the created task and the updated backlog item.
        ``400`` if project_id is missing / not in this program; ``403`` if the
        caller lacks project-write; ``409`` if the item is no longer PROPOSED.
        """
        # Confirm the program exists and the caller holds program-write.
        self._resolve_program()

        project_id = request.data.get("project_id")
        if not project_id:
            return Response(
                {"detail": "project_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Resolve the target project, scoped to this program. A project_id that
        # is not in the program returns 404-as-400 (cross-program pull rejected).
        try:
            project = Project.objects.get(pk=project_id, program_id=program_pk, is_deleted=False)
        except (Project.DoesNotExist, ValueError, DjangoValidationError):
            return Response(
                {"detail": "Target project not found in this program."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Project-level write gate: program-write alone is not enough to drop a
        # Task into a project — the caller must also be Team Member+ on it.
        role = _membership_role(request, project.pk)
        if role is None or role < Role.MEMBER:
            return Response(
                {"detail": "You need at least Team Member role on the target project."},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            task = pull_to_project_backlog(item_id=str(pk), project=project, actor=request.user)
        except BacklogItem.DoesNotExist:
            return Response(
                {"detail": "Backlog item not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        except CrossProgramPullError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except BacklogItemNotPullable as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)

        # Re-fetch with the FK joins the serializer reads (pulled_task/by,
        # created_by) so the pull response doesn't fire lazy per-FK queries.
        item = BacklogItem.objects.select_related("pulled_task", "created_by", "pulled_by").get(
            pk=pk
        )
        return Response(
            {
                "task": TaskSerializer(task).data,
                "backlog_item": BacklogItemSerializer(item).data,
            },
            status=status.HTTP_201_CREATED,
        )
