"""Views for the scheduling app."""

from __future__ import annotations

from datetime import date as _date
from datetime import timedelta

from celery import current_app
from django.conf import settings
from django.core.cache import cache
from django.db import models, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiExample,
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
)
from rest_framework import status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
    IsProjectScheduler,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    Dependency,
    EstimateStatus,
    EstimationMode,
    Project,
    Task,
)
from trueppm_api.apps.scheduling.models import (
    FailedTask,
    FailedTaskStatus,
    ScheduleRequestReason,
    VelocitySuggestion,
)
from trueppm_api.apps.scheduling.serializers import (
    FailedTaskSerializer,
    VelocitySuggestionSerializer,
)
from trueppm_api.apps.scheduling.services import enqueue_recalculate


@api_view(["POST"])
@permission_classes([IsAuthenticated, IsProjectScheduler, IsProjectNotArchived])
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
    transaction.on_commit(
        lambda: enqueue_recalculate(project_id, reason=ScheduleRequestReason.MANUAL)
    )
    return Response({"queued": True}, status=status.HTTP_202_ACCEPTED)


@extend_schema(
    request=OpenApiTypes.OBJECT,
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Monte Carlo simulation result. Includes the engine result fields "
                "(P50/P80/P95 finish dates, mean, std dev, etc.) plus "
                "histogram_buckets ([{date, count}]) and last_run_at (ISO 8601)."
            ),
        ),
        400: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Cyclic dependency, invalid input, or out-of-range project span.",
        ),
        402: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "OSS simulation cap exceeded (n_simulations above MC_SIMULATION_CAP "
                "or too many tasks)."
            ),
            examples=[
                OpenApiExample(
                    "simulation_cap_exceeded",
                    value={
                        "error": "simulation_cap_exceeded",
                        "tier": "team",
                        "message": "Simulation count exceeds the community-edition cap.",
                    },
                ),
            ],
        ),
        404: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Project does not exist.",
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated, IsProjectMember, IsProjectNotArchived])
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

    # Monte Carlo simulates committed delivery only — BACKLOG cards are not
    # part of the forecast. ADR-0057 / Task.committed.
    db_tasks = list(Task.committed.filter(project=project))

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
    except OverflowError:
        # Defense in depth: the engine's MAX_PROJECT_SPAN_DAYS guard makes this
        # unreachable for any realistic start date, but never let a date-range
        # overflow surface as a 500 (OverflowError is not a ValueError).
        return Response(
            {"detail": "Project schedule exceeds the representable date range."},
            status=status.HTTP_400_BAD_REQUEST,
        )

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

    # `last_run_at` lets the frontend surface a "Last run: 2h ago" freshness
    # signal and decide whether to nudge a rerun (#335). Captured at cache-write
    # time so it always tracks the most recent successful simulation, never the
    # cache read.
    result_dict = {
        **mc_result.to_dict(),
        "histogram_buckets": histogram,
        "last_run_at": timezone.now().isoformat(),
    }
    cache.set(f"mc_latest:{pk}", result_dict, timeout=86400)
    return Response(result_dict)


class MonteCarloLatestView(APIView):
    """Return the cached result of the most recent MC simulation for this project.

    Returns 200 with the full result dict if a cached result exists, or 404 if
    no simulation has been run since the 24-hour cache TTL last expired.

    Permission: Member (any role ≥ Viewer).
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

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


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                "status",
                str,
                description=(
                    "Filter by status: dead, pending_retry, dismissed, retried. "
                    "Invalid values are ignored (no filter)."
                ),
            ),
            OpenApiParameter(
                "task_name", str, description="Case-insensitive substring match on task_name."
            ),
            OpenApiParameter(
                "failed_after",
                str,
                description="ISO-8601; keep tasks with last_failed_at at or after this time.",
            ),
            OpenApiParameter(
                "failed_before",
                str,
                description="ISO-8601; keep tasks with last_failed_at at or before this time.",
            ),
        ],
    ),
)
class FailedTaskViewSet(IdempotencyMixin, ListModelMixin, RetrieveModelMixin, GenericViewSet):  # type: ignore[type-arg]
    """Admin endpoint for dead-lettered Celery tasks.

    List/detail/retry/dismiss: admin users only. The serializer exposes
    tracebacks, args, and kwargs which may contain internal paths or partial
    secrets and must not be visible to unprivileged members.

    The list endpoint backs the dead-letter inspector (#694, ADR-0087) and
    accepts read-only filters: ``?status=`` (one of the FailedTaskStatus
    values), ``?task_name=`` (case-insensitive substring), and
    ``?failed_after=`` / ``?failed_before=`` (ISO-8601, filtered on
    ``last_failed_at``). Results keep the model default ordering
    (``-last_failed_at``, newest failure first).
    """

    serializer_class = FailedTaskSerializer
    permission_classes = [IsAdminUser]
    queryset = FailedTask.objects.all()

    def get_queryset(self) -> models.QuerySet[FailedTask]:
        """Apply the inspector's read-only filters to the dead-letter list.

        Invalid filter values are ignored rather than raising, so a malformed
        bookmarked URL degrades to "no filter" instead of a 400 — an operator
        diagnosing an incident should never be blocked by a bad query string.
        """
        qs = FailedTask.objects.all()

        status_filter = self.request.query_params.get("status")
        if status_filter in FailedTaskStatus.values:
            qs = qs.filter(status=status_filter)

        task_name = self.request.query_params.get("task_name")
        if task_name:
            qs = qs.filter(task_name__icontains=task_name)

        failed_after = parse_datetime(self.request.query_params.get("failed_after", ""))
        if failed_after is not None:
            qs = qs.filter(last_failed_at__gte=failed_after)

        failed_before = parse_datetime(self.request.query_params.get("failed_before", ""))
        if failed_before is not None:
            qs = qs.filter(last_failed_at__lte=failed_before)

        return qs

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


# ---------------------------------------------------------------------------
# Velocity suggestions (ADR-0065)
# ---------------------------------------------------------------------------


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                "task",
                OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to velocity suggestions for this task.",
            ),
            OpenApiParameter(
                "pending",
                OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When true, restrict to suggestions awaiting a decision "
                    "(neither accepted nor dismissed)."
                ),
            ),
        ],
    ),
)
class VelocitySuggestionViewSet(
    IdempotencyMixin,
    ListModelMixin,
    RetrieveModelMixin,
    GenericViewSet[VelocitySuggestion],
):
    """Velocity-calibration suggestions surfaced to the PM (ADR-0065).

    Lifecycle:
      - sprint close generates a row per task in the closing sprint via
        ``compute_velocity_suggestions``
      - the PM accepts (writes ``most_likely_duration`` + enqueues
        ScheduleRequest) or dismisses (audit-only stamp) from the Task Detail
        Drawer
      - both terminal decisions are non-destructive: the row is preserved for
        audit; subsequent sprint closes may add new rows (one per task per
        sprint) but cannot overwrite a settled decision.

    Auth model:
      - list / retrieve: any project member (Viewer+) — read access is fine
        because the surface is informational
      - accept / dismiss: PM or above (the action either writes a CPM input or
        records a governance decision; either way it's PM-scope)

    Filtering: ``?task=<task_id>`` is the primary filter the drawer uses.
    ``?pending=true`` restricts to suggestions awaiting a decision.
    """

    serializer_class = VelocitySuggestionSerializer
    permission_classes = [IsAuthenticated]
    queryset = VelocitySuggestion.objects.all()

    def get_queryset(self) -> models.QuerySet[VelocitySuggestion]:
        qs = (
            VelocitySuggestion.objects.select_related("task", "sprint")
            .filter(task__is_deleted=False)
            .order_by("-created_at")
        )

        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)

        if self.request.query_params.get("pending", "").lower() == "true":
            qs = qs.filter(accepted_at__isnull=True, dismissed_at__isnull=True)

        # Membership gate: only return rows whose task belongs to a project the
        # caller is a member of. We rely on the access app's project-membership
        # subquery rather than per-row checks so the list endpoint stays fast.
        # IsAuthenticated excludes AnonymousUser before this runs; the isinstance
        # guard is there to narrow the type for mypy.
        from django.contrib.auth.models import AbstractBaseUser

        from trueppm_api.apps.access.models import ProjectMembership

        user = self.request.user
        if not isinstance(user, AbstractBaseUser):
            return qs.none()
        # is_deleted=False (#819): without this, a user whose membership was
        # soft-deleted still sees velocity suggestions for that project via the
        # list endpoint. The accept/dismiss actions go through IsProjectAdmin
        # which already filters soft-deleted, so the write path is safe — only
        # the list path was leaking.
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        qs = qs.filter(task__project_id__in=member_project_ids)
        return qs

    @action(
        detail=True,
        methods=["post"],
        permission_classes=[IsAuthenticated, IsProjectAdmin, IsProjectNotArchived],
    )
    def accept(self, request: Request, pk: str | None = None) -> Response:
        """Apply the suggested duration to the task and enqueue a CPM recompute.

        Idempotent: a suggestion that is already accepted returns 200 with the
        existing row. Re-applying after dismiss is rejected with 409 so the
        audit trail of the original decision is preserved.
        """
        suggestion = self.get_object()
        # Object-level permission keys off the task's project.
        self.check_object_permissions(request, suggestion.task)

        if suggestion.accepted_at is not None:
            return Response(VelocitySuggestionSerializer(suggestion).data)
        if suggestion.dismissed_at is not None:
            return Response(
                {"detail": "Suggestion has already been dismissed."},
                status=status.HTTP_409_CONFLICT,
            )

        task = suggestion.task
        project_id = task.project_id

        with transaction.atomic():
            task.most_likely_duration = suggestion.suggested_duration
            task.save(update_fields=["most_likely_duration"])
            VelocitySuggestion.objects.filter(pk=suggestion.pk).update(
                accepted_at=timezone.now(),
                accepted_by=request.user,
            )
            # CPM cascade: the new most_likely_duration shifts the Monte Carlo
            # forecast on the next run. Enqueue inside the transaction so the
            # request is visible to the drain only after the task save commits.
            transaction.on_commit(
                lambda: enqueue_recalculate(
                    str(project_id),
                    reason=ScheduleRequestReason.TASK_CHANGE,
                )
            )

        suggestion.refresh_from_db()
        return Response(VelocitySuggestionSerializer(suggestion).data)

    @action(
        detail=True,
        methods=["post"],
        permission_classes=[IsAuthenticated, IsProjectAdmin, IsProjectNotArchived],
    )
    def dismiss(self, request: Request, pk: str | None = None) -> Response:
        """Mark a suggestion as dismissed without touching the task.

        Idempotent: a suggestion that is already dismissed returns 200 with the
        existing row. Dismissing after accept is rejected with 409 to preserve
        the original decision.
        """
        suggestion = self.get_object()
        self.check_object_permissions(request, suggestion.task)

        if suggestion.dismissed_at is not None:
            return Response(VelocitySuggestionSerializer(suggestion).data)
        if suggestion.accepted_at is not None:
            return Response(
                {"detail": "Suggestion has already been accepted."},
                status=status.HTTP_409_CONFLICT,
            )

        VelocitySuggestion.objects.filter(pk=suggestion.pk).update(
            dismissed_at=timezone.now(),
            dismissed_by=request.user,
        )
        suggestion.refresh_from_db()
        return Response(VelocitySuggestionSerializer(suggestion).data)
