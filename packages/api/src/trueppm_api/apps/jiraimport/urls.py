"""URL routing for offline Jira import."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.jiraimport.views import JiraImportView

urlpatterns = [
    path(
        "projects/<project_pk>/import/jira/",
        JiraImportView.as_view(),
        name="project-import-jira",
    ),
]
