"""Views for the object change history API."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import IsProjectMember
from trueppm_api.apps.history import changelog
from trueppm_api.apps.history.serializers import (
    ChangelogResponseSerializer,
    HistoryRecordSerializer,
)
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
        # ADR-0124 reason-privacy (#1135): blocked_reason is contributor voice,
        # readable only by the assignee + @-mentioned via the gated TaskSerializer.
        # HistoricalTask carries it, so the team-readable history diff feed MUST
        # exclude it — otherwise any project member reads the reason (and every
        # past reason) through the History tab, bypassing the serializer gate. The
        # structured signal (blocker_type / blocked_since / blocked_by / blocking_task)
        # is team-shareable and may remain in the diff.
        "blocked_reason",
    ]
)

VALID_WINDOWS = {"1d": 1, "7d": 7, "30d": 30, "90d": 90}


class HistoryPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


def _build_prev_map(records: list[Any]) -> dict[int, Any | None]:
    """Return history_id → previous HistoricalRecord without extra DB queries.

    Groups records by their original-object PK, sorts each group by
    history_date ascending, and pairs adjacent records in Python. Avoids
    the per-record DB round-trip that record.prev_record triggers.
    """
    by_obj: dict[Any, list[Any]] = {}
    for r in records:
        by_obj.setdefault(r.id, []).append(r)
    prev_map: dict[int, Any | None] = {}
    for group in by_obj.values():
        group.sort(key=lambda r: r.history_date)
        for i, r in enumerate(group):
            prev_map[r.history_id] = group[i - 1] if i > 0 else None
    return prev_map


def _compute_diffs(
    records: list[Any], all_records: list[Any] | None = None
) -> dict[int, list[dict[str, Any]]]:
    """Return history_id → field-diff list for a batch of HistoricalRecords.

    Compares each record against its predecessor. Records with no tracked-field
    changes map to an empty list; the view omits those from the response so
    CPM-only mutations (or future excluded-field updates) don't produce noise.

    Pass all_records (the full unpaginated list for the same object) so that
    the first record on a page can find its predecessor even when it sits on
    a different page.
    """
    prev_map = _build_prev_map(all_records if all_records is not None else records)
    result: dict[int, list[dict[str, Any]]] = {}
    for record in records:
        prev = prev_map.get(record.history_id)
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
    """Count changed tracked fields across a batch of HistoricalRecords.

    Records may span multiple original objects (e.g. all tasks in a project).
    Groups by original PK and pairs by history_date to avoid prev_record queries.
    """
    prev_map = _build_prev_map(records)
    counts: dict[str, int] = {}
    for record in records:
        prev = prev_map.get(record.history_id)
        if prev is None:
            continue
        for f in record._meta.fields:
            if f.attname in _DIFF_EXCLUDED:
                continue
            if getattr(record, f.attname) != getattr(prev, f.attname):
                counts[f.attname] = counts.get(f.attname, 0) + 1
    return counts


def _caller_can_see_user(request: Request, project: Project) -> bool:
    """True if the caller holds Owner or Admin role (>= Role.ADMIN)."""
    try:
        m = ProjectMembership.objects.get(
            user=request.user,  # type: ignore[misc]
            project=project,
            is_deleted=False,
        )
        return m.role >= Role.ADMIN
    except ProjectMembership.DoesNotExist:
        return False


# Cap the number of history rows materialized in memory for the per-task and
# per-project history list views.  Without this cap a task with thousands of
# edits (a busy automated integration, or a re-import loop) would load the full
# history table into Python on every page request. Shared with
# ProjectHistorySummaryView's constant so both surfaces use the same bound.
_MAX_HISTORY_ROWS = 5000


class TaskHistoryListView(APIView):
    """Paginated change history for a single task.

    GET /api/v1/projects/{project_pk}/tasks/{task_pk}/history/

    Permissions: any project member (Viewer+) may read. history_user details
    are visible only to Owner/Admin (role >= Role.ADMIN); lower-privilege callers
    receive null for that field.

    At most ``_MAX_HISTORY_ROWS`` records are materialized; ``count_truncated``
    in the response is ``true`` when the cap was hit so the client can surface
    "showing recent activity" instead of implying a complete record.
    """

    # IsProjectNotArchived is deliberately omitted: history is a read-only audit
    # surface that must stay accessible after a project is archived. Do not add it
    # "for consistency" — archived projects still need their audit trail readable.
    permission_classes = [IsAuthenticated, IsProjectMember]

    def get(self, request: Request, project_pk: str, task_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)

        # Fetch cap+1 so we can detect truncation, then trim.
        raw: list[Any] = list(
            task.history.order_by("-history_date").select_related("history_user")[
                : _MAX_HISTORY_ROWS + 1
            ]
        )
        count_truncated = len(raw) > _MAX_HISTORY_ROWS
        records = raw[:_MAX_HISTORY_ROWS]

        paginator = HistoryPagination()
        page: list[Any] = paginator.paginate_queryset(records, request, view=self) or records  # type: ignore[arg-type]

        diffs = _compute_diffs(page, all_records=records)
        hide_user = not _caller_can_see_user(request, project)
        visible = [r for r in page if diffs.get(r.history_id)]
        serializer = HistoryRecordSerializer(
            visible,
            many=True,
            context={"diffs": diffs, "hide_user": hide_user},
        )
        response = paginator.get_paginated_response(serializer.data)
        response.data["count_truncated"] = count_truncated
        return response


class ProjectHistoryListView(APIView):
    """Paginated change history for a project (project-level fields only).

    GET /api/v1/projects/{project_pk}/history/

    At most ``_MAX_HISTORY_ROWS`` records are materialized; ``count_truncated``
    in the response is ``true`` when the cap was hit.
    """

    # IsProjectNotArchived is deliberately omitted: history is a read-only audit
    # surface that must stay accessible after a project is archived. Do not add it
    # "for consistency" — archived projects still need their audit trail readable.
    permission_classes = [IsAuthenticated, IsProjectMember]

    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        # Fetch cap+1 so we can detect truncation, then trim.
        raw: list[Any] = list(
            project.history.order_by("-history_date").select_related("history_user")[
                : _MAX_HISTORY_ROWS + 1
            ]
        )
        count_truncated = len(raw) > _MAX_HISTORY_ROWS
        records = raw[:_MAX_HISTORY_ROWS]

        paginator = HistoryPagination()
        page: list[Any] = paginator.paginate_queryset(records, request, view=self) or records  # type: ignore[arg-type]

        diffs = _compute_diffs(page, all_records=records)
        hide_user = not _caller_can_see_user(request, project)
        visible = [r for r in page if diffs.get(r.history_id)]
        serializer = HistoryRecordSerializer(
            visible,
            many=True,
            context={"diffs": diffs, "hide_user": hide_user},
        )
        response = paginator.get_paginated_response(serializer.data)
        response.data["count_truncated"] = count_truncated
        return response


class ProjectHistorySummaryView(APIView):
    """Aggregate mutation counts for a project over a time window.

    GET /api/v1/projects/{project_pk}/history/summary/?window=7d

    Supported windows: 1d, 7d (default), 30d, 90d.
    Response is cached in Redis for 5 minutes. Pass ``?refresh=1`` to bust
    the cache — the UI should call this when the user hits the refresh button.

    The ``generated_at`` field is an ISO-8601 timestamp the UI should display
    as "last updated X ago" so users know the freshness of the data.
    """

    # IsProjectNotArchived is deliberately omitted: history is a read-only audit
    # surface that must stay accessible after a project is archived. Do not add it
    # "for consistency" — archived projects still need their audit trail readable.
    permission_classes = [IsAuthenticated, IsProjectMember]
    _CACHE_TTL = 300  # 5 minutes
    # Cap the rows pulled into memory per object type. A 90-day window on a busy
    # project could otherwise load tens of thousands of history rows just to
    # aggregate field counts (#821). When a batch hits the cap the summary is
    # built from the most recent _MAX_HISTORY_ROWS and `count_truncated` is set so
    # the client can surface "showing recent activity" rather than implying totals.
    _MAX_HISTORY_ROWS = 5000

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

        cap = self._MAX_HISTORY_ROWS
        # Order by -history_date so a truncated batch keeps the most recent rows.
        task_records: list[Any] = list(
            Task.history.filter(project_id=project_pk, history_date__gte=since)
            .select_related("history_user")
            .order_by("-history_date")[: cap + 1]
        )
        project_records: list[Any] = list(
            project.history.filter(history_date__gte=since)
            .select_related("history_user")
            .order_by("-history_date")[: cap + 1]
        )
        dep_records: list[Any] = list(
            Dependency.history.filter(predecessor__project_id=project_pk, history_date__gte=since)
            .select_related("history_user")
            .order_by("-history_date")[: cap + 1]
        )

        # Fetch cap+1 to detect truncation, then trim back to cap for aggregation.
        count_truncated = any(len(b) > cap for b in (task_records, project_records, dep_records))
        task_records = task_records[:cap]
        project_records = project_records[:cap]
        dep_records = dep_records[:cap]

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
            "count_truncated": count_truncated,
            "generated_at": timezone.now().isoformat(),
        }

        cache.set(cache_key, payload, self._CACHE_TTL)
        return Response(payload)


class ProjectChangelogView(APIView):
    """Unified newest-first "what changed" stream for a whole project (ADR-0199).

    GET /api/v1/projects/{project_pk}/changelog/
        ?since=&object_type=&change_type=&user=&cursor=&page_size=

    Aggregates every project-scoped ``django-simple-history`` table (Task, Sprint,
    Risk, Project, Dependency, TaskRecurrenceRule, and the three policy singletons)
    into one stream with a **stable keyset cursor** — pass the response's
    ``next_cursor`` back as ``cursor`` to page. The cursor is opaque and safe to
    persist; a malformed cursor returns 400.

    Permissions: any project member (Viewer+) may read (see ADR-0199 — every
    source's live GET is Viewer+, so membership is a sufficient row gate).
    ``history_user`` is returned only to Owner/Admin (``role >= Role.ADMIN``); the
    ``user=`` filter is likewise honored only for those callers, so the feed can
    never be turned into a per-person activity tracker by a lower-privilege reader.

    Query params:
        since        ISO-8601 datetime; inclusive lower bound on the change time.
        object_type  Comma-separated source keys (task, sprint, risk, dependency,
                     project, task_recurrence, guardrail_policy,
                     signal_privacy_policy, decisions_policy). Default: all.
        change_type  Comma-separated: created, updated, deleted. Default: all.
        user         A history_user id (Owner/Admin only; ignored otherwise).
        cursor       Opaque keyset cursor from a prior response's ``next_cursor``.
        page_size    1..100 (default 50).
    """

    # IsProjectNotArchived is deliberately omitted: history is a read-only audit
    # surface that must stay accessible after a project is archived (matching the
    # per-object history views above).
    permission_classes = [IsAuthenticated, IsProjectMember]

    @extend_schema(
        summary="Unified project changelog (aggregated, filterable, cursor-paginated)",
        parameters=[
            OpenApiParameter(
                "since", str, description="Inclusive ISO-8601 lower bound on the change time."
            ),
            OpenApiParameter(
                "object_type",
                str,
                description=(
                    "Comma-separated source keys: "
                    f"{', '.join(changelog.object_type_choices())}. Default: all."
                ),
            ),
            OpenApiParameter(
                "change_type",
                str,
                description="Comma-separated change types: created, updated, deleted.",
            ),
            OpenApiParameter(
                "user", str, description="Filter to one history_user id (Owner/Admin only)."
            ),
            OpenApiParameter(
                "cursor",
                str,
                description=(
                    "Opaque keyset cursor from a prior response's next_cursor. "
                    "Stable across concurrent writes; persistable; 400 if malformed."
                ),
            ),
            OpenApiParameter("page_size", int, description="Page size (1..100, default 50)."),
        ],
        responses={200: OpenApiResponse(ChangelogResponseSerializer)},
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        since = self._parse_since(request.query_params.get("since"))
        object_types = self._parse_object_types(request.query_params.get("object_type"))
        change_types = self._parse_change_types(request.query_params.get("change_type"))
        page_size = self._parse_page_size(request.query_params.get("page_size"))

        cursor_raw = request.query_params.get("cursor")
        cursor = changelog.ChangelogCursor.decode(cursor_raw) if cursor_raw else None

        # history_user visibility gates both the field and the user= filter: only
        # Owner/Admin may see who made a change, so only they may filter by it.
        hide_user = not _caller_can_see_user(request, project)
        user_id = None if hide_user else self._parse_user(request.query_params.get("user"))

        entries, next_cursor = changelog.build_project_changelog(
            project,
            diff_fn=_compute_diffs,
            cursor=cursor,
            since=since,
            object_types=object_types,
            change_types=change_types,
            user_id=user_id,
            page_size=page_size,
        )

        serializer = ChangelogResponseSerializer(
            {
                "results": entries,
                "next_cursor": next_cursor.encode() if next_cursor is not None else None,
            },
            context={"hide_user": hide_user},
        )
        return Response(serializer.data)

    @staticmethod
    def _parse_user(raw: str | None) -> int | None:
        # The user model's PK is an integer AutoField, so a non-integer value must
        # yield a clean 400 rather than a 500 when the ORM casts it at query time.
        if not raw:
            return None
        try:
            return int(raw)
        except (TypeError, ValueError) as err:
            raise DRFValidationError({"user": "Must be a user id (integer)."}) from err

    @staticmethod
    def _parse_since(raw: str | None) -> Any:
        if not raw:
            return None
        parsed = parse_datetime(raw)
        if parsed is None:
            raise DRFValidationError({"since": f"Invalid datetime '{raw}' (expected ISO 8601)."})
        if timezone.is_naive(parsed):
            parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
        return parsed

    @staticmethod
    def _parse_object_types(raw: str | None) -> set[str] | None:
        if not raw:
            return None
        requested = {t.strip() for t in raw.split(",") if t.strip()}
        valid = set(changelog.object_type_choices())
        unknown = requested - valid
        if unknown:
            raise DRFValidationError(
                {"object_type": f"Unknown object type(s): {', '.join(sorted(unknown))}."}
            )
        return requested

    @staticmethod
    def _parse_change_types(raw: str | None) -> set[str] | None:
        if not raw:
            return None
        requested = {t.strip() for t in raw.split(",") if t.strip()}
        unknown = requested - changelog.CHANGE_TYPES
        if unknown:
            raise DRFValidationError(
                {"change_type": f"Unknown change type(s): {', '.join(sorted(unknown))}."}
            )
        return requested

    @staticmethod
    def _parse_page_size(raw: str | None) -> int:
        if not raw:
            return changelog.DEFAULT_PAGE_SIZE
        try:
            return int(raw)
        except (TypeError, ValueError) as err:
            raise DRFValidationError({"page_size": "Must be an integer."}) from err
