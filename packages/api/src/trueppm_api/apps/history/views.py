"""Views for the object change history API."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import IsProjectMember
from trueppm_api.apps.history.serializers import HistoryRecordSerializer
from trueppm_api.apps.projects.models import Dependency, Project, Task

logger = logging.getLogger(__name__)

User = get_user_model()

# Fields excluded from all diffs — CPM outputs, sync internals, and
# django-simple-history's own bookkeeping columns.
_DIFF_EXCLUDED = frozenset(
    [
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float",
        "free_float",
        "is_critical",
        "server_version",
        "deleted_version",
        "history_id",
        "history_date",
        "history_change_reason",
        "history_user",
        "history_type",
    ]
)

VALID_WINDOWS = {"1d": 1, "7d": 7, "30d": 30, "90d": 90}


class HistoryPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


def _compute_diffs(records: list[Any]) -> dict[int, list[dict[str, Any]]]:
    """Return history_id → field-diff list for a batch of HistoricalRecords.

    Compares each record against its predecessor. Records with no tracked-field
    changes map to an empty list; the view omits those from the response so
    CPM-only mutations (or future excluded-field updates) don't produce noise.
    """
    result: dict[int, list[dict[str, Any]]] = {}
    for record in records:
        prev = record.prev_record
        if prev is None:
            # Creation — list non-null fields as old=None → new=value.
            changes: list[dict[str, Any]] = [
                {"field": f.attname, "old": None, "new": getattr(record, f.attname)}
                for f in record._meta.fields
                if f.attname not in _DIFF_EXCLUDED and getattr(record, f.attname) is not None
            ]
        else:
            changes = [
                {
                    "field": f.attname,
                    "old": getattr(prev, f.attname),
                    "new": getattr(record, f.attname),
                }
                for f in record._meta.fields
                if f.attname not in _DIFF_EXCLUDED
                and getattr(record, f.attname) != getattr(prev, f.attname)
            ]
        result[record.history_id] = changes
    return result


def _count_field_changes(records: list[Any]) -> dict[str, int]:
    """Count changed tracked fields across a batch of HistoricalRecords."""
    counts: dict[str, int] = {}
    for record in records:
        prev = record.prev_record
        if prev is None:
            continue
        for f in record._meta.fields:
            if f.attname in _DIFF_EXCLUDED:
                continue
            if getattr(record, f.attname) != getattr(prev, f.attname):
                counts[f.attname] = counts.get(f.attname, 0) + 1
    return counts


def _caller_can_see_user(request: Request, project: Project) -> bool:
    """True if the caller holds Owner or Admin role (>= ADMIN = 3)."""
    try:
        m = ProjectMembership.objects.get(
            user=request.user,  # type: ignore[misc]
            project=project,
            is_deleted=False,
        )
        return m.role >= Role.ADMIN
    except ProjectMembership.DoesNotExist:
        return False


class TaskHistoryListView(APIView):
    """Paginated change history for a single task.

    GET /api/v1/projects/{project_pk}/tasks/{task_pk}/history/

    Permissions: any project member (Viewer+) may read. history_user details
    are visible only to Owner/Admin (role >= 3); lower-privilege callers
    receive null for that field.
    """

    permission_classes = [IsAuthenticated, IsProjectMember]

    def get(self, request: Request, project_pk: str, task_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)

        records: list[Any] = list(
            task.history.order_by("-history_date").select_related("history_user")
        )

        paginator = HistoryPagination()
        page: list[Any] = paginator.paginate_queryset(records, request, view=self) or records  # type: ignore[arg-type]

        diffs = _compute_diffs(page)
        hide_user = not _caller_can_see_user(request, project)
        visible = [r for r in page if diffs.get(r.history_id)]
        serializer = HistoryRecordSerializer(
            visible,
            many=True,
            context={"diffs": diffs, "hide_user": hide_user},
        )
        return paginator.get_paginated_response(serializer.data)


class ProjectHistoryListView(APIView):
    """Paginated change history for a project (project-level fields only).

    GET /api/v1/projects/{project_pk}/history/
    """

    permission_classes = [IsAuthenticated, IsProjectMember]

    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        records: list[Any] = list(
            project.history.order_by("-history_date").select_related("history_user")
        )

        paginator = HistoryPagination()
        page: list[Any] = paginator.paginate_queryset(records, request, view=self) or records  # type: ignore[arg-type]

        diffs = _compute_diffs(page)
        hide_user = not _caller_can_see_user(request, project)
        visible = [r for r in page if diffs.get(r.history_id)]
        serializer = HistoryRecordSerializer(
            visible,
            many=True,
            context={"diffs": diffs, "hide_user": hide_user},
        )
        return paginator.get_paginated_response(serializer.data)


class ProjectHistorySummaryView(APIView):
    """Aggregate mutation counts for a project over a time window.

    GET /api/v1/projects/{project_pk}/history/summary/?window=7d

    Supported windows: 1d, 7d (default), 30d, 90d.
    Response is cached in Redis for 5 minutes. Pass ``?refresh=1`` to bust
    the cache — the UI should call this when the user hits the refresh button.

    The ``generated_at`` field is an ISO-8601 timestamp the UI should display
    as "last updated X ago" so users know the freshness of the data.
    """

    permission_classes = [IsAuthenticated, IsProjectMember]
    _CACHE_TTL = 300  # 5 minutes

    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        window_str = request.query_params.get("window", "7d")
        if window_str not in VALID_WINDOWS:
            return Response(
                {
                    "detail": (
                        f"Invalid window '{window_str}'. Choose from: {', '.join(VALID_WINDOWS)}."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        force_refresh = request.query_params.get("refresh") == "1"
        cache_key = f"history_summary:{project_pk}:{window_str}"

        if not force_refresh:
            cached: dict[str, Any] | None = cache.get(cache_key)
            if cached is not None:
                return Response(cached)

        since = timezone.now() - timedelta(days=VALID_WINDOWS[window_str])

        task_records: list[Any] = list(
            Task.history.filter(project_id=project_pk, history_date__gte=since).select_related(
                "history_user"
            )
        )
        project_records: list[Any] = list(
            project.history.filter(history_date__gte=since).select_related("history_user")
        )
        dep_records: list[Any] = list(
            Dependency.history.filter(
                predecessor__project_id=project_pk, history_date__gte=since
            ).select_related("history_user")
        )

        field_counts: dict[str, int] = {}
        for batch in (task_records, project_records, dep_records):
            for field, count in _count_field_changes(batch).items():
                field_counts[field] = field_counts.get(field, 0) + count

        by_field: list[dict[str, Any]] = sorted(
            [{"field": f, "count": c} for f, c in field_counts.items()],
            key=lambda x: int(x["count"]),
            reverse=True,
        )

        payload: dict[str, Any] = {
            "project_id": str(project_pk),
            "window": window_str,
            "total_mutations": len(task_records) + len(project_records) + len(dep_records),
            "by_object_type": {
                "task": len(task_records),
                "project": len(project_records),
                "dependency": len(dep_records),
            },
            "by_field": by_field,
            "generated_at": timezone.now().isoformat(),
        }

        cache.set(cache_key, payload, self._CACHE_TTL)
        return Response(payload)
