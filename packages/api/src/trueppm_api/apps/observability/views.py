"""Health endpoints for Beat liveness observability (ADR-0081)."""

from __future__ import annotations

from django.conf import settings
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAdminUser
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.observability.models import BeatHeartbeat

# Matches trueppm_api.apps.observability.tasks._SINGLETON_KEY — the single row.
_SINGLETON_KEY = 1


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
