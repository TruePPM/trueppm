"""DRF ViewSets for the projects app."""

from __future__ import annotations

import uuid
from typing import Any

from django.db import transaction
from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import filters, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsProjectMember,
    IsProjectMemberWrite,
    ProjectScopedViewSet,
)
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.projects.serializers import (
    CalendarSerializer,
    DependencySerializer,
    ProjectSerializer,
    TaskBulkSerializer,
    TaskReorderSerializer,
    TaskSerializer,
)


class CalendarViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Calendar]):
    """CRUD for project calendars.

    Calendars define working days, hours per day, and holiday exceptions.
    They can be shared across multiple projects and resources.

    Read access requires IsAuthenticated (any logged-in user can see calendars
    since they are referenced by projects the user may not yet belong to).
    Write operations require IsProjectAdmin on the owning project.
    """

    # Calendars are org-level objects referenced by projects; read is open to
    # any authenticated user, write is admin-only.
    permission_classes = [IsAuthenticated, IsProjectMember]
    queryset = Calendar.objects.prefetch_related("exceptions").order_by("name")
    serializer_class = CalendarSerializer
    search_fields = ["name"]
    ordering_fields = ["name"]

    def get_queryset(self) -> QuerySet[Calendar]:
        # Calendars are not project-scoped — they are shared org-level resources.
        # Return the full queryset for any authenticated user.
        return Calendar.objects.prefetch_related("exceptions").order_by("name")


class ProjectViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Project]):
    """CRUD for projects.

    Any authenticated user can create a project; on creation the creator is
    automatically assigned the Owner role via perform_create().
    """

    permission_classes = [IsAuthenticated, IsProjectMember]
    queryset = Project.objects.select_related("calendar").order_by("start_date", "name")
    serializer_class = ProjectSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name"]
    ordering_fields = ["start_date", "name"]

    def perform_create(self, serializer: BaseSerializer[Project]) -> None:
        """Create the project and auto-assign the creator as Owner.

        The Owner membership is created in the same request so the creator can
        immediately perform admin operations without a second round-trip.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = serializer.save()
        ProjectMembership.objects.create(
            project=project,
            user=self.request.user,  # type: ignore[misc]
            role=Role.OWNER,
        )
        project_id = str(project.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_created", {"id": project_id})
        )

    def perform_update(self, serializer: BaseSerializer[Project]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
        )

    def perform_destroy(self, instance: Project) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_deleted", {"id": project_id})
        )


class TaskViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Task]):
    """CRUD for tasks within a project.

    CPM output fields (early_start, early_finish, late_start, late_finish,
    total_float, free_float, is_critical) are read-only and populated by
    the auto-scheduling Celery task.
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]
    serializer_class = TaskSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name"]
    ordering_fields = ["wbs_path", "name", "early_start"]
    queryset = Task.objects.select_related("project").filter(is_deleted=False)

    def get_queryset(self) -> QuerySet[Task]:
        qs = super().get_queryset()
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        is_critical = self.request.query_params.get("is_critical")
        if is_critical is not None:
            qs = qs.filter(is_critical=is_critical.lower() in ("true", "1"))
        return qs

    def perform_create(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_created", {"id": task_id})
        )

    def perform_update(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
        )

    def perform_destroy(self, instance: Task) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_deleted", {"id": task_id})
        )


class DependencyViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Dependency]):
    """CRUD for task dependencies."""

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]
    serializer_class = DependencySerializer
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["dep_type"]
    queryset = Dependency.objects.select_related("predecessor", "successor").filter(
        is_deleted=False
    )

    def get_queryset(self) -> QuerySet[Dependency]:
        qs = super().get_queryset()
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(predecessor__project_id=project_id)
        dep_type = self.request.query_params.get("dep_type")
        if dep_type:
            qs = qs.filter(dep_type=dep_type)
        return qs

    def perform_create(self, serializer: BaseSerializer[Dependency]) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_created", {"id": dep_id})
        )

    def perform_update(self, serializer: BaseSerializer[Dependency]) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_updated", {"id": dep_id})
        )

    def perform_destroy(self, instance: Dependency) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_deleted", {"id": dep_id})
        )


# ---------------------------------------------------------------------------
# Reorder and Bulk views
# ---------------------------------------------------------------------------


def _build_wbs_path(parent_path: str, position: int) -> str:
    """Compute a sibling's ltree path given its parent and 1-based position.

    Examples:
        _build_wbs_path("", 1)       → "1"
        _build_wbs_path("1.2", 3)    → "1.2.3"
    """
    label = str(position)
    return f"{parent_path}.{label}" if parent_path else label


class TaskReorderView(APIView):
    """Reorder sibling tasks within a WBS level.

    POST /api/v1/projects/{pk}/tasks/reorder/

    Body:
        {
            "parent_path": "1.2",          # empty string for root level
            "ordered_ids": ["<uuid>", ...]  # all live siblings in desired order
        }

    The server recomputes wbs_path for every sibling (e.g. "1.2.1", "1.2.2",
    ...) and saves them atomically.  All supplied IDs must be live, non-deleted
    tasks belonging to this project under the given parent — otherwise 400.

    Returns:
        200 { "updated": [{ "id": "<uuid>", "wbs_path": "1.2.1" }, ...] }
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]

    def post(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        serializer = TaskReorderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        parent_path: str = serializer.validated_data["parent_path"]
        ordered_ids: list[uuid.UUID] = serializer.validated_data["ordered_ids"]

        # Fetch live siblings for this parent, locked for update.
        siblings_qs = Task.objects.select_for_update().filter(
            project_id=pk, is_deleted=False
        )
        if parent_path:
            # Exact siblings: their path is "{parent_path}.{single_label}",
            # i.e. the path starts with the parent prefix and adds exactly one
            # label segment.  We filter by prefix match then exclude deeper paths.
            siblings_qs = siblings_qs.filter(
                wbs_path__startswith=f"{parent_path}."
            ).exclude(
                # Exclude tasks deeper than one level below parent_path.
                # A descendant at depth+2 would have at least two dots after
                # the parent prefix — filter those out.
                wbs_path__regex=rf"^{parent_path}\.\d+\."
            )
        else:
            # Root-level siblings have no dot in their path.
            siblings_qs = siblings_qs.filter(wbs_path__regex=r"^\d+$")

        siblings_by_id = {t.pk: t for t in siblings_qs}

        # Validate: every supplied ID must be a live sibling.
        supplied_ids = {uid: True for uid in ordered_ids}
        unknown = [str(uid) for uid in ordered_ids if uid not in siblings_by_id]
        if unknown:
            return Response(
                {"ordered_ids": [f"Unknown or invalid task IDs: {', '.join(unknown)}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate: the supplied list must be complete (no missing siblings).
        missing = [str(pk_) for pk_ in siblings_by_id if pk_ not in supplied_ids]
        if missing:
            return Response(
                {"ordered_ids": [f"Missing siblings from ordered_ids: {', '.join(missing)}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        updated: list[dict[str, Any]] = []

        with transaction.atomic():
            for position, task_id in enumerate(ordered_ids, start=1):
                task = siblings_by_id[task_id]
                new_path = _build_wbs_path(parent_path, position)
                if task.wbs_path != new_path:
                    task.wbs_path = new_path
                    task.save(update_fields=["wbs_path"])
                updated.append({"id": str(task_id), "wbs_path": new_path})

            project_id = str(project.pk)
            transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_reordered", {})
            )

        return Response({"updated": updated}, status=status.HTTP_200_OK)


class TaskBulkView(APIView):
    """Atomically create, update, and delete tasks in a single request.

    POST /api/v1/projects/{pk}/tasks/bulk/

    Body:
        {
            "operations": [
                { "op": "create", "data": { "name": "Sprint 1", "duration": 5, ... } },
                { "op": "update", "id": "<uuid>", "data": { "percent_complete": 0.5 } },
                { "op": "delete", "id": "<uuid>" }
            ]
        }

    All operations execute inside a single transaction.atomic() block.
    The scheduling engine is triggered once after commit regardless of how
    many tasks were mutated.

    Returns:
        200 {
            "created": [{ "id": "<uuid>", ...task fields... }, ...],
            "updated": [{ "id": "<uuid>", ...task fields... }, ...],
            "deleted": ["<uuid>", ...]
        }
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]

    def post(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        serializer = TaskBulkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        operations: list[dict[str, Any]] = serializer.validated_data["operations"]

        # Collect update/delete IDs up front so we can lock the rows in one
        # select_for_update() call — avoids repeated individual lookups.
        mutated_ids = [
            op["id"] for op in operations if op["op"] in ("update", "delete")
        ]
        locked_tasks: dict[uuid.UUID, Task] = {}
        if mutated_ids:
            qs = Task.objects.select_for_update().filter(
                pk__in=mutated_ids, project_id=pk, is_deleted=False
            )
            locked_tasks = {t.pk: t for t in qs}

            # Validate all referenced tasks exist and belong to this project.
            missing = [str(uid) for uid in mutated_ids if uid not in locked_tasks]
            if missing:
                return Response(
                    {"operations": [f"Task(s) not found in project: {', '.join(missing)}"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        result: dict[str, Any] = {"created": [], "updated": [], "deleted": []}

        with transaction.atomic():
            for op in operations:
                op_type: str = op["op"]
                data: dict[str, Any] = op.get("data", {})

                if op_type == "create":
                    task_serializer = TaskSerializer(
                        data={**data, "project": str(project.pk)}
                    )
                    task_serializer.is_valid(raise_exception=True)
                    task = task_serializer.save()
                    result["created"].append(TaskSerializer(task).data)

                elif op_type == "update":
                    task = locked_tasks[op["id"]]
                    task_serializer = TaskSerializer(task, data=data, partial=True)
                    task_serializer.is_valid(raise_exception=True)
                    task = task_serializer.save()
                    result["updated"].append(TaskSerializer(task).data)

                elif op_type == "delete":
                    task = locked_tasks[op["id"]]
                    task.soft_delete()
                    result["deleted"].append(str(op["id"]))

            project_id = str(project.pk)
            transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_bulk_mutated", {})
            )

        return Response(result, status=status.HTTP_200_OK)
