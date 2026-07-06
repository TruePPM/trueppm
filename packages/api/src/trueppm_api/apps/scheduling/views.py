"""Views for the scheduling app."""

from __future__ import annotations

import dataclasses
import json
import logging
from datetime import date as _date
from datetime import datetime as _datetime
from datetime import timedelta
from typing import Any, cast

from django.conf import settings
from django.core.cache import cache
from django.db import models, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiExample,
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
)
from rest_framework import status
from rest_framework.decorators import action, api_view, permission_classes, throttle_classes
from rest_framework.generics import ListAPIView
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework.viewsets import GenericViewSet

from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
    IsProjectScheduler,
    McpReadableViewMixin,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    Dependency,
    EstimationMode,
    Project,
    Task,
)
from trueppm_api.apps.scheduling.calendars import compose_project_calendar
from trueppm_api.apps.scheduling.models import (
    FailedTask,
    FailedTaskStatus,
    MonteCarloRun,
    ProjectForecastSnapshot,
    ScheduleRequestReason,
    VelocitySuggestion,
)
from trueppm_api.apps.scheduling.serializers import (
    FailedTaskDropSerializer,
    FailedTaskRequeueSerializer,
    FailedTaskSerializer,
    MonteCarloRunSerializer,
    MonteCarloWhatIfRequestSerializer,
    ProjectForecastSnapshotSerializer,
    VelocitySuggestionSerializer,
)
from trueppm_api.apps.scheduling.services import (
    build_sched_tasks,
    enqueue_recalculate,
    forecast_diagnostic,
    record_monte_carlo_run,
)
from trueppm_api.apps.scheduling.telemetry import monte_carlo_span
from trueppm_api.workflows.consumers.requeue_failed_task import WORKFLOW_NAME as REQUEUE_WORKFLOW
from trueppm_api.workflows.services import start_workflow

logger = logging.getLogger(__name__)

# Upper bound on how many parked tasks a single bulk requeue/drop touches, so a
# "drop all" / "requeue all" over a large filtered set cannot unbounded-load the
# DB or storm the broker (ADR-0210 §4). Overridable via settings for large
# installs; oldest-first slice, with a ``capped`` flag in the response so the
# operator knows to repeat.
FAILED_TASK_BULK_ACTION_MAX = getattr(settings, "FAILED_TASK_BULK_ACTION_MAX", 500)

# Statuses an operator can act on: a task that is already dismissed or retried is
# terminal and is skipped by bulk actions / rejected by single actions.
_ACTIONABLE_FAILED_STATUSES = (FailedTaskStatus.DEAD, FailedTaskStatus.PENDING_RETRY)


@extend_schema(
    summary="Trigger a CPM recalculation for a project",
    request=None,
    responses={
        202: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description='Recalculation queued via the outbox; body is {"queued": true}.',
        ),
        403: OpenApiResponse(description="Caller lacks the Scheduler role on the project."),
        404: OpenApiResponse(description="Project not found."),
    },
)
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


def _delta_vs_cpm_days(percentile: _date | None, cpm_finish: _date | None) -> int | None:
    """Signed calendar-day delta of a percentile finish vs the deterministic CPM finish.

    Positive means the probabilistic finish lands *later* than the deterministic
    spine — the schedule risk pushes the date out (worse). ``None`` when either
    input is missing. Server-owned so a headless/MCP client reads the risk
    premium directly instead of re-subtracting dates (API-first, #987/#986).
    """
    if percentile is None or cpm_finish is None:
        return None
    return (percentile - cpm_finish).days


def _confidence_curve(histogram: list[dict[str, object]], total: int) -> list[dict[str, object]]:
    """Cumulative P(finish ≤ date) S-curve derived from the histogram buckets.

    ``histogram`` is the already-binned ``[{date, count}]`` list in ascending date
    order; ``total`` is the number of simulated runs. Returns one ``{date, pct}``
    point per bucket carrying the cumulative share of runs that finished on or
    before that bucket — the same value ``MonteCarloDetailPanel`` previously
    accumulated in the browser (#987). Bounded to the bucket count (≤30 points).
    """
    if total <= 0:
        return []
    cumulative = 0
    curve: list[dict[str, object]] = []
    for bucket in histogram:
        cumulative += cast(int, bucket["count"])
        curve.append({"date": bucket["date"], "pct": round(cumulative / total * 100, 1)})
    return curve


def _distribution_for_persist(payload: dict[str, Any]) -> dict[str, Any]:
    """Shrink the distribution payload to fit MC_DISTRIBUTION_MAX_BYTES for storage (#1231).

    Takes the ``{histogram_buckets, confidence_curve, sensitivity}`` slice of the
    full result and, if its serialized size exceeds the cap, down-samples the
    histogram (keeps every Nth bucket, always retaining the first and last so the
    spread endpoints survive) until it fits. The confidence curve is recomputed
    from the thinned buckets so the two stay consistent; sensitivity is left intact
    (it is bounded by the task count, not the bucket count).

    Returns a NEW dict — the caller's full ``result_dict`` (and the cache copy it
    feeds) is never mutated, so the live view still serves the full-resolution
    histogram while the persisted row is bounded against a pathological run.
    """
    dist = {
        "histogram_buckets": payload.get("histogram_buckets", []),
        "confidence_curve": payload.get("confidence_curve", []),
        "sensitivity": payload.get("sensitivity", []),
    }
    cap = settings.MC_DISTRIBUTION_MAX_BYTES
    if len(json.dumps(dist).encode()) <= cap:
        return dist

    buckets: list[dict[str, object]] = list(dist["histogram_buckets"])
    total = sum(cast(int, b.get("count", 0)) for b in buckets)
    # Increase the stride until the serialized payload fits. Always keep the first
    # and last bucket so the distribution's min/max dates are preserved.
    stride = 2
    while len(json.dumps(dist).encode()) > cap and stride <= max(len(buckets), 2):
        thinned = [b for i, b in enumerate(buckets) if i % stride == 0]
        if buckets and buckets[-1] not in thinned:
            thinned.append(buckets[-1])
        dist = {
            "histogram_buckets": thinned,
            "confidence_curve": _confidence_curve(thinned, total),
            "sensitivity": dist["sensitivity"],
        }
        stride += 1
    return dist


class MonteCarloRunThrottle(ScopedRateThrottle):
    """Caps synchronous Monte Carlo runs per member (#1552) to bound DoS.

    ``run_monte_carlo`` executes an expensive simulation inline in the request
    cycle, gated only by project membership. Scoped per-user via ``monte_carlo``
    (10/min) so no single account can loop the endpoint to exhaust CPU, while a
    human tuning estimates and re-running the forecast stays well under the cap.

    ``ScopedRateThrottle`` normally reads its scope from ``view.throttle_scope``,
    but ``run_monte_carlo`` is a function-based ``@api_view`` that cannot carry
    that attribute, so the scope is bound from this class instead. The cache key
    is still per-user + scope (``get_cache_key`` is inherited unchanged).
    """

    scope = "monte_carlo"

    def allow_request(self, request: Request, view: APIView) -> bool:
        # Bind the fixed scope from the class rather than off the view (an
        # @api_view FBV has no throttle_scope), then apply the standard
        # SimpleRateThrottle sliding-window check.
        self.rate = self.get_rate()
        self.num_requests, self.duration = self.parse_rate(self.rate)
        return super(ScopedRateThrottle, self).allow_request(request, view)


@extend_schema(
    request=OpenApiTypes.OBJECT,
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Monte Carlo simulation result. Includes the engine result fields "
                "(P50/P80/P95 finish dates, mean, std dev, etc.) plus "
                "cpm_finish (deterministic CPM project finish, ISO 8601 or null), "
                "delta_vs_cpm ({p50,p80,p95} signed calendar-day premium vs CPM), "
                "confidence_curve ([{date, pct}] cumulative finish-by-date S-curve), "
                "histogram_buckets ([{date, count}]), sensitivity ([{task_id, index}] "
                "duration tornado — tasks that move the finish most, index 0..1, "
                "ADR-0140), forecast_diagnostic ({deterministic, reason, tasks_total, "
                "tasks_with_variance, tasks_pending_approval, agile_tasks_without_velocity} "
                "— explains a flat forecast; reason is null when a real band exists) "
                "and last_run_at (ISO 8601)."
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
@throttle_classes([MonteCarloRunThrottle])
def run_monte_carlo(request: Request, pk: str) -> Response:
    """Run a Monte Carlo probabilistic schedule simulation synchronously.

    Monte Carlo is fast (< 100 ms vectorised) so this runs in the request/
    response cycle rather than via Celery. No state is written; results are
    returned directly.

    Synchronous-by-design decision (#1203): keeping this inline is only safe
    because *every* multiplicative cost factor the run depends on is now bounded
    by the engine — tasks (MC_TASK_CAP), simulation runs (MC_SIMULATION_CAP),
    raw dependency edges (MAX_DEPENDENCIES), expanded edges (MAX_EXPANDED_EDGES),
    the distinct-lag delta arrays (MAX_LAG_DELTA_CELLS), and the velocity horizon
    (MAX_VELOCITY_SPRINTS) — and #1201 vectorised the previously O(edges x span)
    per-edge lag precompute. With the input space bounded and the hot path
    vectorised, the worst-case wall time stays within the request budget, so
    moving to a Celery job (extra latency, result polling, a new failure surface)
    would add cost without removing a real risk. A project that breaches the edge
    cap is rejected by the engine as InvalidScheduleInput (a ValueError) and
    surfaces below as a clean 400 rather than a stalled worker.

    Request body (all optional):
        n_simulations (int): Number of simulation runs. Defaults to
            settings.MC_SIMULATION_CAP. Must not exceed the cap.

    Returns 200 on success, 402 if the OSS simulation cap is exceeded,
    400 if the schedule input is invalid (e.g. the dependency-edge cap is
    breached), 404 if the project does not exist, 403 if the caller lacks
    read access.
    """
    from trueppm_scheduler.engine import CyclicDependencyError, SimulationCapExceeded, monte_carlo
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType
    from trueppm_scheduler.models import Project as SchedProject

    try:
        project = (
            Project.objects.select_related("calendar")
            # calendar__exceptions + calendar_layers__calendar__exceptions:
            # compose_project_calendar reads the base calendar's exceptions (#1491)
            # AND every applied overlay's (#906); prefetch both to avoid an N+1.
            .prefetch_related(
                "tasks", "calendar__exceptions", "calendar_layers__calendar__exceptions"
            )
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

    # Shared converter (#1491): includes the calendar's CalendarException
    # holiday/shutdown ranges, which the previous inline construction dropped —
    # so Monte Carlo silently scheduled straight through configured holidays.
    sched_calendar = compose_project_calendar(project)

    # Monte Carlo simulates committed delivery only — BACKLOG cards are not
    # part of the forecast. ADR-0057 / Task.committed.
    # select_related("sprint"): build_sched_tasks reads sprint.start_date for the
    # ADR-0168 sprint-window floor; load it with the task to avoid an N+1.
    db_tasks = list(Task.committed.filter(project=project).select_related("sprint"))

    # Shared converter (ADR-0132): the deterministic CPM pass and Monte Carlo
    # build their scheduler input through one function, so a field can never reach
    # one engine and not the other — the drift that caused #1185 (MC had silently
    # dropped planned_start). build_sched_tasks honors the planned_start floor for
    # every task (the #1185 fix, now centralized) and withholds pending three-point
    # estimates in SUGGEST_APPROVE mode.
    suggest_approve = project.estimation_mode == EstimationMode.SUGGEST_APPROVE
    sched_tasks = build_sched_tasks(db_tasks, suggest_approve=suggest_approve)

    # Drop any edge whose endpoint is absent from sched_tasks: cross-project
    # dependencies (successor lives in another project) and edges to non-committed
    # (BACKLOG) tasks both dangle here and would make the engine reject the network
    # as referencing an unknown task. Mirrors the CPM guard in scheduling.tasks
    # (ADR-0090) — a single-project Monte Carlo simulates only this project's tasks.
    included_ids = {str(t.id) for t in db_tasks}
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
        if str(d.predecessor_id) in included_ids and str(d.successor_id) in included_ids
    ]

    # Agile-aware Monte Carlo (#411, ADR-0065/0106): feed the team's completed-sprint
    # throughput to the engine so SCRUM/story-point tasks sample sprints-to-completion
    # from real velocity variance. Without this the engine's velocity path can never
    # fire — every story falls back to its deterministic placeholder duration (1 day),
    # so an all-agile project (e.g. a board-driven program project) forecasts a single
    # flat date with no uncertainty. ([], None) when there is no velocity signal, which
    # leaves a waterfall/PERT project's forecast unchanged.
    from trueppm_api.apps.projects.services import scheduler_velocity_inputs

    velocity_samples, sprint_length_days = scheduler_velocity_inputs(
        project.pk, sched_calendar.working_days
    )

    sched_project = SchedProject(
        id=str(project.pk),
        name=project.name,
        start_date=project.start_date,
        tasks=sched_tasks,
        dependencies=sched_deps,
        calendar=sched_calendar,
        # Data date for the forecast (ADR-0132): the project's explicit status
        # date, or today when unset — so Monte Carlo never schedules remaining
        # work in the past and pins completed work to its actuals.
        status_date=project.status_date or timezone.localdate(),
        velocity_samples=velocity_samples or None,
        sprint_length_days=sprint_length_days,
    )

    try:
        # Manual Monte Carlo span (#709): times the simulation inline in the request
        # cycle and records the run count; a no-op span unless OTel is configured.
        with monte_carlo_span(pk, simulation_count=n_simulations):
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

    # The deterministic CPM spine is the max early_finish of the committed tasks
    # already loaded above — no extra query. It anchors delta_vs_cpm (the risk
    # premium each percentile adds over the deterministic finish) and is itself
    # the project's deterministic schedule finish (#987 — single source, no
    # duplicate project field). Computed before result_dict so the cached latest
    # payload carries it.
    cpm_finish = max(
        (t.early_finish for t in db_tasks if t.early_finish is not None),
        default=None,
    )

    # `last_run_at` lets the frontend surface a "Last run: 2h ago" freshness
    # signal and decide whether to nudge a rerun (#335). Captured at cache-write
    # time so it always tracks the most recent successful simulation, never the
    # cache read.
    result_dict = {
        **mc_result.to_dict(),
        "cpm_finish": cpm_finish.isoformat() if cpm_finish else None,
        "delta_vs_cpm": {
            "p50": _delta_vs_cpm_days(mc_result.p50, cpm_finish),
            "p80": _delta_vs_cpm_days(mc_result.p80, cpm_finish),
            "p95": _delta_vs_cpm_days(mc_result.p95, cpm_finish),
        },
        "confidence_curve": _confidence_curve(histogram, len(dist)),
        "histogram_buckets": histogram,
        # Why the forecast has (or lacks) a band, so the UI can explain a flat
        # result instead of presenting a misleadingly precise single date (#1340).
        # Computed from the already-loaded committed task set + estimation mode +
        # velocity signal — no extra query.
        "forecast_diagnostic": forecast_diagnostic(
            db_tasks,
            suggest_approve=suggest_approve,
            has_velocity_signal=bool(velocity_samples),
            deterministic=(mc_result.p50 == mc_result.p80 == mc_result.p95),
        ),
        "last_run_at": timezone.now().isoformat(),
    }
    cache.set(f"mc_latest:{pk}", result_dict, timeout=86400)

    # Persist this run for the forecast-drift history (ADR-0175, #961). Best-effort:
    # a write failure inside the service is logged and swallowed so the simulation
    # result is still returned; the response carries the run id when persistence
    # succeeded.
    # Persist the same distribution slice the cache holds, but bounded to
    # MC_DISTRIBUTION_MAX_BYTES via down-sampling (#1231) — the cache copy above is
    # full-resolution and untouched. Stored so the histogram + tornado survive
    # cache expiry and a past run stays re-viewable.
    distribution = _distribution_for_persist(result_dict)
    run = record_monte_carlo_run(
        str(project.pk),
        p50=mc_result.p50,
        p80=mc_result.p80,
        p95=mc_result.p95,
        n_simulations=n_simulations,
        cpm_finish=cpm_finish,
        task_count=len(db_tasks),
        user=request.user,
        distribution=distribution,
    )
    if run is not None:
        result_dict["run_id"] = str(run.id)
    return Response(result_dict)


class MonteCarloLatestView(McpReadableViewMixin, APIView):
    """Return the cached result of the most recent MC simulation for this project.

    Returns 200 with the full result dict if a cached result exists, or 404 if
    no simulation has been run since the 24-hour cache TTL last expired.

    Permission: Member (any role ≥ Viewer).
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        summary="Latest cached Monte Carlo forecast for the project",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "The most recent Monte Carlo result for the project. Keys: p50/p80/p95 "
                    "(ISO-8601 finish dates), cpm_finish, delta_vs_cpm ({p50, p80, p95} "
                    "calendar-day deltas vs the CPM finish), runs (n_simulations), "
                    "confidence_curve, histogram_buckets, sensitivity, last_run_at, and "
                    "from_history (true when served from a persisted run after the 24h cache "
                    "TTL expired). Legacy runs with no stored distribution return empty "
                    "confidence_curve/histogram_buckets/sensitivity arrays."
                ),
            ),
            404: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="No simulation result available for this project ({detail}).",
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        """Return the latest cached Monte Carlo result for the project.

        Falls back to the most recent persisted ``MonteCarloRun`` when the 24-hour
        cache has expired (ADR-0175): the latest forecast now survives past the
        TTL. As of #1231 the run also persists its distribution, so when present the
        fallback returns the real ``histogram_buckets``/``confidence_curve``/
        ``sensitivity`` instead of empty arrays — the histogram survives cache
        expiry. Legacy runs (no persisted distribution) still fall back to empty,
        and the frontend renders the empty-state prose for them.
        """
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        cached = cache.get(f"mc_latest:{pk}")
        if cached is not None:
            return Response(cached)

        latest = MonteCarloRun.objects.filter(project_id=pk).order_by("-taken_at").first()
        if latest is None:
            return Response(
                {"detail": "No simulation result available."},
                status=status.HTTP_404_NOT_FOUND,
            )
        # cpm_finish + delta_vs_cpm survive the TTL because both are persisted on the
        # run (ADR-0175). The distribution (#1231) now survives too when persisted:
        # use the stored buckets/curve/sensitivity, falling back to empty arrays for
        # legacy runs that pre-date persistence (the frontend shows the empty-state
        # prose then). Response shape is unchanged (snake_case keys).
        dist = latest.distribution or {}
        return Response(
            {
                "p50": latest.p50.isoformat() if latest.p50 else None,
                "p80": latest.p80.isoformat() if latest.p80 else None,
                "p95": latest.p95.isoformat() if latest.p95 else None,
                "cpm_finish": latest.cpm_finish.isoformat() if latest.cpm_finish else None,
                "delta_vs_cpm": {
                    "p50": _delta_vs_cpm_days(latest.p50, latest.cpm_finish),
                    "p80": _delta_vs_cpm_days(latest.p80, latest.cpm_finish),
                    "p95": _delta_vs_cpm_days(latest.p95, latest.cpm_finish),
                },
                "confidence_curve": dist.get("confidence_curve", []),
                "runs": latest.n_simulations,
                "histogram_buckets": dist.get("histogram_buckets", []),
                "sensitivity": dist.get("sensitivity", []),
                "last_run_at": latest.taken_at.isoformat(),
                "from_history": True,
            }
        )


# Fixed RNG seed for the what-if endpoint (#993). Both the baseline and the
# perturbed Monte Carlo runs sample with THIS seed, so they draw the *same*
# per-run duration samples for every unperturbed task. The delta between the two
# forecasts therefore isolates the effect of the perturbation rather than RNG
# noise, and the endpoint is a pure function of its inputs — the same what-if
# query always returns the same forecast, which a reproducible "slip this task"
# demo (and a stable test assertion) both depend on.
WHATIF_MC_SEED = 993_993


def _shift_duration(td: timedelta | None, delta_days: int) -> timedelta | None:
    """Shift a duration by ``delta_days``, flooring at zero; ``None`` passes through.

    Used to perturb both the deterministic duration and each leg of a task's PERT
    triple by the same signed offset, so the estimate's shape/order is preserved
    while its center moves. A negative delta that would drive a duration below zero
    is clamped to zero rather than producing a nonsensical negative duration.
    """
    if td is None:
        return None
    shifted = td + timedelta(days=delta_days)
    return shifted if shifted > timedelta(0) else timedelta(0)


class MonteCarloWhatIfView(McpReadableViewMixin, APIView):
    """Non-mutating Monte Carlo what-if: perturb one task's duration, recompute (#993).

    Backs the MCP ``whatif`` read tool (#504/#603): accept a ``task_id`` plus a
    duration perturbation, run CPM + Monte Carlo **in memory without persisting
    anything**, and return the resulting P50/P80/P95, the deterministic CPM finish,
    whether the critical path changed, and the signed deltas versus the current
    (unperturbed) forecast.

    Why GET, not POST: the endpoint has no side effects — it writes no rows, sets no
    cache, and enqueues no recompute — so it is a pure read/compute, correctly
    modeled as GET. That is also what makes it reachable by an ``mcp:read`` API
    token: ``McpReadableViewMixin`` confines token callers to safe methods, so a
    POST could never back a *read* MCP tool. Query params carry the perturbation
    (``?task_id=&duration_delta=`` or ``&new_duration=``).

    Non-persistence guarantee: this view never calls ``.save()``,
    ``record_monte_carlo_run``, ``cache.set``, or ``enqueue_recalculate``. The
    perturbation is applied to freshly-built in-memory scheduler dataclasses; the
    Django rows are only read. ``schedule()`` and ``monte_carlo()`` both operate on
    copies and do not mutate their input project.

    Permission: Member (any role >= Viewer), the same project-read gate as the
    ``run_monte_carlo`` / latest / history forecast endpoints.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "monte_carlo_whatif"

    @extend_schema(
        summary="Non-mutating Monte Carlo what-if for a single task duration change",
        parameters=[
            OpenApiParameter(
                "task_id",
                OpenApiTypes.UUID,
                required=True,
                description="The committed task whose duration to perturb.",
            ),
            OpenApiParameter(
                "duration_delta",
                OpenApiTypes.INT,
                description=(
                    "Signed day offset applied to the task's current duration "
                    "(e.g. 5 to slip it a working week later, -2 to pull it in). "
                    "Supply exactly one of duration_delta or new_duration."
                ),
            ),
            OpenApiParameter(
                "new_duration",
                OpenApiTypes.INT,
                description=(
                    "Absolute day count to set the task's duration to (>= 0). "
                    "Supply exactly one of duration_delta or new_duration."
                ),
            ),
            OpenApiParameter(
                "n_simulations",
                OpenApiTypes.INT,
                description="Monte Carlo iterations; defaults to MC_SIMULATION_CAP, capped there.",
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "What-if forecast. Keys: task_id; applied ({base_duration_days, "
                    "duration_delta_days, new_duration_days}); current and whatif (each "
                    "{p50, p80, p95, cpm_finish (ISO-8601 or null), critical_path ([task_id])}); "
                    "critical_path_changed (bool — did the set of critical tasks change); "
                    "delta_vs_current ({p50, p80, p95, cpm_finish} signed calendar-day shifts, "
                    "positive = later/worse, null when a date is missing); runs (n_simulations); "
                    "seed (fixed RNG seed shared by both runs so the delta isolates the change)."
                ),
            ),
            400: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Invalid input: malformed/absent params, both or neither of "
                    "duration_delta/new_duration, task_id not a committed task in this "
                    "project, a milestone (zero-duration) target, a cyclic dependency, or an "
                    "out-of-range project span."
                ),
            ),
            402: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="OSS simulation cap exceeded (n_simulations or task count too high).",
            ),
            404: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Project does not exist.",
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        """Run the perturbed forecast in memory and return the deltas (see class doc)."""
        from trueppm_scheduler.engine import (
            CyclicDependencyError,
            SimulationCapExceeded,
            monte_carlo,
            schedule,
        )
        from trueppm_scheduler.models import Dependency as SchedDependency
        from trueppm_scheduler.models import DependencyType
        from trueppm_scheduler.models import Project as SchedProject

        from trueppm_api.apps.projects.services import scheduler_velocity_inputs

        req = MonteCarloWhatIfRequestSerializer(data=request.query_params)
        req.is_valid(raise_exception=True)
        params = req.validated_data
        task_id = str(params["task_id"])

        try:
            project = (
                Project.objects.select_related("calendar")
                .prefetch_related(
                    "tasks", "calendar__exceptions", "calendar_layers__calendar__exceptions"
                )
                .get(pk=pk, is_deleted=False)
            )
        except Project.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        # Object-level membership + not-archived gate (same read level as the
        # forecast endpoints). APIView.get has no get_object(), so enforce explicitly.
        self.check_object_permissions(request, project)

        cap: int | None = settings.MC_SIMULATION_CAP
        n_simulations = int(params.get("n_simulations", cap or 1_000))

        # Build the baseline scheduler input exactly as run_monte_carlo does, through
        # the shared converters (ADR-0132/#1491) so the what-if forecast is computed on
        # the identical graph the real forecast uses — same calendar exceptions, same
        # planned_start floors, same velocity signal.
        sched_calendar = compose_project_calendar(project)
        db_tasks = list(Task.committed.filter(project=project).select_related("sprint"))
        if not db_tasks:
            return Response(
                {"detail": "Project has no schedulable (committed) tasks to forecast."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # The perturbation target must be one of THIS project's committed tasks. A
        # BACKLOG card, a task in another project, or an unknown id is rejected as a
        # clean 400 (not 404 — the project exists and the caller can read it; only the
        # task reference is invalid) and never leaks whether the id exists elsewhere.
        target_db = next((t for t in db_tasks if str(t.id) == task_id), None)
        if target_db is None:
            return Response(
                {"detail": "task_id is not a committed task in this project."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if target_db.is_milestone:
            return Response(
                {"detail": "A milestone is a zero-duration gate and cannot be perturbed."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        base_duration_days = int(target_db.duration)
        if "duration_delta" in params:
            delta_days = int(params["duration_delta"])
        else:
            # new_duration is absolute; convert to the equivalent signed shift so both
            # inputs flow through one perturbation path.
            delta_days = int(params["new_duration"]) - base_duration_days
        new_duration_days = max(0, base_duration_days + delta_days)

        suggest_approve = project.estimation_mode == EstimationMode.SUGGEST_APPROVE
        baseline_tasks = build_sched_tasks(db_tasks, suggest_approve=suggest_approve)

        # Perturbed task list: a copy with only the target's duration (and, when it
        # carries a three-point estimate, each PERT leg) shifted. Shifting the PERT
        # triple too matters because Monte Carlo samples a PERT task from its triple,
        # not its deterministic duration — perturbing only `duration` would leave the
        # probabilistic bands unmoved for an estimated task, defeating the what-if.
        perturbed_tasks = []
        for st in baseline_tasks:
            if st.id == task_id:
                st = dataclasses.replace(
                    st,
                    duration=_shift_duration(st.duration, delta_days),
                    optimistic_duration=_shift_duration(st.optimistic_duration, delta_days),
                    most_likely_duration=_shift_duration(st.most_likely_duration, delta_days),
                    pessimistic_duration=_shift_duration(st.pessimistic_duration, delta_days),
                )
            perturbed_tasks.append(st)

        included_ids = {str(t.id) for t in db_tasks}
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
            if str(d.predecessor_id) in included_ids and str(d.successor_id) in included_ids
        ]

        velocity_samples, sprint_length_days = scheduler_velocity_inputs(
            project.pk, sched_calendar.working_days
        )

        # The deterministic CPM and Monte Carlo use different data dates by design
        # (ADR-0132), so mirror each engine's canonical status_date here: schedule()
        # takes the raw status_date (None => earliest-possible dates, matching the
        # stored plan) and monte_carlo() floors it at today (never forecasts remaining
        # work in the past). Using each engine's own convention keeps current.cpm_finish
        # identical to the persisted deterministic finish and current P50/P80/P95
        # identical to run_monte_carlo.
        cpm_status_date = project.status_date
        mc_status_date = project.status_date or timezone.localdate()

        def _make_project(tasks: list[Any], status_date: _date | None) -> Any:
            return SchedProject(
                id=str(project.pk),
                name=project.name,
                start_date=project.start_date,
                tasks=tasks,
                dependencies=sched_deps,
                calendar=sched_calendar,
                status_date=status_date,
                velocity_samples=velocity_samples or None,
                sprint_length_days=sprint_length_days,
            )

        try:
            # One shared Monte Carlo span (#709) over the full what-if computation —
            # baseline + perturbed CPM and simulation — through the same helper the
            # real forecast uses, so the span name and attributes cannot drift.
            with monte_carlo_span(pk, simulation_count=n_simulations):
                baseline_cpm = schedule(_make_project(baseline_tasks, cpm_status_date))
                perturbed_cpm = schedule(_make_project(perturbed_tasks, cpm_status_date))
                baseline_mc = monte_carlo(
                    _make_project(baseline_tasks, mc_status_date),
                    runs=n_simulations,
                    seed=WHATIF_MC_SEED,
                    max_runs=cap,
                    max_tasks=settings.MC_TASK_CAP,
                )
                perturbed_mc = monte_carlo(
                    _make_project(perturbed_tasks, mc_status_date),
                    runs=n_simulations,
                    seed=WHATIF_MC_SEED,
                    max_runs=cap,
                    max_tasks=settings.MC_TASK_CAP,
                )
        except SimulationCapExceeded as exc:
            return Response(
                {"error": "simulation_cap_exceeded", "tier": "team", "message": str(exc)},
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )
        except (CyclicDependencyError, ValueError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except OverflowError:
            return Response(
                {"detail": "Project schedule exceeds the representable date range."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # A membership change in the critical set is the meaningful "the shape of the
        # plan moved" signal — compared as sets so a pure reordering along an unchanged
        # path does not read as a change.
        critical_path_changed = set(baseline_cpm.critical_path) != set(perturbed_cpm.critical_path)

        def _days(later: _date | None, earlier: _date | None) -> int | None:
            if later is None or earlier is None:
                return None
            return (later - earlier).days

        current = {
            "p50": baseline_mc.p50.isoformat(),
            "p80": baseline_mc.p80.isoformat(),
            "p95": baseline_mc.p95.isoformat(),
            "cpm_finish": baseline_cpm.project_finish.isoformat(),
            "critical_path": list(baseline_cpm.critical_path),
        }
        whatif = {
            "p50": perturbed_mc.p50.isoformat(),
            "p80": perturbed_mc.p80.isoformat(),
            "p95": perturbed_mc.p95.isoformat(),
            "cpm_finish": perturbed_cpm.project_finish.isoformat(),
            "critical_path": list(perturbed_cpm.critical_path),
        }
        return Response(
            {
                "task_id": task_id,
                "applied": {
                    "base_duration_days": base_duration_days,
                    "duration_delta_days": delta_days,
                    "new_duration_days": new_duration_days,
                },
                "current": current,
                "whatif": whatif,
                "critical_path_changed": critical_path_changed,
                "delta_vs_current": {
                    "p50": _days(perturbed_mc.p50, baseline_mc.p50),
                    "p80": _days(perturbed_mc.p80, baseline_mc.p80),
                    "p95": _days(perturbed_mc.p95, baseline_mc.p95),
                    "cpm_finish": _days(perturbed_cpm.project_finish, baseline_cpm.project_finish),
                },
                "runs": n_simulations,
                "seed": WHATIF_MC_SEED,
            }
        )


# Hard ceiling on a single forecast-history response, independent of the
# retention cap. OSS retention (MC_HISTORY_CAP=100) is already below this; the
# ceiling only bites the Enterprise unlimited-retention case so the endpoint can
# never stream an unbounded payload (ADR-0175).
MC_HISTORY_RESPONSE_MAX = 500


@extend_schema(
    parameters=[
        OpenApiParameter(
            "expand",
            str,
            description=(
                "Set to 'distribution' to include each run's persisted distribution "
                "({histogram_buckets, confidence_curve, sensitivity}) payload (#1231). "
                "Omitted by default to keep the list lightweight; distribution is null "
                "unless expanded or for legacy runs with no stored distribution."
            ),
        ),
    ],
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Project Monte Carlo run history (ADR-0175/0143). "
                "{results: [MonteCarloRun], cap: int|null, enabled: bool}. When the "
                "per-workspace config disables history, enabled is false and results is "
                "empty. Each run carries P50/P80/P95, cpm_finish, n_simulations, "
                "task_count, a per-percentile delta vs the previous run (null on the "
                "oldest row), triggered_by_name (non-null only for the resolved "
                "attribution audience), and distribution (only when ?expand=distribution)."
            ),
        ),
        404: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Project does not exist.",
        ),
    },
)
class MonteCarloHistoryView(APIView):
    """Project Monte Carlo run history — forecast drift over time (ADR-0175, #961).

    Returns persisted runs newest-first, capped at ``settings.MC_HISTORY_CAP``,
    each with a computed-on-read per-percentile delta versus the immediately
    previous (older) run. The run-author attribution (``triggered_by_name``) is
    serialized only for Admin/Owner (role ≥ ADMIN); every other member sees the
    drift values without attribution, so forecast drift cannot become a
    named-individual performance signal (VoC Morgan).

    Permission: Member (any role ≥ Viewer), consistent with the forecast read.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, pk: str) -> Response:
        """Return the capped, newest-first run history with per-run deltas."""
        from trueppm_api.apps.access.models import Role
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.scheduling.forecast_history_settings import (
            resolve_effective_mc_history,
        )
        from trueppm_api.apps.scheduling.models import MCAttributionAudience

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        # Per-workspace forecast-history config (ADR-0144, #1232), inheritable
        # Workspace → Program → Project. When the effective config disables history,
        # return 200 with an empty list + enabled:false rather than 403/404 — the
        # feature is off, not access-denied, so the FE renders a "history off" state.
        if not resolve_effective_mc_history(project, "mc_history_enabled"):
            return Response({"results": [], "cap": None, "enabled": False})

        # The retention cap is now per-workspace-effective (clamped to
        # MC_HISTORY_HARD_CAP in the resolver) rather than the global constant.
        cap: int | None = resolve_effective_mc_history(project, "mc_history_retention_cap")
        # Hard response ceiling: even when the cap is None (Enterprise unlimited
        # *retention*), a single API response must stay bounded — keep the newest
        # MC_HISTORY_RESPONSE_MAX rows. select_related avoids an N+1 on triggered_by
        # when attribution is serialized.
        limit = cap if cap is not None else MC_HISTORY_RESPONSE_MAX
        # ?expand=distribution opts a single detail fetch into the heavier per-run
        # distribution payload (#1231); the default list stays lightweight.
        expand_distribution = request.query_params.get("expand") == "distribution"
        qs = (
            MonteCarloRun.objects.filter(project_id=pk)
            .select_related("triggered_by")
            .order_by("-taken_at")
        )
        # The distribution column is up to MC_DISTRIBUTION_MAX_BYTES per row; the
        # serializer never reads it on the default list path, so defer it there to
        # avoid fetching + JSON-parsing ~limit×32KB only to discard it.
        if not expand_distribution:
            qs = qs.defer("distribution")
        runs = list(qs[:limit])

        # Computed-on-read delta (ADR-0108): each run vs the next-older run.
        # Positive days = the forecast slipped later (worse). The oldest row in
        # the list has no predecessor → _delta stays None (baseline).
        def _diff(newer: _date | None, older: _date | None) -> int | None:
            if newer is None or older is None:
                return None
            return (newer - older).days

        for i, run in enumerate(runs):
            older = runs[i + 1] if i + 1 < len(runs) else None
            if older is None:
                run._delta = None  # type: ignore[attr-defined]
            else:
                run._delta = {  # type: ignore[attr-defined]
                    "p50": _diff(run.p50, older.p50),
                    "p80": _diff(run.p80, older.p80),
                    "p95": _diff(run.p95, older.p95),
                }

        # Attribution audience is now resolved per-workspace (ADR-0144) instead of a
        # hardcoded Admin/Owner gate: ADMIN_OWNER → role ≥ ADMIN; SCHEDULER_PLUS →
        # role ≥ SCHEDULER; NONE → never. Default ADMIN_OWNER reproduces the prior
        # behavior exactly. Drift must not become a named-individual signal below
        # the configured audience (VoC Morgan).
        role = _membership_role(request, pk)
        audience = resolve_effective_mc_history(project, "mc_history_attribution_audience")
        if audience == MCAttributionAudience.NONE:
            can_see_attribution = False
        elif audience == MCAttributionAudience.SCHEDULER_PLUS:
            can_see_attribution = role is not None and role >= Role.SCHEDULER
        else:  # ADMIN_OWNER (default)
            can_see_attribution = role is not None and role >= Role.ADMIN

        data = MonteCarloRunSerializer(
            runs,
            many=True,
            context={
                "request": request,
                "can_see_attribution": can_see_attribution,
                "expand_distribution": expand_distribution,
            },
        ).data
        return Response({"results": data, "cap": cap, "enabled": True})


@extend_schema(
    parameters=[
        # Day-grained window, declared as `date` to match the burn-series
        # contract (#1378) — the new 0.3 computed analytics endpoints expose
        # since/until with one consistent type. The runtime stays lenient: a
        # bare ISO date is the documented format, and a full ISO datetime is
        # still accepted as a backward-compatible superset (see _parse_bound).
        OpenApiParameter(
            "since",
            OpenApiTypes.DATE,
            description="Only snapshots captured at or after this ISO 8601 date (YYYY-MM-DD).",
        ),
        OpenApiParameter(
            "until",
            OpenApiTypes.DATE,
            description="Only snapshots captured at or before this ISO 8601 date (YYYY-MM-DD).",
        ),
    ],
    responses={200: ProjectForecastSnapshotSerializer(many=True)},
)
class ForecastSnapshotListView(ListAPIView[ProjectForecastSnapshot]):
    """Project-grain forecast snapshot history (ADR-0154, #388).

    Returns the project's forecast snapshots newest-first (paginated), the
    persisted record of how the CPM finish and Monte Carlo percentiles drifted
    over time. Read-only — rows are server-generated on recompute and by the daily
    floor; there is no write surface. ``?since=``/``?until=`` bound the window by
    ``captured_at`` (ISO 8601 date YYYY-MM-DD, the documented format; a full ISO
    datetime is also accepted and interpreted literally, a bare date as midnight UTC).

    Permission: Member (any role ≥ Viewer), the project-read gate — consistent
    with the Monte Carlo history read.
    """

    serializer_class = ProjectForecastSnapshotSerializer
    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get_queryset(self) -> models.QuerySet[ProjectForecastSnapshot]:
        """Project-scoped, optionally date-bounded, newest-first."""
        project = get_object_or_404(Project, pk=self.kwargs["pk"], is_deleted=False)
        # IsProjectMember/IsProjectNotArchived are object-level — this list view has
        # no get_object(), so enforce them explicitly against the resolved project.
        self.check_object_permissions(self.request, project)

        qs = ProjectForecastSnapshot.objects.filter(project_id=project.pk).order_by("-captured_at")
        since = self._parse_bound(self.request.query_params.get("since"))
        until = self._parse_bound(self.request.query_params.get("until"))
        if since is not None:
            qs = qs.filter(captured_at__gte=since)
        if until is not None:
            qs = qs.filter(captured_at__lte=until)
        return qs

    @staticmethod
    def _parse_bound(raw: str | None) -> Any:
        """Parse an ISO date (documented) or full datetime to a timezone-aware bound.

        A bare ``YYYY-MM-DD`` is the documented since/until format (#1378),
        interpreted as midnight in the default timezone; a full ISO datetime is
        still accepted. ``parse_datetime`` parses a date-only string into a *naive*
        midnight, so any naive result is made aware here — otherwise the bound
        would be compared naive against the aware ``captured_at`` column (a Django
        RuntimeWarning and a silent offset bug).
        """
        if not raw:
            return None
        dt = parse_datetime(raw)
        if dt is None:
            d = parse_date(raw)
            if d is None:
                return None
            dt = _datetime(d.year, d.month, d.day)
        if timezone.is_naive(dt):
            dt = timezone.make_aware(dt)
        return dt


class FailedTaskPagination(PageNumberPagination):
    """Bounded page-number pagination for the dead-letter queue (#1317).

    The list mixin already paged through the project default, but the bound was
    implicit; the dead-letter table can grow to thousands, so the cap is made
    explicit here. Page-number (not cursor) is retained deliberately — the
    inspector header shows a total ``count``, which CursorPagination omits.
    """

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


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

    List/detail/requeue/drop and the bulk ``requeue_all``/``drop_all``: admin users
    only. The serializer exposes tracebacks, args, and kwargs which may contain
    internal paths or partial secrets and must not be visible to unprivileged
    members.

    The list endpoint backs the dead-letter inspector (#694, ADR-0172) and
    accepts read-only filters: ``?status=`` (one of the FailedTaskStatus
    values), ``?task_name=`` (case-insensitive substring), and
    ``?failed_after=`` / ``?failed_before=`` (ISO-8601, filtered on
    ``last_failed_at``). Results keep the model default ordering
    (``-last_failed_at``, newest failure first).

    Write actions (#695, ADR-0210):
      - ``requeue`` re-enqueues a parked task with an operator-chosen backoff,
        round-tripping through the durable workflow backend (ADR-0080) rather than
        the old raw ``send_task`` side channel.
      - ``drop`` soft-removes a parked task (→ DISMISSED) with an optional audit
        note; the row is retained so the audit survives (ADR-0084 "no silent
        discards").
      - ``requeue_all`` / ``drop_all`` apply the same action across the *current
        filter set*, bounded to ``FAILED_TASK_BULK_ACTION_MAX``.
    """

    serializer_class = FailedTaskSerializer
    permission_classes = [IsAdminUser]
    pagination_class = FailedTaskPagination
    queryset = FailedTask.objects.all()

    def get_queryset(self) -> models.QuerySet[FailedTask]:
        """Apply the inspector's read-only filters to the dead-letter list.

        Invalid filter values are ignored rather than raising, so a malformed
        bookmarked URL degrades to "no filter" instead of a 400 — an operator
        diagnosing an incident should never be blocked by a bad query string.

        ``select_related('resolved_by')`` avoids an N+1 on the resolved-status list
        views (``?status=retried``/``dismissed``): the ``resolved_by_display``
        serializer field reads the operator FK, which would otherwise lazy-load
        once per row (ADR-0210 audit fields).
        """
        qs = FailedTask.objects.select_related("resolved_by")

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

    def _start_requeue_workflow(self, failed: FailedTask, backoff_seconds: int) -> str:
        """Start the durable requeue workflow for one task (ADR-0210 §1).

        Routes the re-enqueue through the #652 outbox-composing workflow backend
        (``start_workflow``) rather than a raw ``send_task`` side channel, so a
        broker outage cannot silently drop the requeue. The idempotency key ties one
        requeue to one *observed failure* (``id`` + ``failure_count``): a
        double-clicked or replayed requeue collides on the key and returns the
        existing workflow instead of double-enqueuing.
        """
        return start_workflow(
            REQUEUE_WORKFLOW,
            {
                "failed_task_id": str(failed.id),
                "task_name": failed.task_name,
                "args": failed.args,
                "kwargs": failed.kwargs,
                "backoff_seconds": backoff_seconds,
            },
            idempotency_key=f"requeue:{failed.id}:{failed.failure_count}",
        )

    @extend_schema(
        request=FailedTaskRequeueSerializer,
        responses={200: FailedTaskSerializer},
        summary="Requeue a dead-lettered task with an operator-chosen backoff",
    )
    @action(detail=True, methods=["post"], permission_classes=[IsAdminUser])
    def requeue(self, request: Request, pk: str | None = None) -> Response:
        """Re-enqueue a parked task via the durable workflow backend (ADR-0210).

        Only ``dead``/``pending_retry`` tasks are requeueable; a terminal task is a
        400. The re-enqueue is durable (workflow outbox); the ``backoff_seconds`` is
        a best-effort Celery countdown on the re-dispatched task.
        """
        failed = self.get_object()
        if failed.status not in _ACTIONABLE_FAILED_STATUSES:
            return Response(
                {"detail": f"Cannot requeue a task with status '{failed.status}'."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        payload = FailedTaskRequeueSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        backoff_seconds = payload.validated_data["backoff_seconds"]

        # Start the durable workflow first, then stamp the row: the side effect is the
        # durable part, so if the status update failed the workflow still ran and a
        # re-run dedupes on the idempotency key. Both commit together under
        # ATOMIC_REQUESTS, so a mid-action error rolls the whole thing back.
        workflow_id = self._start_requeue_workflow(failed, backoff_seconds)
        FailedTask.objects.filter(pk=failed.pk).update(
            status=FailedTaskStatus.RETRIED,
            resolved_by=request.user,
            resolved_at=timezone.now(),
        )
        failed.refresh_from_db()
        logger.info(
            "dead-letter requeue: task %s (%s) requeued by user %s, backoff=%ss, workflow=%s",
            failed.id,
            failed.task_name,
            getattr(request.user, "pk", None),
            backoff_seconds,
            workflow_id,
        )
        data = dict(FailedTaskSerializer(failed).data)
        data["workflow_id"] = workflow_id
        return Response(data)

    @extend_schema(
        request=FailedTaskDropSerializer,
        responses={200: FailedTaskSerializer},
        summary="Drop (dismiss) a dead-lettered task with an optional audit note",
    )
    @action(detail=True, methods=["post"], permission_classes=[IsAdminUser])
    def drop(self, request: Request, pk: str | None = None) -> Response:
        """Soft-remove a parked task (→ DISMISSED) with an optional audit note.

        The row is retained (not hard-deleted) so the note/operator/timestamp audit
        survives; it drops out of the operator's default ``dead``/``pending_retry``
        view. Re-dropping an already-dismissed task is an idempotent no-op.
        """
        failed = self.get_object()
        payload = FailedTaskDropSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        note = payload.validated_data["note"]

        if failed.status == FailedTaskStatus.DISMISSED:
            return Response(FailedTaskSerializer(failed).data)

        FailedTask.objects.filter(pk=failed.pk).update(
            status=FailedTaskStatus.DISMISSED,
            resolution_note=note,
            resolved_by=request.user,
            resolved_at=timezone.now(),
        )
        failed.refresh_from_db()
        logger.info(
            "dead-letter drop: task %s (%s) dropped by user %s%s",
            failed.id,
            failed.task_name,
            getattr(request.user, "pk", None),
            " with note" if note else "",
        )
        return Response(FailedTaskSerializer(failed).data)

    @extend_schema(
        request=FailedTaskRequeueSerializer,
        responses={200: OpenApiResponse(description="{processed, matched, capped}")},
        summary="Requeue every actionable task in the current filter set (bounded)",
    )
    @action(
        detail=False, methods=["post"], url_path="requeue_all", permission_classes=[IsAdminUser]
    )
    def requeue_all(self, request: Request) -> Response:
        """Bulk-requeue the current filter set, bounded (ADR-0210 §4).

        Applies the inspector's ``get_queryset`` filters, restricts to actionable
        (``dead``/``pending_retry``) tasks, and processes at most
        ``FAILED_TASK_BULK_ACTION_MAX`` (oldest-first). ``capped`` in the response
        signals that more remain and the operator should repeat.
        """
        payload = FailedTaskRequeueSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        backoff_seconds = payload.validated_data["backoff_seconds"]

        qs = self.get_queryset().filter(status__in=_ACTIONABLE_FAILED_STATUSES)
        matched = qs.count()
        batch = list(qs.order_by("last_failed_at")[:FAILED_TASK_BULK_ACTION_MAX])
        for failed in batch:
            self._start_requeue_workflow(failed, backoff_seconds)
        if batch:
            FailedTask.objects.filter(pk__in=[f.pk for f in batch]).update(
                status=FailedTaskStatus.RETRIED,
                resolved_by=request.user,
                resolved_at=timezone.now(),
            )
        logger.info(
            "dead-letter requeue_all: %d of %d task(s) requeued by user %s, backoff=%ss",
            len(batch),
            matched,
            getattr(request.user, "pk", None),
            backoff_seconds,
        )
        return Response(
            {
                "processed": len(batch),
                "matched": matched,
                "capped": matched > FAILED_TASK_BULK_ACTION_MAX,
            }
        )

    @extend_schema(
        request=FailedTaskDropSerializer,
        responses={200: OpenApiResponse(description="{processed, matched, capped}")},
        summary="Drop every task in the current filter set (bounded)",
    )
    @action(detail=False, methods=["post"], url_path="drop_all", permission_classes=[IsAdminUser])
    def drop_all(self, request: Request) -> Response:
        """Bulk-drop the current filter set, bounded (ADR-0210 §4).

        Applies the inspector's ``get_queryset`` filters, excludes already-dismissed
        rows, and dismisses at most ``FAILED_TASK_BULK_ACTION_MAX`` (oldest-first) in
        a single bounded ``UPDATE`` — no per-row loop. ``capped`` signals more remain.
        """
        payload = FailedTaskDropSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        note = payload.validated_data["note"]

        qs = self.get_queryset().exclude(status=FailedTaskStatus.DISMISSED)
        matched = qs.count()
        ids = list(
            qs.order_by("last_failed_at").values_list("pk", flat=True)[:FAILED_TASK_BULK_ACTION_MAX]
        )
        processed = 0
        if ids:
            processed = FailedTask.objects.filter(pk__in=ids).update(
                status=FailedTaskStatus.DISMISSED,
                resolution_note=note,
                resolved_by=request.user,
                resolved_at=timezone.now(),
            )
        logger.info(
            "dead-letter drop_all: %d of %d task(s) dropped by user %s",
            processed,
            matched,
            getattr(request.user, "pk", None),
        )
        return Response(
            {
                "processed": processed,
                "matched": matched,
                "capped": matched > FAILED_TASK_BULK_ACTION_MAX,
            }
        )


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
            # get_serializer injects request context so the serializer's ADR-0104
            # velocity gate fires on these action responses too (#949).
            return Response(self.get_serializer(suggestion).data)
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
        # get_serializer injects request context so the serializer's ADR-0104
        # velocity gate fires on these action responses too (#949).
        return Response(self.get_serializer(suggestion).data)

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
            # get_serializer injects request context so the serializer's ADR-0104
            # velocity gate fires on these action responses too (#949).
            return Response(self.get_serializer(suggestion).data)
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
        # get_serializer injects request context so the serializer's ADR-0104
        # velocity gate fires on these action responses too (#949).
        return Response(self.get_serializer(suggestion).data)


# ---------------------------------------------------------------------------
# Schedule value derivation (ADR-0218, #1058)
# ---------------------------------------------------------------------------

# The CPM quantities the derivation endpoint can explain. Mirrors
# trueppm_scheduler.Quantity so the API contract and the engine cannot drift.
_CPM_DERIVATION_QUANTITIES = frozenset(
    {
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float",
        "free_float",
    }
)
# The Monte Carlo percentile quantities, whose derivation is the risk premium over
# the deterministic CPM finish plus the ADR-0140 sensitivity drivers (#987).
_MC_DERIVATION_QUANTITIES = frozenset({"p50", "p80", "p95"})


def _build_cpm_sched_project(project: Project, pk: str) -> Any:
    """Assemble the scheduler ``Project`` for a deterministic CPM derivation run.

    Mirrors the input construction of :func:`run_monte_carlo` exactly — the same
    shared converters (``compose_project_calendar`` / ``build_sched_tasks``), the same
    committed-only task set, the same cross-project/non-committed edge drop, and the
    same data-date and velocity inputs — so the schedule the derivation explains is
    the *same* schedule the forecast is anchored on. Keeping one construction path
    is what stops the derivation from explaining a different network than the one
    the engine actually scheduled.
    """
    from trueppm_scheduler.models import Dependency as SchedDependency
    from trueppm_scheduler.models import DependencyType as SchedDependencyType
    from trueppm_scheduler.models import Project as SchedProject

    from trueppm_api.apps.projects.services import scheduler_velocity_inputs

    sched_calendar = compose_project_calendar(project)
    db_tasks = list(Task.committed.filter(project=project).select_related("sprint"))
    suggest_approve = project.estimation_mode == EstimationMode.SUGGEST_APPROVE
    sched_tasks = build_sched_tasks(db_tasks, suggest_approve=suggest_approve)

    included_ids = {str(t.id) for t in db_tasks}
    db_deps = list(
        Dependency.objects.filter(predecessor__project_id=pk).select_related(
            "predecessor", "successor"
        )
    )
    sched_deps = [
        SchedDependency(
            predecessor_id=str(d.predecessor_id),
            successor_id=str(d.successor_id),
            dep_type=SchedDependencyType(d.dep_type),
            lag=timedelta(days=d.lag),
        )
        for d in db_deps
        if str(d.predecessor_id) in included_ids and str(d.successor_id) in included_ids
    ]

    velocity_samples, sprint_length_days = scheduler_velocity_inputs(
        project.pk, sched_calendar.working_days
    )

    return SchedProject(
        id=str(project.pk),
        name=project.name,
        start_date=project.start_date,
        tasks=sched_tasks,
        dependencies=sched_deps,
        calendar=sched_calendar,
        status_date=project.status_date or timezone.localdate(),
        velocity_samples=velocity_samples or None,
        sprint_length_days=sprint_length_days,
    )


class ScheduleDerivationView(McpReadableViewMixin, APIView):
    """The server-computed *why* behind a computed schedule value (ADR-0218, #1058).

    ``GET /projects/<pk>/schedule/derivation/?task_id=<id>&quantity=<quantity>``

    Returns the derivation of a single computed value — the driving predecessor/
    successor chain, the binding constraint, each term's lag and calendar-snap
    contribution, and which CPM pass (forward/backward/float) set it. The
    derivation is computed server-side from the engine's own pass data by
    :func:`trueppm_scheduler.derive_value`; it is never recomputed in the browser
    and nothing is fabricated (rule 120) — a contribution is emitted only for a
    constraint the engine actually evaluates.

    For a Monte Carlo percentile quantity (``p50``/``p80``/``p95``) the "why" is
    the deterministic ``cpm_finish``, the signed ``delta_vs_cpm`` risk premium, and
    the ADR-0140 sensitivity drivers of the latest persisted run (#987) — the
    existing engine output surfaced honestly, not a second recomputation.

    RBAC: any project member (Viewer+) may read a derivation; ``McpReadableViewMixin``
    additionally exposes it to an ``mcp:read`` API token confined to safe methods,
    so an AI/MCP agent can cite the *why* alongside the value.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        operation_id="project_schedule_derivation",
        summary="Derivation (the why) of a computed schedule value",
        parameters=[
            OpenApiParameter(
                name="task_id",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=True,
                description="The task whose computed value is being explained.",
            ),
            OpenApiParameter(
                name="quantity",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=True,
                description=(
                    "Which computed value to explain: a CPM quantity "
                    "(early_start, early_finish, late_start, late_finish, "
                    "total_float, free_float) or a Monte Carlo percentile "
                    "(p50, p80, p95). CPM quantities return {task_id, task_name, "
                    "quantity, value, pass, is_critical, binding, contributions[]}, "
                    "each contribution carrying its source task, dep_type, lag_days, "
                    "imposed_date, calendar_days_added, slack_days, and is_binding. "
                    "Percentiles return {quantity, value, cpm_finish, "
                    "delta_vs_cpm_days, drivers[]} from the latest simulation."
                ),
            ),
        ],
        responses={
            200: OpenApiResponse(description="The derivation of the requested value."),
            400: OpenApiResponse(
                description="Missing/unknown quantity, or invalid schedule input."
            ),
            404: OpenApiResponse(
                description="Unknown project or task, or no simulation available."
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_scheduler.derive import UnknownTaskError, derive_value
        from trueppm_scheduler.engine import CyclicDependencyError

        quantity = request.query_params.get("quantity")
        if not quantity:
            return Response(
                {"detail": "The 'quantity' query parameter is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if quantity not in _CPM_DERIVATION_QUANTITIES and quantity not in _MC_DERIVATION_QUANTITIES:
            allowed = ", ".join(sorted(_CPM_DERIVATION_QUANTITIES | _MC_DERIVATION_QUANTITIES))
            return Response(
                {"detail": f"Unknown quantity {quantity!r}; must be one of: {allowed}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        project = get_object_or_404(
            Project.objects.select_related("calendar").prefetch_related(
                "tasks", "calendar__exceptions", "calendar_layers__calendar__exceptions"
            ),
            pk=pk,
            is_deleted=False,
        )
        # 404 (not 403) for a non-member: the object-scope oracle keeps a project's
        # existence from leaking to a non-member (mirrors MonteCarloLatestView).
        self.check_object_permissions(request, project)

        if quantity in _MC_DERIVATION_QUANTITIES:
            return self._monte_carlo_derivation(pk, quantity)

        task_id = request.query_params.get("task_id")
        if not task_id:
            return Response(
                {"detail": "The 'task_id' query parameter is required for a CPM quantity."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sched_project = _build_cpm_sched_project(project, pk)
        if not sched_project.tasks:
            return Response(
                {"detail": "Project has no committed tasks to schedule."},
                status=status.HTTP_404_NOT_FOUND,
            )
        try:
            derivation = derive_value(sched_project, task_id, quantity)
        except UnknownTaskError:
            return Response(
                {"detail": f"Task {task_id!r} is not in the scheduled network."},
                status=status.HTTP_404_NOT_FOUND,
            )
        except (CyclicDependencyError, ValueError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except OverflowError:
            return Response(
                {"detail": "Project schedule exceeds the representable date range."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(derivation.to_dict())

    def _monte_carlo_derivation(self, pk: str, quantity: str) -> Response:
        """Derive a Monte Carlo percentile from the latest persisted run (#987).

        The percentile's "why" is the deterministic ``cpm_finish`` it is measured
        against, the signed ``delta_vs_cpm`` days of risk premium, and the ADR-0140
        sensitivity drivers (the tasks whose duration most moves the finish). All
        three are already computed and persisted on the run — this surfaces them,
        it does not recompute the forecast.
        """
        latest = MonteCarloRun.objects.filter(project_id=pk).order_by("-taken_at").first()
        if latest is None:
            return Response(
                {"detail": "No simulation result available; run a Monte Carlo forecast first."},
                status=status.HTTP_404_NOT_FOUND,
            )
        percentile_date = {"p50": latest.p50, "p80": latest.p80, "p95": latest.p95}[quantity]
        dist = latest.distribution or {}
        return Response(
            {
                "quantity": quantity,
                "value": percentile_date.isoformat() if percentile_date else None,
                "pass": "monte_carlo",
                "cpm_finish": latest.cpm_finish.isoformat() if latest.cpm_finish else None,
                "delta_vs_cpm_days": _delta_vs_cpm_days(percentile_date, latest.cpm_finish),
                # ADR-0140 tornado: the tasks whose duration variance drives the
                # finish — the honest "why" behind a probabilistic date.
                "drivers": dist.get("sensitivity", []),
                "runs": latest.n_simulations,
                "last_run_at": latest.taken_at.isoformat(),
            }
        )
