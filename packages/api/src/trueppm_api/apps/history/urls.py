"""URL routing for the history app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.history.views import (
    ProjectHistoryListView,
    ProjectHistorySummaryView,
    TaskHistoryListView,
)

urlpatterns = [
    path(
        "projects/<project_pk>/history/",
        ProjectHistoryListView.as_view(),
        name="project-history-list",
    ),
    path(
        "projects/<project_pk>/history/summary/",
        ProjectHistorySummaryView.as_view(),
        name="project-history-summary",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/history/",
        TaskHistoryListView.as_view(),
        name="task-history-list",
    ),
]
