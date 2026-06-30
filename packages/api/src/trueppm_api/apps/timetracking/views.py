"""REST views for the time-tracking app (ADR-0185 §4).

Task-nested create/list, user-scoped (`/me/`) detail, weekly rollup, and the running
timer. Nothing here calls ``broadcast_board_event()`` — a time entry mutates no shared
board state (ADR-0185 §5), so the realtime board channel is deliberately untouched.

RBAC posture:
  * cross-project / nonexistent task → **404** (the task is resolved against a
    membership-scoped queryset, so existence is never leaked — IDOR-safe);
  * member-but-Viewer on an accessible task → **403** (``CanLogTime`` object check);
  * another user's entry → **404** (detail queryset is scoped to ``request.user``,
    so author-only edit/delete is an existence-oracle close, not a 403).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import CanLogTime
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.timetracking import services
from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry
from trueppm_api.apps.timetracking.serializers import (
    ActiveTimerSerializer,
    TimeEntrySerializer,
    TimeEntryWeeklySerializer,
    TimerStartSerializer,
)

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User


def _member_task_or_404(request: Request, task_pk: Any) -> Task:
    """Resolve a task scoped to projects the caller is an active member of.

    Returns the task or raises ``Http404`` — a non-member (cross-project IDOR) and a
    nonexistent task are indistinguishable to the caller (no existence oracle). A Viewer
    is a member, so the task resolves for them; the role gate (``CanLogTime``) then
    yields the 403, not this lookup.
    """
    user = cast("_User", request.user)
    qs = Task.objects.filter(
        pk=task_pk,
        is_deleted=False,
        project__is_deleted=False,
        project__memberships__user=user,
        project__memberships__is_deleted=False,
    ).select_related("project")
    return get_object_or_404(qs)


class TaskTimeEntryView(IdempotencyMixin, APIView):
    """``/api/v1/tasks/{task_pk}/time-entries/`` — create and list caller-scoped entries.

    POST creates an entry owned by ``request.user`` (server-set; the body can never
    spoof ``user``). GET returns the caller's **own** entries on the task plus their own
    ``total_logged_minutes`` — the cross-contributor rollup is Enterprise/#100 and is
    deliberately not exposed here (no surveillance surface, ADR-0185 §Consequences).

    Inherits :class:`IdempotencyMixin` (ADR-0170) so a create honours an
    ``Idempotency-Key`` and a retried POST never double-logs.
    """

    permission_classes = [IsAuthenticated, CanLogTime]

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "The caller's own time entries on this task plus their own "
                    "total: {results: [<entry>], total_logged_minutes: int}."
                ),
            )
        },
    )
    def get(self, request: Request, task_pk: str) -> Response:
        user = cast("_User", request.user)
        task = _member_task_or_404(request, task_pk)
        # Object-level read gate: any project member (Viewer+) may read their own
        # (possibly empty) entries; a non-member already 404'd above.
        self.check_object_permissions(request, task)
        entries = TimeEntry.objects.filter(task=task, user=user, is_deleted=False).order_by(
            "-entry_date", "-created_at"
        )
        total = (
            TimeEntry.objects.filter(task=task, user=user, is_deleted=False).aggregate(
                total=Sum("minutes")
            )["total"]
            or 0
        )
        return Response(
            {
                "results": TimeEntrySerializer(entries, many=True).data,
                "total_logged_minutes": int(total),
            }
        )

    @extend_schema(
        request=TimeEntrySerializer,
        responses={201: TimeEntrySerializer},
    )
    def post(self, request: Request, task_pk: str) -> Response:
        task = _member_task_or_404(request, task_pk)
        # Role gate: Member+ may log; Viewer is denied 403 (CanLogTime object check).
        self.check_object_permissions(request, task)
        serializer = TimeEntrySerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        entry = services.log_time(
            user=cast("_User", request.user),
            task=task,
            minutes=serializer.validated_data["minutes"],
            entry_date=serializer.validated_data.get("entry_date"),
            note=serializer.validated_data.get("note", ""),
        )
        return Response(
            TimeEntrySerializer(entry, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class MeTimeEntryDetailView(IdempotencyMixin, APIView):
    """``/api/v1/me/time-entries/{id}/`` — author-only PATCH / DELETE (ADR-0185 §4).

    The queryset is hard-scoped to ``user=request.user``, so PATCH or DELETE on another
    user's entry returns **404** (existence-oracle close, matches #996) — never 403.
    DELETE is a ``soft_delete`` so the undo toast and mobile sync tombstone both work.
    """

    permission_classes = [IsAuthenticated]

    def _own_entry_or_404(self, request: Request, pk: str) -> TimeEntry:
        user = cast("_User", request.user)
        qs = TimeEntry.objects.filter(user=user, is_deleted=False)
        return get_object_or_404(qs, pk=pk)

    @extend_schema(request=TimeEntrySerializer, responses={200: TimeEntrySerializer})
    def patch(self, request: Request, pk: str) -> Response:
        entry = self._own_entry_or_404(request, pk)
        serializer = TimeEntrySerializer(
            entry, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @extend_schema(responses={204: OpenApiResponse(description="Entry soft-deleted; empty body.")})
    def delete(self, request: Request, pk: str) -> Response:
        entry = self._own_entry_or_404(request, pk)
        entry.soft_delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _parse_iso_date(raw: str, field: str) -> date:
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except (ValueError, TypeError) as err:
        raise ValidationError({field: "Must be an ISO date (YYYY-MM-DD)."}) from err


class MeTimeEntryWeeklyView(APIView):
    """``/api/v1/me/time-entries/?from=&to=`` — weekly cross-project rollup (ADR-0185 §4).

    Drives both the #1435 grid and the #1234 header rollup. Returns the caller's entries
    in the window across **all accessible projects**, plus precomputed totals (by_day,
    by_cell, today, week). The membership re-check (defence-in-depth, mirrors
    ``/me/work``) drops entries on projects the user was removed from. ``select_related``
    on task→project keeps the read N+1-bounded (asserted by ``assertNumQueries``); the
    totals are folded from the already-fetched rows, adding no query.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter("from", OpenApiTypes.DATE, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("to", OpenApiTypes.DATE, OpenApiParameter.QUERY, required=False),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Caller's entries in [from, to] across accessible projects with "
                    "totals: {results: [<weekly entry>], totals: {by_day, by_cell, "
                    "today_minutes, week_minutes}}."
                ),
            )
        },
    )
    def get(self, request: Request) -> Response:
        user = cast("_User", request.user)
        from_raw = request.query_params.get("from")
        to_raw = request.query_params.get("to")
        if (from_raw is None) != (to_raw is None):
            raise ValidationError("Provide both 'from' and 'to', or neither.")
        if from_raw is None or to_raw is None:
            # Default to the current ISO week (Monday..Sunday).
            today = timezone.localdate()
            start = today - timedelta(days=today.weekday())
            end = start + timedelta(days=6)
        else:
            start = _parse_iso_date(from_raw, "from")
            end = _parse_iso_date(to_raw, "to")
        if start > end:
            raise ValidationError({"from": "'from' must be on or before 'to'."})

        entries = list(
            TimeEntry.objects.filter(
                user=user,
                is_deleted=False,
                entry_date__range=(start, end),
                task__project__memberships__user=user,
                task__project__memberships__is_deleted=False,
            )
            .select_related("task", "task__project")
            .order_by("entry_date", "created_at")
        )

        today = timezone.localdate()
        by_day: dict[str, int] = {}
        by_cell: dict[str, int] = {}
        today_minutes = 0
        week_minutes = 0
        for e in entries:
            iso = e.entry_date.isoformat()
            by_day[iso] = by_day.get(iso, 0) + e.minutes
            cell = f"{e.task_id}|{iso}"
            by_cell[cell] = by_cell.get(cell, 0) + e.minutes
            week_minutes += e.minutes
            if e.entry_date == today:
                today_minutes += e.minutes

        return Response(
            {
                "results": TimeEntryWeeklySerializer(entries, many=True).data,
                "totals": {
                    "by_day": by_day,
                    "by_cell": by_cell,
                    "today_minutes": today_minutes,
                    "week_minutes": week_minutes,
                },
            }
        )


class MeTimerView(APIView):
    """``GET /api/v1/me/timer/`` — the caller's running timer, reconcile-on-load (ADR-0185 §4).

    Returns ``{active: false}`` or the live timer with server-computed
    ``elapsed_seconds`` / ``stale``. Multi-device continuity is handled here (refetch on
    focus, ``started_at`` as the authoritative clock) — not by a broadcast (ADR-0185 §5).
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)})
    def get(self, request: Request) -> Response:
        user = cast("_User", request.user)
        timer = (
            ActiveTimer.objects.filter(user=user).select_related("task", "task__project").first()
        )
        if timer is None:
            return Response({"active": False})
        data = {"active": True, **ActiveTimerSerializer(timer).data}
        return Response(data)


class MeTimerStartView(IdempotencyMixin, APIView):
    """``POST /api/v1/me/timer/start`` — start (or restart) the caller's timer (ADR-0185 §4).

    Second-start: if a timer is already running it is atomically stopped and logged, and
    that finalized entry rides back in ``finalized_entry`` for the undo toast. The task
    is resolved membership-scoped (404 for cross-project) and gated by ``can_log_time``
    (403 for a Viewer).
    """

    permission_classes = [IsAuthenticated, CanLogTime]

    @extend_schema(
        request=TimerStartSerializer,
        responses={201: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    def post(self, request: Request) -> Response:
        body = TimerStartSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        task = _member_task_or_404(request, body.validated_data["task"])
        self.check_object_permissions(request, task)
        timer, finalized = services.start_timer(
            user=cast("_User", request.user),
            task=task,
            note=body.validated_data.get("note", ""),
        )
        return Response(
            {
                "active_timer": ActiveTimerSerializer(timer).data,
                "finalized_entry": (
                    TimeEntrySerializer(finalized, context={"request": request}).data
                    if finalized is not None
                    else None
                ),
            },
            status=status.HTTP_201_CREATED,
        )


class MeTimerStopView(IdempotencyMixin, APIView):
    """``POST /api/v1/me/timer/stop`` — finalize the caller's running timer (ADR-0185 §4).

    Returns the created ``TimeEntry`` (``source="timer"``). Naturally idempotent without a
    key — a second stop finds no timer and returns ``409`` rather than a 500 or a
    double-log — and carries :class:`IdempotencyMixin` (matching ``MeTimerStartView``) so a
    keyed retry replays the original ``201`` instead of racing into that 409.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={201: TimeEntrySerializer, 409: OpenApiTypes.OBJECT})
    def post(self, request: Request) -> Response:
        entry = services.stop_timer(user=cast("_User", request.user))
        if entry is None:
            return Response({"detail": "No active timer to stop."}, status=status.HTTP_409_CONFLICT)
        return Response(
            TimeEntrySerializer(entry, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )
