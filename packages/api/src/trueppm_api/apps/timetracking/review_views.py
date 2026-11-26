"""REST views for timesheet review and the reporting line (ADR-1495).

RBAC posture:
  * reporting lines (``/reporting-lines/``) — workspace Admin+ on every method,
    reads included: who manages whom is confidential org structure;
  * the review queue and a report's week (``/me/reports/...``) — the caller's own
    direct reports only. Any other person id, and a missing one, answers **404**;
    the reviewer is always ``request.user`` and never read from the body;
  * approve / return — the same 404 scoping, plus ``ApiToken`` callers refused
    (human-only attestation, audited as an identity refusal).

A manager sees a report's week totals in full, but entry detail (task, project and
note) only for projects the manager is a member of: approving someone's hours does
not grant a read of projects the manager cannot otherwise see.

Nothing here broadcasts: a timesheet is personal, not board state.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any, cast

from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsNotTokenAuthenticated,
    IsNotTokenForTimesheetReview,
)
from trueppm_api.apps.timetracking import review
from trueppm_api.apps.timetracking.models import (
    ReportingLine,
    TimeEntry,
    TimesheetStatus,
    TimesheetSubmission,
)
from trueppm_api.apps.timetracking.views import _monday_of, _parse_iso_date
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdminStrict

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User


def _person(u: Any) -> dict[str, Any]:
    return {"id": u.pk, "username": u.get_username(), "name": (u.get_full_name() or "").strip()}


_PERSON = inline_serializer(
    name="TimesheetPerson",
    fields={
        "id": serializers.IntegerField(),
        "username": serializers.CharField(),
        "name": serializers.CharField(allow_blank=True),
    },
)

_REPORTING_LINE = inline_serializer(
    name="ReportingLine",
    fields={
        "user": _PERSON,
        "manager": _PERSON,
        "updated_at": serializers.DateTimeField(),
    },
)


def _line_payload(line: ReportingLine) -> dict[str, Any]:
    return {
        "user": _person(line.user),
        "manager": _person(line.manager),
        "updated_at": line.updated_at.isoformat(),
    }


class ReportingLineListView(APIView):
    """``GET /api/v1/reporting-lines/`` — every reporting line (workspace Admin+)."""

    # Tokens refused: a reporting line grants approval authority, so it is set by a
    # person (a directory sync calls ``review.set_manager`` in-process instead).
    permission_classes = (
        IsAuthenticated,
        IsWorkspaceAdminStrict,
        IsNotTokenAuthenticated,
    )

    @extend_schema(
        tags=["workspace"],
        responses={
            200: inline_serializer(
                name="ReportingLineList",
                fields={
                    # Unpaginated (one row per person), so next/previous are always null.
                    "next": serializers.CharField(allow_null=True),
                    "previous": serializers.CharField(allow_null=True),
                    "results": _REPORTING_LINE.__class__(many=True),
                },
            )
        },
    )
    def get(self, request: Request) -> Response:
        lines = ReportingLine.objects.select_related("user", "manager").order_by("user_id")
        return Response(
            {"next": None, "previous": None, "results": [_line_payload(line) for line in lines]}
        )


class ReportingLineDetailView(APIView):
    """``/api/v1/reporting-lines/{user_id}/`` — read, set or clear a person's manager.

    Workspace Admin+ only: setting a manager grants approval authority over a
    person's time. ``PUT {"manager": <user id>}`` sets it, ``DELETE`` clears it. The
    service refuses self-management and cycles and audits every change.
    """

    # Tokens refused: a reporting line grants approval authority, so it is set by a
    # person (a directory sync calls ``review.set_manager`` in-process instead).
    permission_classes = (
        IsAuthenticated,
        IsWorkspaceAdminStrict,
        IsNotTokenAuthenticated,
    )

    def _user_or_404(self, user_id: int) -> Any:
        return get_object_or_404(get_user_model(), pk=user_id)

    @extend_schema(tags=["workspace"], responses={200: _REPORTING_LINE, 404: OpenApiTypes.OBJECT})
    def get(self, request: Request, user_id: int) -> Response:
        line = get_object_or_404(
            ReportingLine.objects.select_related("user", "manager"), user_id=user_id
        )
        return Response(_line_payload(line))

    @extend_schema(
        tags=["workspace"],
        request=inline_serializer(
            name="ReportingLineWrite", fields={"manager": serializers.IntegerField()}
        ),
        responses={200: _REPORTING_LINE, 400: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
    )
    def put(self, request: Request, user_id: int) -> Response:
        user = self._user_or_404(user_id)
        body = request.data if isinstance(request.data, dict) else {}
        raw = body.get("manager")
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise serializers.ValidationError({"manager": "A user id (integer) is required."})
        manager = get_user_model().objects.filter(pk=raw).first()
        if manager is None:
            raise serializers.ValidationError({"manager": "No such user."})
        line = review.set_manager(actor=cast("_User", request.user), user=user, manager=manager)
        assert line is not None
        line = ReportingLine.objects.select_related("user", "manager").get(pk=line.pk)
        return Response(_line_payload(line))

    @extend_schema(
        tags=["workspace"], responses={204: OpenApiResponse(description="Manager cleared.")}
    )
    def delete(self, request: Request, user_id: int) -> Response:
        user = self._user_or_404(user_id)
        review.set_manager(actor=cast("_User", request.user), user=user, manager=None)
        return Response(status=204)


def _week_param(request: Request) -> Any:
    raw = request.query_params.get("week")
    if raw is None:
        return _monday_of(timezone.localdate())
    return _monday_of(_parse_iso_date(raw, "week"))


_QUEUE_ROW = inline_serializer(
    name="TimesheetReportRow",
    fields={
        "user": _PERSON,
        "week_start": serializers.DateField(),
        "status": serializers.ChoiceField(choices=TimesheetStatus.choices),
        "submitted_at": serializers.DateTimeField(allow_null=True),
        "week_minutes": serializers.IntegerField(),
    },
)


class MeReportsView(APIView):
    """``GET /api/v1/me/reports/?week=`` — the caller's direct reports and their week.

    One row per direct report with the week's review state and total minutes, so a
    manager sees who has submitted. Three queries regardless of team size.
    """

    permission_classes = (IsAuthenticated,)

    @extend_schema(
        parameters=[OpenApiParameter("week", OpenApiTypes.DATE, OpenApiParameter.QUERY)],
        responses={
            200: inline_serializer(
                name="MeReportsResponse",
                fields={
                    # Unpaginated (one row per direct report); each row names its week.
                    "next": serializers.CharField(allow_null=True),
                    "previous": serializers.CharField(allow_null=True),
                    "results": _QUEUE_ROW.__class__(many=True),
                },
            )
        },
    )
    def get(self, request: Request) -> Response:
        from django.db.models import Sum

        monday = _week_param(request)
        me = cast("_User", request.user)
        reports = list(
            get_user_model()
            .objects.filter(reporting_line__manager=me)
            .exclude(pk=me.pk)
            .order_by("username")
        )
        ids = [u.pk for u in reports]
        subs = {
            s.user_id: s
            for s in TimesheetSubmission.objects.filter(user_id__in=ids, week_start=monday)
        }
        minutes = dict(
            TimeEntry.objects.filter(
                user_id__in=ids,
                is_deleted=False,
                # engine-boundary-ok: calendar bookkeeping, not schedule math
                entry_date__range=(monday, monday + timedelta(days=6)),
            )
            .order_by()
            .values("user_id")
            .annotate(m=Sum("minutes"))
            .values_list("user_id", "m")
        )
        rows = []
        for u in reports:
            sub = subs.get(u.pk)
            rows.append(
                {
                    "user": _person(u),
                    "week_start": monday.isoformat(),
                    "status": sub.status if sub else TimesheetStatus.DRAFT,
                    "submitted_at": sub.submitted_at.isoformat() if sub else None,
                    "week_minutes": int(minutes.get(u.pk) or 0),
                }
            )
        return Response({"next": None, "previous": None, "results": rows})


_REPORT_ENTRY = inline_serializer(
    name="TimesheetReportEntry",
    fields={
        "id": serializers.UUIDField(),
        "entry_date": serializers.DateField(),
        "minutes": serializers.IntegerField(),
        "category": serializers.CharField(),
        "restricted": serializers.BooleanField(),
        "task": serializers.UUIDField(allow_null=True),
        "task_name": serializers.CharField(allow_null=True),
        "project": serializers.UUIDField(allow_null=True),
        "project_name": serializers.CharField(allow_null=True),
        "note": serializers.CharField(allow_blank=True),
    },
)

_REPORT_WEEK = inline_serializer(
    name="TimesheetReportWeek",
    fields={
        "user": _PERSON,
        "week_start": serializers.DateField(),
        "status": serializers.ChoiceField(choices=TimesheetStatus.choices),
        "submitted_at": serializers.DateTimeField(allow_null=True),
        "reviewed_at": serializers.DateTimeField(allow_null=True),
        "return_reason": serializers.CharField(allow_blank=True),
        "week_minutes": serializers.IntegerField(),
        "entries": _REPORT_ENTRY.__class__(many=True),
    },
)


def _report_week_payload(manager: Any, user: Any, monday: Any) -> dict[str, Any]:
    from trueppm_api.apps.access.models import ProjectMembership

    sub = TimesheetSubmission.objects.filter(user=user, week_start=monday).first()
    entries = list(
        TimeEntry.objects.filter(
            user=user,
            is_deleted=False,
            # engine-boundary-ok: calendar bookkeeping, not schedule math
            entry_date__range=(monday, monday + timedelta(days=6)),
        )
        .select_related("task", "task__project")
        .order_by("entry_date", "created_at")
    )
    visible = set(
        ProjectMembership.objects.filter(
            user=manager, is_deleted=False, project__is_deleted=False
        ).values_list("project_id", flat=True)
    )
    rows = []
    for e in entries:
        shown = e.task.project_id in visible
        rows.append(
            {
                "id": str(e.pk),
                "entry_date": e.entry_date.isoformat(),
                "minutes": e.minutes,
                "category": e.category,
                "restricted": not shown,
                "task": str(e.task_id) if shown else None,
                "task_name": e.task.name if shown else None,
                "project": str(e.task.project_id) if shown else None,
                "project_name": e.task.project.name if shown else None,
                "note": e.note if shown else "",
            }
        )
    # The reason is shown to the reviewer who wrote it (and, elsewhere, the submitter)
    # only — not to a manager who took over the line later.
    reason = (
        sub.return_reason
        if sub is not None
        and sub.status == TimesheetStatus.RETURNED
        and sub.reviewer_id == manager.pk
        else ""
    )
    return {
        "user": _person(user),
        "week_start": monday.isoformat(),
        "status": sub.status if sub else TimesheetStatus.DRAFT,
        "submitted_at": sub.submitted_at.isoformat() if sub else None,
        "reviewed_at": sub.reviewed_at.isoformat() if sub and sub.reviewed_at else None,
        "return_reason": reason,
        "week_minutes": sum(e.minutes for e in entries),
        "entries": rows,
    }


def _report_or_404(request: Request, user_id: int) -> Any:
    if not review.is_direct_report(cast("_User", request.user), user_id):
        from django.http import Http404

        raise Http404
    return get_object_or_404(get_user_model(), pk=user_id)


class MeReportWeekView(APIView):
    """``GET /api/v1/me/reports/{user_id}/timesheets/{week_start}/`` — a report's week."""

    permission_classes = (IsAuthenticated,)

    @extend_schema(responses={200: _REPORT_WEEK, 404: OpenApiTypes.OBJECT})
    def get(self, request: Request, user_id: int, week_start: str) -> Response:
        user = _report_or_404(request, user_id)
        monday = _monday_of(_parse_iso_date(week_start, "week_start"))
        return Response(_report_week_payload(request.user, user, monday))


class MeReportApproveView(APIView):
    """``POST .../approve/`` — approve a direct report's submitted week (ADR-1495 §2).

    409 ``timesheet_state_conflict`` when the week is not submitted, and 409
    ``timesheet_changed_since_submit`` when its entries changed after submit.
    """

    permission_classes = (
        IsAuthenticated,
        IsNotTokenForTimesheetReview,
    )

    @extend_schema(
        request=None,
        responses={
            200: _REPORT_WEEK,
            403: OpenApiTypes.OBJECT,
            404: OpenApiTypes.OBJECT,
            409: OpenApiTypes.OBJECT,
        },
    )
    def post(self, request: Request, user_id: int, week_start: str) -> Response:
        user = _report_or_404(request, user_id)
        monday = _monday_of(_parse_iso_date(week_start, "week_start"))
        review.approve_week(
            reviewer=cast("_User", request.user), user_id=user.pk, week_start=monday
        )
        return Response(_report_week_payload(request.user, user, monday))


class MeReportReturnView(APIView):
    """``POST .../return/ {"reason": "..."}`` — return a submitted week (ADR-1495 §2).

    The reason is required (400 when blank). It reaches the submitter as an in-app
    Inbox item and is readable by the submitter and this reviewer only.
    """

    permission_classes = (
        IsAuthenticated,
        IsNotTokenForTimesheetReview,
    )

    @extend_schema(
        request=inline_serializer(
            name="TimesheetReturnRequest", fields={"reason": serializers.CharField()}
        ),
        responses={
            200: _REPORT_WEEK,
            400: OpenApiTypes.OBJECT,
            403: OpenApiTypes.OBJECT,
            404: OpenApiTypes.OBJECT,
            409: OpenApiTypes.OBJECT,
        },
    )
    def post(self, request: Request, user_id: int, week_start: str) -> Response:
        user = _report_or_404(request, user_id)
        monday = _monday_of(_parse_iso_date(week_start, "week_start"))
        body = request.data if isinstance(request.data, dict) else {}
        reason = body.get("reason")
        review.return_week(
            reviewer=cast("_User", request.user),
            user_id=user.pk,
            week_start=monday,
            reason=reason if isinstance(reason, str) else "",
        )
        return Response(_report_week_payload(request.user, user, monday))
