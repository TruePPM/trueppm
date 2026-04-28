"""URL routing for the projects app."""

from __future__ import annotations

from django.urls import path
from rest_framework.routers import DefaultRouter

from trueppm_api.apps.projects.views import (
    BaselineActivateView,
    BaselineViewSet,
    BoardColumnConfigView,
    BoardSavedViewDetailView,
    BoardSavedViewListView,
    CalendarViewSet,
    DependencyViewSet,
    ProjectAttentionView,
    ProjectMyTasksView,
    ProjectOverviewView,
    ProjectPresenceView,
    ProjectViewSet,
    RiskViewSet,
    TaskBaselineDetailView,
    TaskBulkView,
    TaskHistoryView,
    TaskIndentView,
    TaskOutdentView,
    TaskReorderView,
    TaskReparentView,
    TaskViewSet,
)

router = DefaultRouter()
router.register(r"calendars", CalendarViewSet, basename="calendar")
router.register(r"projects", ProjectViewSet, basename="project")
router.register(r"tasks", TaskViewSet, basename="task")
router.register(r"dependencies", DependencyViewSet, basename="dependency")

urlpatterns = [
    *router.urls,
    # Nested project actions — not routable via DefaultRouter.
    path(
        "projects/<pk>/tasks/reorder/",
        TaskReorderView.as_view(),
        name="project-tasks-reorder",
    ),
    path(
        "projects/<pk>/tasks/bulk/",
        TaskBulkView.as_view(),
        name="project-tasks-bulk",
    ),
    path(
        "projects/<pk>/tasks/<task_id>/indent/",
        TaskIndentView.as_view(),
        name="project-task-indent",
    ),
    path(
        "projects/<pk>/tasks/<task_id>/outdent/",
        TaskOutdentView.as_view(),
        name="project-task-outdent",
    ),
    path(
        "projects/<pk>/tasks/<task_id>/reparent/",
        TaskReparentView.as_view(),
        name="project-task-reparent",
    ),
    # Baseline endpoints — nested under /projects/<project_pk>/baselines/
    path(
        "projects/<project_pk>/baselines/",
        BaselineViewSet.as_view({"get": "list", "post": "create"}),
        name="project-baselines-list",
    ),
    path(
        "projects/<project_pk>/baselines/<pk>/",
        BaselineViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
        name="project-baselines-detail",
    ),
    path(
        "projects/<project_pk>/baselines/<baseline_pk>/activate/",
        BaselineActivateView.as_view(),
        name="project-baselines-activate",
    ),
    path(
        "projects/<pk>/board-config/",
        BoardColumnConfigView.as_view(),
        name="project-board-config",
    ),
    path(
        "projects/<pk>/board-views/",
        BoardSavedViewListView.as_view(),
        name="project-board-views",
    ),
    path(
        "projects/<pk>/board-views/<view_pk>/",
        BoardSavedViewDetailView.as_view(),
        name="project-board-views-detail",
    ),
    # Presence endpoint — who is connected to this project's WebSocket
    path(
        "projects/<pk>/presence/",
        ProjectPresenceView.as_view(),
        name="project-presence",
    ),
    # Overview dashboard endpoints (ADR-0030)
    path(
        "projects/<pk>/overview/",
        ProjectOverviewView.as_view(),
        name="project-overview",
    ),
    path(
        "projects/<pk>/attention/",
        ProjectAttentionView.as_view(),
        name="project-attention",
    ),
    path(
        "projects/<pk>/my-tasks/",
        ProjectMyTasksView.as_view(),
        name="project-my-tasks",
    ),
    # Task drawer — history and baseline (ADR-0032)
    path(
        "projects/<project_pk>/tasks/<task_pk>/history/",
        TaskHistoryView.as_view(),
        name="project-task-history",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/baseline/",
        TaskBaselineDetailView.as_view(),
        name="project-task-baseline",
    ),
    # Risk endpoints — nested under /projects/<project_pk>/risks/
    path(
        "projects/<project_pk>/risks/",
        RiskViewSet.as_view({"get": "list", "post": "create"}),
        name="project-risks-list",
    ),
    path(
        "projects/<project_pk>/risks/<pk>/",
        RiskViewSet.as_view(
            {
                "get": "retrieve",
                "put": "update",
                "patch": "partial_update",
                "delete": "destroy",
            }
        ),
        name="project-risks-detail",
    ),
]
