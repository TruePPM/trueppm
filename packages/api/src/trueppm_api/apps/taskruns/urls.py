"""URL configuration for taskruns app."""

from __future__ import annotations

from django.urls import path
from rest_framework.routers import DefaultRouter

from trueppm_api.apps.taskruns.views import GlobalTaskRunViewSet, ProjectTaskRunViewSet

# Global task-run endpoints: /task-runs/<id>/ and /task-runs/active/.
router = DefaultRouter()
router.register(r"task-runs", GlobalTaskRunViewSet, basename="task-run")

urlpatterns = [
    # Nested under /projects/<project_pk>/task-runs/
    path(
        "projects/<project_pk>/task-runs/",
        ProjectTaskRunViewSet.as_view({"get": "list"}),
        name="project-task-runs-list",
    ),
    path(
        "projects/<project_pk>/task-runs/<pk>/",
        ProjectTaskRunViewSet.as_view({"get": "retrieve"}),
        name="project-task-runs-detail",
    ),
    path(
        "projects/<project_pk>/task-runs/<pk>/cancel/",
        ProjectTaskRunViewSet.as_view({"post": "cancel"}),
        name="project-task-runs-cancel",
    ),
    *router.urls,
]
