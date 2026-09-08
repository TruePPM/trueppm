"""Views for the object change history API."""

from __future__ import annotations

import functools
import logging
from typing import Any

from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers as drf_serializers
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import IsProjectMember
from trueppm_api.apps.history import changelog
from trueppm_api.apps.history.diff_policy import (
    HISTORY_DIFF_NOISE,
    is_compared,
    visible_changes,
)
from trueppm_api.apps.history.serializers import (
    ChangelogResponseSerializer,
    HistoryRecordSerializer,
)
from trueppm_api.apps.projects.models import Project, Task

logger = logging.getLogger(__name__)

User = get_user_model()

# Which fields a diff compares, hides, and promotes is decided ONCE, in
# ``history.diff_policy`` — shared with the task drawer's pipeline in
# ``apps/projects/views.py`` (#3435). Do not add a local exclusion set here.


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


@functools.cache
def _compared_fields(model: Any, *, object_scoped: bool) -> tuple[Any, ...]:
    """The historical model's fields this pipeline compares (``diff_policy``).

    Keyed by model class, not record: every record in a batch shares one model (a
    per-object list is one model; the changelog diffs one model per source; the
    summary aggregates three single-model batches of up to ``_MAX_HISTORY_ROWS``),
    so re-filtering ~60 fields through the policy per row was pure repeat work.
    The set of historical models is small and static for the process lifetime.
    """
    return tuple(f for f in model._meta.fields if is_compared(f.name, object_scoped=object_scoped))


def _compute_diffs(
    records: list[Any],
    all_records: list[Any] | None = None,
    *,
    object_scoped: bool = True,
) -> dict[int, list[dict[str, Any]]]:
    """Return history_id → field-diff list for a batch of HistoricalRecords.

    Compares each record against its predecessor. Records with no visible change
    map to an empty list; the view omits those from the response so CPM-only
    mutations (or future excluded-field updates) don't produce noise. A change in
    ``HISTORY_DIFF_PROMOTED_WHEN_ALONE`` is kept only when it is the record's sole
    change (#3306) — the same rule the task drawer applies.

    Each row is keyed by the model **field name** (``assignee``), not the column
    (``assignee_id``): the client's one label map is keyed on names, and the drawer
    pipeline already emits them, so emitting columns here is what left the project
    Activity page rendering raw identifiers (#3435). Values are read through
    ``attname`` so a relation yields its id rather than a lazy fetch per row.

    ``object_scoped`` says whether the caller renders ONE object's own history
    (``True``: the per-object list views, where the object's tombstone flag is not a
    field change worth a row) or a cross-object stream (``False``: the project
    changelog, where that flag is the only record a soft delete left).

    Pass all_records (the full unpaginated list for the same object) so that
    the first record on a page can find its predecessor even when it sits on
    a different page.
    """
    prev_map = _build_prev_map(all_records if all_records is not None else records)
    result: dict[int, list[dict[str, Any]]] = {}
    for record in records:
        prev = prev_map.get(record.history_id)
        model: Any = type(record)
        fields = _compared_fields(model, object_scoped=object_scoped)
        if prev is None:
            # Creation — list non-null fields as old=None → new=value. Promotion is
            # a rule about updates, so promotable noise is dropped here outright.
            changes: list[dict[str, Any]] = [
                {"field": f.name, "old": None, "new": getattr(record, f.attname)}
                for f in fields
                if f.name not in HISTORY_DIFF_NOISE and getattr(record, f.attname) is not None
            ]
        else:
            changes = visible_changes(
                (
                    {
                        "field": f.name,
                        "old": getattr(prev, f.attname),
                        "new": getattr(record, f.attname),
                    }
                    for f in fields
                    if getattr(record, f.attname) != getattr(prev, f.attname)
                ),
                lambda change: str(change["field"]),
            )
        result[record.history_id] = changes
    return result


def _count_field_changes(records: list[Any]) -> dict[str, int]:
    """Count changed tracked fields across a batch of HistoricalRecords.

    Records may span multiple original objects (e.g. all tasks in a project).
    Groups by original PK and pairs by history_date to avoid prev_record queries.
    Keyed by field name like the diffs, and counts exactly the fields a routine
    diff row would show — promotable noise is not tallied, because a count is not a
    record of a single write and has nothing to rescue.
    """
    prev_map = _build_prev_map(records)
    counts: dict[str, int] = {}
    for record in records:
        prev = prev_map.get(record.history_id)
        if prev is None:
            continue
        model: Any = type(record)
        for f in _compared_fields(model, object_scoped=False):
            if f.name in HISTORY_DIFF_NOISE:
                continue
            if getattr(record, f.attname) != getattr(prev, f.attname):
                counts[f.name] = counts.get(f.name, 0) + 1
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
# per-project history list views. Without this cap a task with thousands of
# edits (a busy automated integration, or a re-import loop) would load the full
# history table into Python on every page request.
#
# NOTE(#1889): this cap intentionally differs from the projects app's
# ``apps.projects.views._MAX_HISTORY_ROWS`` (2000), which backs the wired
# ``/projects/<pk>/tasks/<pk>/history/`` route serving the task drawer.
# ``TaskHistoryListView`` below is deliberately unwired (see this app's
# ``urls.py``); the 5000 bound here covers the project-wide list view. Do not
# "sync" the two numbers; cross-reference comments live at both constants.
#
# NOTE(#3372): this constant previously was also shared with
# ``ProjectHistorySummaryView``, an orphaned endpoint (zero client consumers
# since it shipped in 0.1) removed outright rather than deprecated — see
# ADR-0011's dated Superseded note and stability.md step 3. That class carried
# its own identical-value class attribute of the same name, which is gone now
# too; nothing here refers to it any longer.
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
        page: list[Any] = paginator.paginate_queryset(records, request, view=self) or records

        # Pass the untrimmed cap+1 batch (#1889): when the cap was hit, the extra row
        # serves purely as the diff seed for the oldest kept record — otherwise that
        # record has no predecessor in the batch, gets an empty diff, and is dropped
        # from `visible` below. The seed row itself is never paginated or rendered.
        diffs = _compute_diffs(page, all_records=raw)
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

    @extend_schema(
        # Same class of defect as #2583's two named instances: a plain APIView that
        # builds its paginator inline is invisible to drf-spectacular's auto-wrap
        # heuristic, and with no annotation at all the operation shipped a 200 with
        # no response content whatsoever — a generated SDK gets an untyped body for
        # a paginated endpoint. Declare the envelope, including the non-standard
        # ``count_truncated`` flag the handler grafts onto it below.
        responses={
            200: inline_serializer(
                name="ProjectHistoryPage",
                fields={
                    "count": drf_serializers.IntegerField(),
                    "next": drf_serializers.URLField(allow_null=True),
                    "previous": drf_serializers.URLField(allow_null=True),
                    "results": HistoryRecordSerializer(many=True),
                    "count_truncated": drf_serializers.BooleanField(),
                },
            )
        },
    )
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
        page: list[Any] = paginator.paginate_queryset(records, request, view=self) or records

        # Pass the untrimmed cap+1 batch (#1889): when the cap was hit, the extra row
        # serves purely as the diff seed for the oldest kept record — otherwise that
        # record has no predecessor in the batch, gets an empty diff, and is dropped
        # from `visible` below. The seed row itself is never paginated or rendered.
        diffs = _compute_diffs(page, all_records=raw)
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


class ProjectChangelogView(APIView):
    """Unified newest-first "what changed" stream for a whole project (ADR-0201).

    GET /api/v1/projects/{project_pk}/changelog/
        ?since=&object_type=&change_type=&user=&cursor=&page_size=

    Aggregates every project-scoped ``django-simple-history`` table (Task, Sprint,
    Risk, Project, Dependency, TaskRecurrenceRule, and the three policy singletons)
    into one stream with a **stable keyset cursor** — pass the response's
    ``next_cursor`` back as ``cursor`` to page. The cursor is opaque and safe to
    persist; a malformed cursor returns 400.

    Permissions: any project member (Viewer+) may read (see ADR-0201 — every
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
            diff_fn=functools.partial(_compute_diffs, object_scoped=False),
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
