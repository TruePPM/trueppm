"""DRF ViewSets for the projects app."""

from __future__ import annotations

import datetime
import logging
import uuid
from typing import Any, cast

from django.db import models as db_models
from django.db import transaction
from django.db.models import (
    BooleanField,
    Count,
    ExpressionWrapper,
    F,
    IntegerField,
    OuterRef,
    QuerySet,
    Subquery,
)
from django.db.models.expressions import RawSQL
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
    Risk,
    Task,
)
from trueppm_api.apps.projects.serializers import (
    BaselineDetailSerializer,
    BaselineSerializer,
    CalendarSerializer,
    DependencySerializer,
    ProjectSerializer,
    RiskSerializer,
    TaskBulkSerializer,
    TaskReorderSerializer,
    TaskSerializer,
)
from trueppm_api.apps.scheduling.services import enqueue_recalculate as _enqueue_recalculate

logger = logging.getLogger(__name__)


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
        payload = {"id": project_id, "name": project.name, "start_date": str(project.start_date)}
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "project.created", payload))

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
    ordering_fields = ["wbs_path", "name", "early_start", "status"]
    queryset = (
        Task.objects.select_related("project")
        .prefetch_related("assignments__resource")
        .filter(is_deleted=False)
    )

    def get_queryset(self) -> QuerySet[Task]:
        qs = super().get_queryset()
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        short_id = self.request.query_params.get("short_id")
        if short_id:
            qs = qs.filter(short_id=short_id.upper())
        is_critical = self.request.query_params.get("is_critical")
        if is_critical is not None:
            qs = qs.filter(is_critical=is_critical.lower() in ("true", "1"))
        status = self.request.query_params.get("status")
        if status:
            qs = qs.filter(status=status)

        # Date-range filter for calendar / resource views.
        # ?start__gte=YYYY-MM-DD  — tasks whose early_finish >= this date (still active)
        # ?finish__lte=YYYY-MM-DD — tasks whose early_start <= this date (already started)
        # Combined, they return tasks that overlap [start__gte, finish__lte].
        start_gte = self.request.query_params.get("start__gte")
        if start_gte:
            qs = qs.filter(early_finish__gte=start_gte)
        finish_lte = self.request.query_params.get("finish__lte")
        if finish_lte:
            qs = qs.filter(early_start__lte=finish_lte)

        # Summary task annotations: is_summary = has at least one direct child,
        # parent_id = the task whose wbs_path is this task's parent path.
        # Uses ltree operators via RawSQL for PostgreSQL-native performance.
        qs = qs.annotate(
            is_summary=RawSQL(
                "EXISTS("
                "  SELECT 1 FROM projects_task c"
                "  WHERE c.project_id = projects_task.project_id"
                "    AND c.is_deleted = false"
                "    AND c.id != projects_task.id"
                "    AND c.wbs_path IS NOT NULL"
                "    AND projects_task.wbs_path IS NOT NULL"
                "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery"
                ")",
                [],
                output_field=BooleanField(),
            ),
            parent_id=RawSQL(
                "("
                "  SELECT p.id FROM projects_task p"
                "  WHERE p.project_id = projects_task.project_id"
                "    AND p.is_deleted = false"
                "    AND projects_task.wbs_path IS NOT NULL"
                "    AND nlevel(projects_task.wbs_path) > 1"
                "    AND p.wbs_path = subpath("
                "        projects_task.wbs_path, 0,"
                "        nlevel(projects_task.wbs_path) - 1"
                "    )"
                "  LIMIT 1"
                ")",
                [],
                output_field=db_models.UUIDField(),
            ),
        )

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

        return cast("QuerySet[Task]", qs)

    def perform_create(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # H1 fix: DRF does not call has_object_permission on create actions,
        # so we must enforce project membership explicitly before saving.
        project = serializer.validated_data.get("project")
        if project is not None:
            self.check_object_permissions(self.request, project)

        instance = serializer.save()
        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_created", {"id": task_id})
        )
        payload = _task_webhook_payload(instance)
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "task.created", payload))

    def perform_update(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
        )
        payload = _task_webhook_payload(instance)
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "task.updated", payload))

    def perform_destroy(self, instance: Task) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_deleted", {"id": task_id})
        )
        transaction.on_commit(
            lambda: _dispatch_webhooks(
                project_id, "task.deleted", {"id": task_id, "project": project_id}
            )
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
                "id",
                "name",
                "early_start",
                "early_finish",
                "duration",
                "actual_start",
                "actual_finish",
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
                        actual_start=t["actual_start"],
                        actual_finish=t["actual_finish"],
                    )
                    for t in live_tasks
                ]
            )
            # Annotate task_count on the instance so the create response includes it
            # (get_queryset annotates for list/retrieve, but perform_create returns the
            # unsaved instance which lacks the annotation).
            baseline.task_count = len(live_tasks)  # type: ignore[attr-defined]
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
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_created", {"id": dep_id})
        )
        dep_payload = {
            "id": dep_id,
            "predecessor": str(instance.predecessor_id),
            "successor": str(instance.successor_id),
            "dep_type": instance.dep_type,
            "lag": instance.lag,
        }
        transaction.on_commit(
            lambda: _dispatch_webhooks(project_id, "dependency.created", dep_payload)
        )

    def perform_update(self, serializer: BaseSerializer[Dependency]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_updated", {"id": dep_id})
        )

    def perform_destroy(self, instance: Dependency) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_deleted", {"id": dep_id})
        )
        transaction.on_commit(
            lambda: _dispatch_webhooks(project_id, "dependency.deleted", {"id": dep_id})
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
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(lambda: broadcast_board_event(project_id, "tasks_reordered", {}))

        return Response({"updated": updated}, status=status.HTTP_200_OK)


def _get_parent_path(wbs_path: str) -> str:
    """Return the parent's wbs_path by stripping the last label, or '' for root."""
    parts = wbs_path.split(".")
    return ".".join(parts[:-1]) if len(parts) > 1 else ""


def _get_siblings(project_id: str, parent_path: str, *, lock: bool = False) -> list[Task]:
    """Fetch live tasks at the given parent level, ordered by wbs_path."""
    qs = Task.objects.filter(project_id=project_id, is_deleted=False)
    if lock:
        qs = qs.select_for_update()
    if parent_path:
        qs = qs.filter(wbs_path__startswith=f"{parent_path}.").exclude(
            wbs_path__regex=rf"^{parent_path}\.\d+\."
        )
    else:
        qs = qs.filter(wbs_path__regex=r"^\d+$")
    return list(qs.order_by("wbs_path"))


def _get_descendants(project_id: str, wbs_path: str, *, lock: bool = False) -> list[Task]:
    """Fetch all live descendants of a task (not including the task itself)."""
    qs = Task.objects.filter(
        project_id=project_id,
        is_deleted=False,
        wbs_path__startswith=f"{wbs_path}.",
    )
    if lock:
        qs = qs.select_for_update()
    return list(qs.order_by("wbs_path"))


def _renumber_siblings(siblings: list[Task], parent_path: str) -> list[dict[str, Any]]:
    """Assign sequential wbs_path to siblings and save changed ones.

    Returns list of {"id": ..., "wbs_path": ...} for all siblings.
    """
    updated: list[dict[str, Any]] = []
    for position, task in enumerate(siblings, start=1):
        new_path = _build_wbs_path(parent_path, position)
        if task.wbs_path != new_path:
            task.wbs_path = new_path
            task.save(update_fields=["wbs_path"])
        updated.append({"id": str(task.pk), "wbs_path": new_path})
    return updated


def _rewrite_descendants(
    descendants: list[Task], old_prefix: str, new_prefix: str
) -> list[dict[str, Any]]:
    """Update wbs_path for all descendants when a parent's path changes."""
    updated: list[dict[str, Any]] = []
    for task in descendants:
        if task.wbs_path and task.wbs_path.startswith(old_prefix):
            new_path = new_prefix + task.wbs_path[len(old_prefix) :]
            if task.wbs_path != new_path:
                task.wbs_path = new_path
                task.save(update_fields=["wbs_path"])
            updated.append({"id": str(task.pk), "wbs_path": new_path})
    return updated


class TaskIndentView(APIView):
    """Indent a task — make it the last child of its previous sibling.

    POST /api/v1/projects/{pk}/tasks/{task_id}/indent/

    No request body.  The task moves under the immediately preceding sibling
    at the same WBS level.

    Returns:
        200 { "updated": [...], "warning": null | "has_assignments" }
        400 when the task is first at its level (no previous sibling).
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]

    def post(self, request: Request, pk: str, task_id: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
            if not task.wbs_path:
                return Response(
                    {"detail": "Task has no WBS path."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            parent_path = _get_parent_path(task.wbs_path)
            siblings = _get_siblings(str(project.pk), parent_path, lock=True)

            task_idx = next((i for i, s in enumerate(siblings) if s.pk == task.pk), None)
            if task_idx is None or task_idx == 0:
                return Response(
                    {"detail": "Cannot indent: task is first at its level."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            prev_sibling = siblings[task_idx - 1]
            descendants = _get_descendants(str(project.pk), task.wbs_path, lock=True)

            # Count existing children of previous sibling to determine insertion position.
            prev_children = _get_siblings(str(project.pk), prev_sibling.wbs_path, lock=True)
            new_position = len(prev_children) + 1
            old_path = task.wbs_path
            new_path = _build_wbs_path(prev_sibling.wbs_path, new_position)

            # Move the task under previous sibling.
            task.wbs_path = new_path
            task.save(update_fields=["wbs_path"])

            all_updated: list[dict[str, Any]] = [{"id": str(task.pk), "wbs_path": new_path}]
            all_updated.extend(_rewrite_descendants(descendants, old_path, new_path))

            # Renumber old siblings (remove the gap left by the moved task).
            remaining_siblings = [s for s in siblings if s.pk != task.pk]
            all_updated.extend(_renumber_siblings(remaining_siblings, parent_path))

            # Check if previous sibling just became a summary task with assignments.
            warning: str | None = None
            if not prev_children:
                from trueppm_api.apps.resources.models import TaskResource

                if TaskResource.objects.filter(task=prev_sibling).exists():
                    warning = "has_assignments"

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

        return Response(
            {"updated": all_updated, "warning": warning},
            status=status.HTTP_200_OK,
        )


class TaskOutdentView(APIView):
    """Outdent a task — promote to parent's level (MS Project convention).

    POST /api/v1/projects/{pk}/tasks/{task_id}/outdent/

    No request body.  Following siblings at the old level become children
    of the outdented task (MS Project convention).

    Returns:
        200 { "updated": [...], "warning": null | "has_assignments" }
        400 when the task is at root level.
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]

    def post(self, request: Request, pk: str, task_id: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
            if not task.wbs_path:
                return Response(
                    {"detail": "Task has no WBS path."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            parent_path = _get_parent_path(task.wbs_path)
            if not parent_path:
                return Response(
                    {"detail": "Cannot outdent: task is at root level."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            grandparent_path = _get_parent_path(parent_path)

            # Current siblings and task position.
            old_siblings = _get_siblings(str(project.pk), parent_path, lock=True)
            task_idx = next((i for i, s in enumerate(old_siblings) if s.pk == task.pk), None)
            if task_idx is None:
                return Response(
                    {"detail": "Task not found among its siblings."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # MS Project convention: following siblings become children.
            following_siblings = old_siblings[task_idx + 1 :]
            remaining_old = old_siblings[:task_idx]

            # Task's existing descendants.
            task_descendants = _get_descendants(str(project.pk), task.wbs_path, lock=True)

            # Siblings at the new (grandparent) level — for insertion positioning.
            new_level_siblings = _get_siblings(str(project.pk), grandparent_path, lock=True)
            parent_idx = next(
                (i for i, s in enumerate(new_level_siblings) if s.wbs_path == parent_path),
                None,
            )
            if parent_idx is None:
                return Response(
                    {"detail": "Parent task not found."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            old_path = task.wbs_path

            # Count existing children of the task.
            existing_children = _get_siblings(str(project.pk), task.wbs_path, lock=True)
            next_child_pos = len(existing_children) + 1

            all_updated: list[dict[str, Any]] = []

            # Step 1: Compute the task's new path at the grandparent level.
            # It goes immediately after its old parent.
            new_task_path = _build_wbs_path(grandparent_path, parent_idx + 2)

            # Step 2: Move the task itself.
            task.wbs_path = new_task_path
            task.save(update_fields=["wbs_path"])
            all_updated.append({"id": str(task.pk), "wbs_path": new_task_path})

            # Rewrite the task's original descendants under the new path.
            all_updated.extend(_rewrite_descendants(task_descendants, old_path, new_task_path))

            # Step 3: Adopt following siblings as children of the outdented task.
            # Use new_task_path as parent so paths are immediately correct.
            for follower in following_siblings:
                follower_old_path = follower.wbs_path
                follower_new_path = _build_wbs_path(new_task_path, next_child_pos)
                follower_desc = _get_descendants(str(project.pk), follower_old_path, lock=True)

                follower.wbs_path = follower_new_path
                follower.save(update_fields=["wbs_path"])
                all_updated.append({"id": str(follower.pk), "wbs_path": follower_new_path})
                all_updated.extend(
                    _rewrite_descendants(follower_desc, follower_old_path, follower_new_path)
                )
                next_child_pos += 1

            # Step 3: Renumber remaining siblings at the old level.
            all_updated.extend(_renumber_siblings(remaining_old, parent_path))

            # Step 4: Renumber siblings at the new level (insert task after parent).
            refreshed_new_siblings = _get_siblings(str(project.pk), grandparent_path, lock=True)
            all_updated.extend(_renumber_siblings(refreshed_new_siblings, grandparent_path))

            # Assignment warning if the task gained children (adopted followers).
            warning: str | None = None
            if following_siblings and not existing_children:
                from trueppm_api.apps.resources.models import TaskResource

                if TaskResource.objects.filter(task=task).exists():
                    warning = "has_assignments"

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

        return Response(
            {"updated": all_updated, "warning": warning},
            status=status.HTTP_200_OK,
        )


class TaskReparentView(APIView):
    """Reparent a task — move it under an arbitrary summary (or to root).

    POST /api/v1/projects/{pk}/tasks/{task_id}/reparent/

    Body:
        { "new_parent_id": "<uuid>" | null }  (null = root level)

    Inserts the task as the last child of the target parent, rewrites
    descendants, renumbers old siblings, and triggers CPM recalc.
    Unlike indent/, the target is explicit rather than previous-sibling.

    Returns:
        200 { "updated": [...], "warning": null | "has_assignments" }
        400 on cycle (target is self or descendant) or missing WBS path.
        404 when new_parent_id does not exist in the project.
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]

    def post(self, request: Request, pk: str, task_id: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        new_parent_id = request.data.get("new_parent_id")

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
            if not task.wbs_path:
                return Response(
                    {"detail": "Task has no WBS path."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            old_path = task.wbs_path
            old_parent_path = _get_parent_path(old_path)

            if new_parent_id is None:
                new_parent: Task | None = None
                new_parent_path = ""
            else:
                if str(new_parent_id) == str(task.pk):
                    return Response(
                        {"detail": "Cannot reparent a task under itself."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                try:
                    new_parent = Task.objects.select_for_update().get(
                        pk=new_parent_id, project_id=pk, is_deleted=False
                    )
                except Task.DoesNotExist:
                    return Response(
                        {"detail": "New parent not found."},
                        status=status.HTTP_404_NOT_FOUND,
                    )
                if not new_parent.wbs_path:
                    return Response(
                        {"detail": "New parent has no WBS path."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # Cycle guard — new parent cannot be a descendant of the task.
                if new_parent.wbs_path.startswith(f"{old_path}."):
                    return Response(
                        {"detail": "Cannot reparent under own descendant."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                new_parent_path = new_parent.wbs_path

            # No-op when the task is already a child of the target parent.
            if old_parent_path == new_parent_path:
                return Response(
                    {"updated": [], "warning": None},
                    status=status.HTTP_200_OK,
                )

            descendants = _get_descendants(str(project.pk), old_path, lock=True)
            old_siblings = _get_siblings(str(project.pk), old_parent_path, lock=True)
            new_children = _get_siblings(str(project.pk), new_parent_path, lock=True)

            new_position = len(new_children) + 1
            new_path = _build_wbs_path(new_parent_path, new_position)

            task.wbs_path = new_path
            task.save(update_fields=["wbs_path"])

            all_updated: list[dict[str, Any]] = [{"id": str(task.pk), "wbs_path": new_path}]
            all_updated.extend(_rewrite_descendants(descendants, old_path, new_path))

            remaining_old = [s for s in old_siblings if s.pk != task.pk]
            all_updated.extend(_renumber_siblings(remaining_old, old_parent_path))

            # Warning: new parent just became a summary and has resource assignments.
            warning: str | None = None
            if new_parent is not None and not new_children:
                from trueppm_api.apps.resources.models import TaskResource

                if TaskResource.objects.filter(task=new_parent).exists():
                    warning = "has_assignments"

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

        return Response(
            {"updated": all_updated, "warning": warning},
            status=status.HTTP_200_OK,
        )


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
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_bulk_mutated", {})
            )

        return Response(result, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Risk register
# ---------------------------------------------------------------------------


class RiskViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Risk]):
    """CRUD for risks within a project.

    Permission matrix:
      list / retrieve         — Viewer+ (IsProjectMember)
      create / update         — Team Member+ (IsProjectMemberWrite)
      destroy                 — Project Owner only (IsProjectOwner)

    Severity (probability × impact) is annotated on the queryset so
    OrderingFilter can sort by it without a Python round-trip.
    """

    queryset = (
        Risk.objects.select_related("project", "owner", "created_by")
        .prefetch_related("tasks")
        .filter(is_deleted=False)
    )
    serializer_class = RiskSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["title", "description"]
    ordering_fields = ["severity", "probability", "impact", "status", "created_at"]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectOwner()]
        return [IsAuthenticated(), IsProjectMemberWrite()]

    def get_queryset(self) -> QuerySet[Risk]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        short_id = self.request.query_params.get("short_id")
        if short_id:
            qs = qs.filter(short_id=short_id.upper())
        status_filter = self.request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)
        # Annotate computed severity so OrderingFilter can sort without Python.
        return qs.annotate(  # type: ignore[no-any-return]
            severity=ExpressionWrapper(
                F("probability") * F("impact"),
                output_field=IntegerField(),
            )
        )

    def perform_create(self, serializer: BaseSerializer[Risk]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        # DRF does not call has_object_permission on create — check explicitly.
        self.check_object_permissions(self.request, project)

        instance = serializer.save(
            project=project,
            created_by=self.request.user,
        )
        risk_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(str(project_pk), "risk_created", {"id": risk_id})
        )

    def perform_update(self, serializer: BaseSerializer[Risk]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.project_id)
        risk_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "risk_updated", {"id": risk_id})
        )

    def perform_destroy(self, instance: Risk) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        risk_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "risk_deleted", {"id": risk_id})
        )


# ---------------------------------------------------------------------------
# Webhook dispatch helpers
# ---------------------------------------------------------------------------


def _dispatch_webhooks(project_id: str, event_type: str, payload: dict) -> None:  # type: ignore[type-arg]
    """Enqueue webhook deliveries for matching subscriptions."""
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    dispatch_webhooks(project_id, event_type, payload)


def _task_webhook_payload(task: Task) -> dict:  # type: ignore[type-arg]
    """Build a webhook payload dict for a task event."""
    return {
        "id": str(task.pk),
        "project": str(task.project_id),
        "name": task.name,
        "status": task.status,
        "duration": task.duration,
        "assignee": str(task.assignee_id) if task.assignee_id else None,
        "actual_start": str(task.actual_start) if task.actual_start else None,
        "actual_finish": str(task.actual_finish) if task.actual_finish else None,
    }
