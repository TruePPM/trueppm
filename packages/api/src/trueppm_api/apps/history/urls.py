"""URL routing for the history app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.history.views import (
    ProjectChangelogView,
    ProjectHistoryListView,
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
    # NOTE(#3372): ``projects/<project_pk>/history/summary/``
    # (ProjectHistorySummaryView, ``project-history-summary``) was removed
    # outright rather than deprecated — it shipped in 0.1 with a docstring
    # claiming the UI called it on refresh, but had zero client consumers
    # (web uses ``/changelog/`` and task history instead). See ADR-0011's
    # dated Superseded note and stability.md step 3 for the recorded
    # decision and rationale. The path now falls through to Django's
    # standard 404, which is the deliberate outcome for a stale caller.
    #
    # NOTE: ``projects/<project_pk>/tasks/<task_pk>/history/`` is intentionally
    # NOT registered here. The projects app already serves that path via
    # ``project-task-history`` (TaskHistoryView), and because ``projects.urls``
    # is included before ``history.urls`` in the root URLConf, a registration
    # here would be permanently shadowed (dead route). The duplicate was removed
    # per issue #781 so the OpenAPI schema shows a single task-history operation.
]
