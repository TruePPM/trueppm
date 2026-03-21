"""DRF ViewSets for the projects app."""

from __future__ import annotations

from rest_framework import filters, viewsets
from rest_framework.permissions import IsAuthenticated

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectScheduler,
    ProjectScopedViewSet,
)
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.projects.serializers import (
    CalendarSerializer,
    DependencySerializer,
    ProjectSerializer,
    TaskSerializer,
)


class CalendarViewSet(ProjectScopedViewSet, viewsets.ModelViewSet):
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

    def get_queryset(self) -> object:  # type: ignore[override]
        # Calendars are not project-scoped — they are shared org-level resources.
        # Return the full queryset for any authenticated user.
        return Calendar.objects.prefetch_related("exceptions").order_by("name")


class ProjectViewSet(ProjectScopedViewSet, viewsets.ModelViewSet):
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

    def perform_create(self, serializer: object) -> None:  # type: ignore[override]
        """Create the project and auto-assign the creator as Owner.

        The Owner membership is created in the same request so the creator can
        immediately perform admin operations without a second round-trip.
        """
        project = serializer.save()  # type: ignore[union-attr]
        ProjectMembership.objects.create(
            project=project,
            user=self.request.user,
            role=Role.OWNER,
        )


class TaskViewSet(ProjectScopedViewSet, viewsets.ModelViewSet):
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
    queryset = Task.objects.select_related("project")

    def get_queryset(self) -> object:  # type: ignore[override]
        qs = super().get_queryset()  # type: ignore[misc]
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)  # type: ignore[union-attr]
        is_critical = self.request.query_params.get("is_critical")
        if is_critical is not None:
            qs = qs.filter(is_critical=is_critical.lower() in ("true", "1"))  # type: ignore[union-attr]
        return qs

    def perform_create(self, serializer: object) -> None:  # type: ignore[override]
        instance = serializer.save()  # type: ignore[union-attr]
        project_id = str(instance.project_id)
        from django.db import transaction

        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))

    def perform_update(self, serializer: object) -> None:  # type: ignore[override]
        instance = serializer.save()  # type: ignore[union-attr]
        project_id = str(instance.project_id)
        from django.db import transaction

        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))

    def perform_destroy(self, instance: object) -> None:  # type: ignore[override]
        project_id = str(instance.project_id)  # type: ignore[union-attr]
        instance.delete()  # type: ignore[union-attr]
        from django.db import transaction

        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))


class DependencyViewSet(ProjectScopedViewSet, viewsets.ModelViewSet):
    """CRUD for task dependencies."""

    permission_classes = [IsAuthenticated, IsProjectMemberWrite]
    serializer_class = DependencySerializer
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["dep_type"]
    queryset = Dependency.objects.select_related("predecessor", "successor")

    def get_queryset(self) -> object:  # type: ignore[override]
        qs = super().get_queryset()  # type: ignore[misc]
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(predecessor__project_id=project_id)  # type: ignore[union-attr]
        dep_type = self.request.query_params.get("dep_type")
        if dep_type:
            qs = qs.filter(dep_type=dep_type)  # type: ignore[union-attr]
        return qs

    def perform_create(self, serializer: object) -> None:  # type: ignore[override]
        instance = serializer.save()  # type: ignore[union-attr]
        project_id = str(instance.predecessor.project_id)
        from django.db import transaction

        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))

    def perform_update(self, serializer: object) -> None:  # type: ignore[override]
        instance = serializer.save()  # type: ignore[union-attr]
        project_id = str(instance.predecessor.project_id)
        from django.db import transaction

        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))

    def perform_destroy(self, instance: object) -> None:  # type: ignore[override]
        project_id = str(instance.predecessor.project_id)  # type: ignore[union-attr]
        instance.delete()  # type: ignore[union-attr]
        from django.db import transaction

        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        transaction.on_commit(lambda: recalculate_schedule.delay(project_id))
