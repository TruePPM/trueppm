"""Views for the scheduling app."""

from __future__ import annotations

from datetime import timedelta

from celery import current_app
from django.conf import settings
from rest_framework import status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import IsProjectMember, IsProjectScheduler
from trueppm_api.apps.projects.models import Dependency, Project
from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus
from trueppm_api.apps.scheduling.serializers import FailedTaskSerializer
from trueppm_api.apps.scheduling.services import enqueue_recalculate


@api_view(["POST"])
@permission_classes([IsAuthenticated, IsProjectScheduler])
def trigger_schedule(request: Request, pk: str) -> Response:
    """Manually trigger a CPM recalculation for a project.

    Requires the requesting user to hold at least the Scheduler role on the
    project.  The request is written to the transactional outbox and dispatched
    immediately if the broker is available; otherwise the Beat drain task picks
    it up within 30 seconds.

    Returns 404 if the project does not exist.
    """
    try:
        project = Project.objects.get(pk=pk)
    except Project.DoesNotExist:
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

    # Permission check against the project object.
    if not IsProjectScheduler().has_object_permission(request, None, project):  # type: ignore[arg-type]
        return Response({"detail": "Permission denied."}, status=status.HTTP_403_FORBIDDEN)

    enqueue_recalculate(str(project.pk))
    return Response({"queued": True}, status=status.HTTP_202_ACCEPTED)


@api_view(["POST"])
@permission_classes([IsAuthenticated, IsProjectMember])
def run_monte_carlo(request: Request, pk: str) -> Response:
    """Run a Monte Carlo probabilistic schedule simulation synchronously.

    Monte Carlo is fast (< 100 ms vectorised) so this runs in the request/
    response cycle rather than via Celery. No state is written; results are
    returned directly.

    Request body (all optional):
        n_simulations (int): Number of simulation runs. Defaults to
            settings.MC_SIMULATION_CAP. Must not exceed the cap.

    Returns 200 on success, 402 if the OSS simulation cap is exceeded,
    404 if the project does not exist, 403 if the caller lacks read access.
    """
    from trueppm_scheduler.engine import CyclicDependencyError, SimulationCapExceeded, monte_carlo
    from trueppm_scheduler.models import Calendar as SchedCalendar
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject
    from trueppm_scheduler.models import Task as SchedTask

    try:
        project = (
            Project.objects.select_related("calendar")
            .prefetch_related("tasks")
            .get(pk=pk, is_deleted=False)
        )
    except Project.DoesNotExist:
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

    if not IsProjectMember().has_object_permission(request, None, project):  # type: ignore[arg-type]
        return Response({"detail": "Permission denied."}, status=status.HTTP_403_FORBIDDEN)

    cap: int | None = settings.MC_SIMULATION_CAP
    n_simulations: int = int(request.data.get("n_simulations", cap or 1_000))

    cal = project.calendar
    sched_calendar = SchedCalendar(
        working_days=cal.working_days if cal else 31,
        hours_per_day=cal.hours_per_day if cal else 8.0,
        timezone=cal.timezone if cal else "UTC",
    )

    db_tasks = list(project.tasks.filter(is_deleted=False))
    sched_tasks = [
        SchedTask(
            id=str(t.id),
            name=t.name,
            duration=timedelta(days=t.duration),
            percent_complete=t.percent_complete,
            optimistic_duration=timedelta(days=t.optimistic_duration)
            if t.optimistic_duration is not None
            else None,
            most_likely_duration=timedelta(days=t.most_likely_duration)
            if t.most_likely_duration is not None
            else None,
            pessimistic_duration=timedelta(days=t.pessimistic_duration)
            if t.pessimistic_duration is not None
            else None,
        )
        for t in db_tasks
    ]

    db_deps = list(
        Dependency.objects.filter(predecessor__project_id=pk).select_related(
            "predecessor", "successor"
        )
    )
    sched_deps = [
        SchedDependency(
            predecessor_id=str(d.predecessor_id),
            successor_id=str(d.successor_id),
            dep_type=DependencyType(d.dep_type),
            lag=timedelta(days=d.lag),
        )
        for d in db_deps
    ]

    sched_project = SchedProject(
        id=str(project.pk),
        name=project.name,
        start_date=project.start_date,
        tasks=sched_tasks,
        dependencies=sched_deps,
        calendar=sched_calendar,
    )

    try:
        mc_result = monte_carlo(
            sched_project,
            runs=n_simulations,
            max_runs=cap,
            max_tasks=settings.MC_TASK_CAP,
        )
    except SimulationCapExceeded as exc:
        return Response(
            {
                "error": "simulation_cap_exceeded",
                "tier": "team",
                "message": str(exc),
            },
            status=status.HTTP_402_PAYMENT_REQUIRED,
        )
    except (CyclicDependencyError, ValueError) as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    return Response(mc_result.to_dict())


class FailedTaskViewSet(ListModelMixin, RetrieveModelMixin, GenericViewSet):  # type: ignore[type-arg]
    """Admin endpoint for dead-lettered Celery tasks.

    List/detail: any authenticated user (operational visibility).
    Retry/dismiss: staff users only (admin action).
    """

    serializer_class = FailedTaskSerializer
    permission_classes = [IsAuthenticated]
    queryset = FailedTask.objects.all()

    @action(detail=True, methods=["post"], permission_classes=[IsAdminUser])
    def retry(self, request: Request, pk: str | None = None) -> Response:
        """Re-enqueue the original task with stored args/kwargs."""
        failed = self.get_object()
        if failed.status not in (FailedTaskStatus.DEAD, FailedTaskStatus.PENDING_RETRY):
            return Response(
                {"detail": f"Cannot retry a task with status '{failed.status}'."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        current_app.send_task(failed.task_name, args=failed.args, kwargs=failed.kwargs)
        failed.status = FailedTaskStatus.RETRIED
        failed.save(update_fields=["status", "last_failed_at"])
        return Response(FailedTaskSerializer(failed).data)

    @action(detail=True, methods=["post"], permission_classes=[IsAdminUser])
    def dismiss(self, request: Request, pk: str | None = None) -> Response:
        """Mark a dead-lettered task as dismissed (acknowledged, no retry)."""
        failed = self.get_object()
        failed.status = FailedTaskStatus.DISMISSED
        failed.save(update_fields=["status", "last_failed_at"])
        return Response(FailedTaskSerializer(failed).data)
