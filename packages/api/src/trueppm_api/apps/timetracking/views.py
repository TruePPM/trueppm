"""REST views for the time-tracking app (ADR-0185 §4).

Task-nested create/list, user-scoped (`/me/`) detail, weekly rollup, and the running
timer. Nothing here calls ``broadcast_board_event()`` — a time entry mutates no shared
board state (ADR-0185 §5), so the realtime board channel is deliberately untouched.

RBAC posture:
  * cross-project / nonexistent task → **404** (the task is resolved against a
    membership-scoped queryset, so existence is never leaked — IDOR-safe);
  * member-but-Viewer on an accessible task → **403** (``CanLogTime`` object check);
  * another user's entry → **404** (detail queryset is scoped to ``request.user``,
    so author-only edit/delete is an existence-oracle close, not a 403);
  * archived project, or a membership revoked/demoted below Member since the
    write started → **403** on every write path (``IsProjectNotArchived`` /
    ``CanLogTime``, re-checked live rather than trusted from when the entry or
    timer was created — #4318).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers, status
from rest_framework.exceptions import ErrorDetail, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import CanLogTime, IsProjectNotArchived
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.timetracking import review, services
from trueppm_api.apps.timetracking.models import (
    ActiveTimer,
    TimeEntry,
    TimeEntryCategory,
    TimesheetStatus,
    TimesheetSubmission,
)
from trueppm_api.apps.timetracking.serializers import (
    ActiveTimerSerializer,
    TimeEntrySerializer,
    TimeEntryWeeklySerializer,
    TimerStartSerializer,
)
from trueppm_api.core.openapi import state_refusal_400

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

    Carries ``IsProjectNotArchived`` alongside ``CanLogTime`` (#4318) — an archived
    project is hard read-only project-wide, and a time entry is a write like any
    other. Both are object-level checks invoked via ``check_object_permissions``
    after the task resolves; GET is unaffected (reads always pass both).
    """

    permission_classes = [IsAuthenticated, CanLogTime, IsProjectNotArchived]

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=inline_serializer(
                    name="TaskTimeEntryListResponse",
                    fields={
                        "results": TimeEntrySerializer(many=True),
                        "total_logged_minutes": serializers.IntegerField(),
                    },
                ),
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
        # One query: the caller's own entries on one task are a small bounded set, so
        # sum the fetched rows rather than issuing a second aggregate over the same filter.
        entries = list(
            TimeEntry.objects.filter(task=task, user=user, is_deleted=False).order_by(
                "-entry_date", "-created_at"
            )
        )
        total = sum(e.minutes for e in entries)
        return Response(
            {
                "results": TimeEntrySerializer(entries, many=True).data,
                "total_logged_minutes": int(total),
            }
        )

    @extend_schema(
        request=TimeEntrySerializer,
        responses={201: TimeEntrySerializer, 403: OpenApiTypes.OBJECT},
    )
    def post(self, request: Request, task_pk: str) -> Response:
        task = _member_task_or_404(request, task_pk)
        # Role gate: Member+ may log; Viewer is denied 403 (CanLogTime object check).
        self.check_object_permissions(request, task)
        # Pass the nested-route task in context so the serializer can reject a
        # time-log against a phase (ADR-0293) — the task is not in the request body.
        serializer = TimeEntrySerializer(
            data=request.data, context={"request": request, "task": task}
        )
        serializer.is_valid(raise_exception=True)
        entry = services.log_time(
            user=cast("_User", request.user),
            task=task,
            minutes=serializer.validated_data["minutes"],
            entry_date=serializer.validated_data.get("entry_date"),
            note=serializer.validated_data.get("note", ""),
            category=serializer.validated_data.get("category", TimeEntryCategory.TASK),
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

    **The approved-week lock is not here, deliberately (ADR-1495 §3).** It lives in
    ``TimeEntry.save()``, so this view, the create path and timer stop share one guard
    and a write into (or out of) an approved week answers 409
    ``timesheet_week_approved``. A submitted or returned week stays editable.

    **Re-checks live Member+ and the archived-project gate on every write (#4318).**
    The queryset above only proves the entry is *owned by the caller* — it says
    nothing about whether that caller is still a project member, or whether the
    project has since been archived. A former member who still holds a valid
    session could otherwise edit or delete their own historical entries in a
    project they no longer belong to, or one that is now read-only. Both checks run
    against the entry's own ``task`` (object-level, via ``CanLogTime`` and
    ``IsProjectNotArchived`` on ``permission_classes``) — a revoked member or an
    archived project answers **403**, matching the sibling write paths; this never
    leaks existence (the entry already resolved as the caller's own), so there is
    no 404 case to preserve here.
    """

    permission_classes = [IsAuthenticated, CanLogTime, IsProjectNotArchived]

    def _own_entry_or_404(self, request: Request, pk: str) -> TimeEntry:
        user = cast("_User", request.user)
        qs = TimeEntry.objects.filter(user=user, is_deleted=False).select_related("task")
        return get_object_or_404(qs, pk=pk)

    @extend_schema(
        request=TimeEntrySerializer,
        responses={200: TimeEntrySerializer, 403: OpenApiTypes.OBJECT},
    )
    def patch(self, request: Request, pk: str) -> Response:
        entry = self._own_entry_or_404(request, pk)
        # Object-level re-check (#4318): resolves the task's live membership role
        # and the project's archive flag, not whatever was true when the entry
        # was logged.
        self.check_object_permissions(request, entry.task)
        serializer = TimeEntrySerializer(
            entry, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @extend_schema(
        responses={
            204: OpenApiResponse(description="Entry soft-deleted; empty body."),
            403: OpenApiTypes.OBJECT,
        }
    )
    def delete(self, request: Request, pk: str) -> Response:
        entry = self._own_entry_or_404(request, pk)
        # Object-level re-check (#4318) — see the ``patch`` method above.
        self.check_object_permissions(request, entry.task)
        # Record the actor so the task activity stream can attribute the synthesized
        # ``time_deleted`` event (issue #1888). Always the owner here — entries are
        # self-scoped — but stamping it keeps a consistent actor shape across events.
        entry.soft_delete(actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


def _parse_iso_date(raw: str, field: str) -> date:
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except (ValueError, TypeError) as err:
        raise ValidationError({field: "Must be an ISO date (YYYY-MM-DD)."}) from err


def _monday_of(d: date) -> date:
    """Canonicalize a date to the Monday of its ISO week (ADR-0224).

    The submission unit is *a week*; normalizing to Monday (rather than rejecting a
    non-Monday) is forgiving of client drift and makes the ``(user, week_start)`` marker
    impossible to fragment into off-by-a-day rows.
    """
    return d - timedelta(days=d.weekday())


def _own_submission_payload(week_start: date, row: Mapping[str, Any] | None) -> dict[str, Any]:
    """The caller's own week state, folded into the weekly GET (ADR-0224, ADR-1495).

    ``submitted`` stays the 0.4 boolean the grid reads: true while the week is
    submitted or approved, false for draft and returned (both editable). The return
    reason is included because this payload only ever describes the caller's own week.
    """
    if row is None:
        return {
            "week_start": week_start.isoformat(),
            "submitted": False,
            "submitted_at": None,
            "status": TimesheetStatus.DRAFT,
            "reviewer": None,
            "reviewed_at": None,
            "return_reason": "",
        }
    status_ = row["status"]
    return {
        "week_start": week_start.isoformat(),
        "submitted": status_ in (TimesheetStatus.SUBMITTED, TimesheetStatus.APPROVED),
        "submitted_at": row["submitted_at"].isoformat() if row["submitted_at"] else None,
        "status": status_,
        "reviewer": row["reviewer_id"],
        "reviewed_at": row["reviewed_at"].isoformat() if row["reviewed_at"] else None,
        "return_reason": row["return_reason"] if status_ == TimesheetStatus.RETURNED else "",
    }


class MeTimeEntryWeeklyView(APIView):
    """``/api/v1/me/time-entries/?from=&to=`` — weekly cross-project rollup (ADR-0185 §4).

    Drives both the #1435 grid and the #1234 header rollup. Returns the caller's entries
    in the window across **all accessible projects**, plus precomputed totals (by_day,
    by_cell, today, week) and the week's ``submission`` marker (ADR-0224). The membership
    re-check (defence-in-depth, mirrors ``/me/work``) drops entries on projects the user was
    removed from. ``select_related`` on task→project keeps the read N+1-bounded (asserted by
    ``assertNumQueries``); the totals are folded from the already-fetched rows, and the
    submission is a single indexed lookup, so the read stays a small constant of queries.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter("from", OpenApiTypes.DATE, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("to", OpenApiTypes.DATE, OpenApiParameter.QUERY, required=False),
        ],
        responses={
            200: inline_serializer(
                name="MeTimeEntriesWeeklyResponse",
                fields={
                    "results": TimeEntryWeeklySerializer(many=True),
                    "totals": inline_serializer(
                        name="MeTimeEntriesWeeklyTotals",
                        fields={
                            # Keyed by ISO date (by_day) or "<task_id>|<ISO date>"
                            # (by_cell) — the key set is data-shaped, not a fixed
                            # schema, so the value type is all drf-spectacular can
                            # usefully declare here.
                            "by_day": serializers.DictField(child=serializers.IntegerField()),
                            "by_cell": serializers.DictField(child=serializers.IntegerField()),
                            "today_minutes": serializers.IntegerField(),
                            "week_minutes": serializers.IntegerField(),
                        },
                    ),
                    "submission": inline_serializer(
                        name="MeTimeEntriesWeeklySubmission",
                        fields={
                            "week_start": serializers.CharField(),
                            "submitted": serializers.BooleanField(),
                            "submitted_at": serializers.CharField(allow_null=True),
                            "status": serializers.ChoiceField(choices=TimesheetStatus.choices),
                            "reviewer": serializers.IntegerField(allow_null=True),
                            "reviewed_at": serializers.CharField(allow_null=True),
                            "return_reason": serializers.CharField(allow_blank=True),
                        },
                    ),
                },
            ),
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
            # engine-boundary-ok: calendar bookkeeping, not schedule math
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
                task__project__is_deleted=False,  # #4577: trashed project confers no access
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

        # Fold the week's submission marker (ADR-0224) so the grid needs no second
        # round-trip. The grid always requests a full Mon-Sun window, so the Monday of
        # 'start' is the well-defined submission key.
        week_start = _monday_of(start)
        submission = (
            TimesheetSubmission.objects.filter(user=user, week_start=week_start)
            .values("submitted_at", "status", "reviewer_id", "reviewed_at", "return_reason")
            .first()
        )

        return Response(
            {
                "results": TimeEntryWeeklySerializer(entries, many=True).data,
                "totals": {
                    "by_day": by_day,
                    "by_cell": by_cell,
                    "today_minutes": today_minutes,
                    "week_minutes": week_minutes,
                },
                "submission": _own_submission_payload(week_start, submission),
            }
        )


class MeTimesheetSubmitView(APIView):
    """``/api/v1/me/timesheets/{week_start}/submit`` — mark a week done / undo (ADR-0224).

    The submitter's half of the review state machine (ADR-1495 §2): POST submits or
    resubmits (a returned week included, which notifies the reviewer), DELETE withdraws
    to draft. Both answer 409 once the week is approved — there is no reopen in 0.5.
    Entries stay editable while submitted; approve re-hashes them and refuses a week
    that changed. Hard-scoped to ``request.user`` (the URL carries no other user's
    identity), so ``IsAuthenticated`` is the whole gate.

    ``week_start`` is normalized to its ISO Monday (:func:`_monday_of`) before write, so the
    ``(user, week_start)`` uniqueness cannot fragment. A repeated POST refreshes
    ``submitted_at`` and the digest; a DELETE of a never-submitted week is a 204 no-op.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=None,
        responses={
            200: inline_serializer(
                name="TimesheetSubmitResponse",
                fields={
                    "week_start": serializers.CharField(),
                    "submitted_at": serializers.CharField(),
                    "status": serializers.ChoiceField(choices=TimesheetStatus.choices),
                },
            ),
            409: OpenApiResponse(
                description="The week is approved and can no longer be resubmitted."
            ),
            400: state_refusal_400(
                "``week_start`` in the path is not an ISO date (YYYY-MM-DD). The "
                "segment is free text, so a malformed value reaches the handler and "
                "``_parse_iso_date`` refuses it with a body keyed by ``week_start`` "
                "rather than a flat ``detail`` (#3319).",
                shape="fields",
            ),
        },
    )
    def post(self, request: Request, week_start: str) -> Response:
        user = cast("_User", request.user)
        monday = _monday_of(_parse_iso_date(week_start, "week_start"))
        submission = review.submit_week(user=user, week_start=monday)
        return Response(
            {
                "week_start": monday.isoformat(),
                "submitted_at": submission.submitted_at.isoformat(),
                "status": submission.status,
            }
        )

    @extend_schema(
        responses={
            204: OpenApiResponse(description="Week withdrawn to draft; empty body."),
            409: OpenApiResponse(description="The week is approved and cannot be withdrawn."),
            400: state_refusal_400(
                "``week_start`` in the path is not an ISO date (YYYY-MM-DD). The "
                "segment is free text, so a malformed value reaches the handler and "
                "``_parse_iso_date`` refuses it with a body keyed by ``week_start`` "
                "rather than a flat ``detail`` (#3319).",
                shape="fields",
            ),
        }
    )
    def delete(self, request: Request, week_start: str) -> Response:
        user = cast("_User", request.user)
        monday = _monday_of(_parse_iso_date(week_start, "week_start"))
        review.withdraw_week(user=user, week_start=monday)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeTimerView(APIView):
    """``GET /api/v1/me/timer/`` — the caller's running timer, reconcile-on-load (ADR-0185 §4).

    Returns ``{active: false}`` or the live timer with server-computed
    ``elapsed_seconds`` / ``stale``. Multi-device continuity is handled here (refetch on
    focus, ``started_at`` as the authoritative clock) — not by a broadcast (ADR-0185 §5).
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={
            200: inline_serializer(
                name="MeTimerResponse",
                fields={
                    "active": serializers.BooleanField(),
                    # Present only when active is True — flattened from
                    # ActiveTimerSerializer at the top level (not nested), matching
                    # what the view actually returns.
                    "id": serializers.UUIDField(required=False),
                    "task": serializers.UUIDField(required=False),
                    "task_short_id": serializers.CharField(required=False),
                    "task_name": serializers.CharField(required=False),
                    "project": serializers.UUIDField(required=False),
                    "started_at": serializers.DateTimeField(required=False),
                    "elapsed_seconds": serializers.IntegerField(required=False),
                    "note": serializers.CharField(required=False, allow_blank=True),
                    "stale": serializers.BooleanField(required=False),
                },
            )
        }
    )
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

    Carries ``IsProjectNotArchived`` alongside ``CanLogTime`` (#4318) — starting a timer
    is a write like any other, so the **new** task's project being archived answers 403
    exactly as it does on the other write paths. This says nothing about the *prior*
    running timer a second-start may finalize: that timer's own project is re-checked
    inside ``services.start_timer`` (discard rather than finalize if it is no longer
    writable), because it belongs to a different project than the one this permission
    class is resolving against here.
    """

    permission_classes = [IsAuthenticated, CanLogTime, IsProjectNotArchived]

    @extend_schema(
        request=TimerStartSerializer,
        responses={
            201: inline_serializer(
                name="MeTimerStartResponse",
                fields={
                    "active_timer": ActiveTimerSerializer(),
                    # Non-null only on a second-start, where the prior timer is
                    # atomically stopped and logged (see class docstring).
                    "finalized_entry": TimeEntrySerializer(allow_null=True, required=False),
                },
            ),
            403: OpenApiTypes.OBJECT,
        },
    )
    def post(self, request: Request) -> Response:
        body = TimerStartSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        task = _member_task_or_404(request, body.validated_data["task"])
        self.check_object_permissions(request, task)
        # A phase carries no logged time (ADR-0293); reject starting a timer on one
        # up front so the timer-stop path can never create a phase entry that would
        # bypass TimeEntrySerializer. Same stable code as the manual-entry lock.
        from trueppm_api.apps.projects.models import task_is_phase

        if task_is_phase(task):
            raise ValidationError(
                ErrorDetail(
                    "Time cannot be logged against a phase — it rolls up the logged "
                    "time of its child tasks. Log against a leaf task instead.",
                    code="time_log_on_phase",
                )
            )
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

    **No object to resolve a project from at this layer (#4318).** Unlike
    ``MeTimeEntryDetailView``, the request carries no id — the running timer, and
    therefore its task and project, is only known once ``services.stop_timer``
    looks it up. The archived-project and live-Member+ re-checks accordingly live
    *inside* ``stop_timer`` itself (``timetracking/services.py``), not on
    ``permission_classes`` here.

    **Never a 403 from either re-check (#4318 round 2).** An earlier version of
    ``stop_timer`` raised ``PermissionDenied`` when a timer's project was archived
    or access had lapsed — which left the ``ActiveTimer`` row in place and made
    that timer permanently un-stoppable (every retry re-hit the same 403, and the
    web client restores the timer into its cache on any non-409 error). Both
    checks now **discard** the timer and return ``None``, so this view answers the
    same ``409`` ("no timer to stop") it already answers for a timer that was
    stopped from another device — a state the client already clears silently with
    no error toast. In practice a revoked or demoted member's ``ActiveTimer`` row
    is usually already gone by the time this runs regardless — the
    ``ProjectMembership`` revocation hook (``access/signals.py``) discards it
    immediately — so an archived project (which does not evict membership, and so
    never fires that hook) is the common way to actually reach this discard.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={
            201: TimeEntrySerializer,
            409: OpenApiTypes.OBJECT,
        }
    )
    def post(self, request: Request) -> Response:
        entry = services.stop_timer(user=cast("_User", request.user))
        if entry == services.TIMER_DISCARDED_APPROVED_WEEK:
            # Still 409, so the client clears its timer exactly as for "no timer" —
            # the row is gone — but the message says the time was not logged and why.
            return Response(
                {
                    "detail": (
                        "The timer's week is approved and read-only, so its time was "
                        "not logged. The timer was discarded."
                    ),
                    "code": "timesheet_week_approved",
                },
                status=status.HTTP_409_CONFLICT,
            )
        if not isinstance(entry, TimeEntry):
            return Response({"detail": "No active timer to stop."}, status=status.HTTP_409_CONFLICT)
        return Response(
            TimeEntrySerializer(entry, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )
