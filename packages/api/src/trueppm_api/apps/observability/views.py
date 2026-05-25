"""Health endpoints for Beat liveness + dead-letter observability (ADR-0081, ADR-0084)."""

from __future__ import annotations

from django.conf import settings
from django.db.models import Count
from django.http import HttpResponse
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAdminUser
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.observability.models import BeatHeartbeat
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
