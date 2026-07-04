"""URL routing for the history app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.history.views import (
    ProjectChangelogView,
    ProjectHistoryListView,
    ProjectHistorySummaryView,
)

urlpatterns = [
    path(
        "projects/<project_pk>/changelog/",
        ProjectChangelogView.as_view(),
        name="project-changelog",
    ),
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
    # NOTE: ``projects/<project_pk>/tasks/<task_pk>/history/`` is intentionally
    # NOT registered here. The projects app already serves that path via
    # ``project-task-history`` (TaskHistoryView), and because ``projects.urls``
    # is included before ``history.urls`` in the root URLConf, a registration
    # here would be permanently shadowed (dead route). The duplicate was removed
    # per issue #781 so the OpenAPI schema shows a single task-history operation.
]
