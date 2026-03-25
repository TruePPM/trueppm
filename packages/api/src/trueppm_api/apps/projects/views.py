"""DRF ViewSets for the projects app."""

from __future__ import annotations

import datetime
import uuid
from typing import Any

from django.db import transaction
from django.db.models import Count, OuterRef, QuerySet, Subquery
from django.shortcuts import get_object_or_404
from rest_framework import filters, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectMemberWriteOrOwn,
    IsProjectOwner,
    IsProjectScheduler,
    ProjectScopedViewSet,
)
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Dependency,
    Project,
    Task,
)
from trueppm_api.apps.projects.serializers import (
    BaselineDetailSerializer,
    BaselineSerializer,
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

    Permission matrix (issue #11):
      list/retrieve/create/update — any member (IsProjectMember)
      destroy                     — Project Admin (Owner) only (IsProjectOwner)
    """

    permission_classes = [IsAuthenticated, IsProjectMember]

    def get_permissions(self) -> list[BasePermission]:
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectOwner()]
        if self.action == "utilization":
            return [IsAuthenticated(), IsProjectScheduler()]
        return [IsAuthenticated(), IsProjectMember()]

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

    @action(detail=True, methods=["get"], url_path="utilization")
    def utilization(self, request: Request, pk: str | None = None) -> Response:
        """Per-resource daily utilization for a project.

        Returns a sparse map of resource → working day → {hours, task_ids}.
        Requires Resource Manager role (SCHEDULER ≥ 2).

        Query parameters:
          start (YYYY-MM-DD) — window start, inclusive; defaults to earliest
                               early_start across all project tasks.
          end   (YYYY-MM-DD) — window end, inclusive; defaults to latest
                               early_finish across all project tasks.

        Returns 409 when no CPM dates exist on any task (scheduler not run yet).
        """
        from trueppm_api.apps.projects.utilization import compute_utilization

        project = self.get_object()  # handles 404 + object-level permission check

        # Resolve window bounds
        start_str = request.query_params.get("start")
        end_str = request.query_params.get("end")

        def _parse_date(s: str, param: str) -> datetime.date:
            try:
                return datetime.date.fromisoformat(s)
            except ValueError:
                raise ValueError(f"'{param}' must be a valid ISO 8601 date (YYYY-MM-DD).") from None

        try:
            if start_str:
                window_start = _parse_date(start_str, "start")
            else:
                first = (
                    project.tasks.filter(is_deleted=False, early_start__isnull=False)
                    .order_by("early_start")
                    .values_list("early_start", flat=True)
                    .first()
                )
                if first is None:
                    return Response(
                        {"detail": "Schedule has not been computed. Run the scheduler first."},
                        status=status.HTTP_409_CONFLICT,
                    )
                window_start = first

            if end_str:
                window_end = _parse_date(end_str, "end")
            else:
                last = (
                    project.tasks.filter(is_deleted=False, early_finish__isnull=False)
                    .order_by("-early_finish")
                    .values_list("early_finish", flat=True)
                    .first()
                )
                window_end = last if last is not None else window_start

        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        if window_start > window_end:
            return Response(
                {"detail": "'start' must not be after 'end'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = compute_utilization(project, window_start, window_end)
        return Response(result)


class TaskViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Task]):
    """CRUD for tasks within a project.

    CPM output fields (early_start, early_finish, late_start, late_finish,
    total_float, free_float, is_critical) are read-only and populated by
    the auto-scheduling Celery task.

    Permission matrix (issue #11):
      list/retrieve    — any member (IsProjectMember)
      create           — Team Member+ (IsProjectMemberWrite)
      update/destroy   — Project Manager+ or assignee (IsProjectMemberWriteOrOwn)
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("update", "partial_update", "destroy"):
            return [IsAuthenticated(), IsProjectMemberWriteOrOwn()]
        if self.action == "create":
            return [IsAuthenticated(), IsProjectMemberWrite()]
        return [IsAuthenticated(), IsProjectMember()]

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

        # Baseline overlay: annotate each task with baseline_start / baseline_finish.
        # Resolution order:
        #   1. ?baseline=<id> explicit override
        #   2. the project's active baseline (is_active=True)
        #   3. no annotation (both fields are null in the response)
        resolved_baseline_id: str | None = self.request.query_params.get("baseline")
        if resolved_baseline_id is None and project_id:
            active = (
                Baseline.objects.filter(project_id=project_id, is_active=True, is_deleted=False)
                .values_list("id", flat=True)
                .first()
            )
            if active is not None:
                resolved_baseline_id = str(active)

        if resolved_baseline_id is not None:
            start_sub = BaselineTask.objects.filter(
                baseline_id=resolved_baseline_id,
                task_id=OuterRef("id"),
            ).values("start")[:1]
            finish_sub = BaselineTask.objects.filter(
                baseline_id=resolved_baseline_id,
                task_id=OuterRef("id"),
            ).values("finish")[:1]
            qs = qs.annotate(
                baseline_start=Subquery(start_sub),
                baseline_finish=Subquery(finish_sub),
            )

        return qs

    def perform_create(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # H1 fix: DRF does not call has_object_permission on create actions,
        # so we must enforce project membership explicitly before saving.
        project = serializer.validated_data.get("project")
        if project is not None:
            self.check_object_permissions(self.request, project)

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


class BaselineViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Baseline]):
    """CRUD for schedule baselines within a project.

    A baseline is a frozen snapshot of all task dates at a point in time,
    used for plan-vs-actual tracking via ghost bars on the Gantt.

    Permission matrix:
      list / retrieve — any project member (Viewer+)
      create          — Project Manager+ (IsProjectAdmin, role ≥ 3)
      destroy         — Project Owner only (IsProjectOwner, role = 4)
    """

    queryset = Baseline.objects.filter(is_deleted=False)
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["created_at", "name"]

    def get_serializer_class(self) -> type:
        if self.action == "retrieve":
            return BaselineDetailSerializer
        return BaselineSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectOwner()]
        return [IsAuthenticated(), IsProjectAdmin()]

    def get_queryset(self) -> QuerySet[Baseline]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        return qs.annotate(task_count=Count("tasks"))  # type: ignore[no-any-return]

    def perform_create(self, serializer: BaseSerializer[Baseline]) -> None:
        """Snapshot all live task dates atomically and broadcast baseline_created."""
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)

        # Auto-name: "Baseline N" where N = existing count + 1
        name = serializer.validated_data.get("name") or ""
        if not name:
            existing_count = Baseline.objects.filter(
                project_id=project_pk, is_deleted=False
            ).count()
            name = f"Baseline {existing_count + 1}"

        # Enforce unique name per project
        if Baseline.objects.filter(project_id=project_pk, name=name, is_deleted=False).exists():
            raise serializers.ValidationError(
                {"name": f"A baseline named '{name}' already exists for this project."}
            )

        live_tasks = list(
            Task.objects.filter(project_id=project_pk, is_deleted=False).values(
                "id", "name", "early_start", "early_finish", "duration"
            )
        )
        has_cpm_dates = bool(live_tasks) and all(t["early_start"] is not None for t in live_tasks)

        with transaction.atomic():
            baseline = serializer.save(
                project=project,
                created_by=self.request.user,
                name=name,
                has_cpm_dates=has_cpm_dates,
            )
            BaselineTask.objects.bulk_create(
                [
                    BaselineTask(
                        baseline=baseline,
                        task_id=t["id"],
                        task_name=t["name"],
                        start=t["early_start"],
                        finish=t["early_finish"],
                        duration=t["duration"],
                    )
                    for t in live_tasks
                ]
            )
            baseline_id = str(baseline.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    str(project_pk), "baseline_created", {"id": baseline_id}
                )
            )

    def perform_destroy(self, instance: Baseline) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        baseline_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "baseline_deleted", {"id": baseline_id})
        )


class BaselineActivateView(APIView):
    """Activate a specific baseline, deactivating all others for the project.

    POST /api/v1/projects/{project_pk}/baselines/{baseline_pk}/activate/

    Requires Project Manager+ (IsProjectAdmin, role ≥ 3).
    Returns 200 with the updated baseline object.
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin]

    def post(self, request: Request, project_pk: str, baseline_pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        baseline = get_object_or_404(
            Baseline, pk=baseline_pk, project_id=project_pk, is_deleted=False
        )

        with transaction.atomic():
            Baseline.objects.filter(project_id=project_pk, is_active=True).update(is_active=False)
            Baseline.objects.filter(pk=baseline_pk).update(is_active=True)
            baseline.refresh_from_db()

            baseline_id = str(baseline.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_pk, "baseline_activated", {"id": baseline_id})
            )

        serializer = BaselineSerializer(baseline)
        return Response(serializer.data, status=status.HTTP_200_OK)


class DependencyViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Dependency]):
    """CRUD for task dependencies.

    Dependency creation/modification affects CPM scheduling; Resource Manager+
    (IsProjectScheduler) is required for write operations (issue #11 role matrix).
    """

    permission_classes = [IsAuthenticated, IsProjectScheduler]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember()]
        return [IsAuthenticated(), IsProjectScheduler()]

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

        # H1 fix: DRF does not call has_object_permission on create actions,
        # so we must verify the predecessor task belongs to a project the caller
        # is a member of (Resource Manager+) before saving.
        predecessor = serializer.validated_data.get("predecessor")
        if predecessor is not None:
            self.check_object_permissions(self.request, predecessor)

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
        siblings_qs = Task.objects.select_for_update().filter(project_id=pk, is_deleted=False)
        if parent_path:
            # Exact siblings: their path is "{parent_path}.{single_label}",
            # i.e. the path starts with the parent prefix and adds exactly one
            # label segment.  We filter by prefix match then exclude deeper paths.
            siblings_qs = siblings_qs.filter(wbs_path__startswith=f"{parent_path}.").exclude(
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
            transaction.on_commit(lambda: broadcast_board_event(project_id, "tasks_reordered", {}))

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
        mutated_ids = [op["id"] for op in operations if op["op"] in ("update", "delete")]
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
                    task_serializer = TaskSerializer(data={**data, "project": str(project.pk)})
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
