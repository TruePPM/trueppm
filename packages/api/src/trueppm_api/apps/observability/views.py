"""Health endpoints for Beat liveness + dead-letter observability (ADR-0081, ADR-0084)."""

from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.db.models import Count
from django.http import HttpResponse
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.observability.models import BeatHeartbeat, PurgeRun
from trueppm_api.apps.observability.selectors import get_readiness, get_system_health
from trueppm_api.apps.observability.serializers import (
    PurgeRunQueuedSerializer,
    PurgeRunRequestSerializer,
    RetentionImpactQuerySerializer,
    RetentionImpactSerializer,
    RetentionStateSerializer,
    RetentionUpdateSerializer,
)
from trueppm_api.apps.observability.services import (
    apply_retention_update,
    compute_impact,
    get_retention_state,
    start_purge_run,
)
from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus

# Matches trueppm_api.apps.observability.tasks._SINGLETON_KEY — the single row.
_SINGLETON_KEY = 1

# Prometheus 0.0.4 text exposition content type. Hard-coded rather than importing
# prometheus_client — no metrics client is a dependency (ADR-0084).
_PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

_DEAD_LETTER_METRIC = "trueppm_task_dead_letter_parked"


def _escape_label_value(value: str) -> str:
    """Escape a Prometheus label value (backslash, double-quote, newline)."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


@extend_schema(
    summary="Readiness probe (dependency-aware)",
    description=(
        'Returns **200** with `{"status": "ok", "checks": {...}}` only when every '
        "hard dependency answers a live round-trip: the primary database (a bounded "
        "`SELECT 1`) and the Valkey/Redis cache (a write-then-read). Returns **503** "
        "with the failing dependency marked `fail` otherwise. Unlike the shallow "
        "`/api/v1/health/` liveness probe — which always returns 200 while the process "
        "is up — this endpoint gates a pod out of the Service's endpoints when its "
        "database or cache is dead. No authentication required, so kubelet can call it; "
        "the body carries only coarse `ok`/`fail` per dependency and never any "
        "connection string, host, or driver error text."
    ),
    responses={
        200: inline_serializer(
            "ReadyzResponse",
            {
                "status": serializers.CharField(),
                "checks": serializers.DictField(child=serializers.CharField()),
            },
        ),
        503: OpenApiResponse(description="One or more dependencies are unavailable."),
    },
    auth=[],
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([AllowAny])
def readyz(_request: Request) -> Response:
    """Report dependency-aware readiness for Kubernetes readiness/startup probes.

    Deliberately unauthenticated: kubelet issues probe requests with no
    credentials, and the dependency-aware ``/health/system/`` endpoint is
    ``IsAdminUser``-gated so it cannot serve as a probe (#1894). Safe to expose
    because the response is coarse — ``ok``/``fail`` per dependency with no
    infrastructure detail — and the probes themselves are read-only round-trips.
    """
    ready, checks = get_readiness()
    return Response(
        {"status": "ok" if ready else "fail", "checks": checks},
        status=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE,
    )


@extend_schema(
    summary="Celery Beat heartbeat status",
    description=(
        "Returns the last recorded Celery Beat heartbeat and whether it is stale "
        "(older than TRUEPPM_BEAT_STALE_SECONDS). Responds **200** when fresh and "
        "**503** when stale or never recorded, so status-code-driven monitoring "
        "(e.g. Prometheus with a bearer token) can alert without parsing the body. "
        "Requires a staff (admin) account — it exposes operational state. Basic "
        "unauthenticated liveness lives at `/api/v1/health/`."
    ),
    responses={
        200: inline_serializer(
            "BeatHealthResponse",
            {
                "last_heartbeat": serializers.DateTimeField(allow_null=True),
                "stale": serializers.BooleanField(),
            },
        ),
        503: OpenApiResponse(description="Heartbeat is stale or has never been recorded."),
    },
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([IsAdminUser])
def beat_health(_request: Request) -> Response:
    """Report Beat liveness for admin diagnostics and token-auth monitoring.

    Staleness is computed on read so the endpoint works precisely when Beat and
    the workers are down — the one detector that survives total task-infra death.
    """
    row = BeatHeartbeat.objects.filter(singleton_key=_SINGLETON_KEY).first()
    if row is None:
        return Response(
            {"last_heartbeat": None, "stale": True},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    age_seconds = (timezone.now() - row.last_heartbeat).total_seconds()
    stale = age_seconds > settings.TRUEPPM_BEAT_STALE_SECONDS
    return Response(
        {"last_heartbeat": row.last_heartbeat, "stale": stale},
        status=status.HTTP_503_SERVICE_UNAVAILABLE if stale else status.HTTP_200_OK,
    )


@extend_schema(
    summary="Dead-letter parked-task metrics (Prometheus)",
    description=(
        "Prometheus 0.0.4 text exposition of permanently dead-lettered Celery "
        "tasks currently awaiting operator action, labelled by `task_name`. "
        "Derived on read from the `FailedTask` table — no metrics client or "
        "scrape agent runs in-process (ADR-0084). A gauge, not a counter: the "
        "value falls when a task is dismissed, retried, or purged. Requires a "
        "staff (admin) account; scrape with a bearer token. The OSS receiver "
        "also emits a structured WARNING log line per new dead-letter, so "
        "log-based alerting works without scraping this endpoint."
    ),
    responses={
        200: OpenApiResponse(description="Prometheus text-format dead-letter gauge."),
    },
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([IsAdminUser])
def dead_letter_metrics(_request: Request) -> HttpResponse:
    """Expose the parked dead-letter gauge in Prometheus text format.

    Cross-process correct: the count is read from committed `FailedTask` rows,
    so it reflects dead-letters recorded by the Celery worker even though this
    endpoint is served by the web process (an in-process counter would not).
    """
    rows = (
        FailedTask.objects.filter(status=FailedTaskStatus.DEAD)
        .values("task_name")
        .annotate(n=Count("id"))
        .order_by("task_name")
    )

    lines = [
        f"# HELP {_DEAD_LETTER_METRIC} Permanently dead-lettered Celery tasks "
        "currently awaiting operator action, by task name.",
        f"# TYPE {_DEAD_LETTER_METRIC} gauge",
    ]
    for row in rows:
        label = _escape_label_value(row["task_name"])
        lines.append(f'{_DEAD_LETTER_METRIC}{{task_name="{label}"}} {row["n"]}')

    body = "\n".join(lines) + "\n"
    return HttpResponse(body, content_type=_PROMETHEUS_CONTENT_TYPE)


@extend_schema(
    summary="System health overview (operator dashboard)",
    description=(
        "Aggregated, read-only snapshot of the durable-execution layer for the "
        "workspace-admin System Health dashboard (#692, ADR-0172): five component "
        "status cards (outbox dispatcher, Celery Beat, dead-letter alerting, "
        "notification dispatcher, retention purge), the Beat heartbeat panel and "
        "configured schedule, a dead-letter summary, and the read-only retention "
        "configuration. Composes existing committed state — no payloads or task "
        "arguments are exposed here. Always responds 200 with statuses in the body "
        "(unlike `/health/beat/`, which is a 200/503 probe). Requires a staff "
        "(admin) account."
    ),
    responses={
        200: inline_serializer(
            "SystemHealthResponse",
            {
                "generated_at": serializers.DateTimeField(),
                "components": serializers.ListField(child=serializers.DictField()),
                "beat": serializers.DictField(),
                "scheduled_tasks": serializers.ListField(child=serializers.DictField()),
                "dead_letter": serializers.DictField(),
                "retention": serializers.ListField(child=serializers.DictField()),
            },
        ),
    },
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([IsAdminUser])
def system_health(_request: Request) -> Response:
    """Return the aggregated System Health overview payload.

    All figures are read from committed rows, so they reflect work done by the
    Celery worker and Beat processes even though this is served by the web
    process. Safe to poll on the dashboard's 10 s refresh — see
    ``observability.selectors.get_system_health`` for the query budget.
    """
    return Response(get_system_health())


@extend_schema(
    methods=["GET"],
    summary="Retention policy editor state",
    description=(
        "Returns the editable retention policy for the six operational tables "
        "(event history, task runs, webhook deliveries, import requests, sync "
        "batches, soft-deleted projects) with estimated row counts and sizes, the "
        "purge schedule, and the "
        "seven most recent purge runs. Row counts and sizes are PostgreSQL "
        "estimates. Workspace operators tune these from Settings → System health → "
        "Retention & purge (ADR-0173). Requires a staff (admin) account."
    ),
    responses={200: RetentionStateSerializer},
    tags=["meta"],
)
@extend_schema(
    methods=["PATCH"],
    summary="Update retention policy and schedule",
    description=(
        "Persist retention-window overrides and/or the purge schedule, then return "
        "the refreshed editor state. Lowering a window makes more data purge-eligible "
        "on the next run — irreversible. Requires a staff (admin) account."
    ),
    request=RetentionUpdateSerializer,
    responses={200: RetentionStateSerializer},
    tags=["meta"],
)
@api_view(["GET", "PATCH"])
@permission_classes([IsAdminUser])
def retention_settings(request: Request) -> Response:
    """Read or update the retention policy + schedule (ADR-0173 §G).

    Overrides layer over the ADR-0081 settings defaults — an absent override means
    the deployment's configured default is used, so behaviour is unchanged until an
    operator saves a value here.
    """
    if request.method == "PATCH":
        serializer = RetentionUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        apply_retention_update(serializer.validated_data)

    return Response(RetentionStateSerializer(get_retention_state()).data)


@extend_schema(
    summary="Estimate purge impact at a proposed retention window",
    description=(
        "Returns how many rows (and best-effort bytes) would become purge-eligible "
        "for `key` at the proposed `value` (its native unit — days, or hours for sync "
        "batches). A pure count: nothing is deleted. Backs the dirty-state "
        "irreversibility warning when an operator lowers a window. Requires a staff "
        "(admin) account."
    ),
    parameters=[RetentionImpactQuerySerializer],
    responses={200: RetentionImpactSerializer},
    tags=["meta"],
)
@api_view(["GET"])
@permission_classes([IsAdminUser])
def retention_impact(request: Request) -> Response:
    """Count rows that would become purge-eligible at a proposed window."""
    query = RetentionImpactQuerySerializer(data=request.query_params)
    query.is_valid(raise_exception=True)
    rows, eligible_bytes = compute_impact(
        query.validated_data["key"], query.validated_data["value"]
    )
    return Response({"eligible_rows": rows, "eligible_bytes": eligible_bytes})


@extend_schema(
    summary="Run a purge now (or dry-run)",
    description=(
        "Dispatch the retention purge coordinator across all six operational tables. "
        "`dry_run=true` counts eligible rows without deleting. Best-effort dispatch: "
        "returns 202 with the new run's id; the run completes asynchronously and "
        "appears in the recent-runs log. Requires a staff (admin) account."
    ),
    request=PurgeRunRequestSerializer,
    responses={202: PurgeRunQueuedSerializer},
    tags=["meta"],
)
@api_view(["POST"])
@permission_classes([IsAdminUser])
def retention_runs(request: Request) -> Response:
    """Queue a manual purge or dry-run; returns 202 with the run id (ADR-0173 §G).

    Rejects with 409 when a run started within the coordinator's lock window is
    still in progress — an end-to-end single-flight guard on top of the worker-side
    Redis lock, so a rapid double-click can't mint duplicate runs. The window bound
    (not "any RUNNING row") prevents a worker that died mid-run from blocking all
    future runs with a permanently-RUNNING orphan.
    """
    in_flight_cutoff = timezone.now() - timedelta(seconds=settings.RETENTION_PURGE_INFLIGHT_SECONDS)
    if PurgeRun.objects.filter(
        state=PurgeRun.State.RUNNING, started_at__gte=in_flight_cutoff
    ).exists():
        return Response(
            {"detail": "A purge run is already in progress."},
            status=status.HTTP_409_CONFLICT,
        )

    serializer = PurgeRunRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    run = start_purge_run(dry_run=serializer.validated_data["dry_run"])
    return Response(
        {"queued": True, "run_id": str(run.id)},
        status=status.HTTP_202_ACCEPTED,
    )
