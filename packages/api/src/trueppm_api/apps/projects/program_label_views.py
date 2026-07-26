"""Program-scoped cross-project label reads (ADR-0638, issue #2333).

    GET /api/v1/programs/<program_pk>/label-tasks/?label=<name>
    GET /api/v1/programs/<program_pk>/label-catalog/

Both are read-only. The program is a **path segment, never a query parameter**,
and that is the entire point of this module rather than a `?program=` filter on
``TaskViewSet``:

``ProjectScopedViewSet`` already narrows every queryset to the caller's project
memberships, so an unscoped ``?label=`` filter would be *safe* — it would leak
nothing. It would still be wrong. A user belonging to projects across five
programs would receive a **cross-program aggregation**, which is the
portfolio-shaped view that belongs to ``trueppm-enterprise``, shipped in the
community edition by accident. A query parameter can be omitted; a path segment
cannot, so nesting under the program makes the OSS boundary unforgeable rather
than conventional (ADR-0638 Decision 1).
"""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import mixins, serializers, viewsets
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsProgramMember
from trueppm_api.apps.projects.models import Label, Program, Project, Task
from trueppm_api.apps.projects.program_label_services import (
    program_label_catalog,
    tasks_by_label_name,
)


class LabelChipSerializer(serializers.ModelSerializer[Label]):
    """Just enough label to render a chip.

    Not ``LabelSerializer``: that one carries a ``task_count`` fed by an annotation
    on ``LabelViewSet.get_queryset``. Serialized from a bare prefetched instance it
    would fall back to its ``default=0`` and report "0 tasks" on a row that
    demonstrably has one — a wrong number is worse than an absent one.
    """

    class Meta:
        model = Label
        fields = ["id", "name", "color"]
        read_only_fields = fields


class TaskProjectRefSerializer(serializers.ModelSerializer[Project]):
    """The project a cross-project row belongs to.

    ``code`` is included alongside the name because it is what appears in a task's
    short reference, and it is how PMs actually disambiguate two similarly named
    projects at a glance.
    """

    class Meta:
        model = Project
        fields = ["id", "name", "code"]
        read_only_fields = fields


class ProgramLabelTaskSerializer(serializers.ModelSerializer[Task]):
    """A task row in the program label view.

    Deliberately narrower than ``TaskSerializer``: this is a findability list, not
    a task-editing surface, and a read-only cross-project view has no business
    shipping the full task payload (including its CPM outputs) for every row.
    """

    project = TaskProjectRefSerializer(read_only=True)
    labels = LabelChipSerializer(many=True, read_only=True)

    class Meta:
        model = Task
        fields = [
            "id",
            "short_id",
            "name",
            "wbs_path",
            "status",
            "percent_complete",
            "early_finish",
            "is_milestone",
            "project",
            "labels",
        ]
        read_only_fields = fields


def _readable_project_ids(request: Request, program: Program) -> tuple[list[Any], int]:
    """Project ids in ``program`` the caller may read, and how many were withheld.

    Program membership and project membership are different sets — a program member
    is not automatically a member of every project in it. ADR-0120 D5 settled the
    shape this reuses: program membership *admits* the caller to the program-level
    read, project membership governs what is *revealed*.

    The withheld count is returned so the response can say so. A list that silently
    omits projects is a wrong answer presented as a complete one.
    """
    from trueppm_api.apps.access.models import ProjectMembership

    user = request.user
    if not user.is_authenticated:
        # Unreachable behind IsAuthenticated; narrows AnonymousUser out for the
        # membership lookup, which types its `user` lookup as a concrete User.
        return [], 0

    all_ids = set(
        Project.objects.filter(program=program, is_deleted=False).values_list("id", flat=True)
    )
    readable = set(
        ProjectMembership.objects.filter(
            user=user, is_deleted=False, project_id__in=all_ids
        ).values_list("project_id", flat=True)
    )
    return list(readable), len(all_ids - readable)


class ProgramLabelTaskViewSet(mixins.ListModelMixin, viewsets.GenericViewSet[Task]):
    """Tasks across a program's projects carrying a given label name."""

    serializer_class = ProgramLabelTaskSerializer
    # No filter backends. The project settings enable `OrderingFilter` globally,
    # which would let `?ordering=-name` override the ordering this view depends
    # on — and that is not cosmetic. Two things break:
    #   * the UI groups rows by project and assumes they arrive grouped;
    #   * `name` is not unique, so ordering by it alone is not a total order, and
    #     a non-total order lets page boundaries skip or repeat rows.
    # The ordering is a correctness property here (ADR-0638 D5), so it is fixed.
    filter_backends: list[Any] = []

    def get_permissions(self) -> list[BasePermission]:
        # IsProgramMember enforces membership in has_permission when the URL
        # carries program_pk, so a non-member gets a 403 before the queryset runs
        # rather than an ambiguous empty 200.
        return [IsAuthenticated(), IsProgramMember()]

    def _program(self) -> Program:
        return get_object_or_404(
            Program.objects.filter(is_deleted=False), pk=self.kwargs["program_pk"]
        )

    def get_queryset(self) -> QuerySet[Task]:
        label = (self.request.query_params.get("label") or "").strip()
        if not label:
            # Fail closed. Ignoring an absent filter would turn this into an
            # unbounded dump of every task in the program — precisely the
            # unscoped read this endpoint's shape exists to prevent.
            raise serializers.ValidationError(
                {"label": "A label name is required, e.g. ?label=security-review."}
            )
        readable_ids, _ = _readable_project_ids(self.request, self._program())
        return tasks_by_label_name(project_ids=readable_ids, label_name=label)

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Standard paginated list, plus the partial-visibility disclosure."""
        _, withheld = _readable_project_ids(request, self._program())
        response = super().list(request, *args, **kwargs)
        if isinstance(response.data, dict):
            response.data["withheld_project_count"] = withheld
        return response


class ProgramLabelCatalogView(APIView):
    """Distinct label names across a program, with the number of projects using each.

    Backs the view's filter control. The count is of *projects*, not tasks — see
    ADR-0638 Decision 5 for why a task count is the wrong read to put behind a picker.
    """

    permission_classes = [IsAuthenticated, IsProgramMember]

    def get(self, request: Request, program_pk: str) -> Response:
        program = get_object_or_404(Program.objects.filter(is_deleted=False), pk=program_pk)
        readable_ids, withheld = _readable_project_ids(request, program)
        return Response(
            {
                "results": program_label_catalog(project_ids=readable_ids),
                "withheld_project_count": withheld,
            }
        )
