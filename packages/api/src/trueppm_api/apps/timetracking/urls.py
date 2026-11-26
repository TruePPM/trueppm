"""URL patterns for the time-tracking app (ADR-0185 §4)."""

from __future__ import annotations

from django.urls import path, re_path

from trueppm_api.apps.timetracking.review_views import (
    MeReportApproveView,
    MeReportReturnView,
    MeReportsView,
    MeReportWeekView,
    ReportingLineDetailView,
    ReportingLineListView,
)
from trueppm_api.apps.timetracking.views import (
    MeTimeEntryDetailView,
    MeTimeEntryWeeklyView,
    MeTimerStartView,
    MeTimerStopView,
    MeTimerView,
    MeTimesheetSubmitView,
    TaskTimeEntryView,
)

urlpatterns = [
    # Per-task, caller-scoped create + list.
    path(
        "tasks/<uuid:task_pk>/time-entries/",
        TaskTimeEntryView.as_view(),
        name="task-time-entries",
    ),
    # Weekly cross-project rollup (grid + header). Registered before the detail
    # route; the trailing-uuid detail route cannot shadow the bare list path.
    path(
        "me/time-entries/",
        MeTimeEntryWeeklyView.as_view(),
        name="me-time-entries",
    ),
    # Author-only edit/delete.
    path(
        "me/time-entries/<uuid:pk>/",
        MeTimeEntryDetailView.as_view(),
        name="me-time-entry-detail",
    ),
    # Weekly submission marker — submit / un-submit (ADR-0224).
    # Canonical form carries the trailing slash like every other route (#3792). The
    # unslashed spelling shipped first in 0.4 and web/integrator clients call it, and
    # APPEND_SLASH only ever adds a slash, so it stays routable through `/?$` — one
    # pattern, one view, one schema path (the slashed one).
    re_path(
        r"^me/timesheets/(?P<week_start>[^/]+)/submit/?$",
        MeTimesheetSubmitView.as_view(),
        name="me-timesheet-submit",
    ),
    # Timesheet review (ADR-1495): reporting lines (workspace Admin+) and the
    # manager's review of their direct reports' weeks.
    path("reporting-lines/", ReportingLineListView.as_view(), name="reporting-lines"),
    path(
        "reporting-lines/<int:user_id>/",
        ReportingLineDetailView.as_view(),
        name="reporting-line-detail",
    ),
    path("me/reports/", MeReportsView.as_view(), name="me-reports"),
    path(
        "me/reports/<int:user_id>/timesheets/<str:week_start>/",
        MeReportWeekView.as_view(),
        name="me-report-week",
    ),
    path(
        "me/reports/<int:user_id>/timesheets/<str:week_start>/approve/",
        MeReportApproveView.as_view(),
        name="me-report-week-approve",
    ),
    path(
        "me/reports/<int:user_id>/timesheets/<str:week_start>/return/",
        MeReportReturnView.as_view(),
        name="me-report-week-return",
    ),
    # Running timer (user singleton).
    path("me/timer/", MeTimerView.as_view(), name="me-timer"),
    re_path(r"^me/timer/start/?$", MeTimerStartView.as_view(), name="me-timer-start"),
    re_path(r"^me/timer/stop/?$", MeTimerStopView.as_view(), name="me-timer-stop"),
]
