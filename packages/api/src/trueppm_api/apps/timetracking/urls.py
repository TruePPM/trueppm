"""URL patterns for the time-tracking app (ADR-0185 §4)."""

from __future__ import annotations

from django.urls import path

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
    path(
        "me/timesheets/<str:week_start>/submit",
        MeTimesheetSubmitView.as_view(),
        name="me-timesheet-submit",
    ),
    # Running timer (user singleton).
    path("me/timer/", MeTimerView.as_view(), name="me-timer"),
    path("me/timer/start", MeTimerStartView.as_view(), name="me-timer-start"),
    path("me/timer/stop", MeTimerStopView.as_view(), name="me-timer-stop"),
]
