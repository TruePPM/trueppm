"""Views for the scheduling app."""

from __future__ import annotations

from datetime import date as _date
from datetime import timedelta

from celery import current_app
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import IsProjectMember, IsProjectScheduler
from trueppm_api.apps.projects.models import Dependency, EstimateStatus, EstimationMode, Project
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

    # Defer until any outer transaction commits so the ScheduleRequest row is
    # never visible to the drain before its parent write lands.
    project_id = str(project.pk)
    transaction.on_commit(lambda: enqueue_recalculate(project_id))
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
    raw_n = request.data.get("n_simulations", cap or 1_000)
    try:
        n_simulations: int = int(raw_n)
    except (TypeError, ValueError):
        return Response(
            {"detail": "n_simulations must be an integer."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if n_simulations < 1:
        return Response(
            {"detail": "n_simulations must be a positive integer."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    cal = project.calendar
    sched_calendar = SchedCalendar(
        working_days=cal.working_days if cal else 31,
        hours_per_day=cal.hours_per_day if cal else 8.0,
        timezone=cal.timezone if cal else "UTC",
    )

    db_tasks = list(project.tasks.filter(is_deleted=False))

    # Gate: in suggest_approve mode, pending estimates are excluded from MC.
    # The scheduler's all-or-none rule means passing None for any field is
    # sufficient — the engine falls back to deterministic duration automatically.
    _suggest_approve = project.estimation_mode == EstimationMode.SUGGEST_APPROVE

    def _pert_field(value: int | None, task_estimate_status: str | None) -> timedelta | None:
        if value is None:
            return None
        if _suggest_approve and task_estimate_status != EstimateStatus.ACCEPTED:
            return None
        return timedelta(days=value)

    sched_tasks = [
        SchedTask(
            id=str(t.id),
            name=t.name,
            duration=timedelta(days=t.duration),
            percent_complete=t.percent_complete,
            optimistic_duration=_pert_field(t.optimistic_duration, t.estimate_status),
            most_likely_duration=_pert_field(t.most_likely_duration, t.estimate_status),
            pessimistic_duration=_pert_field(t.pessimistic_duration, t.estimate_status),
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

    dist = mc_result.distribution
    if dist:
        min_ord = dist[0].toordinal()
        max_ord = dist[-1].toordinal()
        span = max(max_ord - min_ord, 1)
        n_buckets = min(30, len(dist))
        bucket_size = span / n_buckets
        bucket_counts: dict[int, int] = {}
        for d in dist:
            idx = min(int((d.toordinal() - min_ord) / bucket_size), n_buckets - 1)
            bucket_counts[idx] = bucket_counts.get(idx, 0) + 1
        histogram: list[dict[str, object]] = [
            {
                "date": _date.fromordinal(min_ord + int((i + 0.5) * bucket_size)).isoformat(),
                "count": bucket_counts.get(i, 0),
            }
            for i in range(n_buckets)
        ]
    else:
        histogram = []

    result_dict = {**mc_result.to_dict(), "histogram_buckets": histogram}
    cache.set(f"mc_latest:{pk}", result_dict, timeout=86400)
    return Response(result_dict)


class MonteCarloLatestView(APIView):
    """Return the cached result of the most recent MC simulation for this project.

    Returns 200 with the full result dict if a cached result exists, or 404 if
    no simulation has been run since the 24-hour cache TTL last expired.

    Permission: Member (any role ≥ Viewer).
    """

    permission_classes = [IsAuthenticated, IsProjectMember]

    def get(self, request: Request, pk: str) -> Response:
        """Return the latest cached Monte Carlo result for the project."""
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        cached = cache.get(f"mc_latest:{pk}")
        if cached is None:
            return Response(
                {"detail": "No simulation result available."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(cached)


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
